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

  let normalizedAddress;
  try {
    normalizedAddress = ethers.getAddress(address);
  } catch (error) {
    throw new Error('Invalid Ethereum address provided.');
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
    deployedAt: new Date().toISOString(),
  };

  try {
    const initTx = await contract.adminSetKills(normalizedAddress, 0);
    console.log(`Initializing kills=0 for player ${normalizedAddress}`);
    writeStore(store);
  } catch (e) {
    throw new Error(`Failed to broadcast initialization tx: ${e?.message || e}`);
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
  const killsBn = await contract.getKills(record.playerAddress).catch(() => -1n);
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
