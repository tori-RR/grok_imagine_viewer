"""Application preferences and no-overwrite local exports. Standard library only.

This module never changes a library or obtains network credentials. The HTTP
adapter resolves a live source under its gallery lease before calling copy_out.
"""
from __future__ import annotations

import errno
import locale
import os
import re
import stat
from pathlib import Path

DEFAULT_SHORTCUTS = {
    "previousItem": "ArrowUp", "nextItem": "ArrowDown",
    "previousGroup": "Ctrl+ArrowLeft", "nextGroup": "Ctrl+ArrowRight",
    "seekBack": "ArrowLeft", "seekForward": "ArrowRight",
    "seekBackFar": "Shift+ArrowLeft", "seekForwardFar": "Shift+ArrowRight",
    "previousFrame": "KeyD", "nextFrame": "KeyF",
    "setA": "BracketLeft", "setB": "BracketRight", "clearAB": "Backslash",
    "loop": "KeyL", "play": "Space", "mute": "KeyM",
    "size50": "Ctrl+Digit1", "size100": "Ctrl+Digit2",
    "size150": "Ctrl+Digit3", "size150Alt": "Ctrl+Digit4",
    "fullscreen": "Ctrl+KeyF",
}
# Configs written before seek/frame keys still bind arrows to combo walking.
_LEGACY_SEEK_KEYS = ("seekBack", "seekForward", "seekBackFar", "seekForwardFar", "previousFrame", "nextFrame")
MODIFIERS = ("Ctrl", "Alt", "Shift", "Meta")
KEY_CODE = re.compile(r"^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Space|BracketLeft|BracketRight|Backslash|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backquote|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Enter|Numpad[0-9])$")
RESERVED = {"Alt+F4", "Ctrl+KeyW", "Ctrl+KeyR", "Ctrl+KeyT", "Ctrl+KeyN", "Ctrl+KeyL", "Ctrl+KeyQ", "Ctrl+Shift+KeyW", "Ctrl+Shift+KeyR", "Ctrl+Alt+Delete"}


def desktop_directory():
    """Honor Windows' redirected/Desktop known folder (including OneDrive)."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            shell = ctypes.WinDLL("shell32", winmode=0x00000800)
            resolve = shell.SHGetFolderPathW
            resolve.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR]
            resolve.restype = ctypes.c_long
            buffer = ctypes.create_unicode_buffer(32768)
            if resolve(None, 0x10, None, 0, buffer) == 0 and buffer.value:
                return buffer.value
        except (OSError, AttributeError):
            pass
    elif os.name == "posix":
        try:
            text = (Path.home() / ".config/user-dirs.dirs").read_text(encoding="utf-8")
            match = re.search(r'^XDG_DESKTOP_DIR="([^"\n]+)"$', text, re.MULTILINE)
            if match:
                raw = match.group(1).replace("$HOME", str(Path.home()))
                if os.path.isabs(raw) and "$" not in raw:
                    return raw
        except OSError:
            pass
    return str(Path.home() / "Desktop")


def normalize_chord(value):
    if not isinstance(value, str) or len(value) > 120:
        raise ValueError("快捷键格式无效。")
    parts = value.split("+")
    keys = sorted(set(part for part in parts if part not in MODIFIERS))
    if len(parts) != len(set(parts)) or not 1 <= len(keys) <= 3 or any(not KEY_CODE.fullmatch(key) for key in keys):
        raise ValueError("快捷键必须包含有效的非修饰键。")
    result = "+".join([mod for mod in MODIFIERS if mod in parts] + keys)
    if "Meta" in parts or result in RESERVED:
        raise ValueError("此组合被系统或浏览器保留，请选择其他快捷键。")
    return result


def system_language():
    """UI language, independent of Windows' regional date/number formats."""
    if os.name == "nt":
        try:
            import ctypes
            kernel = ctypes.WinDLL("kernel32", winmode=0x00000800)
            language = kernel.GetUserDefaultUILanguage
            language.argtypes = []
            language.restype = ctypes.c_ushort
            return locale.windows_locale.get(language(), "").replace("_", "-")
        except (OSError, AttributeError):
            return ""
    for key in ("LC_ALL", "LC_MESSAGES", "LANG"):
        value = os.environ.get(key, "").strip()
        if value:
            return value.split(".", 1)[0].split("@", 1)[0].replace("_", "-")
    try:
        return (locale.getlocale()[0] or "").replace("_", "-")
    except (ValueError, TypeError):
        return ""


def defaults():
    return {"version": 1, "language": "auto", "saveDirectory": desktop_directory(), "audioOutputId": "",
            "wheelVolumeStep": 5, "sidebarCollapsed": False, "shortcuts": dict(DEFAULT_SHORTCUTS)}


def read_preferences(config):
    result = defaults()
    raw = config.get("preferences", {}) if isinstance(config, dict) else {}
    if not isinstance(raw, dict):
        return result
    for name in ("language", "saveDirectory", "audioOutputId", "wheelVolumeStep", "sidebarCollapsed"):
        value = raw.get(name)
        if name == "language" and isinstance(value, str) and value in ("auto", "zh-CN", "en"):
            result[name] = value
        elif name == "saveDirectory" and isinstance(value, str) and os.path.isabs(value):
            result[name] = value
        elif name == "audioOutputId" and isinstance(value, str) and len(value) <= 512:
            result[name] = value
        elif name == "wheelVolumeStep" and type(value) is int and 1 <= value <= 20:
            result[name] = value
        elif name == "sidebarCollapsed" and type(value) is bool:
            result[name] = value
    keys = raw.get("shortcuts")
    if isinstance(keys, dict):
        legacy = not any(name in keys for name in _LEGACY_SEEK_KEYS)
        for name in DEFAULT_SHORTCUTS:
            try:
                result["shortcuts"][name] = normalize_chord(keys.get(name, result["shortcuts"][name]))
            except ValueError:
                pass
        if legacy:
            if result["shortcuts"].get("previousGroup") == "ArrowLeft" and result["shortcuts"].get("seekBack") == "ArrowLeft":
                result["shortcuts"]["previousGroup"] = "Ctrl+ArrowLeft"
            if result["shortcuts"].get("nextGroup") == "ArrowRight" and result["shortcuts"].get("seekForward") == "ArrowRight":
                result["shortcuts"]["nextGroup"] = "Ctrl+ArrowRight"
    return result


def update_preferences(config, patch):
    """Validate before changing anything; preserve unrelated/future fields."""
    if not isinstance(patch, dict) or set(patch) - {"language", "saveDirectory", "audioOutputId", "wheelVolumeStep", "sidebarCollapsed", "shortcuts"}:
        raise ValueError("设置字段无效。")
    stored = config.get("preferences", {})
    if not isinstance(stored, dict) or type(stored.get("version", 1)) is not int or stored.get("version", 1) != 1:
        raise ValueError("设置版本无法识别，已停止写入。")
    result = dict(stored)
    result.update(read_preferences(config))
    for key, value in patch.items():
        if key == "language":
            if not isinstance(value, str) or value not in ("auto", "zh-CN", "en"):
                raise ValueError("界面语言无效。")
        elif key == "saveDirectory":
            if not isinstance(value, str) or not value.strip() or len(value) > 32768 or "\x00" in value:
                raise ValueError("另存为目录无效。")
            value = os.path.expanduser(value.strip())
            if not os.path.isabs(value) or not os.path.isdir(value):
                raise ValueError("请选一个已存在的绝对目录。")
            if value.startswith(("\\\\.\\", "\\??\\")) or value.lower().startswith("\\\\?\\globalroot"):
                raise ValueError("不能选择设备路径。")
            value = os.path.realpath(value)
        elif key == "audioOutputId":
            if not isinstance(value, str) or len(value) > 512 or any(ord(c) < 32 for c in value):
                raise ValueError("音频设备标识无效。")
        elif key == "wheelVolumeStep":
            if type(value) is not int or not 1 <= value <= 20:
                raise ValueError("滚轮音量步长必须为 1–20%。")
        elif key == "sidebarCollapsed":
            if type(value) is not bool:
                raise ValueError("侧栏设置无效。")
        else:
            if not isinstance(value, dict) or set(value) - set(DEFAULT_SHORTCUTS):
                raise ValueError("快捷键操作无效。")
            value = dict(result["shortcuts"], **{name: normalize_chord(chord) for name, chord in value.items()})
            seen = set()
            for chord in value.values():
                if chord in seen:
                    raise ValueError("快捷键与另一项操作重复。")
                seen.add(chord)
            # Avoid prefix ambiguity: pressing the shorter chord must not run
            # an action on the way to a longer one.
            sets = [set(chord.split("+")) for chord in value.values()]
            if any((a & set(MODIFIERS)) == (b & set(MODIFIERS)) and (a < b or b < a)
                   for i, a in enumerate(sets) for b in sets[i + 1:]):
                raise ValueError("快捷键是另一组合的子集，请换一个键位。")
        result[key] = value
    return result


def _regular(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("源文件不是安全的普通文件。")
    return info


def _fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def copy_out(source, directory, library_root):
    """Copy, fsync, then publish without replacement. Never move the original.

    Caller holds the gallery lease. Partial files are random, exclusively
    owned, and never named like complete media. Existing destinations survive
    all errors and competing exports.
    """
    target_dir = os.path.realpath(directory)
    root = os.path.realpath(library_root)
    if not os.path.isdir(target_dir):
        raise ValueError("另存为目录不存在或无法访问，请在设置中重新选择。")
    try:
        inside_library = os.path.normcase(os.path.commonpath([root, target_dir])) == os.path.normcase(root)
    except ValueError:
        inside_library = False  # Different Windows drives.
    if inside_library:
        raise ValueError("另存为目录不能在当前图库内，以免改变图库。")
    name = os.path.basename(source)
    if (not name or name in (".", "..") or any(c in name for c in '<>:"/\\|?*')
            or any(ord(c) < 32 for c in name) or name.endswith((".", " "))
            or name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *("COM%d" % n for n in range(1, 10)), *("LPT%d" % n for n in range(1, 10))}):
        raise ValueError("文件名无效。")
    directory_info = os.stat(target_dir)
    before = _regular(source)
    fd = os.open(source, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary = os.path.join(target_dir, ".giv-save-" + os.urandom(16).hex() + ".part")
    published = None
    owned = False
    try:
        with os.fdopen(fd, "rb") as src:
            if _fingerprint(os.fstat(src.fileno())) != _fingerprint(before):
                raise ValueError("源文件在复制前发生变化，请重试。")
            with open(temporary, "xb") as dest:
                owned = True
                remaining = before.st_size
                while remaining:
                    block = src.read(min(1024 * 1024, remaining))
                    if not block:
                        raise OSError(errno.EIO, "源文件读取不完整。")
                    dest.write(block)
                    remaining -= len(block)
                if src.read(1) or _fingerprint(os.fstat(src.fileno())) != _fingerprint(before):
                    raise ValueError("源文件在复制期间发生变化，未发布副本。")
                dest.flush()
                os.fsync(dest.fileno())
            if os.path.realpath(directory) != target_dir or not os.path.samestat(directory_info, os.stat(target_dir)):
                raise ValueError("另存为目录发生变化，未发布副本。")
            stem, ext = os.path.splitext(name)
            for index in range(1000):
                filename = name if index == 0 else f"{stem} ({index}){ext}"
                candidate = os.path.join(target_dir, filename)
                try:
                    if os.name == "nt":
                        os.rename(temporary, candidate)  # Windows rename never replaces.
                    else:
                        os.link(temporary, candidate, follow_symlinks=False)
                    published = candidate
                    break
                except FileExistsError:
                    continue
            if published is None:
                raise FileExistsError("同名文件过多，未覆盖任何文件。")
        return {"ok": True, "path": published, "name": os.path.basename(published), "bytes": before.st_size}
    finally:
        if owned:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            except OSError:
                # Preserve an owned temporary rather than deleting anything else.
                pass
