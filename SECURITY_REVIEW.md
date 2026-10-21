# Security review and integration boundaries

This is a development review, not an independent audit, certification, or determination of regulatory compliance. The contract is an authorization and integrity-reference registry, not a medical-record storage system. Review date: 2026-10-21.

## Threat model

Attackers may submit arbitrary transactions, inspect every storage slot and historical event, copy transaction inputs, operate unauthorized wallets, hold previously authorized credentials, or control an authorized provider wallet. The registry cannot determine whether a wallet belongs to a licensed clinician, whether a patient is legally competent to consent, or whether an uploaded record is clinically accurate.

The off-chain application, storage service, identity system, encryption implementation, key-management service, RPC endpoint, and patient signing device are separate security boundaries. Compromise of these components can expose records even if the contract behaves correctly.

## Mandatory off-chain behavior

1. Encrypt documents before storage using authenticated encryption and securely generated keys/nonces. Commit to ciphertext, never directly to predictable diagnoses, identifiers, or plaintext documents. Keep locators random and opaque; do not encode names, account numbers, URLs, or medical codes in record salts or commitments.
2. Authenticate the requester's wallet using a domain-bound, nonce-protected, expiring challenge. A `canRead(recordId, address)` result is not proof that the caller controls that address. Support contract-wallet signature validation when contract wallets are allowed.
3. Verify chain ID, deployed contract address, and sufficiently confirmed state before releasing data or key material. Re-evaluate authorization on each request; invalidate cached authorization after revocation, expiry, and archival. Fail closed on unavailable or inconsistent authorization state. There is an unavoidable ordering/race boundary between the chain check and actual off-chain delivery.
4. Treat every version as untrusted input. Verify ciphertext bytes against the selected on-chain ciphertext hash, validate document format after decryption, and display author/version provenance. Use the version-specific locator commitment to verify the off-chain locator association under the documented application convention.
5. Keep an authenticated off-chain access log. View calls produce no events, and a contract cannot observe someone reading a public storage slot or downloading data outside the gateway.
6. Keep backups and a key-recovery policy. An immutable deployment has no administrator capable of recovering a lost patient wallet. Recovery-capable smart wallets require their own security assessment.

## Contract source review

Reviewed `contracts/MedicalRecordsRegistry.sol`, pinned to Solidity 0.8.30. No privilege-escalation or historical-version mutation defect was identified in this manual review. This is a bounded observation, not a guarantee of absence of vulnerabilities. Executed test results are reported separately by the build/test workflow.

| Area | Observed behavior |
| --- | --- |
| Patient authorization | Record creation binds ownership to `msg.sender`; grant, individual revoke, and archive controls check the stored patient. No `tx.origin` authentication. |
| Record squatting | ID hashes both patient address and salt; copying another patient's creation inputs cannot create that patient's ID from another caller. |
| Effective permission | Unknown record, zero account, and archived record return false. Patient access is intrinsic only for active records; delegates require the requested bit, unexpired timestamp, and current patient epoch. |
| Delegation | Read and write bits are independent. Delegates can append only; they cannot alter grants or ownership. Updating a grant replaces its complete permission set. |
| Expiry | The deadline is exclusive: equality with the block timestamp denies access. New grants must expire in the future. |
| Revocation | Individual revocation deletes the grant. Patient-wide revocation increments an epoch without iterating records. Default empty grants have zero permissions and therefore cannot accidentally authorize. |
| Archive/restore | Archive suspends all effective read/write permissions, including the patient's. It retains grants; restore reactivates grants still valid by expiry and epoch. To prevent that behavior, revoke individual grants or call `revokeAllAccess()` before restoring. |
| Append integrity | Authorized callers must supply the current version number. A successful append increments the version and cannot select an older slot. Conflicting stale submissions revert. Prior versions remain immutable. |
| External interactions | No external calls, callbacks, token transfers, upgrade hooks, or funds-handling paths are present. Reentrancy through the contract is therefore not an applicable mutation path. |
| Resource bounds | Mutations perform constant-sized storage operations with no unbounded loops. Solidity checked arithmetic prevents version/epoch wraparound. |

The retained-grant restore behavior was reviewed explicitly and is documented in the contract. It is a product policy that the application must expose clearly, not a permanent revocation operation.

## Residual limitations

- Addresses, grants, transaction timing, authorship, record linkage, hashes, and commitments are public and permanent. Even opaque values can expose sensitive relationship metadata. A permissioned deployment can reduce exposure but does not itself provide encryption or legal compliance.
- Revocation stops future gateway authorization only. It cannot erase prior downloads, retract plaintext, or revoke a key already disclosed. Key rotation and ciphertext re-encryption require an off-chain process; historical chain entries remain visible.
- Grants are record-wide, not version-specific. An effective read grant authorizes the application's access policy for the record, including its history unless the gateway imposes additional restrictions. An effective write grant permits append operations, not permission management.
- Append-only history records submitted assertions, not truth. A malicious authorized writer can publish incorrect hashes or unavailable content; a patient can also authorize malicious writers. No storage availability or clinical authenticity is established by a hash alone.
- Expiry follows block timestamps. It is not a clinical clock or an exact real-world service deadline. Network finality and chain reorganizations must be handled by the application.
- No emergency override, guardian delegation, organizational credential registry, retention enforcement, erasure mechanism, or healthcare interoperability layer is included.

## Deployment gate

Use synthetic records on a local chain or testnet first. Before real data: independent contract and integration security review, a tested identity/key-management design, operational recovery procedures, a privacy threat assessment for public metadata, and a jurisdiction-specific compliance assessment. Do not interpret passing unit tests as evidence that the entire medical-record system is secure.
