"""Production-bundle viewport/selection regression; synthetic thumbnail data only.

Requires the same cached Playwright/Pillow environment as stack_evo_visual.py.
No performance threshold: assertions cover geometry, bounded mounted content,
selection state and media identity rather than machine-dependent frame times.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile

from PIL import Image
from playwright.sync_api import expect, sync_playwright

from stack_evo_visual import start

GROUPS = 1000
DATA_BUDGET = 100 * 1024 * 1024


def make_gallery(root: Path):
    root.mkdir()
    # Thumbnail-sized pixels keep the deliberately broken all-mounted red
    # case small as well. Every group still has its own URL and real file.
    template = root / "thumbnail-template.jpg"
    Image.new("RGB", (96, 72), (64, 104, 144)).save(template, quality=70)
    thumbnail = template.read_bytes()
    template.unlink()
    groups = []
    for index in range(GROUPS):
        folder = f"{index + 1:04d}_fixture"
        directory = root / "combos" / folder
        directory.mkdir(parents=True)
        (directory / "image.jpg").write_bytes(thumbnail)
        ident = f"fixture-{index + 1}"
        card = dict(id=ident, n=index + 1, folder=folder, title=f"Fixture {index + 1}",
                    created="2026-01-01T00:00:00Z", items=[dict(id=ident + "-image", file="image.jpg",
                    mime="image/jpeg", created="2026-01-01T00:00:00Z", status="linked")])
        (directory / "card.json").write_text(json.dumps(card), encoding="utf-8")
        groups.append({key: value for key, value in card.items() if key != "items"} | dict(count=1, images=1, videos=0))
    (root / "_index.json").write_text(json.dumps(dict(combos=groups, other=[], summary={})), encoding="utf-8")


GEOMETRY = """() => {
  const scroller = document.querySelector('#main .grid-scroll');
  const surface = scroller?.querySelector('.wall');
  const tiles = [...document.querySelectorAll('#main .tile')];
  const rects = tiles.map(tile => tile.getBoundingClientRect());
  const r = scroller?.getBoundingClientRect();
  return {viewport:{width:innerWidth,height:innerHeight}, mounted:tiles.length,
    columns:new Set(rects.map(r=>Math.round(r.x))).size,
    minTileHeight:rects.length ? Math.min(...rects.map(r=>r.height)) : 0,
    tileWidth:rects[0]?.width || 0,
    scroller:scroller && {clientWidth:scroller.clientWidth,clientHeight:scroller.clientHeight,
      scrollHeight:scroller.scrollHeight,scrollTop:scroller.scrollTop,
      top:r.top,bottom:r.bottom},
    surfaceHeight:surface?.getBoundingClientRect().height,
    keys:tiles.map(tile=>tile.dataset.groupKey),
    selected:tiles.filter(tile=>tile.classList.contains('picked')).map(tile=>tile.dataset.groupKey)};
}"""


def bounded(snapshot):
    scroller = snapshot["scroller"]
    assert scroller and 0 < scroller["clientHeight"] <= snapshot["viewport"]["height"], (
        "production scroller expanded beyond its viewport", snapshot)
    assert scroller["top"] >= -2 and scroller["bottom"] <= snapshot["viewport"]["height"] + 2, snapshot
    assert scroller["scrollHeight"] > scroller["clientHeight"] * 3, ("fixture is not meaningfully scrollable", snapshot)
    assert snapshot["mounted"] > 0 and snapshot["columns"] > 0 and snapshot["minTileHeight"] > 0, snapshot
    # Loose viewport + overscan envelope, deliberately larger than the current
    # implementation's 420px overscan/400px bands. This does not mirror its
    # painter; it rejects an all-N wall while allowing band/edge rounding.
    limit = snapshot["columns"] * (math.ceil((scroller["clientHeight"] + 2000) / snapshot["minTileHeight"]) + 4)
    assert limit < GROUPS and snapshot["mounted"] <= limit, ("mounted content escaped viewport envelope", limit, snapshot)
    return limit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--chromium")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="giv-virtualization-", dir=output)).resolve()
    inventory = dict(owner="stack_evo_virtualization_ui", fixture=str(work),
                     purpose="1000 synthetic tiny JPEG/card/index/app config/SQLite; no real user data", retainOnFailure=True)
    (output / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    process = None
    success = False
    report = dict(groups=GROUPS, checks=[], geometry=[], pageErrors=[])
    try:
        root = work / "gallery"
        make_gallery(root)
        assert sum(path.stat().st_size for path in work.rglob("*") if path.is_file()) < DATA_BUDGET
        process, ready, token = start(args.sidecar.resolve(), repo / "frontend-react/dist", work / "app", root)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
            try:
                context = browser.new_context(viewport=dict(width=1600, height=1000), locale="zh-CN", reduced_motion="reduce")
                context.add_cookies([dict(name=ready["cookie"], value=token, url=ready["origin"], httpOnly=True, sameSite="Strict")])
                page = context.new_page()
                page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
                page.goto(ready["origin"], wait_until="networkidle")
                expect(page.get_by_role("main")).to_be_visible()
                page.locator("#selectBtn").focus()
                expect(page.locator("#selectBtn")).to_be_focused()
                page.wait_for_function("""() => document.querySelectorAll('#main .tile img').length > 0 &&
                  [...document.querySelectorAll('#main .tile img')].every(img => img.complete && img.naturalWidth > 0)""")

                def frames():
                    page.evaluate("() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")

                def record(stage):
                    frames()
                    geometry = page.evaluate(GEOMETRY)
                    geometry["stage"] = stage
                    report["geometry"].append(geometry)
                    # Save before asserting: old production dist should fail
                    # with a useful scroller/mounted observation, not a timeout.
                    (output / "virtualization-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
                    geometry["mountedLimit"] = bounded(geometry)
                    return geometry

                initial = record("initial")
                report["checks"].append("production-scroller-constrained-and-mounted-content-bounded")
                initial_key = initial["keys"][0]
                # The transparent React root must preserve semantic content,
                # keyboard focus and the separate native dialog's focus loop.
                history_button = page.locator("#downloadHistoryBtn")
                history_button.focus()
                history_button.press("Enter")
                expect(page.get_by_role("dialog", name="下载历史", exact=True)).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.locator("#downloadHistoryDialog")).not_to_be_visible()
                expect(history_button).to_be_focused()
                report["checks"].append("main-selection-focus-and-history-dialog-escape-focus-return")

                # Each real click gets a separate render opportunity. Selection
                # is the only observed operation in this identity/request scope;
                # scrolling legitimately mounts and fetches different media.
                requests = []
                page.on("request", lambda request: requests.append(request.url.split("?", 1)[0]) if any(
                    path in request.url for path in ("/media/", "/resource/cover", "/api/cover/prepare")) else None)
                page.evaluate("""() => {
                  const tiles=[...document.querySelectorAll('#main .tile')];
                  const p=window.__virtualizationTest={tiles,images:tiles.map(t=>t.querySelector('img')),removed:0};
                  p.observer=new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)
                    if(n.nodeType===1&&(n.matches('.tile,img,video')||n.querySelector('.tile,img,video')))p.removed++});
                  p.observer.observe(document.querySelector('#main'),{childList:true,subtree:true});
                }""")
                for _ in range(3):
                    page.locator("#selectBtn").click(); frames()
                    page.locator("#main .tile .tile-check").first.click(); frames()
                    expect(page.locator("#main .tile .tile-check").first).to_have_attribute("aria-pressed", "true")
                    page.locator("#selDone").click(); frames()
                    expect(page.locator("#main .tile .tile-check").first).to_have_attribute("aria-pressed", "false")
                identities = page.evaluate("""() => {
                  const p=window.__virtualizationTest,current=[...document.querySelectorAll('#main .tile')];p.observer.disconnect();
                  return {sameTiles:p.tiles.length===current.length&&p.tiles.every((t,i)=>t===current[i]),
                    sameImages:p.images.every((image,i)=>image===current[i]?.querySelector('img')),removedMediaNodes:p.removed};
                }""")
                identities["newMediaRequests"] = len(requests)
                report["selectionIdentity"] = identities
                assert identities["sameTiles"] and identities["sameImages"] and identities["removedMediaNodes"] == 0 and not requests, identities
                report["checks"].append("separate-real-selection-clicks-preserve-media-identity-without-new-requests")

                def key_tile(key):
                    return page.locator('#main .tile[data-group-key="' + key + '"]')

                def scroll_to(fraction):
                    page.locator("#main .grid-scroll").evaluate("(e,f)=>{e.scrollTop=(e.scrollHeight-e.clientHeight)*f}", fraction)
                    frames()

                page.locator("#selectBtn").click()
                key_tile(initial_key).locator(".tile-check").click()
                scroll_to(.5)
                expect(key_tile(initial_key)).to_have_count(0)
                middle = record("middle-selected")
                assert not middle["selected"], middle
                page.locator("#main .tile .tile-check").first.click()
                expect(page.locator("#selCount")).to_have_text("已选择 2 项")
                scroll_to(0)
                expect(key_tile(initial_key).locator(".tile-check")).to_have_attribute("aria-pressed", "true")
                record("returned-selected-pool-state")
                scroll_to(1)
                bottom = record("bottom-before-exit")
                assert bottom["scroller"]["scrollTop"] > initial["scroller"]["clientHeight"], bottom
                page.locator("#selDone").click(); frames()
                scroll_to(0)
                expect(key_tile(initial_key).locator(".tile-check")).to_have_attribute("aria-pressed", "false")
                assert not record("returned-after-offscreen-selection-exit")["selected"]
                report["checks"].append("scrolling-and-offscreen-pool-selection-state-remain-correct")

                page.locator("#selectBtn").click()
                key_tile(initial_key).locator(".tile-check").click()
                page.set_viewport_size(dict(width=1024, height=768))
                record("resized-while-selected")
                expect(key_tile(initial_key).locator(".tile-check")).to_have_attribute("aria-pressed", "true")
                # The compact selection toolbar intentionally occupies the
                # navigation corner. Leave selection normally before using
                # its covered View control; never bypass pointer hit testing.
                page.locator("#selDone").click(); frames()
                assert not record("narrow-viewport-after-selection-exit")["selected"]
                page.locator("#viewBtn").click()
                slider = page.locator("#viewMenu input[type=range]")
                slider.focus(); slider.press("End")
                expect(slider).to_have_value("240")
                page.wait_for_function("() => document.querySelector('#main .tile').getBoundingClientRect().width >= 230")
                record("slider-large-tiles")
                slider.focus(); slider.press("Home")
                expect(slider).to_have_value("96")
                page.wait_for_function("() => document.querySelector('#main .tile').getBoundingClientRect().width < 130")
                record("slider-small-tiles")
                page.locator("#viewBtn").click()
                page.set_viewport_size(dict(width=1600, height=1000))
                record("expanded-viewport-small-tiles")
                page.locator("#selectBtn").click(); frames()
                page.locator("#main .tile .tile-check").first.click(); frames()
                expect(page.locator("#selCount")).to_have_text("已选择 1 项")
                page.locator("#selDone").click(); frames()
                final = record("final-after-selection-exit")
                assert not final["selected"]
                report["checks"].append("resize-slider-and-selection-exit-keep-virtualization")
                page.screenshot(path=str(output / "virtualization.png"), animations="disabled")
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
        report["fixtureBytesAtEnd"] = sum(path.stat().st_size for path in work.rglob("*") if path.is_file())
        assert report["fixtureBytesAtEnd"] < DATA_BUDGET, "Synthetic fixture exceeded its 100MiB budget"
        (output / "virtualization-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        if success:
            assert work.is_relative_to(output)
            for path in (work, *work.rglob("*")):
                assert not path.is_symlink() and not getattr(path, "is_junction", lambda: False)()
            shutil.rmtree(work)
            inventory["fixtureRemoved"] = True
        else:
            inventory["failureFixtureRetained"] = str(work)
        (output / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    assert success


if __name__ == "__main__":
    main()
