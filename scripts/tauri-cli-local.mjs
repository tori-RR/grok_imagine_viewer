import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  addOwnedPid,
  cleanupStaleStages,
  createOwnedStage,
  removeOwnedStage,
} from "./tauri-stage-local.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");
const modulesDir = path.join(repoDir, "node_modules");
const cliSource = path.join(modulesDir, "@tauri-apps", "cli");
const nativePackages = {
  "win32-arm64": "cli-win32-arm64-msvc",
  "win32-ia32": "cli-win32-ia32-msvc",
  "win32-x64": "cli-win32-x64-msvc",
};

if (!existsSync(path.join(cliSource, "tauri.js"))) {
  console.error("Tauri CLI is not installed. Run npm install first.");
  process.exit(1);
}

let stageOwner = null;
let cliScript = path.join(cliSource, "tauri.js");
const childEnv = { ...process.env };
const cargoBin = path.join(homedir(), ".cargo", "bin");
childEnv.CARGO_TARGET_DIR ??= path.join(tmpdir(), "grok-imagine-viewer-tauri-target");
if (existsSync(path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo"))) {
  childEnv.PATH = `${cargoBin}${path.delimiter}${childEnv.PATH ?? ""}`;
}

try {
  if (process.platform === "win32") {
    const nativeName = nativePackages[`${process.platform}-${process.arch}`];
    if (!nativeName) {
      throw new Error(`Unsupported Windows architecture: ${process.arch}`);
    }
    const nativeSource = path.join(modulesDir, "@tauri-apps", nativeName);
    if (!existsSync(nativeSource)) {
      throw new Error(`Tauri native package is missing: @tauri-apps/${nativeName}`);
    }

    cleanupStaleStages();
    stageOwner = createOwnedStage();
    const stageScope = path.join(stageOwner.path, "node_modules", "@tauri-apps");
    mkdirSync(stageScope, { recursive: true });
    cpSync(cliSource, path.join(stageScope, "cli"), { recursive: true });
    cpSync(nativeSource, path.join(stageScope, nativeName), { recursive: true });
    cliScript = path.join(stageScope, "cli", "tauri.js");
  }

  const child = spawn(process.execPath, [cliScript, ...process.argv.slice(2)], {
    cwd: repoDir,
    env: childEnv,
    stdio: "inherit",
  });
  const childResult = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (stageOwner && child.pid && !addOwnedPid(stageOwner, child.pid)) {
    child.kill();
    try {
      await childResult;
    } catch {
      // A failed spawn is already stopped; preserve the original marker error.
    }
    throw new Error("Could not record the staged Tauri CLI child process.");
  }
  process.exitCode = await childResult;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (stageOwner) {
    removeOwnedStage(stageOwner);
  }
}
