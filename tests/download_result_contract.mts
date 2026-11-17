import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeDownloadResult } from "../frontend-react/src/lib/download-result.ts";
const cases = JSON.parse(readFileSync(new URL("./fixtures/download-result-v1.json", import.meta.url), "utf8"));
for (const entry of cases) {
  if (entry.valid) assert.deepEqual(decodeDownloadResult(entry.result), entry.result, entry.name);
  else assert.throws(() => decodeDownloadResult(entry.result), entry.name);
}
console.log(`ok  ${cases.length} shared Go/Rust/TypeScript download result contracts`);
