#!/usr/bin/env python3
"""Download only immutable Linux candidate bytes; verify the accepted fingerprint and signatures."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def gh_json(route):
    return json.loads(subprocess.check_output(['gh', 'api', route], text=True))


def main(args):
    repository = os.environ['GITHUB_REPOSITORY']
    source_sha = os.environ['DESKTOP_SHA']
    fingerprint = os.environ['CANDIDATE_SHA256']
    run_id = os.environ['CANDIDATE_RUN_ID']
    tag = os.environ['RELEASE_TAG']
    assert re.fullmatch(r'[a-f0-9]{40}', source_sha)
    assert re.fullmatch(r'[a-f0-9]{64}', fingerprint)
    assert re.fullmatch(r'\d+', run_id)
    assert tag == 'v0.9.0'
    assert subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip() == source_sha
    run = gh_json(f'repos/{repository}/actions/runs/{run_id}')
    assert run['conclusion'] == 'success' and run['head_sha'] == source_sha
    assert run['path'].split('@')[0] == '.github/workflows/release-desktop.yml'
    # The tag REST endpoint does not resolve a draft's pending tag; read its exact ID.
    pages = json.loads(subprocess.check_output(
        ['gh', 'api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100'], text=True))
    releases = [release for page in pages for release in page if release['tag_name'] == tag]
    assert len(releases) == 1, 'Expected exactly one release for the pinned tag'
    release = gh_json(f'repos/{repository}/releases/{releases[0]["id"]}')
    assert release['tag_name'] == tag
    assert release['target_commitish'] == source_sha
    args.assets.mkdir(parents=True)
    subprocess.run(['gh', 'release', 'download', tag, '--repo', repository, '--dir', str(args.assets),
                    '--pattern', 'checksums.txt', '--pattern', 'release-record.json'], check=True)
    assert digest(args.assets / 'checksums.txt') == fingerprint, 'Candidate fingerprint changed'
    checksums = {}
    for line in (args.assets / 'checksums.txt').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([0-9A-Za-z][0-9A-Za-z._-]*)', line)
        assert match and match[2] not in checksums
        checksums[match[2]] = match[1]
    assert digest(args.assets / 'release-record.json') == checksums['release-record.json']
    record = json.loads((args.assets / 'release-record.json').read_text())
    assert record['desktopSha'] == source_sha and record['desktopVersion'] == '0.9.0'
    assert record['githubReleaseTag'] == tag
    assert record['coreSha'] == 'b9f82a21fd9268bd499051e23b614ecb06d5b888'
    assert record['bundledRuntimeTag'] == 'runtime-v0.21.0-cn.18'
    assert record['bundledRuntimeVersion'] == '0.21.0-cn.18'
    assert len(record['assets']) == 5, 'Final release record must contain five updater formats'
    assert record['releasePolicy']['environment'] == 'production'
    assert record['releasePolicy']['channel'] == 'stable'
    config = json.loads((args.source / 'tauri.conf.json').read_text())
    assert config['version'] == record['desktopVersion']
    formats = {}
    with tempfile.TemporaryDirectory(prefix='hermes-linux-signature-') as temporary:
        temporary = Path(temporary)
        key = temporary / 'updater.pub'
        key.write_bytes(base64.b64decode(config['plugins']['updater']['pubkey']))
        for kind, target, extension in [('deb', 'linux-deb', '.deb'), ('appimage', 'linux', '.AppImage')]:
            assets = [a for a in record['assets'] if a['target'] == target and a['arch'] == 'x86_64']
            assert len(assets) == 1, f'Missing unique signed updater asset for {target}/x86_64'
            asset = assets[0]
            filename, signature = asset['fileName'], asset['signatureFile']
            assert filename.endswith(extension) and signature == filename + '.sig'
            assert filename in checksums and signature in checksums
            subprocess.run(['gh', 'release', 'download', tag, '--repo', repository, '--dir', str(args.assets),
                            '--pattern', filename, '--pattern', signature], check=True)
            for name in [filename, signature]:
                assert digest(args.assets / name) == checksums[name], f'Original bytes changed: {name}'
            detached = temporary / 'updater.sig'
            detached.write_bytes(base64.b64decode((args.assets / signature).read_text().strip()))
            subprocess.run(['minisign', '-V', '-p', str(key), '-m', str(args.assets / filename), '-x', str(detached)], check=True)
            formats[kind] = {'path': str((args.assets / filename).resolve()), 'sha256': checksums[filename],
                             'signatureFile': signature, 'target': target, 'signatureVerified': True}
    for filename in ['checksums.txt', 'release-record.json']:
        (args.output.parent / filename).write_bytes((args.assets / filename).read_bytes())
    return {'ok': True, 'repository': repository, 'acceptanceCommit': os.environ['GITHUB_SHA'], 'releaseUrl': release['html_url'], 'isDraft': release['draft'],
            'runUrl': run['html_url'], 'candidateSha256': fingerprint, 'desktopSha': source_sha,
            'desktopVersion': record['desktopVersion'], 'runtimeVersion': record['bundledRuntimeVersion'],
            'coreSha': record['coreSha'], 'formats': formats}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--assets', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        report = main(args)
    except Exception as error:
        args.output.write_text(json.dumps({'ok': False, 'error': str(error)}, indent=2))
        raise
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
