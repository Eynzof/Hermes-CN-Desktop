"""Local, two-host HTTPS proxy for the actual signed macOS updater archive.

Requires cryptography. Never proxies model traffic or changes system proxy/DNS.
The caller explicitly trusts ca.cer for acceptance and removes that exact CA later.
"""
import argparse
import datetime as dt
import hashlib
import http.server
import json
import shutil
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--candidate", type=Path)
parser.add_argument("--version")
parser.add_argument("--runtime-version", default="0.21.0-cn.12")
parser.add_argument("--port", type=int, default=19448)
args = parser.parse_args()
root = args.root
hosts = ("hot-update-staging.hermesagent.org.cn", "dl-desktop.hermesagent.org.cn")


def save(name, value):
    (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


if args.prepare:
    if root.exists():
        raise SystemExit("Retain the existing pinned fixture; choose a new root for another build")
    if not args.candidate or not args.version:
        parser.error("--prepare requires --candidate and --version")
    root.mkdir(parents=True, mode=0o700)
    shutil.copyfile(args.candidate, root / "update.app.tar.gz")
    with args.candidate.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    signature = Path(str(args.candidate) + ".sig").read_text().strip()
    asset = f"/v{args.version}/update.app.tar.gz"
    save("good.json", {
        "version": args.version, "notes": "仅本机验收：验证下载、用户确认安装和 macOS 自动重启。",
        "pub_date": dt.datetime.now(dt.timezone.utc).isoformat(),
        "url": f"https://{hosts[1]}{asset}", "signature": signature,
        "metadata": {
            "schemaVersion": 2, "releaseId": f"desktop-{args.version}-darwin-aarch64",
            "channel": "prototype", "githubReleaseTag": f"v{args.version}",
            "githubFallbackUrl": f"https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/v{args.version}/update.app.tar.gz",
            "sha256": sha, "size": args.candidate.stat().st_size,
            "bundledCoreVersion": "0.21.0", "bundledRuntimeVersion": args.runtime_version,
            "runtimeRevision": int(args.runtime_version.rsplit(".", 1)[1]),
        },
    })
    now = dt.datetime.now(dt.timezone.utc)
    key = rsa.generate_private_key(65537, 2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Hermes macOS acceptance two-host fixture")])
    ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=10))
          .not_valid_after(now + dt.timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
          .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), True)
          .add_extension(x509.NameConstraints([x509.DNSName(host) for host in hosts], None), True)
          .sign(key, hashes.SHA256()))
    tls_key = rsa.generate_private_key(65537, 2048)
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hosts[0])]))
            .issuer_name(name).public_key(tls_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host) for host in hosts]), False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False).sign(key, hashes.SHA256()))
    (root / "ca.cer").write_bytes(ca.public_bytes(serialization.Encoding.DER))
    (root / "tls.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private = root / "tls-key.pem"
    private.write_bytes(tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    private.chmod(0o600)
    save("metadata.json", {"version": args.version, "sha256": sha, "asset": asset,
                           "caThumbprint": ca.fingerprint(hashes.SHA1()).hex(), "port": args.port})
    save("mode.json", {"available": True, "authorized": True})
    save("invitation.json", {"schemaVersion": 1, "channel": "prototype", "deviceId": "mac-v090-ux",
                            "token": "local-fixture-mac-v090-ux",
                            "endpoint": f"https://{hosts[0]}/v1/check/{{{{channel}}}}/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}"})
    print("Prepared signed macOS update fixture")
    raise SystemExit(0)

metadata = json.loads((root / "metadata.json").read_text())
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / "tls.pem", root / "tls-key.pem")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *params):
        pass

    def send_headers(self, status, length, content="application/json"):
        with (root / "requests.jsonl").open("a") as stream:
            stream.write(json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(),
                                    "host": self.headers.get("Host"), "path": self.path,
                                    "status": status, "authorizationPresent": bool(self.headers.get("Authorization"))}) + "\n")
        self.send_response(status)
        self.send_header("Content-Type", content)
        self.send_header("Content-Length", str(length))
        self.end_headers()

    def reply(self, status, body=b""):
        self.send_headers(status, len(body))
        self.wfile.write(body)

    def do_CONNECT(self):
        if self.path not in [f"{host}:443" for host in hosts]:
            return self.reply(403)
        self.send_response(200, "Connection Established")
        self.end_headers()
        with context.wrap_socket(self.connection, server_side=True) as connection:
            Handler(connection, self.client_address, self.server)
        self.close_connection = True

    def do_GET(self):
        host = self.headers.get("Host", "").split(":")[0]
        if host == "127.0.0.1" and self.path == "/health":
            return self.reply(200, b'{"ready":true}')
        mode = json.loads((root / "mode.json").read_text())
        if host == hosts[0] and self.path.startswith("/v1/check/"):
            if not mode["authorized"] or self.headers.get("Authorization") != "Bearer local-fixture-mac-v090-ux":
                return self.reply(403)
            return self.reply(200, (root / "good.json").read_bytes()) if mode["available"] else self.reply(204)
        if host == hosts[1] and self.path == metadata["asset"]:
            if self.headers.get("Authorization"):
                return self.reply(400, b'{"error":"unexpected_asset_authorization"}')
            file = root / "update.app.tar.gz"
            self.send_headers(200, file.stat().st_size, "application/gzip")
            with file.open("rb") as stream:
                while chunk := stream.read(65536):
                    self.wfile.write(chunk)
            return
        self.reply(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/v1/events":
            with (root / "events.jsonl").open("ab") as stream:
                stream.write(body + b"\n")
        self.reply(204)


http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
