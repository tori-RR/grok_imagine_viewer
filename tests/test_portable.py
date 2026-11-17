#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
import sys

if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import server


class PortableConfigTests(unittest.TestCase):
    def setUp(self):
        self._old_repo = server.REPO_DIR
        self._old_cfg = server.CONFIG_PATH_OVERRIDE
        self._old_home = os.environ.get("HOME")
        self.tmp = tempfile.TemporaryDirectory()
        server.REPO_DIR = self.tmp.name
        server.CONFIG_PATH_OVERRIDE = None
        os.environ["HOME"] = self.tmp.name

    def tearDown(self):
        server.REPO_DIR = self._old_repo
        server.CONFIG_PATH_OVERRIDE = self._old_cfg
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        self.tmp.cleanup()

    def test_config_lives_next_to_app(self):
        path = server.config_path()
        self.assertEqual(path, os.path.join(self.tmp.name, ".viewer-config.json"))
        self.assertTrue(server.save_config({"root": "/tmp/lib"}))
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(server.load_config().get("root"), "/tmp/lib")

    def test_nearby_single_combo(self):
        folder = os.path.join(self.tmp.name, "library", "0001_abcd1234")
        os.makedirs(folder)
        card = {
            "n": 1,
            "id": "abcd",
            "title": "demo",
            "folder": "0001_abcd1234",
            "count": 0,
            "items": [],
        }
        with open(os.path.join(folder, "card.json"), "w", encoding="utf-8") as fh:
            json.dump(card, fh)
        found = server.resolve_initial_root(None, base_dir=self.tmp.name)
        self.assertEqual(os.path.realpath(found), os.path.realpath(os.path.join(self.tmp.name, "library")))
        self.assertEqual(server.detect_library(found).get("mode"), "loose")

    def test_discovery_does_not_probe_unrelated_personal_locations(self):
        parent = os.path.dirname(self.tmp.name)
        with mock.patch.object(server, "load_config", return_value={}), \
                mock.patch.object(server.os.path, "isdir", return_value=False) as exists:
            self.assertEqual(server.resolve_initial_root(None, base_dir=self.tmp.name), "")
        self.assertTrue(exists.called)
        for call in exists.call_args_list:
            self.assertEqual(os.path.commonpath([parent, call.args[0]]), parent)



class PortFallbackTests(unittest.TestCase):
    def test_candidate_order(self):
        ports = server.candidate_ports(19706)
        self.assertEqual(ports[0], 19706)
        self.assertIn(9806, ports)
        self.assertEqual(len(ports), len(set(ports)))

    def test_bind_denied_win10013(self):
        exc = OSError("denied")
        exc.winerror = 10013
        self.assertTrue(server._bind_denied(exc))
        self.assertFalse(server._addr_in_use(exc))


if __name__ == "__main__":
    unittest.main()
