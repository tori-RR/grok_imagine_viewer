"""Dedup destructive paths run only against generated temporary libraries."""
import errno
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import server
from tests.test_server import COMBO1_FILE, make_full_library


class DedupSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="giv-dedup-safety-")
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        make_full_library(self.root)
        self.keep = Path(self.root, "combos", "0001_aaa11111", COMBO1_FILE)
        self.old = Path(self.root, "combos", "0120_aaa11111", COMBO1_FILE)
        self.old.parent.mkdir()
        self.old.write_bytes(self.keep.read_bytes())
        self.state = server.AppState(self.root)

    def preview(self):
        result = self.state.library_dedup({"expectedRoot": self.root})
        self.assertTrue(result.get("ok"), result)
        return result

    def apply(self, action="keep_newest", plan=None, actions=None):
        plan = plan or self.preview()
        if actions is None:
            actions = {plan["groups"][0]["key"]: action}
        return self.state.library_dedup({"expectedRoot": self.root, "apply": True,
                                        "planToken": plan["planToken"], "actions": actions})

    def quarantined(self):
        result = self.apply()
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["moved"]), 1)
        return result["moved"][0]

    def mutation(self, method, copy_id):
        return getattr(self.state, method)({"expectedRoot": self.root, "ids": [copy_id]})

    def test_complete_bytes_not_head_tail_sampling(self):
        self.keep.write_bytes(b"A" * 65536 + b"X" * 65536 + b"Z" * 65536)
        self.old.write_bytes(b"A" * 65536 + b"Y" * 65536 + b"Z" * 65536)
        plan = self.preview()
        self.assertFalse(plan["groups"][0]["identical"])
        result = self.apply(plan=plan)
        self.assertEqual(result["moved"], [])
        self.assertTrue(self.old.is_file())

    def test_missing_token_refused_and_omitted_selection_skipped(self):
        result = self.state.library_dedup({"expectedRoot": self.root, "apply": True,
                                          "actions": {"combos/aaa11111": "keep_newest"}})
        self.assertEqual(result["status"], 409)
        result = self.apply(actions={})
        self.assertEqual(result["moved"], [])
        self.assertTrue(self.old.is_file())

    def test_keep_newest_only_quarantines_identical_and_preserves_unique_media(self):
        unique = self.old.parent / "unique.jpg"
        unique.write_bytes(b"only copy with its own prompt")
        card = self.old.parent / "card.json"
        original_card = json.dumps({"folder": self.old.parent.name, "items": [
            {"id": self.old.stem, "file": self.old.name, "prompt": "duplicate"},
            {"id": "unique", "file": unique.name, "prompt": "keep this metadata"}]})
        card.write_text(original_card, encoding="utf-8")
        plan = self.preview()
        self.assertFalse(plan["groups"][0]["identical"])
        result = self.apply(plan=plan)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["moved"]), 1)
        self.assertTrue(unique.is_file())
        self.assertFalse((self.keep.parent / unique.name).exists())
        self.assertEqual(card.read_text(encoding="utf-8"), original_card)

    def test_stale_preview_rejects_content_change_even_if_size_and_mtime_match(self):
        plan = self.preview()
        stamp = self.old.stat()
        original = self.old.read_bytes()
        self.old.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        os.utime(self.old, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        result = self.apply(plan=plan)
        self.assertEqual(result["code"], "dedup_plan_changed")
        self.assertTrue(self.old.exists())

    def test_new_group_not_in_preview_cannot_be_selected(self):
        plan = self.preview()
        result = self.apply(plan=plan, actions={"_other/bbbb2222": "keep_newest"})
        self.assertEqual(result["status"], 409)
        self.assertTrue(self.old.exists())

    def test_token_is_single_use_and_root_generation_bound(self):
        plan = self.preview()
        self.apply(plan=plan, actions={})
        self.assertEqual(self.apply(plan=plan)["status"], 409)
        plan = self.preview()
        self.state.set_root(self.root, persist_if_ok=False)
        self.assertEqual(self.apply(plan=plan)["status"], 409)

    def test_copy_is_listed_without_hiding_retained_asset_and_can_restore(self):
        before = self.state.combo("combos", "0001_aaa11111")["items"][0]["prompt"]
        row = self.quarantined()
        self.assertEqual(row["scope"], "copy")
        self.assertEqual(row["assetId"], self.keep.stem)
        self.assertFalse(Path(self.root, ".trash", "by-id", self.keep.stem + ".json").exists())
        self.assertFalse(Path(str(self.old) + ".trashed").exists())
        self.assertTrue(self.keep.exists())
        flat = self.state.flat()["items"]
        self.assertTrue(any(it["id"] == self.keep.stem and it["folder"] == "0001_aaa11111" for it in flat))
        self.assertEqual(self.state.combo("combos", "0001_aaa11111")["items"][0]["prompt"], before)
        self.state = server.AppState(self.root)  # restart with no in-memory plan
        rows = self.state.trash_list()["items"]
        self.assertEqual([it["id"] for it in rows], [row["id"]])
        self.assertEqual(Path(self.state.resolve_trash_file(row["id"])).read_bytes(), self.keep.read_bytes())
        restored = self.mutation("trash_restore", row["id"])
        self.assertEqual(restored["errors"], [])
        self.assertEqual(restored["restored"], [row["id"]])
        self.assertEqual(self.old.read_bytes(), self.keep.read_bytes())
        self.assertEqual(self.state.trash_list()["items"], [])

    def test_purge_copy_does_not_create_global_tombstone(self):
        row = self.quarantined()
        result = self.mutation("trash_purge", row["id"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["purged"], [row["id"]])
        self.assertTrue(self.keep.is_file())
        self.assertFalse(server.item_is_trashed(self.root, {"id": self.keep.stem, "file": COMBO1_FILE}))
        self.assertEqual(self.state.trash_list()["items"], [])

    def test_conflicting_restore_does_not_replace_live_file(self):
        row = self.quarantined()
        self.old.write_bytes(b"belongs to user")
        result = self.mutation("trash_restore", row["id"])
        self.assertEqual(len(result["conflicts"]), 1)
        self.assertEqual(self.old.read_bytes(), b"belongs to user")
        self.assertEqual(len(self.state.trash_list()["items"]), 1)

    def test_same_asset_in_multiple_old_folders_has_independent_copy_records(self):
        another = Path(self.root, "combos", "0130_aaa11111", COMBO1_FILE)
        another.parent.mkdir()
        another.write_bytes(self.keep.read_bytes())
        result = self.apply()
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["moved"]), 2)
        self.assertEqual(len({row["id"] for row in result["moved"]}), 2)
        self.assertEqual(len(self.state.trash_list()["items"]), 2)
        for row in result["moved"]:
            self.assertEqual(self.mutation("trash_restore", row["id"])["errors"], [])
        self.assertTrue(self.old.is_file())
        self.assertTrue(another.is_file())

    def test_binding_tamper_blocks_restore_purge_and_preview(self):
        row = self.quarantined()
        binding = Path(self.root, ".trash", "copies", row["token"], "binding.json")
        data = json.loads(binding.read_text(encoding="utf-8"))
        data["folder"] = "0001_aaa11111"
        binding.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.state.trash_list()["items"], [])
        self.assertTrue(self.mutation("trash_restore", row["id"])["errors"])
        self.assertTrue(self.mutation("trash_purge", row["id"])["errors"])
        self.assertTrue(Path(self.root, *row["to"].split("/")).exists())

    def test_corrupt_body_same_stat_refuses_restore_and_purge(self):
        row = self.quarantined()
        body = Path(self.root, *row["to"].split("/"))
        stamp = body.stat()
        data = body.read_bytes()
        body.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        os.utime(body, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertTrue(self.mutation("trash_restore", row["id"])["errors"])
        self.assertTrue(self.mutation("trash_purge", row["id"])["errors"])
        self.assertTrue(body.exists())
        self.assertFalse(self.old.exists())
        record = Path(self.root, ".trash", "copies", row["token"], "record.json")
        self.assertEqual(json.loads(record.read_text(encoding="utf-8"))["phase"], "trashed")

    @staticmethod
    def corrupt_preserving_stat(path):
        path = Path(path)
        stamp, data = path.stat(), path.read_bytes()
        path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))

    def test_restore_post_move_hash_failure_keeps_restoring_record(self):
        row = self.quarantined()
        move = self.state._move_regular_no_replace_verified
        def corrupt_after_move(src, dest, expected=None):
            move(src, dest, expected)
            self.corrupt_preserving_stat(dest)
        with mock.patch.object(self.state, "_move_regular_no_replace_verified", side_effect=corrupt_after_move):
            result = self.mutation("trash_restore", row["id"])
        self.assertTrue(result["errors"])
        self.assertEqual(result["restored"], [])
        directory = Path(self.root, ".trash", "copies", row["token"])
        self.assertTrue((directory / "binding.json").is_file())
        self.assertEqual(json.loads((directory / "record.json").read_text(encoding="utf-8"))["phase"], "restoring")

    def test_quarantine_post_move_hash_failure_keeps_trashing_record(self):
        move = self.state._move_regular_no_replace_verified
        def corrupt_after_move(src, dest, expected=None):
            move(src, dest, expected)
            self.corrupt_preserving_stat(dest)
        with mock.patch.object(self.state, "_move_regular_no_replace_verified", side_effect=corrupt_after_move):
            result = self.apply()
        self.assertTrue(result["errors"])
        self.assertEqual(result["moved"], [])
        records = list(Path(self.root, ".trash", "copies").glob("*/record.json"))
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0].read_text(encoding="utf-8"))["phase"], "trashing")
        self.assertTrue((records[0].parent / "binding.json").exists())
        self.assertTrue(self.keep.is_file())

    def assert_merge_publish_corruption_preserves_source(self, unique):
        source = self.old.parent / "unique.jpg" if unique else self.old
        source.write_bytes(b"valid unique source" if unique else b"different valid source")
        source_before, keep_before = source.read_bytes(), self.keep.read_bytes()
        move = server.AppState._move_regular_no_replace_verified
        def corrupt_staged_publish(src, dest, expected=None):
            move(src, dest, expected)
            if Path(src).name.startswith(".dedup-stage-"):
                self.corrupt_preserving_stat(dest)
        with mock.patch.object(server.AppState, "_move_regular_no_replace_verified", side_effect=corrupt_staged_publish):
            result = self.apply(action="merge")
        self.assertTrue(any("dedup_copy_publish_changed" in row["error"] for row in result["errors"]), result)
        self.assertEqual(source.read_bytes(), source_before)
        self.assertEqual(self.keep.read_bytes(), keep_before)
        self.assertFalse(any(row["assetId"] == source.stem for row in result["moved"]), result)
        retained = [path for path in self.keep.parent.iterdir()
                    if path.name == "unique.jpg" or "~n" in path.name]
        self.assertEqual(len(retained), 1)
        self.assertNotEqual(retained[0].read_bytes(), source_before)
        self.assertFalse(Path(str(source) + ".trashed").exists())

    def test_merge_unique_publish_corruption_does_not_quarantine_good_source(self):
        self.assert_merge_publish_corruption_preserves_source(unique=True)

    def test_merge_conflict_publish_corruption_does_not_quarantine_good_source(self):
        self.assert_merge_publish_corruption_preserves_source(unique=False)

    def test_copy_parent_reparse_is_refused_without_moving_source(self):
        plan = self.preview()
        # Production resolves the root before walking entries. Windows temp
        # paths may use an 8.3 alias; inject at the same canonical spelling.
        copies = Path(os.path.realpath(self.root), ".trash", "copies")
        copies.mkdir(parents=True)
        lstat = os.lstat
        injected = []
        def reparse(path, *args, **kwargs):
            info = lstat(path, *args, **kwargs)
            if os.path.normcase(str(path)) == os.path.normcase(str(copies)):
                injected.append(path)
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with mock.patch.object(server.os, "lstat", side_effect=reparse):
            result = self.apply(plan=plan)
        self.assertTrue(injected, "The reparse fixture must reach the canonical entry")
        self.assertTrue(result["errors"])
        self.assertTrue(self.old.is_file())
        self.assertTrue(self.keep.is_file())

    def test_existing_asset_tombstone_and_marker_are_never_repaired_by_guess(self):
        path = Path(self.root, ".trash", "by-id", self.keep.stem + ".json")
        path.parent.mkdir(parents=True)
        raw = json.dumps({"id": self.keep.stem, "phase": "trashed"})
        path.write_text(raw, encoding="utf-8")
        self.assertEqual(self.preview()["groups"], [])
        self.assertEqual(path.read_text(encoding="utf-8"), raw)
        self.assertTrue(self.keep.exists())
        self.assertTrue(self.old.exists())

    def test_truncated_unseen_groups_are_not_implicitly_applied(self):
        with mock.patch.object(server, "_DEDUP_PREVIEW_LIMIT", 0):
            plan = self.preview()
            self.assertTrue(plan["truncated"])
            self.assertEqual(plan["groups"], [])
            result = self.apply(plan=plan, actions={})
        self.assertEqual(result["moved"], [])
        self.assertTrue(self.old.exists())

    def test_corrupt_index_never_demotes_formal_folders_to_leftovers(self):
        Path(self.root, "_index.json").write_text("{broken", encoding="utf-8")
        result = server.plan_library_dedup(self.root)
        self.assertFalse(result["ok"])
        self.assertTrue(self.keep.exists())
        self.assertTrue(self.old.exists())

    def test_interrupted_final_record_is_recoverable_after_restart(self):
        original = self.state._write_controlled_tombstone
        def fail_final(snap, tomb, phase):
            if phase == "trashed" and tomb.get("scope") == "copy":
                raise OSError("fixture interruption after move")
            return original(snap, tomb, phase)
        with mock.patch.object(self.state, "_write_controlled_tombstone", side_effect=fail_final):
            result = self.apply()
        self.assertTrue(result["errors"])
        self.assertFalse(self.old.exists())
        self.state = server.AppState(self.root)
        rows = self.state.trash_list()["items"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["phase"], "trashing")
        self.assertEqual(self.mutation("trash_restore", rows[0]["id"])["errors"], [])
        self.assertTrue(self.old.exists())

    def test_other_summary_combo_cards_and_flat_share_disk_members(self):
        folder = Path(self.root, "_other", "0998_dup")
        folder.mkdir(parents=True)
        (folder / COMBO1_FILE).write_bytes(b"different version of same id")
        (folder / "orphan.jpg").write_bytes(b"orphan")
        (folder / "card.json").write_text(json.dumps({"folder": folder.name, "items": [
            {"id": self.keep.stem, "file": COMBO1_FILE, "prompt": "preserved"},
            {"id": "missing", "file": "missing.jpg"}]}), encoding="utf-8")
        lib = self.state.library()
        row = next(it for it in lib["other"] if it["folder"] == folder.name)
        combo = self.state.combo("_other", folder.name)
        card = self.state.cards("_other", [folder.name])["cards"][0]
        flat = [it for it in self.state.flat()["items"] if it["section"] == "_other" and it["folder"] == folder.name]
        self.assertEqual(row["count"], 2)
        self.assertEqual(card["count"], 2)
        self.assertEqual({it["file"] for it in combo["items"]}, {COMBO1_FILE, "orphan.jpg"})
        self.assertEqual({it["file"] for it in flat}, {COMBO1_FILE, "orphan.jpg"})
        self.assertEqual(next(it for it in flat if it["file"] == COMBO1_FILE)["prompt"], "preserved")

    def test_same_stem_different_extensions_are_not_silently_discarded(self):
        (self.old.parent / (self.old.stem + ".mp4")).write_bytes(b"a video")
        self.assertEqual(self.preview()["groups"], [])
        self.assertTrue(self.old.exists())

    def test_single_conversation_folders_do_not_hash_all_library_media(self):
        self.old.unlink()
        with mock.patch.object(server, "dedup_media_fingerprint", wraps=server.dedup_media_fingerprint) as hashed:
            self.preview()
        self.assertTrue(all("aaa11111" in str(call.args[0]) for call in hashed.call_args_list))

    def test_cover_fingerprint_stays_stat_only_and_uses_cache_contract(self):
        with mock.patch("builtins.open", side_effect=AssertionError("cover must not read media bytes")):
            fingerprint = server.media_fingerprint(self.keep)
        self.assertEqual(fingerprint, {"size": self.keep.stat().st_size,
                                       "mtime_ns": self.keep.stat().st_mtime_ns})
        self.assertEqual(set(server.dedup_media_fingerprint(self.keep)), {"size", "mtimeNs", "ino", "dev", "hash"})


class TrashListFastPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="giv-trash-list-")
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        make_full_library(self.root)
        self.state = server.AppState(self.root)
        result = self.state.trash_add({"expectedRoot": self.root, "section": "combos",
                                       "folder": "0001_aaa11111", "ids": [Path(COMBO1_FILE).stem]})
        self.assertEqual(result["errors"], [])
        self.tomb = result["moved"][0]
        self.asset_id = self.tomb["id"]
        self.body = Path(self.root, *self.tomb["to"].split("/"))
        self.snap = self.state.snapshot()

    def test_purged_record_skips_card_and_marker_reads(self):
        result = self.state.trash_purge({"expectedRoot": self.root, "ids": [self.asset_id]})
        self.assertEqual(result["errors"], [])
        with mock.patch.object(self.state, "snapshot", return_value=self.snap), \
             mock.patch.object(self.state, "_validated_tombstone_rels", side_effect=AssertionError("empty row must not read card")), \
             mock.patch.object(server, "read_json", wraps=server.read_json) as reads:
            listed = self.state.trash_list()
        self.assertEqual(listed["items"], [])
        self.assertEqual(reads.call_count, 1)  # record only, no card or binding

    def test_missing_body_skips_full_validation_even_without_purged_phase(self):
        self.body.unlink()  # generated fixture simulates an externally missing body
        with mock.patch.object(self.state, "snapshot", return_value=self.snap), \
             mock.patch.object(self.state, "_validated_tombstone_rels", side_effect=AssertionError("missing body")):
            self.assertEqual(self.state.trash_list()["items"], [])

    def test_existing_body_still_reads_card_and_validates_marker_without_hashing(self):
        with mock.patch.object(self.state, "snapshot", return_value=self.snap), \
             mock.patch.object(self.state, "_validated_tombstone_rels", wraps=self.state._validated_tombstone_rels) as validated, \
             mock.patch.object(self.state, "_read_controlled_marker", wraps=self.state._read_controlled_marker) as marker, \
             mock.patch.object(server, "dedup_media_fingerprint", side_effect=AssertionError("list must not hash media")):
            listed = self.state.trash_list()
        self.assertEqual([row["id"] for row in listed["items"]], [self.asset_id])
        self.assertGreaterEqual(validated.call_count, 1)
        self.assertGreaterEqual(marker.call_count, 1)

    def test_permission_and_network_errors_are_not_missing_body_proof(self):
        lstat = os.lstat
        for failure in (PermissionError(errno.EACCES, "fixture denied"), OSError(errno.EIO, "fixture network error")):
            def unavailable(path, *args, **kwargs):
                if os.path.normcase(str(path)) == os.path.normcase(str(self.body)):
                    raise failure
                return lstat(path, *args, **kwargs)
            with self.subTest(error=type(failure).__name__), \
                 mock.patch.object(server.os, "lstat", side_effect=unavailable), \
                 mock.patch.object(self.state, "snapshot", return_value=self.snap), \
                 mock.patch.object(self.state, "_validated_tombstone_rels", wraps=self.state._validated_tombstone_rels) as validated:
                self.assertFalse(self.state._readonly_trash_body_missing(self.snap, self.asset_id, self.tomb))
                self.state.trash_list()
                self.assertGreaterEqual(validated.call_count, 1)
        self.assertTrue(self.body.exists())

    def test_unbound_path_does_not_get_missing_body_shortcut(self):
        malicious = dict(self.tomb, to=".trash/../../outside.jpg")
        with mock.patch.object(server.os, "lstat", side_effect=AssertionError("unbound path must not be probed")):
            self.assertFalse(self.state._readonly_trash_body_missing(self.snap, self.asset_id, malicious))

    def test_restore_never_uses_list_only_shortcut(self):
        with mock.patch.object(self.state, "_readonly_trash_body_missing", side_effect=AssertionError("mutation must fully validate")):
            result = self.state.trash_restore({"expectedRoot": self.root, "ids": [self.asset_id]})
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["restored"], [self.asset_id])


if __name__ == "__main__":
    unittest.main()
