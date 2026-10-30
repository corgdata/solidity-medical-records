import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, ZeroAddress, ZeroHash, id } from 'ethers';
const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/MedicalRecordsRegistry.json', import.meta.url)));
const salt = id('test-only-random-salt');
const locator = id('test-only-opaque-locator-commitment');
const digest = id('test-only-ciphertext');
const nextLocator = id('second-locator');
const nextDigest = id('second-ciphertext');
async function fixture(t) {
  const rpc = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', time: new Date('2026-01-01T00:00:00Z') }, wallet: { totalAccounts: 4 }, miner: { timestampIncrement: 0 } });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); });
  const [patient, clinician, stranger, secondPatient] = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const registry = await new ContractFactory(artifact.abi, artifact.bytecode, patient).deploy();
  await registry.waitForDeployment();
  const recordId = await registry.computeRecordId(patient.address, salt);
  await (await registry.createRecord(salt, locator, digest)).wait();
  const now = Number((await provider.getBlock('latest')).timestamp);
  return { rpc, provider, patient, clinician, stranger, secondPatient, registry, recordId, now };
}
async function rejected(call) { await assert.rejects(call, error => error.code === 'CALL_EXCEPTION'); }

test('creation records ownership, immutable first version, and owner permissions', async t => {
  const { registry: c, recordId: r, patient } = await fixture(t);
  const record = await c.getRecord(r);
  assert.equal(record.patient, patient.address);
  assert.equal(record.archived, false);
  assert.equal(record.versionCount, 1n);
  const version = await c.getVersion(r, 1);
  assert.equal(version.locatorCommitment, locator);
  assert.equal(version.ciphertextHash, digest);
  assert.equal(version.author, patient.address);
  assert.equal(await c.canRead(r, patient.address), true);
  assert.equal(await c.canWrite(r, patient.address), true);
});

test('unknown records deny access and metadata/version reads reject', async t => {
  const { registry: c, patient } = await fixture(t);
  const unknown = id('missing');
  assert.equal(await c.canRead(unknown, patient.address), false);
  assert.equal(await c.canWrite(unknown, patient.address), false);
  await rejected(c.getRecord(unknown));
  await rejected(c.getVersion(unknown, 1));
  await rejected(c.appendVersion.staticCall(unknown, 1, locator, digest));
});

test('record identifiers are patient namespaced; duplicate creation cannot overwrite', async t => {
  const { registry: c, recordId: r, secondPatient } = await fixture(t);
  await rejected(c.createRecord.staticCall(salt, nextLocator, nextDigest));
  const otherId = await c.computeRecordId(secondPatient.address, salt);
  assert.notEqual(otherId, r);
  await (await c.connect(secondPatient).createRecord(salt, nextLocator, nextDigest)).wait();
  assert.equal((await c.getRecord(otherId)).patient, secondPatient.address);
  assert.equal((await c.getVersion(r, 1)).ciphertextHash, digest);
});

test('zero commitments and ciphertext hashes are rejected on create and append', async t => {
  const { registry: c, recordId: r } = await fixture(t);
  await rejected(c.createRecord.staticCall(id('new'), ZeroHash, digest));
  await rejected(c.createRecord.staticCall(id('new'), locator, ZeroHash));
  await rejected(c.appendVersion.staticCall(r, 1, ZeroHash, digest));
  await rejected(c.appendVersion.staticCall(r, 1, locator, ZeroHash));
});

test('ungranted callers cannot append or manage permissions or archive', async t => {
  const { registry: c, recordId: r, stranger, clinician, now } = await fixture(t);
  const attacker = c.connect(stranger);
  assert.equal(await c.canRead(r, stranger.address), false);
  assert.equal(await c.canWrite(r, stranger.address), false);
  await rejected(attacker.appendVersion.staticCall(r, 1, locator, digest));
  await rejected(attacker.grantAccess.staticCall(r, clinician.address, 3, now + 100));
  await rejected(attacker.revokeAccess.staticCall(r, clinician.address));
  await rejected(attacker.setArchived.staticCall(r, true));
});

test('read-only permission allows gateway read authorization but not append', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 1, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canWrite(r, clinician.address), false);
  await rejected(c.connect(clinician).appendVersion.staticCall(r, 1, nextLocator, nextDigest));
});

test('writer appends attributed version without modifying earlier version or gaining administration', async t => {
  const { registry: c, recordId: r, clinician, stranger, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.connect(clinician).appendVersion(r, 1, nextLocator, nextDigest)).wait();
  assert.equal((await c.getRecord(r)).versionCount, 2n);
  assert.equal((await c.getVersion(r, 1)).ciphertextHash, digest);
  const v2 = await c.getVersion(r, 2);
  assert.equal(v2.ciphertextHash, nextDigest);
  assert.equal(v2.author, clinician.address);
  await rejected(c.connect(clinician).grantAccess.staticCall(r, stranger.address, 3, now + 100));
  await rejected(c.connect(clinician).setArchived.staticCall(r, true));
});

test('compare-and-swap rejects stale and future versions; invalid indices reject', async t => {
  const { registry: c, recordId: r } = await fixture(t);
  await rejected(c.appendVersion.staticCall(r, 0, nextLocator, nextDigest));
  await rejected(c.appendVersion.staticCall(r, 2, nextLocator, nextDigest));
  await (await c.appendVersion(r, 1, nextLocator, nextDigest)).wait();
  await rejected(c.appendVersion.staticCall(r, 1, locator, digest));
  await rejected(c.getVersion(r, 0));
  await rejected(c.getVersion(r, 3));
});

test('grants reject invalid masks, zero address, and expired grants', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  for (const mask of [0, 4, 255]) await rejected(c.grantAccess.staticCall(r, clinician.address, mask, now + 100));
  await rejected(c.grantAccess.staticCall(r, ZeroAddress, 1, now + 100));
  await rejected(c.grantAccess.staticCall(r, clinician.address, 1, now));
  await rejected(c.grantAccess.staticCall(r, clinician.address, 1, 0));
});

test('grant expires exactly at expiresAt; expired writers cannot append', async t => {
  const { registry: c, recordId: r, clinician, now, rpc } = await fixture(t);
  const expiry = now + 100;
  await (await c.grantAccess(r, clinician.address, 3, expiry)).wait();
  await rpc.request({ method: 'evm_setTime', params: [(expiry - 1) * 1000] });
  await rpc.request({ method: 'evm_mine', params: [] });
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canWrite(r, clinician.address), true);
  await rpc.request({ method: 'evm_setTime', params: [expiry * 1000] });
  await rpc.request({ method: 'evm_mine', params: [] });
  assert.equal(await c.canRead(r, clinician.address), false);
  assert.equal(await c.canWrite(r, clinician.address), false);
  await rejected(c.connect(clinician).appendVersion.staticCall(r, 1, locator, digest));
});

test('revocation immediately blocks read and write; a new explicit grant works', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.revokeAccess(r, clinician.address)).wait();
  assert.equal(await c.canRead(r, clinician.address), false);
  assert.equal(await c.canWrite(r, clinician.address), false);
  await rejected(c.connect(clinician).appendVersion.staticCall(r, 1, locator, digest));
  await (await c.grantAccess(r, clinician.address, 1, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canWrite(r, clinician.address), false);
});

test('global revoke invalidates all patient grants without affecting another patient', async t => {
  const { registry: c, recordId: r, clinician, secondPatient, now } = await fixture(t);
  const r2 = await c.computeRecordId(secondPatient.address, salt);
  await (await c.connect(secondPatient).createRecord(salt, locator, digest)).wait();
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.connect(secondPatient).grantAccess(r2, clinician.address, 3, now + 100)).wait();
  await (await c.revokeAllAccess()).wait();
  assert.equal(await c.canRead(r, clinician.address), false);
  assert.equal(await c.canWrite(r, clinician.address), false);
  assert.equal(await c.canRead(r2, clinician.address), true);
  await (await c.grantAccess(r, clinician.address, 1, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
});

test('archiving disables owner and delegate policy access and writes; restoring preserves history', async t => {
  const { registry: c, recordId: r, clinician, patient, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.setArchived(r, true)).wait();
  for (const account of [patient.address, clinician.address]) {
    assert.equal(await c.canRead(r, account), false);
    assert.equal(await c.canWrite(r, account), false);
  }
  await rejected(c.appendVersion.staticCall(r, 1, locator, digest));
  await rejected(c.connect(clinician).appendVersion.staticCall(r, 1, locator, digest));
  assert.equal((await c.getVersion(r, 1)).ciphertextHash, digest);
  await (await c.setArchived(r, false)).wait();
  assert.equal(await c.canRead(r, patient.address), true);
  assert.equal((await c.getRecord(r)).versionCount, 1n);
});

test('metadata is publicly readable even without an access grant', async t => {
  const { registry: c, recordId: r, stranger } = await fixture(t);
  assert.equal(await c.canRead(r, stranger.address), false);
  assert.equal((await c.connect(stranger).getVersion(r, 1)).ciphertextHash, digest);
});

test('state-changing operations emit parseable events with record identifiers', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  for (const tx of [
    () => c.grantAccess(r, clinician.address, 1, now + 100),
    () => c.revokeAccess(r, clinician.address),
    () => c.appendVersion(r, 1, nextLocator, nextDigest),
    () => c.setArchived(r, true),
  ]) {
    const receipt = await (await tx()).wait();
    const parsed = receipt.logs.map(log => c.interface.parseLog(log));
    assert.ok(parsed.some(event => event.args.some(arg => arg === r)));
  }
});

test('write-only grants do not imply reads and replacement can downgrade a writer to reader', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 2, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), false);
  assert.equal(await c.canWrite(r, clinician.address), true);
  await (await c.connect(clinician).appendVersion(r, 1, nextLocator, nextDigest)).wait();
  await (await c.grantAccess(r, clinician.address, 1, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canWrite(r, clinician.address), false);
  assert.equal((await c.getGrant(r, clinician.address)).permissions, 1n);
  await rejected(c.connect(clinician).appendVersion.staticCall(r, 2, locator, digest));
});

test('restore reactivates retained valid grants but not grants revoked while archived', async t => {
  const { registry: c, recordId: r, clinician, now } = await fixture(t);
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.setArchived(r, true)).wait();
  assert.equal(await c.canRead(r, clinician.address), false);
  await rejected(c.grantAccess.staticCall(r, clinician.address, 1, now + 100));
  await (await c.setArchived(r, false)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canWrite(r, clinician.address), true);
  await (await c.setArchived(r, true)).wait();
  await (await c.revokeAccess(r, clinician.address)).wait();
  await (await c.setArchived(r, false)).wait();
  assert.equal(await c.canRead(r, clinician.address), false);
  assert.equal(await c.canWrite(r, clinician.address), false);
});

test('global revoke covers multiple same-owner records, including archived ones, and isolates other patients', async t => {
  const { registry: c, recordId: r, patient, clinician, secondPatient, now } = await fixture(t);
  const secondSalt = id('same-patient-second-record');
  const sameOwnerRecord = await c.computeRecordId(patient.address, secondSalt);
  const otherOwnerRecord = await c.computeRecordId(secondPatient.address, salt);
  await (await c.createRecord(secondSalt, locator, digest)).wait();
  await (await c.connect(secondPatient).createRecord(salt, locator, digest)).wait();
  await (await c.grantAccess(r, clinician.address, 3, now + 100)).wait();
  await (await c.grantAccess(sameOwnerRecord, clinician.address, 3, now + 100)).wait();
  await (await c.connect(secondPatient).grantAccess(otherOwnerRecord, clinician.address, 3, now + 100)).wait();
  await (await c.setArchived(sameOwnerRecord, true)).wait();
  await (await c.revokeAllAccess()).wait();
  await (await c.setArchived(sameOwnerRecord, false)).wait();
  for (const record of [r, sameOwnerRecord]) {
    assert.equal(await c.canRead(record, clinician.address), false);
    assert.equal(await c.canWrite(record, clinician.address), false);
    await rejected(c.connect(clinician).appendVersion.staticCall(record, 1, nextLocator, nextDigest));
  }
  assert.equal(await c.canRead(otherOwnerRecord, clinician.address), true);
  assert.equal(await c.canWrite(otherOwnerRecord, clinician.address), true);
  await (await c.grantAccess(r, clinician.address, 1, now + 100)).wait();
  assert.equal(await c.canRead(r, clinician.address), true);
  assert.equal(await c.canRead(sameOwnerRecord, clinician.address), false);
});

test('seeded random operation sequences preserve access, expiry, archive, and version invariants', async t => {
  const SEED = 20261030;
  const STEPS = 200;
  let state = SEED >>> 0;
  const nextRandom = () => {
    state = (state + 0x6D2B79F5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = arr => arr[Math.floor(nextRandom() * arr.length)];
  const below = n => Math.floor(nextRandom() * n);

  const rpc = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', time: new Date('2026-01-01T00:00:00Z') }, wallet: { totalAccounts: 6 }, miner: { timestampIncrement: 0 } });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await rpc.disconnect(); });
  const signers = await Promise.all([0, 1, 2, 3, 4, 5].map(i => provider.getSigner(i)));
  const [patientA, patientB, delegate1, delegate2, delegate3, stranger] = signers;
  const patients = [patientA, patientB];
  const grantees = [delegate1, delegate2, delegate3, stranger];
  const allAccounts = signers.map(s => s.address);
  const registry = await new ContractFactory(artifact.abi, artifact.bytecode, patientA).deploy();
  await registry.waitForDeployment();
  let now = Number((await provider.getBlock('latest')).timestamp);

  const epochs = new Map(patients.map(p => [p.address, 0]));
  const records = new Map();
  const recordIds = [];
  const previousCounts = new Map();
  let saltCounter = 0;
  let valueCounter = 0;
  const freshBytes = label => id(`invariant-${label}-${valueCounter++}`);

  const modelAccess = (record, account) => {
    if (!record || record.archived) return { read: false, write: false };
    if (account === record.patient) return { read: true, write: true };
    const grant = record.grants.get(account);
    if (!grant || grant.epoch !== epochs.get(record.patient) || !(now < grant.expiresAt)) return { read: false, write: false };
    return { read: (grant.permissions & 1) !== 0, write: (grant.permissions & 2) !== 0 };
  };

  async function checkInvariants(step) {
    for (const [recordId, record] of records) {
      const onchain = await registry.getRecord(recordId);
      assert.equal(onchain.patient, record.patient, `step ${step}: patient drift on ${recordId}`);
      assert.equal(onchain.archived, record.archived, `step ${step}: archive drift on ${recordId}`);
      assert.equal(onchain.versionCount, BigInt(record.versions.length), `step ${step}: version count drift on ${recordId}`);
      const previous = previousCounts.get(recordId) ?? 0n;
      assert.ok(onchain.versionCount >= previous, `step ${step}: version count decreased on ${recordId}`);
      previousCounts.set(recordId, onchain.versionCount);
      for (const account of allAccounts) {
        const expected = modelAccess(record, account);
        assert.equal(await registry.canRead(recordId, account), expected.read, `step ${step}: canRead(${recordId}, ${account})`);
        assert.equal(await registry.canWrite(recordId, account), expected.write, `step ${step}: canWrite(${recordId}, ${account})`);
      }
      for (const grantee of grantees) {
        const stored = await registry.getGrant(recordId, grantee.address);
        const grant = record.grants.get(grantee.address);
        assert.equal(stored.permissions, BigInt(grant ? grant.permissions : 0), `step ${step}: grant permissions drift on ${recordId}`);
        assert.equal(stored.expiresAt, BigInt(grant ? grant.expiresAt : 0), `step ${step}: grant expiry drift on ${recordId}`);
        assert.equal(stored.epoch, BigInt(grant ? grant.epoch : 0), `step ${step}: grant epoch drift on ${recordId}`);
      }
      for (let v = 1; v <= record.versions.length; v++) {
        const stored = await registry.getVersion(recordId, v);
        assert.equal(stored.locatorCommitment, record.versions[v - 1].locatorCommitment, `step ${step}: version ${v} locator mutated on ${recordId}`);
        assert.equal(stored.ciphertextHash, record.versions[v - 1].ciphertextHash, `step ${step}: version ${v} ciphertext hash mutated on ${recordId}`);
        assert.equal(stored.author, record.versions[v - 1].author, `step ${step}: version ${v} author mutated on ${recordId}`);
      }
    }
  }

  const opCounts = { create: 0, append: 0, grant: 0, revoke: 0, revokeAll: 0, archive: 0, advanceTime: 0, foreignManage: 0, duplicateCreate: 0 };
  for (let step = 0; step < STEPS; step++) {
    const roll = nextRandom();
    if (recordIds.length === 0 || roll < 0.10) {
      const patient = pick(patients);
      if (recordIds.length > 0 && nextRandom() < 0.25) {
        opCounts.duplicateCreate++;
        const owner = pick(patients);
        const existing = pick([...records.values()].filter(r => r.patient === owner.address));
        if (existing) {
          await rejected(registry.connect(owner).createRecord.staticCall(existing.salt, freshBytes('locator'), freshBytes('digest')));
        }
      } else {
        opCounts.create++;
        const saltValue = id(`invariant-salt-${saltCounter++}`);
        const recordId = await registry.computeRecordId(patient.address, saltValue);
        const locatorValue = freshBytes('locator');
        const digestValue = freshBytes('digest');
        await (await registry.connect(patient).createRecord(saltValue, locatorValue, digestValue)).wait();
        records.set(recordId, { patient: patient.address, salt: saltValue, archived: false, grants: new Map(), versions: [{ locatorCommitment: locatorValue, ciphertextHash: digestValue, author: patient.address }] });
        recordIds.push(recordId);
      }
    } else if (roll < 0.34) {
      opCounts.append++;
      const recordId = pick(recordIds);
      const record = records.get(recordId);
      const caller = pick([patients.find(p => p.address === record.patient), ...grantees]);
      const useCorrectCount = nextRandom() < 0.75;
      const expectedVersion = useCorrectCount ? record.versions.length : below(record.versions.length + 2);
      const locatorValue = freshBytes('locator');
      const digestValue = freshBytes('digest');
      const shouldPass = !record.archived && modelAccess(record, caller.address).write && expectedVersion === record.versions.length;
      if (shouldPass) {
        await (await registry.connect(caller).appendVersion(recordId, expectedVersion, locatorValue, digestValue)).wait();
        record.versions.push({ locatorCommitment: locatorValue, ciphertextHash: digestValue, author: caller.address });
      } else {
        await rejected(registry.connect(caller).appendVersion.staticCall(recordId, expectedVersion, locatorValue, digestValue));
      }
    } else if (roll < 0.56) {
      opCounts.grant++;
      const recordId = pick(recordIds);
      const record = records.get(recordId);
      const owner = patients.find(p => p.address === record.patient);
      const grantee = pick(grantees);
      const permissions = 1 + below(3);
      const delta = pick([-50, 10, 100, 1000, 5000]);
      const expiresAt = now + delta;
      const shouldPass = !record.archived && expiresAt > now;
      if (shouldPass) {
        await (await registry.connect(owner).grantAccess(recordId, grantee.address, permissions, expiresAt)).wait();
        record.grants.set(grantee.address, { permissions, expiresAt, epoch: epochs.get(record.patient) });
      } else {
        await rejected(registry.connect(owner).grantAccess.staticCall(recordId, grantee.address, permissions, expiresAt));
      }
    } else if (roll < 0.64) {
      opCounts.revoke++;
      const recordId = pick(recordIds);
      const record = records.get(recordId);
      const owner = patients.find(p => p.address === record.patient);
      const grantee = pick(grantees);
      await (await registry.connect(owner).revokeAccess(recordId, grantee.address)).wait();
      record.grants.delete(grantee.address);
    } else if (roll < 0.70) {
      opCounts.revokeAll++;
      const patient = pick(patients);
      await (await registry.connect(patient).revokeAllAccess()).wait();
      epochs.set(patient.address, epochs.get(patient.address) + 1);
    } else if (roll < 0.80) {
      opCounts.archive++;
      const recordId = pick(recordIds);
      const record = records.get(recordId);
      const owner = patients.find(p => p.address === record.patient);
      const target = !record.archived;
      await (await registry.connect(owner).setArchived(recordId, target)).wait();
      record.archived = target;
    } else if (roll < 0.92) {
      opCounts.advanceTime++;
      now += 1 + below(600);
      await rpc.request({ method: 'evm_setTime', params: [now * 1000] });
      await rpc.request({ method: 'evm_mine', params: [] });
    } else {
      opCounts.foreignManage++;
      const recordId = pick(recordIds);
      const record = records.get(recordId);
      const outsider = pick(signers.filter(s => s.address !== record.patient));
      await rejected(registry.connect(outsider).grantAccess.staticCall(recordId, delegate1.address, 3, now + 100));
      await rejected(registry.connect(outsider).revokeAccess.staticCall(recordId, delegate1.address));
      await rejected(registry.connect(outsider).setArchived.staticCall(recordId, true));
    }
    await checkInvariants(step);
  }
  console.log(`invariant sequence complete: seed=${SEED} steps=${STEPS} records=${recordIds.length} operations=${JSON.stringify(opCounts)}`);
});
