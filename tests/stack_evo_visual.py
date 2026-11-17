"""Pixel/interaction parity against the preserved original UI. Synthetic media only.
Requires playwright + Pillow; --chromium can point to a system Chromium binary.
"""
from __future__ import annotations
import argparse, json, secrets, subprocess, tempfile, time
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import expect, sync_playwright


def fixtures(root: Path):
    groups = []
    for n in range(1, 7):
        folder = f"{n:04d}_fixture{n}"
        d = root / "combos" / folder
        d.mkdir(parents=True)
        items = []
        for i in range(1, 4):
            ident = f"fixture-{n}-{i}"
            image = Image.new("RGB", (400, 300 + ((n+i)%3)*100), (32+n*18, 43+i*25, 72+n*7))
            draw = ImageDraw.Draw(image)
            draw.rectangle((40, 40, 320, 210), outline=(188,194,204), width=3)
            draw.text((60,80), f"Fixture {n} / {i}", fill=(230,230,230))
            image.save(d / f"{ident}.jpg")
            items.append(dict(id=ident,file=f"{ident}.jpg",mime="image/jpeg",created=f"2026-01-{n:02d}T12:00:00Z",prompt="Synthetic visual regression fixture",status="linked"))
        card=dict(id=f"fixture-group-{n}",n=n,title=f"Fixture collection {n}",folder=folder,created=f"2026-01-{n:02d}T12:00:00Z",items=items)
        (d/"card.json").write_text(json.dumps(card),encoding="utf-8")
        groups.append({**card,"count":len(items),"images":len(items),"videos":0})
    (root/"_index.json").write_text(json.dumps(dict(combos=groups,other=[],summary={})),encoding="utf-8")


def start(binary: Path, static: Path, base: Path, root: Path | None):
    base.mkdir(exist_ok=True)
    token=secrets.token_hex(32)
    boot=dict(protocolVersion=3,instanceSecret=secrets.token_hex(32),sessionToken=token,instanceId=secrets.token_hex(16),serverPath=str(binary),staticDir=str(static),configPath=str(base/"config.json"),desktop=str(base.parent),language="zh-CN",downloadBindOnly=True,root=str(root) if root else "")
    process=subprocess.Popen([str(binary)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    process.stdin.write(json.dumps(boot)+"\n");process.stdin.flush()
    line=process.stdout.readline()
    if not line: raise RuntimeError(process.stderr.read())
    ready=json.loads(line)
    return process,ready,token


def main():
    ap=argparse.ArgumentParser();ap.add_argument("--sidecar",required=True);ap.add_argument("--repo",default=str(Path(__file__).resolve().parent.parent));ap.add_argument("--out",required=True);ap.add_argument("--chromium")
    ap.add_argument("--screens", nargs="+")
    args=ap.parse_args();repo=Path(args.repo).resolve();out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    reports=[];diagnostics=[];launcher_interactions=[]
    with tempfile.TemporaryDirectory(prefix="giv-visual-") as temp, sync_playwright() as pw:
        base=Path(temp);root=base/"gallery";fixtures(root)
        browser=pw.chromium.launch(headless=True,executable_path=args.chromium,args=["--no-sandbox"])
        for name, viewport, selected in [("launcher",(1280,800),False),("gallery",(1280,800),True),("compact",(768,900),True),("view-menu",(1280,800),True),("preview",(1280,800),True),("directory-picker",(1280,800),True)]:
            if args.screens and name not in args.screens: continue
            shots=[]
            for kind,static in [("original",repo/"static"),("react",repo/"frontend-react/dist")]:
                app_base=base/(name+kind)
                if name=="launcher":
                    # A fresh configuration misses the regression where a saved
                    # root bypasses the launcher. Both renderers get the same
                    # existing and unavailable recent paths, but no explicit root.
                    app_base.mkdir()
                    saved=dict(root=str(root),history=[str(root),str(base/"missing-gallery")])
                    config_file=app_base/"config.json"
                    config_file.write_text(json.dumps(saved),encoding="utf-8")
                    saved_bytes=config_file.read_bytes()
                process,ready,token=start(Path(args.sidecar).resolve(),static,app_base,root if selected else None)
                try:
                    context=browser.new_context(viewport=dict(width=viewport[0],height=viewport[1]),device_scale_factor=1,locale="zh-CN",reduced_motion="reduce")
                    context.add_cookies([dict(name=ready["cookie"],value=token,url=ready["origin"],httpOnly=True,sameSite="Strict")])
                    page=context.new_page();errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
                    page.goto(ready["origin"],wait_until="networkidle")
                    if selected:
                        page.locator("#main .tile").first.wait_for(state="visible")
                        # A cold cover request may serve the original JPEG while
                        # FFmpeg builds its thumbnail. Wait for the real fixture
                        # cache before comparing; otherwise the second renderer
                        # gets different source pixels even with identical CSS.
                        accel=page.evaluate("fetch('/api/accel').then(response=>response.json())")
                        if accel.get("covers"):
                            deadline=time.monotonic()+30
                            while len([p for p in (root/".viewer-cache/go-covers").glob("*.jpg") if not p.name.startswith(".")])<6:
                                if time.monotonic()>deadline: raise AssertionError("Fixture thumbnails did not become ready")
                                time.sleep(0.05)
                            page.reload(wait_until="networkidle")
                        page.wait_for_function("() => document.querySelectorAll('#main .tile img').length===6 && Array.from(document.querySelectorAll('#main .tile img')).every(x=>x.complete && x.naturalWidth>0)")
                    else:
                        page.locator("#launcher").wait_for(state="visible")
                        history=page.locator("#launcherHistory .history-row")
                        expect(history).to_have_count(2)
                        expect(history.nth(0).locator(".history-name")).to_have_text(root.name)
                        expect(history.nth(0).locator(".history-path")).to_have_text(str(root))
                        expect(history.nth(1)).to_have_class("history-row missing")
                        expect(history.nth(1).locator(".history-path")).to_have_text(str(base/"missing-gallery"))
                        expect(history.nth(1).locator(".history-mark")).to_have_text("路径不在了")
                        config=page.evaluate("fetch('/api/config').then(response=>response.json())")
                        assert config["root"]=="" and not config["ok"], "Saved root was activated before user selection"
                        assert config["lastRoot"]==str(root) and [row["path"] for row in config["history"]]==saved["history"], "Recent libraries were lost"
                        assert config_file.read_bytes()==saved_bytes, "Default startup rewrote saved settings"
                    if name=="view-menu":page.locator("#viewBtn").click()
                    if name=="preview":
                        page.locator("#main .tile").first.click()
                        page.locator("#comboPreview").wait_for(state="visible")
                    if name=="directory-picker":
                        page.locator("#plusBtn").click()
                        panel=page.locator("#browser .modal-panel")
                        panel.wait_for(state="visible")
                        before=panel.bounding_box()["height"]
                        assert abs(before-max(viewport[1]*0.6,420))<1, "Mainline fixed-height picker regressed"
                        page.locator("#browserPath").fill(str(root/"combos"))
                        page.locator("#browserPath").press("Enter")
                        expect(page.locator("#browserList button")).to_have_count(6)
                        expect(page.locator("#browserUse")).to_be_enabled()
                        assert abs(panel.bounding_box()["height"]-before)<1, "Folder changes moved picker controls"
                        page.locator("#browserPath").focus()
                        expect(page.locator("#browserPath")).to_be_focused()
                    page.evaluate("() => document.fonts.ready")
                    if name=="directory-picker":
                        diagnostics.append(dict(screen=name, entry=kind, state=page.locator("#browserPath").evaluate("""el => {
                          const style=getComputedStyle(el), rect=el.getBoundingClientRect();
                          return {activeElement:document.activeElement?.id,focusVisible:el.matches(':focus-visible'),
                            rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
                            style:Object.fromEntries(['colorScheme','borderTopColor','borderTopWidth','borderTopStyle','outlineColor','outlineWidth','outlineStyle','outlineOffset','boxShadow','fontFamily','fontSize'].map(key=>[key,style[key]])),
                            colorSchemeMeta:document.querySelector('meta[name="color-scheme"]')?.content ?? null};
                        }""")))
                    page.wait_for_timeout(500)
                    if errors: raise AssertionError((name,kind,errors))
                    path=out/f"{name}-{kind}.png";page.screenshot(path=str(path),animations="disabled");shots.append(path)
                    if name=="launcher":
                        # Preserve the homepage screenshot, then exercise the
                        # actual recent-item action instead of selecting via API.
                        history.nth(0).locator(".history-open").click()
                        expect(page.locator("#launcher")).to_be_hidden()
                        page.locator("#main .tile").first.wait_for(state="visible")
                        active=page.evaluate("fetch('/api/config?minimal=1').then(response=>response.json())")
                        assert Path(active["root"])==root, "Recent-item click did not select the gallery"
                        if errors: raise AssertionError((name,kind,errors))
                        launcher_interactions.append(dict(entry=kind,savedRootDeferred=True,historyPreserved=True,missingPathNotice=True,settingsUnchangedBeforeSelection=True,recentClickOpensLibrary=True))
                    context.close()
                finally:
                    process.stdin.close();process.wait(timeout=20)
            a=Image.open(shots[0]).convert("RGB");b=Image.open(shots[1]).convert("RGB")
            delta=ImageChops.difference(a,b)
            changed=sum(1 for p in delta.getdata() if max(p)>3)
            report=dict(screen=name,pixels=a.width*a.height,changedPixels=changed,changedRatio=changed/(a.width*a.height))
            reports.append(report)
            delta.save(out/f"{name}-diff.png")
        browser.close()
    (out/"computed-styles.json").write_text(json.dumps(diagnostics,indent=2),encoding="utf-8")
    (out/"launcher-interactions.json").write_text(json.dumps(launcher_interactions,indent=2),encoding="utf-8")
    (out/"report.json").write_text(json.dumps(reports,indent=2),encoding="utf-8")
    print(json.dumps(reports,indent=2))
    assert all(r["changedRatio"]<=0.001 for r in reports), "Visual mismatch exceeds 0.1%"

if __name__=="__main__":main()
