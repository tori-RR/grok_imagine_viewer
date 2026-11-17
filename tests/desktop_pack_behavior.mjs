// Exercise the real replacement script against disposable files and a fake EXE.
// --pack-only is intentional here: no fixture executable is ever launched.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repo, "output");
mkdirSync(output, {recursive: true});
const fixture = mkdtempSync(path.join(output, "desktop-pack-fixture-"));
assert.ok(fixture.startsWith(output + path.sep));
try {
  const profile = path.join(fixture, "profile");
  const target = path.join(profile, "Desktop", "grok-imagine-viewer-0.3.0");
  const cargo = path.join(fixture, "cargo");
  const temp = path.join(fixture, "temp");
  for (const dir of ["src-tauri", "scripts", "static/locales", "profile/Desktop", "cargo/release", "temp"]) mkdirSync(path.join(fixture, dir), {recursive: true});
  writeFileSync(path.join(fixture, "scripts/install-environment.ps1"), "# fixed installer fixture\n");
  writeFileSync(path.join(fixture, "src-tauri/tauri.conf.json"), "{}");
  for (const file of ["server.py", "viewer_preferences.py", "cover_acceleration.py"]) writeFileSync(path.join(fixture, file), "# fixture only\n");
  writeFileSync(path.join(cargo, "release/grok-imagine-viewer-tauri.exe"), Buffer.alloc(1_000_001, 7));
  const retained = {
    "gallery-webview2/fixture.txt": "gallery fixture",
    "grok-webview2/fixture.txt": "Grok fixture",
    "EBWebView/fixture.txt": "legacy fixture",
    "新建文件夹/keep.txt": "user library fixture",
    "notes.txt": "user notes fixture",
  };
  for (const [name, value] of Object.entries(retained)) {
    const file = path.join(target, name);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, value);
  }
  for (const version of ["first", "second"]) {
    writeFileSync(path.join(fixture, "static/index.html"), version);
    writeFileSync(path.join(fixture, "static/locales/en.js"), "// " + version);
    const result = spawnSync(process.execPath, [path.join(repo, "scripts/pack_desktop_test.mjs"), "--pack-only"], {
      cwd: fixture, encoding: "utf8",
      env: {...process.env, USERPROFILE: profile, TMP: temp, TEMP: temp, TMPDIR: temp, CARGO_TARGET_DIR: cargo},
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(path.join(target, "viewer/static/index.html"), "utf8"), version);
    assert.equal(readFileSync(path.join(target, "viewer/static/locales/en.js"), "utf8"), "// " + version);
    for (const [name, value] of Object.entries(retained)) assert.equal(readFileSync(path.join(target, name), "utf8"), value, name + " must survive replacement");
    assert.match(result.stdout, /file\s+[a-f0-9]{64}\s+viewer\/static\/locales\/en.js/);
  }
  console.log("ok  desktop replacement updates resources and preserves profiles, user folders and extra files across repeated updates");
  const runtime = path.join(fixture, "runtime/win64/portable-managed");
  mkdirSync(path.join(fixture, "scripts"), {recursive: true});
  writeFileSync(path.join(fixture, "scripts/install_video_tools.py"), "# installer fixture\n");
  const {createHash} = await import("node:crypto");
  const files = {};
  for (const name of ["python/python.exe", "python/python314._pth", "licenses/fixture.txt"]) {
    mkdirSync(path.dirname(path.join(runtime, name)), {recursive: true});
    writeFileSync(path.join(runtime, name), name);
    files[name] = createHash("sha256").update(name).digest("hex");
  }
  writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({files, sources: {fixture: {version: "test"}}}));
  const release = path.join(profile, "Desktop/grok-imagine-viewer-release");
  const pack = () => spawnSync(process.execPath, [path.join(repo, "scripts/pack_desktop_test.mjs"), "--pack-only", "--portable"], {
    cwd: fixture, encoding: "utf8", env: {...process.env, USERPROFILE: profile, TMP: temp, TEMP: temp, TMPDIR: temp, CARGO_TARGET_DIR: cargo},
  });
  for (const iteration of [1, 2]) {
    const result = pack();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(path.join(release, "release-manifest.json"), "utf8"));
    assert.equal(manifest.architecture, "x64");
    assert.equal(readFileSync(path.join(release, "viewer/runtime/win64/python.exe"), "utf8"), "python/python.exe");
    assert.equal(manifest.files["webview2/msedge.dll"], undefined);
    assert.equal(manifest.files["viewer/runtime/win64/ffmpeg.exe"], undefined);
    assert.equal(manifest.files["viewer/runtime/win64/ffprobe.exe"], undefined);
    assert.equal(readFileSync(path.join(release, "viewer/install-environment.ps1"), "utf8"), "# fixed installer fixture\n");
    assert.equal(manifest.files["viewer/runtime/win64/ffplay.exe"], undefined);
    assert.equal(manifest.files["install-video-tools.cmd"], undefined);
    assert.ok(manifest.files["viewer/static/locales/en.js"]);
    if (iteration === 1) {
      mkdirSync(path.join(release, "grok-webview2"));
      writeFileSync(path.join(release, "grok-webview2/fixture.txt"), "release profile fixture");
      writeFileSync(path.join(release, "notes.txt"), "release notes fixture");
      mkdirSync(path.join(release, "video-tools"));
      writeFileSync(path.join(release, "video-tools/fixture.txt"), "optional component fixture");
      mkdirSync(path.join(release, "webview2"));
      writeFileSync(path.join(release, "webview2/fixture.txt"), "superseded full runtime fixture");
    } else {
      assert.equal(readFileSync(path.join(release, "grok-webview2/fixture.txt"), "utf8"), "release profile fixture");
      assert.equal(readFileSync(path.join(release, "notes.txt"), "utf8"), "release notes fixture");
      assert.equal(readFileSync(path.join(release, "video-tools/fixture.txt"), "utf8"), "optional component fixture");
      assert.equal(manifest.files["webview2/fixture.txt"], undefined);
    }
  }
  mkdirSync(path.join(fixture, "tests/fixtures"), {recursive: true});
  writeFileSync(path.join(fixture, "tests/fixtures/environment-preview.js"), readFileSync(path.join(repo, "tests/fixtures/environment-preview.js")));
  writeFileSync(path.join(fixture, "static/index.html"), '<script src="/static/environment.js"></script>\n<script src="/static/app.js"></script>');
  const demo = spawnSync(process.execPath, [path.join(repo, "scripts/pack_desktop_test.mjs"), "--pack-only", "--portable", "--environment-preview"], {
    cwd: fixture, encoding: "utf8", env: {...process.env, GIV_PACK_FIXTURE: "1", USERPROFILE: profile, TMP: temp, TEMP: temp, TMPDIR: temp, CARGO_TARGET_DIR: cargo},
  });
  assert.equal(demo.status, 0, demo.stderr || demo.stdout);
  const preview = path.join(profile, "Desktop/grok-imagine-viewer-environment-preview");
  const previewManifest = JSON.parse(readFileSync(path.join(preview, "release-manifest.json"), "utf8"));
  assert.equal(previewManifest.environmentPreview, true);
  assert.ok(previewManifest.files["viewer/static/environment-preview.js"]);
  const previewHTML = readFileSync(path.join(preview, "viewer/static/index.html"), "utf8");
  assert.ok(previewHTML.indexOf('/static/environment.js') < previewHTML.indexOf('/static/environment-preview.js'));
  assert.ok(previewHTML.indexOf('/static/environment-preview.js') < previewHTML.indexOf('/static/app.js'));
  assert.equal(readFileSync(path.join(release, "viewer/static/index.html"), "utf8"), "second");
  assert.equal(JSON.parse(readFileSync(path.join(release, "release-manifest.json"), "utf8")).files["viewer/static/environment-preview.js"], undefined);
  assert.match(readFileSync(path.join(preview, "README-portable.txt"), "utf8"), /This is a simulation/);
  writeFileSync(path.join(runtime, "python/python.exe"), "corrupt fixture");
  const failed = pack();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /runtime hash\/path mismatch/);
  assert.equal(readFileSync(path.join(release, "viewer/runtime/win64/python.exe"), "utf8"), "python/python.exe");
  assert.equal(readFileSync(path.join(target, "viewer/static/index.html"), "utf8"), "second");
  console.log("ok  portable release contains verified runtimes and i18n, preserves user files, rejects corrupt input and leaves the old test folder untouched");
  // The migration branch must deliver the newly built Go/React resources,
  // rather than a Tauri EXE beside the old Python/static resource tree.
  writeFileSync(path.join(fixture, "src-tauri/tauri.conf.json"), JSON.stringify({bundle: {resources: {"../backend-go/bin/giv-backend.exe": "viewer/giv-backend.exe"}}}));
  mkdirSync(path.join(fixture, "backend-go/bin"), {recursive: true});
  mkdirSync(path.join(fixture, "frontend-react/dist/assets"), {recursive: true});
  writeFileSync(path.join(fixture, "backend-go/bin/giv-backend.exe"), "fixture Go backend");
  writeFileSync(path.join(fixture, "frontend-react/dist/index.html"), "built React entry");
  writeFileSync(path.join(fixture, "frontend-react/dist/assets/i18n.js"), "built English catalog");
  const migrated = spawnSync(process.execPath, [path.join(repo, "scripts/pack_desktop_test.mjs"), "--pack-only"], {
    cwd: fixture, encoding: "utf8", env: {...process.env, USERPROFILE: profile, TMP: temp, TEMP: temp, TMPDIR: temp, CARGO_TARGET_DIR: cargo},
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  assert.equal(readFileSync(path.join(target, "viewer/giv-backend.exe"), "utf8"), "fixture Go backend");
  assert.equal(readFileSync(path.join(target, "viewer/static/index.html"), "utf8"), "built React entry");
  assert.equal(readFileSync(path.join(target, "viewer/static/assets/i18n.js"), "utf8"), "built English catalog");
  const buildManifest = JSON.parse(readFileSync(path.join(target, "viewer/build-manifest.json"), "utf8"));
  assert.equal(buildManifest.backend, "go");
  assert.ok(buildManifest.files["viewer/giv-backend.exe"]);
  assert.equal(buildManifest.files["viewer/server.py"], undefined);
  for (const [name, value] of Object.entries(retained)) assert.equal(readFileSync(path.join(target, name), "utf8"), value);
  console.log("ok  Go/React desktop delivery preserves profiles and ships the complete built runtime with hashes");
} finally {
  rmSync(fixture, {recursive: true, force: true});
}
