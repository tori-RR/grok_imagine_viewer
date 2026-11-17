"""Black-box desktop/Go protocol regression; temporary fixtures only."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
from pathlib import Path
import queue
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


def exercise(binary: Path, base: Path, explicit_root: bool) -> None:
    static = base / "static"
    static.mkdir(exist_ok=True)
    (static / "index.html").write_text("fixture gallery", encoding="utf-8")
    config = base / "settings.json"
    if not config.exists():
        config.write_text("{}", encoding="utf-8")
    saved_config = config.read_bytes()
    gallery = base / "gallery"
    gallery.mkdir(exist_ok=True)
    index = gallery / "_index.json"
    if not index.exists():
        # Catch accidental pre-readiness card/duration hydration on Windows.
        # These synthetic bytes never go through a media decoder.
        groups = []
        for n in range(120):
            folder = f"fixture-{n:04d}"
            group = gallery / "combos" / folder
            group.mkdir(parents=True)
            items = []
            for m in range(8):
                asset = f"fixture-{n:04d}-{m}"
                filename = asset + ".mp4"
                (group / filename).write_bytes(b"synthetic video fixture")
                items.append({"id": asset, "file": filename, "mime": "video/mp4"})
            (group / "card.json").write_text(json.dumps({"id": folder, "title": folder, "items": items}), encoding="utf-8")
            groups.append({"id": folder, "folder": folder, "count": len(items)})
        index.write_text(json.dumps({"combos": groups, "other": [], "summary": {}}), encoding="utf-8")
    boot = {
        "protocolVersion": 3,
        "instanceSecret": secrets.token_hex(32),
        "sessionToken": secrets.token_hex(32),
        "instanceId": secrets.token_hex(16),
        "serverPath": str(binary),
        "staticDir": str(static),
        "configPath": str(config),
        "desktop": str(base),
        "language": "en",
        "downloadBindOnly": True,
        "root": str(gallery) if explicit_root else "",
        "toolDirs": [],
    }
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with (base / "stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            [str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=stderr, text=True, encoding="utf-8",
        )
        assert process.stdin is not None and process.stdout is not None
        try:
            started = time.monotonic()
            process.stdin.write(json.dumps(boot) + "\n")
            process.stdin.flush()
            ready_lines: queue.Queue[str] = queue.Queue()
            threading.Thread(target=lambda: ready_lines.put(process.stdout.readline()), daemon=True).start()
            try:
                ready = json.loads(ready_lines.get(timeout=15))
            except (queue.Empty, ValueError) as exc:
                raise AssertionError("sidecar did not become ready") from exc
            origin = ready["origin"]
            print(f"PASS: {'explicit root' if explicit_root else 'launcher with recent gallery'} startup ready in {time.monotonic() - started:.3f}s", flush=True)
            assert origin.startswith("http://127.0.0.1:")
            port = int(origin.rsplit(":", 1)[1])
            assert ready["pid"] == process.pid

            def request(path: str, payload=None, auth="native", method=None, extra=None, timeout=5):
                headers = {"Origin": origin, "Content-Type": "application/json"}
                if auth == "native":
                    headers["X-Viewer-Session"] = boot["sessionToken"]
                elif auth == "cookie":
                    headers["Cookie"] = ready["cookie"] + "=" + boot["sessionToken"]
                headers.update(extra or {})
                data = None if payload is None else json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(origin + path, data=data, headers=headers,
                                             method=method or ("PUT" if data is not None else "GET"))
                try:
                    with opener.open(req, timeout=timeout) as response:
                        return response.status, response.read(1 << 20)
                except urllib.error.HTTPError as exc:
                    return exc.code, exc.read(1 << 20)

            nonce = secrets.token_bytes(32)
            status, body = request("/api/identity", auth="none", extra={"X-Viewer-Challenge": nonce.hex()})
            identity = json.loads(body)
            message = (b"giv-identity-v3\0" + nonce + bytes.fromhex(boot["instanceId"])
                       + port.to_bytes(2, "big") + process.pid.to_bytes(4, "big") + b"\x01")
            proof = hmac.new(bytes.fromhex(boot["instanceSecret"]), message, hashlib.sha256).hexdigest()
            assert status == 200 and hmac.compare_digest(identity["challengeResponse"], proof)
            assert request("/", auth="none")[0] == 403
            assert request("/", auth="cookie") == (200, b"fixture gallery")
            status, body = request("/api/config?minimal=1")
            assert status == 200
            if explicit_root:
                assert Path(json.loads(body)["root"]) == gallery
            else:
                assert json.loads(body)["root"] == "", "saved gallery bypassed the launcher"
                status, body = request("/api/config", timeout=30)
                cfg = json.loads(body)
                assert status == 200 and cfg["root"] == "" and not cfg["ok"]
                assert Path(cfg["lastRoot"]) == gallery and Path(cfg["history"][0]["path"]) == gallery
                assert config.read_bytes() == saved_config, "default startup changed saved locations"
                status, body = request("/api/root", {"root": str(gallery)}, auth="cookie", timeout=30)
                assert status == 200 and json.loads(body)["ok"], "recent gallery selection failed"
                status, body = request("/api/config?minimal=1")
                assert status == 200 and Path(json.loads(body)["root"]) == gallery
            assert request("/internal/download/status")[0] == 403
            status, body = request("/api/download/status", auth="cookie")
            assert status == 200 and not ({"tickets", "result", "token"} & json.loads(body).keys())

            bind = {"expectedRoot": str(gallery), "grokUserId": "fixture-account", "commit": False}
            meta = gallery / ".viewer-meta.json"
            before = meta.read_bytes() if meta.exists() else None
            status, body = request("/api/download/bind", bind)
            assert status == 200 and json.loads(body)["ok"], "Rust binding preflight failed"
            assert (meta.read_bytes() if meta.exists() else None) == before
            assert request("/api/download/bind", bind, auth="cookie")[0] == 403
            bind["commit"] = True
            status, body = request("/api/download/bind", bind)
            assert status == 200 and json.loads(body)["bound"]
            committed = meta.read_bytes()
            assert json.loads(committed)["grokUserId"] == "fixture-account"
            assert json.loads(committed)["revision"] == 1
            assert request("/api/download/bind", bind)[0] == 200
            assert meta.read_bytes() == committed
            bind["grokUserId"] = "another-account"
            status, body = request("/api/download/bind", bind)
            assert status == 409 and json.loads(body)["code"] == "account_mismatch"
            assert meta.read_bytes() == committed
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("owned sidecar did not shut down on stdin EOF")
        assert process.returncode == 0, "sidecar exited unsuccessfully"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", type=Path, required=True)
    args = parser.parse_args()
    binary = args.sidecar.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="giv-contract-") as temp:
        base = Path(temp).resolve()
        exercise(binary, base, explicit_root=True)
        exercise(binary, base, explicit_root=False)
    print("PASS: bootstrap/HMAC, browser/native isolation, binding, mismatch, default launcher/recent selection, explicit root, EOF shutdown")


if __name__ == "__main__":
    main()
