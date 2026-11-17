"""Cover decode policy and per-source backoff. No device or file I/O here.

FFmpeg's -hwaccels reports build capabilities, not a working device/decoder.
The caller must retain a software fallback and distinguish policy from evidence.
"""
from collections import OrderedDict
import threading
import time

BACKENDS = ('auto', 'cuda', 'd3d11va', 'dxva2', 'qsv', 'vaapi', 'videotoolbox')
PLATFORM_BACKENDS = {
    'win32': ('d3d11va', 'dxva2', 'cuda', 'qsv'),
    'darwin': ('videotoolbox',),
    'linux': ('vaapi', 'cuda', 'qsv'),
}


def available_backends(compiled, platform):
    return [name for name in PLATFORM_BACKENDS.get(platform, ()) if name in compiled]


def choose_backend(compiled, gpu_hint, platform, preference='auto'):
    available = available_backends(compiled, platform)
    if preference != 'auto':
        return preference if preference in available else ''
    if platform == 'darwin':
        order = ('videotoolbox',)
    elif platform == 'win32':
        order = (('cuda',) if gpu_hint == 'nvidia' else ()) + ('d3d11va', 'dxva2', 'qsv')
    elif platform == 'linux':
        order = ('cuda',) if gpu_hint == 'nvidia' else (('vaapi', 'qsv') if gpu_hint == 'drm' else ())
    else:
        order = ()
    return next((name for name in order if name in available), '')


class SourceBackoff:
    """Bounded, monotonic negative cache. One bad file never disables a device.

    Caller keys include generation, source identity/fingerprint and backend.
    Old entries expire even if the wall clock changes; accesses do not renew TTL.
    """
    def __init__(self, limit=256, ttl=300, clock=time.monotonic):
        self.limit, self.ttl, self.clock = limit, ttl, clock
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def blocked(self, key):
        now = self.clock()
        with self.lock:
            when = self.entries.get(key)
            if when is None:
                return False
            if now - when >= self.ttl:
                del self.entries[key]
                return False
            self.entries.move_to_end(key)
            return True

    def fail(self, key):
        with self.lock:
            self.entries[key] = self.clock()
            self.entries.move_to_end(key)
            while len(self.entries) > self.limit:
                self.entries.popitem(last=False)

    def clear(self, key):
        with self.lock:
            self.entries.pop(key, None)
