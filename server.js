import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createContract, getUserContract, getPlayerRecord } from './backend/contractManager.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: 'http://localhost:2000',  
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.get('/', (req, res) => {
  res.send('OG Protocol Backend is running!');
});

/**
 * Register user contract endpoint (req.body)
 */
app.post('/user', async (req, res) => {
  const { username, address } = req.body;

  if (!username || !address) {
    return res.status(400).json({ error: 'Username and address are required' });
  }

  try {
    const contract = await createContract(username, address);
    res.status(201).json({
      message: 'Player registered successfully',
      contractAddress: contract.target,
      record: getPlayerRecord(username),
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create contract' });
  }
});


app.get('/user/:username', async (req, res) => {
  const { username } = req.params;
  const record = getPlayerRecord(username);
  if (!record) {
    return res.status(404).json({ error: 'User not found' });
  }

  const contract = await getUserContract(username);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found for user' });
  }

  res.json(contract);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
