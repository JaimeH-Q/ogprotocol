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

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
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
  const contractAddress = store[username]?.contractAddress;
  if (!contractAddress) throw new Error('Username does not exist');

  const abi = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')).abi;
  const contract = new ethers.Contract(contractAddress, abi, provider);

  return {
    contract,
    owner: store[username].owner,
    playerAddress: store[username].playerAddress,
    deployedAt: store[username].deployedAt,
  };
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
