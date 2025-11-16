import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.RPC_URL || 'https://rpc.api.moonbase.moonbeam.network';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const ARTIFACT_PATH = path.join(__dirname, '..', 'artifacts', 'contracts', 'PlayerContract.sol', 'PlayerData.json');
const STORE_PATH = path.join(__dirname, 'userContracts.json');

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return {};
  }
}

async function createContract(username, address) {
  if (!signer) throw new Error('No signer available. Please set PRIVATE_KEY in .env');

  // Accept both Ethereum addresses and other identifier formats (Polkadot, etc.).
  // If it's a valid EVM address we normalize it; otherwise we keep the raw identifier.
  let normalizedAddress = address;
  let isEthereumAddress = false;
  try {
    normalizedAddress = ethers.getAddress(address);
    isEthereumAddress = true;
  } catch (error) {
    // Not an EVM address — treat as external identifier (store as-is)
    console.log('Non-EVM identifier provided; storing as off-chain identifier:', address);
    normalizedAddress = address;
    isEthereumAddress = false;
  }

  const deployer = await signer.getAddress();
  const balance = await provider.getBalance(deployer);

  const store = readStore();
  if (store[username]) throw new Error('Username already exists');

  const artifact = loadArtifact();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

  console.log(`Deploying contract for ${username} (${normalizedAddress}) from ${deployer} with balance ${ethers.formatEther(balance)} ETH`);

  const contract = await factory.deploy();
  await contract.waitForDeployment();
  console.log(`Contract deployed at ${contract.target}`);

  store[username] = {
    contractAddress: contract.target,
    owner: deployer,
    playerAddress: normalizedAddress,
    playerAddressIsEthereum: isEthereumAddress,
    deployedAt: new Date().toISOString(),
  };

  // Persist the store before attempting on-chain actions so the record exists
  writeStore(store);

  // If it's an Ethereum address, initialize the address mapping on-chain.
  if (isEthereumAddress) {
    try {
      const initTx = await contract.adminSetKills(normalizedAddress, 0);
      console.log(`Initializing kills=0 for EVM player ${normalizedAddress}`);
    } catch (e) {
      throw new Error(`Failed to broadcast initialization tx: ${e?.message || e}`);
    }
  }

    // Additionally, initialize the generic id mapping (bytes32) so non-EVM identifiers
    // are represented on-chain. We compute keccak256 over the identifier string.
    try {
      const idHash = ethers.id(normalizedAddress);
      // call adminSetKillsById for all identifiers (this will set the bytes32 mapping).
      await contract.adminSetKillsById(idHash, 0);
      console.log(`Initialized id-hash mapping on-chain for ${normalizedAddress} -> ${idHash}`);
    } catch (e) {
      // If the contract doesn't have adminSetKillsById (old ABI), surface a clear message
      console.warn('Could not initialize id-hash mapping on-chain (contract may need recompilation/redeploy):', e?.message || e);
    }

  return contract;
}

async function getUserContract(username) {
  const store = readStore();
  const record = store[username];
  if (!record) throw new Error('Username does not exist');
  const contractAddress = record.contractAddress;
  console.log("Reading contract Address:", contractAddress + " for user:", username);

  const artifact = loadArtifact();
  const abi = artifact.abi;
  const contract = new ethers.Contract(contractAddress, abi, provider);
  // Prefer on-chain lookup by address when we know it's an Ethereum address,
  // otherwise use the bytes32 id lookup (keccak256 of identifier string).
  let killsBn = -1n;
  try {
    if (record.playerAddressIsEthereum) {
      killsBn = await contract.getKills(record.playerAddress).catch(() => -1n);
    } else {
      const idHash = ethers.id(record.playerAddress);
      // Try the id-based getter; if it fails (old contract), fallback to -1n
      if (typeof contract.getKillsById === 'function') {
        killsBn = await contract.getKillsById(idHash).catch(() => -1n);
      } else {
        // contract doesn't support id-based getter
        killsBn = -1n;
      }
    }
  } catch (e) {
    killsBn = -1n;
  }
  // console.log(`Fetched kills for ${username}:`, killsBn.toString());

  // Normalize kills to a JSON-serializable value (string or null)
  let kills = null;
  try {
    if (typeof killsBn === 'bigint') {
      kills = killsBn === -1n ? null : killsBn.toString();
    } else if (killsBn && typeof killsBn.toString === 'function') {
      // handles BigNumber-like objects
      const s = killsBn.toString();
      kills = s === '-1' ? null : s;
    } else {
      kills = null;
    }
  } catch (e) {
    kills = null;
  }

  return {
    contractAddress: record.contractAddress,
    owner: record.owner,
    playerAddress: record.playerAddress,
    deployedAt: record.deployedAt,
    kills: kills,
  };
}

function loadArtifact() {
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`Artifact not found at ${ARTIFACT_PATH}. Run npx hardhat compile first.`);
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
}


function writeStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    throw new Error(`Failed to write store: ${e?.message || e}`);
  }
}

function getPlayerRecord(username) {
  const store = readStore();
  return store[username] || null;
}

export { createContract, getUserContract, getPlayerRecord };
