#!/usr/bin/env python3
"""Local 127.0.0.1 viewer for a Grok Imagine export library."""

from __future__ import annotations

import argparse
import cover_acceleration
import errno
import hashlib
import hmac
import json
import mimetypes
import ntpath
from functools import lru_cache
import os
import posixpath
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import webbrowser
import viewer_preferences
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

DEFAULT_PORT = 19706
BIND_HOST = "127.0.0.1"
LOCAL_HTTP_HOSTS = frozenset(("127.0.0.1", "localhost"))
# 9706 sits in common Windows Hyper-V excluded ranges (WinError 10013).
FALLBACK_PORTS = (9806, 9906, 18765, 28080)

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(REPO_DIR, "static")

# Tests may point this at a tempfile so HOME is not touched.
CONFIG_PATH_OVERRIDE = None

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VIDEO_EXT = {".mp4", ".webm"}

MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}

SECTIONS = ("combos", "_other", "loose", "_root")
PRESET_TAGS = ("ACG",)
META_NAME = ".viewer-meta.json"
META_LOCK_NAME = ".viewer-meta.lock"
META_VERSION = 2
META_REVISION_MAX = (1 << 53) - 1
LIB_CONFIG_NAME = ".viewer-config.json"
TRASH_DIR = ".trash"
GALLERY_LOCK_NAME = ".viewer-write.lock"
DOWNLOAD_BIND_ONLY_ENV = "GIV_DOWNLOAD_BIND_ONLY"
DESKTOP_AUTH_PROTOCOL = 3
DESKTOP_AUTH_MAX_BOOTSTRAP = 1024
# Cover stills live in the library so a viewer upgrade never re-extracts them.
CACHE_DIR = ".viewer-cache"
COVER_SUB = "covers"
COVER_EXT = ".jpg"
COVER_META_EXT = ".json"
COVER_WIDTH = 480
COVER_TIMEOUT = 12
PROBE_TIMEOUT = 8
COVER_FAIL_TTL = 300
COVER_QUEUE_MAX = 2048
# Imagine clips are seconds long; a day is a comfortable ceiling for anything a
# probe or a browser could sanely report.
MAX_DURATION = 24 * 3600
ICON_NAME = "grok_imagine_viewer.ico"
MEDIA_CACHE = "private, max-age=86400"
STATIC_CACHE = "private, max-age=3600"
SHELL_CACHE = "no-store"
SKIP_NAMES = (TRASH_DIR, CACHE_DIR, GALLERY_LOCK_NAME, META_LOCK_NAME, ".", "..")
ACCEL_MODES = ("auto", "compat")
HISTORY_MAX = 12
CARDS_BATCH_MAX = 120
# How many index rows the library shell may check against the disk. Keeps a stale
# index from turning one library open into thousands of CIFS round trips; anything
# past the budget is corrected by /api/cards once the tile is on screen.
SHELL_VERIFY_MAX = 120


def download_bind_only_mode():
    return os.environ.get(DOWNLOAD_BIND_ONLY_ENV) == "1"


def _decode_lower_hex(value, size):
    if not isinstance(value, str) or len(value) != size * 2:
        raise ValueError("invalid secret")
    if not re.fullmatch(r"[0-9a-f]+", value):
        raise ValueError("invalid secret")
    return bytes.fromhex(value)


class DesktopAuth:
    """Ephemeral Tauri-only trust material. Never persist or include it in repr."""

    __slots__ = ("instance_secret", "session_token", "instance_id", "instance_id_bytes")

    def __init__(self, instance_secret, session_token, instance_id):
        self.instance_secret = _decode_lower_hex(instance_secret, 32)
        _decode_lower_hex(session_token, 32)
        self.instance_id_bytes = _decode_lower_hex(instance_id, 16)
        self.session_token = session_token
        self.instance_id = instance_id

    def __repr__(self):
        return "DesktopAuth(<redacted>)"

    @classmethod
    def read_bootstrap(cls, stream):
        raw = stream.readline(DESKTOP_AUTH_MAX_BOOTSTRAP + 1)
        if not raw or len(raw) > DESKTOP_AUTH_MAX_BOOTSTRAP or not raw.endswith(b"\n"):
            raise ValueError("desktop authentication bootstrap is invalid")
        if stream.read(1):
            raise ValueError("desktop authentication bootstrap is invalid")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("desktop authentication bootstrap is invalid") from None
        expected = {"protocolVersion", "instanceSecret", "sessionToken", "instanceId"}
        if not isinstance(payload, dict) or set(payload) != expected:
            raise ValueError("desktop authentication bootstrap is invalid")
        version = payload.get("protocolVersion")
        if isinstance(version, bool) or version != DESKTOP_AUTH_PROTOCOL:
            raise ValueError("desktop authentication bootstrap is invalid")
        try:
            return cls(payload["instanceSecret"], payload["sessionToken"], payload["instanceId"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("desktop authentication bootstrap is invalid") from None

    def cookie_name(self, port):
        return "GIV_SESSION_%d" % int(port)

    def challenge_response(self, challenge, port):
        pid = os.getpid()
        message = (
            b"giv-identity-v3\0"
            + challenge
            + self.instance_id_bytes
            + int(port).to_bytes(2, "big")
            + int(pid).to_bytes(4, "big")
            + b"\x01"
        )
        return hmac.new(self.instance_secret, message, hashlib.sha256).hexdigest()


class ViewerHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive, 1)
        super().server_bind()


def guess_mime(filename, fallback=""):
    ext = os.path.splitext(filename)[1].lower()
    if ext in MIME_BY_EXT:
        return MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or fallback or "application/octet-stream"


def is_video(item):
    mime = (item.get("mime") or "").lower()
    filename = item.get("file") or ""
    ext = os.path.splitext(filename)[1].lower()
    return mime.startswith("video/") or ext in VIDEO_EXT


def is_image(item):
    mime = (item.get("mime") or "").lower()
    filename = item.get("file") or ""
    ext = os.path.splitext(filename)[1].lower()
    if is_video(item):
        return False
    return mime.startswith("image/") or ext in IMAGE_EXT


def media_kind(item):
    if is_video(item):
        return "video"
    if is_image(item):
        return "image"
    return "other"


def read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


class StoreError(Exception):
    """A sidecar JSON could not be read, so nothing may be written over it."""

    code = "store_unavailable"

    def __init__(self, path, reason=""):
        super().__init__("%s: %s" % (path, reason) if reason else path)
        self.path = path
        self.reason = reason


class StoreUnavailable(StoreError):
    code = "store_unavailable"


class StoreCorrupt(StoreError):
    code = "store_corrupt"


STORE_MESSAGES = {
    "store_unavailable": "无法读取库内元数据文件（权限或网络问题），已停止写入以免清空收藏和标签。",
    "store_corrupt": "库内元数据文件已损坏，已停止写入以免清空收藏和标签。",
}

# 503: come back when the share answers again. 409: a human has to look at the file.
STORE_STATUS = {"store_unavailable": 503, "store_corrupt": 409}


class GalleryLockError(Exception):
    """The library-wide OS write lease could not be acquired."""

    code = "gallery_lock_unavailable"
    status = 503

    def __init__(self, path, reason=""):
        super().__init__("%s: %s" % (path, reason) if reason else path)
        self.path = path
        self.reason = reason


class LibraryBusy(GalleryLockError):
    code = "library_busy"
    status = 423


class GalleryLockUnavailable(GalleryLockError):
    code = "gallery_lock_unavailable"
    status = 503


class MetaBusy(GalleryLockError):
    code = "meta_busy"
    status = 423


class MetaLockUnavailable(GalleryLockError):
    code = "meta_lock_unavailable"
    status = 503


GALLERY_LOCK_MESSAGES = {
    "library_busy": "图库正在被另一项写入任务占用，请稍后再试。",
    "gallery_lock_unavailable": "无法取得图库写入锁，已停止操作以免损坏图库。",
    "meta_busy": "图库元数据正在被另一窗口更新，请稍后再试。",
    "meta_lock_unavailable": "无法取得图库元数据锁，已停止操作以免覆盖收藏和标签。",
}


def gallery_lock_error_result(exc, **extra):
    row = {
        "ok": False,
        "code": exc.code,
        "error": GALLERY_LOCK_MESSAGES.get(exc.code, str(exc)),
        "path": exc.path,
        "status": exc.status,
    }
    row.update(extra)
    return row


def _gallery_lock_contended(exc):
    return getattr(exc, "errno", None) in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) or getattr(
        exc, "winerror", None
    ) in (32, 33, 36)


class GalleryWriteLease:
    """A cross-process OS lease for one physical library.

    The permanent file is diagnostic infrastructure, not the lock itself. The
    live fd/handle owns the lock and a crashed process releases it. Never delete
    or replace the file: doing so could create a second lock inode.
    """

    busy_error = LibraryBusy
    unavailable_error = GalleryLockUnavailable

    def __init__(self, root, owner="python-viewer", operation_id=""):
        self.root = os.path.realpath(os.path.abspath(os.path.expanduser(root or "")))
        self.path = os.path.join(self.root, GALLERY_LOCK_NAME)
        self.owner = str(owner or "python-viewer")[:64]
        self.operation_id = str(operation_id or "")[:128] or (
            "%s-%s-%s" % (os.getpid(), threading.get_ident(), time.time_ns())
        )
        self.fd = None
        self.refresh_diagnostic = True

    def __enter__(self):
        if not self.root or not os.path.isdir(self.root):
            raise self.unavailable_error(self.path, "library root is unavailable")
        try:
            if os.path.islink(self.path) or (os.path.exists(self.path) and not os.path.isfile(self.path)):
                raise self.unavailable_error(self.path, "lock path is not a regular file")
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            self.fd = os.open(self.path, flags, 0o600)
        except GalleryLockError:
            raise
        except OSError as exc:
            raise self.unavailable_error(self.path, str(exc)) from exc
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            if _gallery_lock_contended(exc):
                raise self.busy_error(self.path, str(exc)) from exc
            raise self.unavailable_error(self.path, str(exc)) from exc
        try:
            opened = os.fstat(self.fd)
            named = os.stat(self.path, follow_symlinks=False)
            if (
                not stat.S_ISREG(opened.st_mode)
                or not stat.S_ISREG(named.st_mode)
                or not os.path.samestat(opened, named)
                or os.path.normcase(os.path.realpath(self.path)) != os.path.normcase(self.path)
            ):
                raise self.unavailable_error(self.path, "lock identity changed")
            self._write_diagnostic()
        except GalleryLockError:
            os.close(self.fd)
            self.fd = None
            raise
        except OSError as exc:
            os.close(self.fd)
            self.fd = None
            raise self.unavailable_error(self.path, str(exc)) from exc
        return self

    def _write_diagnostic(self):
        if not self.refresh_diagnostic and os.fstat(self.fd).st_size > 0:
            return
        payload = (
            json.dumps(
                {
                    "protocol": 1,
                    "owner": self.owner,
                    "pid": os.getpid(),
                    "operationId": self.operation_id,
                    "startedAtUnix": int(time.time()),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
        os.ftruncate(self.fd, 0)
        os.lseek(self.fd, 0, os.SEEK_SET)
        view = memoryview(payload)
        while view:
            written = os.write(self.fd, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fsync(self.fd)

    def __exit__(self, exc_type, exc, tb):
        fd = self.fd
        self.fd = None
        if fd is None:
            return False
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            # Closing the descriptor is the final release path on both kernels.
            pass
        finally:
            os.close(fd)
        return False


def gallery_write_lease(root, owner="python-viewer", operation_id=""):
    return GalleryWriteLease(root, owner=owner, operation_id=operation_id)


class MetaWriteLease(GalleryWriteLease):
    """Cross-process lease for the meta sidecar in one physical library."""

    busy_error = MetaBusy
    unavailable_error = MetaLockUnavailable

    def __init__(self, root, owner="python-meta", operation_id=""):
        super().__init__(root, owner=owner, operation_id=operation_id)
        self.path = os.path.join(self.root, META_LOCK_NAME)
        # The lock file is a permanent identity. Its diagnostic may be stale;
        # avoid an extra SMB truncate+fsync for every favorite click.
        self.refresh_diagnostic = False


def meta_write_lease(root, owner="python-meta", operation_id=""):
    return MetaWriteLease(root, owner=owner, operation_id=operation_id)


def store_error_result(exc, **extra):
    row = {
        "ok": False,
        "code": exc.code,
        "error": STORE_MESSAGES.get(exc.code, str(exc)),
        "path": exc.path,
        "status": STORE_STATUS.get(exc.code, 503),
    }
    row.update(extra)
    return row


_store_locks = {}
_store_locks_guard = threading.Lock()


def store_lock(path):
    """One RLock per sidecar path so read-modify-write inside this process serializes."""
    key = os.path.abspath(path)
    with _store_locks_guard:
        lock = _store_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _store_locks[key] = lock
        return lock


def read_json_store(path):
    """None only when the file truly does not exist. Anything else raises."""
    try:
        data = read_json(path)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise StoreCorrupt(path, str(exc))
    except UnicodeDecodeError as exc:
        raise StoreCorrupt(path, str(exc))
    except (OSError, ValueError) as exc:
        # Permission denied, CIFS blip, a directory in the way: never a default.
        raise StoreUnavailable(path, str(exc))
    if not isinstance(data, dict):
        raise StoreCorrupt(path, "not a JSON object")
    return data


def portable_config_path():
    return os.path.join(REPO_DIR, ".viewer-config.json")


def home_config_path():
    return os.path.join(os.path.expanduser("~"), ".config", "grok_imagine_viewer", "config.json")


def config_path():
    if CONFIG_PATH_OVERRIDE:
        return CONFIG_PATH_OVERRIDE
    return portable_config_path()


def load_config_strict():
    """Raises StoreError so a read failure can never be written back as {}."""
    data = read_json_store(config_path()) or {}
    if data.get("root") or CONFIG_PATH_OVERRIDE:
        return data
    try:
        home = read_json_store(home_config_path())
    except StoreError:
        return data
    if home and home.get("root"):
        save_config(home)
        return home
    return data


def load_config():
    """Best effort for readers. Writers go through save_config_patch."""
    try:
        return load_config_strict()
    except StoreError:
        return {}


def save_config(data):
    path = config_path()
    parent = os.path.dirname(path)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError:
            return False
    try:
        with store_lock(path):
            write_json_atomic(path, data)
        return True
    except OSError:
        return False


def save_config_patch(patch):
    """Read-modify-write under one lock; refuses when the old file is unreadable."""
    path = config_path()
    with store_lock(path):
        cfg = load_config_strict()
        cfg.update(patch or {})
        if not save_config(cfg):
            raise StoreUnavailable(path, "write failed")
        return cfg


def get_preferences():
    cfg = load_config_strict()
    return {"ok": True, "preferences": viewer_preferences.read_preferences(cfg),
            "systemLanguage": viewer_preferences.system_language()}


def put_preferences(payload):
    try:
        with store_lock(config_path()):
            cfg = load_config_strict()
            prefs = viewer_preferences.update_preferences(cfg, payload)
            cfg["preferences"] = prefs
            if not save_config(cfg):
                raise StoreUnavailable(config_path(), "write failed")
        return {"ok": True, "preferences": viewer_preferences.read_preferences(cfg)}
    except ValueError as exc:
        return {"ok": False, "code": "invalid_preferences", "error": str(exc), "status": 400}
    except StoreError as exc:
        return store_error_result(exc)


def remember_root(path):
    """Record the opened library. A config we cannot read is one we must not
    overwrite, so a failure here loses the memory, never the old file."""
    path = os.path.abspath(os.path.expanduser(str(path or "")))
    if not path:
        return False
    cfg_path = config_path()
    try:
        with store_lock(cfg_path):
            cfg = load_config_strict()
            cfg["root"] = path
            push_history(cfg, path)
            return save_config(cfg)
    except StoreError:
        return False


def history_paths(cfg=None):
    data = cfg if isinstance(cfg, dict) else load_config()
    out = []
    seen = set()
    raw = data.get("history")
    if isinstance(raw, list):
        source = raw
    else:
        last = str(data.get("root") or "").strip()
        source = [last] if last else []
    for item in source:
        path = str(item or "").strip()
        if not path:
            continue
        path = os.path.abspath(os.path.expanduser(path))
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out[:HISTORY_MAX]


def push_history(cfg, path):
    """Most recent first, de-duplicated, capped. Bad paths stay on the list."""
    if not isinstance(cfg, dict):
        cfg = {}
    path = os.path.abspath(os.path.expanduser(str(path or "")))
    if not path:
        return cfg
    rest = [p for p in history_paths(cfg) if p != path]
    cfg["history"] = [path] + rest[: HISTORY_MAX - 1]
    return cfg


def drop_history_path(path):
    path = os.path.abspath(os.path.expanduser(str(path or "").strip()))
    if not path:
        return {"ok": False, "error": "路径无效。", "status": 400}
    cfg_path = config_path()
    try:
        with store_lock(cfg_path):
            cfg = load_config_strict()
            kept = [item for item in history_paths(cfg) if item != path]
            cfg["history"] = kept
            if not save_config(cfg):
                raise StoreUnavailable(cfg_path, "write failed")
    except StoreError as exc:
        return store_error_result(exc)
    return {"ok": True, "history": history_entries()}


def clear_history():
    cfg_path = config_path()
    try:
        with store_lock(cfg_path):
            cfg = load_config_strict()
            cfg["history"] = []
            if not save_config(cfg):
                raise StoreUnavailable(cfg_path, "write failed")
    except StoreError as exc:
        return store_error_result(exc)
    return {"ok": True, "history": []}


def created_sort_key(value):
    """Comparable instant for an item's `created` string.

    Raw comparison is wrong across UTC offsets (`…T01:00+09:00` is earlier than
    `…T23:00Z` the day before) and across the optional fractional seconds.
    Unparseable or missing dates keep sorting first, where the old empty-string
    comparison already placed them.
    """
    raw = str(value or "").strip()
    if not raw:
        return (0, 0.0, "")
    text = raw
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return (0, 0.0, raw)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return (1, stamp.timestamp(), raw)


def history_entries():
    """Cheap probe only: isdir plus marker names, never a full library scan."""
    rows = []
    for path in history_paths():
        exists = False
        markers = []
        try:
            exists = os.path.isdir(path)
            if exists:
                markers = library_markers(path)
        except OSError:
            exists = False
        rows.append(
            {
                "path": path,
                "name": os.path.basename(path.rstrip(os.sep)) or path,
                "exists": exists,
                "markers": markers,
            }
        )
    return rows


def write_json_atomic(path, data):
    """Unique tmp per writer: a fixed `.tmp` lets two viewers clobber each other."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), os.urandom(4).hex())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def icon_file():
    path = os.path.join(REPO_DIR, ICON_NAME)
    return path if os.path.isfile(path) else None


def group_key(section, folder):
    if section == "_root":
        return "_root"
    return "%s/%s" % (section, folder or "")


def default_meta():
    return {
        "version": META_VERSION,
        "revision": 0,
        "tags": list(PRESET_TAGS),
        "items": {},
        "groups": {},
        "grokUserId": "",
    }


def normalize_grok_user_id(raw):
    """The gallery bind: an opaque grok.com account id (userId or email hash).

    Only shape is enforced here — one printable line, bounded length — because
    the id comes from an account endpoint probed by a legacy client."""
    value = str(raw or "").strip()
    if len(value) > 200:
        return ""
    if any(ch in value for ch in ("\n", "\r", "\x00")):
        return ""
    return value


def normalize_tag_list(raw):
    out = []
    seen = set()
    for item in raw if isinstance(raw, list) else []:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    for preset in PRESET_TAGS:
        if preset not in seen:
            out.insert(0, preset)
            seen.add(preset)
    return out


def normalize_flags(raw):
    if not isinstance(raw, dict):
        raw = {}
    tags = []
    seen = set()
    for item in raw.get("tags") if isinstance(raw.get("tags"), list) else []:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        tags.append(name)
    return {
        "fav": bool(raw.get("fav")),
        "dislike": bool(raw.get("dislike")),
        "tags": tags,
    }


def normalize_group(raw):
    rec = normalize_flags(raw)
    last = ""
    if isinstance(raw, dict):
        last = str(raw.get("lastViewedId") or "").strip()
        if last and not is_safe_name(last):
            last = ""
    rec["lastViewedId"] = last
    return rec


def normalize_meta(data):
    meta = default_meta()
    if not isinstance(data, dict):
        return meta
    if data.get("version") == META_VERSION:
        revision = data.get("revision")
        if (
            isinstance(revision, int)
            and not isinstance(revision, bool)
            and 0 <= revision <= META_REVISION_MAX
        ):
            meta["revision"] = revision
    meta["tags"] = normalize_tag_list(data.get("tags"))
    items = data.get("items") if isinstance(data.get("items"), dict) else {}
    groups = data.get("groups") if isinstance(data.get("groups"), dict) else {}
    meta["items"] = {str(k): normalize_flags(v) for k, v in items.items() if k}
    meta["groups"] = {str(k): normalize_group(v) for k, v in groups.items() if k}
    meta["grokUserId"] = normalize_grok_user_id(data.get("grokUserId"))
    return meta


def meta_path(root):
    return os.path.join(root, META_NAME)


def load_meta(root):
    """Missing file is a fresh library. Any other failure raises: writing a
    default over a half-written or unreadable file wipes favorites and tags."""
    if not root:
        return default_meta()
    path = meta_path(root)
    data = read_json_store(path)
    if data is None:
        return default_meta()
    version = data.get("version", 1)
    if isinstance(version, bool) or not isinstance(version, int) or version not in (1, META_VERSION):
        raise StoreCorrupt(path, "unsupported meta schema")
    if version == META_VERSION:
        revision = data.get("revision")
        if (
            isinstance(revision, bool)
            or not isinstance(revision, int)
            or revision < 0
            or revision > META_REVISION_MAX
        ):
            raise StoreCorrupt(path, "invalid meta revision")
    return normalize_meta(data)


def load_meta_safe(root):
    """For read-only views: degrade to empty flags, and say so."""
    try:
        return load_meta(root), ""
    except StoreError as exc:
        return default_meta(), exc.code


def save_meta(root, meta):
    write_json_atomic(meta_path(root), normalize_meta(meta))


def default_volume():
    return {"level": 100, "muted": False}


def normalize_volume(raw):
    """App-wide playback volume. Python owns `.viewer-config.json`, so the
    Desktop clients read/write this through the HTTP API only (one writer)."""
    vol = default_volume()
    if not isinstance(raw, dict):
        return vol
    try:
        level = int(raw.get("level"))
    except (TypeError, ValueError):
        level = vol["level"]
    vol["level"] = max(0, min(100, level))
    vol["muted"] = bool(raw.get("muted"))
    return vol


def save_volume(patch):
    vol = normalize_volume(patch)
    save_config_patch({"volume": vol})
    return vol


TILE_MIN = 96
TILE_MAX = 240


# desc / asc order by date; fav puts hearts first; count puts fuller combos first.
# Older configs only ever held asc / desc, and both still mean what they meant.
SORT_MODES = ("desc", "asc", "fav", "count")


def default_view_prefs():
    return {"density": "compact", "sort": "desc", "cats": [], "tile": 0}


def default_views():
    return {
        "combos": default_view_prefs(),
        "flat": default_view_prefs(),
        "other": default_view_prefs(),
    }


def normalize_view_prefs(raw):
    base = default_view_prefs()
    if not isinstance(raw, dict):
        return base
    density = raw.get("density")
    if density in ("compact", "expanded"):
        base["density"] = density
    sort = raw.get("sort")
    if sort in SORT_MODES:
        base["sort"] = sort
    cats = raw.get("cats")
    if isinstance(cats, list):
        cleaned = []
        seen = set()
        for item in cats:
            name = str(item).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            cleaned.append(name)
        base["cats"] = cleaned
    tile = raw.get("tile")
    try:
        tile = int(tile)
    except (TypeError, ValueError):
        tile = 0
    # 0 keeps the built-in default for the density.
    base["tile"] = 0 if tile <= 0 else max(TILE_MIN, min(TILE_MAX, tile))
    return base


def normalize_views(raw):
    views = default_views()
    src = raw.get("views") if isinstance(raw, dict) and isinstance(raw.get("views"), dict) else raw
    if not isinstance(src, dict):
        return views
    for key in ("combos", "flat", "other"):
        views[key] = normalize_view_prefs(src.get(key))
    return views


def library_config_path(root):
    return os.path.join(root, LIB_CONFIG_NAME)


def load_library_config(root):
    if not root:
        return {"views": default_views()}
    data = read_json_store(library_config_path(root)) or {}
    data["views"] = normalize_views(data)
    return data


def load_library_config_safe(root):
    try:
        return load_library_config(root), ""
    except StoreError as exc:
        return {"views": default_views()}, exc.code


def save_library_views(root, views):
    path = library_config_path(root)
    with store_lock(path):
        data = load_library_config(root)
        data["views"] = normalize_views({"views": views} if isinstance(views, dict) and "combos" in views else views)
        write_json_atomic(path, data)
        return data["views"]


def tombstone_path(root, asset_id):
    return jail_join(root, TRASH_DIR, "by-id", asset_id + ".json")


def trash_media_rel(section, folder, filename):
    if section == "_root":
        return posixpath.join(TRASH_DIR, "_root", filename)
    return posixpath.join(TRASH_DIR, section, folder, filename)


def trash_media_abs(root, section, folder, filename):
    if section == "_root":
        return jail_join(root, TRASH_DIR, "_root", filename)
    return jail_join(root, TRASH_DIR, section, folder, filename)


def load_tombstone(root, asset_id):
    if not is_safe_name(asset_id):
        return None
    try:
        path = os.path.join(root, TRASH_DIR, "by-id", asset_id + ".json")
        root_real = os.path.realpath(root)
        real = os.path.realpath(path)
        if real != root_real and not real.startswith(root_real + os.sep):
            return None
        data = read_json(real)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, TypeError):
        return None


MISSING_ERRNOS = (errno.ENOENT, errno.ENOTDIR, errno.ENAMETOOLONG)


def folder_listing(directory):
    """One listdir beats a stat per item on CIFS: live names + `.trashed` markers.

    Third element is `available` / `missing` / `unavailable`. A CIFS blip is
    `unavailable`, which must never be read as "the user emptied this folder"."""
    if not directory:
        return frozenset(), frozenset(), "missing"
    try:
        names = os.listdir(directory)
    except OSError as exc:
        state = "missing" if getattr(exc, "errno", None) in MISSING_ERRNOS else "unavailable"
        return frozenset(), frozenset(), state
    tail = ".trashed"
    live = frozenset(name for name in names if not name.endswith(tail))
    markers = frozenset(name[: -len(tail)] for name in names if name.endswith(tail))
    return live, markers, "available"


def folder_trashed_markers(directory):
    return folder_listing(directory)[1]


def tombstone_phase(data):
    phase = data.get("phase") if isinstance(data, dict) else None
    return phase if isinstance(phase, str) and phase else "trashed"


def tombstone_body_state(root, data):
    """True/False for a controlled regular body; None for an unsafe path."""
    rel = data.get("to") if isinstance(data, dict) else None
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or "\\" in rel:
        return None
    parts = rel.split("/")
    if any(not is_safe_name(part) for part in parts):
        return None
    root_real = os.path.realpath(root)
    trash_real = os.path.realpath(os.path.join(root_real, TRASH_DIR))
    parent_real = os.path.realpath(os.path.join(root_real, *parts[:-1]))
    if parent_real != trash_real and not parent_real.startswith(trash_real + os.sep):
        return None
    path = os.path.join(parent_real, parts[-1])
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return None
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if getattr(st, "st_file_attributes", 0) & reparse or not stat.S_ISREG(st.st_mode):
        return None
    return True


def tombstone_origin_state(root, data):
    """True/False for a controlled live regular entry; None if indeterminate."""
    rel = data.get("from") if isinstance(data, dict) else None
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or "\\" in rel:
        return None
    parts = rel.split("/")
    if any(not is_safe_name(part) for part in parts):
        return None
    root_real = os.path.realpath(root)
    trash_real = os.path.realpath(os.path.join(root_real, TRASH_DIR))
    parent_real = os.path.realpath(os.path.join(root_real, *parts[:-1]))
    if parent_real != root_real and not parent_real.startswith(root_real + os.sep):
        return None
    if parent_real == trash_real or parent_real.startswith(trash_real + os.sep):
        return None
    path = os.path.join(parent_real, parts[-1])
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return None
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if getattr(st, "st_file_attributes", 0) & reparse or not stat.S_ISREG(st.st_mode):
        return None
    return True


def tombstone_hides_live(root, data):
    phase = tombstone_phase(data)
    if phase == "trashing":
        body = tombstone_body_state(root, data)
        origin = tombstone_origin_state(root, data)
        if body is None or origin is None:
            return True
        return body and not origin
    if phase == "restoring":
        # A pending restore hides the live item only while its body is still in
        # trash. Unsafe/indeterminate paths still fail closed.
        return tombstone_body_state(root, data) is not False
    return True


def item_is_trashed(
    root, item, directory=None, ids=None, markers=None, ignore_marker_ids=None
):
    """Tombstone or in-place `*.trashed` marker, same contract as the downloader."""
    asset_id = item.get("id") or ""
    filename = item.get("file") or ""
    if asset_id and is_safe_name(asset_id):
        if ids is not None:
            if asset_id in ids:
                return True
        else:
            marker = os.path.join(root, TRASH_DIR, "by-id", asset_id + ".json")
            try:
                if os.path.isfile(marker):
                    data = read_json(marker)
                    return tombstone_hides_live(root, data)
            except (OSError, ValueError, TypeError):
                return True
    if filename and is_safe_name(os.path.basename(filename)):
        if asset_id and ignore_marker_ids is not None and asset_id in ignore_marker_ids:
            return False
        if markers is not None:
            if filename in markers:
                return True
        elif directory:
            try:
                if os.path.isfile(os.path.join(directory, filename + ".trashed")):
                    return True
            except OSError:
                pass
    return False


_trash_cache = {}
_trash_cache_lock = threading.Lock()


def _trash_by_id_dir(root):
    return os.path.join(root, TRASH_DIR, "by-id")


def invalidate_trash_index(root=None):
    with _trash_cache_lock:
        if root:
            _trash_cache.pop(os.path.abspath(root), None)
        else:
            _trash_cache.clear()


def empty_trash_index():
    return {"ids": frozenset(), "groups": {}, "ignoreMarkerIds": frozenset()}


def _build_trash_index(root):
    by_id = _trash_by_id_dir(root)
    try:
        names = os.listdir(by_id)
    except OSError:
        return empty_trash_index()
    ids = set()
    ignore_marker_ids = set()
    groups = {}
    for name in names:
        if not name.endswith(".json"):
            continue
        asset_id = name[:-5]
        if not is_safe_name(asset_id):
            continue
        try:
            data = read_json(os.path.join(by_id, name))
        except (OSError, json.JSONDecodeError, TypeError):
            ids.add(asset_id)
            continue
        if not isinstance(data, dict):
            ids.add(asset_id)
            continue
        if not tombstone_hides_live(root, data):
            ignore_marker_ids.add(asset_id)
            continue
        ids.add(asset_id)
        section = data.get("section") or ""
        if section not in SECTIONS:
            continue
        rec = groups.setdefault(
            group_key(section, data.get("folder") or ""),
            {"count": 0, "images": 0, "videos": 0},
        )
        rec["count"] += 1
        kind = media_kind({"file": data.get("file") or ""})
        if kind == "video":
            rec["videos"] += 1
        elif kind == "image":
            rec["images"] += 1
    return {
        "ids": frozenset(ids),
        "groups": groups,
        "ignoreMarkerIds": frozenset(ignore_marker_ids),
    }


def trash_index(root):
    """Tombstone ids plus per-group delete counts, cached by the by-id dir stat."""
    if not root:
        return empty_trash_index()
    root = os.path.abspath(root)
    try:
        st = os.stat(_trash_by_id_dir(root))
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        key = None
    with _trash_cache_lock:
        hit = _trash_cache.get(root)
        if hit and hit[0] == key:
            return hit[1]
    snap = empty_trash_index() if key is None else _build_trash_index(root)
    with _trash_cache_lock:
        if len(_trash_cache) > 8:
            _trash_cache.clear()
        _trash_cache[root] = (key, snap)
    return snap


def list_tombstones(root):
    entries = []
    by_id = os.path.join(root, TRASH_DIR, "by-id")
    try:
        names = os.listdir(by_id)
    except OSError:
        return entries
    root_real = os.path.realpath(root)
    trash_real = os.path.realpath(os.path.join(root, TRASH_DIR))
    for name in names:
        if not name.endswith(".json"):
            continue
        asset_id = name[:-5]
        if not is_safe_name(asset_id):
            continue
        path = os.path.join(by_id, name)
        try:
            real = os.path.realpath(path)
            if real != root_real and not real.startswith(root_real + os.sep):
                continue
            data = read_json(real)
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        dest = data.get("to") or ""
        dest_abs = dest if os.path.isabs(dest) else os.path.join(root, dest)
        try:
            dest_real = os.path.realpath(dest_abs)
            exists = os.path.isfile(dest_real) and dest_real.startswith(trash_real + os.sep)
        except OSError:
            exists = False
        row = dict(data)
        row["id"] = data.get("id") or asset_id
        row["exists"] = exists
        row["cover"] = "/resource/trash/file?id=%s" % quote(row["id"]) if exists else None
        entries.append(row)
    entries.sort(key=lambda it: it.get("deletedAt") or "", reverse=True)
    return entries


def cover_cache_dir(root):
    return os.path.join(root, CACHE_DIR, COVER_SUB)


def cover_cache_path(root, asset_id):
    """Cached still for one asset, jailed inside <root>/.viewer-cache/covers."""
    if not root or not is_safe_name(asset_id):
        raise ValueError("bad id")
    base = os.path.realpath(root)
    holder = os.path.realpath(cover_cache_dir(base))
    if holder != base and not holder.startswith(base + os.sep):
        raise ValueError("escaped")
    path = os.path.realpath(os.path.join(holder, asset_id + COVER_EXT))
    if not path.startswith(holder + os.sep):
        raise ValueError("escaped")
    return path


def cover_meta_path(root, asset_id):
    """Sidecar beside the still: duration plus the fingerprint it was cut from."""
    return os.path.splitext(cover_cache_path(root, asset_id))[0] + COVER_META_EXT


def media_fingerprint(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def read_cover_meta(root, asset_id):
    try:
        path = cover_meta_path(root, asset_id)
    except ValueError:
        return None
    try:
        data = read_json(path)
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def write_cover_meta(root, asset_id, duration, fingerprint):
    try:
        path = cover_meta_path(root, asset_id)
    except ValueError:
        return False
    row = dict(fingerprint or {})
    if duration is not None:
        row["duration"] = duration
    else:
        # A length already on disk may have come from a standalone probe or from
        # the browser's own <video>. A cover cut whose ffprobe failed must not
        # take the badge away again.
        prior = (read_cover_meta(root, asset_id) or {}).get("duration")
        if isinstance(prior, (int, float)) and prior > 0:
            row["duration"] = float(prior)
    if not row:
        return False
    try:
        write_json_atomic(path, row)
        return True
    except OSError:
        return False


def write_duration_only(root, asset_id, duration, src=None):
    """Record a clip length without cutting a still.

    The badge must not wait for ffmpeg, so ffprobe (or the browser) can fill the
    sidecar on its own. The size / mtime in that sidecar describe the file a
    cached JPEG was cut from, so a probe that runs before extraction must leave
    an existing fingerprint alone rather than claim a still it never made.
    """
    if not isinstance(duration, (int, float)) or not duration > 0:
        return False
    try:
        path = cover_meta_path(root, asset_id)
        still = cover_cache_path(root, asset_id)
    except ValueError:
        return False
    row = dict(read_cover_meta(root, asset_id) or {})
    try:
        has_still = os.path.isfile(still)
    except OSError:
        has_still = False
    if not has_still and src:
        fingerprint = media_fingerprint(src)
        if fingerprint:
            row.update(fingerprint)
    row["duration"] = float(duration)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_json_atomic(path, row)
    except OSError:
        return False
    invalidate_duration_index(root)
    return True


def cover_meta_fresh(rec, fingerprint):
    """An older sidecar without a fingerprint is trusted: re-cutting every cover
    on upgrade would walk the whole library for nothing."""
    if not rec or not fingerprint:
        return True
    if rec.get("size") is None and rec.get("mtime_ns") is None:
        return True
    return rec.get("size") == fingerprint.get("size") and rec.get("mtime_ns") == fingerprint.get("mtime_ns")


def cover_cache_hit(root, asset_id, src=None):
    """The cached still, or None when it is missing or cut from an older file.

    Passing `src` opts into the fingerprint check: a re-encoded clip keeps its
    asset id, so size + mtime is the only thing that says the frame is stale."""
    try:
        path = cover_cache_path(root, asset_id)
    except ValueError:
        return None
    try:
        if not (os.path.isfile(path) and os.path.getsize(path) > 0):
            return None
    except OSError:
        return None
    if src:
        fingerprint = media_fingerprint(src)
        if fingerprint and not cover_meta_fresh(read_cover_meta(root, asset_id), fingerprint):
            return None
    return path


_duration_cache = {}
_duration_cache_lock = threading.Lock()


def _build_duration_index(root):
    holder = cover_cache_dir(root)
    try:
        names = os.listdir(holder)
    except OSError:
        return {}
    out = {}
    for name in names:
        if not name.endswith(COVER_META_EXT):
            continue
        asset_id = name[: -len(COVER_META_EXT)]
        if not is_safe_name(asset_id):
            continue
        rec = read_cover_meta(root, asset_id)
        if not rec:
            continue
        seconds = rec.get("duration")
        if isinstance(seconds, (int, float)) and seconds > 0:
            out[asset_id] = float(seconds)
    return out


def duration_index(root):
    """{assetId: seconds} for the whole cache, one listdir per cache generation.

    A per-item sidecar read would be thousands of round trips on a network
    share every time the flat wall is built."""
    if not root:
        return {}
    root = os.path.abspath(root)
    key = _duration_cache_key(root)
    with _duration_cache_lock:
        hit = _duration_cache.get(root)
        if hit and hit[0] == key:
            return hit[1]
    snap = {} if key is None else _build_duration_index(root)
    with _duration_cache_lock:
        if len(_duration_cache) > 8:
            _duration_cache.clear()
        _duration_cache[root] = (key, snap)
    return snap


def _duration_cache_key(root):
    try:
        st = os.stat(cover_cache_dir(root))
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def duration_lookup(root, asset_ids):
    """Read only requested sidecars, or reuse an already built full index.

    Opening one combo or fetching one cover must not scan every duration file
    before the browser can start playing. Flat/batch readers retain the full
    index path. A partial lookup never masquerades as a complete cache entry.
    """
    wanted = {asset_id for asset_id in asset_ids if isinstance(asset_id, str) and is_safe_name(asset_id)}
    if not root or not wanted:
        return {}
    root = os.path.abspath(root)
    key = _duration_cache_key(root)
    with _duration_cache_lock:
        hit = _duration_cache.get(root)
        if hit and hit[0] == key:
            return {asset_id: hit[1][asset_id] for asset_id in wanted if asset_id in hit[1]}
    out = {}
    for asset_id in sorted(wanted):
        rec = read_cover_meta(root, asset_id)
        seconds = rec.get("duration") if rec else None
        # Keep the same sidecar acceptance contract as _build_duration_index.
        if isinstance(seconds, (int, float)) and seconds > 0:
            out[asset_id] = float(seconds)
    return out


def invalidate_duration_index(root=None):
    with _duration_cache_lock:
        if root:
            _duration_cache.pop(os.path.abspath(root), None)
        else:
            _duration_cache.clear()


def _bundled_tool(stem):
    name = stem + ".exe" if os.name == "nt" else stem
    # Optional portable tools sit beside viewer/, so program updates preserve
    # them without copying anything from user profiles or changing PATH.
    if os.path.basename(REPO_DIR).lower() == "viewer":
        optional = os.path.join(os.path.dirname(REPO_DIR), "video-tools", name)
        if os.path.isfile(optional):
            return optional
    for rel in (("runtime", "win64", name), ("runtime", "linux64", name), (name,)):
        path = os.path.join(REPO_DIR, *rel)
        if os.path.isfile(path):
            return path
    return None


def _bundled_ffmpeg():
    return _bundled_tool("ffmpeg")


def _resolve_tool(stem, env_name, config_key):
    """Env override, config, bundled runtime, PATH, then WinGet aliases."""
    for candidate in (os.environ.get(env_name), load_config().get(config_key)):
        raw = str(candidate or "").strip()
        if not raw:
            continue
        if os.path.isfile(raw):
            return raw
        found = shutil.which(raw)
        if found:
            return found
    bundled = _bundled_tool(stem)
    if bundled:
        return bundled
    return shutil.which(stem) or _winget_tool(stem)


def _winget_tool(stem):
    # WinGet creates these aliases even though this already-running process
    # still has its old PATH. Do not scan package/profile trees or change PATH.
    if os.name != "nt" or stem not in ("ffmpeg", "ffprobe"):
        return None
    for variable in ("LOCALAPPDATA", "ProgramFiles"):
        base = os.environ.get(variable)
        if base:
            relative = ("Microsoft", "WinGet", "Links") if variable == "LOCALAPPDATA" else ("WinGet", "Links")
            candidate = os.path.join(base, *relative, stem + ".exe")
            if os.path.isfile(candidate):
                return candidate
    return None


def resolve_ffmpeg():
    return _resolve_tool("ffmpeg", "VIEWER_FFMPEG", "ffmpeg")


def resolve_ffprobe():
    """Prefer the ffprobe sitting next to the ffmpeg we actually use.

    VIEWER_FFMPEG / a bundled runtime / a stub in tests all ship the pair in
    one folder. Looking up `ffprobe` on PATH first would ignore that pair and
    probe with a different binary (or fail the stub).
    """
    for candidate in (os.environ.get("VIEWER_FFPROBE"), load_config().get("ffprobe")):
        raw = str(candidate or "").strip()
        if not raw:
            continue
        if os.path.isfile(raw):
            return raw
        found = shutil.which(raw)
        if found:
            return found
    ffmpeg = resolve_ffmpeg()
    if ffmpeg:
        sibling = os.path.join(os.path.dirname(ffmpeg), "ffprobe.exe" if os.name == "nt" else "ffprobe")
        if os.path.isfile(sibling):
            return sibling
    bundled = _bundled_tool("ffprobe")
    if bundled:
        return bundled
    return shutil.which("ffprobe") or _winget_tool("ffprobe")


def _tool_health(stem, binary):
    if not binary:
        return {"ready": False, "reason": "missing"}
    try:
        result = subprocess.run(
            [binary, "-version"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        line = result.stdout.decode("utf-8", "replace").splitlines()
        version = re.match(r"^" + stem + r" version (\S+)", line[0] if line else "")
        if result.returncode == 0 and version:
            return {"ready": True, "version": version.group(1)[:100]}
    except subprocess.TimeoutExpired:
        return {"ready": False, "reason": "timeout"}
    except (OSError, subprocess.SubprocessError):
        pass
    return {"ready": False, "reason": "unusable"}


def environment_status():
    """Read-only startup check; no library, browser data or install side effects."""
    global _accel_state
    binaries = {"ffmpeg": resolve_ffmpeg(), "ffprobe": resolve_ffprobe()}
    tools = {name: _tool_health(name, binary) for name, binary in binaries.items()}
    # Forget only the in-memory tool snapshot. The next cover request probes
    # the new pair without overwriting preferences or touching a library.
    with _accel_probe_lock:
        with _accel_lock:
            if _accel_state and any(_accel_state.get(name, "") != (binary or "") for name, binary in binaries.items()):
                _accel_state = None
    return {"ffmpeg": {"ready": all(tool["ready"] for tool in tools.values()), "tools": tools}}


DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")


def _run_probe(args, timeout=PROBE_TIMEOUT):
    try:
        return subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def probe_duration(src, probe=None, ffmpeg=None):
    """Seconds for one clip, or None. ffprobe first, then the ffmpeg banner."""
    if not src or not os.path.isfile(src):
        return None
    probe = probe if probe is not None else resolve_ffprobe()
    if probe:
        proc = _run_probe(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src]
        )
        if proc is not None and proc.returncode == 0:
            text = (proc.stdout or b"").decode("utf-8", "replace").strip()
            try:
                seconds = float(text)
            except ValueError:
                seconds = 0.0
            if seconds > 0:
                return seconds
    ffmpeg = ffmpeg if ffmpeg is not None else resolve_ffmpeg()
    if not ffmpeg:
        return None
    # `ffmpeg -i` with no output exits non-zero on purpose; the banner is the point.
    proc = _run_probe([ffmpeg, "-hide_banner", "-i", src])
    if proc is None:
        return None
    text = (proc.stderr or b"").decode("utf-8", "replace")
    match = DURATION_RE.search(text)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    total = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return total if total > 0 else None


def probe_hwaccels(binary):
    if not binary:
        return []
    try:
        proc = subprocess.run(
            [binary, "-hide_banner", "-hwaccels"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    text = (proc.stdout or b"").decode("utf-8", "replace")
    names = []
    for line in text.splitlines():
        token = line.strip().lower()
        if token not in cover_acceleration.BACKENDS[1:] or token in names:
            continue
        names.append(token)
    return names


def probe_gpu():
    if sys.platform == "darwin":
        return "apple"
    nvidia = shutil.which("nvidia-smi")
    if nvidia:
        try:
            result = subprocess.run([nvidia, "--query-gpu=name", "--format=csv,noheader"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
            if result.returncode == 0 and (result.stdout or b"").strip():
                return "nvidia"
        except (OSError, subprocess.SubprocessError):
            pass
    if os.name == "nt":
        return "windows"
    try:
        if os.path.isdir("/dev/dri") and os.listdir("/dev/dri"):
            return "drm"
    except OSError:
        pass
    return ""


def hwaccel_choice(hwaccels, gpu):
    return cover_acceleration.choose_backend(hwaccels, gpu, sys.platform)


def accel_config_mode():
    mode = str(load_config().get("accel") or "auto").strip().lower()
    if mode == "hardware":
        return "auto"
    return mode if mode in ACCEL_MODES else "auto"


_accel_lock = threading.Lock()
_accel_probe_lock = threading.RLock()
_accel_state = None
_accel_generation = 0
_cover_backoff = cover_acceleration.SourceBackoff()


def accel_state(refresh=False):
    global _accel_state, _accel_generation
    # Serialize probes and settings updates, so an old slow probe cannot publish
    # a stale policy over the user's newer selection. Only this lock spans I/O.
    with _accel_probe_lock:
        with _accel_lock:
            if _accel_state and not refresh:
                return dict(_accel_state)
            _accel_generation += 1
            generation = _accel_generation
        config = load_config()
        mode = str(config.get("accel") or "auto").strip().lower()
        mode = mode if mode in ACCEL_MODES else "auto"
        preference = config.get("coverBackend", "auto")
        if preference not in cover_acceleration.BACKENDS:
            preference = "auto"
        binary = resolve_ffmpeg()
        compiled = probe_hwaccels(binary) if binary else []
        gpu = probe_gpu() if mode == "auto" else ""
        hw = cover_acceleration.choose_backend(compiled, gpu, sys.platform, preference) if mode == "auto" else ""
        state = {
            "mode": mode, "backendPreference": preference,
            # Legacy field describes selection only, never observed GPU use.
            "effective": "hardware" if hw else "compat", "hwaccel": hw,
            "candidateBackend": hw or "cpu", "decodeStatus": "not_observed",
            "availableBackends": cover_acceleration.available_backends(compiled, sys.platform),
            "scaleBackend": "cpu", "encodeBackend": "cpu", "generation": generation,
            "hwaccels": compiled, "gpu": gpu, "ffmpeg": binary or "",
            "ffprobe": resolve_ffprobe() or "", "covers": bool(binary),
            "coverDecode": "hardware-then-cpu" if hw else "cpu",
            "fallback": "" if mode == "compat" or hw else (
                "未找到 ffmpeg" if not binary else "没有适合当前平台的候选后端；使用 CPU"),
        }
        with _accel_lock:
            _accel_state = state
        return dict(state)


def set_accel_mode(mode, backend=None):
    raw = str(mode or "").strip().lower()
    if raw == "hardware":
        raw = "auto"
    if raw not in ACCEL_MODES or (backend is not None and backend not in cover_acceleration.BACKENDS):
        raise ValueError("bad cover policy")
    patch = {"accel": raw}
    if backend is not None:
        patch["coverBackend"] = backend
    with _accel_probe_lock:
        save_config_patch(patch)
        return accel_state(refresh=True)


def record_cover_attempt(snap, backend, succeeded, elapsed_ms):
    # An older job must not relabel the policy changed while it was running.
    with _accel_lock:
        if _accel_state and snap.get("generation") == _accel_state.get("generation"):
            _accel_state["lastAttempt"] = {
                "backend": backend or "cpu", "succeeded": bool(succeeded),
                "elapsedMs": max(0, int(elapsed_ms)),
            }
            # Even a successful FFmpeg command can internally use software.
            _accel_state["decodeStatus"] = "command_succeeded" if succeeded else "command_failed"


def cover_extract_args(binary, src, dest, hwaccel, seek):
    args = [binary, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if hwaccel:
        args += ["-hwaccel", hwaccel]
    if seek:
        args += ["-ss", "%.2f" % seek]
    args += [
        "-i",
        src,
        "-frames:v",
        "1",
        "-an",
        "-vf",
        # The comma is escaped for ffmpeg's filtergraph parser, not for Python.
        r"scale=min(%d\,iw):-2" % COVER_WIDTH,
        "-q:v",
        "5",
        dest,
    ]
    return args


def extract_video_cover(root, src, asset_id, state=None):
    """Grab one frame into the library cache. Returns the path, or None."""
    snap = state or accel_state()
    binary = snap.get("ffmpeg")
    if not binary or not src or not os.path.isfile(src):
        return None
    try:
        dest = cover_cache_path(root, asset_id)
    except ValueError:
        return None
    # Stat before the cut: the fingerprint has to describe the file the frame
    # came from, or a clip re-encoded during extraction keeps a stale cover.
    fingerprint = media_fingerprint(src)
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
    except OSError:
        return None
    # A library can be open in two viewers at once; keep their temp files apart.
    tmp = "%s.%d.%s.tmp.jpg" % (dest, os.getpid(), os.urandom(4).hex())
    # GPT6PRO_THUMBNAILS: decode to system frames for the existing software
    # scale/JPEG graph. Never request GPU output frames without hwdownload.
    # Any unsupported device/codec falls back to the original CPU path.
    hw = snap.get("hwaccel") if snap.get("mode") != "compat" else ""
    is_still = os.path.splitext(src)[1].lower() in IMAGE_EXT
    backoff_key = (snap.get("generation"), binary, os.path.abspath(src),
                   json.dumps(fingerprint, sort_keys=True), hw)
    if hw and _cover_backoff.blocked(backoff_key):
        hw = ""
    attempts = ([(hw, 1.0)] if hw and not is_still else []) + ([("", 0.0)] if is_still else [("", 1.0), ("", 0.0)])
    for hwaccel, seek in attempts:
        started = time.monotonic()
        try:
            proc = subprocess.run(
                cover_extract_args(binary, src, tmp, hwaccel, seek),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=COVER_TIMEOUT,
            )
            code = proc.returncode
        except (OSError, subprocess.SubprocessError):
            code = -1
        ok = code == 0
        if ok:
            try:
                ok = os.path.getsize(tmp) > 0
            except OSError:
                ok = False
        decode_ok = ok
        record_cover_attempt(snap, hwaccel, decode_ok, (time.monotonic() - started) * 1000)
        if hwaccel:
            if decode_ok:
                _cover_backoff.clear(backoff_key)
            else:
                _cover_backoff.fail(backoff_key)
        if ok and media_fingerprint(src) != fingerprint:
            ok = False
        if ok:
            try:
                os.replace(tmp, dest)
            except OSError:
                ok = False
            else:
                # One probe per newly cut cover, so the duration badge costs
                # nothing on the walls that read it back from the sidecar.
                duration = None if is_still else probe_duration(src, probe=snap.get("ffprobe") or None, ffmpeg=binary)
                write_cover_meta(root, asset_id, duration, fingerprint)
                invalidate_duration_index(root)
                return dest
        try:
            os.remove(tmp)
        except OSError:
            pass
    return None


class CoverQueue:
    """One background worker so opening a library never blocks on ffmpeg."""

    def __init__(self):
        self.cond = threading.Condition()
        self.jobs = deque()
        self.pending = set()
        self.failed = {}
        self.worker = None
        self.done = 0

    def enqueue(self, root, src, asset_id):
        if not root or not src or not is_safe_name(asset_id or ""):
            return False
        if not accel_state().get("covers"):
            return False
        key = (os.path.abspath(root), asset_id)
        now = time.time()
        with self.cond:
            failed_at = self.failed.get(key)
            if failed_at and now - failed_at < COVER_FAIL_TTL:
                return False
            if key in self.pending or len(self.jobs) >= COVER_QUEUE_MAX:
                return False
            self.pending.add(key)
            self.jobs.append({"root": root, "src": src, "id": asset_id})
            self.cond.notify()
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._run, name="cover-worker", daemon=True)
                self.worker.start()
        return True

    def failed_recent(self, root, asset_id):
        with self.cond:
            failed_at = self.failed.get((os.path.abspath(root), asset_id))
            return failed_at is not None and time.time() - failed_at < COVER_FAIL_TTL

    def stats(self):
        with self.cond:
            return {"queued": len(self.jobs), "done": self.done, "failed": len(self.failed)}

    def _next(self):
        with self.cond:
            while not self.jobs:
                if not self.cond.wait(timeout=30):
                    return None
            return self.jobs.popleft()

    def _run(self):
        while True:
            job = self._next()
            if job is None:
                with self.cond:
                    if not self.jobs:
                        self.worker = None
                        return
                continue
            key = (os.path.abspath(job["root"]), job["id"])
            made = None
            try:
                made = extract_video_cover(job["root"], job["src"], job["id"])
            except Exception:
                made = None
            with self.cond:
                self.pending.discard(key)
                if made:
                    self.done += 1
                    self.failed.pop(key, None)
                else:
                    if len(self.failed) > COVER_QUEUE_MAX:
                        self.failed.clear()
                    self.failed[key] = time.time()


COVERS = CoverQueue()


class DurationQueue:
    """ffprobe on its own worker, so the badge never waits for a JPEG.

    Extraction can take seconds per clip (and fail outright on a share with no
    ffmpeg), while a probe is cheap. Sharing the cover worker would put every
    length behind that queue for no reason."""

    def __init__(self):
        self.cond = threading.Condition()
        self.jobs = deque()
        self.pending = set()
        self.failed = {}
        self.worker = None
        self.done = 0

    def enqueue(self, root, src, asset_id):
        if not root or not src or not is_safe_name(asset_id or ""):
            return False
        snap = accel_state()
        if not (snap.get("ffprobe") or snap.get("ffmpeg")):
            return False
        if duration_lookup(root, [asset_id]).get(asset_id):
            return False
        key = (os.path.abspath(root), asset_id)
        now = time.time()
        with self.cond:
            failed_at = self.failed.get(key)
            if failed_at and now - failed_at < COVER_FAIL_TTL:
                return False
            if key in self.pending or len(self.jobs) >= COVER_QUEUE_MAX:
                return False
            self.pending.add(key)
            self.jobs.append({"root": root, "src": src, "id": asset_id})
            self.cond.notify()
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._run, name="probe-worker", daemon=True)
                self.worker.start()
        return True

    def stats(self):
        with self.cond:
            return {"queued": len(self.jobs), "done": self.done, "failed": len(self.failed)}

    def _next(self):
        with self.cond:
            while not self.jobs:
                if not self.cond.wait(timeout=30):
                    return None
            return self.jobs.popleft()

    def _run(self):
        while True:
            job = self._next()
            if job is None:
                with self.cond:
                    if not self.jobs:
                        self.worker = None
                        return
                continue
            key = (os.path.abspath(job["root"]), job["id"])
            ok = False
            try:
                snap = accel_state()
                seconds = probe_duration(
                    job["src"],
                    probe=snap.get("ffprobe") or None,
                    ffmpeg=snap.get("ffmpeg") or None,
                )
                if seconds:
                    ok = write_duration_only(job["root"], job["id"], seconds, src=job["src"])
            except Exception:
                ok = False
            with self.cond:
                self.pending.discard(key)
                if ok:
                    self.done += 1
                    self.failed.pop(key, None)
                else:
                    if len(self.failed) > COVER_QUEUE_MAX:
                        self.failed.clear()
                    self.failed[key] = time.time()


DURATIONS = DurationQueue()


def attach_duration(item, durations):
    """Seconds for a clip whose cover has already been cut, else nothing.

    The badge is drawn from the cover sidecar, so a library with no ffmpeg simply
    has no badges instead of blocking the wall on a probe per tile."""
    if not durations or media_kind(item) != "video":
        return item
    seconds = durations.get(item.get("id") or "")
    if seconds:
        item["duration"] = seconds
    return item


def attach_item_meta(item, meta):
    rec = (meta.get("items") or {}).get(item.get("id") or "") or {}
    item["fav"] = bool(rec.get("fav"))
    item["dislike"] = bool(rec.get("dislike"))
    item["tags"] = list(rec.get("tags") or [])
    return item


def attach_group_meta(entry, section, meta):
    rec = (meta.get("groups") or {}).get(group_key(section, entry.get("folder") or "")) or {}
    children = [(meta.get("items") or {}).get(i) or {} for i in entry.get("memberIds") or []]
    entry["ownFav"] = bool(rec.get("fav"))
    entry["inheritedFav"] = any(bool(child.get("fav")) for child in children)
    entry["fav"] = entry["ownFav"] or entry["inheritedFav"]
    entry["dislike"] = bool(rec.get("dislike"))
    entry["ownTags"] = list(rec.get("tags") or [])
    entry["inheritedTags"] = sorted({tag for child in children for tag in child.get("tags") or []})
    entry["tags"] = list(dict.fromkeys(entry["ownTags"] + entry["inheritedTags"]))
    return entry


def live_card_stats(root, mode, section, folder, meta=None, trash=None, durations=None, member_files=None):
    try:
        directory = section_folder_dir(root, mode, section, folder or "")
    except ValueError:
        return None
    names, markers, avail = folder_listing_view(directory)
    if avail == "missing":
        return None
    reachable = avail == "available"
    try:
        card = load_card_view(directory)
    except (OSError, json.JSONDecodeError):
        card = None
    if card is None:
        card = synthesize_card(directory, folder or os.path.basename(directory))
    folder_name = card.get("folder") or folder or os.path.basename(directory)
    if trash is None:
        trash = trash_index(root)
    items = []
    for item in items_from_card(card, folder_name):
        if item_is_trashed(
            root,
            item,
            directory,
            ids=trash["ids"],
            markers=markers if reachable else None,
            ignore_marker_ids=trash["ignoreMarkerIds"],
        ):
            continue
        # A card can outlive its media (moved, purged by hand, download half done).
        # Those items are not viewable, so they must not inflate the card count.
        # An unreadable folder proves nothing, so trust the card until it answers.
        if reachable and item.get("file") not in names:
            continue
        items.append(item)
    if reachable:
        items.extend(unlisted_disk_items(items, names, folder_name))
    if member_files is not None:
        allowed = set(member_files)
        items = [item for item in items if item.get("file") in allowed]
    images = sum(1 for it in items if media_kind(it) == "image")
    videos = sum(1 for it in items if media_kind(it) == "video")
    summary = summarize_card(card, folder_name=folder_name)
    summary["section"] = section
    summary["count"] = len(items)
    summary["images"] = images
    summary["videos"] = videos
    summary["live"] = True
    summary["state"] = avail
    summary["unavailable"] = not reachable
    attach_member_summary(summary, items, known_live=True)
    grec = {}
    if meta is not None:
        attach_group_meta(summary, section, meta)
        grec = (meta.get("groups") or {}).get(group_key(section, folder_name)) or {}
    summary["lastViewedId"] = grec.get("lastViewedId") or ""
    cover = pick_cover_item(items, summary["lastViewedId"], directory=directory if reachable else None)
    summary["coverId"] = ""
    summary["coverMedia"] = ""
    summary["coverFile"] = ""
    summary["coverUrl"] = ""
    summary["coverReady"] = False
    summary["duration"] = 0
    if cover:
        kind = media_kind(cover)
        summary["coverId"] = cover.get("id") or ""
        summary["coverMedia"] = kind
        summary["coverFile"] = cover.get("file") or ""
        summary["coverUrl"] = media_url(
            section,
            folder_name if section != "_root" else "",
            cover.get("file") or "",
        )
        summary["coverReady"] = kind != "video" or bool(
            cover_cache_hit(root, summary["coverId"], src=os.path.join(directory, summary["coverFile"]))
        )
        if kind == "video":
            # A batch of cards shares one index: resolving it per card would be a
            # stat of the cache dir per tile on a network share.
            if durations is None:
                durations = duration_lookup(root, [summary["coverId"]])
            summary["duration"] = durations.get(summary["coverId"]) or 0
    return {
        "directory": directory,
        "card": card,
        "folder": folder_name,
        "items": items,
        "summary": summary,
    }


def annotate_library(lib):
    """Shell only: index counts minus tombstones. Exact numbers come from /api/cards."""
    if not lib.get("ok"):
        return lib
    root = lib.get("root") or ""
    mode = lib.get("mode")
    meta, meta_error = load_meta_safe(root)
    trash = trash_index(root)
    lib = dict(lib)
    lib["tags"] = list(meta.get("tags") or list(PRESET_TAGS))
    lib["hasTrash"] = bool(trash["ids"])
    lib["live"] = False
    lib["metaError"] = meta_error

    budget = [SHELL_VERIFY_MAX]

    def live_count(section, folder):
        """The index can be stale in either direction, so ask the disk. Only worth
        it for cards the index already flags as short on files, and only until the
        budget runs out."""
        if budget[0] <= 0:
            return None
        budget[0] -= 1
        live = live_card_stats(root, mode, section, folder, meta=meta, trash=trash)
        return 0 if live is None else live["summary"].get("count") or 0

    def enrich(entries, section):
        out = []
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            row = dict(entry)
            folder = row.get("folder") or ""
            try:
                directory = section_folder_dir(root, mode, section, folder)
                card = load_card_view(directory)
                if card:
                    attach_member_summary(row, items_from_card(card, folder), trash["ids"])
            except (ValueError, OSError, TypeError):
                pass  # An unreadable share does not prove the group is empty.
            attach_group_meta(row, section, meta)
            gkey = group_key(section, folder)
            grec = (meta.get("groups") or {}).get(gkey) or {}
            last = grec.get("lastViewedId") or ""
            row["section"] = section
            row["lastViewedId"] = last
            row["coverId"] = last
            row["coverMedia"] = ""
            row["coverReady"] = False
            row["live"] = False
            gone = trash["groups"].get(gkey)
            if gone:
                for field in ("count", "images", "videos"):
                    value = row.get(field)
                    if isinstance(value, int):
                        row[field] = max(0, value - gone.get(field, 0))
            count = row.get("count")
            missing = row.get("missing") if isinstance(row.get("missing"), int) else 0
            if isinstance(count, int) and missing > 0 and count - missing <= 0:
                # The index says every file here is missing: check before we ship a
                # tile that can only render a placeholder.
                checked = live_count(section, folder)
                if checked is not None:
                    count = checked
                    row["count"] = count
                    row["live"] = True
            if count == 0:
                continue
            out.append(row)
        return out

    if mode == "single":
        lib["combos"] = enrich(lib.get("combos"), "_root")
    elif mode == "loose":
        lib["combos"] = enrich(lib.get("combos"), "loose")
    else:
        lib["combos"] = enrich(lib.get("combos"), "combos")
        lib["other"] = enrich(lib.get("other"), "_other")
    return lib


def apply_fav_dislike(rec, patch):
    if "fav" in patch:
        rec["fav"] = bool(patch["fav"])
        if rec["fav"]:
            rec["dislike"] = False
    if "dislike" in patch:
        rec["dislike"] = bool(patch["dislike"])
        if rec["dislike"]:
            rec["fav"] = False
    return rec


def apply_item_patch(meta, asset_id, patch, section=None, folder=None):
    if not asset_id or not is_safe_name(asset_id):
        raise ValueError("bad id")
    items = meta.setdefault("items", {})
    rec = normalize_flags(items.get(asset_id))
    apply_fav_dislike(rec, patch)
    if "tags" in patch:
        rec["tags"] = [str(t).strip() for t in (patch.get("tags") or []) if str(t).strip()]
    items[asset_id] = rec
    return rec


def apply_group_patch(meta, section, folder, patch):
    gkey = patch.get("key") or group_key(section, folder or "")
    if gkey != "_root":
        parts = str(gkey).split("/", 1)
        if len(parts) != 2 or parts[0] not in SECTIONS or not is_safe_name(parts[1]):
            raise ValueError("bad group")
    groups = meta.setdefault("groups", {})
    rec = normalize_group(groups.get(gkey))
    apply_fav_dislike(rec, patch)
    if "tags" in patch:
        rec["tags"] = [str(t).strip() for t in (patch.get("tags") or []) if str(t).strip()]
    if "lastViewedId" in patch:
        last = str(patch.get("lastViewedId") or "").strip()
        if last and not is_safe_name(last):
            raise ValueError("bad id")
        rec["lastViewedId"] = last
    groups[gkey] = rec
    return rec, gkey


def merge_meta_payload(root, payload, expected_revision):
    with store_lock(meta_path(root)):
        return _merge_meta_payload_locked(root, payload, expected_revision)


def _merge_meta_payload_locked(root, payload, expected_revision):
    current = load_meta(root)
    if current.get("revision") != expected_revision:
        return current, False
    if not isinstance(payload, dict):
        return current, True
    meta = normalize_meta(current)
    if "tags" in payload and isinstance(payload.get("tags"), list):
        meta["tags"] = normalize_tag_list(payload.get("tags"))
    add_tag = payload.get("addTag") or payload.get("add_tag")
    if isinstance(add_tag, str) and add_tag.strip():
        tags = list(meta.get("tags") or [])
        name = add_tag.strip()
        if name not in tags:
            tags.append(name)
        meta["tags"] = normalize_tag_list(tags)
    # Gallery ↔ grok account bind. Only touched when the key is present, so
    # ordinary flag writes can never clear an existing bind by accident.
    if "grokUserId" in payload:
        meta["grokUserId"] = normalize_grok_user_id(payload.get("grokUserId"))
    if isinstance(payload.get("items"), dict) and payload.get("replace"):
        meta["items"] = {str(k): normalize_flags(v) for k, v in payload["items"].items() if k}
    if isinstance(payload.get("groups"), dict) and payload.get("replace"):
        meta["groups"] = {str(k): normalize_group(v) for k, v in payload["groups"].items() if k}
    item_patch = payload.get("item")
    if isinstance(item_patch, dict):
        apply_item_patch(
            meta,
            item_patch.get("id") or payload.get("id") or "",
            item_patch,
            section=item_patch.get("section") or payload.get("section"),
            folder=item_patch.get("folder") or payload.get("folder"),
        )
    group_patch = payload.get("group")
    if isinstance(group_patch, dict):
        apply_group_patch(
            meta,
            group_patch.get("section") or payload.get("section") or "",
            group_patch.get("folder") or payload.get("folder") or "",
            group_patch,
        )
    # Batch selection edits: skip bad rows instead of losing the whole request.
    for patch in payload.get("itemPatches") if isinstance(payload.get("itemPatches"), list) else []:
        if not isinstance(patch, dict):
            continue
        try:
            apply_item_patch(
                meta,
                patch.get("id") or "",
                patch,
                section=patch.get("section"),
                folder=patch.get("folder"),
            )
        except ValueError:
            continue
    for patch in payload.get("groupPatches") if isinstance(payload.get("groupPatches"), list) else []:
        if not isinstance(patch, dict):
            continue
        try:
            apply_group_patch(meta, patch.get("section") or "", patch.get("folder") or "", patch)
        except ValueError:
            continue
    candidate = normalize_meta(meta)
    candidate["revision"] = current["revision"]
    if candidate == current:
        return current, True
    if current["revision"] >= META_REVISION_MAX:
        raise StoreCorrupt(meta_path(root), "meta revision exhausted")
    candidate["revision"] = current["revision"] + 1
    save_meta(root, candidate)
    return load_meta(root), True


def load_tombstone_strict(root, asset_id):
    if not is_safe_name(asset_id):
        return None
    path = os.path.join(root, TRASH_DIR, "by-id", asset_id + ".json")
    root_real = os.path.realpath(root)
    try:
        real = os.path.realpath(path)
    except OSError as exc:
        raise StoreUnavailable(path, str(exc))
    if real != root_real and not real.startswith(root_real + os.sep):
        return None
    return read_json_store(real)


def write_tombstone(root, payload):
    asset_id = payload.get("id") or ""
    if not is_safe_name(asset_id):
        raise ValueError("bad id")
    dest = os.path.join(root, TRASH_DIR, "by-id", asset_id + ".json")
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    root_real = os.path.realpath(root)
    real_parent = os.path.realpath(parent)
    if real_parent != root_real and not real_parent.startswith(root_real + os.sep):
        raise ValueError("escaped")
    write_json_atomic(dest, payload)
    return dest


def rel_under_root(root, path):
    root_real = os.path.realpath(root)
    real = os.path.realpath(path)
    if real == root_real:
        return ""
    prefix = root_real + os.sep
    if not real.startswith(prefix):
        raise ValueError("escaped")
    return real[len(prefix) :].replace(os.sep, "/")


def same_media_file(a, b):
    """Size + mtime match, which is what `shutil.move` preserves.

    Used to tell "this file is already back where it belongs" from "something
    else now owns that name". Hashing the bytes would mean reading a 14G library
    off a network share to answer a question a stat already answers."""
    try:
        sa = os.stat(a)
        sb = os.stat(b)
    except OSError:
        return False
    return sa.st_size == sb.st_size and sa.st_mtime_ns == sb.st_mtime_ns


def reveal_in_os(target):
    """Open a file or its parent folder in the system file manager."""
    if not target:
        return False
    try:
        if os.name == "nt":
            if os.path.isfile(target):
                subprocess.Popen(["explorer", "/select,", os.path.normpath(target)])
            else:
                os.startfile(target)  # type: ignore[attr-defined]
            return True
        if sys.platform == "darwin":
            if os.path.isfile(target):
                subprocess.Popen(["open", "-R", target])
            else:
                subprocess.Popen(["open", target])
            return True
        folder = target if os.path.isdir(target) else os.path.dirname(target)
        subprocess.Popen(
            ["xdg-open", folder],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except OSError:
        return False


def summarize_card(card, folder_name=None):
    items = card.get("items") if isinstance(card.get("items"), list) else []
    images = 0
    videos = 0
    for item in items:
        kind = media_kind(item)
        if kind == "video":
            videos += 1
        elif kind == "image":
            images += 1
    count = card.get("count")
    if not isinstance(count, int):
        count = len(items)
    folder = card.get("folder") or folder_name or ""
    return {
        "n": card.get("n"),
        "id": card.get("id"),
        "folder": folder,
        "created": card.get("created") or "",
        "title": card.get("title") or "",
        "count": count,
        "videos": videos,
        "images": images,
        "missing": card.get("missing") or 0,
        "source": card.get("source") or "",
    }


def scan_card_dirs(parent):
    entries = []
    try:
        names = os.listdir(parent)
    except OSError:
        return entries
    for name in sorted(names):
        if name in SKIP_NAMES:
            continue
        folder = os.path.join(parent, name)
        card_path = os.path.join(folder, "card.json")
        if not os.path.isdir(folder) or not os.path.isfile(card_path):
            continue
        try:
            card = read_json(card_path)
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(card, dict):
            continue
        entries.append(summarize_card(card, folder_name=name))
    return entries


def lift_library_root(root):
    """If the user opened combos/ or _other/ of a real library, use the parent."""
    if not root:
        return root
    root = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root):
        return root
    base = os.path.basename(root.rstrip("\\/"))
    parent = os.path.dirname(root)
    key = base.lower()
    if key in ("combos", "_other"):
        parent_index = os.path.join(parent, "_index.json")
        sibling = os.path.join(parent, "_other" if key == "combos" else "combos")
        if os.path.isfile(parent_index) or os.path.isdir(sibling):
            return parent
    return root


def _loose_folder_has_media_or_marker(directory):
    """Card-less loose evidence, including the marker left after a trash move."""
    try:
        names = os.listdir(directory)
    except OSError:
        return False
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    for name in names:
        media_name = name[:-8] if name.endswith(".trashed") else name
        ext = os.path.splitext(media_name)[1].lower()
        if ext not in IMAGE_EXT and ext not in VIDEO_EXT:
            continue
        try:
            st = os.lstat(os.path.join(directory, name))
        except OSError:
            continue
        if not (getattr(st, "st_file_attributes", 0) & reparse) and stat.S_ISREG(st.st_mode):
            return True
    return False


def _loose_tombstone_folders(root):
    """Recover loose mode after every card/media was moved or purged."""
    out = set()
    by_id = os.path.join(root, TRASH_DIR, "by-id")
    try:
        names = os.listdir(by_id)
    except OSError:
        return out
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    for name in names:
        if not name.endswith(".json") or not is_safe_name(name[:-5]):
            continue
        path = os.path.join(by_id, name)
        try:
            st = os.lstat(path)
            if getattr(st, "st_file_attributes", 0) & reparse or not stat.S_ISREG(st.st_mode):
                continue
            data = read_json(path)
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        section = data.get("section")
        folder = data.get("folder")
        filename = data.get("file")
        if (
            section not in ("loose", "combos")
            or not isinstance(folder, str)
            or not isinstance(filename, str)
            or not is_safe_name(folder)
            or not is_safe_name(filename)
        ):
            continue
        if data.get("from") != posixpath.join(folder, filename):
            continue
        if data.get("to") != trash_media_rel(section, folder, filename):
            continue
        if os.path.isdir(os.path.join(root, folder)):
            out.add(folder)
    return out


def _media_filename(name):
    if not is_safe_name(name):
        return False
    ext = os.path.splitext(name)[1].lower()
    return ext in IMAGE_EXT or ext in VIDEO_EXT


def disk_media_items(directory, skip_ids=None):
    skip = {str(item).strip().lower() for item in (skip_ids or ()) if item}
    items = []
    try:
        names = os.listdir(directory)
    except OSError:
        return items
    for name in sorted(names):
        if not _media_filename(name):
            continue
        stem = os.path.splitext(name)[0].strip().lower()
        if stem in skip:
            continue
        items.append(
            {
                "id": os.path.splitext(name)[0],
                "mime": guess_mime(name),
                "kind": None,
                "created": "",
                "file": name,
                "status": "linked",
                "prompt": "",
            }
        )
    return items


def unlisted_disk_items(items, names, folder_name):
    listed = {item.get("file") for item in items if item.get("file")}
    extra = []
    for name in sorted(names):
        if name in listed or not _media_filename(name):
            continue
        extra.append(
            {
                "id": os.path.splitext(name)[0],
                "mime": guess_mime(name),
                "kind": None,
                "created": "",
                "file": name,
                "status": "linked",
                "prompt": "",
                "folder": folder_name,
                "title": "",
                "media": media_kind({"file": name, "mime": guess_mime(name)}),
            }
        )
    return extra


def known_library_asset_ids(root, listed_combos=None, listed_other=None):
    ids = set()
    assets_path = os.path.join(root, "_state", "assets.json")
    if os.path.isfile(assets_path):
        try:
            data = read_json(assets_path)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            data = None
        if isinstance(data, dict):
            for asset in data.get("assets") or []:
                if not isinstance(asset, dict):
                    continue
                asset_id = str(asset.get("id") or "").strip().lower()
                if asset_id:
                    ids.add(asset_id)
    sections = (("combos", listed_combos), ("_other", listed_other))
    if ids:
        return ids
    for section, rows in sections:
        for row in rows or []:
            folder = row.get("folder") if isinstance(row, dict) else ""
            if not folder or not is_safe_name(folder):
                continue
            card_path = os.path.join(root, section, folder, "card.json")
            if not os.path.isfile(card_path):
                continue
            try:
                card = read_json(card_path)
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
            if not isinstance(card, dict):
                continue
            for item in card.get("items") or []:
                if not isinstance(item, dict):
                    continue
                asset_id = str(item.get("id") or "").strip().lower()
                if not asset_id and item.get("file"):
                    asset_id = os.path.splitext(os.path.basename(item["file"]))[0].strip().lower()
                if asset_id:
                    ids.add(asset_id)
    return ids


def merge_disk_leftovers(lib):
    """Index rows only name the current Grok set. Keep leftover on-disk groups visible."""
    if not lib.get("ok") or lib.get("mode") not in ("index", "combos"):
        return lib
    root = lib.get("root") or ""
    if not root or not os.path.isdir(root):
        return lib
    combos = list(lib.get("combos") or [])
    other = list(lib.get("other") or [])
    listed = {
        "combos": {row.get("folder") for row in combos if isinstance(row, dict) and row.get("folder")},
        "_other": {row.get("folder") for row in other if isinstance(row, dict) and row.get("folder")},
    }
    changed = False
    for section, key, rows in (("combos", "combos", combos), ("_other", "other", other)):
        base = os.path.join(root, section)
        if not os.path.isdir(base):
            continue
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for folder in sorted(names):
            if folder in SKIP_NAMES or folder in listed[section] or not is_safe_name(folder):
                continue
            if folder.startswith("."):
                continue
            path = os.path.join(base, folder)
            if not os.path.isdir(path):
                continue
            # IDs identify assets, not content. Independent same-ID files must
            # remain visible until an explicit full-content dedup preview.
            orphans = disk_media_items(path)
            if not orphans:
                continue
            row = summarize_card(
                {
                    "id": folder,
                    "folder": folder,
                    "count": len(orphans),
                    "items": orphans,
                    "source": "disk_leftover",
                    "missing": 0,
                },
                folder_name=folder,
            )
            row["section"] = section
            row["memberFiles"] = [item["file"] for item in orphans]
            row["missing"] = 0
            rows.append(row)
            listed[section].add(folder)
            changed = True
        if key == "combos":
            combos = rows
        else:
            other = rows
    if not changed:
        return lib
    lib = dict(lib)
    lib["combos"] = combos
    lib["other"] = other
    lib["hasOther"] = bool(other)
    summary = dict(lib.get("summary") or {})
    summary["web_combos"] = len(combos)
    summary["other_groups"] = len(other)
    lib["summary"] = summary
    return lib


_DUP_FOLDER_RE = re.compile(r"^(\d{1,7})_([0-9A-Fa-f]{8})$")
_DEDUP_ACTIONS = frozenset(("keep_newest", "merge", "skip"))
_DEDUP_PREVIEW_LIMIT = 200
_DEDUP_MAX_LEFTOVERS = 40
_DEDUP_MAX_TRASH_GROUP = 2000


def parse_dup_folder(name):
    match = _DUP_FOLDER_RE.fullmatch(name or "")
    if not match:
        return None
    return int(match.group(1)), match.group(2).lower()


def _regular_media_stat(path):
    info = os.lstat(path)
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & flag:
        raise ValueError("unsafe_non_regular_entry")
    return info


def dedup_media_fingerprint(path):
    info = _regular_media_stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if _media_stat_identity(opened) != _media_stat_identity(info):
            raise ValueError("media_changed_during_read")
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
        if _media_stat_identity(os.fstat(handle.fileno())) != _media_stat_identity(info):
            raise ValueError("media_changed_during_read")
    if _media_stat_identity(_regular_media_stat(path)) != _media_stat_identity(info):
        raise ValueError("media_changed_during_read")
    return {
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "ino": int(getattr(info, "st_ino", 0) or 0),
        "dev": int(getattr(info, "st_dev", 0) or 0),
        "hash": digest.hexdigest(),
    }


def _media_stat_identity(info):
    # Windows lstat/fstat can report different creation-time aliases in
    # st_ctime_ns; size, write time and file identity are comparable there.
    return (info.st_size, info.st_mtime_ns, info.st_ino, info.st_dev)


def _dedup_entry(root, *parts):
    """Dedup owns lexical regular entries, never symlink/reparse ancestors."""
    path = os.path.realpath(root)
    for index, part in enumerate(parts):
        if not isinstance(part, str) or not is_safe_name(part):
            raise ValueError("unsafe_dedup_path")
        path = os.path.join(path, part)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & flag:
            raise ValueError("unsafe_dedup_path")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError("unsafe_dedup_path")
    return path


def _copy_token(asset_id):
    # Wire-only namespace cannot collide with a legal media filename/asset ID.
    match = re.fullmatch(r"copy:([0-9a-f]{32})", asset_id) if isinstance(asset_id, str) else None
    return match.group(1) if match else None


def _dedup_signature(planned):
    rows = [planned.get("_indexed") or []]
    for group in planned.get("_groups") or []:
        rows.append((group["key"], group["keep"], [
            (row["section"], row["folder"], sorted((stem, item["file"], item["fp"]) for stem, item in row["files"].items()))
            for row in group["_rows"]
        ]))
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode("utf-8")).hexdigest()


def library_member_files(lib, section, folder):
    for row in lib.get("other" if section == "_other" else "combos") or []:
        if row.get("folder") == folder and row.get("source") == "disk_leftover":
            return row.get("memberFiles")
    return None


def same_media_fingerprint(left, right):
    if not left or not right:
        return False
    return left.get("size") == right.get("size") and left.get("hash") == right.get("hash")


def _indexed_library_folders(root):
    indexed = set()
    path = _dedup_entry(root, "_index.json")
    try:
        _regular_media_stat(path)
    except FileNotFoundError:
        return indexed
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ValueError("dedup_index_unreadable") from exc
    if not isinstance(data, dict):
        raise ValueError("dedup_index_invalid")
    for section, key in (("combos", "combos"), ("_other", "other")):
        if key in data and not isinstance(data[key], list):
            raise ValueError("dedup_index_invalid")
        for row in data.get(key) or []:
            if not isinstance(row, dict) or not is_safe_name(row.get("folder") or ""):
                raise ValueError("dedup_index_invalid")
            indexed.add((section, row["folder"]))
    return indexed


def _scan_dedup_folders(root):
    rows = []
    suffix_counts = {}
    for section in ("combos", "_other"):
        try:
            base = _dedup_entry(root, section)
            for name in os.listdir(base):
                parsed = parse_dup_folder(name)
                if parsed:
                    suffix_counts[parsed[1]] = suffix_counts.get(parsed[1], 0) + 1
        except (OSError, ValueError):
            continue
    for section in ("combos", "_other"):
        try:
            base = _dedup_entry(root, section)
        except (OSError, ValueError):
            continue
        if not os.path.isdir(base):
            continue
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for folder in sorted(names):
            if folder in SKIP_NAMES or folder.startswith(".") or not is_safe_name(folder):
                continue
            try:
                directory = _dedup_entry(root, section, folder)
            except (OSError, ValueError):
                continue
            if not os.path.isdir(directory):
                continue
            parsed = parse_dup_folder(folder)
            if not parsed or suffix_counts.get(parsed[1], 0) < 2:
                continue
            files = {}
            unreadable = False
            try:
                entries = os.listdir(directory)
            except OSError:
                continue
            for name in sorted(entries):
                if not _media_filename(name):
                    continue
                path = os.path.join(directory, name)
                try:
                    stem = os.path.splitext(name)[0].lower()
                    if name + ".trashed" in entries or item_is_trashed(root, {"id": stem, "file": name}, directory):
                        unreadable = True
                        break
                    if stem in files:
                        # A stem can have both jpg and mp4 variants. Never
                        # silently choose one and clean the other by ID.
                        files = {}
                        break
                    files[stem] = {
                        "file": name,
                        "path": path,
                        "fp": dedup_media_fingerprint(path),
                    }
                except (OSError, ValueError):
                    unreadable = True
                    break
            if unreadable or not files:
                continue
            try:
                mtime = os.lstat(directory).st_mtime_ns
            except OSError:
                mtime = 0
            rows.append({
                "section": section,
                "folder": folder,
                "n": parsed[0] if parsed else 0,
                "suffix": parsed[1] if parsed else "",
                "mtime": mtime,
                "files": files,
            })
    return rows


def _dedup_keep_rank(row, indexed):
    return (
        1 if (row["section"], row["folder"]) in indexed else 0,
        row["n"],
        1 if row["section"] == "combos" else 0,
        row["mtime"],
    )


def _union_dedup_groups(rows):
    """Same conversation prefix only. Never chain folders that merely share a file name."""
    by_suffix = {}
    for row in rows:
        if not row["suffix"]:
            continue
        by_suffix.setdefault(row["suffix"], []).append(row)
    return [members for members in by_suffix.values() if len(members) >= 2]


def _dedup_shared_stems(keep, other):
    return set(keep["files"]) & set(other["files"])


def _dedup_pick_keep(members, indexed):
    indexed_members = [row for row in members if (row["section"], row["folder"]) in indexed]
    leftovers = [row for row in members if (row["section"], row["folder"]) not in indexed]
    if len(indexed_members) > 1:
        return None, leftovers, "indexed_suffix_collision"
    if indexed_members:
        return indexed_members[0], leftovers, ""
    leftovers = sorted(leftovers, key=lambda row: _dedup_keep_rank(row, indexed), reverse=True)
    if len(leftovers) < 2:
        return None, leftovers, ""
    return leftovers[0], leftovers[1:], ""


def plan_library_dedup(root, mode=None):
    del mode
    if not root or not os.path.isdir(root):
        return {"ok": False, "error": "图库目录不可用。"}
    try:
        indexed = _indexed_library_folders(root)
    except (OSError, ValueError):
        return {"ok": False, "status": 409, "error": "无法安全读取图库索引，未生成去重计划。"}
    groups = []
    for members in _union_dedup_groups(_scan_dedup_folders(root)):
        keep, leftovers, reason = _dedup_pick_keep(members, indexed)
        if keep is None or not leftovers:
            continue
        related = [row for row in leftovers if _dedup_shared_stems(keep, row)]
        if not related:
            continue
        conflicts = []
        unique_others = []
        identical = True
        for other in related:
            for stem, entry in other["files"].items():
                held = keep["files"].get(stem)
                if held is None:
                    identical = False
                    unique_others.append({"id": stem, "folder": other["folder"]})
                    continue
                if same_media_fingerprint(held["fp"], entry["fp"]):
                    continue
                identical = False
                conflicts.append({
                    "id": stem,
                    "keepFolder": keep["folder"],
                    "keepSize": held["fp"]["size"],
                    "otherFolder": other["folder"],
                    "otherSize": entry["fp"]["size"],
                })
        would_trash = sum(len(row["files"]) for row in related)
        oversized = len(related) > _DEDUP_MAX_LEFTOVERS or would_trash > _DEDUP_MAX_TRASH_GROUP
        suffix = keep["suffix"] or related[0]["suffix"] or keep["folder"]
        groups.append({
            "key": "%s/%s" % (keep["section"], suffix),
            "identical": identical,
            "keep": {"section": keep["section"], "folder": keep["folder"], "n": keep["n"]},
            "others": [{"section": row["section"], "folder": row["folder"], "n": row["n"]} for row in related],
            "files": len(keep["files"]) + would_trash,
            "wouldTrash": would_trash,
            "oversized": oversized,
            "reason": reason,
            "conflicts": conflicts[:80],
            "uniqueOthers": unique_others[:80],
            "_rows": [keep] + related,
        })
    preview = groups[:_DEDUP_PREVIEW_LIMIT]
    return {
        "ok": True,
        "groups": [{key: value for key, value in group.items() if key != "_rows"} for group in preview],
        "identical": sum(1 for group in preview if group["identical"] and not group["oversized"]),
        "mixed": sum(1 for group in preview if not group["identical"] and not group["oversized"]),
        "leftoverFolders": sum(len(group["others"]) for group in groups if not group["oversized"]),
        "wouldTrash": sum(group["wouldTrash"] for group in groups if not group["oversized"]),
        "oversized": sum(1 for group in groups if group["oversized"]),
        "truncated": len(groups) > _DEDUP_PREVIEW_LIMIT,
        "_groups": groups,
        "_indexed": sorted(indexed),
    }


def _unique_merge_name(directory, stem, number, ext):
    base = "%s~n%s%s" % (stem, number, ext)
    if is_safe_name(base) and not os.path.lexists(os.path.join(directory, base)):
        return base
    for index in range(1, 100):
        name = "%s~n%s-%s%s" % (stem, number, index, ext)
        if is_safe_name(name) and not os.path.lexists(os.path.join(directory, name)):
            return name
    raise ValueError("无法为不同内容的同名文件分配安全文件名。")


def _dedup_copy_verified(src, dest, expected):
    """Publish only a fully verified copy, never replace a live entry."""
    if dedup_media_fingerprint(src) != expected:
        raise ValueError("dedup_source_changed")
    stage = os.path.join(os.path.dirname(dest), ".dedup-stage-" + os.urandom(16).hex())
    with open(src, "rb") as incoming, open(stage, "xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    if dedup_media_fingerprint(src) != expected or not same_media_fingerprint(dedup_media_fingerprint(stage), expected):
        raise ValueError("dedup_copy_changed; staged bytes retained")
    AppState._move_regular_no_replace_verified(stage, dest)
    committed = dedup_media_fingerprint(dest)
    if not same_media_fingerprint(committed, expected):
        raise ValueError("dedup_copy_publish_changed; source and destination retained")
    return committed


def detect_library(root):
    """Identify a selected directory. Never raises for unknown trees."""
    if not root:
        return {
            "ok": False,
            "mode": "empty",
            "root": "",
            "error": "尚未选择图库根目录。",
            "combos": [],
            "other": [],
            "hasOther": False,
            "summary": {},
        }
    root = lift_library_root(root)
    if not os.path.isdir(root):
        return {
            "ok": False,
            "mode": "missing",
            "root": root,
            "error": "目录不存在：%s" % root,
            "combos": [],
            "other": [],
            "hasOther": False,
            "summary": {},
        }

    index_path = os.path.join(root, "_index.json")
    combos_dir = os.path.join(root, "combos")
    other_dir = os.path.join(root, "_other")
    root_card = os.path.join(root, "card.json")

    try:
        if os.path.isfile(index_path):
            try:
                index = read_json(index_path)
            except (OSError, json.JSONDecodeError) as exc:
                return {
                    "ok": False,
                    "mode": "bad_index",
                    "root": root,
                    "error": "无法读取 _index.json：%s" % exc,
                    "combos": [],
                    "other": [],
                    "hasOther": False,
                    "summary": {},
                }
            if not isinstance(index, dict):
                return {
                    "ok": False,
                    "mode": "bad_index",
                    "root": root,
                    "error": "_index.json 格式无效。",
                    "combos": [],
                    "other": [],
                    "hasOther": False,
                    "summary": {},
                }
            combos = index.get("combos") if isinstance(index.get("combos"), list) else []
            other = index.get("other") if isinstance(index.get("other"), list) else []
            summary = index.get("summary") if isinstance(index.get("summary"), dict) else {}
            has_other = bool(other) or os.path.isdir(other_dir)
            return merge_disk_leftovers({
                "ok": True,
                "mode": "index",
                "root": root,
                "error": None,
                "combos": combos,
                "other": other,
                "hasOther": has_other,
                "summary": summary,
            })

        if os.path.isdir(combos_dir):
            combos = scan_card_dirs(combos_dir)
            other = scan_card_dirs(other_dir) if os.path.isdir(other_dir) else []
            return merge_disk_leftovers({
                "ok": True,
                "mode": "combos",
                "root": root,
                "error": None,
                "combos": combos,
                "other": other,
                "hasOther": bool(other) or os.path.isdir(other_dir),
                "summary": {
                    "web_combos": len(combos),
                    "other_groups": len(other),
                },
            })

        if os.path.isfile(root_card):
            try:
                card = read_json(root_card)
            except (OSError, json.JSONDecodeError) as exc:
                return {
                    "ok": False,
                    "mode": "bad_card",
                    "root": root,
                    "error": "无法读取 card.json：%s" % exc,
                    "combos": [],
                    "other": [],
                    "hasOther": False,
                    "summary": {},
                }
            if not isinstance(card, dict):
                return {
                    "ok": False,
                    "mode": "bad_card",
                    "root": root,
                    "error": "card.json 格式无效。",
                    "combos": [],
                    "other": [],
                    "hasOther": False,
                    "summary": {},
                }
            entry = summarize_card(card, folder_name=os.path.basename(root))
            entry["section"] = "_root"
            return {
                "ok": True,
                "mode": "single",
                "root": root,
                "error": None,
                "combos": [entry],
                "other": [],
                "hasOther": False,
                "summary": {"web_combos": 1, "other_groups": 0},
            }

        loose = []
        loose_names = set()
        try:
            names = os.listdir(root)
        except OSError as exc:
            return {
                "ok": False,
                "mode": "error",
                "root": root,
                "error": "无法读取目录：%s" % exc,
                "combos": [],
                "other": [],
                "hasOther": False,
                "summary": {},
            }
        for name in sorted(names):
            if name in SKIP_NAMES:
                continue
            folder = os.path.join(root, name)
            if not os.path.isdir(folder):
                continue
            card_path = os.path.join(folder, "card.json")
            card = None
            if os.path.isfile(card_path):
                try:
                    card = read_json(card_path)
                except (OSError, json.JSONDecodeError, TypeError):
                    card = None
            if isinstance(card, dict):
                loose.append(summarize_card(card, folder_name=name))
                loose_names.add(name)
            elif _loose_folder_has_media_or_marker(folder):
                loose.append(summarize_card(synthesize_card(folder, name), folder_name=name))
                loose_names.add(name)
        for name in sorted(_loose_tombstone_folders(root) - loose_names):
            folder = os.path.join(root, name)
            loose.append(summarize_card(synthesize_card(folder, name), folder_name=name))
        if loose:
            return {
                "ok": True,
                "mode": "loose",
                "root": root,
                "error": None,
                "combos": loose,
                "other": [],
                "hasOther": False,
                "summary": {"web_combos": len(loose), "other_groups": 0},
            }
    except OSError as exc:
        return {
            "ok": False,
            "mode": "error",
            "root": root,
            "error": "读取图库失败：%s" % exc,
            "combos": [],
            "other": [],
            "hasOther": False,
            "summary": {},
        }

    return {
        "ok": False,
        "mode": "unrecognized",
        "root": root,
        "error": "无法识别图库：未找到 _index.json、combos/ 或 card.json。",
        "combos": [],
        "other": [],
        "hasOther": False,
        "summary": {},
    }


def empty_index():
    """The skeleton `_index.json`, matching the shape detect_library() reads."""
    return {"summary": {"web_combos": 0, "other_groups": 0}, "combos": [], "other": []}


def create_library_skeleton(path):
    """新建库文件夹: combos/ + _other/ + an empty _index.json, no media.

    The directory must be new or empty — filling a folder that already holds
    anything else risks mixing a fresh export into unrelated files. Raises
    ValueError with a user-facing message; OSError bubbles for the caller."""
    raw = str(path or "").strip()
    if not raw:
        # Checked before abspath(): abspath("") is the CWD, which must never
        # silently become the target.
        raise ValueError("请提供新图库目录路径。")
    path = os.path.abspath(os.path.expanduser(raw))
    if path == os.path.abspath(os.sep):
        raise ValueError("请提供新图库目录路径。")
    if os.path.isfile(path):
        raise ValueError("路径已是一个文件：%s" % path)
    if os.path.isdir(path):
        try:
            leftover = [n for n in os.listdir(path) if n not in SKIP_NAMES]
        except OSError as exc:
            raise ValueError("无法读取目录：%s" % exc)
        if leftover:
            raise ValueError("目录不是空的，请选择空目录或新名字。")
    # The target must exist before its permanent in-root lease can be opened.
    # The second emptiness check under that lease is authoritative: two creators
    # may both observe a missing or empty path before either one initializes it.
    os.makedirs(path, exist_ok=True)
    with gallery_write_lease(path, owner="python-create") as lease:
        locked_root = lease.root
        try:
            leftover = [n for n in os.listdir(locked_root) if n not in SKIP_NAMES]
        except OSError as exc:
            raise ValueError("无法读取目录：%s" % exc)
        if leftover:
            raise ValueError("目录不是空的，请选择空目录或新名字。")
        os.makedirs(os.path.join(locked_root, "combos"), exist_ok=True)
        os.makedirs(os.path.join(locked_root, "_other"), exist_ok=True)
        write_json_atomic(os.path.join(locked_root, "_index.json"), empty_index())
        return locked_root


def nearby_library_candidates(base_dir=None):
    here = os.path.abspath(base_dir or REPO_DIR)
    parent = os.path.dirname(here)
    names = ("library", "grok_imagine", "Imagine")
    seen = []

    def add(path):
        path = os.path.abspath(path)
        if path not in seen:
            seen.append(path)

    for base in (here, parent):
        for name in names:
            add(os.path.join(base, name))
        add(base)
    return seen


def resolve_initial_root(cli_root, base_dir=None):
    if cli_root:
        return os.path.abspath(os.path.expanduser(cli_root))
    last = load_config().get("root")
    if last:
        last = os.path.abspath(os.path.expanduser(str(last)))
        if os.path.isdir(last) and detect_library(last).get("ok"):
            return last
    for candidate in nearby_library_candidates(base_dir):
        if os.path.isdir(candidate) and detect_library(candidate).get("ok"):
            return candidate
    return ""


def is_safe_name(name):
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    if name.startswith(".."):
        return False
    return True


def jail_join(root, *parts):
    """Join under root; raise ValueError if the result escapes."""
    if not root:
        raise ValueError("no root")
    root_real = os.path.realpath(root)
    if not os.path.isdir(root_real):
        raise ValueError("root missing")
    candidate = root_real
    for part in parts:
        if part in (None, "", ".", ".."):
            raise ValueError("bad path")
        # Allow a single path segment only.
        if not is_safe_name(part):
            raise ValueError("bad path")
        candidate = os.path.join(candidate, part)
    real = os.path.realpath(candidate)
    if real != root_real and not real.startswith(root_real + os.sep):
        raise ValueError("escaped")
    return real


def section_folder_dir(root, mode, section, folder):
    """Absolute directory for a combo / other / single / loose folder."""
    if section not in SECTIONS:
        raise ValueError("bad section")
    if section == "_root":
        if mode != "single":
            raise ValueError("root section only in single mode")
        return os.path.realpath(root)
    if not is_safe_name(folder):
        raise ValueError("bad folder")
    if section == "combos":
        if mode == "loose":
            return jail_join(root, folder)
        return jail_join(root, "combos", folder)
    if section == "_other":
        return jail_join(root, "_other", folder)
    if section == "loose":
        return jail_join(root, folder)
    raise ValueError("bad section")


def allowed_sections(mode):
    if mode in ("index", "combos"):
        return ("combos", "_other")
    if mode == "single":
        return ("_root",)
    if mode == "loose":
        return ("loose", "combos")
    return ()


def default_section_for_mode(mode, requested=None):
    allowed = allowed_sections(mode)
    if requested:
        if requested not in allowed:
            raise ValueError("bad section")
        return requested
    return allowed[0] if allowed else "combos"


def items_from_card(card, folder_name):
    items = card.get("items") if isinstance(card.get("items"), list) else []
    cleaned = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        filename = raw.get("file") or ""
        if not is_safe_name(os.path.basename(filename)):
            continue
        item = dict(raw)
        item["file"] = os.path.basename(filename)
        item["mime"] = item.get("mime") or guess_mime(item["file"])
        item["media"] = media_kind(item)
        item["prompt"] = item.get("prompt") or ""
        item["kind"] = item.get("kind")
        item["created"] = item.get("created") or ""
        item["folder"] = card.get("folder") or folder_name
        item["title"] = card.get("title") or ""
        cleaned.append(item)
    cleaned.sort(key=lambda it: created_sort_key(it.get("created")))
    return cleaned


def load_card(directory):
    path = os.path.join(directory, "card.json")
    if os.path.isfile(path):
        card = read_json(path)
        if isinstance(card, dict):
            return card
    return None


def synthesize_card(directory, folder_name):
    items = []
    try:
        names = os.listdir(directory)
    except OSError:
        names = []
    for name in sorted(names):
        if not is_safe_name(name):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_EXT and ext not in VIDEO_EXT:
            continue
        mime = guess_mime(name)
        items.append(
            {
                "id": os.path.splitext(name)[0],
                "mime": mime,
                "kind": None,
                "created": "",
                "file": name,
                "status": "linked",
                "prompt": "",
            }
        )
    return {
        "id": folder_name,
        "title": "",
        "folder": folder_name,
        "count": len(items),
        "items": items,
    }


def decorate_items(items, section, folder):
    out = []
    for item in items:
        row = dict(item)
        row["section"] = section
        row["folder"] = folder
        row["url"] = media_url(section, folder, row["file"])
        out.append(row)
    return out


def media_url(section, folder, filename):
    if section == "_root":
        return "/media/_root/%s" % quote(filename)
    return "/media/%s/%s/%s" % (quote(section), quote(folder), quote(filename))


def last_image_item(items):
    last = None
    for item in items:
        if item.get("media") == "image":
            last = item
    return last


def last_video_item(items):
    last = None
    for item in items:
        if item.get("media") == "video":
            last = item
    return last


def item_by_id(items, asset_id):
    if not asset_id:
        return None
    for item in items:
        if item.get("id") == asset_id:
            return item
    return None


def item_file_exists(directory, item):
    filename = os.path.basename(item.get("file") or "")
    if not directory or not filename or not is_safe_name(filename):
        return False
    try:
        return os.path.isfile(os.path.join(directory, filename))
    except OSError:
        return False


def pick_cover_item(items, last_viewed_id=None, directory=None):
    """Prefer lastViewedId if the file is still live; else last still, else last video."""
    def usable(item):
        if not item:
            return None
        if directory is not None and not item_file_exists(directory, item):
            return None
        return item

    viewed = usable(item_by_id(items, last_viewed_id))
    if viewed:
        return viewed
    return usable(last_image_item(items)) or usable(last_video_item(items))


def cover_candidates(items, last_viewed_id=None):
    seen = set()
    out = []

    def add(item):
        if not item:
            return
        key = item.get("id") or item.get("file")
        if not key or key in seen:
            return
        seen.add(key)
        out.append(item)

    add(item_by_id(items, last_viewed_id))
    add(last_image_item(items))
    add(last_video_item(items))
    return out


def library_markers(path):
    flags = []
    if os.path.isfile(os.path.join(path, "_index.json")):
        flags.append("_index.json")
    if os.path.isdir(os.path.join(path, "combos")):
        flags.append("combos")
    if os.path.isfile(os.path.join(path, "card.json")):
        flags.append("card.json")
    if os.path.isdir(os.path.join(path, "_other")):
        flags.append("_other")
    return flags


def normalize_browse_path(path, windows=None):
    """Accept an explicit filesystem address, never a drive-relative fallback."""
    if not isinstance(path, str) or "\x00" in path:
        raise ValueError("请输入完整的目录路径。")
    path = path.strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in ('"', "'"):
        path = path[1:-1]
    if windows is None:
        windows = os.name == "nt"
    if windows:
        path = path.replace("/", "\\")
        # Shell/device namespaces and C:relative depend on hidden process state;
        # the picker accepts only drive roots and complete UNC share addresses.
        if path.startswith(("\\\\?\\", "\\\\.\\", "\\??\\")):
            raise ValueError("请输入盘符绝对路径或完整的网络共享路径。")
        drive, _ = ntpath.splitdrive(path)
        if path.startswith("\\\\"):
            parts = drive[2:].split("\\")
            if len(parts) != 2 or any(not p or p in (".", "..", "?") for p in parts):
                raise ValueError("网络路径需包含服务器和共享名，例如 \\\\server\\share。")
        elif not re.match(r"^[A-Za-z]:\\", path):
            raise ValueError("请输入完整路径，例如 D:\\图库，或 \\\\server\\share。")
        return ntpath.normpath(path)
    if not posixpath.isabs(path):
        raise ValueError("请输入以 / 开头的完整目录路径。")
    return posixpath.normpath(path)


def _windows_logical_drives():
    # Neither API opens the drive, queries its label, nor contacts an offline
    # mapped share. Directory access happens only when the user opens an entry.
    listdrives = getattr(os, "listdrives", None)
    if callable(listdrives):
        return listdrives()
    import ctypes

    get_drives = ctypes.WinDLL("kernel32", use_last_error=True).GetLogicalDrives
    get_drives.argtypes = []
    get_drives.restype = ctypes.c_uint32
    mask = get_drives()
    if not mask:
        raise OSError("无法获取磁盘列表。")
    return [chr(ord("A") + bit) + ":\\" for bit in range(26) if mask & (1 << bit)]


WINDOWS_COMMON_PLACE_SPECS = (
    ("桌面", "Desktop", "Desktop"),
    ("图片", "My Pictures", "Pictures"),
    ("视频", "My Video", "Videos"),
    ("文档", "Personal", "Documents"),
    ("下载", "{374DE290-123F-4565-9164-39C4925E467B}", "Downloads"),
)


def _read_windows_user_shell_folder(value_name):
    import winreg

    key_name = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
        value, _ = winreg.QueryValueEx(key, value_name)
    return value if isinstance(value, str) else ""


def windows_common_places(registry_reader=None):
    """Return redirected Windows user folders without opening their contents."""
    reader = registry_reader or _read_windows_user_shell_folder
    profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    places = []
    for label, value_name, fallback_name in WINDOWS_COMMON_PLACE_SPECS:
        try:
            raw = reader(value_name)
        except (OSError, ValueError):
            raw = ""
        raw = raw.strip() if isinstance(raw, str) else ""
        candidate = ntpath.expandvars(raw) if raw else ntpath.join(profile, fallback_name)
        try:
            path = normalize_browse_path(candidate, windows=True)
        except ValueError:
            continue
        places.append({"name": label, "path": path})
    return places


def browse_places():
    if os.name == "nt":
        return windows_common_places()
    home = posixpath.normpath(os.path.expanduser("~"))
    if not posixpath.isabs(home):
        return []
    return [
        {"name": label, "path": posixpath.join(home, folder)}
        for label, folder in (("桌面", "Desktop"), ("图片", "Pictures"),
                              ("视频", "Videos"), ("文档", "Documents"),
                              ("下载", "Downloads"))
    ]


def browse_roots():
    result = {
        "ok": True, "kind": "computer", "path": "", "parent": None,
        "dirs": [], "places": [], "markers": [], "selectable": False, "error": None,
    }
    try:
        if os.name == "nt":
            roots = sorted({normalize_browse_path(p).upper() for p in _windows_logical_drives()})
            result["dirs"] = [{"name": path, "path": path} for path in roots]
        else:
            result["dirs"] = [{"name": "/", "path": "/"}]
            home = os.path.expanduser("~")
            if posixpath.isabs(home) and home != "/":
                result["dirs"].append({"name": "主目录", "path": posixpath.normpath(home)})
    except (OSError, ValueError) as exc:
        result.update(ok=False, error="无法列出磁盘：%s" % exc)
    try:
        result["places"] = browse_places()
    except OSError:
        # Common shortcuts are optional; drive navigation and manual input stay usable.
        result["places"] = []
    return result


def browse_dir(path=None):
    if path is None or (isinstance(path, str) and not path.strip()):
        return browse_roots()
    try:
        path = normalize_browse_path(path)
    except ValueError as exc:
        return {
            "ok": False, "kind": "directory", "path": "", "parent": None,
            "dirs": [], "markers": [], "selectable": False, "error": str(exc),
        }
    pathmod = ntpath if os.name == "nt" else posixpath
    parent = pathmod.dirname(path)
    if parent == path:
        parent = ""
    dirs = []
    try:
        names = os.listdir(path)
    except OSError as exc:
        return {
            "ok": False,
            "kind": "directory",
            "path": path,
            "parent": parent,
            "dirs": [],
            "markers": [],
            "selectable": False,
            "error": "无法列出目录：%s" % exc,
        }
    for name in sorted(names, key=lambda s: s.lower()):
        if name in SKIP_NAMES:
            continue
        full = pathmod.join(path, name)
        try:
            if os.path.isdir(full):
                dirs.append({"name": name, "path": full})
        except OSError:
            continue
    return {
        "ok": True,
        "kind": "directory",
        "path": path,
        "parent": parent,
        "dirs": dirs,
        "markers": library_markers(path),
        "selectable": True,
        "error": None,
    }


def _stat_key(root):
    try:
        st = os.stat(root)
        index = os.path.join(root, "_index.json")
        if os.path.isfile(index):
            ist = os.stat(index)
            return (root, st.st_mtime_ns, ist.st_mtime_ns, ist.st_size)
        return (root, st.st_mtime_ns, 0, 0)
    except OSError:
        return (root, None, None, None)


LIBRARY_CHANGED = "library_changed"
LIBRARY_CHANGED_MESSAGE = "图库已经切换，这次操作没有动任何文件。"
DOWNLOAD_BIND_MISMATCH = "account_mismatch"
DOWNLOAD_BIND_UNSUPPORTED = "unsupported_mode"



# GPT6PRO_BETA1: read-only helpers; mutations never consume cached card data.
def root_identity_key(path, windows=None):
    if not isinstance(path, str) or not path:
        return None
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        return os.path.normcase(os.path.normpath(path))
    value = path.replace("/", "\\")
    lower = value.lower()
    if lower.startswith("\\\\?\\unc\\"):
        value = "\\\\" + value[8:]
    elif lower.startswith("\\\\?\\"):
        value = value[4:]
        if not re.match(r"^[a-zA-Z]:\\", value):
            return None
    elif lower.startswith(("\\\\.\\", "\\??\\")):
        return None
    if not ntpath.isabs(value):
        return None
    return ntpath.normcase(ntpath.normpath(value))


def file_view_stamp(path):
    st = os.stat(path)
    return (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)


@lru_cache(maxsize=256)
def _card_view(directory, stamp):
    return load_card(directory)


def load_card_view(directory):
    try:
        stamp = file_view_stamp(os.path.join(directory, "card.json"))
        # Bound the retained JSON; larger cards still use the original reader.
        return _card_view(directory, stamp) if stamp[-1] <= 1024 * 1024 else load_card(directory)
    except FileNotFoundError:
        return None


@lru_cache(maxsize=256)
def _folder_view(directory, stamp):
    result = folder_listing(directory)
    if result[2] != "available":
        raise OSError("Folder temporarily unavailable")
    return result


def folder_listing_view(directory):
    try:
        return _folder_view(directory, file_view_stamp(directory))
    except OSError:
        return folder_listing(directory)


def attach_member_summary(entry, items, trash_ids=(), known_live=False):
    members = [it for it in items if isinstance(it, dict) and it.get("id")
               and it.get("id") not in trash_ids and (known_live or it.get("status") != "missing")]
    entry["memberIds"] = list(dict.fromkeys(it["id"] for it in members))
    latest, raw_latest = None, ""
    for it in members:
        raw = it.get("created")
        if not isinstance(raw, str) or not raw:
            continue
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            value = parsed.timestamp()
        except (ValueError, TypeError, OverflowError, OSError):
            continue
        if latest is None or value > latest:
            latest, raw_latest = value, raw
    entry["latestItemCreatedAt"] = raw_latest
    return entry


class AppState:
    def __init__(self, initial_root=None):
        self.lock = threading.Lock()
        # Linearizes root commits with root-bound mutations. OS leases are
        # always acquired before this gate; slow scans happen before it.
        self.root_gate = threading.RLock()
        self.root = initial_root or ""
        # Bumped by set_root. A mutation carries the generation it started with,
        # so a library switch mid-request can be caught before a file moves.
        self.generation = 1
        self._lib = None
        self._lib_key = None
        self._lib_gen = 0
        self._flat = None
        self._flat_key = None
        # Last started set_root wins. Slow scans stay outside root_gate, so a
        # later request must be able to invalidate an earlier scan before commit.
        self._set_root_request_id = 0
        self._dedup_preview = None

    def _invalidate_lists(self):
        self._lib = None
        self._lib_key = None
        self._lib_gen = 0
        self._flat = None
        self._flat_key = None
        invalidate_trash_index(self.root)

    def set_root(self, path, persist_if_ok=True):
        path = os.path.abspath(os.path.expanduser(path or ""))
        with self.lock:
            self._set_root_request_id += 1
            request_id = self._set_root_request_id
        lib = detect_library(path)
        annotated = annotate_library(lib)
        with self.root_gate:
            with self.lock:
                if request_id != self._set_root_request_id:
                    return {
                        "ok": False,
                        "code": "stale_root_request",
                        "error": "已切换到另一个图库。",
                        "status": 409,
                        "root": self.root,
                    }
                self.generation += 1
                self.root = path
                self._lib = annotated
                self._lib_key = _stat_key(path) if os.path.isdir(path) else None
                self._lib_gen = self.generation
                self._flat = None
                self._flat_key = None
            if persist_if_ok and lib.get("ok"):
                remember_root(path)
        return annotated

    def library(self, force=False):
        # Three tries: a scan that finishes after set_root describes a library
        # nobody is looking at any more, so it is dropped rather than cached.
        for attempt in range(3):
            with self.lock:
                root = self.root
                gen = self.generation
                cached = self._lib
                cached_key = self._lib_key
                cached_gen = self._lib_gen
            key = _stat_key(root) if root and os.path.isdir(root) else None
            if not force and cached is not None and cached_gen == gen and cached_key is not None and cached_key == key:
                return cached
            lib = annotate_library(detect_library(root))
            with self.lock:
                if self.root != root or self.generation != gen:
                    if attempt < 2:
                        continue
                    return lib
                self._lib = lib
                self._lib_key = key
                self._lib_gen = gen
                if self._flat_key != key:
                    self._flat = None
                    self._flat_key = None
            return lib
        return lib

    def snapshot(self):
        """One resolution of "which library is this" for a whole mutation.

        Re-reading `library()` halfway through a delete can hand back a different
        root, and the second half of the request then writes into a library the
        user has already left."""
        lib = self.library()
        with self.lock:
            gen = self.generation
            root = self.root
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。", "generation": gen}
        if (lib.get("root") or "") != root:
            return {
                "ok": False,
                "code": LIBRARY_CHANGED,
                "error": LIBRARY_CHANGED_MESSAGE,
                "status": 409,
                "generation": gen,
            }
        try:
            root_real = os.path.realpath(root)
        except OSError as exc:
            return {"ok": False, "error": "无法解析图库路径：%s" % exc, "generation": gen}
        return {
            "ok": True,
            "generation": gen,
            "root": lib["root"],
            "root_real": root_real,
            "mode": lib["mode"],
        }

    def snapshot_stale(self, snap):
        with self.lock:
            return self.generation != snap.get("generation") or self.root != snap.get("root")

    def lease_snapshot_stale(self, snap, lease):
        """Recheck process state and the physical root after taking the OS lease."""
        return self.snapshot_stale(snap) or not self.same_physical_root(lease.root, snap.get("root_real"))

    def library_changed_result(self, **extra):
        row = {"ok": False, "code": LIBRARY_CHANGED, "error": LIBRARY_CHANGED_MESSAGE, "status": 409}
        row.update(extra)
        return row

    def expected_root_real(self, payload):
        if not isinstance(payload, dict):
            return None
        expected = str(payload.get("expectedRoot") or "").strip()
        if not expected or not os.path.isabs(expected):
            return None
        try:
            return os.path.realpath(os.path.abspath(expected))
        except OSError:
            return None

    @staticmethod
    def same_physical_root(left, right):
        a, b = root_identity_key(left), root_identity_key(right)
        return bool(a and b) and a == b

    def combo(self, section, folder):
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。"}
        root = lib["root"]
        mode = lib["mode"]
        try:
            section = default_section_for_mode(mode, section)
        except ValueError:
            return {"ok": False, "error": "路径无效。"}
        meta_doc, meta_error = load_meta_safe(root)
        live = live_card_stats(root, mode, section, folder or "", meta=meta_doc,
                               member_files=library_member_files(lib, section, folder))
        if live is None:
            return {"ok": False, "error": "组合目录不存在。"}
        folder_name = live["folder"]
        items = decorate_items(live["items"], section, folder_name if section != "_root" else "")
        durations = duration_lookup(root, [item.get("id") for item in items if media_kind(item) == "video"])
        for item in items:
            attach_item_meta(item, meta_doc)
            attach_duration(item, durations)
        card_meta = live["summary"]
        return {
            "ok": True,
            "section": section,
            "folder": folder_name if section != "_root" else "",
            "card": card_meta,
            "root": root,
            "items": items,
            "lastViewedId": card_meta.get("lastViewedId") or "",
            "coverId": card_meta.get("coverId") or "",
            "coverMedia": card_meta.get("coverMedia") or "",
            "metaError": meta_error,
        }

    def cards(self, section, folders):
        """Exact per-card numbers for the tiles the wall actually shows."""
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。", "cards": []}
        root = lib["root"]
        mode = lib["mode"]
        try:
            section = default_section_for_mode(mode, section)
        except ValueError:
            return {"ok": False, "error": "路径无效。", "cards": []}
        if not isinstance(folders, list):
            return {"ok": False, "error": "请提供 folders。", "cards": []}
        meta_doc, meta_error = load_meta_safe(root)
        trash = trash_index(root)
        durations = duration_index(root)
        rows = []
        for raw in folders[:CARDS_BATCH_MAX]:
            folder = str(raw or "")
            live = live_card_stats(
                root, mode, section, folder, meta=meta_doc, trash=trash, durations=durations,
                member_files=library_member_files(lib, section, folder)
            )
            if live is None:
                rows.append({"folder": folder, "section": section, "count": 0, "live": True, "gone": True})
                continue
            row = dict(live["summary"])
            row["folder"] = live["folder"] if section != "_root" else ""
            rows.append(row)
        return {"ok": True, "section": section, "root": root, "cards": rows, "metaError": meta_error}

    def put_duration(self, payload):
        """Length measured by the page's own <video>, for clips ffprobe missed.

        A library with no ffmpeg (or a codec ffprobe cannot read) would otherwise
        never get a badge. The browser already decoded the clip to play it, so its
        `loadedmetadata` is a free second source; it is written to the same
        sidecar the walls read."""
        if not isinstance(payload, dict):
            return {"ok": False, "error": "请求无效。", "status": 400}
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {"ok": False, "error": "expectedRoot 必须是绝对路径。", "status": 400}
        asset_id = str(payload.get("id") or "")
        try:
            seconds = float(payload.get("duration"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "时长无效。", "status": 400}
        # A zero, a NaN and a clip longer than a day are all bugs upstream, not
        # badges. `not (seconds > 0)` is what rules out NaN as well as negatives.
        if not (seconds > 0) or seconds > MAX_DURATION:
            return {"ok": False, "error": "时长无效。", "status": 400}
        if not is_safe_name(asset_id):
            return {"ok": False, "error": "id 无效。", "status": 400}
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if not self.same_physical_root(expected_real, snap.get("root_real")):
            return self.library_changed_result()
        try:
            with gallery_write_lease(snap["root"], owner="python-duration") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease) or not self.same_physical_root(
                        expected_real, snap.get("root_real")
                    ):
                        return self.library_changed_result()
                    try:
                        section, directory, folder_name, items = self._lookup_card_items(
                            snap, payload.get("section") or "", str(payload.get("folder") or "")
                        )
                    except ValueError:
                        return {"ok": False, "error": "路径无效。", "status": 400}
                    item = item_by_id(items, asset_id)
                    # Only a live video in this card, resolved through the same
                    # jail as /media, may name a sidecar. A still has no length.
                    if item is None or media_kind(item) != "video":
                        return {"ok": False, "error": "这一项不是可见视频。", "status": 404}
                    try:
                        src = jail_join(directory, item.get("file") or "")
                    except ValueError:
                        return {"ok": False, "error": "文件不在了。", "status": 404}
                    if not os.path.isfile(src):
                        return {"ok": False, "error": "文件不在了。", "status": 404}
                    if not write_duration_only(snap["root"], asset_id, seconds, src=src):
                        return {"ok": False, "error": "无法写入时长。"}
                    return {"ok": True, "id": asset_id, "duration": round(seconds, 3)}
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc)

    def cover_target(self, section, folder, asset_id=""):
        """Resolve the cover item for a card without decorating every sibling."""
        lib = self.library()
        if not lib.get("ok"):
            return None
        root = lib["root"]
        mode = lib["mode"]
        section = default_section_for_mode(mode, section)
        live = live_card_stats(root, mode, section, folder or "", meta=load_meta_safe(root)[0],
                               member_files=library_member_files(lib, section, folder))
        if live is None:
            return None
        items = live["items"]
        wanted = item_by_id(items, asset_id) if asset_id else None
        candidates = [wanted] if wanted else cover_candidates(items, live["summary"].get("lastViewedId") or "")
        return {
            "root": root,
            "section": section,
            "folder": live["folder"] if section != "_root" else "",
            "directory": live["directory"],
            "candidates": [it for it in candidates if it],
        }

    def flat(self):
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。", "items": []}
        key = _stat_key(lib["root"])
        with self.lock:
            if self._flat is not None and self._flat_key == key:
                return {"ok": True, "items": self._flat, "root": lib["root"]}
        items = []
        mode = lib["mode"]
        meta_doc, meta_error = load_meta_safe(lib["root"])
        trash = trash_index(lib["root"])
        durations = duration_index(lib["root"])
        groups = [("combos", lib.get("combos") or [])]
        if lib.get("hasOther"):
            groups.append(("_other", lib.get("other") or []))
        if mode == "single":
            groups = [("_root", lib.get("combos") or [])]
        elif mode == "loose":
            groups = [("loose", lib.get("combos") or [])]
        for section, entries in groups:
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                folder = entry.get("folder") or ""
                if section != "_root" and not folder:
                    continue
                try:
                    directory = section_folder_dir(lib["root"], mode, section, folder)
                except ValueError:
                    continue
                if not os.path.isdir(directory):
                    continue
                try:
                    card = load_card_view(directory)
                except (OSError, json.JSONDecodeError):
                    card = None
                if card is None:
                    card = synthesize_card(directory, folder or os.path.basename(directory))
                folder_name = card.get("folder") or folder or os.path.basename(directory)
                title = card.get("title") or entry.get("title") or ""
                names, markers, avail = folder_listing_view(directory)
                if avail == "missing":
                    continue
                # An unreadable folder proves nothing about its contents. Dropping
                # its rows would silently shrink the flat wall during a CIFS blip.
                reachable = avail == "available"
                candidates = items_from_card(card, folder_name)
                if reachable:
                    candidates.extend(unlisted_disk_items(candidates, names, folder_name))
                allowed = entry.get("memberFiles") if entry.get("source") == "disk_leftover" else None
                for item in candidates:
                    if allowed is not None and item.get("file") not in allowed:
                        continue
                    if item_is_trashed(
                        lib["root"],
                        item,
                        directory,
                        ids=trash["ids"],
                        markers=markers if reachable else None,
                        ignore_marker_ids=trash["ignoreMarkerIds"],
                    ):
                        continue
                    if reachable and item.get("file") not in names:
                        continue
                    row = dict(item)
                    row["title"] = title
                    decorated = decorate_items(
                        [row],
                        section,
                        folder_name if section != "_root" else "",
                    )
                    for dec in decorated:
                        attach_item_meta(dec, meta_doc)
                        attach_duration(dec, durations)
                    items.extend(decorated)
        items.sort(key=lambda it: created_sort_key(it.get("created")))
        with self.lock:
            if self.root == lib["root"] and self._lib is lib:
                self._flat = items
                self._flat_key = key
        return {"ok": True, "items": items, "root": lib["root"], "metaError": meta_error}

    def save_copy(self, payload):
        """Export one resolved live member, never a renderer-supplied path/URL."""
        expected = self.expected_root_real(payload)
        if expected is None:
            return {"ok": False, "error": "另存为必须绑定当前图库。", "status": 400}
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if not self.same_physical_root(expected, snap["root_real"]):
            return self.library_changed_result()
        asset_id = payload.get("id")
        if not isinstance(asset_id, str) or not is_safe_name(asset_id):
            return {"ok": False, "error": "媒体标识无效。", "status": 400}
        try:
            prefs = viewer_preferences.read_preferences(load_config_strict())
            with gallery_write_lease(snap["root"], owner="python-save-copy") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease):
                        return self.library_changed_result()
                    _, directory, _, items = self._lookup_card_items(
                        snap, payload.get("section") or "", str(payload.get("folder") or "")
                    )
                    item = item_by_id(items, asset_id)
                    if not item or media_kind(item) not in ("image", "video"):
                        return {"ok": False, "error": "媒体不存在或已进入回收站。", "status": 404}
                    if os.path.splitext(item.get("file") or "")[0] != asset_id:
                        return {"ok": False, "error": "媒体文件身份不一致，已拒绝复制。", "status": 409}
                    source = jail_join(directory, item["file"])
                    # The snapshot path jail and fresh member lookup are required
                    # even when read-only UI caches have the same asset id.
                    if rel_under_root(snap["root_real"], source).startswith(".trash/"):
                        raise ValueError("不能另存为回收站文件。")
                    result = viewer_preferences.copy_out(source, prefs["saveDirectory"], snap["root_real"])
                    result["root"] = snap["root"]
                    return result
        except StoreError as exc:
            return store_error_result(exc)
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc)
        except (ValueError, FileNotFoundError) as exc:
            return {"ok": False, "error": str(exc), "status": 409}
        except OSError as exc:
            return {"ok": False, "code": "copy_failed", "error": "本地复制失败（系统错误 %s）；原文件未移动、同名文件未覆盖。" % (getattr(exc, "winerror", None) or exc.errno), "status": 503}

    def resolve_media(self, section, folder, filename):
        lib = self.library()
        if not lib.get("ok"):
            raise ValueError("library not ready")
        section = default_section_for_mode(lib["mode"], section)
        filename = os.path.basename(filename or "")
        if not is_safe_name(filename):
            raise ValueError("bad file")
        directory = section_folder_dir(lib["root"], lib["mode"], section, folder or "")
        path = jail_join(directory, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        # Final jail against the selected root (not just the combo folder).
        root_real = os.path.realpath(lib["root"])
        real = os.path.realpath(path)
        if real != root_real and not real.startswith(root_real + os.sep):
            raise ValueError("escaped")
        trash_real = os.path.realpath(os.path.join(root_real, TRASH_DIR))
        if real == trash_real or real.startswith(trash_real + os.sep):
            raise ValueError("escaped")
        return path

    def get_meta(self):
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。", "meta": default_meta()}
        meta, meta_error = load_meta_safe(lib["root"])
        return {"ok": True, "root": lib["root"], "meta": meta, "metaError": meta_error}

    def put_meta(self, payload):
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if download_bind_only_mode() and isinstance(payload, dict) and "grokUserId" in payload:
            return {
                "ok": False,
                "code": "binding_endpoint_required",
                "error": "图库账号绑定只能由桌面下载流程设置。",
                "status": 400,
            }
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {
                "ok": False,
                "code": "expected_root_required",
                "error": "元数据写入必须绑定当前图库。",
                "status": 400,
            }
        if not isinstance(payload, dict) or "expectedRevision" not in payload:
            return {
                "ok": False,
                "code": "meta_revision_required",
                "error": "元数据写入缺少版本号。",
                "status": 400,
            }
        expected_revision = payload.get("expectedRevision")
        if (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
            or expected_revision > META_REVISION_MAX
        ):
            return {
                "ok": False,
                "code": "meta_revision_invalid",
                "error": "元数据版本号无效。",
                "status": 400,
            }
        try:
            # Global order: gallery lease (when present) -> meta lease ->
            # root gate -> brief AppState lock -> store lock -> disk.
            with meta_write_lease(snap["root"], owner="python-meta-put") as lease:
                with self.root_gate:
                    if (
                        self.lease_snapshot_stale(snap, lease)
                        or not self.same_physical_root(expected_real, snap.get("root_real"))
                    ):
                        return self.library_changed_result()
                    meta, matched = merge_meta_payload(
                        lease.root, payload, expected_revision
                    )
                    if not matched:
                        return {
                            "ok": False,
                            "code": "meta_conflict",
                            "error": "元数据已被另一窗口更新。",
                            "root": snap["root"],
                            "expectedRevision": expected_revision,
                            "actualRevision": meta["revision"],
                            "meta": meta,
                            "status": 409,
                        }
                    with self.lock:
                        self._invalidate_lists()
                    return {"ok": True, "root": snap["root"], "meta": meta}
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc)
        except StoreError as exc:
            # The old file is unreadable, so a merge would drop every flag it
            # holds. Refuse loudly instead of saving our idea of "empty".
            return store_error_result(exc)
        except ValueError:
            return {"ok": False, "error": "元数据无效。", "status": 400}
        except OSError as exc:
            return {"ok": False, "error": "无法写入元数据：%s" % exc}

    def bind_download_account(self, payload):
        """Atomically bind an indexed library to the probed Grok account.

        The potentially slow library scan runs before taking the state lock.
        Generation, selected root and canonical expected root are then checked
        again under that lock before the meta sidecar is read or written.
        """
        if not download_bind_only_mode():
            return {"ok": False, "error": "Not Found", "status": 404}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "请求无效。", "status": 400}
        expected = str(payload.get("expectedRoot") or "").strip()
        raw_user_id = str(payload.get("grokUserId") or "").strip()
        user_id = normalize_grok_user_id(raw_user_id)
        commit = payload.get("commit", True)
        if commit not in (True, False):
            return {"ok": False, "error": "请求无效。", "status": 400}
        if not expected or not os.path.isabs(expected):
            return {"ok": False, "error": "预期图库路径无效。", "status": 400}
        if not user_id or user_id != raw_user_id:
            return {"ok": False, "error": "Grok 账号标识无效。", "status": 400}

        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if snap.get("mode") != "index":
            return {
                "ok": False,
                "code": DOWNLOAD_BIND_UNSUPPORTED,
                "error": "下载只支持带 _index.json 的完整图库。",
                "status": 409,
            }
        try:
            expected_real = os.path.realpath(os.path.abspath(expected))
        except OSError:
            return self.library_changed_result()

        try:
            # Never wait for the OS lease while holding AppState.lock or a
            # sidecar lock. The physical root is revalidated after acquisition.
            with gallery_write_lease(snap["root"], owner="python-bind") as lease:
                current_real = lease.root
                with meta_write_lease(current_real, owner="python-bind-meta") as meta_lease:
                    with self.root_gate:
                        if self.lease_snapshot_stale(snap, lease):
                            return self.library_changed_result()
                        if not self.same_physical_root(meta_lease.root, current_real):
                            return self.library_changed_result()
                        try:
                            selected_real = os.path.realpath(os.path.abspath(self.root))
                        except OSError:
                            return self.library_changed_result()
                        if (
                            not os.path.isdir(current_real)
                            or not self.same_physical_root(current_real, selected_real)
                            or not self.same_physical_root(current_real, snap["root_real"])
                            or not self.same_physical_root(current_real, expected_real)
                        ):
                            return self.library_changed_result()
                        try:
                            path = meta_path(current_real)
                            with store_lock(path):
                                meta = load_meta(current_real)
                                bound = normalize_grok_user_id(meta.get("grokUserId"))
                                if bound and bound != user_id:
                                    return {
                                        "ok": False,
                                        "code": DOWNLOAD_BIND_MISMATCH,
                                        "mismatch": True,
                                        "error": "当前登录账号与这个图库不一致。",
                                        "status": 409,
                                    }
                                if not bound:
                                    if not commit:
                                        return {
                                            "ok": True,
                                            "root": current_real,
                                            "bound": False,
                                        }
                                    if meta["revision"] >= META_REVISION_MAX:
                                        raise StoreCorrupt(path, "meta revision exhausted")
                                    updated = normalize_meta(meta)
                                    updated["grokUserId"] = user_id
                                    updated["revision"] = meta["revision"] + 1
                                    save_meta(current_real, updated)
                        except StoreError as exc:
                            return store_error_result(exc)
                        except OSError:
                            return {
                                "ok": False,
                                "code": "store_unavailable",
                                "error": STORE_MESSAGES["store_unavailable"],
                                "status": 503,
                            }
                        with self.lock:
                            self._invalidate_lists()
                        return {"ok": True, "root": current_real, "bound": True}
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc)

    def get_views(self):
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。", "views": default_views()}
        cfg, cfg_error = load_library_config_safe(lib["root"])
        return {"ok": True, "root": lib["root"], "views": cfg["views"], "configError": cfg_error}

    def put_views(self, payload):
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {
                "ok": False,
                "code": "expected_root_required",
                "error": "视图写入必须绑定当前图库。",
                "status": 400,
            }
        raw = payload.get("views") if isinstance(payload, dict) and "views" in payload else payload
        try:
            with self.root_gate:
                if self.snapshot_stale(snap) or not self.same_physical_root(
                    expected_real, snap.get("root_real")
                ):
                    return self.library_changed_result()
                views = save_library_views(snap["root_real"], raw)
        except StoreError as exc:
            return store_error_result(exc)
        except (OSError, TypeError, ValueError) as exc:
            return {"ok": False, "error": "无法保存视图：%s" % exc}
        return {"ok": True, "root": snap["root"], "views": views}

    def trash_list(self):
        snap = self.snapshot()
        if not snap.get("ok"):
            return {"ok": False, "error": snap.get("error") or "图库不可用。", "items": []}
        # A5: a purged asset keeps its by-id tombstone for the download script, but
        # the trash view must not offer an empty shell the user cannot restore.
        rows = []
        item_cache = {}
        by_id = os.path.join(snap["root_real"], TRASH_DIR, "by-id")
        try:
            names = os.listdir(by_id)
        except OSError:
            names = []
        copies = os.path.join(snap["root_real"], TRASH_DIR, "copies")
        try:
            for token in os.listdir(copies):
                if re.fullmatch(r"[0-9a-f]{32}", token):
                    names.append("copy:" + token + ".json")
        except OSError:
            pass
        for name in names:
            if not name.endswith(".json"):
                continue
            asset_id = name[:-5]
            if not is_safe_name(asset_id) and not _copy_token(asset_id):
                continue
            try:
                tomb = self._load_controlled_tombstone(
                    snap, asset_id, item_cache=item_cache, skip_absent_body=True
                )
                if not tomb:
                    continue
                _, body = self._trash_paths(
                    snap, asset_id, tomb, item_cache=item_cache
                )
                self._require_regular_entry(body)
            except (OSError, ValueError):
                continue
            row = dict(tomb)
            row["exists"] = True
            row["cover"] = "/resource/trash/file?id=%s" % quote(asset_id)
            rows.append(row)
        rows.sort(key=lambda it: it.get("deletedAt") or "", reverse=True)
        return {"ok": True, "root": snap["root"], "items": rows}

    def _readonly_trash_body_missing(self, snap, asset_id, tomb):
        """List-only fast negative; never a proof for restore/purge or deletion.

        Reconstruct the permitted body from typed identity fields before doing
        I/O. Only ENOENT on that controlled path is a negative: permissions,
        network errors and unsafe ancestors fall through to full validation.
        """
        if not isinstance(tomb, dict) or tomb.get("id") != asset_id:
            return False
        section, folder, filename = tomb.get("section"), tomb.get("folder"), tomb.get("file")
        if not isinstance(filename, str) or not is_safe_name(filename):
            return False
        token = _copy_token(asset_id)
        if token:
            if (tomb.get("scope") != "copy" or tomb.get("token") != token
                or tomb.get("assetId") != os.path.splitext(filename)[0]):
                return False
            body_rel = posixpath.join(TRASH_DIR, "copies", token, filename)
        else:
            if os.path.splitext(filename)[0] != asset_id:
                return False
            body_rel = trash_media_rel(section, folder, filename) if isinstance(section, str) and isinstance(folder, str) else None
        try:
            origin_rel = self._expected_trash_origin_rel(snap["mode"], section, folder, filename)
            if tomb.get("from") != origin_rel or tomb.get("to") != body_rel:
                return False
            body = _dedup_entry(snap["root_real"], *body_rel.split("/"))
        except (OSError, ValueError, TypeError):
            return False
        try:
            os.lstat(body)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        return False

    def _lookup_card_items(self, snap, section, folder):
        """Resolve a card against a snapshot. Never re-reads `library()`."""
        section = default_section_for_mode(snap["mode"], section)
        directory = section_folder_dir(snap["root"], snap["mode"], section, folder or "")
        try:
            card = load_card(directory)
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("无法读取 card.json：%s" % exc)
        if card is None:
            card = synthesize_card(directory, folder or os.path.basename(directory))
        folder_name = card.get("folder") or folder or os.path.basename(directory)
        return section, directory, folder_name, items_from_card(card, folder_name)

    def trash_add(self, payload):
        """One card, or `groups: [{section, folder, ids}]` for a selection."""
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if not isinstance(payload, dict):
            return {"ok": False, "error": "JSON 无效。"}
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {"ok": False, "error": "expectedRoot must be absolute.", "status": 400}
        if not self.same_physical_root(expected_real, snap.get("root_real")):
            return self.library_changed_result(moved=[], errors=[])
        try:
            with gallery_write_lease(snap["root"], owner="python-trash") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease) or not self.same_physical_root(
                        expected_real, snap.get("root_real")
                    ):
                        return self.library_changed_result(moved=[], errors=[])
                    return self._trash_add_locked(snap, payload)
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc, moved=[], errors=[])

    def _trash_add_locked(self, snap, payload):
        groups = payload.get("groups")
        if isinstance(groups, list):
            moved = []
            errors = []
            for group in groups[:500]:
                if not isinstance(group, dict):
                    continue
                res = self._trash_add_one(snap, group)
                if res.get("code") == LIBRARY_CHANGED:
                    return self.library_changed_result(moved=moved, errors=errors)
                if not res.get("ok"):
                    errors.append({"folder": group.get("folder") or "", "error": res.get("error") or "failed"})
                    continue
                moved.extend(res.get("moved") or [])
                errors.extend(res.get("errors") or [])
            return {"ok": True, "moved": moved, "errors": errors}
        return self._trash_add_one(snap, payload)

    def _trash_add_one(self, snap, payload):
        root = snap["root"]
        section = payload.get("section") or ""
        folder = payload.get("folder") or ""
        want_files = payload.get("files")
        want_ids = payload.get("ids")
        try:
            section, directory, folder_name, items = self._lookup_card_items(snap, section, folder)
        except ValueError:
            return {"ok": False, "error": "路径无效。"}
        selected = []
        file_set = set(want_files) if isinstance(want_files, list) else None
        id_set = set(want_ids) if isinstance(want_ids, list) else None
        for item in items:
            if item_is_trashed(root, item, directory):
                continue
            filename = item.get("file") or ""
            if not filename or not is_safe_name(filename):
                continue
            if file_set is None and id_set is None:
                selected.append(item)
                continue
            if file_set is not None and filename in file_set:
                selected.append(item)
                continue
            if id_set is not None and item.get("id") in id_set:
                selected.append(item)
        moved = []
        errors = []
        for item in selected:
            filename = item["file"]
            asset_id = item.get("id") or os.path.splitext(filename)[0]
            if not is_safe_name(asset_id):
                errors.append({"file": filename, "error": "bad id"})
                continue
            if os.path.splitext(filename)[0] != asset_id:
                errors.append(
                    {"id": asset_id, "file": filename, "error": "id_file_mismatch"}
                )
                continue
            try:
                src = jail_join(directory, filename)
            except ValueError:
                errors.append({"file": filename, "error": "bad path"})
                continue
            try:
                src_stat = self._require_regular_entry(src)
            except FileNotFoundError:
                errors.append({"id": asset_id, "file": filename, "error": "missing"})
                continue
            except (OSError, ValueError) as exc:
                errors.append({"id": asset_id, "file": filename, "error": str(exc)})
                continue
            # Last gate before the only irreversible step. A root switch between
            # the snapshot and here must not drag files into the new library.
            if self.snapshot_stale(snap):
                with self.lock:
                    self._invalidate_lists()
                return self.library_changed_result(moved=moved, errors=errors)
            try:
                dest = trash_media_abs(root, section, folder_name if section != "_root" else "", filename)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                if os.path.lexists(dest):
                    raise FileExistsError(errno.EEXIST, "trash destination exists", dest)
                tomb = {
                    "id": asset_id,
                    "from": rel_under_root(root, src),
                    "to": rel_under_root(root, dest),
                    "section": section,
                    "folder": folder_name if section != "_root" else "",
                    "file": filename,
                    "deletedAt": utc_now(),
                    "token": os.urandom(16).hex(),
                    "size": src_stat.st_size,
                    "mtimeNs": src_stat.st_mtime_ns,
                }
                intent = self._write_controlled_tombstone(snap, tomb, "trashing")
                marker = src + ".trashed"
                self._write_controlled_marker(marker, intent)
                self._move_regular_no_replace_verified(src, dest, src_stat)
                try:
                    moved.append(self._write_controlled_tombstone(snap, intent, "trashed"))
                except (OSError, ValueError) as exc:
                    pending = dict(intent)
                    pending["pending"] = True
                    moved.append(pending)
                    errors.append(
                        {
                            "id": asset_id,
                            "file": filename,
                            "error": "trash_commit_pending: %s" % exc,
                        }
                    )
            except (OSError, ValueError) as exc:
                errors.append({"id": asset_id, "file": filename, "error": str(exc)})
        with self.lock:
            self._invalidate_lists()
        return {"ok": True, "moved": moved, "errors": errors}

    def library_dedup(self, payload):
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        if not isinstance(payload, dict):
            return {"ok": False, "error": "JSON 无效。"}
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {"ok": False, "error": "expectedRoot must be absolute.", "status": 400}
        if not self.same_physical_root(expected_real, snap.get("root_real")):
            return self.library_changed_result()
        apply = payload.get("apply") is True
        if not apply:
            planned = plan_library_dedup(snap["root"], snap.get("mode"))
            if not planned.get("ok"):
                return planned
            preview = {"token": os.urandom(24).hex(), "root": snap["root_real"],
                       "generation": snap["generation"], "created": time.monotonic(),
                       "signature": _dedup_signature(planned),
                       "keys": frozenset(group["key"] for group in planned["groups"])}
            with self.root_gate:
                if self.snapshot_stale(snap):
                    return self.library_changed_result()
                self._dedup_preview = preview
            planned["planToken"] = preview["token"]
            if "_groups" in planned:
                planned = dict(planned)
                planned.pop("_groups", None)
                planned.pop("_indexed", None)
            return planned
        raw_actions = payload.get("actions") if isinstance(payload.get("actions"), dict) else {}
        if len(raw_actions) > _DEDUP_PREVIEW_LIMIT:
            return {"ok": False, "error": "去重选项超过预览范围。", "status": 400}
        actions = {}
        for key, value in list(raw_actions.items())[:200]:
            if not isinstance(key, str) or len(key) > 200 or value not in _DEDUP_ACTIONS:
                return {"ok": False, "error": "去重选项无效。", "status": 400}
            actions[key] = value
        force = payload.get("force") is True
        try:
            with gallery_write_lease(snap["root"], owner="python-dedup") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease) or not self.same_physical_root(
                        expected_real, snap.get("root_real")
                    ):
                        return self.library_changed_result()
                    preview = self._dedup_preview
                    if (not preview or payload.get("planToken") != preview["token"]
                        or preview["generation"] != snap["generation"]
                        or not self.same_physical_root(preview["root"], snap["root_real"])
                        or time.monotonic() - preview["created"] > 900
                        or not set(actions).issubset(preview["keys"])):
                        return {"ok": False, "status": 409, "code": "dedup_preview_required",
                                "error": "去重预览已失效，请重新扫描后明确选择。"}
                    self._dedup_preview = None  # one apply attempt per preview
                    return self._library_dedup_apply_locked(snap, actions, force, preview)
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc)

    def _library_dedup_apply_locked(self, snap, actions, force=False, preview=None):
        planned = plan_library_dedup(snap["root"], snap.get("mode"))
        if not planned.get("ok"):
            return planned
        if preview is None or _dedup_signature(planned) != preview["signature"]:
            return {"ok": False, "status": 409, "code": "dedup_plan_changed",
                    "error": "预览后图库文件或分组已变化；没有执行清理，请重新扫描。"}
        indexed = set(tuple(row) for row in planned["_indexed"])
        moved = []
        errors = []
        for group in planned.get("_groups") or []:
            action = actions.get(group["key"], "skip")
            if action == "skip":
                continue
            if group.get("oversized") and not force:
                errors.append({"folder": group["keep"]["folder"], "error": "oversized_group"})
                continue
            keep = group["_rows"][0]
            try:
                keep_dir = _dedup_entry(snap["root_real"], keep["section"], keep["folder"])
            except (OSError, ValueError) as exc:
                errors.append({"folder": keep["folder"], "error": str(exc)})
                continue
            for other in group["_rows"][1:]:
                if (other["section"], other["folder"]) in indexed:
                    errors.append({"folder": other["folder"], "error": "refuse_indexed"})
                    continue
                if not _dedup_shared_stems(keep, other):
                    continue
                for stem, entry in other["files"].items():
                    held = keep["files"].get(stem)
                    same = held is not None and same_media_fingerprint(held["fp"], entry["fp"])
                    try:
                        source = _dedup_entry(snap["root_real"], other["section"], other["folder"], entry["file"])
                        if dedup_media_fingerprint(source) != entry["fp"]:
                            raise ValueError("dedup_source_changed")
                        if held is not None and dedup_media_fingerprint(held["path"]) != held["fp"]:
                            raise ValueError("dedup_kept_file_changed")
                        if held is None:
                            if action != "merge":
                                continue  # same-only cleanup never relocates unique media
                            dest = jail_join(keep_dir, entry["file"])
                            if os.path.lexists(dest):
                                raise FileExistsError(dest)
                            retained_fp = _dedup_copy_verified(source, dest, entry["fp"])
                        elif same:
                            dest, retained_fp = held["path"], held["fp"]
                        elif action == "keep_newest":
                            continue
                        else:
                            ext = os.path.splitext(entry["file"])[1]
                            name = _unique_merge_name(
                                keep_dir,
                                os.path.splitext(entry["file"])[0],
                                other["n"] or "x",
                                ext,
                            )
                            dest = jail_join(keep_dir, name)
                            retained_fp = _dedup_copy_verified(source, dest, entry["fp"])
                        if self.snapshot_stale(snap):
                            return self.library_changed_result(moved=moved, errors=errors)
                        if dedup_media_fingerprint(dest) != retained_fp:
                            raise ValueError("dedup_retained_file_changed")
                        moved.append(self._quarantine_dedup_copy(snap, other, entry))
                    except (OSError, ValueError) as exc:
                        errors.append({"folder": other["folder"], "id": stem, "error": str(exc)})
                        continue
        with self.lock:
            self._invalidate_lists()
        return {"ok": True, "moved": moved, "errors": errors, "groups": len(planned.get("groups") or [])}

    def _quarantine_dedup_copy(self, snap, other, entry):
        """Path-scoped reversible cleanup; never emits an asset tombstone."""
        token = os.urandom(16).hex()
        root = snap["root_real"]
        filename = entry["file"]
        origin = _dedup_entry(root, other["section"], other["folder"], filename)
        if dedup_media_fingerprint(origin) != entry["fp"]:
            raise ValueError("dedup_source_changed")
        destination = _dedup_entry(root, TRASH_DIR, "copies", token, filename)
        os.makedirs(os.path.dirname(destination), exist_ok=False)
        tomb = {"id": "copy:" + token, "assetId": os.path.splitext(filename)[0], "scope": "copy",
                "section": other["section"], "folder": other["folder"], "file": filename,
                "from": posixpath.join(other["section"], other["folder"], filename),
                "to": posixpath.join(TRASH_DIR, "copies", token, filename),
                "deletedAt": utc_now(), "token": token, "size": entry["fp"]["size"],
                "mtimeNs": entry["fp"]["mtimeNs"], "hash": entry["fp"]["hash"]}
        intent = self._write_controlled_tombstone(snap, tomb, "trashing")
        self._write_controlled_marker(self._trash_marker_path(snap, intent, origin), intent)
        _dedup_entry(root, TRASH_DIR, "copies", token, filename)
        if dedup_media_fingerprint(origin) != entry["fp"]:
            raise ValueError("dedup_source_changed")
        self._move_regular_no_replace_verified(origin, destination)
        self._require_tomb_fingerprint(destination, intent)
        return self._write_controlled_tombstone(snap, intent, "trashed")

    @staticmethod
    def _is_reparse(st):
        flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return bool(getattr(st, "st_file_attributes", 0) & flag)

    @classmethod
    def _require_regular_entry(cls, path):
        """lstat the final directory entry; links/reparse points fail closed."""
        st = os.lstat(path)
        if cls._is_reparse(st) or not stat.S_ISREG(st.st_mode):
            raise ValueError("unsafe_non_regular_entry")
        return st

    @staticmethod
    def _lexical_entry_under(root_real, rel):
        """Resolve parents for containment while preserving the final entry."""
        if not isinstance(rel, str) or not rel or os.path.isabs(rel) or "\\" in rel:
            raise ValueError("escaped")
        parts = rel.split("/")
        if any(not is_safe_name(part) for part in parts):
            raise ValueError("escaped")
        parent_real = os.path.realpath(os.path.join(root_real, *parts[:-1]))
        if parent_real != root_real and not parent_real.startswith(root_real + os.sep):
            raise ValueError("escaped")
        return os.path.join(parent_real, parts[-1])

    @classmethod
    def _move_regular_no_replace(cls, src, dest, expected_stat=None):
        """Move one regular file without ever replacing an existing entry."""
        current = cls._require_regular_entry(src)
        if expected_stat is not None and (
            current.st_size,
            current.st_mtime_ns,
        ) != (expected_stat.st_size, expected_stat.st_mtime_ns):
            raise OSError(errno.EIO, "move source fingerprint changed", src)
        if os.path.lexists(dest):
            raise FileExistsError(errno.EEXIST, "destination exists", dest)
        if os.name == "nt":
            # MoveFile semantics used by os.rename on Windows reject an
            # existing destination, including directories and dangling links.
            os.rename(src, dest)
            return
        # link(2) is the portable create-if-absent primitive for a same-volume
        # regular file. Unlink the source only after the destination is owned.
        os.link(src, dest, follow_symlinks=False)
        os.unlink(src)

    @classmethod
    def _move_regular_no_replace_verified(cls, src, dest, expected_stat=None):
        """Move, then classify an SMB error using the source fingerprint."""
        before = expected_stat or cls._require_regular_entry(src)
        expected = (before.st_size, before.st_mtime_ns)

        def verified_destination():
            current = cls._require_regular_entry(dest)
            if (current.st_size, current.st_mtime_ns) != expected:
                raise OSError(errno.EIO, "move destination fingerprint mismatch", dest)

        try:
            cls._move_regular_no_replace(src, dest, before)
        except OSError:
            if not os.path.lexists(src) and os.path.lexists(dest):
                verified_destination()
                return
            raise
        if os.path.lexists(src) or not os.path.lexists(dest):
            raise OSError(errno.EIO, "move outcome could not be verified")
        verified_destination()

    @classmethod
    def _remove_controlled_regular(cls, path, missing_ok=True):
        if not os.path.lexists(path):
            if missing_ok:
                return False
            raise FileNotFoundError(errno.ENOENT, "missing entry", path)
        cls._require_regular_entry(path)
        try:
            os.remove(path)
        except OSError:
            if not os.path.lexists(path):
                return True
            raise
        if os.path.lexists(path):
            raise OSError(errno.EIO, "remove outcome could not be verified", path)
        return True

    @staticmethod
    def _marker_payload(tomb):
        keys = (
            "id",
            "file",
            "section",
            "folder",
            "from",
            "to",
            "token",
            "size",
            "mtimeNs",
        )
        row = {key: tomb.get(key) for key in keys}
        if tomb.get("scope") == "copy":
            row.update({key: tomb.get(key) for key in ("scope", "assetId", "hash")})
        row["phase"] = "trashing"
        return row

    @staticmethod
    def _trash_marker_path(snap, tomb, origin):
        token = _copy_token(tomb.get("id"))
        if token:
            return _dedup_entry(snap["root_real"], TRASH_DIR, "copies", token, "binding.json")
        return origin + ".trashed"

    @classmethod
    def _read_controlled_marker(cls, path):
        cls._require_regular_entry(path)
        data = read_json(path)
        if not isinstance(data, dict):
            raise ValueError("invalid trash marker")
        return data

    @classmethod
    def _write_controlled_marker(cls, path, tomb):
        expected = cls._marker_payload(tomb)
        first_error = None
        try:
            write_json_atomic(path, expected)
        except OSError as exc:
            first_error = exc
        try:
            stored = cls._read_controlled_marker(path)
        except (OSError, ValueError):
            if first_error is not None:
                raise first_error
            raise
        if stored != expected:
            if first_error is not None:
                raise first_error
            raise OSError(errno.EIO, "trash marker write could not be verified", path)
        return stored

    @classmethod
    def _require_tomb_fingerprint(cls, path, tomb):
        st = cls._require_regular_entry(path)
        size = tomb.get("size")
        mtime_ns = tomb.get("mtimeNs")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not isinstance(mtime_ns, int)
            or isinstance(mtime_ns, bool)
            or (st.st_size, st.st_mtime_ns) != (size, mtime_ns)
        ):
            raise ValueError("trash fingerprint mismatch")
        if tomb.get("scope") == "copy" and dedup_media_fingerprint(path)["hash"] != tomb.get("hash"):
            raise ValueError("copy content fingerprint mismatch")
        return st

    @staticmethod
    def _expected_trash_origin_rel(mode, section, folder, filename):
        """Canonical live-media path represented by one tombstone."""
        if section not in allowed_sections(mode):
            raise ValueError("invalid tombstone section")
        if not isinstance(filename, str) or not is_safe_name(filename):
            raise ValueError("invalid tombstone file")
        if section == "_root":
            if folder != "":
                raise ValueError("invalid tombstone folder")
            return filename
        if not isinstance(folder, str) or not is_safe_name(folder):
            raise ValueError("invalid tombstone folder")
        if section == "_other":
            return posixpath.join("_other", folder, filename)
        if section == "combos" and mode != "loose":
            return posixpath.join("combos", folder, filename)
        if section in ("combos", "loose") and mode == "loose":
            return posixpath.join(folder, filename)
        raise ValueError("invalid tombstone section")

    def _validated_tombstone_rels(
        self, snap, asset_id, tomb, item_cache=None
    ):
        """Prove a tombstone describes exactly the requested gallery asset."""
        if not isinstance(tomb, dict) or tomb.get("id") != asset_id:
            raise ValueError("invalid tombstone id")
        copy_token = _copy_token(asset_id)
        if copy_token:
            filename, section, folder = tomb.get("file"), tomb.get("section"), tomb.get("folder")
            if (tomb.get("scope") != "copy" or tomb.get("token") != copy_token
                or section not in ("combos", "_other") or not isinstance(folder, str)
                or not is_safe_name(folder) or not isinstance(filename, str)
                or not _media_filename(filename) or tomb.get("assetId") != os.path.splitext(filename)[0]
                or not isinstance(tomb.get("hash"), str) or not re.fullmatch(r"[0-9a-f]{64}", tomb["hash"])):
                raise ValueError("invalid copy record")
            origin_rel = self._expected_trash_origin_rel(snap["mode"], section, folder, filename)
            body_rel = posixpath.join(TRASH_DIR, "copies", copy_token, filename)
            if tomb.get("from") != origin_rel or tomb.get("to") != body_rel:
                raise ValueError("invalid copy path")
            _dedup_entry(snap["root_real"], *origin_rel.split("/"))
            _dedup_entry(snap["root_real"], *body_rel.split("/"))
            return origin_rel, body_rel
        section = tomb.get("section")
        folder = tomb.get("folder")
        filename = tomb.get("file")
        if not isinstance(section, str) or not isinstance(folder, str):
            raise ValueError("invalid tombstone path")
        if not isinstance(filename, str) or os.path.splitext(filename)[0] != asset_id:
            raise ValueError("invalid tombstone asset")
        origin_rel = self._expected_trash_origin_rel(
            snap["mode"], section, folder, filename
        )
        cache_key = (section, folder)
        if item_cache is not None and cache_key in item_cache:
            card_present, items, directory = item_cache[cache_key]
        else:
            try:
                directory = section_folder_dir(
                    snap["root"], snap["mode"], section, folder
                )
                card_path = os.path.join(directory, "card.json")
                card_present = os.path.lexists(card_path)
                if card_present:
                    self._require_regular_entry(card_path)
                    card = read_json(card_path)
                    if not isinstance(card, dict):
                        raise ValueError("invalid card.json")
                else:
                    card = None
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                raise ValueError("invalid tombstone card: %s" % exc)
            items = items_from_card(card, card.get("folder") or folder) if card_present else []
            if item_cache is not None:
                item_cache[cache_key] = (card_present, items, directory)
        item = item_by_id(items, asset_id)
        if card_present:
            if item is None or item.get("file") != filename:
                raise ValueError("invalid tombstone asset")
        elif snap["mode"] != "loose" or os.path.splitext(filename)[0] != asset_id:
            raise ValueError("invalid tombstone asset")
        elif not tomb.get("token"):
            # Legacy card-less tombstones have no random binding. Require the
            # exact old marker unless this is already a completed cleanup/purge.
            marker = os.path.join(directory, filename + ".trashed")
            allow_missing = tombstone_phase(tomb) in ("restoring", "purging", "purged") and (
                tombstone_body_state(snap["root_real"], tomb) is False
            )
            if os.path.lexists(marker):
                legacy = self._read_controlled_marker(marker)
                if legacy.get("id") != asset_id or legacy.get("file") != filename:
                    raise ValueError("invalid trash marker")
            elif not allow_missing:
                raise ValueError("missing trash marker")
        trash_rel = trash_media_rel(
            section, folder if section != "_root" else "", filename
        )
        if tomb.get("from") != origin_rel or tomb.get("to") != trash_rel:
            raise ValueError("invalid tombstone path")
        return origin_rel, trash_rel

    def _trash_paths(self, snap, asset_id, tomb, item_cache=None):
        """Validated lexical (origin, trash body) pair for one tombstone."""
        root_real = snap["root_real"]
        origin_rel, trash_rel = self._validated_tombstone_rels(
            snap, asset_id, tomb, item_cache=item_cache
        )
        trash_file = self._lexical_entry_under(root_real, trash_rel)
        origin = self._lexical_entry_under(root_real, origin_rel)
        trash_root = os.path.realpath(os.path.join(root_real, TRASH_DIR))
        trash_parent = os.path.dirname(trash_file)
        if trash_parent != trash_root and not trash_parent.startswith(trash_root + os.sep):
            raise ValueError("escaped")
        origin_parent = os.path.dirname(origin)
        if origin_parent == trash_root or origin_parent.startswith(trash_root + os.sep):
            raise ValueError("escaped")
        return origin, trash_file

    def _tombstone_entry(self, snap, asset_id):
        token = _copy_token(asset_id)
        if token:
            return _dedup_entry(snap["root_real"], TRASH_DIR, "copies", token, "record.json")
        rel = posixpath.join(TRASH_DIR, "by-id", asset_id + ".json")
        return self._lexical_entry_under(snap["root_real"], rel)

    def _load_controlled_tombstone(self, snap, asset_id, item_cache=None, skip_absent_body=False):
        path = self._tombstone_entry(snap, asset_id)
        if not os.path.lexists(path):
            return None
        self._require_regular_entry(path)
        data = read_json(path)
        if not isinstance(data, dict):
            raise ValueError("invalid tombstone")
        if skip_absent_body and self._readonly_trash_body_missing(snap, asset_id, data):
            return None
        origin_rel, _ = self._validated_tombstone_rels(
            snap, asset_id, data, item_cache=item_cache
        )
        phase = tombstone_phase(data)
        if phase not in (
            "trashing",
            "trashed",
            "restoring",
            "purging",
            "purged",
        ):
            raise ValueError("invalid tombstone phase")
        if "token" in data:
            token = data.get("token")
            if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
                raise ValueError("invalid tombstone token")
            if (
                not isinstance(data.get("size"), int)
                or isinstance(data.get("size"), bool)
                or not isinstance(data.get("mtimeNs"), int)
                or isinstance(data.get("mtimeNs"), bool)
            ):
                raise ValueError("invalid tombstone fingerprint")
            origin = self._lexical_entry_under(snap["root_real"], origin_rel)
            marker = self._trash_marker_path(snap, data, origin)
            body_state = tombstone_body_state(snap["root_real"], data)
            origin_state = tombstone_origin_state(snap["root_real"], data)
            marker_optional = (
                phase == "trashing" and body_state is False and origin_state is True
            ) or (
                phase == "restoring" and body_state is False and origin_state is True
            ) or (
                phase in ("purging", "purged") and body_state is False
            )
            if os.path.lexists(marker):
                if self._read_controlled_marker(marker) != self._marker_payload(data):
                    raise ValueError("trash marker binding mismatch")
            elif not marker_optional:
                raise ValueError("missing trash marker")
            if phase == "restoring" and body_state is False and origin_state is True:
                self._require_tomb_fingerprint(origin, data)
        return data

    def _write_controlled_tombstone(self, snap, tomb, phase):
        """Atomic WAL transition with read-back after uncertain SMB errors."""
        row = dict(tomb)
        row["phase"] = phase
        first_error = None
        try:
            if _copy_token(row.get("id")):
                self._validated_tombstone_rels(snap, row["id"], row)
                write_json_atomic(self._tombstone_entry(snap, row["id"]), row)
            else:
                write_tombstone(snap["root"], row)
        except OSError as exc:
            first_error = exc
        try:
            stored = self._load_controlled_tombstone(snap, row.get("id") or "")
        except (OSError, ValueError):
            if first_error is not None:
                raise first_error
            raise
        if stored != row:
            if first_error is not None:
                raise first_error
            raise OSError(errno.EIO, "tombstone write could not be verified")
        return stored

    def _validate_trash_marks(self, snap, asset_id, origin):
        token = _copy_token(asset_id)
        marker = (_dedup_entry(snap["root_real"], TRASH_DIR, "copies", token, "binding.json")
                  if token else origin + ".trashed")
        tomb_file = self._tombstone_entry(snap, asset_id)
        if os.path.lexists(marker):
            self._require_regular_entry(marker)
        self._require_regular_entry(tomb_file)
        return marker, tomb_file

    def _clear_trash_marks(self, snap, asset_id, origin):
        marker, tomb_file = self._validate_trash_marks(snap, asset_id, origin)
        self._remove_controlled_regular(marker)
        self._remove_controlled_regular(tomb_file, missing_ok=False)

    def trash_restore(self, payload):
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        root = snap["root"]
        ids = payload.get("ids") if isinstance(payload, dict) else None
        if not isinstance(ids, list) or not ids:
            return {"ok": False, "error": "请提供 ids。"}
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {"ok": False, "error": "expectedRoot must be absolute.", "status": 400}
        if not self.same_physical_root(expected_real, snap.get("root_real")):
            return self.library_changed_result(restored=[], conflicts=[], errors=[])
        try:
            with gallery_write_lease(root, owner="python-restore") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease) or not self.same_physical_root(
                        expected_real, snap.get("root_real")
                    ):
                        return self.library_changed_result(restored=[], conflicts=[], errors=[])
                    return self._trash_restore_locked(snap, root, ids)
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc, restored=[], conflicts=[], errors=[])

    def _trash_restore_locked(self, snap, root, ids):
        restored = []
        conflicts = []
        errors = []
        for raw_asset_id in ids:
            asset_id = str(raw_asset_id or "")
            if not is_safe_name(asset_id) and not _copy_token(asset_id):
                errors.append({"id": asset_id, "error": "bad id"})
                continue
            try:
                tomb = self._load_controlled_tombstone(snap, asset_id)
                if not tomb:
                    errors.append({"id": asset_id, "error": "not found"})
                    continue
                origin, trash_file = self._trash_paths(snap, asset_id, tomb)
                phase = tombstone_phase(tomb)
                if phase in ("purging", "purged"):
                    errors.append(
                        {
                            "id": asset_id,
                            "file": tomb.get("file") or "",
                            "error": "not_restorable",
                        }
                    )
                    continue
                if phase == "restoring" and not os.path.lexists(trash_file):
                    if not os.path.lexists(origin):
                        errors.append(
                            {
                                "id": asset_id,
                                "file": tomb.get("file") or "",
                                "error": "missing_body",
                            }
                        )
                        continue
                    self._require_regular_entry(origin)
                    marker = self._trash_marker_path(snap, tomb, origin)
                    try:
                        if os.path.lexists(marker):
                            self._remove_controlled_regular(marker)
                        self._remove_controlled_regular(
                            self._tombstone_entry(snap, asset_id), missing_ok=False
                        )
                    except (OSError, ValueError) as exc:
                        errors.append(
                            {
                                "id": asset_id,
                                "file": tomb.get("file") or "",
                                "error": "restore_cleanup_pending: %s" % exc,
                            }
                        )
                    restored.append(asset_id)
                    continue
                # No body left to put back. Reporting this as restored is how a
                # tombstone gets dropped for a file that is simply gone.
                if not os.path.lexists(trash_file):
                    errors.append({"id": asset_id, "file": tomb.get("file") or "", "error": "missing_body"})
                    continue
                body_stat = self._require_regular_entry(trash_file)
                if tomb.get("scope") == "copy":
                    self._require_tomb_fingerprint(trash_file, tomb)
                if os.path.lexists(origin):
                    # Any directory entry owns that name now: regular file,
                    # directory, dangling link or reparse point. Never replace
                    # it and never let shutil.move nest the body inside it.
                    conflicts.append(
                        {
                            "id": asset_id,
                            "file": tomb.get("file") or "",
                            "folder": tomb.get("folder") or "",
                            "error": "restore_conflict",
                        }
                    )
                    continue
                self._validate_trash_marks(snap, asset_id, origin)
                restoring = self._write_controlled_tombstone(
                    snap, tomb, "restoring"
                )
                marker = self._trash_marker_path(snap, tomb, origin)
                if self.snapshot_stale(snap):
                    with self.lock:
                        self._invalidate_lists()
                    return self.library_changed_result(restored=restored, conflicts=conflicts, errors=errors)
                os.makedirs(os.path.dirname(origin), exist_ok=True)
                self._move_regular_no_replace_verified(trash_file, origin, body_stat)
                if tomb.get("scope") == "copy":
                    self._require_tomb_fingerprint(origin, tomb)
                try:
                    if os.path.lexists(marker):
                        self._remove_controlled_regular(marker)
                    self._remove_controlled_regular(
                        self._tombstone_entry(snap, asset_id), missing_ok=False
                    )
                except (OSError, ValueError) as exc:
                    errors.append(
                        {
                            "id": asset_id,
                            "file": restoring.get("file") or "",
                            "error": "restore_cleanup_pending: %s" % exc,
                        }
                    )
                restored.append(asset_id)
            except (OSError, ValueError) as exc:
                errors.append({"id": asset_id, "error": str(exc)})
        with self.lock:
            self._invalidate_lists()
        out = {"ok": True, "restored": restored, "conflicts": conflicts, "errors": errors}
        if conflicts:
            out["error"] = "%d 项原位已有别的文件，没有覆盖。" % len(conflicts)
        return out

    def trash_purge(self, payload):
        snap = self.snapshot()
        if not snap.get("ok"):
            return snap
        root = snap["root"]
        ids = payload.get("ids") if isinstance(payload, dict) else None
        if not isinstance(ids, list) or not ids:
            return {"ok": False, "error": "请提供 ids。"}
        expected_real = self.expected_root_real(payload)
        if expected_real is None:
            return {"ok": False, "error": "expectedRoot must be absolute.", "status": 400}
        if not self.same_physical_root(expected_real, snap.get("root_real")):
            return self.library_changed_result(purged=[], errors=[])
        try:
            with gallery_write_lease(root, owner="python-purge") as lease:
                with self.root_gate:
                    if self.lease_snapshot_stale(snap, lease) or not self.same_physical_root(
                        expected_real, snap.get("root_real")
                    ):
                        return self.library_changed_result(purged=[], errors=[])
                    return self._trash_purge_locked(snap, root, ids)
        except GalleryLockError as exc:
            return gallery_lock_error_result(exc, purged=[], errors=[])

    def _trash_purge_locked(self, snap, root, ids):
        purged = []
        errors = []
        for raw_asset_id in ids:
            asset_id = str(raw_asset_id or "")
            if not is_safe_name(asset_id) and not _copy_token(asset_id):
                errors.append({"id": asset_id, "error": "bad id"})
                continue
            try:
                tomb = self._load_controlled_tombstone(snap, asset_id)
                if not tomb:
                    errors.append({"id": asset_id, "error": "not found"})
                    continue
                if tombstone_phase(tomb) == "purged":
                    purged.append(asset_id)
                    continue
                if self.snapshot_stale(snap):
                    with self.lock:
                        self._invalidate_lists()
                    return self.library_changed_result(purged=purged, errors=errors)
                origin, trash_file = self._trash_paths(snap, asset_id, tomb)
                marker = self._trash_marker_path(snap, tomb, origin)
                # Validate every entry before deleting any of them. A crafted
                # marker must not turn a failed purge into a half-purged asset.
                if os.path.lexists(trash_file):
                    self._require_regular_entry(trash_file)
                    if tomb.get("scope") == "copy":
                        self._require_tomb_fingerprint(trash_file, tomb)
                if os.path.lexists(marker):
                    self._require_regular_entry(marker)
                purging = self._write_controlled_tombstone(snap, tomb, "purging")
                self._remove_controlled_regular(trash_file)
                self._remove_controlled_regular(marker)
                # The by-id tombstone stays: the download script reads it to know
                # this asset was deliberately dropped and must not come back.
                self._write_controlled_tombstone(snap, purging, "purged")
                purged.append(asset_id)
            except (OSError, ValueError) as exc:
                errors.append({"id": asset_id, "error": str(exc)})
        with self.lock:
            self._invalidate_lists()
        return {"ok": True, "purged": purged, "errors": errors}

    def resolve_trash_file(self, asset_id):
        snap = self.snapshot()
        if not snap.get("ok"):
            raise ValueError("library not ready")
        if not is_safe_name(asset_id or "") and not _copy_token(asset_id):
            raise ValueError("bad id")
        tomb = self._load_controlled_tombstone(snap, asset_id)
        if not tomb:
            raise FileNotFoundError(asset_id)
        _, trash_file = self._trash_paths(snap, asset_id, tomb)
        if not os.path.lexists(trash_file):
            raise FileNotFoundError(asset_id)
        self._require_regular_entry(trash_file)
        return trash_file

    def reveal(self, payload):
        lib = self.library()
        if not lib.get("ok"):
            return {"ok": False, "error": lib.get("error") or "图库不可用。"}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "JSON 无效。"}
        section = payload.get("section") or ""
        folder = payload.get("folder") or ""
        filename = payload.get("file") or ""
        try:
            section = default_section_for_mode(lib["mode"], section)
            directory = section_folder_dir(lib["root"], lib["mode"], section, folder or "")
            if filename:
                target = jail_join(directory, os.path.basename(filename))
            else:
                target = directory
            root_real = os.path.realpath(lib["root"])
            real = os.path.realpath(target)
            if real != root_real and not real.startswith(root_real + os.sep):
                raise ValueError("escaped")
        except ValueError:
            return {"ok": False, "error": "路径无效。"}
        if not os.path.exists(target):
            return {"ok": False, "error": "路径不存在。", "path": target}
        opened = reveal_in_os(target)
        return {"ok": True, "path": target, "opened": opened}


def send_bytes(handler, status, body, content_type, extra_headers=None, head_only=False):
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if extra_headers:
        for key, value in extra_headers:
            handler.send_header(key, value)
    handler.end_headers()
    if not head_only and body:
        handler.wfile.write(body)


def send_json(handler, obj, status=200, head_only=False):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    send_bytes(handler, status, body, "application/json; charset=utf-8", head_only=head_only)


def send_result(handler, row, head_only=False):
    """A mutation may carry its own status: 409 for a library switch mid-request,
    503 for a sidecar we could not read. A flat 200 would let the page treat
    "nothing was written" as success."""
    if isinstance(row, dict) and row.get("status"):
        try:
            status = int(row["status"])
        except (TypeError, ValueError):
            status = 200
        body = {key: value for key, value in row.items() if key != "status"}
        send_json(handler, body, status=status, head_only=head_only)
        return
    send_json(handler, row, head_only=head_only)


def parse_range(header, size):
    if not header:
        return None
    match = re.match(r"bytes=(\d*)-(\d*)", header.strip())
    if not match:
        return None
    start_s, end_s = match.group(1), match.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        length = int(end_s)
        if length <= 0:
            return None
        start = max(size - length, 0)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    if start >= size or start < 0 or end < start:
        return False
    end = min(end, size - 1)
    return start, end


def send_file(handler, path, content_type, head_only=False, cache_control=None, extra_headers=None):
    try:
        fh = open(path, "rb")
        size = os.fstat(fh.fileno()).st_size
    except OSError:
        handler.send_error(404, "Not Found")
        return

    def extras():
        for key, value in extra_headers or ():
            handler.send_header(key, value)

    try:
        parsed = parse_range(handler.headers.get("Range"), size)
        if parsed is False:
            handler.send_response(416)
            handler.send_header("Content-Range", "bytes */%d" % size)
            handler.send_header("Accept-Ranges", "bytes")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if parsed:
            start, end = parsed
            length = end - start + 1
            handler.send_response(206)
            handler.send_header("Content-Type", content_type)
            handler.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            handler.send_header("Content-Length", str(length))
            handler.send_header("Accept-Ranges", "bytes")
            handler.send_header("Cache-Control", cache_control or STATIC_CACHE)
            extras()
            handler.end_headers()
            if head_only:
                return
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
            return
        handler.send_response(200)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(size))
        handler.send_header("Accept-Ranges", "bytes")
        handler.send_header("Cache-Control", cache_control or STATIC_CACHE)
        extras()
        handler.end_headers()
        if head_only:
            return
        while True:
            chunk = fh.read(64 * 1024)
            if not chunk:
                break
            handler.wfile.write(chunk)
    finally:
        fh.close()


def static_file(rel):
    rel = rel.lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    real_static = os.path.realpath(STATIC_DIR)
    path = os.path.realpath(os.path.join(STATIC_DIR, rel))
    if path != real_static and not path.startswith(real_static + os.sep):
        return None
    if not os.path.isfile(path):
        return None
    return path


def is_local_http_authority(value, port):
    raw = str(value or "").strip()
    if not raw:
        return False
    try:
        parsed = urlparse("//" + raw)
        host = (parsed.hostname or "").rstrip(".").lower()
        request_port = parsed.port
    except ValueError:
        return False
    if parsed.username or parsed.password or host not in LOCAL_HTTP_HOSTS:
        return False
    return request_port is None or request_port == int(port)


def is_same_local_origin(value, port):
    raw = str(value or "").strip()
    if not raw:
        return True
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").rstrip(".").lower()
        origin_port = parsed.port or (80 if parsed.scheme == "http" else 0)
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and not parsed.username
        and not parsed.password
        and host in LOCAL_HTTP_HOSTS
        and origin_port == int(port)
    )


class ViewerHandler(BaseHTTPRequestHandler):
    state = None
    desktop_auth = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("VIEWER_QUIET"):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        if self.desktop_auth is not None:
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "connect-src 'self'; img-src 'self' data: blob:; "
                "media-src 'self' blob:; font-src 'self'; object-src 'none'; "
                "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            )
        super().end_headers()

    def _request_port(self):
        return int(getattr(self.server, "server_port", self.server.server_address[1]))

    def _header_values(self, name):
        return list(self.headers.get_all(name) or ())

    def _desktop_host_ok(self):
        values = self._header_values("Host")
        expected = "%s:%d" % (BIND_HOST, self._request_port())
        return len(values) == 1 and values[0].strip() == expected

    def _desktop_cookie_token(self):
        values = self._header_values("Cookie")
        if len(values) != 1:
            return None
        expected_name = self.desktop_auth.cookie_name(self._request_port())
        matches = []
        for part in values[0].split(";"):
            name, separator, value = part.strip().partition("=")
            if separator and name == expected_name:
                matches.append(value)
        return matches[0] if len(matches) == 1 else None

    def _desktop_authenticated(self):
        headers = self._header_values("X-Viewer-Session")
        if headers:
            token = headers[0] if len(headers) == 1 else None
            return (
                token is not None
                and re.fullmatch(r"[0-9a-f]{64}", token) is not None
                and hmac.compare_digest(token, self.desktop_auth.session_token)
            )
        token = self._desktop_cookie_token()
        return (
            token is not None
            and re.fullmatch(r"[0-9a-f]{64}", token) is not None
            and hmac.compare_digest(token, self.desktop_auth.session_token)
        )

    def _desktop_json_content_type(self):
        values = self._header_values("Content-Type")
        if len(values) != 1:
            return False
        parts = [part.strip().lower() for part in values[0].split(";")]
        if not parts or parts[0] != "application/json":
            return False
        return all(part == "charset=utf-8" for part in parts[1:])

    def _allow_desktop_write(self, head_only=False):
        port = self._request_port()
        origin = self._header_values("Origin")
        expected_origin = "http://%s:%d" % (BIND_HOST, port)
        if len(origin) != 1 or origin[0].strip() != expected_origin:
            self.close_connection = True
            send_json(self, {"ok": False, "error": "拒绝跨来源修改。"}, status=403, head_only=head_only)
            return False
        fetch_site = self._header_values("Sec-Fetch-Site")
        if fetch_site and (len(fetch_site) != 1 or fetch_site[0].strip().lower() != "same-origin"):
            self.close_connection = True
            send_json(self, {"ok": False, "error": "拒绝跨来源修改。"}, status=403, head_only=head_only)
            return False
        if not self._desktop_json_content_type():
            self.close_connection = True
            send_json(self, {"ok": False, "error": "请求必须使用 JSON。"}, status=415, head_only=head_only)
            return False
        if self._header_values("Transfer-Encoding"):
            self.close_connection = True
            send_json(self, {"ok": False, "error": "不支持分块请求。"}, status=400, head_only=head_only)
            return False
        lengths = self._header_values("Content-Length")
        try:
            length = int(lengths[0]) if len(lengths) == 1 else -1
        except ValueError:
            length = -1
        if length < 0 or length > 1_000_000:
            self.close_connection = True
            send_json(self, {"ok": False, "error": "请求长度无效。"}, status=400, head_only=head_only)
            return False
        return True

    def _allow_request(self, write=False, head_only=False):
        port = self._request_port()
        if self.desktop_auth is not None:
            if not self._desktop_host_ok():
                self.close_connection = True
                send_json(self, {"ok": False, "error": "请求目标不是本机查看器。"}, status=421, head_only=head_only)
                return False
            path = unquote(urlparse(self.path).path)
            if path == "/api/identity":
                return True
            authenticated = self._desktop_authenticated()
            if not authenticated:
                self.close_connection = True
                send_json(self, {"ok": False, "error": "本机会话无效。"}, status=403, head_only=head_only)
                return False
            return not write or self._allow_desktop_write(head_only=head_only)
        if not is_local_http_authority(self.headers.get("Host"), port):
            self.close_connection = True
            send_json(self, {"ok": False, "error": "请求目标不是本机查看器。"}, status=421, head_only=head_only)
            return False
        if write:
            origin = self.headers.get("Origin")
            fetch_site = str(self.headers.get("Sec-Fetch-Site") or "").strip().lower()
            cross_site = fetch_site in ("cross-site", "same-site")
            if cross_site or not is_same_local_origin(origin, port):
                self.close_connection = True
                send_json(self, {"ok": False, "error": "拒绝跨来源修改。"}, status=403)
                return False
        return True

    def do_HEAD(self):
        if not self._allow_request(head_only=True):
            return
        self._dispatch(head_only=True)

    def do_GET(self):
        if not self._allow_request():
            return
        self._dispatch(head_only=False)

    def do_POST(self):
        if not self._allow_request(write=True):
            return
        self._write("POST")

    def do_PUT(self):
        if not self._allow_request(write=True):
            return
        self._write("PUT")

    def _read_json_body(self):
        length = self.headers.get("Content-Length")
        try:
            n = int(length) if length else 0
        except ValueError:
            n = 0
        if n < 0 or n > 1_000_000:
            send_json(self, {"ok": False, "error": "请求过大。"}, status=400)
            return None, True
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}, False
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            send_json(self, {"ok": False, "error": "JSON 无效。"}, status=400)
            return None, True
        if not isinstance(payload, dict):
            send_json(self, {"ok": False, "error": "JSON 无效。"}, status=400)
            return None, True
        return payload, False

    def _write(self, method):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if self.desktop_auth is None and method == "PUT" and path == "/api/download/bind":
            port = self._request_port()
            expected_authority = "%s:%d" % (BIND_HOST, port)
            expected_origin = "http://%s" % expected_authority
            host = str(self.headers.get("Host") or "").strip().lower()
            origin = str(self.headers.get("Origin") or "").strip().lower()
            if host != expected_authority or origin != expected_origin:
                self.close_connection = True
                send_json(
                    self, {"ok": False, "error": "下载绑定只允许本机同源调用。"}, status=403
                )
                return
        payload, failed = self._read_json_body()
        if failed:
            return
        if method == "POST" and path == "/api/root":
            self._set_root(payload.get("root") or payload.get("path") or "")
            return
        if method == "POST" and path == "/api/library/create":
            self._create_library(payload)
            return
        if method == "POST" and path == "/api/library/dedup":
            send_result(self, self.state.library_dedup(payload))
            return
        if method == "POST" and path == "/api/history/remove":
            send_result(self, drop_history_path(payload.get("path") if isinstance(payload, dict) else ""))
            return
        if method == "POST" and path == "/api/history/clear":
            send_result(self, clear_history())
            return
        if method == "PUT" and path == "/api/preferences":
            send_result(self, put_preferences(payload))
            return
        if method == "POST" and path == "/api/save-copy":
            send_result(self, self.state.save_copy(payload))
            return
        if method == "PUT" and path == "/api/volume":
            try:
                vol = save_volume(payload)
            except StoreError as exc:
                result = store_error_result(exc)
                send_json(self, result, status=result.get("status") or 503)
                return
            send_json(self, {"ok": True, "volume": vol})
            return
        if method == "PUT" and path == "/api/meta":
            send_result(self, self.state.put_meta(payload))
            return
        if method == "PUT" and path == "/api/download/bind":
            send_result(self, self.state.bind_download_account(payload))
            return
        if method == "PUT" and path == "/api/views":
            send_result(self, self.state.put_views(payload))
            return
        if method == "POST" and path == "/api/cover/prepare":
            self._prepare_cover(payload)
            return
        if method == "POST" and path == "/api/cards":
            send_result(
                self,
                self.state.cards(payload.get("section") or "", payload.get("folders")),
            )
            return
        if method == "POST" and path == "/api/duration":
            send_result(self, self.state.put_duration(payload))
            return
        if method == "PUT" and path == "/api/accel":
            try:
                state = set_accel_mode(payload.get("mode"), payload.get("backend"))
            except StoreError as exc:
                send_result(self, store_error_result(exc))
                return
            except ValueError:
                send_json(self, {"ok": False, "error": "模式无效。"}, status=400)
                return
            send_json(self, dict(state, ok=True))
            return
        if method == "POST" and path == "/api/trash":
            send_result(self, self.state.trash_add(payload))
            return
        if method == "POST" and path == "/api/trash/restore":
            send_result(self, self.state.trash_restore(payload))
            return
        if method == "POST" and path == "/api/trash/purge":
            send_result(self, self.state.trash_purge(payload))
            return
        if method == "POST" and path == "/api/reveal":
            send_json(self, self.state.reveal(payload))
            return
        self.send_error(404, "Not Found")

    def _dispatch(self, head_only):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                self._static("index.html", head_only)
                return
            if path.startswith("/static/"):
                rel = posixpath.normpath(path[len("/static/") :])
                if rel.startswith(".."):
                    self.send_error(403, "Forbidden")
                    return
                self._static(rel, head_only)
                return
            if path == "/api/identity":
                self._identity(head_only)
                return
            if path == "/api/preferences":
                try:
                    send_json(self, get_preferences(), head_only=head_only)
                except StoreError as exc:
                    send_result(self, store_error_result(exc))
                return
            if path == "/api/config":
                self._config(head_only, qs)
                return
            if path == "/api/environment":
                send_json(self, environment_status(), head_only=head_only)
                return
            if path == "/favicon.ico":
                self._favicon(head_only)
                return
            if path == "/api/library":
                send_json(self, self.state.library(), head_only=head_only)
                return
            if path == "/api/combo":
                section = (qs.get("section") or [""])[0]
                folder = (qs.get("folder") or [""])[0]
                send_json(self, self.state.combo(section, folder), head_only=head_only)
                return
            if path == "/api/flat":
                send_json(self, self.state.flat(), head_only=head_only)
                return
            if path == "/api/meta":
                send_json(self, self.state.get_meta(), head_only=head_only)
                return
            if path == "/api/views":
                send_json(self, self.state.get_views(), head_only=head_only)
                return
            if path == "/api/trash":
                send_json(self, self.state.trash_list(), head_only=head_only)
                return
            if path in ("/api/trash/file", "/resource/trash/file"):
                self._trash_file(qs, head_only)
                return
            if path in ("/api/cover", "/resource/cover"):
                self._cover(qs, head_only)
                return
            if path == "/api/accel":
                state = accel_state()
                send_json(self, dict(state, ok=True, queue=COVERS.stats()), head_only=head_only)
                return
            if path == "/api/browse":
                raw = (qs.get("path") or [""])[0]
                send_json(self, browse_dir(raw), head_only=head_only)
                return
            if path == "/api/root":
                if (qs.get("root") or qs.get("path")):
                    send_json(self, {"ok": False, "error": "请使用 POST /api/root 切换图库。"}, status=405, head_only=head_only)
                    return
                send_json(self, {"ok": True, "root": self.state.root, "library": self.state.library()}, head_only=head_only)
                return
            if path.startswith("/media/"):
                self._media(path, head_only)
                return
            self.send_error(404, "Not Found")
        except BrokenPipeError:
            return
        except Exception:
            try:
                send_json(self, {"ok": False, "error": "服务器内部错误。"}, status=500, head_only=head_only)
            except Exception:
                pass

    def _set_root(self, root, head_only=False):
        root = (root or "").strip()
        if not root:
            send_json(self, {"ok": False, "error": "请提供目录路径。"}, status=400, head_only=head_only)
            return
        lib = self.state.set_root(root, persist_if_ok=True)
        if not lib.get("ok") and lib.get("code") == "stale_root_request":
            send_result(self, lib, head_only=head_only)
            return
        send_json(self, {"ok": True, "root": lib.get("root") or root, "library": lib}, head_only=head_only)

    def _create_library(self, payload):
        root = str(payload.get("root") or payload.get("path") or "").strip()
        if not root:
            # Browser flow: the dir picker knows the parent, the user typed a
            # name; the join happens here so the client needs no os.sep logic.
            parent = str(payload.get("parent") or "").strip()
            name = str(payload.get("name") or "").strip().strip(".")
            if parent and name:
                if any(ch in name for ch in "/\\:*?\"<>|"):
                    send_json(self, {"ok": False, "error": "文件夹名不能包含 / \\ : * ? \" < > | 字符。"}, status=400)
                    return
                root = os.path.join(parent, name)
        try:
            path = create_library_skeleton(root)
        except GalleryLockError as exc:
            send_result(self, gallery_lock_error_result(exc))
            return
        except ValueError as exc:
            send_json(self, {"ok": False, "error": str(exc)}, status=400)
            return
        except OSError as exc:
            send_json(self, {"ok": False, "error": "无法创建目录：%s" % exc}, status=500)
            return
        lib = self.state.set_root(path, persist_if_ok=True)
        if not lib.get("ok") and lib.get("code") == "stale_root_request":
            send_result(self, lib)
            return
        send_json(self, {"ok": True, "created": True, "root": lib.get("root") or path, "library": lib})

    def _config(self, head_only, qs=None):
        qs = qs or {}
        minimal = (qs.get("minimal") or [""])[0].strip().lower() in ("1", "true", "yes")
        if minimal:
            # Startup / download identity must not touch history paths or ffmpeg.
            # A hung UNC isdir here would make Rust kill a healthy Python child.
            send_json(
                self,
                {
                    "app": "grok_imagine_viewer",
                    "staticDir": os.path.realpath(STATIC_DIR),
                    "configPath": os.path.realpath(config_path()),
                    "root": self.state.root or "",
                    "downloadBindOnly": download_bind_only_mode(),
                },
                head_only=head_only,
            )
            return
        root = self.state.root or ""
        exists = bool(root) and os.path.isdir(root)
        lib_ok = False
        if exists:
            lib_ok = bool(self.state.library().get("ok"))
        cfg = load_config()
        send_json(
            self,
            {
                "app": "grok_imagine_viewer",
                "staticDir": os.path.realpath(STATIC_DIR),
                "configPath": os.path.realpath(config_path()),
                "root": root,
                "lastRoot": str(cfg.get("root") or ""),
                "history": history_entries(),
                "defaultRoot": "",
                "exists": exists,
                "ok": lib_ok,
                "downloadBindOnly": download_bind_only_mode(),
                "accel": accel_state(),
                "volume": normalize_volume(cfg.get("volume")),
            },
            head_only=head_only,
        )

    def _identity(self, head_only):
        if self.desktop_auth is None:
            self.send_error(404, "Not Found")
            return
        if head_only:
            send_json(self, {"ok": False, "error": "请使用 GET。"}, status=405, head_only=True)
            return
        values = self._header_values("X-Viewer-Challenge")
        if len(values) != 1 or not re.fullmatch(r"[0-9a-f]{64}", values[0].strip()):
            send_json(self, {"ok": False, "error": "身份挑战无效。"}, status=400)
            return
        challenge = bytes.fromhex(values[0].strip())
        port = self._request_port()
        send_json(
            self,
            {
                "app": "grok_imagine_viewer",
                "protocolVersion": DESKTOP_AUTH_PROTOCOL,
                "instanceId": self.desktop_auth.instance_id,
                "pid": os.getpid(),
                "port": port,
                "serverPath": os.path.realpath(__file__),
                "staticDir": os.path.realpath(STATIC_DIR),
                "configPath": os.path.realpath(config_path()),
                "downloadBindOnly": download_bind_only_mode(),
                "challengeResponse": self.desktop_auth.challenge_response(challenge, port),
            },
        )

    def _static(self, rel, head_only):
        path = static_file(rel)
        if not path:
            self.send_error(404, "Not Found")
            return
        content_type = guess_mime(path, "text/plain")
        if path.endswith(".html"):
            content_type = "text/html; charset=utf-8"
        elif path.endswith(".js"):
            content_type = "text/javascript; charset=utf-8"
        elif path.endswith(".css"):
            content_type = "text/css; charset=utf-8"
        cache = SHELL_CACHE if path.endswith((".html", ".js", ".css")) else STATIC_CACHE
        send_file(self, path, content_type, head_only=head_only, cache_control=cache)

    def _favicon(self, head_only):
        path = icon_file()
        if not path:
            self.send_error(404, "Not Found")
            return
        send_file(self, path, "image/x-icon", head_only=head_only, cache_control=MEDIA_CACHE)

    def _prepare_cover(self, payload):
        section = str(payload.get("section") or "")
        folder = str(payload.get("folder") or "")
        asset_id = str(payload.get("id") or "")
        try:
            target = self.state.cover_target(section, folder, asset_id)
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        if target is None:
            send_json(self, {"ok": True, "queued": False})
            return
        root = target["root"]
        for item in target["candidates"]:
            try:
                file_path = self.state.resolve_media(
                    target["section"],
                    target["folder"],
                    item.get("file") or "",
                )
            except FileNotFoundError:
                continue
            except ValueError:
                self.send_error(403, "Forbidden")
                return
            if not is_video(item) and not payload.get("imageThumbnail"):
                send_json(self, {"ok": True, "queued": False})
                return
            candidate_id = item.get("id") or ""
            duration_queued = False
            if is_video(item) and not duration_lookup(root, [candidate_id]).get(candidate_id):
                duration_queued = DURATIONS.enqueue(root, file_path, candidate_id)
            cover_queued = False
            if not cover_cache_hit(root, candidate_id, src=file_path):
                cover_queued = COVERS.enqueue(root, file_path, candidate_id)
            send_json(
                self,
                {
                    "ok": True,
                    "queued": bool(cover_queued or duration_queued),
                    "coverQueued": bool(cover_queued),
                    "durationQueued": bool(duration_queued),
                },
            )
            return
        send_json(self, {"ok": True, "queued": False})

    def _cover(self, qs, head_only):
        """Always an image: videos serve the cached still, never mp4 bytes to <img>."""
        section = (qs.get("section") or [""])[0]
        folder = (qs.get("folder") or [""])[0]
        asset_id = (qs.get("id") or [""])[0]
        raw = (qs.get("as") or [""])[0] == "media"
        thumbnail = (qs.get("thumb") or [""])[0] == "1"
        try:
            target = self.state.cover_target(section, folder, asset_id)
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        if target is None:
            send_bytes(self, 204, b"", "image/jpeg", head_only=head_only)
            return
        root = target["root"]
        for item in target["candidates"]:
            try:
                file_path = self.state.resolve_media(
                    target["section"],
                    target["folder"],
                    item.get("file") or "",
                )
            except FileNotFoundError:
                continue
            except ValueError:
                self.send_error(403, "Forbidden")
                return
            if raw or (not is_video(item) and (not thumbnail or not accel_state().get("covers"))):
                send_file(self, file_path, guess_mime(file_path), head_only=head_only, cache_control=MEDIA_CACHE)
                return
            asset_id = item.get("id") or ""
            # A re-encoded clip keeps its asset id, so size + mtime is the only
            # thing that can say the cached frame is from an older file.
            still = cover_cache_hit(root, asset_id, src=file_path)
            seconds = duration_lookup(root, [asset_id]).get(asset_id) or 0
            extra = [("X-Cover-Duration", "%.3f" % seconds)] if seconds else None
            if still:
                send_file(
                    self,
                    still,
                    "image/jpeg",
                    head_only=head_only,
                    cache_control=MEDIA_CACHE,
                    extra_headers=extra,
                )
                return
            # GPT6PRO_IMAGE_FALLBACK: a decoder failure must not hide an image
            # that the browser can display. GET still never starts a write job.
            if not is_video(item) and COVERS.failed_recent(root, asset_id):
                send_file(self, file_path, guess_mime(file_path), head_only=head_only, cache_control=MEDIA_CACHE)
                return
            # GET and HEAD remain read-only. The authenticated prepare endpoint
            # owns background extraction and the tile keeps its placeholder.
            send_bytes(self, 204, b"", "image/jpeg", extra_headers=extra, head_only=head_only)
            return
        send_bytes(self, 204, b"", "image/jpeg", head_only=head_only)

    def _trash_file(self, qs, head_only):
        asset_id = (qs.get("id") or [""])[0]
        try:
            file_path = self.state.resolve_trash_file(asset_id)
        except FileNotFoundError:
            self.send_error(404, "Not Found")
            return
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        send_file(self, file_path, guess_mime(file_path), head_only=head_only, cache_control=MEDIA_CACHE)

    def _media(self, path, head_only):
        rest = path[len("/media/") :]
        parts = [p for p in rest.split("/") if p != ""]
        if not parts:
            self.send_error(404, "Not Found")
            return
        try:
            if parts[0] == "_root":
                if len(parts) != 2:
                    raise ValueError("bad media path")
                file_path = self.state.resolve_media("_root", "", parts[1])
            elif len(parts) == 3:
                file_path = self.state.resolve_media(parts[0], parts[1], parts[2])
            else:
                raise ValueError("bad media path")
        except FileNotFoundError:
            self.send_error(404, "Not Found")
            return
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        send_file(self, file_path, guess_mime(file_path), head_only=head_only, cache_control=MEDIA_CACHE)


def make_handler(state, desktop_auth=None):
    class BoundHandler(ViewerHandler):
        pass

    BoundHandler.state = state
    BoundHandler.desktop_auth = desktop_auth
    return BoundHandler


def _addr_in_use(exc):
    if getattr(exc, "errno", None) == errno.EADDRINUSE:
        return True
    if getattr(exc, "winerror", None) == 10048:
        return True
    return False


def _bind_denied(exc):
    if getattr(exc, "winerror", None) == 10013:
        return True
    if getattr(exc, "errno", None) in (errno.EACCES, 10013):
        return True
    return False


def candidate_ports(preferred):
    seen = []
    for port in (preferred,) + FALLBACK_PORTS:
        if isinstance(port, int) and 0 < port <= 65535 and port not in seen:
            seen.append(port)
    return seen


def same_static_dir(theirs):
    if not theirs:
        return False
    mine = os.path.normcase(os.path.realpath(STATIC_DIR))
    other = os.path.normcase(os.path.realpath(theirs))
    return bool(mine) and mine == other


def same_config_path(theirs):
    if not theirs:
        return False
    mine = os.path.normcase(os.path.realpath(config_path()))
    other = os.path.normcase(os.path.realpath(theirs))
    return bool(mine) and mine == other


def looks_like_our_server(port):
    try:
        req = Request("http://%s:%d/api/config" % (BIND_HOST, port))
        with urlopen(req, timeout=0.6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not (isinstance(data, dict) and data.get("app") == "grok_imagine_viewer"):
            return False
        return same_static_dir(data.get("staticDir")) and same_config_path(data.get("configPath"))
    except Exception:
        return False


def bind_http_server(handler, preferred, authenticated=False):
    last = None
    for port in candidate_ports(preferred):
        try:
            httpd = ViewerHTTPServer((BIND_HOST, port), handler)
            return httpd, int(httpd.server_address[1])
        except OSError as exc:
            last = exc
            if _addr_in_use(exc):
                if not authenticated and looks_like_our_server(port):
                    return None, port
                print("port %d in use, trying next" % port, flush=True)
                continue
            if _bind_denied(exc):
                print("port %d blocked by Windows (10013/excluded), trying next" % port, flush=True)
                continue
            raise
    if authenticated:
        httpd = ViewerHTTPServer((BIND_HOST, 0), handler)
        return httpd, int(httpd.server_address[1])
    if last is not None:
        raise last
    raise OSError("no port available")


def serve(root, port, open_browser=False, desktop_auth=None):
    # No implicit scan of last night's 14G library: the UI shows a picker first.
    initial = resolve_initial_root(root) if root else ""
    state = AppState(initial)
    if state.root and os.path.isdir(state.root) and detect_library(state.root).get("ok"):
        remember_root(state.root)
    handler = make_handler(state, desktop_auth=desktop_auth)
    httpd, bound = bind_http_server(handler, port, authenticated=desktop_auth is not None)
    url = "http://%s:%d" % (BIND_HOST, bound)
    if httpd is None:
        print("already running  %s" % url, flush=True)
        if open_browser:
            webbrowser.open(url)
        return
    print("grok_imagine_viewer  %s" % url, flush=True)
    print("root  %s" % (state.root or "(none)"), flush=True)
    if bound != port:
        print("requested port %d unavailable; using %d" % (port, bound), flush=True)
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        httpd.server_close()


def main(argv=None):
    global CONFIG_PATH_OVERRIDE

    parser = argparse.ArgumentParser(description="Local viewer for a Grok Imagine export library.")
    parser.add_argument("--root", default=None, help="Optional initial library root")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port (default 19706)")
    parser.add_argument("--config", default=None, help="Override the viewer config file path")
    parser.add_argument("--open", action="store_true", help="Open the browser after start")
    parser.add_argument("--desktop-auth-stdin", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.port <= 0 or args.port > 65535:
        print("invalid --port", file=sys.stderr)
        return 2
    CONFIG_PATH_OVERRIDE = (
        os.path.abspath(os.path.expanduser(args.config))
        if args.config
        else None
    )
    desktop_auth = None
    if args.desktop_auth_stdin:
        if not download_bind_only_mode():
            print("desktop authentication requires download bind mode", file=sys.stderr)
            return 2
        try:
            desktop_auth = DesktopAuth.read_bootstrap(sys.stdin.buffer)
        except ValueError:
            print("desktop authentication bootstrap is invalid", file=sys.stderr)
            return 2
    if desktop_auth is None:
        serve(args.root, args.port, open_browser=args.open)
    else:
        serve(args.root, args.port, open_browser=args.open, desktop_auth=desktop_auth)
    return 0


if __name__ == "__main__":
    sys.exit(main())
