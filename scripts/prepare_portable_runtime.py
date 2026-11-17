#!/usr/bin/env python3
"""Prepare pinned embedded Python; other components install on user request."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "runtime" / "win64" / "portable-managed"
SOURCES = {
    "python": {
        "version": "3.14.8",
        "url": "https://www.python.org/ftp/python/3.14.8/python-3.14.8-embeddable-amd64.zip",
        "sha256": "80292f0e640e373a54bf09f3b94a1472f976f24a10c5bed0d9622e4e44d67447",
        "archive": "python.zip",
        "verification": "Python official windows-3.14.8.json SHA-256",
    },
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_archive(cache, source):
    archive = cache / source["archive"]
    if not archive.exists():
        print("download", source["url"], flush=True)
        with urllib.request.urlopen(source["url"], timeout=120) as response, archive.open("xb") as out:
            shutil.copyfileobj(response, out)
    if digest(archive) != source["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch: {archive}; preserve it for inspection")
    return archive


def extract_zip(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = member.filename
            relative = PureWindowsPath(name)
            if relative.root or relative.drive or ".." in relative.parts or ":" in name:
                raise RuntimeError(f"unsafe archive entry: {name}")
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError(f"linked archive entry: {name}")
        bundle.extractall(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "output" / "portable-release")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("prepare the Windows runtime on Windows")
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archives = {name: checked_archive(cache, source) for name, source in SOURCES.items()}
    DEST.parent.mkdir(parents=True, exist_ok=True)
    if DEST.exists():
        manifest = json.loads((DEST / "manifest.json").read_text(encoding="utf-8"))
        if manifest["sources"] != SOURCES:
            raise RuntimeError("existing runtime versions differ; do not overwrite them")
        for name, expected in manifest["files"].items():
            if digest(DEST / name) != expected:
                raise RuntimeError(f"existing runtime hash mismatch: {name}")
        print("verified existing runtimes", DEST)
        return
    with tempfile.TemporaryDirectory(prefix=".portable-stage-", dir=DEST.parent) as temp:
        stage = Path(temp).resolve()
        if not stage.is_relative_to((ROOT / "runtime" / "win64").resolve()):
            raise RuntimeError("runtime stage escaped workspace")
        extract_zip(archives["python"], stage / "python")
        # The final interpreter lives at viewer/runtime/win64; add only the
        # app's own viewer directory, without site/PYTHONPATH/system packages.
        (stage / "python" / "python314._pth").write_text("python314.zip\n.\n..\\..\n", encoding="utf-8")
        prepared = stage / "prepared"
        prepared.mkdir()
        (prepared / "licenses").mkdir()
        shutil.copy2(stage / "python" / "LICENSE.txt", prepared / "licenses" / "Python-LICENSE.txt")
        shutil.move(str(stage / "python"), prepared / "python")
        files = {p.relative_to(prepared).as_posix(): digest(p)
                 for p in sorted(prepared.rglob("*")) if p.is_file()}
        (prepared / "manifest.json").write_text(json.dumps({
            "schema": 1, "architecture": "x64", "sources": SOURCES, "files": files,
        }, indent=2) + "\n", encoding="utf-8")
        prepared.rename(DEST)
    print("prepared", DEST, "files", len(files))


if __name__ == "__main__":
    main()
