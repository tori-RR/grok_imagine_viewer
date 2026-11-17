/**
 * Build (optional) and replace the fixed Windows test folder on the user Desktop.
 * Cargo/Tauri output and the verified replacement stage stay in Windows temp.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoFromUrl = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = existsSync(path.join(process.cwd(), "src-tauri", "tauri.conf.json"))
  ? process.cwd()
  : repoFromUrl;
const skipBuild = process.argv.includes("--pack-only");
const tauriConfig = JSON.parse(readFileSync(path.join(repoDir, "src-tauri", "tauri.conf.json"), "utf8"));
const goBackend = Object.hasOwn(tauriConfig.bundle?.resources ?? {}, "../backend-go/bin/giv-backend.exe");
const portable = process.argv.includes("--portable");
const environmentPreview = process.argv.includes("--environment-preview");
if (goBackend && (portable || environmentPreview)) throw new Error("This branch uses the Go runtime. Use pack:desktop or pack:stack-evo instead of the legacy Python portable preview.");
if (environmentPreview && !portable) throw new Error("environment preview requires the portable runtime");
if (environmentPreview && skipBuild && process.env.GIV_PACK_FIXTURE !== "1") throw new Error("environment preview requires a fresh feature-gated build");
const programEntries = new Set(["grok-imagine-viewer-tauri.exe", "viewer"]);
if (portable) for (const name of ["webview2", "licenses", "README-portable.txt", "release-manifest.json", "install-video-tools.cmd"]) programEntries.add(name);
// These are user-owned WebView2 profiles created beside the portable EXE.
// Keep them across a fixed-folder replacement so an update does not log the
// user out of Grok or discard the local WebView cache. Other non-program
// entries beside the EXE are also user-owned and must survive replacement.
const portableRuntimeDirs = ["gallery-webview2", "grok-webview2", "EBWebView"];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function desktopDir() {
  const home = process.env.USERPROFILE || homedir();
  const candidates = [
    path.join(home, "Desktop"),
    path.join(home, "OneDrive", "Desktop"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

function walkFiles(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`refusing linked resource directory: ${root}`);
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`refusing linked resource: ${full}`);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function assertSafeTarget(target) {
  for (let current = target; ; current = path.dirname(current)) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing non-directory or linked target: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference='Stop'; $p=$env:GIV_PACK_TARGET;
      while ($p) {
        if (Test-Path -LiteralPath $p) {
          if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing reparse target' }
        }
        $p=[IO.Path]::GetDirectoryName($p);
      }
      Get-Process -Name 'grok-imagine-viewer-tauri' -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $_.Path -or $_.Path -eq (Join-Path $env:GIV_PACK_TARGET 'grok-imagine-viewer-tauri.exe')) { throw 'Close the running viewer normally before packaging' }
      }
      exit 0
    `], {encoding: "utf8", env: {...process.env, GIV_PACK_TARGET: target}});
    if (result.status !== 0) throw new Error(result.stderr || "could not verify target and closed application");
  }
}

const target = path.join(desktopDir(), environmentPreview ? "grok-imagine-viewer-environment-preview" : portable ? "grok-imagine-viewer-release" : "grok-imagine-viewer-0.3.0");
assertSafeTarget(target);
const runtimeRoot = path.join(repoDir, "runtime", "win64", "portable-managed");
let runtimeManifest;
if (portable) {
  walkFiles(runtimeRoot);
  runtimeManifest = JSON.parse(readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
  for (const marker of ["python/python.exe", "python/python314._pth"]) {
    if (!runtimeManifest.files?.[marker]) throw new Error(`missing portable runtime: ${marker}`);
  }
  for (const [name, expected] of Object.entries(runtimeManifest.files)) {
    const source = path.resolve(runtimeRoot, name);
    if (!source.startsWith(runtimeRoot + path.sep) || !/^[a-f0-9]{64}$/.test(expected) || lstatSync(source).isSymbolicLink() || sha256(source) !== expected) {
      throw new Error(`portable runtime hash/path mismatch: ${name}`);
    }
  }
}

function copyAndCheck(src, dest) {
  const info = lstatSync(src);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing non-regular resource: ${src}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  const a = sha256(src);
  const b = sha256(dest);
  if (a !== b) {
    throw new Error(`hash mismatch after copy: ${src}`);
  }
  return a;
}

if (!skipBuild) {
  if (goBackend) {
    const assets = spawnSync(process.execPath, [path.join(repoDir, "scripts/stack-evo-assets.mjs")], { cwd: repoDir, env: process.env, stdio: "inherit" });
    if (assets.error || assets.status !== 0) throw assets.error || new Error("Go/React asset build failed");
  }
  const build = spawnSync(
    process.execPath,
    [path.join(repoDir, "scripts/tauri-cli-local.mjs"), "build", ...(environmentPreview ? ["--features", "environment-preview", "--config", "src-tauri/tauri.environment-preview.conf.json"] : [])],
    { cwd: repoDir, env: process.env, stdio: "inherit" },
  );
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
    process.exit();
  }
}

function findReleaseExe() {
  const names = [];
  if (process.env.CARGO_TARGET_DIR) {
    names.push(path.join(process.env.CARGO_TARGET_DIR, "release", "grok-imagine-viewer-tauri.exe"));
  }
  names.push(path.join(tmpdir(), "grok-imagine-viewer-tauri-target", "release", "grok-imagine-viewer-tauri.exe"));
  const found = names.filter((file) => existsSync(file));
  if (!found.length) {
    throw new Error(`missing release exe; looked in:\n${names.join("\n")}`);
  }
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const exe = findReleaseExe();
const exeStat = statSync(exe);
if (exeStat.size < 1_000_000) {
  throw new Error(`release exe looks too small: ${exeStat.size} bytes`);
}

const sha = git(["rev-parse", "--short", "HEAD"]);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const stage = mkdtempSync(path.join(tmpdir(), `giv-desktop-${sha}-${stamp}-`));

const hashes = {
  "grok-imagine-viewer-tauri.exe": copyAndCheck(exe, path.join(stage, "grok-imagine-viewer-tauri.exe")),
};
if (goBackend) {
  hashes["viewer/giv-backend.exe"] = copyAndCheck(path.join(repoDir, "backend-go/bin/giv-backend.exe"), path.join(stage, "viewer/giv-backend.exe"));
} else {
  for (const name of ["server.py", "viewer_preferences.py", "cover_acceleration.py"]) {
    hashes[`viewer/${name}`] = copyAndCheck(path.join(repoDir, name), path.join(stage, "viewer", name));
  }
}
hashes["viewer/install-environment.ps1"] = copyAndCheck(
  path.join(repoDir, "scripts", "install-environment.ps1"),
  path.join(stage, "viewer", "install-environment.ps1"),
);
if (existsSync(path.join(repoDir, "grok_imagine_viewer.ico"))) {
  hashes["viewer/grok_imagine_viewer.ico"] = copyAndCheck(
    path.join(repoDir, "grok_imagine_viewer.ico"),
    path.join(stage, "viewer", "grok_imagine_viewer.ico"),
  );
}
const staticDir = path.join(repoDir, goBackend ? "frontend-react/dist" : "static");
for (const file of walkFiles(staticDir)) {
  const rel = path.relative(staticDir, file).split(path.sep).join("/");
  hashes[`viewer/static/${rel}`] = copyAndCheck(file, path.join(stage, "viewer", "static", ...rel.split("/")));
}
if (goBackend) {
  writeFileSync(path.join(stage, "viewer", "build-manifest.json"), JSON.stringify({
    schema: 1, commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString(), backend: "go", databaseSchema: 3,
    nativeSmokeProtocol: readFileSync(exe).includes(Buffer.from("grok-imagine-viewer-native-smoke")) ? 1 : 0,
    sourceChanges: git(["diff", "HEAD", "--name-only"]).split(/\r?\n/).filter(Boolean), files: { ...hashes },
  }, null, 2) + "\n");
  hashes["viewer/build-manifest.json"] = sha256(path.join(stage, "viewer", "build-manifest.json"));
}
if (environmentPreview) {
  const previewName = "viewer/static/environment-preview.js";
  hashes[previewName] = copyAndCheck(path.join(repoDir, "tests/fixtures/environment-preview.js"), path.join(stage, ...previewName.split("/")));
  const index = path.join(stage, "viewer/static/index.html");
  const html = readFileSync(index, "utf8");
  const marker = '<script src="/static/app.js"></script>';
  if (!html.includes(marker)) throw new Error("preview script insertion point is unavailable");
  writeFileSync(index, html.replace(marker, '<script src="/static/environment-preview.js"></script>\n  ' + marker));
  hashes["viewer/static/index.html"] = sha256(index);
}

if (portable) {
  for (const [name, expected] of Object.entries(runtimeManifest.files)) {
    const destination = name.startsWith("python/")
      ? `viewer/runtime/win64/${name.slice(name.indexOf("/") + 1)}` : name;
    if (Object.hasOwn(hashes, destination)) throw new Error(`duplicate portable resource: ${destination}`);
    const actual = copyAndCheck(path.join(runtimeRoot, ...name.split("/")), path.join(stage, ...destination.split("/")));
    if (actual !== expected) throw new Error(`portable runtime changed while staging: ${name}`);
    hashes[destination] = actual;
  }
  const readme = environmentPreview ?
    "Grok Imagine Viewer - Environment Preview\r\n\r\n双击 grok-imagine-viewer-tauri.exe。此版本模拟 FFmpeg 和 WebView2 缺失，安装按钮只演示状态变化，不执行 PowerShell 或 winget；重启后重置。\r\n使用独立应用配置和 WebView 目录；保留整个文件夹。需要本机已有 WebView2 才能显示预览，不会卸载或安装组件。\r\nThis is a simulation. Installation buttons do not change system components. Restart to reset.\r\n" :
    "Grok Imagine Viewer - Windows x64 portable test build\r\n\r\n" +
    "双击 grok-imagine-viewer-tauri.exe。请保留整个文件夹；已内置 Python，使用系统 WebView2 和 FFmpeg / ffprobe。\r\n" +
    "Double-click grok-imagine-viewer-tauri.exe. Keep the complete folder together.\r\n" +
    "本地图库可离线浏览；Grok 页面和下载需要联网及登录。此包不包含图库或登录资料。\r\n" +
    "应用设置仍保存在 Windows 用户配置目录；WebView 资料由应用首次运行时在 EXE 旁创建。\r\n" +
    "启动时检查环境。缺少 FFmpeg / ffprobe 时，欢迎页显示缺失环境与一键安装；缺少 WebView2 时先显示原生安装提示。\r\n" +
    "安装会打开 PowerShell 执行 viewer/install-environment.ps1，通过 winget 联网安装到系统，可能需要确认协议或系统权限。不自动安装组件。\r\n" +
    "Missing components can be installed on request through PowerShell and WinGet. Python is bundled; FFmpeg and WebView2 are not.\r\n" +
    "没有 winget 时，请先从 Microsoft Store 安装或更新“应用安装程序”。安装失败可查看 PowerShell 提示，再重新检测。\r\n" +
    "本包未在干净 Windows 10/11 虚拟机验收。\r\n" +
    "版本与所有程序文件的 SHA-256 见 release-manifest.json；第三方许可见 licenses。\r\n";
  writeFileSync(path.join(stage, "README-portable.txt"), "\uFEFF" + readme);
  hashes["README-portable.txt"] = sha256(path.join(stage, "README-portable.txt"));
  writeFileSync(path.join(stage, "release-manifest.json"), JSON.stringify({
    schema: 1, commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString(),
    sourceChanges: git(["diff", "--name-only"]).split(/\r?\n/).filter(Boolean),
    architecture: "x64", environmentPreview, runtimes: runtimeManifest.sources, files: {...hashes},
  }, null, 2) + "\n");
  hashes["release-manifest.json"] = sha256(path.join(stage, "release-manifest.json"));
}
assertSafeTarget(target);
const backup = path.join(tmpdir(), `giv-desktop-backup-${sha}-${stamp}`);
if (existsSync(backup)) {
  throw new Error(`replacement backup already exists: ${backup}`);
}

let previousMoved = false;
const entriesToPreserve = new Set(portableRuntimeDirs);
if (existsSync(target)) {
  const targetStat = lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-directory or linked target: ${target}`);
  }
  for (const entry of readdirSync(target)) {
    if (!programEntries.has(entry)) entriesToPreserve.add(entry);
  }
  renameSync(target, backup);
  previousMoved = true;
}

const preservedEntries = [];
try {
  renameSync(stage, target);
  for (const [name, expected] of Object.entries(hashes)) {
    const actual = sha256(path.join(target, ...name.split("/")));
    if (actual !== expected) throw new Error(`hash mismatch after replacement: ${name}`);
  }
  if (previousMoved) {
    for (const name of entriesToPreserve) {
      const source = path.join(backup, name);
      const destination = path.join(target, name);
      if (!existsSync(source)) continue;
      if (existsSync(destination)) {
        throw new Error(`user entry unexpectedly exists in replacement stage: ${destination}`);
      }
      renameSync(source, destination);
      preservedEntries.push(name);
    }
  }
} catch (error) {
  for (const name of preservedEntries.reverse()) {
    const source = path.join(target, name);
    const destination = path.join(backup, name);
    if (existsSync(source) && !existsSync(destination)) renameSync(source, destination);
  }
  if (existsSync(target) && !existsSync(stage)) renameSync(target, stage);
  if (previousMoved && existsSync(backup) && !existsSync(target)) renameSync(backup, target);
  throw error;
}

if (previousMoved) rmSync(backup, { recursive: true, force: true });

console.log(`folder: ${target}`);
console.log(`commit: ${sha}`);
for (const [name, hash] of Object.entries(hashes)) {
  console.log(`file    ${hash}  ${name}`);
}
