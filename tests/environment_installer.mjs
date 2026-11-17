import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
if (process.platform === "win32") {
  const script = fileURLToPath(new URL("../scripts/install-environment.ps1", import.meta.url));
  const run = component => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Component", component, "-WhatIf"], {encoding: "utf8", timeout: 10000});
  for (const [component, command] of [["ffmpeg", "winget install -e --id Gyan.FFmpeg"], ["webview2", "winget install -e --id Microsoft.EdgeWebView2Runtime --silent --accept-package-agreements --accept-source-agreements"]]) {
    const result = run(component);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(command), result.stdout);
  }
  assert.notEqual(run("ffmpeg; calc").status, 0, "only the two fixed components are allowed");
  console.log("ok  real PowerShell WhatIf validates both fixed WinGet commands without executing an install");
}
