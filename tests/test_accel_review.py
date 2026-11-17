"""Regression coverage for cover policy isolation (no hardware or user library)."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import server
from test_server import write_tiny_jpeg, write_tiny_mp4


class CoverPolicyRegression(unittest.TestCase):
    def test_failed_ffmpeg_probe_must_not_advertise_hardware(self):
        response = SimpleNamespace(returncode=1, stdout=b'cuda\nvaapi\n')
        with mock.patch.object(server.subprocess, 'run', return_value=response):
            self.assertEqual(server.probe_hwaccels('not-a-working-ffmpeg'), [])

    def test_single_bad_video_does_not_disable_other_videos(self):
        with tempfile.TemporaryDirectory() as root:
            config = {'ffmpeg': 'fake', 'ffprobe': 'fake-probe', 'mode': 'auto',
                      'effective': 'hardware', 'hwaccel': 'cuda', 'generation': -1}
            src = str(Path(root, 'clip.mp4'))
            write_tiny_mp4(src)
            def run(args, **_):
                if '-hwaccel' in args:
                    return SimpleNamespace(returncode=1)
                write_tiny_jpeg(args[-1])
                return SimpleNamespace(returncode=0)
            with mock.patch.object(server, '_accel_state', config), \
                 mock.patch.object(server.subprocess, 'run', side_effect=run), \
                 mock.patch.object(server, 'probe_duration', return_value=1):
                self.assertTrue(server.extract_video_cover(root, src, 'clip', state=config))
                self.assertEqual(server._accel_state['hwaccel'], 'cuda')

    def test_platform_selection_does_not_confuse_compiled_and_available_devices(self):
        import cover_acceleration as accel
        all_backends = list(accel.BACKENDS)
        self.assertEqual(accel.choose_backend(all_backends, '', 'linux'), '')
        self.assertEqual(accel.choose_backend(all_backends, 'drm', 'linux'), 'vaapi')
        self.assertEqual(accel.choose_backend(all_backends, 'nvidia', 'linux'), 'cuda')
        self.assertEqual(accel.choose_backend(all_backends, 'nvidia', 'darwin'), 'videotoolbox')
        self.assertEqual(accel.choose_backend(all_backends, '', 'win32'), 'd3d11va')
        self.assertEqual(accel.choose_backend(all_backends, '', 'win32', 'videotoolbox'), '')
        self.assertEqual(accel.choose_backend(['nvdec'], 'nvidia', 'linux'), '')

    def test_source_backoff_is_bounded_expires_and_does_not_poison_other_sources(self):
        from cover_acceleration import SourceBackoff
        now = [1.0]
        cache = SourceBackoff(limit=2, ttl=5, clock=lambda: now[0])
        cache.fail(('A', 1, 'cuda'))
        self.assertTrue(cache.blocked(('A', 1, 'cuda')))
        self.assertFalse(cache.blocked(('A', 2, 'cuda')))
        self.assertFalse(cache.blocked(('B', 1, 'cuda')))
        cache.fail(('B', 1, 'cuda'))
        cache.fail(('C', 1, 'cuda'))
        self.assertFalse(cache.blocked(('A', 1, 'cuda')))
        now[0] = 6.0
        self.assertFalse(cache.blocked(('C', 1, 'cuda')))
        self.assertLessEqual(len(cache.entries), 2)

    def test_invalid_backend_cannot_save_or_inject_command_arguments(self):
        with mock.patch.object(server, 'save_config_patch') as save:
            for value in ['--disable-gpu', 'cuda -i evil', 'turbo', {}, ['cuda']]:
                with self.assertRaises(ValueError):
                    server.set_accel_mode('auto', value)
            save.assert_not_called()

    def test_backend_setting_preserves_legacy_mode_and_unrelated_config(self):
        config = {'accel': 'compat', 'root': 'unchanged', 'coverBackend': 'cuda'}
        def save(patch):
            config.update(patch)
        with mock.patch.object(server, 'load_config', return_value=config), \
             mock.patch.object(server, 'save_config_patch', side_effect=save), \
             mock.patch.object(server, 'resolve_ffmpeg', return_value='fake'), \
             mock.patch.object(server, 'resolve_ffprobe', return_value='fake-probe'), \
             mock.patch.object(server, 'probe_hwaccels', return_value=['cuda']), \
             mock.patch.object(server, 'probe_gpu', return_value='nvidia'), \
             mock.patch.object(server.sys, 'platform', 'win32'), \
             mock.patch.object(server, '_accel_state', None):
            data = server.set_accel_mode('hardware', 'cuda')
            self.assertEqual(data['candidateBackend'], 'cuda')
            self.assertEqual(data['decodeStatus'], 'not_observed')
            self.assertEqual((data['scaleBackend'], data['encodeBackend']), ('cpu', 'cpu'))
            disabled = server.set_accel_mode('compat')
            self.assertEqual(disabled['candidateBackend'], 'cpu')
            self.assertEqual(disabled['backendPreference'], 'cuda')
            self.assertEqual(config['root'], 'unchanged')

    def test_old_job_cannot_update_current_policy_observation(self):
        state = {'generation': 42, 'candidateBackend': 'cpu'}
        with mock.patch.object(server, '_accel_state', state):
            server.record_cover_attempt({'generation': 41}, 'cuda', False, 10)
            self.assertNotIn('lastAttempt', state)
            server.record_cover_attempt({'generation': 42}, '', True, 20)
            self.assertEqual(state['lastAttempt']['backend'], 'cpu')

    def test_publish_failure_is_not_a_hardware_failure(self):
        with tempfile.TemporaryDirectory() as root:
            src = str(Path(root, 'clip.mp4'))
            write_tiny_mp4(src)
            def run(args, **_):
                write_tiny_jpeg(args[-1])
                return SimpleNamespace(returncode=0)
            snap = {'ffmpeg': 'fake', 'mode': 'auto', 'hwaccel': 'cuda', 'generation': -2}
            with mock.patch.object(server.subprocess, 'run', side_effect=run), \
                 mock.patch.object(server.os, 'replace', side_effect=OSError('fixture full disk')), \
                 mock.patch.object(server._cover_backoff, 'fail') as fail:
                self.assertIsNone(server.extract_video_cover(root, src, 'clip', state=snap))
                fail.assert_not_called()

    def test_current_packagers_include_imported_cover_policy_module(self):
        root = Path(server.__file__).parent
        for relative in ['scripts/pack_desktop_test.mjs', 'scripts/pack_portable.py']:
            self.assertIn('cover_acceleration.py', (root / relative).read_text(encoding='utf-8'))


class StackEvolutionBundleContract(unittest.TestCase):
    def test_go_desktop_bundles_compiled_ui_and_sidecar_not_python(self):
        import json
        root = Path(server.__file__).parent
        cfg = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        self.assertEqual(cfg['build']['frontendDist'], '../frontend-react/dist')
        resources = cfg['bundle']['resources']
        self.assertEqual(resources['../backend-go/bin/giv-backend.exe'], 'viewer/giv-backend.exe')
        self.assertEqual(resources['../frontend-react/dist/'], 'viewer/static/')
        self.assertFalse(any(key.endswith('.py') for key in resources))
    def test_packager_prebuilds_assets_outside_tauri_shell(self):
        import json
        root = Path(server.__file__).parent
        cfg = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        self.assertNotIn('beforeBuildCommand', cfg['build'])
        self.assertNotIn('beforeDevCommand', cfg['build'])
        script = (root / 'scripts/pack-stack-evo.mjs').read_text(encoding='utf-8')
        assets = script.index('scripts/stack-evo-assets.mjs')
        tauri = script.index('scripts/tauri-cli-local.mjs')
        self.assertLess(assets, tauri)
        package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        self.assertIn('tauri:dev:stack-evo', package['scripts'])
        self.assertIn('run(process.execPath, ["scripts/stack-evo-assets.mjs"]);', script)
        self.assertIn('"scripts/tauri-cli-local.mjs", "build", "--no-bundle"', script)
        self.assertNotIn("\\n// run under a child shell", script)
        self.assertIn('mkdtempSync(path.join(artifactsDir, ".stack-evo-portable-"))', script)
        self.assertIn('renameSync(staging, output)', script)
        self.assertIn('rmSync(staging, { recursive: true, force: true })', script)
