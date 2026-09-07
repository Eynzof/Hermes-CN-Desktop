"""Process-scoped HTTPS proxy serving an existing, real signed NSIS candidate.

Only two update hosts are handled. There is no upstream proxying, model route,
hosts-file edit, OS proxy setting, or public publication.
"""
import argparse
import base64
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
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path('C:/HermesE2E'))
parser.add_argument('--prepare', action='store_true')
parser.add_argument('--artifacts', type=Path, default=Path('C:/HermesV090Fixes/artifacts'))
args = parser.parse_args()
folder = args.root / 'shell-update-fixture'
private = args.root / 'secrets/shell-update-fixture'
hosts = ('hot-update-staging.hermesagent.org.cn', 'dl-desktop.hermesagent.org.cn')
baseline = json.loads((args.root / 'native-windows/baseline.json').read_text(encoding='utf-8'))
version = baseline['shellUpdateCandidate']['version']
asset_path = f'/v{version}/update.exe'


def sha(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def save(name, value):
    (folder / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


if args.prepare:
    if folder.exists():
        raise SystemExit('Existing fixture is retained; use its pinned metadata')
    original = args.artifacts / baseline['desktopArtifactsDir'] / 'Hermes v090 Acceptance_0.9.0_x64-setup.exe'
    candidate = args.artifacts / f'desktop-{version}/Hermes v090 Acceptance_{version}_x64-setup.exe'
    exe = candidate.parent / 'hermes-agent-cn-desktop.exe'
    assert sha(original) == baseline['desktopInstallerSha256']
    assert sha(candidate) == baseline['shellUpdateCandidate']['installerSha256']
    assert sha(exe) == baseline['shellUpdateCandidate']['exeSha256']
    # Tauri's NSIS bundler changes this bundle-type marker before packaging.
    # Compute the expected installed bytes without modifying the signed asset.
    unpacked = exe.read_bytes()
    assert unpacked.count(b'URI_BUNDLE_TYPE_VAR_UNK') == 1
    installed_sha = hashlib.sha256(unpacked.replace(b'URI_BUNDLE_TYPE_VAR_UNK', b'URI_BUNDLE_TYPE_VAR_NSS')).hexdigest()
    folder.mkdir()
    private.mkdir(parents=True)
    shutil.copyfile(candidate, folder / 'update.exe')
    signature = candidate.with_suffix('.exe.sig').read_text().strip()
    manifest = dict(version=version, notes='仅本机验收的真实签名安装包，不是正式发布', pub_date='2026-09-07T00:00:00Z',
                    url=f'https://{hosts[1]}{asset_path}', signature=signature,
                    metadata=dict(schemaVersion=2, releaseId=f'desktop-{version}-windows-x86_64', channel='prototype',
                                githubReleaseTag=f'v{version}', githubFallbackUrl=f'https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/v{version}/update.exe',
                                sha256=sha(candidate), size=candidate.stat().st_size, bundledCoreVersion='0.21.0',
                                bundledRuntimeVersion=baseline['runtimeVersion'], runtimeRevision=int(baseline['runtimeVersion'].rsplit('.', 1)[1])))
    save('good.json', manifest)
    save('bad-hash.json', {**manifest, 'metadata': {**manifest['metadata'], 'sha256': '0' * 64}})
    lines = base64.b64decode(signature).decode().splitlines()
    damaged = bytearray(base64.b64decode(lines[1]))
    damaged[-1] ^= 1
    lines[1] = base64.b64encode(damaged).decode()
    save('bad-signature.json', {**manifest, 'signature': base64.b64encode(('\n'.join(lines) + '\n').encode()).decode()})
    now = dt.datetime.now(dt.timezone.utc)
    ca_key = rsa.generate_private_key(65537, 2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Hermes E2E two-host update fixture')])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=10))
          .not_valid_after(now + dt.timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
          .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), True)
          .add_extension(x509.NameConstraints([x509.DNSName(host) for host in hosts], None), True).sign(ca_key, hashes.SHA256()))
    tls_key = rsa.generate_private_key(65537, 2048)
    certificate = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hosts[0])]))
                   .issuer_name(ca_name).public_key(tls_key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - dt.timedelta(minutes=10)).not_valid_after(now + dt.timedelta(days=2))
                   .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
                   .add_extension(x509.SubjectAlternativeName([x509.DNSName(host) for host in hosts]), False)
                   .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False).sign(ca_key, hashes.SHA256()))
    (folder / 'ca.cer').write_bytes(ca.public_bytes(serialization.Encoding.DER))
    (private / 'tls.pem').write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    (private / 'tls-key.pem').write_bytes(tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    save('metadata.json', dict(version=version, proxy='http://127.0.0.1:19446', hosts=hosts,
                              caThumbprint=ca.fingerprint(hashes.SHA1()).hex(), candidateInstallerSha256=sha(candidate),
                              candidateInstalledSha256=installed_sha, candidateBuildSha256=sha(exe),
                              baselineInstaller=str(original), baselineInstallerSha256=sha(original),
                              baselineInstalledSha256=baseline['installedDesktopSha256'], expires=ca.not_valid_after_utc.isoformat()))
    save('mode.json', dict(manifest='good.json', authorized=False, deviceId=''))
    print('Prepared exact signed NSIS bytes and two-host TLS fixture')
    raise SystemExit(0)

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(private / 'tls.pem', private / 'tls-key.pem')


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *params):
        pass

    def reply(self, status, data=b'', content='application/json'):
        host = self.headers.get('Host', '').split(':')[0]
        with (folder / 'requests.jsonl').open('a', encoding='utf-8') as output:
            output.write(json.dumps(dict(utc=dt.datetime.now(dt.timezone.utc).isoformat(), host=host, path=self.path,
                                        method=self.command, status=status, authorizationPresent=bool(self.headers.get('Authorization')))) + '\n')
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_CONNECT(self):
        if self.path not in [f'{host}:443' for host in hosts]:
            return self.reply(403)
        self.send_response(200, 'Connection Established')
        self.end_headers()
        with context.wrap_socket(self.connection, server_side=True) as secured:
            Handler(secured, self.client_address, self.server)
        self.close_connection = True

    def do_GET(self):
        host = self.headers.get('Host', '').split(':')[0]
        if host == '127.0.0.1' and self.path == '/health':
            return self.reply(200, b'{"ready":true}')
        state = json.loads((folder / 'mode.json').read_text(encoding='utf-8'))
        if host == hosts[0] and self.path.startswith('/v1/check/'):
            device = state['deviceId']
            if not state['authorized'] or not device or self.headers.get('X-Device-Id') != device or self.headers.get('Authorization') != f'Bearer local-fixture-{device}':
                return self.reply(403, b'{"error":"local_fixture_authorization_denied"}')
            return self.reply(200, (folder / state['manifest']).read_bytes())
        if host == hosts[1] and self.path == asset_path:
            # The actual updater must strip control-plane authorization here.
            if self.headers.get('Authorization'):
                return self.reply(400, b'{"error":"unexpected_asset_authorization"}')
            return self.reply(200, (folder / 'update.exe').read_bytes(), 'application/octet-stream')
        self.reply(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.headers.get('Host', '').split(':')[0] == hosts[0] and self.path == '/v1/events':
            event = json.loads(body)
            with (folder / 'events.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps(event) + '\n')
            return self.reply(204)
        self.reply(404)


print('LOCAL_SIGNED_SHELL_PROXY_READY', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', 19446), Handler).serve_forever()
