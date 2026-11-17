#!/usr/bin/env python3
"""Optional, application-local FFmpeg tools. No system/PATH/config changes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import urllib.request
import zipfile

VERSION = "9.0.2-essentials_build"
URL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
MEMBERS = {"bin/ffmpeg.exe": "ffmpeg.exe", "bin/ffprobe.exe": "ffprobe.exe",
           "LICENSE": "LICENSE.txt", "README.txt": "README.txt"}
MAX_ARCHIVE = 200 * 1024 * 1024


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def plain_directory_path(path):
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise RuntimeError(f"refusing linked or non-directory target: {part}")


def install_archive(archive, destination):
    """Verify before extracting only the two executables and their notices."""
    plain_directory_path(destination)
    if destination.exists():
        manifest = json.loads((destination / "component.json").read_text(encoding="utf-8"))
        if manifest.get("version") != VERSION or set(manifest.get("files", {})) != set(MEMBERS.values()):
            raise RuntimeError("existing video-tools folder is not this component; preserve it")
        for name, expected in manifest["files"].items():
            if (destination / name).is_symlink() or digest(destination / name) != expected:
                raise RuntimeError(f"existing component hash mismatch; preserve it: {name}")
        print("Video tools are already installed and verified.")
        return
    if archive.stat().st_size > MAX_ARCHIVE or digest(archive) != SHA256:
        raise RuntimeError("FFmpeg archive size/SHA-256 mismatch; nothing installed")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".video-tools-stage-", dir=destination.parent) as temp:
        stage = Path(temp).resolve()
        if not stage.is_relative_to(destination.parent.resolve()):
            raise RuntimeError("component stage escaped application folder")
        with zipfile.ZipFile(archive) as bundle:
            for source, target in MEMBERS.items():
                entry = bundle.getinfo(f"ffmpeg-{VERSION}/{source}")
                if entry.file_size > MAX_ARCHIVE:
                    raise RuntimeError("component file is too large")
                with bundle.open(entry) as src, (stage / target).open("xb") as out:
                    shutil.copyfileobj(src, out)
        files = {name: digest(stage / name) for name in MEMBERS.values()}
        (stage / "component.json").write_text(json.dumps({"schema": 1, "version": VERSION,
            "url": URL, "archiveSha256": SHA256, "files": files}, indent=2) + "\n", encoding="utf-8")
        plain_directory_path(destination)
        if destination.exists():
            raise RuntimeError("destination appeared while installing; nothing replaced")
        # Windows rename refuses an existing destination. All unrelated files stay intact.
        stage.rename(destination)
    print("Installed ffmpeg.exe and ffprobe.exe with license notices:", destination)
    print("Restart the viewer normally to generate missing video covers.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded, SHA-256-checked ZIP")
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / "video-tools")
    args = parser.parse_args()
    destination = args.destination.absolute()
    plain_directory_path(destination)
    if args.archive or destination.exists():
        install_archive(args.archive or Path("unused"), destination)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".video-tools-download-", dir=destination.parent) as temp:
        archive = Path(temp) / "ffmpeg.zip"
        print("Downloading optional video tools (about 110 MiB); verifying SHA-256...", flush=True)
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open("xb") as out:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARCHIVE:
                    raise RuntimeError("download exceeded the fixed size limit")
                out.write(chunk)
        install_archive(archive, destination)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"Video tools installation failed: {error}")
