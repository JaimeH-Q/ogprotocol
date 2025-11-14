import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';  
import { ethers } from 'ethers';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

app.get('/', (req, res) => {
  res.send('OG Protocol Backend is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});