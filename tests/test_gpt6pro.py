"""Beta regressions use disposable fixture directories only."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
import server
from tests.test_server import make_full_library, write_tiny_jpeg, write_tiny_mp4


class BetaTests(unittest.TestCase):
    def test_windows_path_spellings_are_equivalent_without_weakening_identity(self):
        key = lambda value: server.root_identity_key(value, windows=True)
        self.assertEqual(key(r'C:\gallery'), key(r'\\?\C:\gallery'))
        self.assertEqual(key(r'\\server\share\gallery'), key(r'\\?\UNC\server\share\gallery'))
        self.assertNotEqual(key(r'C:\gallery'), key(r'D:\gallery'))
        self.assertNotEqual(key(r'C:\gallery'), key(r'C:\gallery-other'))
        self.assertIsNone(key(r'\\?\GLOBALROOT\Device\Harddisk0'))
        self.assertIsNone(key(r'\\.\C:\gallery'))

    @unittest.skipUnless(os.name == 'nt', 'actual extended paths require Windows')
    def test_windows_binding_accepts_extended_form_but_rejects_other_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            make_full_library(root)
            state=server.AppState()
            state.set_root(root,persist_if_ok=False)
            with mock.patch.dict(os.environ,{'GIV_DOWNLOAD_BIND_ONLY':'1'}):
                extended='\\\\?\\'+os.path.abspath(root)
                result=state.bind_download_account({'expectedRoot':extended,'grokUserId':'account-beta','commit':False})
                self.assertTrue(result.get('ok'),result)
                mismatch=state.bind_download_account({'expectedRoot':other,'grokUserId':'account-beta','commit':False})
                self.assertEqual(mismatch.get('code'),'library_changed')
                self.assertFalse(os.path.exists(server.meta_path(root)))

    def test_member_summary_keeps_created_and_uses_latest_valid_instant(self):
        row={'created':'2020-01-01T00:00:00Z'}
        server.attach_member_summary(row,[{'id':'a','created':'2026-09-10T01:00:00+09:00'},{'id':'b','created':'2026-09-09T23:00:00Z'},{'id':'bad','created':'not a date'}])
        self.assertEqual(row['latestItemCreatedAt'],'2026-09-09T23:00:00Z')
        self.assertEqual(row['created'],'2020-01-01T00:00:00Z')
        server.attach_member_summary(row,[{'id':'a','created':'2026-09-01T00:00:00Z'},{'id':'b','created':'2026-09-09T23:00:00Z'}],{'b'})
        self.assertEqual(row['latestItemCreatedAt'],'2026-09-01T00:00:00Z')
        self.assertEqual(row['memberIds'],['a'])

    def test_inherited_tags_and_favorites_are_not_persisted(self):
        meta=server.default_meta();meta['groups']['combos/g']={'fav':False,'dislike':False,'tags':['manual']}
        server.apply_item_patch(meta,'a',{'fav':True,'tags':['ACG']},'combos','g')
        self.assertFalse(meta['groups']['combos/g']['fav'])
        row={'folder':'g','memberIds':['a']};server.attach_group_meta(row,'combos',meta)
        self.assertTrue(row['fav']);self.assertFalse(row['ownFav']);self.assertEqual(row['tags'],['manual','ACG'])
        server.apply_item_patch(meta,'a',{'fav':False,'tags':[]},'combos','g')
        server.attach_group_meta(row,'combos',meta)
        self.assertFalse(row['fav']);self.assertEqual(row['tags'],['manual'])

    def test_read_only_card_and_listing_caches_reuse_and_invalidate(self):
        with tempfile.TemporaryDirectory() as root:
            make_full_library(root)
            folder=os.path.join(root,'combos','0001_aaa11111')
            with mock.patch.object(server,'load_card',wraps=server.load_card) as read:
                server.load_card_view(folder);server.load_card_view(folder)
                self.assertEqual(read.call_count,1)
                card=Path(folder,'card.json');value=json.loads(card.read_text(encoding='utf-8'));value['title']='changed and longer';card.write_text(json.dumps(value),encoding='utf-8')
                self.assertEqual(server.load_card_view(folder)['title'],'changed and longer')
                self.assertEqual(read.call_count,2)
            with mock.patch.object(server,'folder_listing',wraps=server.folder_listing) as listing:
                server.folder_listing_view(folder);server.folder_listing_view(folder)
                self.assertEqual(listing.call_count,1)

    def test_library_shell_knows_child_tags_before_visible_card_loading(self):
        with tempfile.TemporaryDirectory() as root:
            make_full_library(root)
            meta=server.default_meta();asset='a8b9823e-0811-4414-8064-b030dfc90e89'
            meta['items'][asset]={'fav':True,'dislike':False,'tags':['ACG']}
            server.save_meta(root,meta)
            data=server.annotate_library(server.detect_library(root));row=data['combos'][0]
            self.assertTrue(row['fav']);self.assertIn('ACG',row['tags']);self.assertIn(asset,row['memberIds'])
            self.assertTrue(row['latestItemCreatedAt'])

    def test_hardware_failure_falls_back_to_cpu_and_image_does_not_probe_duration(self):
        with tempfile.TemporaryDirectory() as root:
            src=Path(root,'video.mp4');write_tiny_mp4(src);calls=[]
            def run(args,**kw):
                calls.append(args)
                if '-hwaccel' in args:return SimpleNamespace(returncode=1)
                write_tiny_jpeg(args[-1]);return SimpleNamespace(returncode=0)
            config={'ffmpeg':'fake-ffmpeg','ffprobe':'fake-probe','mode':'auto','hwaccel':'cuda'}
            with mock.patch.object(server.subprocess,'run',side_effect=run), mock.patch.object(server,'probe_duration',return_value=3.0), mock.patch.object(server._cover_backoff,'fail') as backoff:
                self.assertTrue(server.extract_video_cover(root,str(src),'asset-video',state=config))
                self.assertEqual(calls[0][calls[0].index('-hwaccel')+1],'cuda')
                self.assertNotIn('-hwaccel',calls[1]);backoff.assert_called_once()
            calls.clear();src=Path(root,'image.jpg');write_tiny_jpeg(src)
            with mock.patch.object(server.subprocess,'run',side_effect=run), mock.patch.object(server,'probe_duration') as probe:
                self.assertTrue(server.extract_video_cover(root,str(src),'asset-image',state=config))
                probe.assert_not_called();self.assertNotIn('-hwaccel',calls[0])

    def test_live_members_override_stale_missing_status(self):
        row={}
        server.attach_member_summary(row,[{'id':'restored','created':'2026-09-11T00:00:00Z','status':'missing'}],known_live=True)
        self.assertEqual(row['memberIds'],['restored'])
        self.assertEqual(row['latestItemCreatedAt'],'2026-09-11T00:00:00Z')

    def test_failed_image_thumbnail_falls_back_without_starting_a_get_write(self):
        with tempfile.TemporaryDirectory() as root:
            make_full_library(root)
            state=server.AppState(root)
            handler_type=server.make_handler(state)
            handler=object.__new__(handler_type)
            with mock.patch.object(server,'cover_cache_hit',return_value=None), mock.patch.object(server,'accel_state',return_value={'covers':True}), mock.patch.object(server.COVERS,'failed_recent',return_value=True), mock.patch.object(server.COVERS,'enqueue') as enqueue, mock.patch.object(server,'send_file') as send, mock.patch.object(server,'send_bytes') as empty:
                handler._cover({'section':['combos'],'folder':['0001_aaa11111'],'id':['a8b9823e-0811-4414-8064-b030dfc90e89'],'thumb':['1']},False)
                send.assert_called_once();empty.assert_not_called();enqueue.assert_not_called()

if __name__=='__main__':unittest.main()
