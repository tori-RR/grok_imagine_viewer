"""Folder picker regressions; only disposable directories and mocked drives."""

import ctypes
import ntpath
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.parse import quote

import server


class BrowseRootsTests(unittest.TestCase):
    def test_windows_computer_lists_drive_roots_without_accessing_them(self):
        with mock.patch.object(server.os, "name", "nt"), \
                mock.patch.object(server.os, "listdrives", return_value=["Z:\\", "C:\\", "d:\\", "C:\\"], create=True), \
                mock.patch.object(server, "browse_places", return_value=[{"name": "桌面", "path": "C:\\Users\\fixture\\Desktop"}]), \
                mock.patch.object(server.os, "listdir") as listing, \
                mock.patch.object(server.os.path, "isdir") as isdir, \
                mock.patch.object(server.os, "stat") as stat:
            data = server.browse_dir("")
        self.assertTrue(data["ok"])
        self.assertEqual(data["kind"], "computer")
        self.assertEqual(data["path"], "")
        self.assertIsNone(data["parent"])
        self.assertFalse(data["selectable"])
        self.assertEqual(data["markers"], [])
        self.assertEqual(data["dirs"], [{"name": p, "path": p} for p in ["C:\\", "D:\\", "Z:\\"]])
        self.assertEqual(data["places"], [{"name": "桌面", "path": "C:\\Users\\fixture\\Desktop"}])
        listing.assert_not_called()
        isdir.assert_not_called()
        stat.assert_not_called()

    def test_older_python_uses_logical_drive_bitmask(self):
        get_drives = mock.Mock(return_value=(1 << 2) | (1 << 3) | (1 << 25))
        with mock.patch.object(server.os, "listdrives", None, create=True), \
                mock.patch.object(ctypes, "WinDLL", return_value=SimpleNamespace(GetLogicalDrives=get_drives), create=True), \
                mock.patch.object(server.os, "listdir") as listing:
            self.assertEqual(server._windows_logical_drives(), ["C:\\", "D:\\", "Z:\\"])
        listing.assert_not_called()
        get_drives.assert_called_once_with()

    def test_unavailable_drive_inventory_is_not_a_selectable_directory(self):
        with mock.patch.object(server.os, "name", "nt"), \
                mock.patch.object(server, "browse_places", return_value=[]), \
                mock.patch.object(server, "_windows_logical_drives", side_effect=OSError("fixture error")):
            data = server.browse_dir(None)
        self.assertFalse(data["ok"])
        self.assertFalse(data["selectable"])
        self.assertEqual(data["kind"], "computer")
        self.assertEqual(data["dirs"], [])

    def test_posix_computer_has_filesystem_and_home_without_listing(self):
        with mock.patch.object(server.os, "name", "posix"), \
                mock.patch.object(server, "browse_places", return_value=[]), \
                mock.patch.object(server.os.path, "expanduser", return_value="/home/fixture"), \
                mock.patch.object(server.os, "listdir") as listing:
            data = server.browse_dir()
        self.assertEqual([row["path"] for row in data["dirs"]], ["/", "/home/fixture"])
        self.assertFalse(data["selectable"])
        listing.assert_not_called()

    def test_windows_common_places_use_redirected_shell_folders_and_fallbacks(self):
        redirected = {
            "Desktop": r"D:\Profiles\fixture\Desktop",
            "My Pictures": r"E:\Media\Pictures",
        }
        with mock.patch.dict(server.os.environ, {"USERPROFILE": r"C:\Users\fixture"}, clear=False):
            places = server.windows_common_places(lambda name: redirected.get(name, ""))
        self.assertEqual([row["name"] for row in places], ["桌面", "图片", "视频", "文档", "下载"])
        self.assertEqual(places[0]["path"], r"D:\Profiles\fixture\Desktop")
        self.assertEqual(places[1]["path"], r"E:\Media\Pictures")
        self.assertEqual(places[2]["path"], r"C:\Users\fixture\Videos")
        self.assertEqual(places[4]["path"], r"C:\Users\fixture\Downloads")


class BrowseAddressTests(unittest.TestCase):
    def test_quoted_absolute_addresses_and_unc_are_normalized(self):
        cases = {
            ' "D:\\图库 空间\\child\\.." ': "D:\\图库 空间",
            "'D:/图库'": "D:\\图库",
            r"\\server\share\child": r"\\server\share\child",
            "//nas/share/folder": r"\\nas\share\folder",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(server.normalize_browse_path(raw, windows=True), expected)

    def test_windows_relative_and_device_addresses_are_rejected_before_io(self):
        paths = ["C:", "C:relative", r"\folder", "/folder", "relative", "~", "",
                 r"\\nas", "\\\\nas\\", r"\\nas\..\folder", r"\\?\C:\folder",
                 r"\\.\C:\folder", r"\??\C:\folder", "C:\\bad\x00path"]
        for path in paths:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    server.normalize_browse_path(path, windows=True)
        with mock.patch.object(server.os, "name", "nt"), mock.patch.object(server.os, "listdir") as listing:
            result = server.browse_dir("C:relative")
        self.assertFalse(result["ok"])
        self.assertFalse(result["selectable"])
        listing.assert_not_called()

    def test_posix_keeps_absolute_navigation_and_rejects_relative_addresses(self):
        self.assertEqual(server.normalize_browse_path('"/tmp/图库/../gallery"', windows=False), "/tmp/gallery")
        for path in ["relative", "~/gallery", "C:\\gallery", "/bad\x00path"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                server.normalize_browse_path(path, windows=False)

    def test_windows_drive_and_unc_roots_return_to_computer(self):
        paths = ["C:\\", "D:\\", r"\\nas\share", "\\\\nas\\share\\"]
        with mock.patch.object(server.os, "name", "nt"), \
                mock.patch.object(server.os, "listdir", return_value=[]), \
                mock.patch.object(server, "library_markers", return_value=[]):
            for path in paths:
                with self.subTest(path=path):
                    data = server.browse_dir(path)
                    self.assertTrue(data["ok"])
                    self.assertTrue(data["selectable"])
                    self.assertEqual(data["parent"], "")
                    self.assertEqual(data["path"], path)

    def test_windows_child_preserves_its_drive_or_unc_parent(self):
        with mock.patch.object(server.os, "name", "nt"), \
                mock.patch.object(server.os, "listdir", return_value=[]), \
                mock.patch.object(server, "library_markers", return_value=[]):
            for path in [r"D:\图库", r"\\nas\share\图库"]:
                with self.subTest(path=path):
                    self.assertEqual(server.browse_dir(path)["parent"], ntpath.dirname(path))

    def test_posix_root_returns_to_computer(self):
        with mock.patch.object(server.os, "name", "posix"), \
                mock.patch.object(server.os, "listdir", return_value=[]), \
                mock.patch.object(server, "library_markers", return_value=[]):
            data = server.browse_dir("/")
        self.assertEqual(data["path"], "/")
        self.assertEqual(data["parent"], "")
        self.assertTrue(data["selectable"])


class BrowseDirectoryTests(unittest.TestCase):
    def test_real_fixture_lists_only_subdirectories_and_library_markers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ["combos", "_other", "图库 空间", ".trash"]:
                (root / name).mkdir()
            (root / "_index.json").write_text("{}", encoding="utf-8")
            (root / "private.txt").write_text("do not include this body", encoding="utf-8")
            data = server.browse_dir('"' + folder + '"')
        self.assertTrue(data["ok"])
        self.assertEqual(data["kind"], "directory")
        self.assertTrue(data["selectable"])
        self.assertEqual(data["path"], os.path.normpath(folder))
        self.assertEqual({row["name"] for row in data["dirs"]}, {"combos", "_other", "图库 空间"})
        self.assertEqual(data["markers"], ["_index.json", "combos", "_other"])
        self.assertNotIn("do not include this body", str(data))

    def test_missing_or_file_address_does_not_fall_back_to_existing_parent(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder, "file.txt")
            file.write_text("fixture", encoding="utf-8")
            for path in [str(file), str(Path(folder, "missing", "gallery"))]:
                with self.subTest(path=path):
                    data = server.browse_dir(path)
                    self.assertFalse(data["ok"])
                    self.assertFalse(data["selectable"])
                    self.assertEqual(data["path"], path)
                    self.assertEqual(data["dirs"], [])

    def test_disconnected_drive_reports_failure_without_retrying_ancestor(self):
        with mock.patch.object(server.os, "name", "nt"), \
                mock.patch.object(server.os, "listdir", side_effect=PermissionError("fixture disconnected")) as listing:
            data = server.browse_dir(r"Z:\gallery")
        self.assertFalse(data["ok"])
        self.assertFalse(data["selectable"])
        self.assertEqual(data["path"], r"Z:\gallery")
        listing.assert_called_once_with(r"Z:\gallery")


class BrowseEndpointTests(unittest.TestCase):
    def dispatch(self, path):
        handler = SimpleNamespace(path=path, state=SimpleNamespace(root="must-not-be-used"))
        with mock.patch.object(server, "send_json") as send:
            server.ViewerHandler._dispatch(handler, False)
        self.assertEqual(send.call_count, 1)
        return send.call_args.args[1]

    def test_omitted_and_empty_query_open_computer_even_with_current_library(self):
        roots = {"ok": True, "kind": "computer", "path": "", "parent": None,
                 "dirs": [], "markers": [], "selectable": False}
        with mock.patch.object(server, "browse_roots", return_value=roots) as browse:
            for path in ["/api/browse", "/api/browse?path="]:
                self.assertEqual(self.dispatch(path), roots)
        self.assertEqual(browse.call_count, 2)

    def test_invalid_manual_query_cannot_select_an_existing_ancestor(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = str(Path(folder, "missing"))
            data = self.dispatch("/api/browse?path=" + quote(missing, safe=""))
        self.assertFalse(data["ok"])
        self.assertFalse(data["selectable"])
        self.assertEqual(data["path"], missing)


if __name__ == "__main__":
    unittest.main()
