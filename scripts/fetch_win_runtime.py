#!/usr/bin/env python3
"""Download official Windows embeddable CPython into runtime/win64/."""

from __future__ import annotations

import hashlib
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "3.12.10"
URL = "https://www.python.org/ftp/python/%s/python-%s-embed-amd64.zip" % (VERSION, VERSION)
# https://www.python.org/downloads/release/python-31210/
# Official page lists MD5 for this file (Python 3.12.10 files table).
MD5 = "fe8ef205f2e9c3ba44d0cf9954e1abd3"

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "runtime" / "win64"


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    marker = DEST / "python.exe"
    if marker.is_file() and (DEST / "python312.zip").is_file():
        print("already present:", marker)
        return 0
    tmp = DEST / "_python-embed.zip"
    print("download", URL)
    urllib.request.urlretrieve(URL, tmp)
    digest = hashlib.md5(tmp.read_bytes()).hexdigest()
    if digest != MD5:
        tmp.unlink(missing_ok=True)
        print("md5 mismatch:", digest, file=sys.stderr)
        return 1
    with zipfile.ZipFile(tmp) as zf:
        zf.extractall(DEST)
    tmp.unlink(missing_ok=True)
    if not marker.is_file():
        print("extract failed", file=sys.stderr)
        return 1
    print("ok", marker)
    return 0


if __name__ == "__main__":
    sys.exit(main())
