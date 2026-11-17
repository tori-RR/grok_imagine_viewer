// New-output-only portable delivery; never replace user profiles or a desktop install.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  throw new Error("Windows/MSVC is required to produce the desktop package.");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`build failed: ${result.status}`);
  }
}

const artifactsDir = path.join(root, "artifacts");
const output = path.join(artifactsDir, "stack-evo-portable");
if (existsSync(output)) {
  throw new Error("Output already exists; refusing to overwrite it.");
}

const target =
  process.env.CARGO_TARGET_DIR ||
  path.join(tmpdir(), "grok-imagine-viewer-tauri-target");

// Build frontend and Go sidecar explicitly in this Node process. Tauri build hooks
// run under a child shell whose PATH is not guaranteed to retain Node on Windows.
run(process.execPath, ["scripts/stack-evo-assets.mjs"]);
run(
  process.execPath,
  ["scripts/tauri-cli-local.mjs", "build", "--no-bundle"],
  { ...process.env, CARGO_TARGET_DIR: target },
);

const sha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
if (sha.status !== 0) throw new Error("Source commit unavailable.");

const desktopExe = path.join(target, "release", "grok-imagine-viewer-tauri.exe");
if (!existsSync(desktopExe)) {
  throw new Error(`Tauri Release executable not found at expected path: ${desktopExe}`);
}

mkdirSync(artifactsDir, { recursive: true });
const staging = mkdtempSync(path.join(artifactsDir, ".stack-evo-portable-"));
const hashes = {};

function copy(source, relative) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Refusing linked program resource.");
  if (stat.isDirectory()) {
    for (const name of readdirSync(source)) {
      copy(path.join(source, name), path.join(relative, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Not a regular program resource.");

  const destination = path.join(staging, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const digest = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  if (digest(source) !== digest(destination)) {
    throw new Error("Package verification failed.");
  }
  hashes[relative.replaceAll("\\", "/")] = digest(destination);
}

try {
  copy(desktopExe, "grok-imagine-viewer-tauri.exe");
  copy(
    path.join(root, "backend-go", "bin", "giv-backend.exe"),
    "viewer/giv-backend.exe",
  );
  copy(path.join(root, "frontend-react", "dist"), "viewer/static");
  copy(
    path.join(root, "scripts", "install-environment.ps1"),
    "viewer/install-environment.ps1",
  );
  copy(
    path.join(root, "grok_imagine_viewer.ico"),
    "viewer/grok_imagine_viewer.ico",
  );

  writeFileSync(
    path.join(staging, "release-manifest.json"),
    JSON.stringify(
      {
        schema: 1,
        commit: sha.stdout.trim(),
        architecture: "windows-x64",
        backend: "go",
        nativeSmokeProtocol: readFileSync(desktopExe).includes(Buffer.from("grok-imagine-viewer-native-smoke")) ? 1 : 0,
        database: "sqlite",
        packageId: randomUUID(),
        files: hashes,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    path.join(staging, "README.txt"),
    "Keep this entire folder together. Run grok-imagine-viewer-tauri.exe.\r\n" +
      "Requires Windows WebView2; FFmpeg/ffprobe are optional for video covers. No Python runtime is required.\r\n" +
      "No user library or login profile is included. Test with a library copy first.\r\n",
  );

  if (existsSync(output)) {
    throw new Error("Output appeared during packaging; refusing to overwrite it.");
  }
  renameSync(staging, output);
  console.log(`Verified portable output: ${output}`);
} finally {
  // Only this invocation's uniquely-created staging directory is removed.
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
}
