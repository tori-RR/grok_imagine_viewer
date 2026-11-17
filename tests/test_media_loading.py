"""Bounded duration reads: one clip must not open the entire sidecar directory."""
import inspect
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

import server
from tests.test_server import make_full_library, COMBO2_MP4


class DurationLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="giv-duration-scope-")
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.config = mock.patch.object(server, "CONFIG_PATH_OVERRIDE", os.path.join(self.root, "unused-config.json"))
        self.config.start()
        self.addCleanup(self.config.stop)
        server.invalidate_duration_index()
        self.addCleanup(server.invalidate_duration_index)
        os.makedirs(server.cover_cache_dir(self.root))

    def sidecar(self, asset_id, duration, **extra):
        path = server.cover_meta_path(self.root, asset_id)
        with open(path, "w", encoding="utf-8") as stream:
            json.dump({"duration": duration, **extra}, stream)

    def test_reads_only_requested_safe_ids_and_does_not_publish_partial_cache(self):
        self.sidecar("wanted", 6.5)
        for i in range(80):
            self.sidecar("unrelated-" + str(i), i + 1)
        with mock.patch.object(server, "_build_duration_index", side_effect=AssertionError("full scan forbidden")), \
                mock.patch.object(server, "read_cover_meta", wraps=server.read_cover_meta) as read:
            found = server.duration_lookup(self.root, ["wanted", "wanted", "absent", "../escape", "a/b", "a\\b", None, 3, ""])
        self.assertEqual(found, {"wanted": 6.5})
        self.assertEqual({call.args[1] for call in read.call_args_list}, {"wanted", "absent"})
        self.assertEqual(read.call_count, 2)
        self.assertNotIn(os.path.abspath(self.root), server._duration_cache)
        self.assertEqual(len(server.duration_index(self.root)), 81, "a partial lookup cannot suppress later full-library duration loading")

    def test_existing_complete_cache_is_reused_but_invalidated_cache_is_not(self):
        self.sidecar("wanted", 6)
        self.sidecar("unrelated", 8)
        server.duration_index(self.root)
        with mock.patch.object(server, "read_cover_meta", side_effect=AssertionError("cache should satisfy the lookup")), \
                mock.patch.object(server, "_build_duration_index", side_effect=AssertionError("no new full scan")):
            found = server.duration_lookup(self.root, ["wanted", "unknown"])
        self.assertEqual(found, {"wanted": 6.0})
        self.assertTrue(server.write_duration_only(self.root, "wanted", 9.25))
        with mock.patch.object(server, "_build_duration_index", side_effect=AssertionError("partial refresh stays bounded")):
            self.assertEqual(server.duration_lookup(self.root, ["wanted"]), {"wanted": 9.25})

    def test_unknown_and_invalid_sidecars_match_full_index_acceptance(self):
        for name, value in {"good": 2.75, "zero": 0, "negative": -1, "text": "3", "null": None, "nan": float("nan"), "object": {}}.items():
            self.sidecar(name, value)
        Path(server.cover_meta_path(self.root, "corrupt")).write_text("{", encoding="utf-8")
        wanted = ["good", "zero", "negative", "text", "null", "nan", "object", "corrupt", "missing"]
        found = server.duration_lookup(self.root, wanted)
        self.assertEqual(found, {"good": 2.75})
        self.assertEqual(found, server.duration_index(self.root))
        with mock.patch.object(server, "read_cover_meta", side_effect=AssertionError("empty lookup must not touch disk")):
            self.assertEqual(server.duration_lookup(self.root, []), {})
            self.assertEqual(server.duration_lookup("", ["good"]), {})

    def test_reencoded_media_keeps_existing_cover_freshness_and_duration_invalidation(self):
        asset_id = "fixture-video"
        src = Path(self.root) / "fixture.mp4"
        src.write_bytes(b"first fixture media")
        still = Path(server.cover_cache_path(self.root, asset_id))
        still.write_bytes(b"cached fixture still")
        fingerprint = server.media_fingerprint(str(src))
        self.sidecar(asset_id, 6.5, **fingerprint)
        self.assertEqual(server.cover_cache_hit(self.root, asset_id, str(src)), str(still))
        server.duration_index(self.root)
        src.write_bytes(b"re-encoded fixture media with a different size")
        self.assertIsNone(server.cover_cache_hit(self.root, asset_id, str(src)))
        # Duration-only reads keep their established sidecar semantics; they
        # must not make a stale JPEG fresh or bypass the source stat check.
        self.assertEqual(server.duration_lookup(self.root, [asset_id]), {asset_id: 6.5})
        self.assertTrue(server.write_duration_only(self.root, asset_id, 8.25, src=str(src)))
        self.assertEqual(server.duration_lookup(self.root, [asset_id]), {asset_id: 8.25})
        self.assertIsNone(server.cover_cache_hit(self.root, asset_id, str(src)))

    def test_combo_and_live_card_never_build_the_full_duration_index(self):
        make_full_library(self.root)
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        self.sidecar(video_id, 7.5)
        self.sidecar("unrelated", 90)
        state = server.AppState(self.root)
        with mock.patch.object(server, "duration_index", side_effect=AssertionError("one combo cannot scan all sidecars")), \
                mock.patch.object(server, "read_cover_meta", wraps=server.read_cover_meta) as read:
            combo = state.combo("combos", "0002_bbb22222")
            self.assertTrue(combo["ok"])
            video = next(item for item in combo["items"] if item["id"] == video_id)
            self.assertEqual(video["duration"], 7.5)
            self.assertEqual({call.args[1] for call in read.call_args_list}, {video_id})
            read.reset_mock()
            meta = {"groups": {"combos/0002_bbb22222": {"lastViewedId": video_id}}, "items": {}}
            live = server.live_card_stats(self.root, "index", "combos", "0002_bbb22222", meta=meta)
            self.assertEqual(live["summary"]["duration"], 7.5)
            self.assertEqual({call.args[1] for call in read.call_args_list}, {video_id})
            read.reset_mock()
            state.combo("combos", "0001_aaa11111")
            self.assertEqual(read.call_count, 0, "an image-only combo needs no duration sidecars")

    def test_single_cover_head_prepare_and_duration_queue_stay_bounded(self):
        make_full_library(self.root)
        video_id = "cccccccc-3333-4333-8333-cccccccccccc"
        src = os.path.join(self.root, "combos", "0002_bbb22222", COMBO2_MP4)
        self.sidecar(video_id, 5.75, **server.media_fingerprint(src))
        Path(server.cover_cache_path(self.root, video_id)).write_bytes(b"cached fixture still")
        item = {"id": video_id, "file": COMBO2_MP4, "media": "video", "mime": "video/mp4"}
        target = {"root": self.root, "section": "combos", "folder": "0002_bbb22222", "candidates": [item]}
        handler = object.__new__(server.ViewerHandler)
        handler.state = types.SimpleNamespace(cover_target=lambda *_: target, resolve_media=lambda *_: src)
        with mock.patch.object(server, "duration_index", side_effect=AssertionError("single resource must not scan all durations")), \
                mock.patch.object(server, "send_file") as send_file, \
                mock.patch.object(server, "send_json") as send_json, \
                mock.patch.object(server.DURATIONS, "enqueue", side_effect=AssertionError("known duration must not queue a probe")), \
                mock.patch.object(server.COVERS, "enqueue", side_effect=AssertionError("fresh cover must not queue extraction")):
            handler._cover({"section": ["combos"], "folder": ["0002_bbb22222"], "id": [video_id]}, True)
            self.assertIn(("X-Cover-Duration", "5.750"), send_file.call_args.kwargs["extra_headers"])
            handler._prepare_cover({"section": "combos", "folder": "0002_bbb22222", "id": video_id})
            self.assertFalse(send_json.call_args.args[1]["queued"])
        with mock.patch.object(server, "duration_index", side_effect=AssertionError("enqueue check must be bounded")), \
                mock.patch.object(server, "accel_state", return_value={"ffprobe": "fixture-only"}):
            self.assertFalse(server.DurationQueue().enqueue(self.root, src, video_id))
        self.assertIn("duration_index(", inspect.getsource(server.AppState.flat), "the full flat listing keeps the shared full-cache contract")


if __name__ == "__main__":
    unittest.main()
