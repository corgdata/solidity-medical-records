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
