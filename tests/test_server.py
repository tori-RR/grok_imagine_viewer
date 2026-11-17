#!/usr/bin/env python3
"""Generate temp fixtures and exercise library detection plus HTTP APIs."""

from __future__ import annotations

import errno
import hashlib
import hmac
import inspect
import json
import os
import queue
import shutil
import socket
import subprocess
import struct
import sys
import tempfile
import threading
import time
import unittest
import zlib
from http.server import ThreadingHTTPServer
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import server  # noqa: E402


# Valid-enough 1x1 JPEG (SOI / EOI). Content-Type is mapped by extension.
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000"
    "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a"
    "1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e"
    "333432ffc0000b080001000101011100ffc4001f00000105010101010101000000"
    "00000000000102030405060708090a0bffc400b510000201030302040305050404"
    "0000017d01020300041105122131410613516107227114328191a1082342b1c115"
    "52d1f02433627282090a161718191a25262728292a3435363738393a4344454647"
    "48494a535455565758595a636465666768696a737475767778797a838485868788"
    "898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5"
    "c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9"
    "faffda000c03010002110311003f007f00ffd9"
)

COMBO1_FILE = "a8b9823e-0811-4414-8064-b030dfc90e89.jpg"
COMBO2_PNG = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.png"
COMBO2_MP4 = "cccccccc-3333-4333-8333-cccccccccccc.mp4"
SINGLE_FILE = "dddddddd-4444-4444-8444-dddddddddddd.jpg"
_CURRENT_META_GUARD = object()


def write_tiny_jpeg(path):
    with open(path, "wb") as fh:
        fh.write(TINY_JPEG)


def write_tiny_png(path, rgb=(70, 74, 88)):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"\x00" + bytes(rgb)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def write_tiny_mp4(path):
    # Minimal ftyp + mdat so MIME / Range can be tested without an encoder.
    ftyp = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
    mdat = b"\x00\x00\x00\x10mdat" + b"\x00" * 8
    with open(path, "wb") as fh:
        fh.write(ftyp + mdat)


def _write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def combo1_card():
    return {
        "n": 1,
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "title": "深蹲",
        "created": "2026-05-21T17:12:17.237878Z",
        "folder": "0001_aaa11111",
        "source": "imagine_conversation",
        "count": 1,
        "items": [
            {
                "id": "a8b9823e-0811-4414-8064-b030dfc90e89",
                "mime": "image/jpeg",
                "kind": "t2i",
                "created": "2026-05-21T17:12:28.174Z",
                "size": len(TINY_JPEG),
                "file": COMBO1_FILE,
                "status": "linked",
                "prompt": "深蹲",
                "conversationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "rootConversationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            }
        ],
    }


def combo2_card():
    return {
        "n": 2,
        "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "title": "视频占位",
        "created": "2026-06-01T00:00:00Z",
        "folder": "0002_bbb22222",
        "source": "imagine_conversation",
        "count": 2,
        "items": [
            {
                "id": "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
                "mime": "image/png",
                "kind": "i2i",
                "created": "2026-06-01T00:00:01Z",
                "file": COMBO2_PNG,
                "status": "linked",
                "prompt": "一张图",
            },
            {
                "id": "cccccccc-3333-4333-8333-cccccccccccc",
                "mime": "video/mp4",
                "kind": "i2v",
                "created": "2026-06-01T00:00:02Z",
                "file": COMBO2_MP4,
                "status": "linked",
                "prompt": "一段视频",
            },
        ],
    }


def make_full_library(root):
    """Indexed library: two combos, jpeg + png/mp4."""
    c1 = os.path.join(root, "combos", "0001_aaa11111")
    c2 = os.path.join(root, "combos", "0002_bbb22222")
    os.makedirs(c1, exist_ok=True)
    os.makedirs(c2, exist_ok=True)
    write_tiny_jpeg(os.path.join(c1, COMBO1_FILE))
    write_tiny_png(os.path.join(c2, COMBO2_PNG))
    write_tiny_mp4(os.path.join(c2, COMBO2_MP4))
    _write_json(os.path.join(c1, "card.json"), combo1_card())
    _write_json(os.path.join(c2, "card.json"), combo2_card())
    _write_json(
        os.path.join(root, "_index.json"),
        {
            "summary": {
                "builtAt": "2026-08-19T12:06:38",
                "web_combos": 2,
                "other_groups": 0,
                "linked": 3,
                "missing": 0,
                "combo_files": 3,
                "other_files": 0,
                "empty_combos": 0,
            },
            "combos": [
                {
                    "n": 1,
                    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "folder": "0001_aaa11111",
                    "created": "2026-05-21T17:12:17.237878Z",
                    "title": "深蹲",
                    "count": 1,
                    "videos": 0,
                    "images": 1,
                    "missing": 0,
                },
                {
                    "n": 2,
                    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "folder": "0002_bbb22222",
                    "created": "2026-06-01T00:00:00Z",
                    "title": "视频占位",
                    "count": 2,
                    "videos": 1,
                    "images": 1,
                    "missing": 0,
                },
            ],
            "other": [],
        },
    )
    return root


def make_scan_library(root):
    """Same shape as a full library but without _index.json."""
    make_full_library(root)
    os.remove(os.path.join(root, "_index.json"))
    return root


def make_single_combo(root):
    """A folder that was copied out by itself: only card.json + media."""
    os.makedirs(root, exist_ok=True)
    write_tiny_jpeg(os.path.join(root, SINGLE_FILE))
    card = combo1_card()
    card["folder"] = os.path.basename(root)
    card["items"][0]["file"] = SINGLE_FILE
    _write_json(os.path.join(root, "card.json"), card)
    return root


def make_loose_library(root):
    """Parent of one or more combo folders (no combos/ prefix, no index)."""
    inner = os.path.join(root, "0001_aaa11111")
    os.makedirs(inner, exist_ok=True)
    write_tiny_jpeg(os.path.join(inner, COMBO1_FILE))
    _write_json(os.path.join(inner, "card.json"), combo1_card())
    return root


def http_get(url, headers=None):
    req = Request(url, headers=headers or {}, method="GET")
    try:
        with urlopen(req, timeout=8) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except HTTPError as exc:
        try:
            body = exc.read() if exc.fp else b""
            headers_map = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
            return exc.code, headers_map, body
        finally:
            exc.close()


def http_head(url, headers=None):
    req = Request(url, headers=headers or {}, method="HEAD")
    try:
        with urlopen(req, timeout=8) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except HTTPError as exc:
        try:
            headers_map = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
            return exc.code, headers_map, b""
        finally:
            exc.close()


def http_json(url, payload, method="POST", headers=None):
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urlopen(req, timeout=8) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            raw = exc.read() if exc.fp else b""
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                parsed = {"raw": raw.decode("utf-8", "replace")}
            return exc.code, parsed
        finally:
            exc.close()


def http_post_json(url, payload, headers=None):
    return http_json(url, payload, "POST", headers=headers)


def http_put_json(url, payload, headers=None):
    return http_json(url, payload, "PUT", headers=headers)


class DetectTests(unittest.TestCase):
    def test_index_mode(self):
        root = tempfile.mkdtemp(prefix="giv-index-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        lib = server.detect_library(root)
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["mode"], "index")
        self.assertEqual(len(lib["combos"]), 2)
        self.assertEqual(lib["combos"][0]["title"], "深蹲")
        lifted = server.detect_library(os.path.join(root, "combos"))
        self.assertTrue(lifted["ok"])
        self.assertEqual(lifted["mode"], "index")
        self.assertEqual(os.path.realpath(lifted["root"]), os.path.realpath(root))

    def test_scan_without_index(self):
        root = tempfile.mkdtemp(prefix="giv-scan-")
        self.addCleanup(shutil.rmtree, root, True)
        make_scan_library(root)
        lib = server.detect_library(root)
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["mode"], "combos")
        self.assertEqual(len(lib["combos"]), 2)
        titles = {c["title"] for c in lib["combos"]}
        self.assertIn("深蹲", titles)

    def test_single_folder(self):
        root = tempfile.mkdtemp(prefix="giv-single-")
        self.addCleanup(shutil.rmtree, root, True)
        make_single_combo(root)
        lib = server.detect_library(root)
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["mode"], "single")
        self.assertEqual(len(lib["combos"]), 1)
        self.assertEqual(lib["combos"][0]["title"], "深蹲")

    def test_loose_folders(self):
        root = tempfile.mkdtemp(prefix="giv-loose-")
        self.addCleanup(shutil.rmtree, root, True)
        make_loose_library(root)
        lib = server.detect_library(root)
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["mode"], "loose")
        self.assertEqual(len(lib["combos"]), 1)

    def test_index_keeps_leftover_orphan_groups(self):
        root = tempfile.mkdtemp(prefix="giv-leftover-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "_other", "0999_orphan")
        os.makedirs(leftover, exist_ok=True)
        write_tiny_jpeg(os.path.join(leftover, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg"))
        lib = server.detect_library(root)
        folders = {row.get("folder") for row in lib.get("other") or []}
        self.assertIn("0999_orphan", folders)

    def test_index_preserves_independent_same_id_leftovers_until_dedup(self):
        root = tempfile.mkdtemp(prefix="giv-dup-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "_other", "0998_dup")
        os.makedirs(leftover, exist_ok=True)
        write_tiny_jpeg(os.path.join(leftover, COMBO1_FILE))
        lib = server.detect_library(root)
        folders = {row.get("folder") for row in lib.get("other") or []}
        self.assertIn("0998_dup", folders)

    def test_live_card_includes_disk_file_absent_from_card(self):
        root = tempfile.mkdtemp(prefix="giv-orphan-file-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        extra_name = "dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg"
        write_tiny_jpeg(os.path.join(root, "combos", "0001_aaa11111", extra_name))
        live = server.live_card_stats(root, "index", "combos", "0001_aaa11111")
        files = {item.get("file") for item in (live or {}).get("items") or []}
        self.assertIn(COMBO1_FILE, files)
        self.assertIn(extra_name, files)

    def test_unrecognized(self):
        root = tempfile.mkdtemp(prefix="giv-empty-")
        self.addCleanup(shutil.rmtree, root, True)
        lib = server.detect_library(root)
        self.assertFalse(lib["ok"])
        self.assertEqual(lib["mode"], "unrecognized")
        self.assertIn("无法识别", lib["error"])

    def test_missing(self):
        lib = server.detect_library("/no/such/grok_imagine_library_dir")
        self.assertFalse(lib["ok"])
        self.assertEqual(lib["mode"], "missing")

    def test_shell_disk_checks_are_capped(self):
        """Opening a library must not turn a stale index into thousands of stats.
        The shell verifies at most SHELL_VERIFY_MAX suspicious rows; the rest keep
        their index numbers until /api/cards corrects them."""
        root = tempfile.mkdtemp(prefix="giv-budget-")
        self.addCleanup(shutil.rmtree, root, True)
        extra = 3
        total = server.SHELL_VERIFY_MAX + extra
        combos = []
        for i in range(1, total + 1):
            folder = "%04d_none" % i
            os.makedirs(os.path.join(root, "combos", folder), exist_ok=True)
            _write_json(
                os.path.join(root, "combos", folder, "card.json"),
                {
                    "n": i,
                    "id": "id-%04d" % i,
                    "folder": folder,
                    "title": "无文件 %d" % i,
                    "count": 1,
                    # the file was never downloaded
                    "items": [{"id": "a-%04d" % i, "file": "gone_%d.jpg" % i, "mime": "image/jpeg"}],
                },
            )
            combos.append({
                "n": i, "id": "id-%04d" % i, "folder": folder, "created": "2026-05-01T00:00:00Z",
                "title": "无文件 %d" % i, "count": 1, "videos": 0, "images": 1, "missing": 1,
            })
        _write_json(os.path.join(root, "_index.json"), {"summary": {}, "combos": combos, "other": []})

        calls = []
        original = server.live_card_stats
        server.live_card_stats = lambda *a, **k: (calls.append(1), original(*a, **k))[1]
        self.addCleanup(setattr, server, "live_card_stats", original)
        out = server.annotate_library(server.detect_library(root))

        self.assertEqual(len(calls), server.SHELL_VERIFY_MAX, msg="disk checks must stay capped")
        # Verified rows were empty, so they are gone; the unchecked tail survives.
        self.assertEqual(len(out["combos"]), extra)
        for row in out["combos"]:
            self.assertFalse(row["live"], msg="unchecked rows are flagged as not live")

    def test_set_root_latest_request_wins_after_a_slow_scan(self):
        first = tempfile.mkdtemp(prefix="giv-root-a-")
        second = tempfile.mkdtemp(prefix="giv-root-b-")
        self.addCleanup(shutil.rmtree, first, True)
        self.addCleanup(shutil.rmtree, second, True)
        make_full_library(first)
        make_full_library(second)
        state = server.AppState()
        started = threading.Event()
        release = threading.Event()
        original = server.detect_library

        def slow_detect(path):
            path = os.path.abspath(path)
            if os.path.normcase(path) == os.path.normcase(first):
                started.set()
                if not release.wait(3):
                    raise RuntimeError("stale set_root scan was not released")
            return original(path)

        results = {}

        def first_switch():
            results["first"] = state.set_root(first, persist_if_ok=False)

        def second_switch():
            self.assertTrue(started.wait(2), msg="first set_root never started its scan")
            results["second"] = state.set_root(second, persist_if_ok=False)
            release.set()

        with mock.patch.object(server, "detect_library", side_effect=slow_detect):
            workers = (
                threading.Thread(target=first_switch),
                threading.Thread(target=second_switch),
            )
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(4)
                self.assertFalse(worker.is_alive())

        self.assertEqual(state.root, os.path.abspath(second))
        self.assertTrue(results["second"].get("ok"), msg=results)
        self.assertEqual(results["first"].get("code"), "stale_root_request")
        self.assertEqual(results["first"].get("status"), 409)

    def test_created_sort_key_compares_instants(self):
        east = server.created_sort_key("2026-09-10T01:00:00+09:00")
        utc = server.created_sort_key("2026-09-09T23:00:00Z")
        self.assertLess(east, utc, "an offset must not be ignored")
        self.assertGreater(
            "2026-09-10T01:00:00+09:00",
            "2026-09-09T23:00:00Z",
            msg="the raw strings sort the other way, which is the bug",
        )

        self.assertEqual(
            server.created_sort_key("2026-09-09T23:00:00Z")[1],
            server.created_sort_key("2026-09-09T23:00:00.000Z")[1],
        )
        self.assertLess(
            server.created_sort_key("2026-09-09T23:00:00Z"),
            server.created_sort_key("2026-09-09T23:00:00.250Z"),
        )
        # Naive stamps are read as UTC so they stay comparable with offsets.
        self.assertEqual(
            server.created_sort_key("2026-09-09T23:00:00")[1],
            server.created_sort_key("2026-09-09T23:00:00Z")[1],
        )
        # Missing and unparseable dates keep the position the old raw-string
        # comparison gave them, so existing orderings do not shift.
        for unusable in ("", None, "   ", "not-a-date"):
            self.assertEqual(server.created_sort_key(unusable)[0], 0)
            self.assertLess(
                server.created_sort_key(unusable),
                server.created_sort_key("1970-01-01T00:00:00Z"),
            )

        rows = [
            {"id": "east", "created": "2026-09-10T01:00:00+09:00"},
            {"id": "utc", "created": "2026-09-09T23:00:00Z"},
            {"id": "none", "created": ""},
        ]
        rows.sort(key=lambda row: server.created_sort_key(row.get("created")))
        self.assertEqual([row["id"] for row in rows], ["none", "east", "utc"])

    def test_send_file_sizes_the_opened_handle(self):
        source = inspect.getsource(server.send_file)
        opened = source.find('open(path, "rb")')
        sized = source.find("os.fstat(fh.fileno())")
        self.assertGreaterEqual(opened, 0)
        self.assertGreater(sized, opened)


class CliTests(unittest.TestCase):
    def test_config_override_is_expanded_before_serve(self):
        original = server.CONFIG_PATH_OVERRIDE
        self.addCleanup(setattr, server, "CONFIG_PATH_OVERRIDE", original)
        requested = os.path.join("~", "giv-cli-test", "config.json")
        seen = []

        def fake_serve(root, port, open_browser=False):
            seen.append(server.CONFIG_PATH_OVERRIDE)

        with mock.patch.object(server, "serve", side_effect=fake_serve) as serve_mock:
            result = server.main(["--config", requested])

        expected = os.path.abspath(os.path.expanduser(requested))
        self.assertEqual(result, 0)
        self.assertEqual(seen, [expected])
        serve_mock.assert_called_once_with(
            None,
            server.DEFAULT_PORT,
            open_browser=False,
        )

    def test_missing_config_argument_restores_portable_default(self):
        original = server.CONFIG_PATH_OVERRIDE
        self.addCleanup(setattr, server, "CONFIG_PATH_OVERRIDE", original)
        server.CONFIG_PATH_OVERRIDE = os.path.join(tempfile.gettempdir(), "stale-config.json")
        seen = []

        with mock.patch.object(server, "serve", side_effect=lambda *args, **kwargs: seen.append(server.CONFIG_PATH_OVERRIDE)):
            result = server.main([])

        self.assertEqual(result, 0)
        self.assertEqual(seen, [None])


class GalleryLockTests(unittest.TestCase):
    def test_trash_fails_closed_with_423_while_gallery_is_locked(self):
        root = tempfile.mkdtemp(prefix="giv-os-lock-trash-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        state = server.AppState(root)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)

        with server.gallery_write_lease(root, owner="python-test-holder"):
            result = state.trash_add(
                {
                    "section": "combos",
                    "folder": folder,
                    "ids": [asset_id],
                    "expectedRoot": root,
                }
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "library_busy")
        self.assertEqual(result["status"], 423)
        self.assertTrue(os.path.isfile(origin))
        self.assertFalse(os.path.isdir(os.path.join(root, server.TRASH_DIR)))

    def test_independent_process_contends_and_release_is_recoverable(self):
        root = tempfile.mkdtemp(prefix="giv-os-lock-")
        self.addCleanup(shutil.rmtree, root, True)
        code = (
            "import sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import server\n"
            "with server.gallery_write_lease(sys.argv[2], owner='python-test-child'):\n"
            "    print('ready', flush=True)\n"
            "    sys.stdin.readline()\n"
        )
        child = subprocess.Popen(
            [sys.executable, "-B", "-c", code, ROOT, root],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def stop_child():
            if child.poll() is None:
                try:
                    child.communicate("\n", timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate(timeout=3)

        self.addCleanup(stop_child)
        self.assertEqual(child.stdout.readline().strip(), "ready")
        with self.assertRaises(server.LibraryBusy):
            with server.gallery_write_lease(root, owner="python-test-parent"):
                self.fail("a second process acquired the same gallery write lease")

        child.communicate("\n", timeout=3)
        with server.gallery_write_lease(root, owner="python-test-parent"):
            pass
        lock_path = os.path.join(root, server.GALLERY_LOCK_NAME)
        self.assertTrue(os.path.isfile(lock_path), msg="the stable lock inode is permanent")
        with open(lock_path, encoding="utf-8") as fh:
            diagnostic = json.load(fh)
        self.assertEqual(diagnostic["protocol"], 1)
        self.assertEqual(diagnostic["owner"], "python-test-parent")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["VIEWER_QUIET"] = "1"
        cls.cfg_dir = tempfile.mkdtemp(prefix="giv-cfg-")
        server.CONFIG_PATH_OVERRIDE = os.path.join(cls.cfg_dir, "config.json")
        cls.lib = tempfile.mkdtemp(prefix="giv-lib-")
        cls.single = tempfile.mkdtemp(prefix="giv-one-")
        cls.scan = tempfile.mkdtemp(prefix="giv-scanhttp-")
        make_full_library(cls.lib)
        make_single_combo(cls.single)
        make_scan_library(cls.scan)
        cls.state = server.AppState(cls.lib)
        handler = server.make_handler(cls.state)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.httpd.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                http_get(cls.base + "/")
                break
            except URLError:
                time.sleep(0.05)

    def tearDown(self):
        if getattr(self.state, "root", None) != self.lib:
            http_post_json(self.base + "/api/root", {"root": self.lib})

    def put_download_bind(self, root, user_id, include_origin=True, commit=None):
        headers = {"Host": "127.0.0.1:%d" % self.port}
        if include_origin:
            headers["Origin"] = self.base
        payload = {"expectedRoot": root, "grokUserId": user_id}
        if commit is not None:
            payload["commit"] = commit
        return http_put_json(
            self.base + "/api/download/bind",
            payload,
            headers=headers,
        )

    def post_trash(self, path, payload, expected_root=_CURRENT_META_GUARD):
        """Issue a root-bound trash mutation using the current root by default."""
        outgoing = dict(payload)
        if expected_root is _CURRENT_META_GUARD:
            expected_root = self.state.root
        if expected_root is not None:
            outgoing["expectedRoot"] = expected_root
        return http_post_json(self.base + path, outgoing)

    def put_meta(
        self,
        payload,
        *,
        expected_root=_CURRENT_META_GUARD,
        expected_revision=_CURRENT_META_GUARD,
        headers=None,
    ):
        """Issue a guarded meta write using the latest server snapshot by default."""
        status, _, body = http_get(self.base + "/api/meta")
        if status != 200:
            raise AssertionError("could not obtain the current meta guard: HTTP %s" % status)
        current = json.loads(body.decode("utf-8"))
        outgoing = dict(payload)
        if expected_root is _CURRENT_META_GUARD:
            expected_root = current["root"]
        if expected_revision is _CURRENT_META_GUARD:
            expected_revision = current["meta"]["revision"]
        outgoing["expectedRoot"] = expected_root
        outgoing["expectedRevision"] = expected_revision
        return http_put_json(self.base + "/api/meta", outgoing, headers=headers)

    def put_views(self, payload, *, expected_root=_CURRENT_META_GUARD, headers=None):
        """Issue a root-bound view preference write using the current root."""
        if expected_root is _CURRENT_META_GUARD:
            status, _, body = http_get(self.base + "/api/views")
            if status != 200:
                raise AssertionError("could not obtain the current views guard: HTTP %s" % status)
            expected_root = json.loads(body.decode("utf-8"))["root"]
        outgoing = dict(payload)
        outgoing["expectedRoot"] = expected_root
        return http_put_json(self.base + "/api/views", outgoing, headers=headers)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.CONFIG_PATH_OVERRIDE = None
        shutil.rmtree(cls.cfg_dir, True)
        shutil.rmtree(cls.lib, True)
        shutil.rmtree(cls.single, True)
        shutil.rmtree(cls.scan, True)

    def test_index_page(self):
        status, headers, body = http_get(self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("content-type", ""))
        self.assertIn("图库".encode("utf-8"), body)

    def test_config_reports_real_config_path(self):
        status, _, body = http_get(self.base + "/api/config")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["configPath"], os.path.realpath(server.CONFIG_PATH_OVERRIDE))

    def test_rejects_untrusted_host_and_cross_origin_writes(self):
        status, _, body = http_get(self.base + "/api/config", headers={"Host": "rebound.invalid:%d" % self.port})
        self.assertEqual(status, 421)
        data = json.loads(body.decode("utf-8"))
        self.assertFalse(data["ok"])

        status, payload = http_put_json(
            self.base + "/api/volume",
            {"level": 100, "muted": False},
            headers={"Origin": "https://rebound.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertFalse(payload["ok"])

        status, payload = http_put_json(self.base + "/api/volume", {"level": 100, "muted": False}, headers={"Origin": self.base})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_get_root_cannot_switch_library(self):
        before = os.path.realpath(self.state.root)
        url = self.base + "/api/root?root=" + quote(self.single, safe="")
        status, _, _ = http_get(url)
        self.assertEqual(status, 405)
        self.assertEqual(os.path.realpath(self.state.root), before)

    def test_library_lists_combos(self):
        status, headers, body = http_get(self.base + "/api/library")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["ok"])
        self.assertEqual(len(data["combos"]), 2)
        self.assertEqual(data["combos"][0]["folder"], "0001_aaa11111")

    def test_meta_default_schema_and_write_guards(self):
        root = tempfile.mkdtemp(prefix="giv-meta-guards-")
        other = tempfile.mkdtemp(prefix="giv-meta-other-")
        self.addCleanup(shutil.rmtree, root, True)
        self.addCleanup(shutil.rmtree, other, True)
        make_full_library(root)
        make_full_library(other)
        http_post_json(self.base + "/api/root", {"root": root})

        status, _, body = http_get(self.base + "/api/meta")
        self.assertEqual(status, 200)
        current = json.loads(body.decode("utf-8"))
        self.assertTrue(os.path.samefile(current["root"], root))
        self.assertEqual(current["meta"]["version"], 2)
        self.assertEqual(current["meta"]["revision"], 0)

        write = {"item": {"id": "a8b9823e-0811-4414-8064-b030dfc90e89", "fav": True}}
        status, payload = http_put_json(
            self.base + "/api/meta",
            {**write, "expectedRoot": current["root"]},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload.get("code"), "meta_revision_required")

        for invalid in (True, -1, 1.25, "0", 2**53):
            with self.subTest(expectedRevision=invalid):
                status, payload = http_put_json(
                    self.base + "/api/meta",
                    {**write, "expectedRoot": current["root"], "expectedRevision": invalid},
                )
                self.assertEqual(status, 400)
                self.assertEqual(payload.get("code"), "meta_revision_invalid")

        status, payload = http_put_json(
            self.base + "/api/meta",
            {**write, "expectedRevision": 0},
        )
        self.assertEqual(status, 400, msg="expectedRoot is mandatory")
        self.assertFalse(payload.get("ok"))
        status, payload = self.put_meta(write, expected_root="relative/gallery")
        self.assertEqual(status, 400, msg="expectedRoot must be absolute")
        self.assertFalse(payload.get("ok"))
        status, payload = self.put_meta(write, expected_root=os.path.realpath(other))
        self.assertEqual(status, 409, msg="a different absolute root is a stale snapshot")
        self.assertEqual(payload.get("code"), server.LIBRARY_CHANGED)
        self.assertFalse(os.path.exists(os.path.join(root, server.META_NAME)))

    def test_meta_cas_conflict_noop_and_revision_bumps_once(self):
        root = tempfile.mkdtemp(prefix="giv-meta-cas-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        patch = {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": "0001_aaa11111"}}

        status, payload = self.put_meta(patch)
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["revision"], 1)
        meta_file = os.path.join(root, server.META_NAME)
        with open(meta_file, encoding="utf-8") as fh:
            revision_one = fh.read()

        stale = {"item": {"id": asset_id, "fav": False, "section": "combos", "folder": "0001_aaa11111"}}
        status, payload = self.put_meta(stale, expected_revision=0)
        self.assertEqual(status, 409)
        self.assertEqual(payload.get("code"), "meta_conflict")
        self.assertEqual(payload.get("actualRevision"), 1)
        self.assertEqual(payload["meta"]["revision"], 1)
        self.assertTrue(payload["meta"]["items"][asset_id]["fav"])
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), revision_one, msg="a stale client must not rewrite meta")

        status, payload = self.put_meta(patch)
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["revision"], 1, msg="a semantic no-op does not consume a revision")
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), revision_one, msg="a semantic no-op does not rewrite the sidecar")

        status, payload = self.put_meta(stale)
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["revision"], 2)
        self.assertFalse(payload["meta"]["items"][asset_id]["fav"])

    def test_meta_v1_is_upgraded_in_memory_then_written_as_revision_one(self):
        root = tempfile.mkdtemp(prefix="giv-meta-v1-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        meta_file = os.path.join(root, server.META_NAME)
        legacy = {
            "version": 1,
            "tags": ["ACG", "legacy"],
            "items": {},
            "groups": {},
            "grokUserId": "",
        }
        _write_json(meta_file, legacy)
        with open(meta_file, encoding="utf-8") as fh:
            before = fh.read()
        http_post_json(self.base + "/api/root", {"root": root})

        status, _, body = http_get(self.base + "/api/meta")
        self.assertEqual(status, 200)
        meta = json.loads(body.decode("utf-8"))["meta"]
        self.assertEqual(meta["version"], 2)
        self.assertEqual(meta["revision"], 0)
        self.assertIn("legacy", meta["tags"])
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), before, msg="GET migration is memory-only")

        status, payload = self.put_meta({"addTag": "migrated"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["version"], 2)
        self.assertEqual(payload["meta"]["revision"], 1)
        with open(meta_file, encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["version"], 2)
        self.assertEqual(saved["revision"], 1)
        self.assertIn("legacy", saved["tags"])
        self.assertIn("migrated", saved["tags"])

    def test_meta_write_lease_is_permanent_and_contention_returns_423(self):
        root = tempfile.mkdtemp(prefix="giv-meta-lock-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        lock_path = os.path.join(root, server.META_LOCK_NAME)

        with server.meta_write_lease(root, owner="python-test-holder"):
            self.assertTrue(os.path.isfile(lock_path))
            status, payload = self.put_meta({"addTag": "blocked"})
            self.assertEqual(status, 423)
            self.assertFalse(payload.get("ok"))
        self.assertTrue(os.path.isfile(lock_path), msg="the stable meta lock inode is permanent")
        self.assertFalse(os.path.exists(os.path.join(root, server.META_NAME)))

    def test_jpeg_media_type(self):
        url = self.base + "/media/combos/0001_aaa11111/" + COMBO1_FILE
        status, headers, body = http_get(url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"))
        self.assertTrue(body.startswith(b"\xff\xd8"))
        self.assertTrue(body.endswith(b"\xff\xd9"))

    def test_png_and_mp4_mime_branches(self):
        png = self.base + "/media/combos/0002_bbb22222/" + COMBO2_PNG
        status, headers, body = http_get(png)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/png"))
        self.assertTrue(body.startswith(b"\x89PNG"))

        mp4 = self.base + "/media/combos/0002_bbb22222/" + COMBO2_MP4
        status, headers, body = http_get(mp4)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("video/mp4"))
        self.assertIn(b"ftyp", body[:32])

    def test_range_request(self):
        url = self.base + "/media/combos/0002_bbb22222/" + COMBO2_MP4
        status, headers, body = http_get(url, headers={"Range": "bytes=0-3"})
        self.assertEqual(status, 206)
        self.assertEqual(body, b"\x00\x00\x00\x18")
        self.assertIn("bytes 0-3/", headers.get("content-range", ""))
        self.assertEqual(headers.get("accept-ranges"), "bytes")

    def test_combo_and_cover(self):
        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["ok"])
        self.assertEqual(data["items"][0]["prompt"], "深蹲")
        self.assertEqual(data["items"][0]["kind"], "t2i")

        status, headers, body = http_get(self.base + "/api/cover?section=combos&folder=0001_aaa11111")
        self.assertIn(status, (200, 302))
        if status == 302:
            self.assertIn("/media/", headers.get("location", ""))
        else:
            self.assertTrue(headers.get("content-type", "").startswith("image/"))
            self.assertTrue(body.startswith(b"\xff\xd8"))
            self.assertIn("86400", headers.get("cache-control", ""))

    @mock.patch.object(server.COVERS, "enqueue", return_value=False)
    @mock.patch.object(server.DURATIONS, "enqueue", return_value=False)
    def test_cover_last_viewed_and_fallback(self, duration_enqueue, cover_enqueue):
        root = tempfile.mkdtemp(prefix="giv-cover-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        png_path = os.path.join(root, "combos", folder, COMBO2_PNG)
        mp4_path = os.path.join(root, "combos", folder, COMBO2_MP4)
        cover_url = self.base + "/resource/cover?section=combos&folder=" + folder

        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/png"))
        self.assertTrue(body.startswith(b"\x89PNG"))

        status, payload = self.put_meta(
            {
                "group": {
                    "key": "combos/" + folder,
                    "section": "combos",
                    "folder": folder,
                    "lastViewedId": video_id,
                }
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["groups"]["combos/" + folder]["lastViewedId"], video_id)

        with open(os.path.join(root, ".viewer-meta.json"), encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["groups"]["combos/" + folder]["lastViewedId"], video_id)

        status, payload = self.put_meta(
            {"group": {"key": "combos/" + folder, "section": "combos", "folder": folder, "fav": True}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["meta"]["groups"]["combos/" + folder]["lastViewedId"], video_id)
        self.assertTrue(payload["meta"]["groups"]["combos/" + folder]["fav"])

        # A video cover never streams mp4 to <img>: still missing -> empty 204.
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertNotIn("text/html", headers.get("content-type", ""))
        duration_enqueue.assert_not_called()
        cover_enqueue.assert_not_called()

        status, payload = http_post_json(
            self.base + "/api/cover/prepare",
            {"section": "combos", "folder": folder, "id": video_id},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        duration_enqueue.assert_called()
        cover_enqueue.assert_called()

        # Cached still present -> that jpeg is served for the same URL.
        cache_dir = os.path.join(root, ".viewer-cache", "covers")
        os.makedirs(cache_dir, exist_ok=True)
        write_tiny_jpeg(os.path.join(cache_dir, video_id + ".jpg"))
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"), headers.get("content-type"))
        self.assertTrue(body.startswith(b"\xff\xd8"))

        # The raw file stays reachable for hover playback.
        status, headers, body = http_get(cover_url + "&as=media")
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("video/mp4"), headers.get("content-type"))
        self.assertIn(b"ftyp", body[:32])

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=" + folder)
        combo = json.loads(body.decode("utf-8"))
        self.assertEqual(combo.get("lastViewedId"), video_id)
        self.assertEqual(combo.get("coverId"), video_id)
        self.assertEqual(combo.get("coverMedia"), "video")

        # /api/library only carries the cheap hint; exact cover comes from /api/cards.
        status, _, body = http_get(self.base + "/api/library")
        lib = json.loads(body.decode("utf-8"))
        row = next(c for c in lib["combos"] if c["folder"] == folder)
        self.assertEqual(row.get("lastViewedId"), video_id)
        self.assertFalse(row.get("live"))

        status, payload = http_post_json(self.base + "/api/cards", {"section": "combos", "folders": [folder]})
        self.assertEqual(status, 200)
        card = payload["cards"][0]
        self.assertEqual(card.get("coverId"), video_id)
        self.assertEqual(card.get("coverMedia"), "video")
        self.assertTrue(card.get("coverReady"))
        self.assertTrue(card.get("live"))

        os.remove(os.path.join(cache_dir, video_id + ".jpg"))

        os.remove(mp4_path)
        self.assertTrue(os.path.isfile(png_path))
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/png"))
        self.assertTrue(body.startswith(b"\x89PNG"))

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=" + folder)
        combo = json.loads(body.decode("utf-8"))
        self.assertEqual(combo.get("coverId"), "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb")
        self.assertEqual(combo.get("coverMedia"), "image")

    def test_outside_path_not_served(self):
        attempts = [
            "/media/combos/../../../../etc/passwd",
            "/media/_root/../../etc/passwd",
            "/media/combos/0001_aaa11111/../../../../etc/passwd",
            "/media/combos/0001_aaa11111/../../../etc/passwd",
            "/media/loose/etc/passwd",
            "/media/_root/passwd",
            "/media/.trash/by-id/x.json",
            "/api/trash/file?id=../etc/passwd",
        ]
        for path in attempts:
            status, _, body = http_get(self.base + path)
            self.assertIn(status, (400, 403, 404), msg=path)
            text = body.decode("utf-8", "replace")
            self.assertNotIn("root:x:", text)
            self.assertNotIn("root:x:0:0", text)
            self.assertFalse(body.startswith(b"root:"), msg=path)

    def test_browse_lists_dirs_not_file_bodies(self):
        status, _, body = http_get(self.base + "/api/browse?path=" + self.lib)
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        names = {d["name"] for d in data["dirs"]}
        self.assertIn("combos", names)
        self.assertNotIn("_index.json", names)
        self.assertNotIn(COMBO1_FILE, json.dumps(data))

        if os.path.isdir("/etc"):
            status, _, body = http_get(self.base + "/api/browse?path=/etc")
            self.assertEqual(status, 200)
            data = json.loads(body.decode("utf-8"))
            dumped = json.dumps(data)
            self.assertNotIn("root:x:0:0", dumped)
            names = {d["name"] for d in data["dirs"]}
            self.assertNotIn("passwd", names)

    def test_switch_root_to_single_combo(self):
        status, payload = http_post_json(self.base + "/api/root", {"root": self.single})
        self.assertEqual(status, 200)
        lib = payload["library"]
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["mode"], "single")
        self.assertEqual(len(lib["combos"]), 1)

        status, _, body = http_get(self.base + "/api/library")
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["mode"], "single")
        self.assertEqual(len(data["combos"]), 1)

        status, headers, media = http_get(self.base + "/media/_root/" + SINGLE_FILE)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"))
        self.assertTrue(media.startswith(b"\xff\xd8"))

        with open(server.CONFIG_PATH_OVERRIDE, encoding="utf-8") as fh:
            cfg = json.loads(fh.read())
        self.assertEqual(os.path.realpath(cfg["root"]), os.path.realpath(self.single))

        # Restore indexed fixture so remaining tests stay on the full library.
        http_post_json(self.base + "/api/root", {"root": self.lib})

    def test_scan_root_without_index(self):
        status, payload = http_post_json(self.base + "/api/root", {"root": self.scan})
        self.assertEqual(status, 200)
        self.assertEqual(payload["library"]["mode"], "combos")
        self.assertEqual(len(payload["library"]["combos"]), 2)
        http_post_json(self.base + "/api/root", {"root": self.lib})

    def test_trash_restore_purge_and_wall(self):
        root = tempfile.mkdtemp(prefix="giv-trash-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        src = os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)
        self.assertTrue(os.path.isfile(src))

        status, payload = self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": "0001_aaa11111", "ids": [asset_id]},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload.get("ok"))
        self.assertFalse(os.path.isfile(src))
        dest = os.path.join(root, ".trash", "combos", "0001_aaa11111", COMBO1_FILE)
        self.assertTrue(os.path.isfile(dest), msg="deleted file should land in .trash")
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        self.assertTrue(os.path.isfile(tomb))
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", "card.json")))

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data.get("items"), [])
        self.assertEqual(data.get("card", {}).get("count"), 0)

        status, _, body = http_get(self.base + "/api/flat")
        flat = json.loads(body.decode("utf-8"))
        ids = {it.get("id") for it in flat.get("items") or []}
        self.assertNotIn(asset_id, ids)

        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(src))
        self.assertFalse(os.path.isfile(tomb))
        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(len(data.get("items") or []), 1)

        self.post_trash("/api/trash", {"section": "combos", "folder": "0001_aaa11111", "ids": [asset_id]})
        status, payload = self.post_trash("/api/trash/purge", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertFalse(os.path.isfile(dest))
        self.assertTrue(os.path.isfile(tomb), msg="purge keeps by-id tombstone")
        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data.get("items"), [])

    def test_favorite_item_inherits_without_persisting_group(self):
        root = tempfile.mkdtemp(prefix="giv-fav-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": "0001_aaa11111"}},
        )
        self.assertEqual(status, 200)
        meta = payload["meta"]
        self.assertTrue(meta["items"][asset_id]["fav"])
        self.assertFalse(meta["groups"].get("combos/0001_aaa11111", {}).get("fav"))
        _, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        self.assertEqual(json.loads(body)["card"]["fav"], meta["items"][asset_id]["fav"])

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": False, "section": "combos", "folder": "0001_aaa11111"}},
        )
        self.assertEqual(status, 200)
        meta = payload["meta"]
        self.assertFalse(meta["items"][asset_id]["fav"])
        self.assertFalse(meta["groups"].get("combos/0001_aaa11111", {}).get("fav"))
        _, _, body = http_get(self.base + "/api/combo?section=combos&folder=0001_aaa11111")
        self.assertEqual(json.loads(body)["card"]["fav"], meta["items"][asset_id]["fav"])

    def test_fav_dislike_item_mutex(self):
        root = tempfile.mkdtemp(prefix="giv-mutex-item-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        rec = payload["meta"]["items"][asset_id]
        self.assertTrue(rec["fav"])
        self.assertFalse(rec["dislike"])

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "dislike": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        rec = payload["meta"]["items"][asset_id]
        self.assertFalse(rec["fav"], msg="dislike must clear fav")
        self.assertTrue(rec["dislike"])

        status, _, body = http_get(self.base + "/api/meta")
        self.assertEqual(status, 200)
        rec = json.loads(body.decode("utf-8"))["meta"]["items"][asset_id]
        self.assertFalse(rec["fav"])
        self.assertTrue(rec["dislike"])

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        rec = payload["meta"]["items"][asset_id]
        self.assertTrue(rec["fav"])
        self.assertFalse(rec["dislike"], msg="fav must clear dislike")

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": False, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        rec = payload["meta"]["items"][asset_id]
        self.assertFalse(rec["fav"])
        self.assertFalse(rec["dislike"], msg="unfav must not add dislike")

        self.put_meta(
            {"item": {"id": asset_id, "dislike": True, "section": "combos", "folder": folder}},
        )
        status, payload = self.put_meta(
            {"item": {"id": asset_id, "dislike": False, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        rec = payload["meta"]["items"][asset_id]
        self.assertFalse(rec["fav"], msg="undislike must not add fav")
        self.assertFalse(rec["dislike"])

    def test_fav_dislike_group_mutex(self):
        root = tempfile.mkdtemp(prefix="giv-mutex-group-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        gkey = "combos/" + folder

        status, payload = self.put_meta(
            {"group": {"key": gkey, "dislike": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        grec = payload["meta"]["groups"][gkey]
        self.assertTrue(grec["dislike"])
        self.assertFalse(grec["fav"])

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        grec = payload["meta"]["groups"][gkey]
        self.assertFalse(grec["fav"], msg="child favorite must not become a permanent own favorite")
        self.assertTrue(grec["dislike"], msg="an explicit group dislike remains explicit")
        rec = payload["meta"]["items"][asset_id]
        self.assertTrue(rec["fav"])
        self.assertFalse(rec["dislike"])

        status, payload = self.put_meta(
            {"group": {"key": gkey, "dislike": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        grec = payload["meta"]["groups"][gkey]
        self.assertTrue(grec["dislike"])
        self.assertFalse(grec["fav"], msg="group dislike must clear group fav")

        status, payload = self.put_meta(
            {"group": {"key": gkey, "fav": True, "section": "combos", "folder": folder}},
        )
        self.assertEqual(status, 200)
        grec = payload["meta"]["groups"][gkey]
        self.assertTrue(grec["fav"])
        self.assertFalse(grec["dislike"])

        status, _, body = http_get(self.base + "/api/meta")
        self.assertEqual(status, 200)
        grec = json.loads(body.decode("utf-8"))["meta"]["groups"][gkey]
        self.assertTrue(grec["fav"])
        self.assertFalse(grec["dislike"])

    def test_new_api_path_escape(self):
        for path, body, method in (
            ("/api/trash", {"section": "../etc", "folder": "passwd", "ids": ["x"]}, "POST"),
            ("/api/reveal", {"section": "combos", "folder": "../..", "file": "passwd"}, "POST"),
            ("/api/meta", {"group": {"key": "../../etc/passwd", "fav": True}}, "PUT"),
        ):
            if path == "/api/meta":
                status, payload = self.put_meta(body)
            else:
                status, payload = http_json(self.base + path, body, method)
            self.assertIn(status, (200, 400, 403), msg=path)
            dumped = json.dumps(payload)
            self.assertNotIn("root:x:", dumped)

        status, _, body = http_get(self.base + "/api/trash/file?id=../../etc/passwd")
        self.assertIn(status, (400, 403, 404))
        self.assertNotIn(b"root:x:", body)

    def test_empty_combo_never_reaches_the_wall(self):
        root = tempfile.mkdtemp(prefix="giv-empty-combo-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        # A third combo whose card lists nothing at all.
        empty_dir = os.path.join(root, "combos", "0003_ccc33333")
        os.makedirs(empty_dir, exist_ok=True)
        _write_json(
            os.path.join(empty_dir, "card.json"),
            {"n": 3, "id": "cccc", "folder": "0003_ccc33333", "title": "空的", "count": 0, "items": []},
        )
        index_path = os.path.join(root, "_index.json")
        with open(index_path, encoding="utf-8") as fh:
            index = json.load(fh)
        index["combos"].append(
            {
                "n": 3,
                "id": "cccc",
                "folder": "0003_ccc33333",
                "created": "2026-06-02T00:00:00Z",
                "title": "空的",
                "count": 0,
                "videos": 0,
                "images": 0,
                "missing": 0,
            }
        )
        _write_json(index_path, index)
        http_post_json(self.base + "/api/root", {"root": root})

        status, _, body = http_get(self.base + "/api/library")
        self.assertEqual(status, 200)
        folders = [c["folder"] for c in json.loads(body.decode("utf-8"))["combos"]]
        self.assertNotIn("0003_ccc33333", folders, msg="count=0 combo must be hidden")
        self.assertEqual(folders, ["0001_aaa11111", "0002_bbb22222"])

        # Emptying a combo by deleting its only item hides it too.
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        status, payload = self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": "0001_aaa11111", "ids": [asset_id]},
        )
        self.assertTrue(payload.get("ok"))

        status, payload = http_post_json(
            self.base + "/api/cards", {"section": "combos", "folders": ["0001_aaa11111"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["cards"][0]["count"], 0)

        status, _, body = http_get(self.base + "/api/library")
        lib = json.loads(body.decode("utf-8"))
        folders = [c["folder"] for c in lib["combos"]]
        self.assertNotIn("0001_aaa11111", folders, msg="emptied combo must drop off the wall")
        self.assertTrue(lib.get("hasTrash"))

        # The media is still recoverable from the trash view.
        status, _, body = http_get(self.base + "/api/trash")
        trash = json.loads(body.decode("utf-8"))
        self.assertIn(asset_id, {row.get("id") for row in trash["items"]})

        self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        status, _, body = http_get(self.base + "/api/library")
        folders = [c["folder"] for c in json.loads(body.decode("utf-8"))["combos"]]
        self.assertIn("0001_aaa11111", folders, msg="restore brings the combo back")

    def test_card_that_outlived_its_media_counts_zero(self):
        """A card can list files that are no longer on disk (moved, half-downloaded,
        purged by hand). Those items are not viewable, so they must not inflate the
        count, keep an empty combo on the wall, or show up in the flat view."""
        root = tempfile.mkdtemp(prefix="giv-ghost-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        ghost_dir = os.path.join(root, "combos", "0003_ghost333")
        os.makedirs(ghost_dir, exist_ok=True)
        _write_json(
            os.path.join(ghost_dir, "card.json"),
            {
                "n": 3,
                "id": "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
                "folder": "0003_ghost333",
                "title": "只剩卡片",
                "count": 1,
                "items": [
                    {
                        "id": "ghost-asset-0001",
                        "mime": "image/jpeg",
                        "kind": "t2i",
                        "created": "2026-06-03T00:00:00Z",
                        "file": "gone.jpg",
                        "status": "missing",
                        "prompt": "已经不在了",
                    }
                ],
            },
        )
        index_path = os.path.join(root, "_index.json")
        with open(index_path, encoding="utf-8") as fh:
            index = json.load(fh)
        # The index still believes there is one image here.
        index["combos"].append(
            {
                "n": 3,
                "id": "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
                "folder": "0003_ghost333",
                "created": "2026-06-03T00:00:00Z",
                "title": "只剩卡片",
                "count": 1,
                "videos": 0,
                "images": 1,
                "missing": 1,
            }
        )
        _write_json(index_path, index)
        http_post_json(self.base + "/api/root", {"root": root})

        status, payload = http_post_json(
            self.base + "/api/cards", {"section": "combos", "folders": ["0003_ghost333"]}
        )
        self.assertEqual(status, 200)
        row = payload["cards"][0]
        self.assertEqual(row["count"], 0, msg="a card with no files on disk counts zero")
        self.assertEqual(row["images"], 0)
        self.assertEqual(row["coverId"], "", msg="nothing left to use as a cover")

        status, _, body = http_get(self.base + "/api/flat")
        files = {item.get("file") for item in json.loads(body.decode("utf-8"))["items"]}
        self.assertNotIn("gone.jpg", files, msg="flat view must not offer a missing file")

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0003_ghost333")
        combo = json.loads(body.decode("utf-8"))
        self.assertTrue(combo["ok"])
        self.assertEqual(combo["items"], [], msg="preview has nothing to show")

        # Asking for its cover is a no-content answer, not an ffmpeg job or a 500.
        status, headers, body = http_get(
            self.base + "/api/cover?section=combos&folder=0003_ghost333"
        )
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")

        # The live combos are untouched.
        status, _, body = http_get(self.base + "/api/library")
        folders = [c["folder"] for c in json.loads(body.decode("utf-8"))["combos"]]
        self.assertEqual(folders, ["0001_aaa11111", "0002_bbb22222"])

    def test_stale_index_does_not_hide_a_combo_whose_file_is_there(self):
        """The index is a snapshot: if it claims every file is missing but the media
        is actually on disk, the combo still belongs on the wall."""
        root = tempfile.mkdtemp(prefix="giv-staleindex-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        index_path = os.path.join(root, "_index.json")
        with open(index_path, encoding="utf-8") as fh:
            index = json.load(fh)
        for row in index["combos"]:
            if row["folder"] == "0001_aaa11111":
                row["missing"] = row["count"]  # stale: says nothing was downloaded
        _write_json(index_path, index)
        http_post_json(self.base + "/api/root", {"root": root})

        status, _, body = http_get(self.base + "/api/library")
        self.assertEqual(status, 200)
        combos = {c["folder"]: c for c in json.loads(body.decode("utf-8"))["combos"]}
        self.assertIn("0001_aaa11111", combos, msg="the file is there, so keep the combo")
        self.assertEqual(combos["0001_aaa11111"]["count"], 1)

    def test_missing_file_does_not_hide_its_live_siblings(self):
        """Only the dead item goes away; the rest of the card still shows up."""
        root = tempfile.mkdtemp(prefix="giv-halfghost-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        card_path = os.path.join(root, "combos", "0002_bbb22222", "card.json")
        card = combo2_card()
        card["items"].append(
            {
                "id": "dddddddd-4444-4444-8444-dddddddddddd",
                "mime": "image/jpeg",
                "kind": "t2i",
                "created": "2026-06-01T00:00:03Z",
                "file": "never_downloaded.jpg",
                "status": "missing",
                "prompt": "缺图",
            }
        )
        card["count"] = 3
        _write_json(card_path, card)
        http_post_json(self.base + "/api/root", {"root": root})

        status, payload = http_post_json(
            self.base + "/api/cards", {"section": "combos", "folders": ["0002_bbb22222"]}
        )
        self.assertEqual(status, 200)
        row = payload["cards"][0]
        self.assertEqual(row["count"], 2, msg="two files exist, three are listed")
        self.assertEqual(row["images"], 1)
        self.assertEqual(row["videos"], 1)

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=0002_bbb22222")
        files = [item.get("file") for item in json.loads(body.decode("utf-8"))["items"]]
        self.assertEqual(files, [COMBO2_PNG, COMBO2_MP4])

    def test_cards_reports_missing_folder(self):
        status, payload = http_post_json(
            self.base + "/api/cards", {"section": "combos", "folders": ["nope_not_here", "../etc"]}
        )
        self.assertEqual(status, 200)
        rows = payload["cards"]
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row.get("count"), 0)
            self.assertTrue(row.get("gone"))
        self.assertNotIn("root:x:", json.dumps(payload))

    def test_cover_cache_stays_inside_the_library(self):
        root = tempfile.mkdtemp(prefix="giv-cachejail-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        good = server.cover_cache_path(root, "cccccccc-3333-4333-8333-cccccccccccc")
        self.assertTrue(good.startswith(os.path.realpath(os.path.join(root, ".viewer-cache", "covers")) + os.sep))
        for bad in ("../../etc/passwd", "..", "/etc/passwd", "a/b", "", "..\\win", "\x00x"):
            with self.assertRaises(ValueError, msg=bad):
                server.cover_cache_path(root, bad)

        # A cache dir symlinked out of the library must be refused, not written through.
        escape = tempfile.mkdtemp(prefix="giv-escape-")
        self.addCleanup(shutil.rmtree, escape, True)
        link_root = tempfile.mkdtemp(prefix="giv-cachelink-")
        self.addCleanup(shutil.rmtree, link_root, True)
        os.makedirs(os.path.join(link_root, ".viewer-cache"), exist_ok=True)
        try:
            os.symlink(escape, os.path.join(link_root, ".viewer-cache", "covers"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(ValueError):
            server.cover_cache_path(link_root, "abc")

        http_post_json(self.base + "/api/root", {"root": root})
        for query in (
            "?section=combos&folder=0002_bbb22222&id=../../etc/passwd",
            "?section=../etc&folder=passwd",
            "?section=combos&folder=../..&id=x",
        ):
            status, _, body = http_get(self.base + "/api/cover" + query)
            self.assertIn(status, (200, 204, 403, 404), msg=query)
            self.assertNotIn(b"root:x:", body)

    def install_ffmpeg_stub(self, seconds="15.25"):
        """Fake ffmpeg (copies a jpeg to the output path) plus fake ffprobe (prints
        a duration), so cover extraction and probing are testable without an
        encoder. Returns the stub dir and both binaries."""
        stub_dir = tempfile.mkdtemp(prefix="giv-stub-")
        self.addCleanup(shutil.rmtree, stub_dir, True)
        frame = os.path.join(stub_dir, "frame.jpg")
        write_tiny_jpeg(frame)
        stub = os.path.join(stub_dir, "ffmpeg")
        with open(stub, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\n")
            # A duration probe is `-i <src>` with no output file; only a real
            # extraction may record argv or write over the destination.
            fh.write('case " $* " in *" -frames:v "*) ;; *) exit 1 ;; esac\n')
            fh.write('for arg in "$@"; do dest="$arg"; done\n')
            fh.write('printf %%s "$*" > "%s"\n' % os.path.join(stub_dir, "argv.txt"))
            fh.write('cp "%s" "$dest"\n' % frame)
        os.chmod(stub, 0o755)

        probe = os.path.join(stub_dir, "ffprobe")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\necho %s\n" % seconds)
        os.chmod(probe, 0o755)

        old_env = os.environ.get("VIEWER_FFMPEG")
        os.environ["VIEWER_FFMPEG"] = stub

        def restore():
            if old_env is None:
                os.environ.pop("VIEWER_FFMPEG", None)
            else:
                os.environ["VIEWER_FFMPEG"] = old_env
            server.accel_state(refresh=True)

        self.addCleanup(restore)
        return stub_dir, stub, probe

    def test_cover_extract_uses_ffmpeg_and_caches_in_library(self):
        if os.name == "nt":
            self.skipTest("shell stub is posix only")
        root = tempfile.mkdtemp(prefix="giv-ffmpeg-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        stub_dir, stub, probe = self.install_ffmpeg_stub()
        state = server.accel_state(refresh=True)
        self.assertEqual(state["ffmpeg"], stub)
        self.assertEqual(state["ffprobe"], probe, msg="ffprobe is found next to ffmpeg")
        self.assertTrue(state["covers"])
        self.assertEqual(state["coverDecode"], "cpu", msg="stills come off a software filter")

        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        src = os.path.join(root, "combos", "0002_bbb22222", COMBO2_MP4)
        made = server.extract_video_cover(root, src, video_id, state=state)
        self.assertEqual(made, server.cover_cache_path(root, video_id))
        self.assertTrue(os.path.isfile(made))
        leftovers = [
            name for name in os.listdir(os.path.dirname(made)) if ".tmp" in name
        ]
        self.assertEqual(leftovers, [], msg="tmp+rename must leave no tmp behind")
        with open(os.path.join(stub_dir, "argv.txt"), encoding="utf-8") as fh:
            argv = fh.read()
        self.assertIn("-frames:v", argv)
        vf = server.cover_extract_args("ffmpeg", src, made, "", 1.0)
        vf = vf[vf.index("-vf") + 1]
        self.assertEqual(vf, r"scale=min(480\,iw):-2")

        http_post_json(self.base + "/api/root", {"root": root})
        cover_url = self.base + "/api/cover?section=combos&folder=0002_bbb22222&id=" + video_id
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"))
        self.assertTrue(body.startswith(b"\xff\xd8"))

        # GET is read-only; an explicit authenticated POST starts extraction.
        os.remove(made)
        status, _, body = http_get(cover_url)
        self.assertEqual(status, 204)
        status, _ = http_post_json(self.base + "/api/cover/prepare", {"section": "combos", "folder": "0002_bbb22222", "id": video_id})
        self.assertEqual(status, 200)
        deadline = time.time() + 8
        while time.time() < deadline and not os.path.isfile(made):
            time.sleep(0.05)
        self.assertTrue(os.path.isfile(made), msg="background worker should write the still")
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"))

    def test_cover_degrades_without_ffmpeg(self):
        old_env = os.environ.get("VIEWER_FFMPEG")
        os.environ["VIEWER_FFMPEG"] = os.path.join(tempfile.gettempdir(), "no-such-ffmpeg-binary")

        def restore():
            if old_env is None:
                os.environ.pop("VIEWER_FFMPEG", None)
            else:
                os.environ["VIEWER_FFMPEG"] = old_env
            server.accel_state(refresh=True)

        self.addCleanup(restore)
        root = tempfile.mkdtemp(prefix="giv-noffmpeg-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        # PATH lookup may still find a real ffmpeg; force the miss.
        old_which = server.shutil.which
        server.shutil.which = lambda name, *a, **k: None if name == "ffmpeg" else old_which(name, *a, **k)
        self.addCleanup(setattr, server.shutil, "which", old_which)
        state = server.accel_state(refresh=True)
        self.assertFalse(state["covers"])
        self.assertEqual(state["effective"], "compat")
        self.assertIsNone(server.extract_video_cover(root, os.path.join(root, "x.mp4"), "abc", state=state))
        self.assertFalse(server.COVERS.enqueue(root, os.path.join(root, "x.mp4"), "abc"))

        http_post_json(self.base + "/api/root", {"root": root})
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        status, headers, body = http_get(
            self.base + "/api/cover?section=combos&folder=0002_bbb22222&id=" + video_id
        )
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertNotIn("text/html", headers.get("content-type", ""))

    def test_accel_mode_round_trip(self):
        status, _, body = http_get(self.base + "/api/accel")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertIn(data["mode"], ("auto", "compat"))
        self.assertIn(data["effective"], ("hardware", "compat"))

        status, payload = http_put_json(self.base + "/api/accel", {"mode": "compat"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["mode"], "compat")
        self.assertEqual(payload["effective"], "compat")
        self.assertEqual(payload["hwaccel"], "")

        status, payload = http_put_json(self.base + "/api/accel", {"mode": "hardware"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["mode"], "auto")

        status, payload = http_put_json(self.base + "/api/accel", {"mode": "turbo"})
        self.assertEqual(status, 400)
        self.assertFalse(payload.get("ok"))
        http_put_json(self.base + "/api/accel", {"mode": "auto"})

    def test_batch_trash_and_batch_tags(self):
        root = tempfile.mkdtemp(prefix="giv-batch-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        jpg_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        png_id = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

        status, payload = self.put_meta(
            {
                "addTag": "批量",
                "itemPatches": [
                    {"id": jpg_id, "section": "combos", "folder": "0001_aaa11111", "tags": ["批量"]},
                    {"id": png_id, "section": "combos", "folder": "0002_bbb22222", "tags": ["批量", "ACG"]},
                    {"id": "../bad", "tags": ["批量"]},
                ],
                "groupPatches": [
                    {"section": "combos", "folder": "0002_bbb22222", "tags": ["批量"]},
                    {"section": "combos", "folder": "../../etc", "tags": ["x"]},
                ],
            },
        )
        self.assertEqual(status, 200)
        meta = payload["meta"]
        self.assertIn("批量", meta["tags"])
        self.assertEqual(meta["items"][jpg_id]["tags"], ["批量"])
        self.assertEqual(meta["items"][png_id]["tags"], ["批量", "ACG"])
        self.assertEqual(meta["groups"]["combos/0002_bbb22222"]["tags"], ["批量"])
        self.assertNotIn("../bad", meta["items"])
        self.assertNotIn("combos/../../etc", meta["groups"])

        status, payload = self.post_trash(
            "/api/trash",
            {
                "groups": [
                    {"section": "combos", "folder": "0001_aaa11111", "ids": [jpg_id]},
                    {"section": "combos", "folder": "0002_bbb22222", "ids": [png_id]},
                    {"section": "../etc", "folder": "passwd", "ids": ["x"]},
                ]
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        moved = {row["id"] for row in payload["moved"]}
        self.assertEqual(moved, {jpg_id, png_id})
        self.assertFalse(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)))
        self.assertFalse(os.path.isfile(os.path.join(root, "combos", "0002_bbb22222", COMBO2_PNG)))
        self.assertTrue(os.path.isfile(os.path.join(root, ".trash", "by-id", jpg_id + ".json")))
        self.assertTrue(os.path.isfile(os.path.join(root, ".trash", "by-id", png_id + ".json")))

        status, _, body = http_get(self.base + "/api/library")
        folders = [c["folder"] for c in json.loads(body.decode("utf-8"))["combos"]]
        self.assertNotIn("0001_aaa11111", folders)
        self.assertIn("0002_bbb22222", folders, msg="combo keeps its remaining video")

    def test_config_history_and_views_tile(self):
        root = tempfile.mkdtemp(prefix="giv-hist-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        http_post_json(self.base + "/api/root", {"root": self.lib})
        http_post_json(self.base + "/api/root", {"root": root})

        status, _, body = http_get(self.base + "/api/config")
        cfg = json.loads(body.decode("utf-8"))
        paths = [row["path"] for row in cfg["history"]]
        self.assertEqual(paths[0], os.path.abspath(root), msg="most recent first")
        self.assertEqual(len(paths), len(set(paths)), msg="history is de-duplicated")
        self.assertIn(os.path.abspath(self.lib), paths)
        live = {row["path"]: row for row in cfg["history"]}
        self.assertTrue(live[os.path.abspath(root)]["exists"])
        self.assertIn("_index.json", live[os.path.abspath(root)]["markers"])

        gone = os.path.join(root, "nope-gone")
        os.makedirs(gone)
        http_post_json(self.base + "/api/root", {"root": root})
        with open(server.CONFIG_PATH_OVERRIDE, encoding="utf-8") as fh:
            saved = json.load(fh)
        saved["history"] = [gone] + saved.get("history", [])
        with open(server.CONFIG_PATH_OVERRIDE, "w", encoding="utf-8") as fh:
            json.dump(saved, fh)
        shutil.rmtree(gone, True)
        status, _, body = http_get(self.base + "/api/config")
        cfg = json.loads(body.decode("utf-8"))
        bad = next(row for row in cfg["history"] if row["path"] == os.path.abspath(gone))
        self.assertFalse(bad["exists"], msg="dead path stays listed but flagged")

        gone_abs = os.path.abspath(gone)
        keep_root = os.path.abspath(root)
        status, payload = http_post_json(self.base + "/api/history/remove", {"path": gone_abs})
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get("ok"), payload)
        self.assertNotIn(gone_abs, [row["path"] for row in payload["history"]])
        status, payload = http_post_json(self.base + "/api/history/clear", {})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload.get("history"), [])
        status, _, body = http_get(self.base + "/api/config")
        cfg = json.loads(body.decode("utf-8"))
        self.assertEqual(cfg["history"], [])
        self.assertEqual(cfg["root"], keep_root, msg="clearing history must not close the open library")
        self.assertTrue(os.path.isdir(root), msg="history edits must not delete library files")

        status, payload = self.put_views({"views": {"combos": {"density": "expanded", "tile": 5000}}})
        self.assertEqual(status, 200)
        self.assertEqual(payload["views"]["combos"]["tile"], 240)
        self.assertEqual(payload["views"]["combos"]["density"], "expanded")
        status, payload = self.put_views({"views": {"combos": {"tile": 128}}})
        self.assertEqual(payload["views"]["combos"]["tile"], 128)
        status, _, body = http_get(self.base + "/api/views")
        self.assertEqual(json.loads(body.decode("utf-8"))["views"]["combos"]["tile"], 128)

    def test_views_write_for_an_old_root_is_rejected_without_touching_new_root(self):
        old = tempfile.mkdtemp(prefix="giv-views-old-")
        new = tempfile.mkdtemp(prefix="giv-views-new-")
        self.addCleanup(shutil.rmtree, old, True)
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        http_post_json(self.base + "/api/root", {"root": old})
        status, _, body = http_get(self.base + "/api/views")
        self.assertEqual(status, 200)
        old_root = json.loads(body.decode("utf-8"))["root"]
        http_post_json(self.base + "/api/root", {"root": new})

        status, payload = self.put_views(
            {"views": {"combos": {"tile": 96}}},
            expected_root=old_root,
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload.get("code"), server.LIBRARY_CHANGED)
        self.assertFalse(os.path.exists(os.path.join(old, server.LIB_CONFIG_NAME)))
        self.assertFalse(os.path.exists(os.path.join(new, server.LIB_CONFIG_NAME)))

    def test_delete_after_a_root_switch_moves_nothing(self):
        """A1: a mutation carries the library it started in. If the user switches
        roots mid-request, the delete is refused rather than dragging files into
        whichever library happens to be open now."""
        old = tempfile.mkdtemp(prefix="giv-crossa-")
        self.addCleanup(shutil.rmtree, old, True)
        new = tempfile.mkdtemp(prefix="giv-crossb-")
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"

        state = server.AppState(old)
        snap = state.snapshot()
        self.assertTrue(snap["ok"])
        # The user picks a different library while the request is in flight.
        state.set_root(new, persist_if_ok=False)
        self.assertTrue(state.snapshot_stale(snap), msg="the snapshot must go stale")

        res = state._trash_add_one(snap, {"section": "combos", "folder": folder, "ids": [asset_id]})
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("code"), "library_changed")
        self.assertEqual(res.get("status"), 409)
        self.assertEqual(res.get("moved"), [])

        for root in (old, new):
            self.assertTrue(
                os.path.isfile(os.path.join(root, "combos", folder, COMBO1_FILE)),
                msg="the media stays where it was",
            )
            self.assertFalse(os.path.isdir(os.path.join(root, ".trash")), msg="no trash was created")

    def test_trash_mutations_require_the_request_root_and_reject_late_calls(self):
        old = tempfile.mkdtemp(prefix="giv-trash-root-old-")
        new = tempfile.mkdtemp(prefix="giv-trash-root-new-")
        self.addCleanup(shutil.rmtree, old, True)
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        add = {"section": "combos", "folder": folder, "ids": [asset_id]}
        http_post_json(self.base + "/api/root", {"root": old})

        for path, payload in (
            ("/api/trash", add),
            ("/api/trash/restore", {"ids": [asset_id]}),
            ("/api/trash/purge", {"ids": [asset_id]}),
        ):
            status, data = self.post_trash(path, payload, expected_root=None)
            self.assertEqual(status, 400, msg=path)
            self.assertFalse(data.get("ok"), msg=path)

        status, data = self.post_trash("/api/trash", add, expected_root=old)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        old_body = os.path.join(old, ".trash", "combos", folder, COMBO1_FILE)
        old_tomb = os.path.join(old, ".trash", "by-id", asset_id + ".json")
        with open(old_body, "rb") as fh:
            body_bytes = fh.read()
        with open(old_tomb, "rb") as fh:
            tomb_bytes = fh.read()

        http_post_json(self.base + "/api/root", {"root": new})
        for path, payload in (
            ("/api/trash", add),
            ("/api/trash/restore", {"ids": [asset_id]}),
            ("/api/trash/purge", {"ids": [asset_id]}),
        ):
            status, data = self.post_trash(path, payload, expected_root=old)
            self.assertEqual(status, 409, msg=path)
            self.assertEqual(data.get("code"), server.LIBRARY_CHANGED, msg=path)

        with open(old_body, "rb") as fh:
            self.assertEqual(fh.read(), body_bytes)
        with open(old_tomb, "rb") as fh:
            self.assertEqual(fh.read(), tomb_bytes)
        self.assertTrue(os.path.isfile(os.path.join(new, "combos", folder, COMBO1_FILE)))
        self.assertFalse(os.path.lexists(os.path.join(new, ".trash")))

    def test_root_switch_waits_for_trash_move_critical_section(self):
        old = tempfile.mkdtemp(prefix="giv-gate-old-")
        new = tempfile.mkdtemp(prefix="giv-gate-new-")
        self.addCleanup(shutil.rmtree, old, True)
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        state = server.AppState(old)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        entered = threading.Event()
        release = threading.Event()
        switched = threading.Event()
        results = {}
        original_move = state._move_regular_no_replace_verified

        def blocked_move(src, dest, expected_stat):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test did not release move")
            return original_move(src, dest, expected_stat)

        def do_trash():
            results["trash"] = state.trash_add(
                {
                    "section": "combos",
                    "folder": folder,
                    "ids": [asset_id],
                    "expectedRoot": old,
                }
            )

        def do_switch():
            state.set_root(new, persist_if_ok=False)
            switched.set()

        with mock.patch.object(
            state, "_move_regular_no_replace_verified", side_effect=blocked_move
        ):
            trash_thread = threading.Thread(target=do_trash)
            switch_thread = threading.Thread(target=do_switch)
            trash_thread.start()
            self.assertTrue(entered.wait(2), msg="trash reached its filesystem mutation")
            switch_thread.start()
            try:
                self.assertFalse(
                    switched.wait(0.1),
                    msg="set_root must wait while a root-bound file change is in flight",
                )
            finally:
                release.set()
                trash_thread.join(3)
                switch_thread.join(3)

        self.assertFalse(trash_thread.is_alive())
        self.assertFalse(switch_thread.is_alive())
        self.assertTrue(results["trash"].get("ok"))
        self.assertEqual([row["id"] for row in results["trash"].get("moved") or []], [asset_id])
        self.assertEqual(state.root, os.path.abspath(new))
        self.assertFalse(os.path.isfile(os.path.join(old, "combos", folder, COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(new, "combos", folder, COMBO1_FILE)))

    def test_trash_commit_failure_leaves_a_visible_restorable_wal_entry(self):
        root = tempfile.mkdtemp(prefix="giv-trash-wal-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        state = server.AppState(root)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        tomb_path = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        original_write = state._write_controlled_tombstone

        def fail_final_commit(snap, tomb, phase):
            if phase == "trashed":
                raise OSError(errno.EIO, "injected final tombstone failure")
            return original_write(snap, tomb, phase)

        with mock.patch.object(
            state, "_write_controlled_tombstone", side_effect=fail_final_commit
        ):
            result = state.trash_add(
                {
                    "section": "combos",
                    "folder": folder,
                    "ids": [asset_id],
                    "expectedRoot": root,
                }
            )

        self.assertTrue(result.get("ok"))
        self.assertEqual([row.get("id") for row in result.get("moved") or []], [asset_id])
        self.assertFalse(os.path.lexists(origin))
        self.assertTrue(os.path.isfile(body))
        with open(tomb_path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh).get("phase"), "trashing")
        self.assertEqual(
            {row.get("id") for row in state.trash_list().get("items") or []},
            {asset_id},
        )
        self.assertNotIn(asset_id, {row.get("id") for row in state.combo("combos", folder)["items"]})

        restored = state.trash_restore(
            {"ids": [asset_id], "expectedRoot": root}
        )
        self.assertEqual(restored.get("restored"), [asset_id])
        self.assertTrue(os.path.isfile(origin))
        self.assertFalse(os.path.lexists(body))
        self.assertFalse(os.path.lexists(tomb_path))

    def test_restore_cleanup_failure_is_live_and_converges_on_retry(self):
        root = tempfile.mkdtemp(prefix="giv-restore-wal-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        state = server.AppState(root)
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        tomb_path = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        trashed = state.trash_add(
            {
                "section": "combos",
                "folder": folder,
                "ids": [asset_id],
                "expectedRoot": root,
            }
        )
        self.assertEqual(
            [row.get("id") for row in trashed.get("moved") or []],
            [asset_id],
            msg=trashed,
        )
        original_remove = state._remove_controlled_regular

        def block_tomb_cleanup(path, missing_ok=True):
            if os.path.normcase(os.path.realpath(path)) == os.path.normcase(os.path.realpath(tomb_path)):
                raise OSError(errno.EIO, "injected tombstone cleanup failure")
            return original_remove(path, missing_ok=missing_ok)

        with mock.patch.object(
            state, "_remove_controlled_regular", side_effect=block_tomb_cleanup
        ):
            first = state.trash_restore(
                {"ids": [asset_id], "expectedRoot": root}
            )

        self.assertEqual(first.get("restored"), [asset_id])
        self.assertTrue(os.path.isfile(origin))
        self.assertFalse(os.path.lexists(body))
        with open(tomb_path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh).get("phase"), "restoring")
        self.assertIn(asset_id, {row.get("id") for row in state.combo("combos", folder)["items"]})
        self.assertEqual(state.trash_list().get("items"), [])

        second = state.trash_restore(
            {"ids": [asset_id], "expectedRoot": root}
        )
        self.assertEqual(second.get("restored"), [asset_id])
        self.assertFalse(os.path.lexists(tomb_path))
        self.assertTrue(os.path.isfile(origin))

    def test_fresh_state_recovers_a_cardless_loose_pending_tombstone(self):
        root = tempfile.mkdtemp(prefix="giv-loose-wal-")
        self.addCleanup(shutil.rmtree, root, True)
        make_loose_library(root)
        folder = "0001_aaa11111"
        state = server.AppState(root)
        self.assertEqual(state.library().get("mode"), "loose")
        asset_id = os.path.splitext(COMBO1_FILE)[0]
        origin = os.path.join(root, folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "loose", folder, COMBO1_FILE)
        tomb_path = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        original_write = state._write_controlled_tombstone

        def fail_final_commit(snap, tomb, phase):
            if phase == "trashed":
                raise OSError(errno.EIO, "injected final tombstone failure")
            return original_write(snap, tomb, phase)

        with mock.patch.object(
            state, "_write_controlled_tombstone", side_effect=fail_final_commit
        ):
            trashed = state.trash_add(
                {
                    "section": "loose",
                    "folder": folder,
                    "ids": [asset_id],
                    "expectedRoot": root,
                }
            )
        self.assertEqual(
            [row.get("id") for row in trashed.get("moved") or []],
            [asset_id],
            msg=trashed,
        )
        self.assertFalse(os.path.lexists(origin))
        self.assertTrue(os.path.isfile(body))
        with open(tomb_path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh).get("phase"), "trashing")

        os.remove(os.path.join(root, folder, "card.json"))
        fresh_state = server.AppState(root)
        self.assertEqual(
            fresh_state.library().get("mode"),
            "loose",
            msg="pending trash evidence must make a cardless loose root detectable",
        )
        restored = fresh_state.trash_restore(
            {"ids": [asset_id], "expectedRoot": root}
        )
        self.assertEqual(restored.get("restored"), [asset_id])
        self.assertTrue(os.path.isfile(origin))
        self.assertFalse(os.path.lexists(body))
        self.assertFalse(os.path.lexists(tomb_path))

    def test_coherently_redirected_tombstone_cannot_claim_same_stem_in_another_card(self):
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        other_id = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee"
        source_folder = "0001_aaa11111"
        redirect_folder = "0003_ccc33333"

        for operation, result_key in (("restore", "restored"), ("purge", "purged")):
            with self.subTest(operation=operation):
                root = tempfile.mkdtemp(prefix="giv-tomb-redirect-")
                self.addCleanup(shutil.rmtree, root, True)
                make_scan_library(root)
                redirect_dir = os.path.join(root, "combos", redirect_folder)
                os.makedirs(redirect_dir)
                redirect_card = combo1_card()
                redirect_card["folder"] = redirect_folder
                redirect_card["id"] = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
                redirect_card["items"][0]["id"] = other_id
                self.assertNotIn(
                    asset_id,
                    [item.get("id") for item in redirect_card.get("items") or []],
                )
                _write_json(os.path.join(redirect_dir, "card.json"), redirect_card)

                state = server.AppState(root)
                trashed = state.trash_add(
                    {
                        "section": "combos",
                        "folder": source_folder,
                        "ids": [asset_id],
                        "expectedRoot": root,
                    }
                )
                self.assertEqual(
                    [row.get("id") for row in trashed.get("moved") or []],
                    [asset_id],
                    msg=trashed,
                )
                original_body = os.path.join(
                    root, ".trash", "combos", source_folder, COMBO1_FILE
                )
                redirected_body = os.path.join(
                    root, ".trash", "combos", redirect_folder, COMBO1_FILE
                )
                os.makedirs(os.path.dirname(redirected_body), exist_ok=True)
                os.replace(original_body, redirected_body)
                tomb_path = os.path.join(
                    root, ".trash", "by-id", asset_id + ".json"
                )
                with open(tomb_path, encoding="utf-8") as fh:
                    tampered = json.load(fh)
                tampered.update(
                    {
                        "folder": redirect_folder,
                        "from": "combos/%s/%s" % (redirect_folder, COMBO1_FILE),
                        "to": ".trash/combos/%s/%s"
                        % (redirect_folder, COMBO1_FILE),
                    }
                )
                _write_json(tomb_path, tampered)
                redirected_marker = os.path.join(
                    redirect_dir, COMBO1_FILE + ".trashed"
                )
                _write_json(
                    redirected_marker, server.AppState._marker_payload(tampered)
                )
                with open(tomb_path, "rb") as fh:
                    tomb_bytes = fh.read()
                with open(redirected_body, "rb") as fh:
                    body_bytes = fh.read()
                with open(redirected_marker, "rb") as fh:
                    marker_bytes = fh.read()

                result = getattr(state, "trash_" + operation)(
                    {"ids": [asset_id], "expectedRoot": root}
                )

                self.assertEqual(result.get(result_key), [], msg=result)
                self.assertEqual(
                    [row.get("id") for row in result.get("errors") or []],
                    [asset_id],
                    msg=result,
                )
                with open(tomb_path, "rb") as fh:
                    self.assertEqual(fh.read(), tomb_bytes)
                with open(redirected_body, "rb") as fh:
                    self.assertEqual(fh.read(), body_bytes)
                with open(redirected_marker, "rb") as fh:
                    self.assertEqual(fh.read(), marker_bytes)
                self.assertFalse(
                    os.path.lexists(os.path.join(redirect_dir, COMBO1_FILE))
                )

    def test_multiple_control_files_cannot_redirect_restore_or_purge_to_another_asset(self):
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        victim_id = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
        source_folder = "0001_aaa11111"
        victim_folder = "0002_bbb22222"

        for operation, result_key in (("restore", "restored"), ("purge", "purged")):
            with self.subTest(operation=operation):
                root = tempfile.mkdtemp(prefix="giv-multi-control-")
                self.addCleanup(shutil.rmtree, root, True)
                make_full_library(root)
                state = server.AppState(root)
                for folder, selected_id in (
                    (victim_folder, victim_id),
                    (source_folder, asset_id),
                ):
                    trashed = state.trash_add(
                        {
                            "section": "combos",
                            "folder": folder,
                            "ids": [selected_id],
                            "expectedRoot": root,
                        }
                    )
                    self.assertEqual(
                        [row.get("id") for row in trashed.get("moved") or []],
                        [selected_id],
                        msg=trashed,
                    )

                source_body = os.path.join(
                    root, ".trash", "combos", source_folder, COMBO1_FILE
                )
                victim_body = os.path.join(
                    root, ".trash", "combos", victim_folder, COMBO2_PNG
                )
                source_marker = os.path.join(
                    root, "combos", source_folder, COMBO1_FILE + ".trashed"
                )
                victim_marker = os.path.join(
                    root, "combos", victim_folder, COMBO2_PNG + ".trashed"
                )
                source_tomb = os.path.join(
                    root, ".trash", "by-id", asset_id + ".json"
                )
                victim_tomb = os.path.join(
                    root, ".trash", "by-id", victim_id + ".json"
                )
                source_card = os.path.join(root, "combos", source_folder, "card.json")
                victim_card = os.path.join(root, "combos", victim_folder, "card.json")

                with open(source_tomb, encoding="utf-8") as fh:
                    forged = json.load(fh)
                victim_stat = os.lstat(victim_body)
                forged.update(
                    {
                        "file": COMBO2_PNG,
                        "folder": victim_folder,
                        "from": "combos/%s/%s" % (victim_folder, COMBO2_PNG),
                        "to": ".trash/combos/%s/%s"
                        % (victim_folder, COMBO2_PNG),
                        "size": victim_stat.st_size,
                        "mtimeNs": victim_stat.st_mtime_ns,
                        "token": "f" * 32,
                    }
                )
                _write_json(source_tomb, forged)
                _write_json(victim_marker, server.AppState._marker_payload(forged))
                with open(victim_card, encoding="utf-8") as fh:
                    card = json.load(fh)
                for item in card.get("items") or []:
                    if item.get("file") == COMBO2_PNG:
                        item["id"] = asset_id
                _write_json(victim_card, card)

                controlled = (
                    source_body,
                    victim_body,
                    source_marker,
                    victim_marker,
                    source_tomb,
                    victim_tomb,
                    source_card,
                    victim_card,
                )
                before = {}
                for path in controlled:
                    with open(path, "rb") as fh:
                        before[path] = fh.read()

                result = getattr(state, "trash_" + operation)(
                    {"ids": [asset_id], "expectedRoot": root}
                )

                self.assertEqual(result.get(result_key), [], msg=result)
                self.assertEqual(
                    [row.get("id") for row in result.get("errors") or []],
                    [asset_id],
                    msg=result,
                )
                for path, expected in before.items():
                    with open(path, "rb") as fh:
                        self.assertEqual(fh.read(), expected, msg=path)
                self.assertFalse(
                    os.path.lexists(
                        os.path.join(root, "combos", source_folder, COMBO1_FILE)
                    )
                )
                self.assertFalse(
                    os.path.lexists(
                        os.path.join(root, "combos", victim_folder, COMBO2_PNG)
                    )
                )

    def test_trash_add_rejects_card_id_filename_stem_mismatch_before_wal(self):
        root = tempfile.mkdtemp(prefix="giv-add-id-file-mismatch-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        folder = "0001_aaa11111"
        mismatched_id = "renamed-card-id"
        card_path = os.path.join(root, "combos", folder, "card.json")
        with open(card_path, encoding="utf-8") as fh:
            card = json.load(fh)
        card["items"][0]["id"] = mismatched_id
        _write_json(card_path, card)
        state = server.AppState(root)
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        marker = origin + ".trashed"
        tomb = os.path.join(root, ".trash", "by-id", mismatched_id + ".json")

        result = state.trash_add(
            {
                "section": "combos",
                "folder": folder,
                "ids": [mismatched_id],
                "expectedRoot": root,
            }
        )

        self.assertEqual(result.get("moved"), [], msg=result)
        self.assertEqual(
            [row.get("error") for row in result.get("errors") or []],
            ["id_file_mismatch"],
            msg=result,
        )
        self.assertTrue(os.path.isfile(origin))
        self.assertFalse(os.path.lexists(body))
        self.assertFalse(os.path.lexists(marker))
        self.assertFalse(os.path.lexists(tomb))

    def test_tampered_marker_token_cannot_restore_or_purge(self):
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"

        for operation, result_key in (("restore", "restored"), ("purge", "purged")):
            with self.subTest(operation=operation):
                root = tempfile.mkdtemp(prefix="giv-marker-token-")
                self.addCleanup(shutil.rmtree, root, True)
                make_full_library(root)
                state = server.AppState(root)
                trashed = state.trash_add(
                    {
                        "section": "combos",
                        "folder": folder,
                        "ids": [asset_id],
                        "expectedRoot": root,
                    }
                )
                self.assertEqual(
                    [row.get("id") for row in trashed.get("moved") or []],
                    [asset_id],
                    msg=trashed,
                )
                body = os.path.join(
                    root, ".trash", "combos", folder, COMBO1_FILE
                )
                tomb_path = os.path.join(
                    root, ".trash", "by-id", asset_id + ".json"
                )
                marker = os.path.join(
                    root, "combos", folder, COMBO1_FILE + ".trashed"
                )
                with open(tomb_path, encoding="utf-8") as fh:
                    tomb = json.load(fh)
                with open(marker, encoding="utf-8") as fh:
                    marker_data = json.load(fh)
                marker_data["token"] = (
                    "0" * 32 if tomb.get("token") != "0" * 32 else "1" * 32
                )
                _write_json(marker, marker_data)
                with open(tomb_path, "rb") as fh:
                    tomb_bytes = fh.read()
                with open(body, "rb") as fh:
                    body_bytes = fh.read()
                with open(marker, "rb") as fh:
                    marker_bytes = fh.read()

                result = getattr(state, "trash_" + operation)(
                    {"ids": [asset_id], "expectedRoot": root}
                )

                self.assertEqual(result.get(result_key), [], msg=result)
                self.assertEqual(
                    [row.get("id") for row in result.get("errors") or []],
                    [asset_id],
                    msg=result,
                )
                for path, expected in (
                    (tomb_path, tomb_bytes),
                    (body, body_bytes),
                    (marker, marker_bytes),
                ):
                    with open(path, "rb") as fh:
                        self.assertEqual(fh.read(), expected, msg=path)

    def test_non_object_card_blocks_restore_and_purge_without_partial_cleanup(self):
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"

        for operation, result_key in (("restore", "restored"), ("purge", "purged")):
            with self.subTest(operation=operation):
                root = tempfile.mkdtemp(prefix="giv-invalid-card-")
                self.addCleanup(shutil.rmtree, root, True)
                make_full_library(root)
                state = server.AppState(root)
                trashed = state.trash_add(
                    {
                        "section": "combos",
                        "folder": folder,
                        "ids": [asset_id],
                        "expectedRoot": root,
                    }
                )
                self.assertEqual(
                    [row.get("id") for row in trashed.get("moved") or []],
                    [asset_id],
                    msg=trashed,
                )
                card = os.path.join(root, "combos", folder, "card.json")
                body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
                marker = os.path.join(root, "combos", folder, COMBO1_FILE + ".trashed")
                tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
                _write_json(card, [])
                expected = {}
                for path in (tomb, body, marker):
                    with open(path, "rb") as fh:
                        expected[path] = fh.read()

                result = getattr(state, "trash_" + operation)(
                    {"ids": [asset_id], "expectedRoot": root}
                )

                self.assertEqual(result.get(result_key), [], msg=result)
                self.assertEqual(
                    [row.get("id") for row in result.get("errors") or []],
                    [asset_id],
                    msg=result,
                )
                for path, before in expected.items():
                    with open(path, "rb") as fh:
                        self.assertEqual(fh.read(), before, msg=path)

    def test_card_symlink_blocks_restore_and_purge_without_partial_cleanup(self):
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"

        for operation, result_key in (("restore", "restored"), ("purge", "purged")):
            with self.subTest(operation=operation):
                root = tempfile.mkdtemp(prefix="giv-card-link-")
                self.addCleanup(shutil.rmtree, root, True)
                make_full_library(root)
                state = server.AppState(root)
                trashed = state.trash_add(
                    {
                        "section": "combos",
                        "folder": folder,
                        "ids": [asset_id],
                        "expectedRoot": root,
                    }
                )
                self.assertEqual(
                    [row.get("id") for row in trashed.get("moved") or []],
                    [asset_id],
                    msg=trashed,
                )
                card = os.path.join(root, "combos", folder, "card.json")
                card_target = card + ".target"
                os.replace(card, card_target)
                try:
                    os.symlink(card_target, card)
                except (OSError, NotImplementedError) as exc:
                    self.skipTest("symlink creation unavailable: %s" % exc)
                body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
                marker = os.path.join(root, "combos", folder, COMBO1_FILE + ".trashed")
                tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
                expected = {}
                for path in (tomb, body, marker):
                    with open(path, "rb") as fh:
                        expected[path] = fh.read()

                result = getattr(state, "trash_" + operation)(
                    {"ids": [asset_id], "expectedRoot": root}
                )

                self.assertEqual(result.get(result_key), [], msg=result)
                self.assertEqual(
                    [row.get("id") for row in result.get("errors") or []],
                    [asset_id],
                    msg=result,
                )
                self.assertTrue(os.path.islink(card))
                for path, before in expected.items():
                    with open(path, "rb") as fh:
                        self.assertEqual(fh.read(), before, msg=path)

    def test_marker_write_unknown_outcome_uses_exact_readback(self):
        root = tempfile.mkdtemp(prefix="giv-marker-write-")
        self.addCleanup(shutil.rmtree, root, True)
        marker = os.path.join(root, COMBO1_FILE + ".trashed")
        tomb = {
            "id": os.path.splitext(COMBO1_FILE)[0],
            "file": COMBO1_FILE,
            "section": "loose",
            "folder": "0001_aaa11111",
            "from": "0001_aaa11111/" + COMBO1_FILE,
            "to": ".trash/loose/0001_aaa11111/" + COMBO1_FILE,
            "token": "1" * 32,
            "size": len(TINY_JPEG),
            "mtimeNs": 123456789,
        }
        expected = server.AppState._marker_payload(tomb)
        original_write = server.write_json_atomic

        def persist_then_raise(path, payload):
            original_write(path, payload)
            raise OSError(errno.EIO, "injected uncertain marker write")

        with mock.patch.object(
            server, "write_json_atomic", side_effect=persist_then_raise
        ):
            stored = server.AppState._write_controlled_marker(marker, tomb)
        self.assertEqual(stored, expected)
        with open(marker, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), expected)

        def persist_mismatch_then_raise(path, payload):
            original_write(path, {"unexpected": True})
            raise OSError(errno.EIO, "injected mismatched marker write")

        with mock.patch.object(
            server, "write_json_atomic", side_effect=persist_mismatch_then_raise
        ):
            with self.assertRaises(OSError):
                server.AppState._write_controlled_marker(marker, tomb)
        with open(marker, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {"unexpected": True})

    def test_marker_remove_unknown_outcome_uses_entry_readback(self):
        root = tempfile.mkdtemp(prefix="giv-marker-remove-")
        self.addCleanup(shutil.rmtree, root, True)
        marker = os.path.join(root, COMBO1_FILE + ".trashed")
        _write_json(marker, {"id": os.path.splitext(COMBO1_FILE)[0]})
        original_remove = server.os.remove

        def remove_then_raise(path):
            original_remove(path)
            raise OSError(errno.EIO, "injected uncertain marker remove")

        with mock.patch.object(server.os, "remove", side_effect=remove_then_raise):
            self.assertTrue(server.AppState._remove_controlled_regular(marker))
        self.assertFalse(os.path.lexists(marker))

        _write_json(marker, {"sentinel": "keep"})
        with open(marker, "rb") as fh:
            before = fh.read()
        with mock.patch.object(
            server.os,
            "remove",
            side_effect=OSError(errno.EIO, "injected failed marker remove"),
        ):
            with self.assertRaises(OSError):
                server.AppState._remove_controlled_regular(marker)
        with open(marker, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_tampered_tombstone_cannot_move_or_delete_another_control_file(self):
        root = tempfile.mkdtemp(prefix="giv-tomb-tamper-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        other_id = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
        folder = "0001_aaa11111"
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        marker = os.path.join(root, "combos", folder, COMBO1_FILE + ".trashed")
        tomb_path = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        other_tomb = os.path.join(root, ".trash", "by-id", other_id + ".json")
        _write_json(other_tomb, {"id": other_id, "sentinel": "keep"})
        with open(tomb_path, encoding="utf-8") as fh:
            tampered = json.load(fh)
        tampered["to"] = ".trash/by-id/" + other_id + ".json"
        _write_json(tomb_path, tampered)
        with open(tomb_path, "rb") as fh:
            tomb_bytes = fh.read()
        with open(other_tomb, "rb") as fh:
            other_bytes = fh.read()
        with open(body, "rb") as fh:
            body_bytes = fh.read()

        for path in ("/api/trash/restore", "/api/trash/purge"):
            status, data = self.post_trash(path, {"ids": [asset_id]})
            self.assertEqual(status, 200, msg=path)
            self.assertEqual([row.get("id") for row in data.get("errors") or []], [asset_id])
            with open(tomb_path, "rb") as fh:
                self.assertEqual(fh.read(), tomb_bytes, msg=path)
            with open(other_tomb, "rb") as fh:
                self.assertEqual(fh.read(), other_bytes, msg=path)
            with open(body, "rb") as fh:
                self.assertEqual(fh.read(), body_bytes, msg=path)
            self.assertTrue(os.path.isfile(marker), msg=path)

        status, _, _ = http_get(
            self.base + "/resource/trash/file?id=" + quote(asset_id)
        )
        self.assertEqual(status, 403)

    def test_restore_refuses_to_overwrite_a_different_file(self):
        """A2: something else owns that name now. Reporting a conflict is the only
        answer that cannot lose one of the two files."""
        root = tempfile.mkdtemp(prefix="giv-conflict-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")

        self.post_trash("/api/trash", {"section": "combos", "folder": folder, "ids": [asset_id]})
        self.assertTrue(os.path.isfile(body))
        self.assertFalse(os.path.isfile(origin))

        # A different picture takes the freed name.
        write_tiny_png(origin, rgb=(1, 2, 3))
        with open(origin, "rb") as fh:
            keep = fh.read()

        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [], msg="nothing may be reported restored")
        conflicts = payload.get("conflicts") or []
        self.assertEqual([row.get("id") for row in conflicts], [asset_id])
        self.assertEqual(conflicts[0].get("error"), "restore_conflict")
        with open(origin, "rb") as fh:
            self.assertEqual(fh.read(), keep, msg="the file in the way is untouched")
        self.assertTrue(os.path.isfile(body), msg="the trashed body is still recoverable")
        self.assertTrue(os.path.isfile(tomb), msg="the tombstone stays until it really goes back")

        # Even identical bytes do not authorize cleanup: an existing directory
        # entry owns the name, so restore must still refuse it.
        os.remove(origin)
        shutil.copy2(body, origin)
        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [])
        self.assertEqual([row.get("id") for row in payload.get("conflicts") or []], [asset_id])
        self.assertTrue(os.path.isfile(tomb), msg="an occupied name never drops its tombstone")

    def test_restore_conflicts_with_a_directory_and_never_nests(self):
        root = tempfile.mkdtemp(prefix="giv-restore-dir-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        os.mkdir(origin)

        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [])
        self.assertEqual([row.get("id") for row in payload.get("conflicts") or []], [asset_id])
        self.assertTrue(os.path.isdir(origin))
        self.assertFalse(
            os.path.lexists(os.path.join(origin, COMBO1_FILE)),
            msg="restore must not use directory-nesting move semantics",
        )
        self.assertTrue(os.path.isfile(body))

    def test_restore_conflicts_with_a_dangling_symlink(self):
        root = tempfile.mkdtemp(prefix="giv-restore-link-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        try:
            os.symlink(os.path.join(root, "missing-target"), origin)
        except (OSError, NotImplementedError) as exc:
            self.skipTest("symlink creation unavailable: %s" % exc)

        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [])
        self.assertEqual([row.get("id") for row in payload.get("conflicts") or []], [asset_id])
        self.assertTrue(os.path.lexists(origin), msg="the dangling link is untouched")
        self.assertTrue(os.path.isfile(body), msg="the trashed body is still recoverable")

    def test_restore_no_replace_survives_check_to_move_race(self):
        root = tempfile.mkdtemp(prefix="giv-restore-race-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        original_move = server.AppState._move_regular_no_replace
        raced = {}

        def occupy_then_move(src, dest, expected_stat):
            write_tiny_png(dest, rgb=(7, 8, 9))
            with open(dest, "rb") as fh:
                raced["bytes"] = fh.read()
            return original_move(src, dest, expected_stat)

        with mock.patch.object(
            server.AppState, "_move_regular_no_replace", side_effect=occupy_then_move
        ):
            status, payload = self.post_trash(
                "/api/trash/restore", {"ids": [asset_id]}
            )
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [])
        self.assertEqual([row.get("id") for row in payload.get("errors") or []], [asset_id])
        with open(origin, "rb") as fh:
            self.assertEqual(fh.read(), raced["bytes"], msg="racing destination is not overwritten")
        self.assertTrue(os.path.isfile(body))
        self.assertTrue(os.path.isfile(tomb))

    def test_uncertain_move_rejects_a_different_destination_fingerprint(self):
        root = tempfile.mkdtemp(prefix="giv-move-fingerprint-")
        self.addCleanup(shutil.rmtree, root, True)
        src = os.path.join(root, "source.jpg")
        dest = os.path.join(root, "destination.jpg")
        write_tiny_jpeg(src)
        expected_stat = os.lstat(src)

        def lose_source_and_raise(move_src, move_dest, move_expected_stat):
            self.assertEqual(move_expected_stat.st_size, expected_stat.st_size)
            os.remove(move_src)
            write_tiny_png(move_dest, rgb=(11, 12, 13))
            raise OSError(errno.EIO, "injected uncertain move failure")

        with mock.patch.object(
            server.AppState,
            "_move_regular_no_replace",
            side_effect=lose_source_and_raise,
        ):
            with self.assertRaises(OSError):
                server.AppState._move_regular_no_replace_verified(
                    src, dest, expected_stat
                )

        self.assertFalse(os.path.lexists(src))
        self.assertTrue(os.path.isfile(dest))
        self.assertNotEqual(os.lstat(dest).st_size, expected_stat.st_size)

    def test_purge_refuses_a_non_regular_body_without_partial_cleanup(self):
        root = tempfile.mkdtemp(prefix="giv-purge-dir-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        marker = origin + ".trashed"
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        os.remove(body)
        os.mkdir(body)

        status, payload = self.post_trash("/api/trash/purge", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("purged"), [])
        self.assertEqual([row.get("id") for row in payload.get("errors") or []], [asset_id])
        self.assertTrue(os.path.isdir(body), msg="non-regular body is never recursively removed")
        self.assertTrue(os.path.isfile(marker), msg="validation happens before any cleanup")
        self.assertTrue(os.path.isfile(tomb))

    def test_purge_refuses_a_dangling_marker_without_deleting_body(self):
        root = tempfile.mkdtemp(prefix="giv-purge-link-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        origin = os.path.join(root, "combos", folder, COMBO1_FILE)
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        marker = origin + ".trashed"
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")
        self.post_trash(
            "/api/trash",
            {"section": "combos", "folder": folder, "ids": [asset_id]},
        )
        os.remove(marker)
        try:
            os.symlink(os.path.join(root, "missing-marker-target"), marker)
        except (OSError, NotImplementedError) as exc:
            self.skipTest("symlink creation unavailable: %s" % exc)

        status, payload = self.post_trash("/api/trash/purge", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("purged"), [])
        self.assertEqual([row.get("id") for row in payload.get("errors") or []], [asset_id])
        self.assertTrue(os.path.isfile(body), msg="all entries are validated before the body is removed")
        self.assertTrue(os.path.lexists(marker), msg="dangling marker itself is untouched")
        self.assertTrue(os.path.isfile(tomb))

    def test_restore_of_a_missing_body_is_not_reported_restored(self):
        """A2: a tombstone whose body is gone must not be quietly dropped."""
        root = tempfile.mkdtemp(prefix="giv-nobody-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        self.post_trash("/api/trash", {"section": "combos", "folder": folder, "ids": [asset_id]})
        body = os.path.join(root, ".trash", "combos", folder, COMBO1_FILE)
        os.remove(body)

        status, payload = self.post_trash("/api/trash/restore", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("restored"), [])
        self.assertEqual([row.get("error") for row in payload.get("errors") or []], ["missing_body"])
        self.assertTrue(os.path.isfile(os.path.join(root, ".trash", "by-id", asset_id + ".json")))

    def test_unreadable_meta_is_never_written_over(self):
        """A3: saving our idea of "empty" over a file we could not read is how a
        library loses every favorite and tag it had."""
        root = tempfile.mkdtemp(prefix="giv-badmeta-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        meta_file = os.path.join(root, ".viewer-meta.json")
        garbage = '{"items": {"a": {"fav": true}}, "groups"'  # truncated mid-write
        with open(meta_file, "w", encoding="utf-8") as fh:
            fh.write(garbage)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"

        status, payload = self.put_meta(
            {"item": {"id": asset_id, "fav": True, "section": "combos", "folder": "0001_aaa11111"}},
        )
        self.assertEqual(status, 409, msg="a corrupt store is a conflict, not a fresh start")
        self.assertFalse(payload.get("ok"))
        self.assertEqual(payload.get("code"), "store_corrupt")
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), garbage, msg="the broken file is left for a human")

        # Reads degrade instead of failing, and say why the flags look empty.
        status, _, body = http_get(self.base + "/api/meta")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data.get("metaError"), "store_corrupt")
        self.assertEqual(data["meta"]["items"], {})

        status, _, body = http_get(self.base + "/api/library")
        lib = json.loads(body.decode("utf-8"))
        self.assertTrue(lib["ok"], msg="the wall still opens")
        self.assertEqual(lib.get("metaError"), "store_corrupt")
        self.assertEqual([c["folder"] for c in lib["combos"]], ["0001_aaa11111", "0002_bbb22222"])

    def test_unreadable_meta_reports_unavailable_not_corrupt(self):
        """A3: a permission or network failure is temporary, so it answers 503 and
        the page can retry; only real garbage is a 409."""
        root = tempfile.mkdtemp(prefix="giv-metadir-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        # A directory where the sidecar belongs: open() fails with an OSError that
        # is not "missing", which must never be read as an empty library.
        os.makedirs(os.path.join(root, ".viewer-meta.json"), exist_ok=True)
        http_post_json(self.base + "/api/root", {"root": root})

        status, payload = self.put_meta(
            {"group": {"key": "combos/0001_aaa11111", "section": "combos", "folder": "0001_aaa11111", "fav": True}},
        )
        self.assertEqual(status, 503)
        self.assertEqual(payload.get("code"), "store_unavailable")
        self.assertTrue(os.path.isdir(os.path.join(root, ".viewer-meta.json")))

    def test_unreadable_folder_does_not_hide_a_card(self):
        """A4: a listdir that fails proves nothing about the folder's contents. A
        CIFS blip must not read as "the user emptied this combo"."""
        root = tempfile.mkdtemp(prefix="giv-blip-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        folder = "0001_aaa11111"
        target = os.path.realpath(os.path.join(root, "combos", folder))

        real_listdir = os.listdir

        def flaky(path, *args, **kwargs):
            try:
                same = os.path.realpath(path) == target
            except (OSError, TypeError, ValueError):
                same = False
            if same:
                raise OSError(errno.EIO, "input/output error")
            return real_listdir(path, *args, **kwargs)

        # The card.json stays readable: only the listing is broken, which is what
        # a flaky share actually looks like.
        os.listdir = flaky
        self.addCleanup(setattr, os, "listdir", real_listdir)
        server.invalidate_trash_index()
        http_post_json(self.base + "/api/root", {"root": root})

        live, markers, avail = server.folder_listing(target)
        self.assertEqual(avail, "unavailable")
        self.assertEqual((live, markers), (frozenset(), frozenset()))
        self.assertEqual(server.folder_listing(os.path.join(root, "combos", "nope"))[2], "missing")
        self.assertEqual(server.folder_listing(os.path.join(root, "combos", "0002_bbb22222"))[2], "available")

        status, payload = http_post_json(self.base + "/api/cards", {"section": "combos", "folders": [folder]})
        self.assertEqual(status, 200)
        row = payload["cards"][0]
        self.assertEqual(row["state"], "unavailable")
        self.assertTrue(row["unavailable"])
        self.assertEqual(row["count"], 1, msg="trust the card until the folder answers")
        self.assertNotEqual(row["count"], 0, msg="an unreadable folder must not hide the card")

        status, _, body = http_get(self.base + "/api/library")
        folders = [c["folder"] for c in json.loads(body.decode("utf-8"))["combos"]]
        self.assertIn(folder, folders, msg="the card stays on the wall")

        status, _, body = http_get(self.base + "/api/flat")
        flat = json.loads(body.decode("utf-8"))
        files = {item.get("file") for item in flat["items"]}
        self.assertIn(COMBO1_FILE, files, msg="the flat wall must not shrink during a blip")

    def test_purged_asset_leaves_the_list_but_keeps_its_tombstone(self):
        """A5: the by-id tombstone is the download script's contract, but the trash
        view must not offer a shell the user cannot restore."""
        root = tempfile.mkdtemp(prefix="giv-purged-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        asset_id = "a8b9823e-0811-4414-8064-b030dfc90e89"
        folder = "0001_aaa11111"
        tomb = os.path.join(root, ".trash", "by-id", asset_id + ".json")

        self.post_trash("/api/trash", {"section": "combos", "folder": folder, "ids": [asset_id]})
        status, _, body = http_get(self.base + "/api/trash")
        self.assertIn(asset_id, {row.get("id") for row in json.loads(body.decode("utf-8"))["items"]})

        status, payload = self.post_trash("/api/trash/purge", {"ids": [asset_id]})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("purged"), [asset_id])

        status, _, body = http_get(self.base + "/api/trash")
        self.assertEqual(status, 200)
        rows = json.loads(body.decode("utf-8"))["items"]
        self.assertNotIn(asset_id, {row.get("id") for row in rows}, msg="no empty shell in the list")
        self.assertTrue(os.path.isfile(tomb), msg="the tombstone stays for the download script")
        self.assertTrue(server.load_tombstone(root, asset_id), msg="by-id lookup still resolves")

    def test_view_sort_accepts_fav_and_count(self):
        """B4: the menu writes four values, and an older asc/desc config still
        means what it always meant."""
        root = tempfile.mkdtemp(prefix="giv-sort-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})

        for value in ("fav", "count", "asc", "desc"):
            status, payload = self.put_views({"views": {"combos": {"sort": value}}})
            self.assertEqual(status, 200)
            self.assertEqual(payload["views"]["combos"]["sort"], value)

        self.put_views({"views": {"combos": {"sort": "fav"}}})
        status, _, body = http_get(self.base + "/api/views")
        self.assertEqual(json.loads(body.decode("utf-8"))["views"]["combos"]["sort"], "fav")
        with open(os.path.join(root, ".viewer-config.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["views"]["combos"]["sort"], "fav")

        status, payload = self.put_views({"views": {"combos": {"sort": "sideways"}}})
        self.assertEqual(payload["views"]["combos"]["sort"], "desc", msg="junk falls back to the default")
        self.assertEqual(server.normalize_view_prefs({"sort": "count"})["sort"], "count")
        self.assertEqual(server.normalize_view_prefs({"sort": ""})["sort"], "desc")

    def test_duration_sidecar_feeds_cards_cover_and_flat(self):
        """B1: one ffprobe per extracted cover, cached in the library, then read
        back for the badge without touching ffmpeg again."""
        if os.name == "nt":
            self.skipTest("shell stub is posix only")
        root = tempfile.mkdtemp(prefix="giv-dur-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        self.install_ffmpeg_stub(seconds="15.25")
        state = server.accel_state(refresh=True)
        self.assertTrue(state["covers"])

        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        src = os.path.join(root, "combos", folder, COMBO2_MP4)

        made = server.extract_video_cover(root, src, video_id, state=state)
        self.assertTrue(made and os.path.isfile(made))
        sidecar = server.cover_meta_path(root, video_id)
        self.assertTrue(os.path.isfile(sidecar), msg="the still gets a duration sidecar")
        with open(sidecar, encoding="utf-8") as fh:
            rec = json.load(fh)
        self.assertAlmostEqual(rec["duration"], 15.25, places=3)
        self.assertEqual(rec["size"], os.path.getsize(src))
        self.assertEqual(rec["mtime_ns"], os.stat(src).st_mtime_ns)
        self.assertAlmostEqual(server.duration_index(root)[video_id], 15.25, places=3)

        http_post_json(self.base + "/api/root", {"root": root})
        # Make the clip the cover so the card carries its length.
        self.put_meta(
            {"group": {"key": "combos/" + folder, "section": "combos", "folder": folder, "lastViewedId": video_id}},
        )

        status, payload = http_post_json(self.base + "/api/cards", {"section": "combos", "folders": [folder]})
        self.assertEqual(status, 200)
        card = payload["cards"][0]
        self.assertEqual(card["coverMedia"], "video")
        self.assertAlmostEqual(card["duration"], 15.25, places=3)

        status, headers, body = http_get(
            self.base + "/api/cover?section=combos&folder=" + folder + "&id=" + video_id
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-type", "").startswith("image/jpeg"))
        self.assertAlmostEqual(float(headers.get("x-cover-duration")), 15.25, places=2)

        status, _, body = http_get(self.base + "/api/combo?section=combos&folder=" + folder)
        items = {it["id"]: it for it in json.loads(body.decode("utf-8"))["items"]}
        self.assertAlmostEqual(items[video_id]["duration"], 15.25, places=3)
        self.assertNotIn("duration", items["bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"], msg="stills have no length")

        status, _, body = http_get(self.base + "/api/flat")
        flat = {it["id"]: it for it in json.loads(body.decode("utf-8"))["items"]}
        self.assertAlmostEqual(flat[video_id]["duration"], 15.25, places=3)

        # A re-encoded clip keeps its id, so size + mtime is what says "stale".
        self.assertTrue(server.cover_cache_hit(root, video_id, src=src))
        with open(src, "ab") as fh:
            fh.write(b"\x00" * 32)
        self.assertIsNone(
            server.cover_cache_hit(root, video_id, src=src),
            msg="a changed source invalidates the cached still",
        )

    def test_duration_arrives_before_the_still_is_cut(self):
        """B1: the badge rides its own ffprobe queue. A card whose cover has no
        JPEG yet still reports a length, and /api/cover carries it on the empty
        answer so the wall does not have to wait for ffmpeg."""
        if os.name == "nt":
            self.skipTest("shell stub is posix only")
        root = tempfile.mkdtemp(prefix="giv-durq-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        self.install_ffmpeg_stub(seconds="6.5")
        server.accel_state(refresh=True)

        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        src = os.path.join(root, "combos", folder, COMBO2_MP4)
        still = server.cover_cache_path(root, video_id)
        sidecar = server.cover_meta_path(root, video_id)

        self.assertTrue(server.DURATIONS.enqueue(root, src, video_id))
        deadline = time.time() + 8
        while time.time() < deadline and not os.path.isfile(sidecar):
            time.sleep(0.05)
        self.assertTrue(os.path.isfile(sidecar), msg="the probe worker writes the sidecar")
        self.assertFalse(os.path.isfile(still), msg="a length must not require a frame")
        with open(sidecar, encoding="utf-8") as fh:
            self.assertAlmostEqual(json.load(fh)["duration"], 6.5, places=3)
        self.assertAlmostEqual(server.duration_index(root)[video_id], 6.5, places=3)
        # Already known: the queue does not pay for a second probe.
        self.assertFalse(server.DURATIONS.enqueue(root, src, video_id))

        http_post_json(self.base + "/api/root", {"root": root})
        self.put_meta(
            {"group": {"key": "combos/" + folder, "section": "combos", "folder": folder, "lastViewedId": video_id}},
        )
        status, payload = http_post_json(self.base + "/api/cards", {"section": "combos", "folders": [folder]})
        self.assertEqual(status, 200)
        card = payload["cards"][0]
        self.assertEqual(card["coverMedia"], "video")
        self.assertFalse(card["coverReady"], msg="no still yet")
        self.assertAlmostEqual(card["duration"], 6.5, places=3)

        # The empty cover answer still carries the badge, and the page asks for it
        # with HEAD so a tile never downloads a frame just to read a length. This
        # request also queues the extraction, so nothing below may assert on the
        # still being absent.
        cover_url = self.base + "/api/cover?section=combos&folder=" + folder + "&id=" + video_id
        status, headers, body = http_head(cover_url)
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertAlmostEqual(float(headers.get("x-cover-duration")), 6.5, places=2)
        status, headers, body = http_get(cover_url)
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertAlmostEqual(float(headers.get("x-cover-duration")), 6.5, places=2)

        # A GET/HEAD never queues writes; explicitly prepare the frame.
        status, _ = http_post_json(self.base + "/api/cover/prepare", {"section": "combos", "folder": folder, "id": video_id})
        self.assertEqual(status, 200)
        # Once the frame lands, HEAD still answers with the length and no body.
        still_path = server.cover_cache_path(root, video_id)
        deadline = time.time() + 8
        while time.time() < deadline and not os.path.isfile(still_path):
            time.sleep(0.05)
        self.assertTrue(os.path.isfile(still_path))
        status, headers, body = http_head(cover_url)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertAlmostEqual(float(headers.get("x-cover-duration")), 6.5, places=2)

    def test_browser_measured_duration_is_written_back(self):
        """B1: no ffprobe (or a container it cannot read) leaves the page's own
        <video> as the only source. It writes to the same sidecar the walls read."""
        root = tempfile.mkdtemp(prefix="giv-durpost-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        png_id = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

        status, payload = http_post_json(
            self.base + "/api/duration",
            {
                "section": "combos",
                "folder": folder,
                "id": video_id,
                "duration": 4.75,
                "expectedRoot": root,
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertAlmostEqual(payload["duration"], 4.75, places=3)
        with open(server.cover_meta_path(root, video_id), encoding="utf-8") as fh:
            self.assertAlmostEqual(json.load(fh)["duration"], 4.75, places=3)
        self.assertAlmostEqual(server.duration_index(root)[video_id], 4.75, places=3)

        self.put_meta(
            {"group": {"key": "combos/" + folder, "section": "combos", "folder": folder, "lastViewedId": video_id}},
        )
        status, payload = http_post_json(self.base + "/api/cards", {"section": "combos", "folders": [folder]})
        self.assertAlmostEqual(payload["cards"][0]["duration"], 4.75, places=3)
        status, headers, _ = http_head(
            self.base + "/api/cover?section=combos&folder=" + folder + "&id=" + video_id
        )
        self.assertEqual(status, 204)
        self.assertAlmostEqual(float(headers.get("x-cover-duration")), 4.75, places=2)

        # A still has no length, an escape is not an id, and neither zero nor a
        # week-long clip is a number this endpoint will keep.
        for bad, why in (
            ({"section": "combos", "folder": folder, "id": png_id, "duration": 3}, "a still"),
            ({"section": "combos", "folder": folder, "id": "../../etc/passwd", "duration": 3}, "escape"),
            ({"section": "combos", "folder": folder, "id": video_id, "duration": 0}, "zero"),
            ({"section": "combos", "folder": folder, "id": video_id, "duration": -2}, "negative"),
            ({"section": "combos", "folder": folder, "id": video_id, "duration": 999999}, "absurd"),
            ({"section": "combos", "folder": folder, "id": video_id, "duration": "abc"}, "not a number"),
            ({"section": "combos", "folder": "0009_nope", "id": video_id, "duration": 3}, "no such card"),
        ):
            bad["expectedRoot"] = root
            status, payload = http_post_json(self.base + "/api/duration", bad)
            self.assertIn(status, (400, 404), msg=why)
            self.assertFalse(payload.get("ok"), msg=why)
        # None of the refusals moved the value that was already there.
        self.assertAlmostEqual(server.duration_index(root)[video_id], 4.75, places=3)

    def test_browser_duration_requires_current_expected_root(self):
        old = tempfile.mkdtemp(prefix="giv-duration-old-")
        new = tempfile.mkdtemp(prefix="giv-duration-new-")
        self.addCleanup(shutil.rmtree, old, True)
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        base_payload = {
            "section": "combos",
            "folder": folder,
            "id": video_id,
            "duration": 8.25,
        }
        http_post_json(self.base + "/api/root", {"root": old})

        status, payload = http_post_json(self.base + "/api/duration", base_payload)
        self.assertEqual(status, 400)
        self.assertFalse(payload.get("ok"))

        http_post_json(self.base + "/api/root", {"root": new})
        status, payload = http_post_json(
            self.base + "/api/duration", {**base_payload, "expectedRoot": old}
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload.get("code"), server.LIBRARY_CHANGED)
        for root in (old, new):
            self.assertFalse(
                os.path.lexists(server.cover_meta_path(root, video_id)),
                msg="a stale duration callback writes neither library",
            )

    def test_a_failed_probe_never_erases_a_known_duration(self):
        """A cover cut later must not take the badge away again, and a probe that
        runs while a still is already cached must not revalidate that still."""
        if os.name == "nt":
            self.skipTest("shell stub is posix only")
        root = tempfile.mkdtemp(prefix="giv-durkeep-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        # ffprobe prints nothing usable, and the stub ffmpeg has no banner either.
        self.install_ffmpeg_stub(seconds="")
        state = server.accel_state(refresh=True)
        folder = "0002_bbb22222"
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        src = os.path.join(root, "combos", folder, COMBO2_MP4)
        self.assertIsNone(server.probe_duration(src, probe=state["ffprobe"], ffmpeg=state["ffmpeg"]))

        self.assertTrue(server.write_duration_only(root, video_id, 3.5, src=src))
        made = server.extract_video_cover(root, src, video_id, state=state)
        self.assertTrue(made and os.path.isfile(made))
        with open(server.cover_meta_path(root, video_id), encoding="utf-8") as fh:
            rec = json.load(fh)
        self.assertAlmostEqual(rec["duration"], 3.5, places=3)
        self.assertEqual(rec["mtime_ns"], os.stat(src).st_mtime_ns, msg="the still's fingerprint is current")

        # Re-encode the clip, then record a length again. The sidecar keeps the
        # stale fingerprint, so the cached frame stays invalid.
        with open(src, "ab") as fh:
            fh.write(b"\x00" * 16)
        self.assertIsNone(server.cover_cache_hit(root, video_id, src=src))
        self.assertTrue(server.write_duration_only(root, video_id, 9.25, src=src))
        self.assertIsNone(
            server.cover_cache_hit(root, video_id, src=src),
            msg="a probe must not vouch for a frame it did not cut",
        )
        self.assertAlmostEqual(server.duration_index(root)[video_id], 9.25, places=3)

    def test_favicon_and_meta_get(self):
        status, headers, body = http_get(self.base + "/favicon.ico")
        self.assertEqual(status, 200)
        self.assertTrue(len(body) > 100)
        status, _, body = http_get(self.base + "/api/meta")
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["ok"])
        self.assertIn("ACG", data["meta"]["tags"])

    def test_create_library_skeleton(self):
        parent = tempfile.mkdtemp(prefix="giv-new-")
        self.addCleanup(shutil.rmtree, parent, True)
        target = os.path.join(parent, "新图库")
        status, data = http_post_json(self.base + "/api/library/create", {"root": target})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertTrue(data["library"]["ok"])
        self.assertEqual(data["library"]["combos"], [])
        self.assertTrue(os.path.isdir(os.path.join(target, "combos")))
        self.assertTrue(os.path.isdir(os.path.join(target, "_other")))
        with open(os.path.join(target, "_index.json"), encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertEqual(index["summary"], {"web_combos": 0, "other_groups": 0})
        self.assertEqual(index["combos"], [])
        self.assertEqual(index["other"], [])
        # The new skeleton is a live, parseable, empty library.
        status, _, body = http_get(self.base + "/api/library")
        lib = json.loads(body.decode("utf-8"))
        self.assertTrue(lib["ok"])
        self.assertEqual(lib["combos"], [])
        # A fresh library carries no account bind.
        status, _, body = http_get(self.base + "/api/meta")
        meta = json.loads(body.decode("utf-8"))
        self.assertEqual(meta["meta"].get("grokUserId", ""), "")

    def test_create_library_refuses_non_empty_dir(self):
        parent = tempfile.mkdtemp(prefix="giv-full-")
        self.addCleanup(shutil.rmtree, parent, True)
        with open(os.path.join(parent, "keep.txt"), "w", encoding="utf-8") as fh:
            fh.write("x")
        status, data = http_post_json(self.base + "/api/library/create", {"root": parent})
        self.assertEqual(status, 400)
        self.assertFalse(data["ok"])
        self.assertFalse(os.path.exists(os.path.join(parent, "_index.json")))
        # An empty payload is rejected too.
        status, data = http_post_json(self.base + "/api/library/create", {})
        self.assertEqual(status, 400)

    def test_create_library_parent_name_form(self):
        # The browser flow sends parent + typed name; python does the join.
        parent = tempfile.mkdtemp(prefix="giv-join-")
        self.addCleanup(shutil.rmtree, parent, True)
        status, data = http_post_json(
            self.base + "/api/library/create", {"parent": parent, "name": "libB"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertTrue(os.path.samefile(data["root"], os.path.join(parent, "libB")))
        self.assertTrue(os.path.isdir(os.path.join(parent, "libB", "combos")))
        # Separators and reserved characters never sneak into the join.
        for bad in ("a/b", "a\\b", "..", "con?"):
            status, data = http_post_json(
                self.base + "/api/library/create", {"parent": parent, "name": bad}
            )
            self.assertEqual(status, 400, bad)
            self.assertFalse(data["ok"])

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "0"})
    def test_legacy_grok_user_id_bind_round_trip(self):
        root = tempfile.mkdtemp(prefix="giv-bind-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        status, data = self.put_meta({"grokUserId": " user-123 "})
        self.assertEqual(status, 200)
        self.assertEqual(data["meta"]["grokUserId"], "user-123")
        # Survives the write and comes back on a plain GET.
        status, _, body = http_get(self.base + "/api/meta")
        meta = json.loads(body.decode("utf-8"))["meta"]
        self.assertEqual(meta["grokUserId"], "user-123")
        # An ordinary flag write without the key must not clear the bind.
        status, data = self.put_meta(
            {"item": {"id": "a8b9823e-0811-4414-8064-b030dfc90e89", "fav": True}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["meta"]["grokUserId"], "user-123")
        with open(os.path.join(root, server.META_NAME), encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk["grokUserId"], "user-123")
        # Explicit empty string unbinds; garbage (newline) is dropped.
        status, data = self.put_meta({"grokUserId": "bad\nid"})
        self.assertEqual(data["meta"]["grokUserId"], "")

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_empty_same_and_mismatch_are_atomic(self):
        root = tempfile.mkdtemp(prefix="giv-bind-auth-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})

        status, data = self.put_download_bind(root, "user-one")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        meta_file = os.path.join(root, server.META_NAME)
        with open(meta_file, encoding="utf-8") as fh:
            first = fh.read()
        first_meta = json.loads(first)
        self.assertEqual(first_meta["grokUserId"], "user-one")
        self.assertEqual(first_meta["version"], 2)
        self.assertEqual(first_meta["revision"], 1, msg="the first account bind is one meta mutation")

        status, data = self.put_download_bind(root, "user-one")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), first, msg="same-account bind does not rewrite meta")

        status, data = self.put_download_bind(root, "user-two")
        self.assertEqual(status, 409)
        self.assertEqual(data.get("code"), server.DOWNLOAD_BIND_MISMATCH)
        self.assertTrue(data.get("mismatch"))
        self.assertNotIn("grokUserId", data)
        with open(meta_file, encoding="utf-8") as fh:
            mismatched = json.load(fh)
        self.assertEqual(mismatched["grokUserId"], "user-one")
        self.assertEqual(mismatched["revision"], 1)

        status, data = self.put_meta(
            {"grokUserId": "user-two"},
            headers={"Origin": self.base},
        )
        self.assertEqual(status, 400)
        self.assertEqual(data.get("code"), "binding_endpoint_required")
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["grokUserId"], "user-one")

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_check_only_does_not_write_an_empty_library(self):
        root = tempfile.mkdtemp(prefix="giv-bind-check-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})
        status, data = self.put_download_bind(root, "user-one", commit=False)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertFalse(data.get("bound"))
        self.assertFalse(os.path.exists(os.path.join(root, server.META_NAME)))

        status, data = self.put_download_bind(root, "user-one")
        self.assertEqual(status, 200)
        self.assertTrue(data.get("bound"))
        with open(os.path.join(root, server.META_NAME), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["grokUserId"], "user-one")

        status, data = self.put_download_bind(root, "user-two", commit=False)
        self.assertEqual(status, 409)
        self.assertEqual(data.get("code"), server.DOWNLOAD_BIND_MISMATCH)
        with open(os.path.join(root, server.META_NAME), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["grokUserId"], "user-one")

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_obeys_meta_lease_contention(self):
        root = tempfile.mkdtemp(prefix="giv-bind-meta-lock-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        http_post_json(self.base + "/api/root", {"root": root})

        with server.meta_write_lease(root, owner="python-test-holder"):
            status, payload = self.put_download_bind(root, "user-one")
        self.assertEqual(status, 423)
        self.assertFalse(payload.get("ok"))
        self.assertFalse(os.path.exists(os.path.join(root, server.META_NAME)))

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_wrong_root_and_missing_origin_write_nothing(self):
        current = tempfile.mkdtemp(prefix="giv-bind-current-")
        other = tempfile.mkdtemp(prefix="giv-bind-other-")
        self.addCleanup(shutil.rmtree, current, True)
        self.addCleanup(shutil.rmtree, other, True)
        make_full_library(current)
        make_full_library(other)
        http_post_json(self.base + "/api/root", {"root": current})

        status, data = self.put_download_bind(other, "user-one")
        self.assertEqual(status, 409)
        self.assertEqual(data.get("code"), server.LIBRARY_CHANGED)
        self.assertFalse(os.path.exists(os.path.join(current, server.META_NAME)))
        self.assertFalse(os.path.exists(os.path.join(other, server.META_NAME)))

        status, data = self.put_download_bind(current, "user-one", include_origin=False)
        self.assertEqual(status, 403)
        self.assertFalse(data["ok"])
        self.assertFalse(os.path.exists(os.path.join(current, server.META_NAME)))

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_rejects_single_and_loose_modes(self):
        single = tempfile.mkdtemp(prefix="giv-bind-single-")
        loose = tempfile.mkdtemp(prefix="giv-bind-loose-")
        self.addCleanup(shutil.rmtree, single, True)
        self.addCleanup(shutil.rmtree, loose, True)
        make_single_combo(single)
        make_loose_library(loose)
        for root in (single, loose):
            http_post_json(self.base + "/api/root", {"root": root})
            status, data = self.put_download_bind(root, "user-one")
            self.assertEqual(status, 409)
            self.assertEqual(data.get("code"), server.DOWNLOAD_BIND_UNSUPPORTED)
            self.assertFalse(os.path.exists(os.path.join(root, server.META_NAME)))

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_refuses_corrupt_meta_without_overwrite(self):
        root = tempfile.mkdtemp(prefix="giv-bind-corrupt-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        meta_file = os.path.join(root, server.META_NAME)
        broken = "{ this is not json\n"
        with open(meta_file, "w", encoding="utf-8") as fh:
            fh.write(broken)
        http_post_json(self.base + "/api/root", {"root": root})

        status, data = self.put_download_bind(root, "user-one")
        self.assertEqual(status, 409)
        self.assertEqual(data.get("code"), "store_corrupt")
        with open(meta_file, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), broken)

    @mock.patch.dict(os.environ, {server.DOWNLOAD_BIND_ONLY_ENV: "1"})
    def test_download_bind_rechecks_generation_after_snapshot(self):
        old = tempfile.mkdtemp(prefix="giv-bind-old-")
        new = tempfile.mkdtemp(prefix="giv-bind-new-")
        self.addCleanup(shutil.rmtree, old, True)
        self.addCleanup(shutil.rmtree, new, True)
        make_full_library(old)
        make_full_library(new)
        state = server.AppState(old)
        old_snapshot = state.snapshot()

        def snapshot_then_switch():
            state.set_root(new, persist_if_ok=False)
            return old_snapshot

        with mock.patch.object(state, "snapshot", side_effect=snapshot_then_switch):
            result = state.bind_download_account(
                {"expectedRoot": old, "grokUserId": "user-one"}
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result.get("code"), server.LIBRARY_CHANGED)
        self.assertFalse(os.path.exists(os.path.join(old, server.META_NAME)))
        self.assertFalse(os.path.exists(os.path.join(new, server.META_NAME)))

    def test_volume_round_trip(self):
        status, data = http_put_json(self.base + "/api/volume", {"level": 37, "muted": True})
        self.assertEqual(status, 200)
        self.assertEqual(data["volume"], {"level": 37, "muted": True})
        status, _, body = http_get(self.base + "/api/config")
        cfg = json.loads(body.decode("utf-8"))
        self.assertEqual(cfg["volume"], {"level": 37, "muted": True})
        # Out-of-range levels clamp instead of erroring.
        status, data = http_put_json(self.base + "/api/volume", {"level": 900, "muted": False})
        self.assertEqual(data["volume"], {"level": 100, "muted": False})

    def test_shell_static_not_cached(self):
        status, headers, body = http_get(self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn(b'id="modeGallery"', body)
        self.assertLess(body.find(b'id="modeGallery"'), body.find(b'id="modeGrok"'))
        self.assertLess(body.find(b'id="dlBtn"'), body.find(b'id="catPills"'))
        self.assertIn("no-store", headers.get("cache-control", ""))
        status, headers, _ = http_get(self.base + "/static/app.js")
        self.assertEqual(status, 200)
        self.assertIn("no-store", headers.get("cache-control", ""))
        status, _, cfg = http_get(self.base + "/api/config")
        data = json.loads(cfg.decode("utf-8"))
        self.assertEqual(os.path.realpath(data["staticDir"]), os.path.realpath(server.STATIC_DIR))
        port = int(self.base.rsplit(":", 1)[1])
        self.assertTrue(server.looks_like_our_server(port))
        self.assertFalse(server.same_static_dir(""))
        self.assertFalse(server.same_static_dir(os.path.join(tempfile.gettempdir(), "giv-other-static")))
        self.assertTrue(server.same_config_path(data["configPath"]))
        self.assertFalse(server.same_config_path(""))
        self.assertFalse(server.same_config_path(os.path.join(tempfile.gettempdir(), "giv-other-config")))

    def test_minimal_config_skips_history_and_accel_io(self):
        def fail_history():
            raise AssertionError("minimal config must not probe history paths")

        def fail_accel():
            raise AssertionError("minimal config must not probe ffmpeg")

        with mock.patch.object(server, "history_entries", side_effect=fail_history):
            with mock.patch.object(server, "accel_state", side_effect=fail_accel):
                status, _, body = http_get(self.base + "/api/config?minimal=1")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["app"], "grok_imagine_viewer")
        self.assertIn("staticDir", data)
        self.assertIn("configPath", data)
        self.assertIn("downloadBindOnly", data)
        self.assertIn("root", data)
        self.assertNotIn("history", data)
        self.assertNotIn("accel", data)
        self.assertNotIn("volume", data)


class TauriAuthHttpTests(unittest.TestCase):
    INSTANCE_SECRET = "11" * 32
    SESSION_TOKEN = "22" * 32
    INSTANCE_ID = "33" * 16

    @classmethod
    def setUpClass(cls):
        os.environ["VIEWER_QUIET"] = "1"
        cls.old_bind_mode = os.environ.get(server.DOWNLOAD_BIND_ONLY_ENV)
        os.environ[server.DOWNLOAD_BIND_ONLY_ENV] = "1"
        cls.old_config = server.CONFIG_PATH_OVERRIDE
        cls.cfg_dir = tempfile.mkdtemp(prefix="giv-auth-cfg-")
        server.CONFIG_PATH_OVERRIDE = os.path.join(cls.cfg_dir, "config.json")
        cls.lib = tempfile.mkdtemp(prefix="giv-auth-lib-")
        make_full_library(cls.lib)
        cls.auth = server.DesktopAuth(cls.INSTANCE_SECRET, cls.SESSION_TOKEN, cls.INSTANCE_ID)
        cls.state = server.AppState(cls.lib)
        handler = server.make_handler(cls.state, desktop_auth=cls.auth)
        cls.httpd = server.ViewerHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = int(cls.httpd.server_address[1])
        cls.base = "http://127.0.0.1:%d" % cls.port
        status, headers, body = http_get(cls.base + "/")
        if status != 403 or "set-cookie" in headers:
            raise AssertionError("authenticated test server did not start")
        cls.unauthenticated_body = body
        cls.cookie = "%s=%s" % (cls.auth.cookie_name(cls.port), cls.SESSION_TOKEN)
        status, cls.index_headers, cls.index_body = http_get(
            cls.base + "/", headers={"Cookie": cls.cookie}
        )
        if status != 200:
            raise AssertionError("native-cookie test session did not start")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.CONFIG_PATH_OVERRIDE = cls.old_config
        if cls.old_bind_mode is None:
            os.environ.pop(server.DOWNLOAD_BIND_ONLY_ENV, None)
        else:
            os.environ[server.DOWNLOAD_BIND_ONLY_ENV] = cls.old_bind_mode
        shutil.rmtree(cls.cfg_dir, True)
        shutil.rmtree(cls.lib, True)

    def cookie_headers(self, **extra):
        headers = {"Cookie": self.cookie}
        headers.update(extra)
        return headers

    def write_headers(self, **extra):
        headers = self.cookie_headers(Origin=self.base)
        headers.update(extra)
        return headers

    def test_unauthenticated_http_can_never_bootstrap_a_session(self):
        for path in ("/", "/index.html", "/?again=1", "/%69ndex.html"):
            status, headers, body = http_get(self.base + path)
            self.assertEqual(status, 403)
            self.assertNotIn("set-cookie", headers)
            self.assertNotIn(self.SESSION_TOKEN.encode("ascii"), body)
            self.assertNotIn(self.INSTANCE_SECRET.encode("ascii"), body)

        before = server.load_config().get("volume")
        status, _ = http_put_json(
            self.base + "/api/volume",
            {"level": 7, "muted": True},
            headers={"Origin": self.base},
        )
        self.assertEqual(status, 403)
        self.assertEqual(server.load_config().get("volume"), before)

        self.assertNotIn(self.SESSION_TOKEN.encode("ascii"), self.index_body)
        self.assertNotIn(self.INSTANCE_SECRET.encode("ascii"), self.index_body)
        self.assertNotIn("set-cookie", self.index_headers)
        csp = self.index_headers.get("content-security-policy", "")
        self.assertIn("default-src 'none'", csp)
        self.assertIn("script-src 'self'", csp)
        self.assertIn("style-src 'self' 'unsafe-inline'", csp)
        self.assertIn("connect-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)

        status, _, _ = http_get(self.base + "/static/app.js")
        self.assertEqual(status, 403)
        status, _, _ = http_get(self.base + "/static/app.js", headers=self.cookie_headers())
        self.assertEqual(status, 200)

    def test_cookie_and_native_header_unlock_control_api(self):
        status, _, _ = http_get(self.base + "/api/config")
        self.assertEqual(status, 403)
        status, _, body = http_get(self.base + "/api/config", headers=self.cookie_headers())
        self.assertEqual(status, 200)
        self.assertNotIn(self.SESSION_TOKEN.encode("ascii"), body)
        self.assertNotIn(self.INSTANCE_SECRET.encode("ascii"), body)
        status, _, minimal = http_get(
            self.base + "/api/config?minimal=1",
            headers={"X-Viewer-Session": self.SESSION_TOKEN},
        )
        self.assertEqual(status, 200)
        minimal_data = json.loads(minimal.decode("utf-8"))
        self.assertEqual(minimal_data["app"], "grok_imagine_viewer")
        self.assertNotIn("history", minimal_data)
        self.assertNotIn(self.SESSION_TOKEN.encode("ascii"), minimal)

        status, _, _ = http_get(
            self.base + "/api/config",
            headers={"X-Viewer-Session": self.SESSION_TOKEN},
        )
        self.assertEqual(status, 200)
        status, _, _ = http_get(
            self.base + "/api/config",
            headers={
                "Cookie": self.cookie,
                "X-Viewer-Session": "00" * 32,
            },
        )
        self.assertEqual(status, 403)

    def test_exact_host_origin_and_json_are_required_before_write(self):
        status, _, _ = http_get(
            self.base + "/api/config",
            headers=self.cookie_headers(Host="localhost:%d" % self.port),
        )
        self.assertEqual(status, 421)
        status, _, _ = http_get(
            self.base + "/api/config",
            headers=self.cookie_headers(Host="127.0.0.1"),
        )
        self.assertEqual(status, 421)

        before = server.load_config().get("volume")
        status, _ = http_put_json(
            self.base + "/api/volume",
            {"level": 9, "muted": True},
            headers=self.cookie_headers(),
        )
        self.assertEqual(status, 403)
        self.assertEqual(server.load_config().get("volume"), before)

        status, _ = http_put_json(
            self.base + "/api/volume",
            {"level": 9, "muted": True},
            headers=self.cookie_headers(Origin="http://localhost:%d" % self.port),
        )
        self.assertEqual(status, 403)
        self.assertEqual(server.load_config().get("volume"), before)

        request = Request(
            self.base + "/api/volume",
            data=b"{}",
            method="PUT",
            headers=self.write_headers(**{"Content-Type": "text/plain"}),
        )
        with self.assertRaises(HTTPError) as raised:
            urlopen(request, timeout=8)
        self.assertEqual(raised.exception.code, 415)
        raised.exception.close()
        self.assertEqual(server.load_config().get("volume"), before)

        status, payload = http_put_json(
            self.base + "/api/volume",
            {"level": 9, "muted": True},
            headers=self.write_headers(),
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["volume"], {"level": 9, "muted": True})

    def test_identity_challenge_is_bound_and_secret_free(self):
        challenge_hex = "44" * 32
        status, _, body = http_get(
            self.base + "/api/identity",
            headers={"X-Viewer-Challenge": challenge_hex},
        )
        self.assertEqual(status, 200)
        identity = json.loads(body.decode("utf-8"))
        self.assertEqual(identity["protocolVersion"], server.DESKTOP_AUTH_PROTOCOL)
        self.assertEqual(identity["instanceId"], self.INSTANCE_ID)
        self.assertEqual(identity["port"], self.port)
        message = (
            b"giv-identity-v3\0"
            + bytes.fromhex(challenge_hex)
            + bytes.fromhex(self.INSTANCE_ID)
            + self.port.to_bytes(2, "big")
            + int(identity["pid"]).to_bytes(4, "big")
            + b"\x01"
        )
        expected = hmac.new(bytes.fromhex(self.INSTANCE_SECRET), message, hashlib.sha256).hexdigest()
        self.assertEqual(identity["challengeResponse"], expected)
        self.assertNotIn(self.SESSION_TOKEN.encode("ascii"), body)
        self.assertNotIn(self.INSTANCE_SECRET.encode("ascii"), body)

        status, _, _ = http_get(self.base + "/api/identity")
        self.assertEqual(status, 400)
        status, _, _ = http_get(
            self.base + "/api/identity",
            headers={"X-Viewer-Challenge": "not-hex"},
        )
        self.assertEqual(status, 400)

    def test_get_root_and_cover_resource_are_read_only(self):
        before = os.path.realpath(self.state.root)
        status, _, _ = http_get(
            self.base + "/api/root?root=" + quote(self.cfg_dir, safe=""),
            headers=self.cookie_headers(),
        )
        self.assertEqual(status, 405)
        self.assertEqual(os.path.realpath(self.state.root), before)

        with mock.patch.object(server.COVERS, "enqueue") as covers, mock.patch.object(
            server.DURATIONS, "enqueue"
        ) as durations:
            query = "/resource/cover?section=combos&folder=0002_bbb22222&id=cccccccc-3333-4333-8333-cccccccccccc"
            status, _, _ = http_get(self.base + query, headers=self.cookie_headers())
            self.assertIn(status, (200, 204))
            status, _, _ = http_head(self.base + query, headers=self.cookie_headers())
            self.assertIn(status, (200, 204))
            covers.assert_not_called()
            durations.assert_not_called()

    def test_authenticated_port_collision_never_reuses_existing_service(self):
        auth = server.DesktopAuth("55" * 32, "66" * 32, "77" * 16)
        handler = server.make_handler(server.AppState(self.lib), desktop_auth=auth)
        httpd, port = server.bind_http_server(handler, self.port, authenticated=True)
        try:
            self.assertIsNotNone(httpd)
            self.assertNotEqual(port, self.port)
        finally:
            httpd.server_close()

    def test_cookie_names_are_port_scoped(self):
        self.assertNotEqual(self.auth.cookie_name(self.port), self.auth.cookie_name(self.port + 1))


class TauriAuthProcessTests(unittest.TestCase):
    def test_stdin_bootstrap_starts_owned_server_without_secret_output(self):
        secret = "81" * 32
        token = "82" * 32
        instance_id = "83" * 16
        cfg_dir = tempfile.mkdtemp(prefix="giv-auth-process-")
        self.addCleanup(shutil.rmtree, cfg_dir, True)
        config_path = os.path.join(cfg_dir, "config.json")
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
        probe.close()
        env = os.environ.copy()
        env[server.DOWNLOAD_BIND_ONLY_ENV] = "1"
        env.pop("VIEWER_QUIET", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        process = subprocess.Popen(
            [
                sys.executable,
                os.path.join(ROOT, "server.py"),
                "--port",
                str(port),
                "--config",
                config_path,
                "--desktop-auth-stdin",
            ],
            cwd=ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        bootstrap = json.dumps(
            {
                "protocolVersion": server.DESKTOP_AUTH_PROTOCOL,
                "instanceSecret": secret,
                "sessionToken": token,
                "instanceId": instance_id,
            },
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        process.stdin.write(bootstrap)
        process.stdin.close()
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
        reader.start()
        banner = b""
        try:
            banner = lines.get(timeout=8)
            self.assertTrue(banner.startswith(b"grok_imagine_viewer  http://127.0.0.1:"))
            self.assertNotIn(secret.encode("ascii"), banner)
            self.assertNotIn(token.encode("ascii"), banner)
            base = banner.decode("utf-8").strip().split("  ", 1)[1]

            status, _, config_body = http_get(
                base + "/api/config",
                headers={"X-Viewer-Session": token},
            )
            self.assertEqual(status, 200)
            self.assertNotIn(secret.encode("ascii"), config_body)
            self.assertNotIn(token.encode("ascii"), config_body)

            challenge = "84" * 32
            status, _, identity_body = http_get(
                base + "/api/identity",
                headers={"X-Viewer-Challenge": challenge},
            )
            self.assertEqual(status, 200)
            identity = json.loads(identity_body.decode("utf-8"))
            self.assertEqual(identity["instanceId"], instance_id)
            self.assertEqual(identity["port"], int(base.rsplit(":", 1)[1]))
            self.assertNotIn(secret.encode("ascii"), identity_body)
            self.assertNotIn(token.encode("ascii"), identity_body)

            status, headers, root_body = http_get(base + "/")
            self.assertEqual(status, 403)
            self.assertNotIn("set-cookie", headers)
            self.assertNotIn(token.encode("ascii"), root_body)
            cookie = "GIV_SESSION_%s=%s" % (base.rsplit(":", 1)[1], token)
            status, headers, root_body = http_get(base + "/", headers={"Cookie": cookie})
            self.assertEqual(status, 200)
            self.assertNotIn("set-cookie", headers)
            self.assertNotIn(token.encode("ascii"), root_body)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            remaining_stdout = process.stdout.read()
            stderr = process.stderr.read()
            process.stdout.close()
            process.stderr.close()
            combined = banner + remaining_stdout + stderr
            self.assertNotIn(secret.encode("ascii"), combined)
            self.assertNotIn(token.encode("ascii"), combined)


class DedupTests(unittest.TestCase):
    def apply_plan(self, state, root, actions):
        planned = state.library_dedup({"expectedRoot": root})
        return state.library_dedup({"expectedRoot": root, "apply": True,
                                    "planToken": planned["planToken"], "actions": actions})

    def test_identical_leftover_keeps_indexed_folder(self):
        root = tempfile.mkdtemp(prefix="giv-dedup-same-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "combos", "0120_aaa11111")
        os.makedirs(leftover, exist_ok=True)
        write_tiny_jpeg(os.path.join(leftover, COMBO1_FILE))
        planned = server.plan_library_dedup(root)
        self.assertTrue(planned["ok"], planned)
        self.assertEqual(planned["identical"], 1)
        self.assertEqual(planned["mixed"], 0)
        group = planned["groups"][0]
        self.assertEqual(group["keep"]["folder"], "0001_aaa11111")
        state = server.AppState(root)
        result = self.apply_plan(state, root, {group["key"]: "keep_newest"})
        self.assertTrue(result.get("ok"), result)
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)))
        self.assertFalse(os.path.isfile(os.path.join(leftover, COMBO1_FILE)))

    def test_different_bytes_are_mixed_and_can_merge(self):
        root = tempfile.mkdtemp(prefix="giv-dedup-mix-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "combos", "0120_aaa11111")
        os.makedirs(leftover, exist_ok=True)
        other = os.path.join(leftover, COMBO1_FILE)
        write_tiny_jpeg(other)
        with open(other, "ab") as handle:
            handle.write(b"DIFFERENT")
        planned = server.plan_library_dedup(root)
        self.assertEqual(planned["mixed"], 1)
        self.assertFalse(planned["groups"][0]["identical"])
        state = server.AppState(root)
        result = self.apply_plan(state, root, {planned["groups"][0]["key"]: "merge"})
        self.assertTrue(result.get("ok"), result)
        keep = os.path.join(root, "combos", "0001_aaa11111")
        self.assertTrue(os.path.isfile(os.path.join(keep, COMBO1_FILE)))
        merged = [name for name in os.listdir(keep) if name.startswith("a8b9823e") and "~n" in name]
        self.assertEqual(len(merged), 1)
        self.assertFalse(os.path.isfile(other))

    def test_shared_stem_does_not_join_different_conversations(self):
        root = tempfile.mkdtemp(prefix="giv-dedup-chain-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "combos", "0120_aaa11111")
        bridge = os.path.join(root, "combos", "0121_cccc3333")
        os.makedirs(leftover, exist_ok=True)
        os.makedirs(bridge, exist_ok=True)
        write_tiny_jpeg(os.path.join(leftover, COMBO1_FILE))
        write_tiny_jpeg(os.path.join(bridge, COMBO1_FILE))
        write_tiny_png(os.path.join(bridge, COMBO2_PNG))
        planned = server.plan_library_dedup(root)
        self.assertEqual(len(planned["groups"]), 1, planned)
        self.assertEqual(planned["groups"][0]["keep"]["folder"], "0001_aaa11111")
        self.assertEqual([row["folder"] for row in planned["groups"][0]["others"]], ["0120_aaa11111"])
        state = server.AppState(root)
        result = self.apply_plan(state, root, {planned["groups"][0]["key"]: "keep_newest"})
        self.assertTrue(result.get("ok"), result)
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0002_bbb22222", COMBO2_PNG)))
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0002_bbb22222", COMBO2_MP4)))
        self.assertFalse(os.path.isfile(os.path.join(leftover, COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(bridge, COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(bridge, COMBO2_PNG)))

    def test_keep_newest_leaves_conflicting_bytes_in_leftover(self):
        root = tempfile.mkdtemp(prefix="giv-dedup-keep-mix-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        leftover = os.path.join(root, "combos", "0120_aaa11111")
        os.makedirs(leftover, exist_ok=True)
        other = os.path.join(leftover, COMBO1_FILE)
        write_tiny_jpeg(other)
        with open(other, "ab") as handle:
            handle.write(b"DIFFERENT")
        state = server.AppState(root)
        result = self.apply_plan(state, root, {"combos/aaa11111": "keep_newest"})
        self.assertTrue(result.get("ok"), result)
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)))
        self.assertTrue(os.path.isfile(other))

    def test_indexed_suffix_collision_is_left_alone(self):
        root = tempfile.mkdtemp(prefix="giv-dedup-collide-")
        self.addCleanup(shutil.rmtree, root, True)
        make_full_library(root)
        index_path = os.path.join(root, "_index.json")
        with open(index_path, encoding="utf-8") as handle:
            index = json.load(handle)
        twin = os.path.join(root, "combos", "0099_aaa11111")
        os.makedirs(twin, exist_ok=True)
        write_tiny_jpeg(os.path.join(twin, COMBO1_FILE))
        index["combos"].append({
            "n": 99,
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99",
            "folder": "0099_aaa11111",
            "count": 1,
        })
        leftover = os.path.join(root, "combos", "0120_aaa11111")
        os.makedirs(leftover, exist_ok=True)
        write_tiny_jpeg(os.path.join(leftover, COMBO1_FILE))
        _write_json(index_path, index)
        planned = server.plan_library_dedup(root)
        self.assertEqual(planned["groups"], [])
        self.assertTrue(os.path.isfile(os.path.join(root, "combos", "0001_aaa11111", COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(twin, COMBO1_FILE)))
        self.assertTrue(os.path.isfile(os.path.join(leftover, COMBO1_FILE)))


if __name__ == "__main__":
    unittest.main()
