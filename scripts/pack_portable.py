#!/usr/bin/env python3
"""Pack a copy-and-run folder/zip. Does not include the media library."""

from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE_FILES = (
    "server.py",
    "viewer_preferences.py",
    "cover_acceleration.py",
    "README.md",
    "start.bat",
    "start.sh",
    ".gitignore",
)
INCLUDE_DIRS = ("static",)
RUNTIME = ROOT / "runtime" / "win64"


def add_tree(zf, src: Path, arc_prefix: str):
    for path in sorted(src.rglob("*")):
        if path.name.endswith(".pyc") or path.name == "__pycache__":
            continue
        if path.is_dir():
            continue
        rel = path.relative_to(src)
        zf.write(path, arc_prefix + "/" + str(rel).replace("\\", "/"))


def main(argv=None):
    argv = list(argv or sys.argv[1:])
    out = Path(argv[0]) if argv else ROOT / "dist" / "grok_imagine_viewer-portable.zip"
    if not (ROOT / "start.bat").is_file():
        print("missing start.bat", file=sys.stderr)
        return 1
    if not (RUNTIME / "python.exe").is_file():
        print("missing runtime/win64/python.exe — run scripts/fetch_win_runtime.py", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    prefix = "grok_imagine_viewer"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in INCLUDE_FILES:
            path = ROOT / name
            if path.is_file():
                zf.write(path, prefix + "/" + name)
        for dirname in INCLUDE_DIRS:
            add_tree(zf, ROOT / dirname, prefix + "/" + dirname)
        add_tree(zf, RUNTIME, prefix + "/runtime/win64")
    print("wrote", out, "bytes", out.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
