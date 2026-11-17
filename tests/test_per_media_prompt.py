"""Per-media prompt read compatibility, using generated local media only."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_server import _write_json, write_tiny_jpeg, write_tiny_mp4
import server


class PerMediaPromptTests(unittest.TestCase):
    def fixture(self, directory, *, missing_video_prompt=False):
        root = Path(directory) / "gallery"
        group = root / "combos" / "0007_existing"
        group.mkdir(parents=True)
        prompts = {"image-one": "  first image\nkeep whitespace  ",
                   "image-two": "第二张图片 <literal> & 独立提示词",
                   "video-three": "Different video prompt 🎬"}
        items = []
        for index, ident in enumerate(prompts):
            video = ident == "video-three"
            filename = ident + (".mp4" if video else ".jpg")
            (write_tiny_mp4 if video else write_tiny_jpeg)(str(group / filename))
            item = dict(id=ident, file=filename, mime="video/mp4" if video else "image/jpeg",
                        created=f"2026-01-0{index+1}T00:00:00Z", status="linked")
            if not (video and missing_video_prompt):
                item["prompt"] = prompts[ident]
            items.append(item)
        card = dict(id="conversation-existing", n=7, folder=group.name,
                    title="Original group title stays a group title", items=items)
        _write_json(str(group / "card.json"), card)
        _write_json(str(root / "_index.json"), dict(combos=[dict(id=card["id"], n=7,
                    folder=group.name, title=card["title"], count=3)], other=[], summary={}))
        config = Path(directory) / "config.json"
        _write_json(str(config), {})
        return root, group, config, prompts, card["title"]

    @staticmethod
    def fingerprints(root):
        return {str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
                for path in root.rglob("*") if path.is_file()}

    def test_combo_and_flat_keep_each_prompt_without_rewriting(self):
        with tempfile.TemporaryDirectory(prefix="giv-per-media-prompt-") as directory:
            root, group, config, prompts, title = self.fixture(directory)
            before = self.fingerprints(Path(directory))
            with patch.object(server, "CONFIG_PATH_OVERRIDE", str(config)):
                state = server.AppState(str(root))
                combo = state.combo("combos", group.name)
                flat = state.flat()
            self.assertTrue(combo["ok"])
            self.assertTrue(flat["ok"])
            self.assertEqual(combo["card"]["title"], title)
            for result in (combo, flat):
                self.assertEqual({item["id"]: item["prompt"] for item in result["items"]}, prompts)
                self.assertTrue(all(item["title"] == title for item in result["items"]))
            self.assertEqual(self.fingerprints(Path(directory)), before)

    def test_missing_prompt_does_not_inherit_group_or_another_item(self):
        with tempfile.TemporaryDirectory(prefix="giv-per-media-prompt-empty-") as directory:
            root, group, config, prompts, _ = self.fixture(directory, missing_video_prompt=True)
            before = self.fingerprints(Path(directory))
            with patch.object(server, "CONFIG_PATH_OVERRIDE", str(config)):
                state = server.AppState(str(root))
                responses = (state.combo("combos", group.name), state.flat())
            prompts["video-three"] = ""
            for result in responses:
                self.assertTrue(result["ok"])
                self.assertEqual({item["id"]: item["prompt"] for item in result["items"]}, prompts)
            self.assertEqual(self.fingerprints(Path(directory)), before)


if __name__ == "__main__":
    unittest.main()
