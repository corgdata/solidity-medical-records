# Validation — 21 October 2026

- Solidity 0.8.30 compilation passed with optimizer enabled (200 runs), Paris EVM.
- Deployed runtime bytecode: 3,732 bytes.
- `npm test`: 18 tests passed, 0 failed. Full captured output: `test-results.txt`.
- `npm run demo`: passed local deployment, AES-256-GCM synthetic-record round trip, ciphertext integrity verification, grant and revocation.
- Manual agent security review: see `SECURITY_REVIEW.md`; not an independent audit.
- Execution environment: Node.js 24.19.0, npm 11.9.0. Ganache used its JavaScript fallback because its optional native µWS binary did not match Node 24. This was a performance warning; compilation and tests completed successfully.

Tests exercise authorization, exact expiry, read/write separation, downgrade, owner isolation, immutable versions, optimistic concurrency, archive/restore and persistent revocation. No formal verification, fuzzing, real gateway integration, chain deployment, or healthcare compliance assessment was performed. No production or testnet transaction was sent.

# Addendum: 30 October 2026

Amended verification package, approved by the Principal on the recommendation of the Karpathy consultant seat (memo: consultant-output/karpathy-solidity-input-2026-10-30.md in the CORG operations records). Two parts: a Slither static analysis run with every finding read and dispositioned, and one seeded interleaved invariant sequence test. No contract code changed.

## Slither static analysis

- Tool: Slither 0.11.6, run locally against contracts/MedicalRecordsRegistry.sol compiled with solc 0.8.30 (the repository toolchain version), 102 detectors enabled.
- Command: `slither contracts/MedicalRecordsRegistry.sol --solc <solc-0.8.30 binary>`.
- Result: 2 findings, both from the timestamp detector, both Low impact and Medium confidence. Each was read against the contract source and dispositioned as a false positive:
  1. grantAccess (line 120), comparison `expiresAt <= block.timestamp`. This comparison is the input validation for the documented grant policy: a new grant must expire in the future. The timestamp is the specification of the policy, not an incidental input to it. Disposition: false positive, no change.
  2. _hasAccess (lines 184 to 185), comparison `block.timestamp < grant.expiresAt`. This comparison is the expiry mechanism itself: access ends when block time reaches expiresAt, the exclusive-expiry rule stated in the contract documentation and exercised exactly at the boundary by the test suite. Removing or altering it would remove expiring grants. Validator timestamp drift is seconds-scale; it can only marginally shorten or lengthen a window the patient already granted, and patient-side revocation and epoch invalidation remain immediate. Disposition: false positive, no change.
- With the timestamp detector excluded on the strength of these dispositions, the same run reports 0 results across the remaining 101 detectors and exits cleanly. That excluded-detector form is the configuration staged for CI (see below).

## Seeded invariant sequence test

- Added to test/registry.test.mjs: "seeded random operation sequences preserve access, expiry, archive, and version invariants".
- Method: a fixed-seed pseudorandom sequence (seed 20261030, printed with the step count in the test output) of 200 interleaved operations across two patients, four grantees, and one stranger: record creation (including duplicate attempts), appends with correct and incorrect expected versions, grants with future and past expiries, single revocations, global revocations, archive and restore toggles, foreign management attempts by non-patients, and time advances past grant expiries. Operations the model predicts must fail are asserted to revert; operations predicted to pass are executed.
- After every step, the test sweeps all records and asserts: canRead and canWrite agree with the modelled grant state, expiry, archive state, and patient epoch; stored grants match the model exactly; version counts match and never decrease; every stored version's locator commitment, ciphertext hash, and author are unchanged since it was written.
- This run: 200 steps, 16 records created, operation mix recorded in test-results.txt. All invariants held after every step.

## Suite totals and reproduction

- `npm test`: 19 tests passed, 0 failed (the 18 tests of 21 October 2026 plus the invariant sequence test). Full captured output: `test-results.txt`.
- Reproduction: `npm ci`, then `npm test`. The invariant test is the long pole (about 5 to 10 minutes in the local Ganache JavaScript fallback environment); its seed makes the sequence identical on every run.
- Execution environment: Node.js v24.22.1. The Ganache µWS fallback warning from the original validation note applies unchanged.

## CI status

- A Slither job matching this local run (Slither 0.11.6, solc 0.8.30, timestamp detector excluded per the dispositions above, every other detector enforced) has been prepared and staged locally with the operations fleet. It is not yet in the repository workflow file: the connector integration lacks the GitHub Workflows permission, so the workflow update lands through a separate browser pass. Until then, the Slither result above is a local run record, not a CI gate.
