import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createContract, getUserContract, getPlayerRecord } from './backend/contractManager.js';
import { createToken, getToken, registerSession, getSessionForUsername } from './backend/sessionManager.js';
import fs from 'fs';
import path from 'path';

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

/*
 * Register user contract endpoint (req.body)
 *
 * Disabled: user registration via this endpoint is commented out on purpose.
 * To register a user programmatically, call `createContract(username, address)`
 * from server-side flows (for example during /login when user is missing).
 */
/*
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
*/


/**
 * Login: accepts { username, token, address, ip }
 * - validates the token
 * - if user does not exist, auto-registers via createContract(username, address)
 * - registers a session via Arkacdn (registerSession)
 */
app.post('/login', async (req, res) => {
  const { username, token, address, ip } = req.body;
  const storedToken = getToken(token);
  if (!storedToken || storedToken.username !== username) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'address (wallet) is required in body' });
  }

  if (!ip || typeof ip !== 'string') {
    return res.status(400).json({ error: 'ip is required in body' });
  }

  try {
    // If user not registered, create their contract (register user)
    const record = getPlayerRecord(username);
    if (!record) {
      try {
        // createContract may deploy on-chain; surface any errors
        const contract = await createContract(username, address);
        console.log(`Auto-registered user ${username} with contract ${contract.target}`);
      } catch (regErr) {
        console.error('Failed to auto-register user:', regErr);
        return res.status(500).json({ error: 'Failed to auto-register user', details: regErr?.message || String(regErr) });
      }
    }

    const result = await registerSession(token, ip);
    return res.status(200).json({ message: 'Session registered', fileId: result.fileId, session: result.session, arkacdn: result.arkacdn });
  } catch (err) {
    console.error('Failed to register session:', err);
    return res.status(502).json({ error: err?.message || 'Failed to register session' });
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

/**
 * Create a login token for a given username.
 * GET /token?username=<username>
 *
 * NOTE: Generating a token no longer requires that the player is already registered.
 * Tokens can be requested by clients before user registration; the token will still be
 * associated with the provided `username` string.
 */
app.get('/token', async (req, res) => {
  try {
    const username = req.query.username;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username query parameter is required' });

    // createToken will throw on invalid args; we do NOT check getPlayerRecord here
    const token = createToken(username, { createdFor: username });

    return res.json({ token });
  } catch (err) {
    console.error('Failed to create token:', err);
    return res.status(500).json({ error: err?.message || 'Failed to create token' });
  }
});

/**
 * Validate a token by id
 * GET /token/validate/:id
 */
app.get('/token/validate/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'token id is required' });

    const token = getToken(id);
    if (!token) return res.status(404).json({ valid: false });

    return res.json({ valid: true, token });
  } catch (err) {
    console.error('Token validation failed:', err);
    return res.status(500).json({ error: err?.message || 'Token validation failed' });
  }
});


/**
 * Validate session by token and ip
 * POST /validatesession  { token, ip }
 * Responses mapped from `getSession`:
 * - 200: session exists for that token's username and ip
 * - 404: no session exists for that username (body.reason = 'no_session')
 * - 409: session exists but ip mismatch (body.reason = 'ip_mismatch')
 * - 401: token invalid or expired
 */
app.post('/validatesession', async (req, res) => {
  try {
    const { username, ip } = req.body || {};
    if (!username || !ip || typeof username !== 'string' || typeof ip !== 'string') {
      return res.status(400).json({ error: 'username and ip (strings) are required in body' });
    }

    let sessionResult;
    try {
      sessionResult = await getSessionForUsername(username, ip);
    } catch (e) {
      const msg = String(e?.message || e);
      console.error('getSessionForUsername error:', e);
      return res.status(502).json({ error: msg });
    }

    if (sessionResult && sessionResult.allowed === true) {
      return res.status(200).json({ ok: true, fileId: sessionResult.fileId, session: sessionResult.session });
    }

    if (sessionResult && sessionResult.reason === 'ip_mismatch') {
      return res.status(409).json({ ok: false, reason: 'ip_mismatch', action: sessionResult.action });
    }

    if (sessionResult && sessionResult.reason === 'no_session') {
      return res.status(404).json({ ok: false, reason: 'no_session', action: sessionResult.action });
    }

    // Fallback
    return res.status(500).json({ error: 'Unexpected response from getSessionForUsername', result: sessionResult });
  } catch (err) {
    console.error('validatesession failed', err);
    return res.status(500).json({ error: err?.message || 'validatesession failed' });
  }
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
