#!/usr/bin/env python3
"""Launch two verified final Desktop packages on Ubuntu 22.04; never build or fake a backend."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.error
import urllib.request
import zipfile


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def one(paths, label):
    paths = list(paths)
    assert len(paths) == 1, f'{label}: expected one file, found {paths}'
    return paths[0]


def process_evidence(pid):
    proc = Path('/proc') / str(pid)
    executable = (proc / 'exe').resolve(strict=True)
    return {'pid': pid, 'executablePath': str(executable), 'executableSha256': digest(executable)}


def wait_until(condition, label, process=None, timeout=180, allow_wrapper_exit=False):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process and process.poll() is not None and not (allow_wrapper_exit and process.returncode == 0):
            raise RuntimeError(f'Desktop launcher exited before {label}: {process.returncode}')
        value = condition()
        if value:
            return value
        time.sleep(0.25)
    raise RuntimeError(f'Timed out waiting for {label}')


def stop_owned(process, desktop, core_pid, runtime_root):
    # Only this script's new process group and a Core executable under its fresh root.
    if core_pid and (Path('/proc') / str(core_pid) / 'exe').exists():
        actual = (Path('/proc') / str(core_pid) / 'exe').resolve()
        assert actual.is_relative_to(runtime_root / 'versions')
        try:
            os.kill(core_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    owned_group = process.poll() is None
    if desktop and (Path('/proc') / str(desktop['pid']) / 'exe').exists():
        assert process_evidence(desktop['pid'])['executablePath'] == desktop['executablePath']
        owned_group = owned_group or os.getpgid(desktop['pid']) == process.pid
        if not owned_group:
            os.kill(desktop['pid'], signal.SIGTERM)
    if owned_group:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
    if core_pid:
        wait_until(lambda: not (Path('/proc') / str(core_pid) / 'exe').exists(), 'owned Core exit', timeout=15)
    if desktop:
        wait_until(lambda: not (Path('/proc') / str(desktop['pid']) / 'exe').exists(), 'owned Desktop exit', timeout=15)


def smoke_format(kind, candidate, output, temp_root):
    root = temp_root / kind
    root.mkdir(parents=True)
    report = {'ok': False, 'format': kind, 'root': str(root), 'desktopVersion': candidate['desktopVersion'],
              'desktopSha': candidate['desktopSha'], 'candidateSha256': candidate['candidateSha256']}
    artifact = Path(candidate['formats'][kind]['path'])
    assert digest(artifact) == candidate['formats'][kind]['sha256']
    if kind == 'deb':
        subprocess.run(['dpkg-deb', '-x', str(artifact), str(root / 'package')], check=True)
        name = subprocess.check_output(['dpkg-deb', '-f', str(artifact), 'Package'], text=True).strip()
        version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', name], text=True).strip()
        assert version == candidate['desktopVersion']
        package_binary = one((root / 'package/usr/bin').glob('hermes-agent-cn-desktop'), 'deb main executable')
        expected_binary = Path('/usr/bin') / package_binary.name
        assert digest(expected_binary) == digest(package_binary), 'Actual apt-installed executable differs from signed deb payload'
        entries = subprocess.check_output(['dpkg-query', '-L', name], text=True).splitlines()
        manifest_path = one((Path(x) for x in entries if x.endswith('/bundled-runtime/stable-linux-x64.json')), 'apt-installed runtime manifest')
        command = [str(expected_binary)]
        report['versionEvidence'] = {'source': 'dpkg-query for actual installed package', 'package': name, 'version': version}
    else:
        artifact.chmod(artifact.stat().st_mode | 0o111)
        with (output / 'appimage-extraction.log').open('w') as log:
            subprocess.run([str(artifact), '--appimage-extract'], cwd=root, stdout=log, stderr=subprocess.STDOUT, check=True)
        appdir = root / 'squashfs-root'
        expected_binary = one((appdir / 'usr/bin').glob('hermes-agent-cn-desktop'), 'AppImage main executable')
        manifest_path = one(appdir.rglob('bundled-runtime/stable-linux-x64.json'), 'AppImage runtime manifest')
        command = [str(appdir / 'AppRun')]
        report['versionEvidence'] = {'source': 'signed AppImage and pinned candidate release-record', 'version': candidate['desktopVersion']}
    expected_binary = expected_binary.resolve()
    manifest = json.loads(manifest_path.read_text())
    assert manifest['schemaVersion'] == 2 and manifest['platform'] == 'linux' and manifest['arch'] == 'x64'
    assert manifest['runtimeVersion'] == candidate['runtimeVersion'] and manifest['sourceCommit'] == candidate['coreSha']
    archive = manifest_path.parent / 'hermes-agent-cn-runtime-linux-x64.zip'
    assert digest(archive) == manifest['sha256']
    with zipfile.ZipFile(archive) as bundled:
        core_member = one((entry.filename for entry in bundled.infolist()
                           if not entry.is_dir() and Path(entry.filename).name == 'hermes-agent-cn-runtime-linux-x64'), 'bundled Core executable')
        expected_core_hash = hashlib.sha256(bundled.read(core_member)).hexdigest()
    runtime_root = root / 'runtime'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HERMES_', 'TAURI_', 'PYTHON'))}
    for key in ['GH_TOKEN', 'GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
                'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
                'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']:
        env.pop(key, None)
    env.update({'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
                'XDG_CACHE_HOME': str(root / 'cache'), 'HERMES_DESKTOP_RUNTIME_ROOT': str(runtime_root),
                'HERMES_HOME': str(runtime_root / 'hermes-home'), 'HERMES_DESKTOP_API_PORT': '9120',
                'HERMES_NO_ANALYTICS': '1', 'HERMES_DISABLE_LAZY_INSTALLS': '1', 'PYTHONUTF8': '1',
                'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
                'RUST_LOG': 'warn,hermes_agent_cn_desktop::process::dashboard=info'})
    for key in ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']:
        Path(env[key]).mkdir()
    process = None
    desktop = None
    core_pid = None
    try:
        with (output / f'{kind}-desktop.log').open('w') as log:
            process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            owner_file = runtime_root / 'desktop-owner.json'
            current_file = runtime_root / 'current.json'
            def ready_owner():
                if not owner_file.exists() or not current_file.exists():
                    return None
                value = json.loads(owner_file.read_text())
                return value if value.get('dashboardPid') else None
            owner = wait_until(ready_owner, 'managed runtime records with actual Core PID', process,
                               allow_wrapper_exit=kind == 'appimage')
            current = json.loads(current_file.read_text())
            desktop = process_evidence(owner['desktopPid'])
            assert desktop['executablePath'] == str(expected_binary)
            assert desktop['executableSha256'] == digest(expected_binary)
            assert Path(owner['runtimeRoot']) == runtime_root
            core_pid = owner['dashboardPid']
            core = process_evidence(core_pid)
            assert Path(core['executablePath']).is_relative_to(runtime_root / 'versions' / candidate['runtimeVersion'])
            assert core['executableSha256'] == expected_core_hash
            assert current['runtimeVersion'] == candidate['runtimeVersion']
            assert current['sourceCommit'] == candidate['coreSha'] and current['artifactSha256'] == manifest['sha256']
            assert Path(current['executablePath']).resolve() == Path(core['executablePath'])
            assert owner['apiBaseUrl'] == 'http://127.0.0.1:9120'
            report.update({'desktopProcess': desktop, 'coreProcess': core, 'current': current,
                           'manifestSha256': digest(manifest_path), 'runtimeArchiveSha256': manifest['sha256']})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def ready_dashboard_page():
                assert json.loads(owner_file.read_text())['dashboardPid'] == core_pid, 'Owned Core PID changed during startup'
                assert (Path('/proc') / str(core_pid) / 'exe').resolve(strict=True) == Path(core['executablePath'])
                try:
                    with opener.open(owner['apiBaseUrl'] + '/', timeout=5) as response:
                        return response.read().decode()
                except urllib.error.URLError as error:
                    if not isinstance(error.reason, ConnectionRefusedError):
                        raise
                    return None
            html = wait_until(ready_dashboard_page, 'same owned Core serving its dashboard page', process,
                              allow_wrapper_exit=kind == 'appimage')
            token = re.search(r'__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"', html)[1]
            apis = {}
            for endpoint in ['health', 'version', 'status']:
                request = urllib.request.Request(owner['apiBaseUrl'] + '/api/' + endpoint,
                    headers={'Authorization': 'Bearer ' + token, 'X-Hermes-Session-Token': token})
                with opener.open(request, timeout=30) as response:
                    apis[endpoint] = json.load(response)
            assert apis['health']['ok'] is True
            assert apis['health']['version'] == manifest['kernelVersion']
            assert apis['version']['version'] == manifest['kernelVersion']
            assert Path(apis['status']['hermes_home']) == runtime_root / 'hermes-home'
            assert apis['status']['active_agents'] == 0 and not apis['status']['gateway_busy']
            def windows():
                r = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(desktop['pid'])], capture_output=True, text=True)
                return r.stdout.strip().splitlines() if r.returncode == 0 else []
            window_ids = wait_until(windows, 'visible native Desktop window', process, timeout=60,
                                    allow_wrapper_exit=kind == 'appimage')
            title = subprocess.check_output(['xdotool', 'getwindowname', window_ids[0]], text=True).strip()
            assert 'Hermes' in title
            # Give the actual WebKit frontend time to render after Core readiness.
            time.sleep(5)
            subprocess.run(['import', '-window', 'root', str(output / f'{kind}-native-window.png')], check=True)
            # AppRun may exec or spawn the native executable and return zero.
            # The actual owner PID and /proc executable decide Desktop liveness.
            assert process_evidence(desktop['pid']) == desktop
            report.update({'ok': True, 'desktopProcess': desktop, 'coreProcess': core, 'current': current,
                           'apiHealth': apis['health'], 'apiVersion': apis['version'], 'apiStatusIdle': True,
                           'windowTitle': title, 'windowIds': window_ids, 'manifestSha256': digest(manifest_path),
                           'runtimeArchiveSha256': manifest['sha256'], 'screenshotsRequireVisualReview': True,
                           'launcherPid': process.pid, 'launcherExitCodeAtCapture': process.poll()})
    except Exception as error:
        report['error'] = str(error)
        subprocess.run(['import', '-window', 'root', str(output / f'{kind}-failure-window.png')], check=False)
        raise
    finally:
        if process:
            try:
                stop_owned(process, desktop, core_pid, runtime_root)
                report['ownedProcessesStopped'] = True
            except Exception as error:
                report['cleanupError'] = str(error)
                report['ok'] = False
        (output / f'{kind}-desktop-smoke.json').write_text(json.dumps(report, indent=2) + '\n')
    assert report['ok'], report
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    assert os_release['ID'].strip('"') == 'ubuntu' and os_release['VERSION_ID'].strip('"') == '22.04'
    candidate = json.loads(args.candidate.read_text())
    assert candidate['ok'] and all(x['signatureVerified'] for x in candidate['formats'].values())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    temp_root = Path(os.environ['RUNNER_TEMP']) / 'hermes-final-linux-smoke'
    results = []
    for kind in ['deb', 'appimage']:
        results.append(smoke_format(kind, candidate, output, temp_root))
    (output / 'summary.json').write_text(json.dumps({'ok': True, 'os': os_release, 'formats': results}, indent=2) + '\n')
