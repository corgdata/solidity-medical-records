import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceName = 'contracts/MedicalRecordsRegistry.sol';
if (!solc.version().startsWith('0.8.30+')) throw new Error(`Expected Solidity 0.8.30; got ${solc.version()}`);
const input = {
  language: 'Solidity',
  sources: { [sourceName]: { content: fs.readFileSync(path.join(root, sourceName), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
if ((output.errors ?? []).some(d => d.severity === 'error')) process.exit(1);
const compiled = output.contracts[sourceName].MedicalRecordsRegistry;
const artifact = {
  contractName: 'MedicalRecordsRegistry', sourceName, compilerVersion: solc.version(),
  abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`,
  deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
  metadata: JSON.parse(compiled.metadata),
};
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts/MedicalRecordsRegistry.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(`Compiled ${artifact.contractName}: ${compiled.evm.deployedBytecode.object.length / 2} deployed bytes; solc ${solc.version()}; Paris EVM.`);
