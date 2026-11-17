import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  STAGE_PREFIX,
  addOwnedPid,
  cleanupStaleStages,
  createOwnedStage,
  removeOwnedStage,
} from "./tauri-stage-local.mjs";

const testRoot = mkdtempSync(path.join(tmpdir(), "grok-tauri-stage-smoke-"));

try {
  const deadOwner = createOwnedStage({ tempRoot: testRoot, pid: 10101 });
  const liveOwner = createOwnedStage({ tempRoot: testRoot, pid: 20202 });
  const extendedOwner = createOwnedStage({ tempRoot: testRoot, pid: 30303 });
  assert.ok(addOwnedPid(extendedOwner, 40404));

  const unmarked = path.join(testRoot, `${STAGE_PREFIX}unmarked`);
  mkdirSync(unmarked);
  const malformed = path.join(testRoot, `${STAGE_PREFIX}malformed`);
  mkdirSync(malformed);
  writeFileSync(path.join(malformed, ".owner.json"), "{not-json}\n", "utf8");

  const removed = cleanupStaleStages({
    tempRoot: testRoot,
    isAlive: (pid) => pid === 20202 || pid === 40404,
  });

  assert.deepEqual(removed, [deadOwner.path]);
  assert.ok(!existsSync(deadOwner.path));
  assert.ok(existsSync(liveOwner.path));
  assert.ok(existsSync(extendedOwner.path));
  assert.ok(existsSync(unmarked));
  assert.ok(existsSync(malformed));

  assert.equal(removeOwnedStage({ ...extendedOwner, token: "wrong-token-value" }), false);
  assert.ok(existsSync(extendedOwner.path));
  assert.equal(removeOwnedStage(extendedOwner), true);
  assert.equal(removeOwnedStage(liveOwner), true);

  console.log("tauri stage cleanup smoke ok");
} finally {
  const resolvedRoot = path.resolve(testRoot);
  const resolvedTemp = path.resolve(tmpdir()) + path.sep;
  if (resolvedRoot.startsWith(resolvedTemp)) {
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
}
