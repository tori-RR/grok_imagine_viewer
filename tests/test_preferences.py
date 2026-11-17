"""Settings/copy regressions: disposable local fixture data, never a real library."""
import concurrent.futures
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import server
import viewer_preferences as prefs
from tests.test_server import make_full_library


class PreferencesTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows UI language API")
    def test_system_language_uses_ui_language_instead_of_region_formats(self):
        import ctypes
        kernel = mock.Mock()
        kernel.GetUserDefaultUILanguage.return_value = 0x0804
        with mock.patch.object(ctypes, "WinDLL", return_value=kernel), mock.patch.object(prefs.locale, "getlocale", side_effect=AssertionError("regional locale must not be used")):
            self.assertEqual(prefs.system_language(), "zh-CN")
        with mock.patch.object(ctypes, "WinDLL", side_effect=OSError("unavailable")):
            self.assertEqual(prefs.system_language(), "")

    def test_posix_ui_language_environment_precedence(self):
        with mock.patch.object(prefs.os, "name", "posix"), mock.patch.dict(os.environ, {"LC_ALL": "", "LC_MESSAGES": "en_US.UTF-8", "LANG": "zh_CN.UTF-8"}):
            self.assertEqual(prefs.system_language(), "en-US")
            with mock.patch.dict(os.environ, {"LC_ALL": "zh_TW.UTF-8"}):
                self.assertEqual(prefs.system_language(), "zh-TW")

    def test_language_defaults_validation_and_preservation(self):
        self.assertEqual(prefs.defaults()["language"], "auto")
        self.assertEqual(prefs.read_preferences({})["language"], "auto")
        for language in ("auto", "zh-CN", "en"):
            config = {"root": "keep", "preferences": {"version": 1, "future": "keep"}}
            updated = prefs.update_preferences(config, {"language": language})
            self.assertEqual(updated["language"], language)
            self.assertEqual(updated["future"], "keep")
            self.assertEqual(config["root"], "keep")
            self.assertNotIn("language", config["preferences"])
            self.assertEqual(prefs.read_preferences({"preferences": updated})["language"], language)
            self.assertEqual(prefs.update_preferences({"preferences": updated}, {"wheelVolumeStep": 2})["language"], language)
        for invalid in ("ja", "zh", "", None, True, 1, [], {}):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    prefs.update_preferences({}, {"language": invalid})
                self.assertEqual(prefs.read_preferences({"preferences": {"language": invalid}})["language"], "auto")

    def test_language_http_preferences_round_trip_preserves_unrelated_settings(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(server, "config_path", return_value=str(Path(directory, "config.json"))):
            with mock.patch.object(prefs, "system_language", return_value="zh-TW"):
                self.assertTrue(server.save_config({"root": "unchanged", "volume": {"level": 37}}))
                self.assertEqual(server.get_preferences()["systemLanguage"], "zh-TW")
                for language in ("en", "zh-CN", "auto"):
                    result = server.put_preferences({"language": language})
                    self.assertTrue(result["ok"])
                    self.assertEqual(server.get_preferences()["preferences"]["language"], language)
                    config = server.load_config_strict()
                    self.assertEqual(config["root"], "unchanged")
                    self.assertEqual(config["volume"], {"level": 37})

    def test_defaults_use_desktop_and_preserve_specified_shortcuts(self):
        with mock.patch.object(prefs, "desktop_directory", return_value=r"C:\Users\Test\OneDrive\Desktop"):
            default = prefs.defaults()
            self.assertEqual(default["saveDirectory"], r"C:\Users\Test\OneDrive\Desktop")
            self.assertEqual(default["audioOutputId"], "")
            self.assertEqual(default["shortcuts"]["mute"], "KeyM")
            self.assertEqual(default["shortcuts"]["size150Alt"], "Ctrl+Digit4")
            self.assertEqual(default["shortcuts"]["previousGroup"], "Ctrl+ArrowLeft")
            self.assertEqual(default["shortcuts"]["nextGroup"], "Ctrl+ArrowRight")
            self.assertEqual(default["shortcuts"]["seekBack"], "ArrowLeft")
            self.assertEqual(default["shortcuts"]["previousFrame"], "KeyD")
            self.assertEqual(default["shortcuts"]["nextFrame"], "KeyF")

    def test_settings_validation_preserves_unknown_fields_and_rejects_future_version(self):
        config = {"other": "keep", "preferences": {"version": 1, "futureOption": "keep"}}
        result = prefs.update_preferences(config, {"wheelVolumeStep": 7, "shortcuts": {"mute": "Ctrl+KeyM"}})
        self.assertEqual(result["wheelVolumeStep"], 7)
        self.assertEqual(result["futureOption"], "keep")
        self.assertEqual(config["preferences"], {"version": 1, "futureOption": "keep"})
        for value in [0, 21, True, "5"]:
            with self.assertRaises(ValueError): prefs.update_preferences(config, {"wheelVolumeStep": value})
        for version in [2, True, "1"]:
            with self.assertRaises(ValueError): prefs.update_preferences({"preferences": {"version": version}}, {})
        with self.assertRaises(ValueError): prefs.update_preferences(config, {"shortcuts": {"mute": "Space"}})
        with self.assertRaises(ValueError): prefs.update_preferences(config, {"shortcuts": {"mute": "Ctrl"}})
        with self.assertRaises(ValueError): prefs.update_preferences(config, {"shortcuts": {"mute": "Alt+F4"}})

    def test_legacy_arrow_combo_shortcuts_move_to_ctrl(self):
        config = {"preferences": {"version": 1, "shortcuts": {
            "previousGroup": "ArrowLeft", "nextGroup": "ArrowRight", "play": "Space",
        }}}
        result = prefs.read_preferences(config)
        self.assertEqual(result["shortcuts"]["previousGroup"], "Ctrl+ArrowLeft")
        self.assertEqual(result["shortcuts"]["nextGroup"], "Ctrl+ArrowRight")
        self.assertEqual(result["shortcuts"]["seekBack"], "ArrowLeft")
        self.assertEqual(result["shortcuts"]["seekForward"], "ArrowRight")

    def test_save_directory_is_distinct_from_root_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {"root":"unchanged", "lastRoot":"unchanged"}
            updated = prefs.update_preferences(config, {"saveDirectory": folder})
            self.assertEqual(updated["saveDirectory"], os.path.realpath(folder))
            self.assertEqual(config["root"], "unchanged")
            with self.assertRaises(ValueError): prefs.update_preferences(config, {"saveDirectory":"relative"})
            with self.assertRaises(ValueError): prefs.update_preferences(config, {"saveDirectory":folder+"/absent"})

    def test_copy_uses_unique_names_and_keeps_original_byte_identical(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base,"library");target=Path(base,"desktop");root.mkdir();target.mkdir()
            src=root/"clip.mp4";data=b"test-media\x00"*100;src.write_bytes(data)
            original=src.stat()
            (target/src.name).write_bytes(b"do not replace")
            result=prefs.copy_out(str(src),str(target),str(root))
            self.assertTrue(result["ok"]);self.assertEqual(result["name"],"clip (1).mp4")
            self.assertEqual(Path(result["path"]).read_bytes(),data)
            self.assertEqual(src.read_bytes(),data);self.assertEqual(src.stat().st_mtime_ns,original.st_mtime_ns)
            self.assertEqual((target/src.name).read_bytes(),b"do not replace")
            self.assertFalse(list(target.glob("*.part")))

    def test_parallel_copies_do_not_replace_each_other(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base,"library");target=Path(base,"desktop");root.mkdir();target.mkdir()
            source=root/"clip.mp4";source.write_bytes(b"fixture")
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                results=list(pool.map(lambda _: prefs.copy_out(str(source),str(target),str(root)),range(4)))
            self.assertEqual(len({r["path"] for r in results}),4)
            self.assertTrue(all(Path(r["path"]).read_bytes()==b"fixture" for r in results))
            self.assertEqual(len(list(target.iterdir())),4)

    def test_failure_removes_only_owned_temporary_file(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base,"library");target=Path(base,"desktop");root.mkdir();target.mkdir()
            source=root/"clip.mp4";source.write_bytes(b"fixture");other=target/"unrelated.part";other.write_bytes(b"keep")
            with mock.patch.object(prefs.os,"fsync",side_effect=OSError("simulated disk full")):
                with self.assertRaises(OSError):prefs.copy_out(str(source),str(target),str(root))
            self.assertEqual(list(target.iterdir()),[other]);self.assertEqual(source.read_bytes(),b"fixture")
            with self.assertRaises(ValueError):prefs.copy_out(str(source),str(root),str(root))

    def test_source_link_and_device_style_filename_are_rejected(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base,"library");target=Path(base,"desktop");root.mkdir();target.mkdir()
            source=root/"clip.mp4";source.write_bytes(b"fixture")
            if os.name != "nt":
                linked=root/"linked.mp4";linked.symlink_to(source)
                with self.assertRaises(ValueError):prefs.copy_out(str(linked),str(target),str(root))
                stream=root/"clip:secret.mp4";stream.write_bytes(b"fixture")
                with self.assertRaises(ValueError):prefs.copy_out(str(stream),str(target),str(root))
            self.assertFalse(list(target.iterdir()))

    def test_config_api_preserves_other_preferences_and_reports_corruption(self):
        with tempfile.TemporaryDirectory() as base:
            with mock.patch.object(server,"CONFIG_PATH_OVERRIDE",os.path.join(base,"config.json")):
                server.save_config({"lastRoot":"keep", "unknownFuture":123})
                result=server.put_preferences({"wheelVolumeStep":3})
                self.assertTrue(result["ok"])
                self.assertEqual(server.load_config_strict()["lastRoot"],"keep")
                self.assertEqual(server.load_config_strict()["unknownFuture"],123)
                Path(server.config_path()).write_text("invalid-json",encoding="utf-8")
                result=server.put_preferences({"wheelVolumeStep":4})
                self.assertFalse(result["ok"])
                self.assertEqual(Path(server.config_path()).read_text(),"invalid-json")

    def test_copy_endpoint_binds_original_library_and_uses_stored_destination(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base,"library");root.mkdir();make_full_library(str(root))
            other=Path(base,"other");other.mkdir();target=Path(base,"desktop");target.mkdir()
            state=server.AppState(str(root));identifier='a8b9823e-0811-4414-8064-b030dfc90e89'
            payload={"expectedRoot":str(root),"section":"combos","folder":"0001_aaa11111","id":identifier}
            with mock.patch.object(server,"CONFIG_PATH_OVERRIDE",str(Path(base,"config.json"))):
                server.save_config({"preferences":{"version":1,"saveDirectory":str(target)}})
                stale=state.save_copy(dict(payload,expectedRoot=str(other)))
                self.assertEqual(stale["code"],"library_changed");self.assertFalse(list(target.iterdir()))
                result=state.save_copy(payload);self.assertTrue(result.get("ok"),result)
                self.assertTrue(Path(result["path"]).is_file())
                wrong=state.save_copy(dict(payload,id="not-this-card"));self.assertFalse(wrong.get("ok"))
                self.assertEqual(len(list(target.iterdir())),1)


if __name__=="__main__": unittest.main()
