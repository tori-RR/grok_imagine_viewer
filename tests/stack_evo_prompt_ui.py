"""Per-media prompts and metadata-only history sync through Go/production UI.

Only generated images/video/configuration are used. Copy buttons call a local
clipboard API adapter, so the user's system clipboard is never read or changed.
The lightbox is a trash-only filename preview and is outside this live-library
contract. Native history results are synthetic; no remote endpoint is used.
Requires the visual harness dependencies and an existing FFmpeg.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image
from playwright.sync_api import expect, sync_playwright

TITLE = "dancing cat"
PROMPTS = [TITLE, "drinking", "dancing and drinking"]
FOLDER = "0001_prompt-fixture"
USER = "fixture-user"
CONVERSATION = "fixture-conversation"


def no_reparse_ancestors(path: Path):
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        assert not candidate.is_symlink() and not getattr(info, "st_file_attributes", 0) & 0x400, candidate


def remove_owned_fixture(work: Path, output: Path):
    assert work.is_relative_to(output) and work != output
    pending = [work]
    while pending:
        directory = pending.pop()
        no_reparse_ancestors(directory)
        for path in directory.iterdir():
            no_reparse_ancestors(path)
            if path.is_dir():
                pending.append(path)
    shutil.rmtree(work)


def start_native(binary: Path, static: Path, base: Path, root: Path):
    """Own bootstrap; the native admin secret stays in this Python process."""
    base.mkdir(exist_ok=True)
    token, secret = secrets.token_hex(32), secrets.token_hex(32)
    boot = dict(protocolVersion=3, instanceSecret=secret, sessionToken=token,
                instanceId=secrets.token_hex(16), serverPath=str(binary), staticDir=str(static),
                configPath=str(base / "config.json"), desktop=str(base.parent), language="zh-CN",
                downloadBindOnly=True, root=str(root))
    process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        process.stdin.write(json.dumps(boot) + "\n")
        process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        ready = json.loads(line)
    except Exception:
        process.stdin.close()
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
        raise
    return process, ready, token, secret


def file_snapshot(path: Path):
    info = path.stat()
    return dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), size=info.st_size,
                mtimeNs=info.st_mtime_ns)


def make_gallery(root: Path, ffmpeg: str):
    directory = root / "combos" / FOLDER
    directory.mkdir(parents=True)
    for name, color in (("cat-dance.jpg", (120, 60, 80)), ("cat-drink.jpg", (50, 110, 130))):
        Image.new("RGB", (240, 180), color).save(directory / name)
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-f", "lavfi", "-i", "color=c=navy:s=160x120:r=10", "-t", "1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(directory / "cat-both.mp4")],
                   check=True, capture_output=True, timeout=20)
    names = ["cat-dance.jpg", "cat-drink.jpg", "cat-both.mp4"]
    ids = ["cat-dance", "cat-drink", "cat-both"]
    items = [dict(id=ident, file=name, mime="video/mp4" if name.endswith("mp4") else "image/jpeg",
                  prompt=prompt, conversationId=CONVERSATION,
                  created=f"2026-01-0{index + 1}T12:00:00Z", status="linked")
             for index, (ident, name, prompt) in enumerate(zip(ids, names, PROMPTS))]
    card = dict(id="fixture-conversation", n=1, folder=FOLDER, title=TITLE,
                created="2026-01-01T12:00:00Z", items=items)
    card_path = directory / "card.json"
    card_path.write_text(json.dumps(card), encoding="utf-8")
    summary = {key: value for key, value in card.items() if key != "items"} | dict(count=3, images=2, videos=1)
    (root / "_index.json").write_text(json.dumps(dict(combos=[summary], other=[], summary={})), encoding="utf-8")
    (root / ".viewer-meta.json").write_text(json.dumps(dict(version=2, revision=0, tags=["ACG"],
                                                         items={}, groups={}, grokUserId=USER)), encoding="utf-8")
    state = root / "_state"
    state.mkdir()
    (state / "assets.json").write_text(json.dumps(dict(assets=[dict(id=ident) for ident in ids])), encoding="utf-8")
    (state / "conversations.json").write_text(json.dumps(dict(conversations=[dict(id=CONVERSATION)])), encoding="utf-8")
    hashes = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in names}
    return card, card_path, hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--chromium")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = args.out.resolve()
    no_reparse_ancestors(args.out.absolute())
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="giv-prompt-ui-", dir=output)).resolve()
    inventory = dict(owner="stack_evo_prompt_ui", fixture=str(work), retainOnFailure=True,
                     purpose="synthetic two JPEGs + one 1s video, bound account metadata, card/index/state/app config/SQLite")
    (output / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    process = None
    success = False
    report = dict(checks=[], observations=[], pageErrors=[], clipboardScope="navigator.clipboard.writeText adapter only; no system clipboard")
    try:
        override = os.environ.get("VIEWER_FFMPEG", "").strip()
        ffmpeg = (override if override and Path(override).is_file() else shutil.which(override) if override else None) or shutil.which("ffmpeg")
        assert ffmpeg, "An existing FFmpeg is required to generate the synthetic video; this test installs nothing"
        root = work / "gallery"
        card, card_path, original_hashes = make_gallery(root, ffmpeg)
        process, ready, token, admin_secret = start_native(args.sidecar.resolve(), repo / "frontend-react/dist", work / "app", root)
        inventory["sidecarPid"] = process.pid
        (output / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")

        def native(path, body=None):
            assert path.startswith("/internal/download/")
            request = urllib.request.Request(ready["origin"] + path,
                data=json.dumps(body).encode("utf-8") if body is not None else None,
                headers={"Content-Type": "application/json", "Origin": ready["origin"],
                         "X-Giv-Admin": admin_secret})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    result = json.load(response)
                    assert response.status == 200 and result.get("ok"), (path, result)
                    return result
            except urllib.error.HTTPError as error:
                # Include the API diagnostic, never request headers or secrets.
                raise AssertionError((path, error.code, error.read().decode("utf-8"))) from None

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
            try:
                context = browser.new_context(viewport=dict(width=1280, height=900), locale="zh-CN", reduced_motion="reduce")
                context.add_cookies([dict(name=ready["cookie"], value=token, url=ready["origin"], httpOnly=True, sameSite="Strict")])
                context.add_init_script("""window.__promptCopied=[];
                  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
                    writeText:async text=>{window.__promptCopied.push(String(text));}}});""")
                context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(ready["origin"] + "/") else route.abort())
                page = context.new_page()
                page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                page.goto(ready["origin"], wait_until="networkidle")

                def choose_view(label):
                    page.locator("#viewBtn").click()
                    page.locator("#viewMenu").get_by_text(label, exact=True).click()
                    if page.locator("#viewMenu").is_visible():
                        page.locator("#viewBtn").click()

                def combo():
                    return page.evaluate("""folder=>fetch('/api/combo?section=combos&folder='+encodeURIComponent(folder))
                      .then(async response=>({status:response.status,body:await response.json()}))""", FOLDER)

                def open_group():
                    tile = page.locator('#main .tile[data-group-key="combos/' + FOLDER + '"]')
                    expect(tile).to_be_visible()
                    tile.click()
                    expect(page.locator("#comboPreview")).to_be_visible()
                    expect(page.locator("#cpFilm .cp-thumb")).to_have_count(3)

                def assert_current(index, prompt, phase):
                    page.locator("#cpFilm .cp-thumb").nth(index).click()
                    expect(page.locator("#cpTitle")).to_have_text(TITLE)
                    expect(page.locator("#cpPrompt")).to_have_text(prompt)
                    if index == 2:
                        page.wait_for_function("() => document.querySelector('#cpVideo').classList.contains('show') && document.querySelector('#cpVideo').readyState>=1")
                    else:
                        page.wait_for_function("() => {const image=document.querySelector('#cpImage');return image.classList.contains('show')&&image.complete&&image.naturalWidth>0}")
                    before = page.evaluate("window.__promptCopied.length")
                    page.locator("#cpCopy").click()
                    page.wait_for_function("count=>window.__promptCopied.length===count+1", arg=before)
                    assert page.evaluate("window.__promptCopied.at(-1)") == prompt
                    expect(page.locator("#cpCopy")).to_have_text("已复制")
                    report["observations"].append(dict(phase=phase, item=card["items"][index]["id"], prompt=prompt, groupTitle=TITLE, copy=prompt))

                data = combo()
                assert data["status"] == 200 and [row["prompt"] for row in data["body"]["items"]] == PROMPTS, data
                report["checks"].append("go-api-keeps-three-distinct-item-prompts-under-original-group-title")
                open_group()
                for index, prompt in enumerate(PROMPTS):
                    assert_current(index, prompt, "initial")
                report["checks"].append("image-video-detail-switch-and-copy-use-current-item-prompt")
                page.screenshot(path=str(output / "video-distinct-prompt.png"), animations="disabled")
                page.reload(wait_until="networkidle")
                open_group()
                for index, prompt in enumerate(PROMPTS):
                    assert_current(index, prompt, "reloaded")
                report["checks"].append("reloaded-library-retains-per-item-prompts-and-copy-values")
                page.locator("#cpBack").click()
                choose_view("扁平")
                for index, ident in ((1, "cat-drink"), (2, "cat-both")):
                    page.locator('#main .tile[data-asset-id="' + ident + '"]').click()
                    expect(page.locator("#cpPrompt")).to_have_text(PROMPTS[index])
                    assert_current(index, PROMPTS[index], "flat-entry")
                    page.locator("#cpBack").click()
                report["checks"].append("flat-item-entry-opens-its-own-prompt-not-conversation-title")

                # Unknown image and explicitly empty video are separate cases.
                # Only our fixture card changes; the title and media stay intact.
                card["items"][1].pop("prompt")
                card["items"][2]["prompt"] = ""
                card_path.write_text(json.dumps(card), encoding="utf-8")
                page.reload(wait_until="networkidle")
                choose_view("组合")
                data = combo()
                assert data["status"] == 200 and [row["prompt"] for row in data["body"]["items"]] == [TITLE, "", ""], data
                open_group()
                for index, prompt in enumerate((TITLE, "", "")):
                    assert_current(index, prompt, "missing-and-empty")
                report["checks"].append("missing-image-and-empty-video-prompt-stay-empty-without-title-or-sibling-fallback")
                page.screenshot(path=str(output / "empty-prompt-preserved.png"), animations="disabled")

                # The remote saved list no longer contains these assets, while
                # all three local files remain live. Simulate only the native
                # history metadata result; never contact Grok or download media.
                page.locator("#cpBack").click()
                historical_before = json.loads(card_path.read_text(encoding="utf-8"))
                historical_before["items"][2]["prompt"] = "stale local video prompt"
                card_path.write_text(json.dumps(historical_before), encoding="utf-8")
                protected = [root / "_index.json", root / "_state/assets.json", root / "_state/conversations.json"]
                protected_before = {str(path.relative_to(root)): file_snapshot(path) for path in protected}
                media_before = {name: file_snapshot(card_path.parent / name) for name in original_hashes}
                group_files_before = sorted(path.name for path in card_path.parent.iterdir())
                reservation = native("/internal/download/reserve", dict(root=str(root)))
                run_id = reservation["runId"]
                targets_reply = native("/internal/download/prompt-targets", dict(runId=run_id, root=str(root), userId=USER))
                targets = targets_reply["targets"]
                assert not targets_reply.get("truncated") and len(targets) == 3
                assert {target["id"] for target in targets} == {item["id"] for item in card["items"]}
                assert all(set(target) <= {"token", "id", "conv", "rootConv"}
                           and target["conv"] == CONVERSATION and target["token"] for target in targets)
                by_id = {target["id"]: target for target in targets}
                updates = [dict(token=by_id[card["items"][index]["id"]]["token"],
                                id=card["items"][index]["id"], conv=CONVERSATION, prompt=PROMPTS[index])
                           for index in (1, 2)]
                # The unreturned cat-dance result intentionally has no patch:
                # an unknown remote prompt must preserve its known local value.
                native("/internal/download/start", dict(runId=run_id, userId=USER,
                       manifest=dict(complete=True, assets=[], conversations=[], promptUpdates=updates)))
                deadline, authorized, phases = time.monotonic() + 20, False, []
                while True:
                    status = native("/internal/download/status")
                    assert status["runId"] == run_id and not status.get("tickets"), status
                    if not phases or phases[-1] != status["phase"]:
                        phases.append(status["phase"])
                    if status.get("result") is not None:
                        result = status["result"]
                        break
                    if status["phase"] == "verify_account" and not authorized:
                        native("/internal/download/authorize", dict(runId=run_id, userId=USER))
                        authorized = True
                    assert time.monotonic() < deadline, "Synthetic metadata-only transaction timed out"
                    time.sleep(0.03)
                assert authorized and result["ok"] and result["published"], result
                assert result["counts"]["total"] == 0, result
                historical_expected = json.loads(json.dumps(historical_before))
                for index in (1, 2):
                    historical_expected["items"][index]["prompt"] = PROMPTS[index]
                assert json.loads(card_path.read_text(encoding="utf-8")) == historical_expected
                assert {str(path.relative_to(root)): file_snapshot(path) for path in protected} == protected_before
                assert {name: file_snapshot(card_path.parent / name) for name in original_hashes} == media_before
                assert sorted(path.name for path in card_path.parent.iterdir()) == group_files_before
                assert not (root / "_inbox").exists() and not (root / "_state/.giv-go-download.json").exists()
                report["historicalMetadataOnly"] = dict(remoteAssets=0, targets=len(targets), updates=len(updates),
                    phases=phases, result={key: result[key] for key in ("ok", "published", "counts")},
                    preservedMedia=media_before, preservedIndexAndState=protected_before,
                    omittedRemotePromptRetained=card["items"][0]["id"])
                report["checks"].append("native-empty-asset-transaction-backfills-missing-and-old-prompts-preserving-unknown-sibling")
                report["checks"].append("metadata-only-keeps-media-hash-mtime-index-state-and-group-files-unchanged")

                # Refresh using the production settings action, not a private
                # adapter or a page navigation that would hide stale UI caches.
                page.locator("#settingsBtn").click()
                expect(page.locator("#settingsDialog")).to_be_visible()
                with page.expect_response(lambda response: response.url == ready["origin"] + "/api/library"
                                          and response.request.method == "GET") as refreshed:
                    page.locator("#libraryReload").click()
                assert refreshed.value.status == 200
                expect(page.locator("#settingsMessage")).to_have_text("图库已重新加载。")
                expect(page.locator("#libraryReload")).to_be_enabled()
                page.locator("#settingsClose").click()
                open_group()
                for index, prompt in enumerate(PROMPTS):
                    assert_current(index, prompt, "metadata-only-real-reload")
                report["checks"].append("production-reload-renders-repaired-live-prompts-and-copy-without-inheriting-group-title")
                page.screenshot(path=str(output / "historical-prompts-reloaded.png"), animations="disabled")
                assert card["title"] == TITLE
                directory = card_path.parent
                assert {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in original_hashes} == original_hashes
                assert {str(path.relative_to(root)): file_snapshot(path) for path in protected} == protected_before
                assert {name: file_snapshot(directory / name) for name in original_hashes} == media_before
                report["originalMediaSha256"] = original_hashes
                assert not report["pageErrors"], report["pageErrors"]
                context.close()
            finally:
                browser.close()
        success = True
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        if process is not None:
            process.stdin.close()
            try:
                process.wait(timeout=20)
            except Exception:
                process.terminate()
                process.wait(timeout=10)
            report["sidecarExit"] = process.returncode
            report["sidecarStderr"] = process.stderr.read()
            success = success and process.returncode == 0
        report["success"] = success
        report["binarySha256"] = hashlib.sha256(args.sidecar.read_bytes()).hexdigest()
        report["staticIndexSha256"] = hashlib.sha256((repo / "frontend-react/dist/index.html").read_bytes()).hexdigest()
        (output / "prompt-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        if success:
            remove_owned_fixture(work, output)
            inventory["fixtureRemoved"] = True
        else:
            inventory["failureFixtureRetained"] = str(work)
        (output / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    assert success


if __name__ == "__main__":
    main()
