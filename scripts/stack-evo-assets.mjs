import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm.cmd" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], path.join(root, "frontend-react"));
mkdirSync(path.join(root, "backend-go/bin"), { recursive: true });
run("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", process.platform === "win32" ? "bin/giv-backend.exe" : "bin/giv-backend", "."], path.join(root, "backend-go"));
