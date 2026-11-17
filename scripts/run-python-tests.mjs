// Runs the Python fixture suites through whichever Python 3 this machine has,
// so `npm test` covers the gallery engine and not only the two shells.
//
// The suites create their own temp fixtures; nothing here touches a real
// gallery, a browser profile or a network share.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const candidates =
  process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

function probe(command, prefix) {
  const result = spawnSync(command, [...prefix, "-c", "import sys; print(sys.version_info[0])"], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0 && String(result.stdout).trim() === "3";
}

const python = candidates.find(([command, prefix]) => probe(command, prefix));
if (!python) {
  console.error("python tests: no working Python 3 found (tried py -3 / python / python3)");
  process.exit(1);
}

const [command, prefix] = python;
const args = [...prefix, "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"];
console.log(`python tests: ${command} ${args.join(" ")}`);
const run = spawnSync(command, args, { cwd: repo, stdio: "inherit" });
if (run.error) {
  console.error(`python tests: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status === null ? 1 : run.status);
