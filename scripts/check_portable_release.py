#!/usr/bin/env python3
"""Check a portable folder with no system Python/FFmpeg on the child PATH.

Only temporary config is used. This never opens the desktop
application, a WebView profile, Grok or a real library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SMOKE = r'''
import json, pathlib, sys, threading, urllib.request
import server, viewer_preferences, cover_acceleration
root, fixture = map(pathlib.Path, sys.argv[1:3])
assert pathlib.Path(sys.executable).resolve() == (root / "viewer/runtime/win64/python.exe").resolve()
assert pathlib.Path(server.__file__).resolve() == (root / "viewer/server.py").resolve()
server.CONFIG_PATH_OVERRIDE = str(fixture / "viewer-config.json")
library = fixture / "library"
library.mkdir()
checks = ["bundled imports", "isolated PATH", "no bundled video tools"]
assert server.resolve_ffmpeg() is None
assert server.resolve_ffprobe() is None
assert not (root / "webview2").exists()
assert (root / "viewer/install-environment.ps1").is_file()
health = server.environment_status()
assert not health["ffmpeg"]["ready"]
assert all(tool["reason"] == "missing" for tool in health["ffmpeg"]["tools"].values())
state = server.AppState(str(library))
httpd = server.ViewerHTTPServer(("127.0.0.1", 0), server.make_handler(state))
worker = threading.Thread(target=httpd.serve_forever, daemon=True)
worker.start()
try:
    base = "http://127.0.0.1:" + str(httpd.server_port)
    for route in ["/", "/static/i18n.js", "/static/locales/en.js", "/static/environment.js", "/api/config?minimal=1", "/api/environment"]:
        with urllib.request.urlopen(base + route, timeout=10) as response:
            assert response.status == 200, route
            assert response.read(), route
    with urllib.request.urlopen(base + "/api/environment", timeout=10) as response:
        assert json.load(response) == health
finally:
    httpd.shutdown()
    httpd.server_close()
    worker.join(timeout=5)
print(json.dumps({"python": sys.version.split()[0],
                  "checks": checks + ["loopback HTTP", "i18n resources", "missing FFmpeg detection"]}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    args = parser.parse_args()
    release = args.release.resolve(strict=True)
    manifest = json.loads((release / "release-manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["files"].items():
        file = (release / name).resolve(strict=True)
        if not file.is_relative_to(release):
            raise RuntimeError(f"manifest path escaped release: {name}")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise RuntimeError(f"release hash mismatch: {name}")
    with tempfile.TemporaryDirectory(prefix="giv-portable-smoke-") as temp:
        fixture = Path(temp).resolve()
        if not fixture.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("smoke directory escaped temp")
        system_root = os.environ["SystemRoot"]
        env = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if name in os.environ}
        env.update({"PATH": str(Path(system_root) / "System32"), "TEMP": temp, "TMP": temp,
                    "USERPROFILE": temp, "HOME": temp, "APPDATA": temp, "LOCALAPPDATA": temp,
                    "PYTHONIOENCODING": "utf-8"})
        result = subprocess.run([str(release / "viewer/runtime/win64/python.exe"), "-B", "-X", "utf8", "-c", SMOKE,
                                 str(release), temp], cwd=fixture, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        if result.returncode: raise RuntimeError(result.stdout + result.stderr)
        print(result.stdout.strip())
    print(f"verified {len(manifest['files'])} program file hashes; desktop application not launched")


if __name__ == "__main__":
    main()
