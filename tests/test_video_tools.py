import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

import server

spec = importlib.util.spec_from_file_location("install_video_tools", Path(__file__).resolve().parents[1] / "scripts/install_video_tools.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(os.name == "nt", "Windows portable video tools")
class OptionalVideoToolsTests(unittest.TestCase):
    def make_archive(self, root):
        archive = root / "tools.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            for source, target in installer.MEMBERS.items():
                bundle.writestr(f"ffmpeg-{installer.VERSION}/{source}", target.encode())
            bundle.writestr(f"ffmpeg-{installer.VERSION}/bin/ffplay.exe", b"must not install")
            bundle.writestr("../../outside.txt", b"must not extract")
        return archive

    def test_only_selected_tools_are_installed_and_existing_files_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = self.make_archive(root)
            destination = root / "app/video-tools"
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            with mock.patch.object(installer, "SHA256", digest):
                installer.install_archive(archive, destination)
                self.assertEqual(set(p.name for p in destination.iterdir()), {*installer.MEMBERS.values(), "component.json"})
                self.assertFalse((root / "outside.txt").exists())
                installer.install_archive(Path("unused"), destination)
                (destination / "notes.txt").write_text("keep me")
                (destination / "ffmpeg.exe").write_bytes(b"changed fixture")
                with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                    installer.install_archive(archive, destination)
                self.assertEqual((destination / "notes.txt").read_text(), "keep me")
                self.assertEqual((destination / "ffmpeg.exe").read_bytes(), b"changed fixture")

    def test_wrong_download_hash_installs_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = self.make_archive(root)
            with mock.patch.object(installer, "SHA256", "0" * 64):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    installer.install_archive(archive, root / "video-tools")
            self.assertFalse((root / "video-tools").exists())

    def test_portable_viewer_resolves_optional_pair_without_path_or_config_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            viewer = root / "viewer"
            viewer.mkdir()
            (root / "video-tools").mkdir()
            for name in ["ffmpeg.exe", "ffprobe.exe"]:
                (root / "video-tools" / name).write_bytes(b"fixture only")
            with mock.patch.object(server, "REPO_DIR", str(viewer)), mock.patch.object(server, "load_config", return_value={}), mock.patch.dict(os.environ, {"VIEWER_FFMPEG": "", "VIEWER_FFPROBE": ""}):
                self.assertEqual(Path(server.resolve_ffmpeg()), root / "video-tools/ffmpeg.exe")
                self.assertEqual(Path(server.resolve_ffprobe()), root / "video-tools/ffprobe.exe")
