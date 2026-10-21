# Validation — 21 October 2026

- Solidity 0.8.30 compilation passed with optimizer enabled (200 runs), Paris EVM.
- Deployed runtime bytecode: 3,732 bytes.
- `npm test`: 18 tests passed, 0 failed. Full captured output: `test-results.txt`.
- `npm run demo`: passed local deployment, AES-256-GCM synthetic-record round trip, ciphertext integrity verification, grant and revocation.
- Manual agent security review: see `SECURITY_REVIEW.md`; not an independent audit.
- Execution environment: Node.js 24.19.0, npm 11.9.0. Ganache used its JavaScript fallback because its optional native µWS binary did not match Node 24. This was a performance warning; compilation and tests completed successfully.

Tests exercise authorization, exact expiry, read/write separation, downgrade, owner isolation, immutable versions, optimistic concurrency, archive/restore and persistent revocation. No formal verification, fuzzing, real gateway integration, chain deployment, or healthcare compliance assessment was performed. No production or testnet transaction was sent.
