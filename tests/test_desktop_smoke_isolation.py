"""Native smoke must reject older or mixed packages before starting any EXE."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import stack_evo_desktop_smoke as smoke


class NativeSmokeBoundaryTests(unittest.TestCase):
    def test_manifest_only_accepts_program_resources(self):
        for name in ("grok-imagine-viewer-tauri.exe", "viewer/giv-backend.exe", "viewer/static/assets/app.js"):
            self.assertTrue(smoke.program_file(name))
        for name in ("../secret", "viewer/static/../../secret", "gallery-webview2/Cookies", "grok-webview2/Cookies", "viewer/../grok-webview2/Cookies", "/viewer/static/x"):
            self.assertFalse(smoke.program_file(name), name)

    @unittest.skipUnless(os.name == "nt", "Windows filesystem guard")
    def test_old_package_is_rejected_without_starting_program(self):
        with tempfile.TemporaryDirectory(prefix="giv-native-guard-") as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            (package / "release-manifest.json").write_text(json.dumps(dict(schema=1, backend="go", files={})))
            out = root / "evidence"
            with patch("sys.argv", ["smoke", "--package", str(package), "--out", str(out)]), patch.object(smoke.subprocess, "Popen") as process:
                with self.assertRaisesRegex(AssertionError, "predates safe native smoke"):
                    smoke.main()
                process.assert_not_called()
            self.assertFalse(out.exists())

    @unittest.skipUnless(os.name == "nt", "Windows filesystem guard")
    def test_mixed_old_executable_cannot_claim_new_isolation(self):
        with tempfile.TemporaryDirectory(prefix="giv-native-guard-") as directory:
            root = Path(directory)
            package = root / "package"
            files = {"grok-imagine-viewer-tauri.exe": b"old program, never execute", "viewer/giv-backend.exe": b"fixture", "viewer/static/index.html": b"fixture"}
            hashes = {}
            for name, data in files.items():
                path = package / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                hashes[name] = hashlib.sha256(data).hexdigest()
            (package / "release-manifest.json").write_text(json.dumps(dict(schema=1, backend="go", nativeSmokeProtocol=1, files=hashes)))
            out = root / "evidence"
            with patch("sys.argv", ["smoke", "--package", str(package), "--out", str(out)]), patch.object(smoke.subprocess, "Popen") as process:
                with self.assertRaisesRegex(AssertionError, "does not declare native smoke isolation"):
                    smoke.main()
                process.assert_not_called()
            self.assertFalse(out.exists())


if __name__ == "__main__": unittest.main()
