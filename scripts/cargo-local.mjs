import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const userCargo = path.join(homedir(), ".cargo", "bin", cargoName);
const cargo = existsSync(userCargo) ? userCargo : cargoName;
const childEnv = { ...process.env };
childEnv.CARGO_TARGET_DIR ??= path.join(tmpdir(), "grok-imagine-viewer-tauri-target");
const result = spawnSync(cargo, process.argv.slice(2), {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
});
if (result.error) {
  console.error("Cargo is unavailable. Install the Rust MSVC toolchain first.");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
