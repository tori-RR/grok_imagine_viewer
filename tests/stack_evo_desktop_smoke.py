"""Launch manifest-listed Windows program files in a marked, fully isolated fixture."""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def powershell(script: str):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                            check=True, capture_output=True, text=True, timeout=20)
    return json.loads(result.stdout.strip() or 'null')


def plain_path(path: Path, directory: bool):
    for parent in (path, *path.parents):
        info = parent.lstat()
        if info.st_file_attributes & 0x400 or parent.is_symlink():
            raise AssertionError('Linked smoke paths are not allowed')
    if path.is_dir() != directory or (not directory and not path.is_file()):
        raise AssertionError('Unexpected smoke path type')


def program_file(relative: str) -> bool:
    normalized = relative.replace('\\', '/')
    parts = normalized.split('/')
    return not any(part in ('', '.', '..') for part in parts) and (normalized in {
        'grok-imagine-viewer-tauri.exe', 'viewer/giv-backend.exe', 'viewer/grok_imagine_viewer.ico',
        'viewer/install-environment.ps1', 'viewer/build-manifest.json', 'README.txt', 'README-portable.txt',
    } or normalized.startswith('viewer/static/'))


def main():
    if os.name != 'nt':
        raise SystemExit('The native smoke test requires Windows.')
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    package = args.package.absolute()
    plain_path(package, True)
    package = package.resolve(strict=True)
    manifest_path = package / 'release-manifest.json'
    if not manifest_path.exists():
        manifest_path = package / 'viewer/build-manifest.json'
    plain_path(manifest_path, False)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    assert manifest.get('schema') == 1 and manifest.get('backend') == 'go', 'Unsupported program manifest'
    if manifest.get('nativeSmokeProtocol') != 1:
        raise AssertionError('Package predates safe native smoke isolation. Rebuild it before testing; no program was started.')
    for relative, expected in manifest['files'].items():
        if not program_file(relative):
            raise AssertionError('Manifest contains a non-program resource')
        plain_path(package / relative, False)
        path = (package / relative).resolve(strict=True)
        if not path.is_relative_to(package) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise AssertionError('Package hash verification failed')
    assert {'grok-imagine-viewer-tauri.exe', 'viewer/giv-backend.exe', 'viewer/static/index.html'} <= set(manifest['files'])
    if b'grok-imagine-viewer-native-smoke' not in (package/'grok-imagine-viewer-tauri.exe').read_bytes():
        raise AssertionError('Program does not declare native smoke isolation. No program was started.')
    output = args.out.absolute()
    if '..' in output.parts:
        raise AssertionError('Smoke output cannot contain parent traversal')
    for parent in output.parents:
        if parent.exists(): plain_path(parent, True)
    output.mkdir(parents=True, exist_ok=False)
    plain_path(output, True)
    base = Path(tempfile.mkdtemp(prefix='giv-desktop-smoke-', dir=output))
    marker = dict(schema=1, owner='grok-imagine-viewer-native-smoke', nonce=secrets.token_hex(16))
    (base / '.giv-smoke-owner.json').write_text(json.dumps(marker), encoding='utf-8')
    inventory = dict(owner=marker['owner'], fixture=str(base), purpose='native window, owned sidecar and isolated app config/data/WebView profiles', retainOnFailure=True, package=str(package), commit=manifest['commit'])
    (output / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    success = False
    native_stdout = native_stderr = None
    try:
        install = base / 'program'
        install.mkdir()
        # Copy only program entries. Never enumerate or copy login profiles,
        # even when --package points at the fixed desktop test installation.
        for relative in manifest['files']:
            destination = install / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package / relative, destination)
            assert hashlib.sha256(destination.read_bytes()).hexdigest() == manifest['files'][relative]
        gallery = base / 'gallery'
        gallery.mkdir()
        (gallery / '_index.json').write_text('{"combos":[],"other":[],"summary":{}}', encoding='utf-8')
        for name in ('config', 'data', 'profiles/gallery-webview2', 'profiles/grok-webview2'):
            (base / name).mkdir(parents=True)
        (base / 'config/.viewer-config.json').write_text('{}', encoding='utf-8')
        env = dict(os.environ)
        for variable in ('APPDATA', 'LOCALAPPDATA'):
            folder = base / variable.lower()
            folder.mkdir()
            env[variable] = str(folder)
        env.pop('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', None)
        native_stdout = (output/'native-stdout.log').open('wb')
        native_stderr = (output/'native-stderr.log').open('wb')
        process = subprocess.Popen([str(install/'grok-imagine-viewer-tauri.exe'), '--smoke-fixture', str(base), '--root', str(gallery)],
                                   cwd=install, env=env, stdin=subprocess.DEVNULL, stdout=native_stdout, stderr=native_stderr)
        window = None
        sidecar = None
        port = None
        try:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(f'Desktop exited before readiness ({process.returncode})')
                windows = []
                @callback_type
                def collect(handle, _):
                    pid = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
                    if pid.value == process.pid and user32.IsWindowVisible(handle):
                        title = ctypes.create_unicode_buffer(256)
                        user32.GetWindowTextW(handle, title, len(title))
                        if title.value == 'Grok Imagine Viewer':
                            windows.append(handle)
                    return True
                user32.EnumWindows(collect, 0)
                children = powershell(f"@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = {process.pid}' | Select-Object ProcessId,Name) | ConvertTo-Json -Compress") or []
                if isinstance(children, dict): children = [children]
                assert not any(str(row['Name']).lower().startswith('python') for row in children), 'Python runtime was started'
                candidates = [row['ProcessId'] for row in children if str(row['Name']).lower() == 'giv-backend.exe']
                if windows and len(candidates) == 1:
                    window, sidecar = windows[0], int(candidates[0])
                    listeners = powershell(f"@(Get-NetTCPConnection -State Listen -OwningProcess {sidecar} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress") or []
                    if isinstance(listeners, dict): listeners = [listeners]
                    assert all(row['LocalAddress'] == '127.0.0.1' for row in listeners), 'Non-loopback backend listener'
                    if len(listeners) == 1:
                        port = int(listeners[0]['LocalPort'])
                        break
                time.sleep(1)
            if not window or not sidecar or not port:
                raise AssertionError('Visible desktop window and owned Go listener did not become ready')
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            origin = f'http://127.0.0.1:{port}'
            request = urllib.request.Request(origin+'/api/identity', headers={'X-Viewer-Challenge': '42'*32})
            with opener.open(request, timeout=5) as response:
                identity = json.load(response)
            assert identity['pid'] == sidecar and identity['app'] == 'grok_imagine_viewer' and identity['protocolVersion'] == 3

            # The explicit native fixture mode replaces Known Folder lookups;
            # no fallback to the current user's profile is permitted here.
            config_path = Path(identity['configPath']).resolve(strict=True)
            if config_path != (base/'config/.viewer-config.json').resolve(strict=True):
                raise AssertionError('Application config escaped its registered fixture')
            database = config_path.parent / 'stack-evo-state' / 'history.sqlite'
            if not database.is_file() or database.is_symlink():
                raise AssertionError(f'Go task history database was not initialized beside {config_path}')
            connection = sqlite3.connect(database.resolve(strict=True).as_uri() + '?mode=ro', uri=True)
            try:
                integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
                version = connection.execute('PRAGMA user_version').fetchone()[0]
                tables = {row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )}
                assert integrity == 'ok', f'SQLite integrity check: {integrity}'
                assert version == 3 and 'runs' in tables and {'retry_of', 'started_at_ns'} <= {row[1] for row in connection.execute('PRAGMA table_info(runs)')}, 'Unexpected task history schema'
            finally:
                connection.close()
            try:
                opener.open(origin+'/', timeout=5)
            except urllib.error.HTTPError as error:
                assert error.code == 403
            else:
                raise AssertionError('Gallery accepted unauthenticated HTTP request')
            assert user32.PostMessageW(window, 0x0010, 0, 0)
            process.wait(timeout=30)
            assert process.returncode == 0, f'Desktop exit code {process.returncode}'
            remaining = powershell(f"@(Get-CimInstance Win32_Process -Filter 'ProcessId = {sidecar}' | Select-Object ProcessId,Name) | ConvertTo-Json -Compress")
            assert not remaining, 'Owned Go child survived normal desktop exit'
            assert (base/'profiles/gallery-webview2/EBWebView').is_dir(), 'Isolated gallery profile was not initialized'
            assert not (install/'gallery-webview2').exists() and not (install/'grok-webview2').exists(), 'Native smoke used portable profile migration'
            result = {'commit': manifest['commit'], 'window': 'visible', 'sidecar': 'owned-loopback', 'unauthenticatedHttp': 'rejected', 'normalClose': 'success', 'sqliteSchema': 3, 'sqliteIntegrity': 'ok', 'pythonRuntime': False, 'configIsolation': True, 'profileMigrationSkipped': True}
            (output/'report.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
            print(json.dumps(result))
            success = True
        finally:
            if process.poll() is None:
                # Only this test-created fixture process and its children, never an existing app.
                subprocess.run(['taskkill.exe','/PID',str(process.pid),'/T','/F'], capture_output=True, timeout=15)
                process.wait(timeout=15)
    finally:
        for stream in (native_stdout, native_stderr):
            if stream is not None: stream.close()
        inventory['success'] = success
        if success:
            # Only this run's fresh, marked tree is eligible for cleanup.
            assert json.loads((base/'.giv-smoke-owner.json').read_text()) == marker
            assert base.parent == output
            for directory, children, files in os.walk(base, followlinks=False):
                plain_path(Path(directory), True)
                for name in children: plain_path(Path(directory)/name, True)
                for name in files: plain_path(Path(directory)/name, False)
            for attempt in range(10):
                try:
                    shutil.rmtree(base)
                    break
                except PermissionError:
                    if attempt == 9: break
                    time.sleep(0.2)
        inventory['fixtureRemoved'] = not base.exists()
        if base.exists():
            inventory['retainedBytes'] = sum(path.stat().st_size for path in base.rglob('*') if path.is_file() and not path.is_symlink())
        (output/'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')


if __name__ == '__main__': main()
