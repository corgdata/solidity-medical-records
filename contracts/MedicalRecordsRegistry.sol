// Copyright (c) 2026 Clinical Outcomes Research Group, CORG LLC
// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Patient-controlled registry for encrypted off-chain medical records
/// @notice ALL chain state, calldata and events are public, including wallet relationships.
/// Never submit names, diagnoses, plaintext records, URLs, encryption keys, or plaintext hashes.
/// Permissions are policy signals for an authenticated off-chain key/storage gateway;
/// they do not hide chain state or retract data or keys already disclosed.
/// @dev No administrator, external calls, upgrade mechanism, funds or identity verification.
contract MedicalRecordsRegistry {
    uint8 public constant READ = 1;
    uint8 public constant WRITE = 2;

    struct Record {
        address patient;
        bool archived;
        uint64 versionCount;
    }

    struct Version {
        bytes32 locatorCommitment;
        bytes32 ciphertextHash;
        address author;
        uint64 createdAt;
    }

    struct Grant {
        uint8 permissions;
        uint64 expiresAt;
        uint256 epoch;
    }

    mapping(bytes32 recordId => Record) private records;
    mapping(bytes32 recordId => mapping(uint64 version => Version)) private versions;
    mapping(bytes32 recordId => mapping(address delegate => Grant)) private grants;
    mapping(address patient => uint256 epoch) public patientAccessEpoch;

    error UnknownRecord();
    error RecordAlreadyExists();
    error InvalidCommitment();
    error NotPatient();
    error RecordArchived();
    error UnauthorizedWriter();
    error StaleVersion();
    error InvalidDelegate();
    error InvalidPermissions();
    error InvalidExpiry();
    error UnknownVersion();

    event RecordCreated(bytes32 indexed recordId, address indexed patient);
    event VersionAppended(
        bytes32 indexed recordId,
        uint64 indexed version,
        address indexed author,
        bytes32 locatorCommitment,
        bytes32 ciphertextHash
    );
    event AccessGranted(
        bytes32 indexed recordId,
        address indexed delegate,
        uint8 permissions,
        uint64 expiresAt,
        uint256 epoch
    );
    event AccessRevoked(bytes32 indexed recordId, address indexed delegate);
    event AllAccessRevoked(address indexed patient, uint256 newEpoch);
    event ArchiveStatusChanged(bytes32 indexed recordId, bool archived);

    /// @notice Derives an ID in a patient's namespace. Use a cryptographically random salt.
    /// @dev IDs are local to this deployment; off-chain signing must also bind chain and contract.
    function computeRecordId(address patient, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(patient, salt));
    }

    /// @notice Registers the caller as patient and creates immutable version 1.
    /// @param locatorCommitment Commitment to a high-entropy opaque off-chain locator.
    /// @param ciphertextHash Hash of the encrypted payload, never its plaintext.
    function createRecord(bytes32 salt, bytes32 locatorCommitment, bytes32 ciphertextHash)
        external
        returns (bytes32 recordId)
    {
        _validateCommitments(locatorCommitment, ciphertextHash);
        recordId = computeRecordId(msg.sender, salt);
        if (records[recordId].patient != address(0)) revert RecordAlreadyExists();
        records[recordId] = Record(msg.sender, false, 1);
        emit RecordCreated(recordId, msg.sender);
        _storeVersion(recordId, 1, locatorCommitment, ciphertextHash);
    }

    /// @notice Appends a version without modifying any prior version.
    /// @param expectedVersion Current version count, preventing silent concurrent overwrites.
    /// @dev Write authority establishes wallet provenance, not clinical truth or professional status.
    function appendVersion(
        bytes32 recordId,
        uint64 expectedVersion,
        bytes32 locatorCommitment,
        bytes32 ciphertextHash
    ) external {
        Record storage record = _requireRecord(recordId);
        if (record.archived) revert RecordArchived();
        if (!_hasAccess(recordId, record, msg.sender, WRITE)) revert UnauthorizedWriter();
        if (record.versionCount != expectedVersion) revert StaleVersion();
        _validateCommitments(locatorCommitment, ciphertextHash);
        uint64 newVersion = record.versionCount + 1;
        record.versionCount = newVersion;
        _storeVersion(recordId, newVersion, locatorCommitment, ciphertextHash);
    }

    /// @notice Replaces the delegate's complete record-level grant; permissions are READ, WRITE or both.
    /// @dev READ and WRITE are independent. Grants cover all past and future versions of this record.
    /// Expiry is exclusive: access ends when block.timestamp >= expiresAt. No permanent grants.
    function grantAccess(bytes32 recordId, address delegate, uint8 permissions, uint64 expiresAt)
        external
    {
        Record storage record = _requirePatient(recordId);
        if (record.archived) revert RecordArchived();
        if (delegate == address(0) || delegate == msg.sender) revert InvalidDelegate();
        if (permissions == 0 || permissions > (READ | WRITE)) revert InvalidPermissions();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        uint256 epoch = patientAccessEpoch[msg.sender];
        grants[recordId][delegate] = Grant(permissions, expiresAt, epoch);
        emit AccessGranted(recordId, delegate, permissions, expiresAt, epoch);
    }

    /// @notice Revokes a delegate, including while archived; does not retract disclosed keys or copies.
    function revokeAccess(bytes32 recordId, address delegate) external {
        _requirePatient(recordId);
        delete grants[recordId][delegate];
        emit AccessRevoked(recordId, delegate);
    }

    /// @notice Invalidates every existing grant across all records owned by the caller in O(1).
    /// @dev New grants use the new epoch; old grants never reactivate on restore or regrant elsewhere.
    function revokeAllAccess() external {
        uint256 newEpoch = ++patientAccessEpoch[msg.sender];
        emit AllAccessRevoked(msg.sender, newEpoch);
    }

    /// @notice Suspends/resumes gateway read policy and appends, including the patient's access.
    /// @dev Archive is not deletion. Restoring reactivates grants still valid by expiry and epoch.
    function setArchived(bytes32 recordId, bool archived) external {
        Record storage record = _requirePatient(recordId);
        record.archived = archived;
        emit ArchiveStatusChanged(recordId, archived);
    }

    /// @notice Policy check for authenticated off-chain gateways, not a confidentiality boundary.
    function canRead(bytes32 recordId, address account) external view returns (bool) {
        return _hasAccess(recordId, records[recordId], account, READ);
    }

    function canWrite(bytes32 recordId, address account) external view returns (bool) {
        return _hasAccess(recordId, records[recordId], account, WRITE);
    }

    /// @notice Public metadata; access control cannot hide blockchain storage.
    function getRecord(bytes32 recordId) external view returns (Record memory) {
        return _requireRecord(recordId);
    }

    /// @notice Returns immutable public commitment metadata for a 1-indexed version.
    function getVersion(bytes32 recordId, uint64 version) external view returns (Version memory) {
        Record storage record = _requireRecord(recordId);
        if (version == 0 || version > record.versionCount) revert UnknownVersion();
        return versions[recordId][version];
    }

    /// @notice Returns raw grant state, which may be expired, invalidated or suspended.
    /// Use canRead/canWrite for the effective permission decision.
    function getGrant(bytes32 recordId, address delegate) external view returns (Grant memory) {
        _requireRecord(recordId);
        return grants[recordId][delegate];
    }

    function _hasAccess(bytes32 recordId, Record storage record, address account, uint8 permission)
        private
        view
        returns (bool)
    {
        if (record.patient == address(0) || record.archived || account == address(0)) return false;
        if (account == record.patient) return true;
        Grant storage grant = grants[recordId][account];
        return (grant.permissions & permission) != 0 && block.timestamp < grant.expiresAt
            && grant.epoch == patientAccessEpoch[record.patient];
    }

    function _requireRecord(bytes32 recordId) private view returns (Record storage record) {
        record = records[recordId];
        if (record.patient == address(0)) revert UnknownRecord();
    }

    function _requirePatient(bytes32 recordId) private view returns (Record storage record) {
        record = _requireRecord(recordId);
        if (record.patient != msg.sender) revert NotPatient();
    }

    function _validateCommitments(bytes32 locatorCommitment, bytes32 ciphertextHash) private pure {
        if (locatorCommitment == bytes32(0) || ciphertextHash == bytes32(0)) revert InvalidCommitment();
    }

    function _storeVersion(bytes32 recordId, uint64 version, bytes32 locatorCommitment, bytes32 ciphertextHash)
        private
    {
        versions[recordId][version] =
            Version(locatorCommitment, ciphertextHash, msg.sender, uint64(block.timestamp));
        emit VersionAppended(recordId, version, msg.sender, locatorCommitment, ciphertextHash);
    }
}
