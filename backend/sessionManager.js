import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { inspect } from 'util';
import dotenv from 'dotenv';
dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File-backed token store (replaces previous in-memory sessions map)
// Tokens are persisted to `backend/tokens.json` so the server can be restarted
// without losing pending login tokens. Tokens keep the same TTL semantics.
const TOKENS_PATH = path.join(__dirname, 'tokens.json');
const SESSION_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ARKACDN_URL = process.env.ARKACDN_URL || 'https://arkacdn.cloudycoding.com/api';
let ARKACDN_TOKEN = process.env.ARKACDN_TOKEN;
const ARKACDN_REFRESH_TOKEN = process.env.ARKACDN_REFRESH_TOKEN;
const REGISTERED_MAP_PATH = path.join(__dirname, 'registeredSessions.json');

// Helper: read tokens file
function _readTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
      return raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.warn('Failed to read tokens file, starting fresh:', e?.message || e);
  }
  return {};
}

// Helper: write tokens file
function _writeTokens(map) {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write tokens file:', e);
    throw e;
  }
}

/**
 * Create a new ephemeral login token UUID for a specific username and store it on disk.
 * Tokens expire after `SESSION_TTL_MS` but we lazily remove expired tokens on get.
 */
function createToken(username, data = {}) {
  if (!username || typeof username !== 'string') throw new Error('username (string) is required to create a session');
  const map = _readTokens();

  // Remove any existing token for this username (single token per user)
  for (const [id, rec] of Object.entries(map)) {
    if (rec && rec.username === username) delete map[id];
  }

  const uuid = (typeof randomUUID === 'function') ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const createdAt = new Date();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  map[uuid] = { username, data, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  _writeTokens(map);
  return uuid;
}

/**
 * Retrieve a token record from disk. Removes it from disk if expired.
 */
function getToken(uuid) {
  if (!uuid || typeof uuid !== 'string') return null;
  const map = _readTokens();
  const rec = map[uuid];
  if (!rec) return null;
  if (Date.now() > new Date(rec.expiresAt).getTime()) {
    delete map[uuid];
    _writeTokens(map);
    return null;
  }
  return { uuid, username: rec.username, data: rec.data, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
}

function deleteToken(uuid) {
  const map = _readTokens();
  if (!map[uuid]) return false;
  delete map[uuid];
  _writeTokens(map);
  return true;
}

export { createToken, getToken, deleteToken };

/**
 * Register a session (persisted remotely via Arkacdn) using a token UUID.
 * The session stored remotely is a JSON containing { username, createdAt, ip}.
 * On success, the function saves a local mapping fileId -> session JSON in `registeredSessions.json`.
 * @param {string} tokenUuid
 * @param {string} ip
 * @returns {Promise<{fileId:string, session:Object, arkacdn:Object}>}
 */
async function registerSession(tokenUuid, ip) {
  // Validate input
  if (!tokenUuid || typeof tokenUuid !== 'string') throw new Error('tokenUuid (string) is required');
  if (!ip || typeof ip !== 'string') throw new Error('ip (string) is required');

  // Validate token and build session object
  const rec = getToken(tokenUuid);
  if (!rec) throw new Error('Invalid or expired token');

  const sessionObj = {
    ip,
    username: rec.username,
    createdAt: new Date().toISOString(),
    tokenUuid,
  };

  // Ensure we can call fetch
  let fetchFn = (typeof fetch === 'function') ? fetch : null;
  if (!fetchFn) {
    try {
      const mod = await import('node-fetch');
      fetchFn = mod.default || mod;
    } catch (e) {
      throw new Error('fetch is not available and node-fetch could not be imported');
    }
  }

  if (!ARKACDN_URL) throw new Error('ARKACDN_URL is not set in environment');
  if (!ARKACDN_TOKEN && !ARKACDN_REFRESH_TOKEN) throw new Error('ARKACDN_TOKEN or ARKACDN_REFRESH_TOKEN must be set in environment');

  const base = ARKACDN_URL.replace(/\/$/, '');
  const uploadUrl = `${base}/upload/plain`;

  // Helper: attempt refresh and update ARKACDN_TOKEN if response provides accessToken


  // Pre-refresh to revive session if possible
  await attemptRefresh();

  // Build payload: ensure remote receives JSON string so fields like `ip` are preserved
  const payload = {
    data: JSON.stringify(sessionObj),
    filename: `${rec.username}-session.json`,
    description: `Session for ${rec.username}`,
  };

  console.log(payload)

  // Upload helper with optional retry-on-401
  async function doUpload() {
    const resp = await fetchFn(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARKACDN_TOKEN}` },
      body: JSON.stringify(payload),
    });
    return resp;
  }

  console.log("Playoad json " + JSON.stringify(payload))

  // Perform upload and if 401 then attempt refresh once and retry
  let res = await doUpload();
  if (res.status === 401) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      res = await doUpload();
    } else {
      const bt = await res.text().catch(() => null);
      throw new Error(`Arkacdn unauthorized and refresh failed: ${bt}`);
    }
  }

  const bodyText = await res.text().catch(() => null);
  let parsed = null; try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch (e) { parsed = bodyText; }
  if (!res.ok) {
    const errMsg = (parsed && (parsed.message || parsed.error)) || `status ${res.status}`;
    throw new Error(`Arkacdn registration failed: ${errMsg}`);
  }

  // Extract fileId robustly
  let fileId = null;
  if (parsed) {
    fileId = parsed?.data?.fileId || parsed?.data?.file_id || parsed?.data?.id || parsed?.fileId || parsed?.file_id || parsed?.id || null;
  }
  if (!fileId) throw new Error(`Arkacdn response missing fileId; response=${JSON.stringify(parsed || {})}`);

  // Persist map (without storing ip), keep minimal info for lookup
  let map = {};
  try { if (fs.existsSync(REGISTERED_MAP_PATH)) { const raw = fs.readFileSync(REGISTERED_MAP_PATH, 'utf8'); map = raw ? JSON.parse(raw) : {}; } } catch (e) { map = {}; }
  map[fileId] = { username: sessionObj.username, tokenUuid: sessionObj.tokenUuid };
  try { fs.writeFileSync(REGISTERED_MAP_PATH, JSON.stringify(map, null, 2), 'utf8'); } catch (e) { throw new Error(`Failed to persist registered sessions map: ${e?.message || e}`); }

  // Verify remote stored content contains ip
  try {
    const fileUrl = `${base}/upload/${fileId}`;
    const rf = await fetchFn(fileUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${ARKACDN_TOKEN}` } });
    const txt = await rf.text().catch(() => null);
    let remote = null; try { remote = txt ? JSON.parse(txt) : null; } catch (e) { remote = txt; }
    const remoteIp = remote && remote.ip ? String(remote.ip) : null;
    if (!remoteIp) {
      // remote didn't store ip as a field — surface an error so caller can inspect logs
      console.warn('Remote session did not include ip field', { fileId, remote });
      return { fileId, session: sessionObj, verified: false, arkacdn: { status: res.status, body: parsed } };
    }
    return { fileId, session: sessionObj, verified: true, arkacdn: { status: res.status, body: parsed } };
  } catch (e) {
    // Could not verify remote content; still return success but flag unverified
    console.warn('Could not verify remote session content', e);
    return { fileId, session: sessionObj, verified: false, arkacdn: { status: res.status, body: parsed } };
  }
}


async function getSessionForUsername(username, ip) {
  if(!await attemptRefresh()){
    throw new Error('Failed to refresh Arkacdn token');
  }

  if(username===undefined || typeof username!=='string' || username.length===0) {
    throw new Error('username (non-empty string) is required');
  }
  if(ip===undefined || typeof ip!=='string' || ip.length===0) {
    throw new Error('ip (non-empty string) is required');
  }

  for(const [fileId, rec] of Object.entries(JSON.parse(fs.readFileSync(REGISTERED_MAP_PATH, 'utf8')) || {})) {
    if(rec.username !== username) {
      continue;
    }
    const fetchUrl = ARKACDN_URL + `/upload/${fileId}/json`;

    const res = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ARKACDN_TOKEN}`
      }
    });
    if(!res.ok) {
      if(res.status === 404) {
        unregisterSessionLocally(fileId);
        return { allowed: false, reason: 'no_session' };
      }
      if(res.status === 400) {
        throw new Error(`No session found for username ${username}. Maybe it hasn't uploaded yet?`);
      }
      throw new Error(`Arkacdn fetch failed: status ${res.status}`);
    }
    const sessionData = await res.json();
    const sessionIp = sessionData.data.data.ip;
    console.log("Session IP:", sessionIp, "Provided IP:", ip);

    if(sessionIp === ip) {
      return { allowed: true, fileId, session: sessionData.data.data };
    } else {
      return { allowed: false, reason: 'ip_mismatch' };
    }


    
  }  
}


  async function attemptRefresh() {
    const refreshUrl = `${ARKACDN_URL}/auth/refresh`;

    let fetchFn = (typeof fetch === 'function') ? fetch : null;
  if (!fetchFn) {
    try {
      const mod = await import('node-fetch');
      fetchFn = mod.default || mod;
    } catch (e) {
      throw new Error('fetch is not available and node-fetch could not be imported');
    }
  }
    if (!ARKACDN_REFRESH_TOKEN) return false;
    try {
      const r = await fetchFn(refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: ARKACDN_REFRESH_TOKEN }),
      });
      const txt = await r.text().catch(() => null);
      let parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) { parsed = txt; }
      const newToken = parsed && (parsed.accessToken || parsed.access_token || parsed.token);
      if (newToken && typeof newToken === 'string') {
        ARKACDN_TOKEN = String(newToken);
        return true;
      }
      return r.ok;
    } catch (e) {
      console.error('Arkacdn token refresh failed:', e);
      return false;
    }
  }

function unregisterSessionLocally(fileId) {
  let map = {};
  try { if (fs.existsSync(REGISTERED_MAP_PATH)) { const raw = fs.readFileSync(REGISTERED_MAP_PATH, 'utf8'); map = raw ? JSON.parse(raw) : {}; } } catch (e) { map = {}; }
  if (map[fileId]) {
    delete map[fileId];
    try { fs.writeFileSync(REGISTERED_MAP_PATH, JSON.stringify(map, null, 2), 'utf8'); } catch (e) { throw new Error(`Failed to persist registered sessions map: ${e?.message || e}`); }
  }


}

export { registerSession, getSessionForUsername };
