// Canonical hash guard for solidity-medical-records.
//
// This repository is the canonical home of MedicalRecordsRegistry.sol.
// SHA256SUMS records the SHA-256 of every file in the frozen release
// set. This check fails if any recorded file differs from its recorded
// hash, so a change to the contract (or its test) can only land
// together with a deliberate SHA256SUMS update in the same commit.
// corgdata/corg-record-vault vendors the contract from here and runs
// the mirror-image check against this repository; see its VENDORED.md.
//
// Run on the committed tree, before install or tests, so the tree is
// exactly as committed. Stdlib only.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sumsPath = join(root, "SHA256SUMS");

let failures = 0;
for (const line of readFileSync(sumsPath, "utf8").split("\n")) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!match) continue;
  const [, expected, rel] = match;
  let actual;
  try {
    actual = createHash("sha256")
      .update(readFileSync(join(root, rel)))
      .digest("hex");
  } catch {
    console.error(`MISSING: ${rel} is recorded in SHA256SUMS but absent`);
    failures += 1;
    continue;
  }
  if (actual !== expected) {
    console.error(
      `HASH MISMATCH: ${rel}\n  recorded ${expected}\n  actual   ${actual}`
    );
    failures += 1;
  }
}

if (failures > 0) {
  console.error(
    `Canonical hash guard FAILED: ${failures} file(s) differ from ` +
      "SHA256SUMS. If this change is deliberate, update SHA256SUMS in " +
      "the same commit and re-vendor the contract in corg-record-vault."
  );
  process.exit(1);
}
console.log("Canonical hash guard PASS: all recorded files match SHA256SUMS.");
