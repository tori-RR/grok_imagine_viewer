import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export const STAGE_PREFIX = "grok-imagine-tauri-cli-";
const OWNER_FILE = ".owner.json";
const OWNER_VERSION = 1;

function directStagePath(tempRoot, stagePath) {
  const root = path.resolve(tempRoot);
  const resolved = path.resolve(stagePath);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(STAGE_PREFIX)) {
    return null;
  }
  try {
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readOwner(tempRoot, stagePath) {
  const resolved = directStagePath(tempRoot, stagePath);
  if (!resolved) return null;
  try {
    const owner = JSON.parse(readFileSync(path.join(resolved, OWNER_FILE), "utf8"));
    if (
      owner.version !== OWNER_VERSION ||
      owner.directory !== path.basename(resolved) ||
      typeof owner.token !== "string" ||
      owner.token.length < 16 ||
      !Array.isArray(owner.pids) ||
      owner.pids.length === 0 ||
      !owner.pids.every(validPid)
    ) {
      return null;
    }
    return {
      path: resolved,
      directory: owner.directory,
      token: owner.token,
      pids: [...new Set(owner.pids)],
      createdAt: owner.createdAt,
    };
  } catch {
    return null;
  }
}

function writeOwner(owner) {
  writeFileSync(
    path.join(owner.path, OWNER_FILE),
    `${JSON.stringify({
      version: OWNER_VERSION,
      directory: owner.directory,
      token: owner.token,
      pids: owner.pids,
      createdAt: owner.createdAt,
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

export function cleanupStaleStages(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || tmpdir());
  const isAlive = options.isAlive || processIsAlive;
  let entries = [];
  try {
    entries = readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue;
    const stagePath = path.join(tempRoot, entry.name);
    const owner = readOwner(tempRoot, stagePath);
    // An absent or malformed marker is not proof that a stage is inactive.
    if (!owner) continue;

    let anyAlive = true;
    try {
      anyAlive = owner.pids.some((pid) => isAlive(pid));
    } catch {
      anyAlive = true;
    }
    if (anyAlive) continue;

    // Re-read after the PID check so a stage that was replaced or reclaimed
    // while scanning is preserved instead of being deleted by a stale view.
    const current = readOwner(tempRoot, stagePath);
    if (!current || current.token !== owner.token) continue;
    try {
      rmSync(current.path, { recursive: true, force: true });
      removed.push(current.path);
    } catch {
      // Cleanup is best effort. A locked or permission-denied stage is safer
      // to leave for a later launch than to broaden the deletion rules.
    }
  }
  return removed;
}

export function createOwnedStage(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || tmpdir());
  const ownerPid = options.pid || process.pid;
  if (!validPid(ownerPid)) throw new Error("Invalid stage owner PID");
  const stagePath = mkdtempSync(path.join(tempRoot, STAGE_PREFIX));
  const owner = {
    path: stagePath,
    directory: path.basename(stagePath),
    token: randomUUID(),
    pids: [ownerPid],
    createdAt: new Date().toISOString(),
  };
  try {
    writeOwner(owner);
    return owner;
  } catch (error) {
    rmSync(stagePath, { recursive: true, force: true });
    throw error;
  }
}

export function addOwnedPid(owner, pid) {
  if (!owner || !validPid(pid)) return false;
  const current = readOwner(path.dirname(owner.path), owner.path);
  if (!current || current.token !== owner.token) return false;
  const pids = [...new Set([...current.pids, pid])];
  writeOwner({ ...current, pids });
  owner.pids = pids;
  return true;
}

export function removeOwnedStage(owner) {
  if (!owner || typeof owner.path !== "string") return false;
  const tempRoot = path.dirname(path.resolve(owner.path));
  const current = readOwner(tempRoot, owner.path);
  if (!current || current.token !== owner.token) return false;
  rmSync(current.path, { recursive: true, force: true });
  return true;
}
