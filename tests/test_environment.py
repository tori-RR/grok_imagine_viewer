import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import urllib.request

import server


class EnvironmentTests(unittest.TestCase):
    def test_tool_probe_requires_successful_expected_banner_and_is_bounded(self):
        cases = [(0, b"ffmpeg version 9.0.2 build\n", True),
                 (1, b"ffmpeg version 9.0.2\n", False),
                 (0, b"other program\n", False), (0, b"", False)]
        for code, output, ready in cases:
            with self.subTest(code=code, output=output), mock.patch.object(server.subprocess, "run", return_value=subprocess.CompletedProcess([], code, output)) as run:
                status = server._tool_health("ffmpeg", "fixture-tool")
                self.assertEqual(status["ready"], ready)
                self.assertEqual(run.call_args.args[0], ["fixture-tool", "-version"])
                self.assertEqual(run.call_args.kwargs["timeout"], 3)
                self.assertNotIn("shell", run.call_args.kwargs)
                self.assertNotIn("fixture-tool", json.dumps(status))
        for error, reason in [(subprocess.TimeoutExpired("fixture", 3), "timeout"), (OSError("fixture"), "unusable")]:
            with mock.patch.object(server.subprocess, "run", side_effect=error):
                self.assertEqual(server._tool_health("ffprobe", "fixture"), {"ready": False, "reason": reason})

    def test_missing_and_partial_pair_never_report_ready(self):
        with mock.patch.object(server, "resolve_ffmpeg", return_value=None), mock.patch.object(server, "resolve_ffprobe", return_value=None), mock.patch.object(server.subprocess, "run") as run:
            status = server.environment_status()
            self.assertFalse(status["ffmpeg"]["ready"])
            self.assertEqual(status["ffmpeg"]["tools"]["ffmpeg"]["reason"], "missing")
            run.assert_not_called()
        with mock.patch.object(server, "resolve_ffmpeg", return_value="fixture"), mock.patch.object(server, "resolve_ffprobe", return_value=None), mock.patch.object(server.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"ffmpeg version test\n")):
            status = server.environment_status()["ffmpeg"]
            self.assertFalse(status["ready"])
            self.assertTrue(status["tools"]["ffmpeg"]["ready"])
            self.assertFalse(status["tools"]["ffprobe"]["ready"])

    @unittest.skipUnless(os.name == "nt", "Windows WinGet aliases")
    def test_new_winget_aliases_are_resolved_without_restarting_or_changing_path(self):
        with tempfile.TemporaryDirectory() as temp:
            links = Path(temp) / "Microsoft/WinGet/Links"
            links.mkdir(parents=True)
            for name in ("ffmpeg.exe", "ffprobe.exe"):
                (links / name).write_bytes(b"fixture only")
            old_path = os.environ.get("PATH")
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": temp, "ProgramFiles": temp, "VIEWER_FFMPEG": "", "VIEWER_FFPROBE": ""}), mock.patch.object(server, "load_config", return_value={}), mock.patch.object(server, "_bundled_tool", return_value=None), mock.patch.object(server.shutil, "which", return_value=None):
                self.assertEqual(Path(server.resolve_ffmpeg()), links / "ffmpeg.exe")
                self.assertEqual(Path(server.resolve_ffprobe()), links / "ffprobe.exe")
                self.assertIsNone(server._winget_tool("arbitrary-command"))
                self.assertEqual(os.environ.get("PATH"), old_path)

    def test_environment_http_check_does_not_read_a_library(self):
        expected = {"ffmpeg": {"ready": False, "tools": {}}}
        with mock.patch.object(server, "environment_status", return_value=expected), mock.patch.object(server.AppState, "library", side_effect=AssertionError("must not read a library")):
            httpd = server.ViewerHTTPServer(("127.0.0.1", 0), server.make_handler(server.AppState(None)))
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_port}/api/environment", timeout=5) as response:
                    self.assertEqual(json.load(response), expected)
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(5)

    def test_new_install_invalidates_only_tool_snapshot_and_enables_cover_requests(self):
        cached = {"ffmpeg": "", "ffprobe": "", "covers": False}
        with mock.patch.object(server, "_accel_state", cached), mock.patch.object(server, "_accel_generation", 0), mock.patch.object(server, "resolve_ffmpeg", return_value="fixture-ffmpeg"), mock.patch.object(server, "resolve_ffprobe", return_value="fixture-ffprobe"), mock.patch.object(server, "_tool_health", return_value={"ready": True}), mock.patch.object(server, "load_config", return_value={}), mock.patch.object(server, "probe_hwaccels", return_value=[]), mock.patch.object(server, "probe_gpu", return_value=""), mock.patch.object(server, "save_config_patch") as save:
            self.assertTrue(server.environment_status()["ffmpeg"]["ready"])
            self.assertIsNone(server._accel_state)
            self.assertTrue(server.accel_state()["covers"])
            self.assertEqual(server.accel_state()["ffprobe"], "fixture-ffprobe")
            snapshot = server._accel_state
            server.environment_status()
            self.assertIs(server._accel_state, snapshot, "an unchanged check keeps current observations")
            save.assert_not_called()
