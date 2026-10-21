# Executable Consent and Audit for Medical Records: A Solidity Methods Description

**Pavel Zagadailov, MD**
Clinical Outcomes Research Group (CORG)
pzagadailov@corgdata.com

**Version:** 1.0 — Methods draft, 2026-10-06
**License:** CC BY 4.0
**Status:** Preprint draft. No empirical results are reported; all deployment figures are illustrative unless measured and stated.

---

## Abstract

Medical records concentrate some of the most sensitive personal data in existence, yet the mechanisms that govern who may access them — consent, purpose limitation, audit — remain largely procedural: policy documents, institutional promises, and after-the-fact forensics. This paper describes a methods framework for moving three governance functions onto executable infrastructure using Solidity smart contracts on Ethereum-compatible networks: (1) a **consent registry** in which patients grant, scope, and revoke access programmatically; (2) an **access audit log** that records every disclosure as an immutable, timestamped event; and (3) a **record anchor** that commits cryptographic hashes of off-chain records on-chain, so any tampering with the off-chain store is detectable. Protected health information never touches the chain. We specify the contract interfaces, the on-chain/off-chain data architecture, a worked clinical scenario (multi-party embryo disposition consent in assisted reproduction), the threat model, and the known limitations — including key management, the tension between immutability and erasure rights, and gas costs. The framework is presented as a complement to institutional governance, not a replacement for it, and as an executable companion to the governance-and-ethics framework for computational reproductive modeling previously described by the author.

**Keywords:** Solidity, smart contracts, medical records, consent management, audit trail, HIPAA, assisted reproduction, governance

---

## 1. Introduction

Three operations underpin trustworthy handling of medical records: establishing **who consented to what**, restricting use to the **consented purpose**, and producing an **auditable trail** of every access. In current practice all three are implemented procedurally. Consent lives in signed PDFs filed in an EHR; purpose limitation lives in institutional policy; audit lives in database logs controlled by the same institution being audited. This arrangement asks patients and regulators to trust the custodian's internal controls — the party with the most to lose from their failure.

Distributed ledger technology does not solve the underlying social problem, but it changes the enforcement geometry: rules written as smart contracts execute deterministically, and their execution history is visible to parties who do not trust each other. The claim of this paper is modest and specific — that **consent, audit, and integrity attestation** for medical records can be factored out of institutional databases and expressed as a small set of Solidity contracts, with the records themselves remaining off-chain under conventional protections. We describe the method in enough detail for an independent team to implement and evaluate it.

### 1.1 What this paper is and is not

This is a **methods description**, not an empirical study. It specifies interfaces, data flows, and a reference implementation. It reports no deployment measurements, no clinical trial, and no production deployment. Where quantitative claims appear (e.g., gas costs), they are labeled as estimates pending measurement. The threat model in Section 6 is part of the method: a consent/audit system whose failure modes are not enumerated is not a method but a pitch.

---

## 2. Background

### 2.1 Solidity and the EVM in one paragraph

Solidity is the dominant high-level language for smart contracts on Ethereum and Ethereum-compatible (EVM) networks. A contract is a program deployed at an address; its functions are invoked by transactions; its state transitions are validated by network consensus and recorded immutably. Execution costs "gas," priced in the network's native token, which bounds computation and storage — a design constraint that shapes everything below. For medical use we assume a permissioned or low-fee EVM network (e.g., a consortium chain), not Ethereum mainnet, though the contracts are network-agnostic.

### 2.2 The on-chain/off-chain split (the only architecture that survives contact with HIPAA)

A foundational design rule: **no protected health information (PHI) goes on-chain.** Blockchains are append-only and widely replicated; data placed on-chain cannot be deleted and is visible to all node operators. This is incompatible with both HIPAA's minimum-necessary standard and GDPR's right to erasure. The architecture used here is therefore:

- **Off-chain:** encrypted records in conventional storage (EHR database, IPFS with client-side encryption, institutional vault). Access control enforced by existing systems.
- **On-chain:** (a) consent directives (who may access what, for which purpose, until when); (b) hashes of records or record versions (integrity anchors); (c) an append-only log of access events.

The chain stores *governance metadata*, never *content*. A hash on-chain proves a record existed in a given state at a given time without revealing it.

### 2.3 Related approaches

Patient-mediated record sharing (e.g., MedRec-style provider networks), consent-management prototypes on Hyperledger Fabric, and self-sovereign identity (DID/VC) wallets all address adjacent problems. What distinguishes the present method is its narrowness: three contracts, one responsibility each, specified to the level of function signatures, with an explicit non-goal — it does not attempt identity provisioning, record storage, or clinical semantics, and it composes with systems that do.

---

## 3. Method: Architecture

### 3.1 Components

```
┌──────────────┐      ┌──────────────────┐      ┌────────────────┐
│  Patient /   │      │  Off-chain store  │      │  EVM network   │
│  Provider    │─────▶│  (EHR / IPFS /    │      │                │
│  application │      │   vault, encrypted│      │  ┌──────────┐  │
└──────────────┘      └──────────────────┘      │  │ Consent  │  │
       │                       │                │  │ Registry │  │
       │  1. grant/revoke      │  2. store      │  └──────────┘  │
       │     consent ──────────┼───────────────▶│  ┌──────────┐  │
       │                       │                │  │  Access  │  │
       │  3. request access    │  4. disclose   │  │  Audit   │  │
       │     (checks consent)  │     (logs event│  └──────────� "┘
       │                       │      on-chain) │  ┌──────────┐  │
       └───────────────────────┴───────────────▶│  │  Record  │  │
                                               │  │  Anchor  │  │
                                               │  └──────────┘  │
                                               └────────────────┘
```

**Flow.** (1) The patient (or legal proxy) issues a consent directive to the ConsentRegistry: grantee address, record identifier (a hash, not the record), permitted purpose code, expiry. (2) The record itself is stored off-chain, encrypted. (3) When a provider requests access, the off-chain access service queries the ConsentRegistry: is there a live, unrevoked, purpose-matching grant? (4) On disclosure, the service appends an event to the AccessAudit log and the RecordAnchor holds the hash of the disclosed version.

### 3.2 Identity and key assumptions

The method assumes each actor controls an EVM keypair and that a real-world identity-verification step (clinic registration, KYC, institutional onboarding) binds keypairs to persons *off-chain*. On-chain, actors are addresses; the binding registry is deliberately out of scope — it is the one component that must remain institutional, because key recovery for patients who lose keys has no satisfactory decentralized answer (see Section 6.4).

### 3.3 Purpose codes and record identifiers

- `recordId`: `keccak256` of (patient pseudonym ‖ record type ‖ version nonce). Unlinkable without the preimage; stable for anchoring.
- `purpose`: a `bytes32` code from a controlled vocabulary (e.g., `TREATMENT`, `RESEARCH_DEIDENTIFIED`, `BILLING`, `EMBRYO_DISPOSITION`). Purpose limitation is enforced by requiring the disclosed purpose to match a live grant.
- `expiry`: Unix timestamp after which the grant is void. Revocation is immediate and recorded as an event.

---

## 4. Method: Contract specifications

Reference implementations are provided in `contracts/`. What follows is the normative interface description; the `.sol` files are the executable counterpart. Target: Solidity `^0.8.20`.

### 4.1 ConsentRegistry.sol — programmable consent

**Responsibility:** the single source of truth for "who may access what, for which purpose, until when."

```solidity
struct Grant {
    address grantor;      // patient (or legal proxy)
    address grantee;      // provider / researcher / institution
    bytes32 recordId;     // hash identifier, never PHI
    bytes32 purpose;      // controlled vocabulary code
    uint64 expiry;        // unix time; 0 = no expiry
    bool revoked;         // revocation flag
}

function grant(address grantee, bytes32 recordId, bytes32 purpose, uint64 expiry) external returns (uint256 grantId);
function revoke(uint256 grantId) external;                       // grantor (or proxy) only
function isValid(uint256 grantId, bytes32 purpose) external view returns (bool);
function grantsFor(bytes32 recordId) external view returns (uint256[] memory);
event Granted(uint256 indexed grantId, address indexed grantor, address indexed grantee, bytes32 recordId, bytes32 purpose, uint64 expiry);
event Revoked(uint256 indexed grantId, uint256 timestamp);
```

**Semantics.** `grant` creates a directive; only the grantor's address (or a registered proxy, e.g., a guardianship contract) may call it. `revoke` flips the flag and emits `Revoked` — revocation is itself an audited event. `isValid` returns true iff the grant exists, is not revoked, has not expired, and the purpose matches. The off-chain access service MUST call `isValid` (via `eth_call`, no transaction needed) before every disclosure.

**Design note — why revocation is a flag, not deletion.** Deleting the grant would destroy the evidence that consent once existed and was withdrawn — precisely the history a dispute needs. Append-only revocation preserves the full consent lifecycle.

### 4.2 AccessAudit.sol — the immutable disclosure log

**Responsibility:** every disclosure of a record is recorded as an on-chain event, timestamped by block time, attributable to the disclosing service's address.

```solidity
function logAccess(bytes32 recordId, uint256 grantId, bytes32 purpose, bytes32 disclosureHash) external;
event Accessed(bytes32 indexed recordId, uint256 indexed grantId, address indexed accessor, bytes32 purpose, bytes32 disclosureHash, uint256 timestamp);
```

**Semantics.** `disclosureHash` is the hash of (record version ‖ recipient ‖ timestamp), letting a patient later verify *what version* was disclosed *to whom*. Logging is restricted to registered discloser addresses (clinics, HIE nodes) to prevent log spam; registration is governed by a simple allowlist controlled by a multisig of participating institutions. The log is queryable by `recordId`, giving the patient a complete, institution-independent access history — the property centralized audit logs cannot offer, since the custodian controls them.

### 4.3 RecordAnchor.sol — tamper-evident integrity

**Responsibility:** commit hashes of record versions on-chain so that subsequent modification of the off-chain store is detectable.

```solidity
function anchor(bytes32 recordId, bytes32 recordHash, string calldata uri) external;
function verify(bytes32 recordId, bytes32 recordHash) external view returns (bool isCurrent, uint256 anchoredAt);
event Anchored(bytes32 indexed recordId, bytes32 recordHash, string uri, uint256 timestamp);
```

**Semantics.** `recordHash` is `keccak256` of the encrypted record bytes; `uri` is a pointer to the off-chain location (IPFS CID, vault reference). `verify` lets anyone confirm that a presented record matches the anchored hash and when it was anchored. Versioning is by repeated anchoring; the full version history is the event log.

### 4.4 EmbryoDisposition.sol — worked clinical scenario (ART)

Assisted reproduction presents a consent problem of unusual sharpness: disposition of cryopreserved embryos typically requires the **concurrent, unrevoked consent of both progenitors**, and disputes (divorce, death, withdrawal of consent by one party) are litigated regularly. This contract specializes the registry pattern for that case.

```solidity
function registerCohort(bytes32 cohortId, address progenitorA, address progenitorB, address clinic) external;
function consentDisposition(bytes32 cohortId, uint8 option) external;   // option: CONTINUE_STORAGE | DONATE_RESEARCH | DONATE_COUPLE | DISCARD | ...
function revokeDisposition(bytes32 cohortId) external;
function dispositionStatus(bytes32 cohortId) external view returns (bool executable, uint8 agreedOption);
event DispositionConsented(bytes32 indexed cohortId, address indexed progenitor, uint8 option, uint256 timestamp);
event DispositionRevoked(bytes32 indexed cohortId, address indexed progenitor, uint256 timestamp);
```

**Semantics.** A disposition is `executable` iff both progenitors have consented to the *same* option and neither has revoked. Any revocation by either party immediately renders the disposition non-executable, and the revocation is timestamped on-chain — producing exactly the evidentiary record courts currently reconstruct from paper forms and testimony. The clinic's address is recorded so the authorization is bound to the custodian.

---

## 5. Evaluation plan (not results)

Because this is a methods paper, we specify how the method should be evaluated rather than reporting outcomes:

1. **Functional tests** (`test/`): grant → valid; grant → revoke → invalid; expiry boundary; purpose mismatch rejected; double-consent gating in EmbryoDisposition; revocation by one progenitor blocks execution. Each test maps to one normative sentence in Section 4.
2. **Gas profiling:** measure `grant`, `revoke`, `logAccess`, and `anchor` on a local EVM (e.g., Anvil) and report per-function gas with the network's gas price, yielding a per-consent-lifecycle cost figure. *Illustrative estimate only (not measured):* a full grant→disclosure→revoke lifecycle plausibly costs on the order of 100k–200k gas; at 1 gwei on a consortium chain this is fractions of a cent, at 20 gwei on mainnet it is dollars — the reason Section 2.1 assumes a low-fee network.
3. **Threat-model review** (Section 6) conducted as a structured walkthrough with clinical, security, and legal reviewers before any pilot.
4. **Pilot criteria:** a pilot may begin only when (a) all functional tests pass, (b) the threat-model review is signed off, (c) a key-recovery procedure for patients exists off-chain, and (d) counsel has reviewed the erasure-rights analysis (Section 6.3).

---

## 6. Threat model and limitations

**6.1 What the chain guarantees.** Ordering, timestamping, tamper-evidence of the governance metadata, and deterministic execution of the consent logic. It does not guarantee that the off-chain record is correct, complete, or fairly obtained — "garbage in, anchored garbage out."

**6.2 Oracle and disclosure gap.** The contracts govern *permission*; the actual disclosure happens off-chain. A malicious discloser can disclose without logging. Mitigations: disclosures are detectable by the recipient's inability to produce a matching audit event; institutional allowlisting makes the discloser set small and accountable; but the gap cannot be closed cryptographically without trusted execution environments, which are out of scope.

**6.3 Immutability vs. erasure.** GDPR's right to erasure and similar rights conflict with append-only logs. The architecture's answer is that no PHI is on-chain, so erasure of the off-chain record plus revocation of consent leaves only hashes and access metadata — which are arguably still personal data under GDPR. Deployments in scope of GDPR need a legal basis for retaining the audit trail (e.g., legal obligation under medical-record retention law) documented before deployment. This paper does not resolve the conflict; it confines it to metadata.

**6.4 Key management.** Patients lose keys. There is no good decentralized recovery story; the method assumes an institutional recovery procedure (in-person re-verification, key rotation via the proxy mechanism). Any deployment without one will strand patients outside their own consent system — the worst possible failure for a patient-agency tool.

**6.5 Purpose-code governance.** The controlled vocabulary is a governance artifact: who defines purposes, who adjudicates "research vs. treatment" boundary cases, and how codes evolve without breaking existing grants. Recommend versioned purpose registries with explicit migration rules.

**6.6 Non-goals restated.** Identity provisioning, record storage, clinical semantics, and cross-chain interoperability are out of scope.

---

## 7. Discussion: executable governance

This method is best understood as *executable governance* — the machine-readable counterpart to the governance-and-ethics framework for computational reproductive modeling described previously by the author. Where that framework articulates principles for who decides, this one specifies a mechanism by which decisions, once made, are enforced and evidenced without relying on the good faith of the custodian. The embryo-disposition contract (Section 4.4) is the bridge: a domain where consent is multi-party, longitudinal, revokable, and frequently disputed is exactly where procedural governance fails most visibly and executable governance adds most value.

Future work, in order of priority: (1) reference implementation audit and gas profiling per Section 5; (2) a pilot with a single clinic on a consortium chain, scoped to consent and audit for one record type; (3) integration patterns with FHIR-based consent resources (mapping `Grant` to FHIR Consent); (4) formal verification of the disposition-gating logic.

---

## 8. Conclusion

Consent, audit, and integrity attestation for medical records can be expressed as three small Solidity contracts plus one domain specialization, with PHI kept strictly off-chain. The method is specified to the level of function signatures and includes its own evaluation plan and threat model. It is offered not as a finished system but as a precise starting point — one that treats the hardest problems (key recovery, erasure rights, the disclosure gap) as first-class limitations rather than footnotes.

---

## References

1. Nakamoto, S. (2008). Bitcoin: A Peer-to-Peer Electronic Cash System.
2. Buterin, V. (2014). Ethereum: A Next-Generation Smart Contract and Decentralized Application Platform.
3. Solidity documentation, v0.8.x. https://docs.soliditylang.org
4. Azaria, A. et al. (2016). MedRec: Using Blockchain for Medical Data Access and Permission Management. *2nd Int. Conf. on Open and Big Data*.
5. HL7 FHIR R4 — Consent resource. https://www.hl7.org/fhir/consent.html
6. HIPAA Privacy Rule, 45 CFR Part 160 and Part 164.
7. EU General Data Protection Regulation (2016/679), esp. Art. 17 (right to erasure).
8. Gordon, W. J. & Catalini, C. (2018). Blockchain Technology for Healthcare: Facilitating the Transition to Patient-Driven Interoperability. *Comp. Struct. Biotech. J.* 16:224–230.
9. Zagadailov, P. (2026). A governance and ethics framework for computational reproductive selection modeling. Zenodo. https://doi.org/10.5281/zenodo.23068885
10. Zagadailov, P. (2026). A governed synthetic genetic pool as a computational framework anchored to real population allele frequencies and simulated with msprime. Zenodo. https://doi.org/10.5281/zenodo.23068129

---

*Manuscript history: v1.0 drafted 2026-10-06. Reference Solidity implementations in `../contracts/`. Correspondence: pzagadailov@corgdata.com*
