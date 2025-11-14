import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();


const RPC_URL = process.env.RPC_URL || 'https://rpc.api.moonbase.moonbeam.network';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

const ARTIFACT_PATH = path.join(__dirname, '..', 'artifacts', 'contracts', 'PlayerData.sol', 'PlayerData.json');
const STORE_PATH = path.join(__dirname, 'userContracts.json');

