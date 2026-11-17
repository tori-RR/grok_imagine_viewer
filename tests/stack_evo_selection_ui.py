"""Production-entry selection regressions. Uses only synthetic fixture libraries."""
from __future__ import annotations
import argparse
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from stack_evo_visual import fixtures, start


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--chromium")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="giv-selection-") as temporary, sync_playwright() as pw:
        base = Path(temporary)
        root = base / "gallery"
        fixtures(root)
        process, ready, token = start(Path(args.sidecar).resolve(), repo / "frontend-react/dist", base / "app", root)
        browser = None
        try:
            browser = pw.chromium.launch(headless=True, executable_path=args.chromium, args=["--no-sandbox"])
            context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN", reduced_motion="reduce")
            context.add_cookies([dict(name=ready["cookie"], value=token, url=ready["origin"], httpOnly=True, sameSite="Strict")])
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(ready["origin"], wait_until="networkidle")
            page.wait_for_function("""() => document.querySelectorAll('#main .tile img').length === 6
                && [...document.querySelectorAll('#main .tile img')].every(img => img.complete && img.naturalWidth > 0)""")
            page.wait_for_timeout(700)  # Settle the existing card/cover asynchronous pipeline.
            requests = []
            page.on("request", lambda request: requests.append(request.url.split("?", 1)[0]) if any(path in request.url for path in ["/media/", "/resource/cover", "/api/cover/prepare"]) else None)
            result = page.evaluate("""async () => {
              const tiles = [...document.querySelectorAll('#main .tile')];
              const images = tiles.map(tile => tile.querySelector('img'));
              let removed = 0;
              const observer = new MutationObserver(records => {
                for (const record of records) for (const node of record.removedNodes) {
                  if (node.nodeType === 1 && (node.matches('.tile, img, video') || node.querySelector('.tile, img, video'))) removed++;
                }
              });
              observer.observe(document.querySelector('#main'), {childList:true,subtree:true});
              const durations = [];
              for (let i = 0; i < 30; i++) {
                const begin = performance.now();
                document.querySelector('#selectBtn').click();
                tiles[0].querySelector('.tile-check').click();
                if (!tiles[0].classList.contains('picked')) throw new Error('selection did not update');
                document.querySelector('#selAll').click();
                if (!tiles.every(tile => tile.classList.contains('picked'))) throw new Error('select all failed');
                document.querySelector('#selDone').click();
                if (tiles.some(tile => tile.classList.contains('picked'))) throw new Error('selection did not clear');
                durations.push(performance.now() - begin);
                await new Promise(requestAnimationFrame);
              }
              await new Promise(requestAnimationFrame);
              observer.disconnect();
              const current = [...document.querySelectorAll('#main .tile')];
              durations.sort((a,b) => a-b);
              return {iterations:30, mountedTiles:tiles.length, removedMediaNodes:removed,
                sameTiles:tiles.length === current.length && tiles.every((tile,i) => tile === current[i]),
                sameImages:images.every((image,i) => image === current[i]?.querySelector('img')),
                allUnselected:current.every(tile => tile.querySelector('.tile-check').getAttribute('aria-pressed') === 'false'),
                scriptIterationP50Ms:durations[Math.floor(durations.length*0.5)],
                scriptIterationP95Ms:durations[Math.floor(durations.length*0.95)]};
            }""")
            page.wait_for_timeout(250)
            result["mediaRequestsDuringSelection"] = len(requests)
            result["pageErrors"] = errors
            result["scope"] = "Synthetic Chromium production bundle; not a Windows GPU/cursor benchmark"
            (output / "selection-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            page.locator("#selectBtn").click()
            page.locator("#main .tile .tile-check").first.click()
            page.screenshot(path=str(output / "selection.png"), animations="disabled")
            assert not errors, errors
            assert result["sameTiles"] and result["sameImages"], result
            assert result["removedMediaNodes"] == 0 and result["mediaRequestsDuringSelection"] == 0, result
            assert result["allUnselected"], result
            print(json.dumps(result, indent=2))
        finally:
            if browser is not None:
                browser.close()
            process.stdin.close()
            try:
                process.wait(timeout=20)
            except Exception:
                process.terminate()  # This fixture's own subprocess, never a desktop/user process.
                process.wait(timeout=10)
                raise


if __name__ == "__main__":
    main()
