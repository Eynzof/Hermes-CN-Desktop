"""Local HTTPS distribution of real signed test candidates, never a model mock."""
import argparse
import base64
import datetime as dt
import hashlib
import http.server
import ipaddress
import json
import shutil
import ssl
import zipfile
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, default=Path("C:/HermesE2E"))
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--runtime-archive", type=Path)
parser.add_argument("--runtime-manifest", type=Path)
parser.add_argument("--ui-dist", type=Path)
parser.add_argument("--signing-key", type=Path)
args = parser.parse_args()
folder = args.root / "update-fixture"
keys = args.root / "secrets" / "update-fixture"
port = 19445
base = f"https://localhost:{port}"


def save(name, value):
    (folder / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


if args.prepare:
    if folder.exists():
        raise SystemExit("Fixture already exists; preserve its certificate and evidence")
    folder.mkdir()
    keys.mkdir(parents=True)
    baseline = json.loads((args.root / "native-windows/baseline.json").read_text(encoding="utf-8"))
    current = json.loads(args.runtime_manifest.read_text(encoding="utf-8-sig"))
    runtime_sha = hashlib.file_digest(args.runtime_archive.open("rb"), "sha256").hexdigest()
    assert runtime_sha == current["sha256"], "Use the exact installed bundled Core archive"
    assert current["sourceCommit"] == baseline["coreCommit"]
    shutil.copyfile(args.runtime_archive, folder / "runtime.zip")
    # Use the acceptance build's existing test key. A different override would
    # also reject its bundled Runtime during reinstall and confound the test.
    signing = serialization.load_pem_private_key(args.signing_key.read_bytes(), password=None)
    assert isinstance(signing, ed25519.Ed25519PrivateKey)
    (keys / "signing.pem").write_bytes(signing.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (folder / "public.pem").write_bytes(signing.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))

    def sign(manifest, fields):
        manifest["signature"] = base64.b64encode(signing.sign("\n".join(str(manifest[f]) for f in fields).encode())).decode()
        return manifest

    runtime_fields = ["schemaVersion", "channel", "runtimeVersion", "kernelVersion", "runtimeFlavor", "runtimeRevision", "platform", "arch", "artifactUrl", "sha256", "sourceRepo", "sourceCommit"]
    manifest = dict(schemaVersion=2, channel="prototype", runtimeVersion=f"0.21.0-cn.{current['runtimeRevision'] + 1}", kernelVersion="0.21.0", runtimeFlavor="cn", runtimeRevision=current["runtimeRevision"] + 1,
                    platform="win32", arch="x64", artifactUrl=base + "/runtime.zip", sha256=runtime_sha,
                    sourceRepo="Eynzof/Hermes-CN-Core", sourceCommit=baseline["coreCommit"], minAppVersion="0.9.0")
    save("runtime-good.json", sign(manifest, runtime_fields))
    save("runtime-bad-signature.json", {**manifest, "signature": base64.b64encode(bytes(64)).decode()})
    save("runtime-bad-hash.json", sign({**manifest, "sha256": "0" * 64}, runtime_fields))
    ui_fields = ["schemaVersion", "channel", "uiVersion", "appVersionFloor", "platform", "arch", "artifactUrl", "sha256", "sourceRepo", "sourceCommit"]
    ui_source = {str(f.relative_to(args.ui_dist)).replace("\\", "/"): hashlib.file_digest(f.open("rb"), "sha256").hexdigest()
                 for f in args.ui_dist.rglob("*") if f.is_file()}
    save("ui-source-files.json", ui_source)
    for revision in (1, 2):
        archive = folder / f"ui-{revision}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
            for file in args.ui_dist.rglob("*"):
                if not file.is_file():
                    continue
                relative = file.relative_to(args.ui_dist).as_posix()
                if relative == "index.html":
                    package.writestr(relative, file.read_text(encoding="utf-8").replace("</head>", f'<meta name="hermes-native-e2e-ui" content="{revision}"></head>'))
                else:
                    package.write(file, relative)
        ui = dict(schemaVersion=1, channel="prototype", uiVersion=f"0.9.0-e2e.{revision}", appVersionFloor="0.9.0", platform="win32", arch="x64",
                  artifactUrl=f"{base}/ui-{revision}.zip", sha256=hashlib.file_digest(archive.open("rb"), "sha256").hexdigest(),
                  sourceRepo="Eynzof/Hermes-CN-Desktop", sourceCommit="local-e2e-candidate-see-ui-source-files")
        save(f"ui-{revision}.json", sign(ui, ui_fields))
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = rsa.generate_private_key(65537, 2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Hermes Native E2E localhost only")])
    ca = x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=7)).add_extension(x509.BasicConstraints(ca=True, path_length=0), True).add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), True).sign(ca_key, hashes.SHA256())
    tls_key = rsa.generate_private_key(65537, 2048)
    certificate = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])).issuer_name(ca_name).public_key(tls_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=7)).add_extension(x509.BasicConstraints(ca=False, path_length=None), True).add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False).sign(ca_key, hashes.SHA256())
    (folder / "ca.cer").write_bytes(ca.public_bytes(serialization.Encoding.DER))
    (folder / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (keys / "tls.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    (keys / "tls-key.pem").write_bytes(tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    save("metadata.json", dict(baseUrl=base, caThumbprint=ca.fingerprint(hashes.SHA1()).hex(), expires=ca.not_valid_after_utc.isoformat(), runtimeSha256=runtime_sha, runtimeVersion=manifest["runtimeVersion"]))
    save("mode.json", dict(runtime="runtime-good.json", ui="ui-1.json"))
    print("Prepared localhost fixture with real archives and isolated signing key")
    raise SystemExit(0)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *params, **kwargs):
        super().__init__(*params, directory=str(folder), **kwargs)

    def do_GET(self):
        mode = json.loads((folder / "mode.json").read_text(encoding="utf-8"))
        if self.path in ("/runtime.json", "/ui.json"):
            self.path = "/" + mode[self.path[1:-5]]
        if self.path.startswith("/v1/check/"):
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, format, *params):
        with (folder / "requests.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(dict(utc=dt.datetime.now(dt.timezone.utc).isoformat(), request=self.path, message=format % params)) + "\n")


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(keys / "tls.pem", keys / "tls-key.pem")
server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
server.socket = context.wrap_socket(server.socket, server_side=True)
print("LOCAL_SIGNED_UPDATE_FIXTURE_READY", flush=True)
server.serve_forever()
