// Synthetic data only. This demonstrates local encryption and the registry, not a gateway.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BrowserProvider, ContractFactory, keccak256, hexlify } from 'ethers';
import ganache from 'ganache';
import './compile.mjs';

const artifact = JSON.parse(readFileSync(new URL('../artifacts/MedicalRecordsRegistry.json', import.meta.url)));
const rpc = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 }, chain: { hardfork: 'shanghai' } });
try {
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const patient = await provider.getSigner(0);
  const clinician = await provider.getSigner(1);
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, patient).deploy();
  await contract.waitForDeployment();
  const salt = hexlify(randomBytes(32));
  const recordId = await contract.computeRecordId(await patient.getAddress(), salt);
  const network = await provider.getNetwork();
  const aad = Buffer.from(JSON.stringify({ chainId: network.chainId.toString(), registry: await contract.getAddress(), recordId, version: 1 }));
  const key = randomBytes(32), nonce = randomBytes(12), locatorToken = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify({ resourceType: 'Observation', status: 'final', note: [{ text: 'SYNTHETIC DEMO ONLY' }] }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Demo envelope layout: 1-byte format version, 12-byte nonce, 16-byte tag, ciphertext.
  const envelope = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  await (await contract.createRecord(salt, keccak256(locatorToken), keccak256(envelope))).wait();
  const block = await provider.getBlock('latest');
  await (await contract.grantAccess(recordId, await clinician.getAddress(), 1, block.timestamp + 3600)).wait();
  if (!await contract.canRead(recordId, await clinician.getAddress())) throw new Error('Grant failed');
  const version = await contract.getVersion(recordId, 1);
  if (version.ciphertextHash !== keccak256(envelope)) throw new Error('Integrity mismatch');
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 13));
  decipher.setAAD(aad); decipher.setAuthTag(envelope.subarray(13, 29));
  const recovered = Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
  if (!recovered.equals(plaintext)) throw new Error('Round-trip failed');
  await (await contract.revokeAccess(recordId, await clinician.getAddress())).wait();
  if (await contract.canRead(recordId, await clinician.getAddress())) throw new Error('Revocation failed');
  console.log('PASS: local deployment, encrypted synthetic record, integrity check, authenticated decryption, permission grant and revocation.');
  console.log('Encryption key stayed in process memory. No external storage or healthcare gateway was deployed.');
} finally {
  await rpc.disconnect();
}
