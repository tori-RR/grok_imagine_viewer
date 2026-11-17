"""Exercise the shipped history dialog with a real fixture sidecar and a fake native downloader.

Only generated galleries/configuration are used. The native adapter records IDs;
it never opens Grok or downloads remote media. Requires the visual harness deps.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
import tempfile

from playwright.sync_api import expect, sync_playwright
from stack_evo_visual import fixtures, start


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--chromium")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    args.out.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix="giv-history-ui-") as temp, sync_playwright() as pw:
        base = Path(temp)
        root = base / "gallery"
        fixtures(root)
        config = base / "app"
        process, ready, token = start(args.sidecar.resolve(), repo / "frontend-react/dist", config, root)
        try:
            database = sqlite3.connect(config / "stack-evo-state/history.sqlite")
            failures = [dict(assetId="retry-alpha", stage="transfer", code="network", message="Synthetic network failure", attempt=2, retryable=True),
                        dict(assetId="retry-beta", stage="transfer", code="timeout", message="Synthetic timeout", attempt=2, retryable=True),
                        dict(assetId="permanent", stage="transfer", code="signature_mismatch", message="<img src=x onerror=alert(1)>", attempt=1, retryable=False)]
            records = [("fixture-partial", 1, str(root.resolve()), "2026-11-03T00:00:00Z", "partial", json.dumps(failures)),
                       ("fixture-interrupted", 2, str(root.resolve()), "2026-11-02T00:00:00Z", "interrupted", "null")]
            records += [(f"fixture-older-{index}", index+3, str(root.resolve()), (datetime(2026,10,1,tzinfo=timezone.utc)+timedelta(seconds=index)).isoformat().replace('+00:00','Z'), "failed" if index==0 else "succeeded", json.dumps([dict(assetId="oldest-retry-asset",stage="transfer",code="network",message="Synthetic old failure",attempt=1,retryable=True)]) if index==0 else "[]") for index in range(203)]
            records = [(*row, int(datetime.fromisoformat(row[3].replace('Z', '+00:00')).timestamp()) * 1_000_000_000) for row in records]
            database.executemany("INSERT INTO runs(id,run_id,root,started_at,phase,failures,started_at_ns) VALUES(?,?,?,?,?,?,?)", records)
            database.commit()
            database.close()
            browser = pw.chromium.launch(headless=True, executable_path=args.chromium)
            context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN", reduced_motion="reduce")
            context.add_cookies([dict(name=ready["cookie"], value=token, url=ready["origin"], httpOnly=True, sameSite="Strict")])
            context.add_init_script("""window.__fixtureDownloads=[]; window.__fixtureStops=0;
                window.viewer={shell:'tauri',capabilities:['startDownload','stopDownload'],
                  startDownload: args=>{window.__fixtureDownloads.push(args); return new Promise(resolve=>window.__fixtureResolve=resolve);},
                  stopDownload: async()=>{window.__fixtureStops++; window.__fixtureResolve({stopped:true}); return {stopped:true};}};""")
            page = context.new_page()
            errors = []
            history_requests = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: history_requests.append(request.url) if "/api/download/history?" in request.url else None)
            page.goto(ready["origin"], wait_until="networkidle")
            page.locator("#main .tile").first.wait_for(state="visible")
            page.locator("#downloadHistoryBtn").click()
            dialog = page.locator("#downloadHistoryDialog")
            expect(dialog).to_be_visible()
            expect(dialog.locator("article")).to_have_count(50)
            dialog.get_by_role("button", name=re.compile("查看失败明细")).click()
            expect(dialog.get_by_role("checkbox")).to_have_count(2)
            expect(dialog.locator("img")).to_have_count(0)
            page.evaluate("window.GivI18n.setPreference('en')")
            expect(dialog.get_by_role("heading", name="Download history")).to_be_visible()
            dialog.get_by_role("checkbox", name="Retry retry-beta", exact=True).uncheck()
            page.screenshot(path=str(args.out / "history-en.png"))
            dialog.get_by_role("button", name="Retry selected failures (1)", exact=True).click()
            page.wait_for_function("window.__fixtureDownloads.length===1")
            assert page.evaluate("window.__fixtureDownloads[0]") == dict(root=str(root.resolve()), retryOf="fixture-partial", retryAssetIds=["retry-alpha"])
            expect(dialog.get_by_role("checkbox").first).to_be_disabled()
            # Completing an action refreshes history and resets expanded rows
            # and selection. Wait for that refresh instead of racing the brief
            # enabled state of the old retry button before React's effect runs.
            with page.expect_request(lambda request: "/api/download/history?" in request.url and request.method == "GET") as refreshed:
                page.evaluate("window.__fixtureResolve({ok:false,published:false,error:'Synthetic fixture result'})")
            refreshed_response = refreshed.value.response()
            assert refreshed_response is not None and refreshed_response.status == 200
            refreshed_data = refreshed_response.json()
            assert refreshed_data["ok"] and Path(refreshed_data["root"]) == root.resolve()
            assert len(refreshed_data["items"]) == 50
            expect(dialog.locator("article")).to_have_count(50)
            expect(dialog.get_by_role("checkbox")).to_have_count(0)
            expect(dialog.get_by_role("button", name="Refresh history", exact=True)).to_be_enabled()
            expect(page.locator("#dlBtn")).not_to_have_class(re.compile(r"\bbusy\b"))
            expect(page.locator("#dlBtn")).to_be_enabled()
            dialog.get_by_role("button", name=re.compile(r"^Show failures")).click()
            expect(dialog.get_by_role("checkbox")).to_have_count(2)
            for checkbox in dialog.get_by_role("checkbox").all():
                expect(checkbox).to_be_checked()
                expect(checkbox).to_be_enabled()
            expect(dialog.get_by_role("button", name="Retry selected failures (2)", exact=True)).to_be_enabled()
            checks += ["production-entry-mounted", "history-pagination-initial-50", "null-failures", "i18n-live-switch", "failure-text-escaped", "selected-ids-only", "busy-guard"]
            checks += ["retry-completion-refresh", "download-busy-cleared", "refreshed-failures-reopen-with-default-selection"]

            dialog.get_by_role("button", name="Load earlier records", exact=True).click()
            expect(dialog.locator("article")).to_have_count(100)
            for expected in (150,200,205):
                dialog.get_by_role("button",name="Load earlier records",exact=True).click()
                expect(dialog.locator("article")).to_have_count(expected)
            oldest=dialog.locator("article").last
            (args.out / "history-pagination-tail.json").write_text(json.dumps(dialog.locator("article").all_text_contents()[-3:],indent=2),encoding="utf-8")
            oldest.get_by_role("button",name=re.compile(r"^Show failures")).click()
            expect(oldest.get_by_role("checkbox",name="Retry oldest-retry-asset",exact=True)).to_be_checked()
            expect(oldest.get_by_role("button",name="Retry selected failures (1)",exact=True)).to_be_enabled()
            expect(dialog.get_by_role("button",name="Load earlier records",exact=True)).to_have_count(0)
            bounds = dialog.bounding_box()
            page.mouse.move(bounds["x"]+100, bounds["y"]+30)
            page.mouse.down()
            page.mouse.move(bounds["x"]-20, bounds["y"]+30)
            page.mouse.up()
            expect(dialog).to_be_visible()
            checks.append("inside-to-backdrop-drag-keeps-dialog")
            dialog.get_by_role("button", name="Resume unfinished download", exact=True).click()
            page.wait_for_function("window.__fixtureDownloads.length===2")
            assert page.evaluate("window.__fixtureDownloads[1]") == dict(root=str(root.resolve()))
            page.keyboard.press("Escape")
            expect(dialog).not_to_be_visible()
            page.locator("#dlBtn").click()
            page.wait_for_function("window.__fixtureStops===1")
            expect(page.locator("#dlBtn")).to_be_enabled()
            # A bounded quiet interval is necessary to prove that a closed panel
            # cancels polling rather than merely hiding its DOM.
            page.wait_for_timeout(250)
            requests_before = len(history_requests)
            page.wait_for_timeout(2300)
            assert len(history_requests) == requests_before, "closed dialog kept polling"
            checks += ["history-pagination-205-with-oldest-retry", "resume-fresh-manifest", "controller-cancel", "escape-close", "closed-panel-stops-polling"]

            page.route("**/api/download/history?*", lambda route: route.fulfill(json={"ok": True, "root": str(base / "wrong-library"), "items": []}))
            page.locator("#downloadHistoryBtn").click()
            expect(dialog.get_by_role("alert")).to_contain_text("The library changed")
            expect(dialog.locator("article")).to_have_count(0)
            bounds = dialog.bounding_box()
            page.mouse.click(bounds["x"]-20, bounds["y"]+30)
            expect(dialog).not_to_be_visible()
            checks.append("stationary-backdrop-click-closes")
            checks.append("mismatched-root-response-rejected")
            assert not errors, errors
            context.close()
            browser.close()
        finally:
            process.stdin.close()
            process.wait(timeout=20)
    report = {"checks": checks, "pageErrors": errors, "nativeDownloader": "synthetic adapter; no Grok access"}
    (args.out / "history-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
