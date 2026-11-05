'use strict';

/**
 * fallback/server.js - pure Node fallback for AI Status Light.
 *
 * Used when the Electron binary cannot be installed. It runs the SAME local
 * HTTP status service (127.0.0.1:17890, same API and heartbeat rules as the
 * Electron main process) and serves a browser page at
 * http://127.0.0.1:17890/ that renders the status-light strip.
 *
 * Limitations vs the Electron overlay: no always-on-top, no frameless window,
 * no position memory. Keep the browser window pinned/on top manually if needed.
 *
 * Usage: node fallback/server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = Number(process.env.PORT) || 17890;
const HTTP_HOST = '127.0.0.1';
const HEARTBEAT_IDLE_MS = 60_000;
const HEARTBEAT_OFFLINE_MS = 300_000;
const AGENT_ID_PATTERN = /^[a-z0-9_-]{1,24}$/i;
const VALID_STATUSES = new Set(['running', 'idle', 'stuck', 'assist', 'offline']);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PAGE_PATH = path.join(__dirname, 'page.html');

/** @type {Map<string, {id: string, name: string, status: string, task: string, lastHeartbeat: number}>} */
const agents = new Map();

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    for (const entry of Array.isArray(raw.agents) ? raw.agents : []) {
      if (entry && typeof entry.id === 'string') {
        agents.set(entry.id, {
          id: entry.id,
          name: entry.name || entry.id,
          status: 'offline',
          task: '',
          lastHeartbeat: 0,
        });
      }
    }
  } catch {
    console.warn('[fallback] config.json not found or invalid, starting empty');
  }
}

function saveConfig() {
  const payload = {
    agents: Array.from(agents.values()).map((a) => ({ id: a.id, name: a.name })),
    window: { x: null, y: null },
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[fallback] failed to save config.json:', err.message);
  }
}

function effectiveStatus(agent, now) {
  // "stuck" and "assist" are sticky: they only clear via a new report.
  if (agent.status === 'stuck') return 'stuck';
  if (agent.status === 'assist') return 'assist';
  if (!agent.lastHeartbeat) return 'offline';
  const age = now - agent.lastHeartbeat;
  if (age > HEARTBEAT_OFFLINE_MS) return 'offline';
  if (age > HEARTBEAT_IDLE_MS) return 'idle';
  return agent.status;
}

function serializeAgents() {
  const now = Date.now();
  return Array.from(agents.values()).map((a) => {
    const status = effectiveStatus(a, now);
    return { id: a.id, name: a.name, status, auto: status !== a.status, task: a.task, lastHeartbeat: a.lastHeartbeat };
  });
}

function upsertAgent(id, name) {
  const existing = agents.get(id);
  if (existing) {
    if (name && name !== existing.name) { existing.name = name; saveConfig(); }
    return existing;
  }
  const created = { id, name: name || id, status: 'offline', task: '', lastHeartbeat: 0 };
  agents.set(id, created);
  saveConfig();
  return created;
}

function applyReport(body) {
  if (!body || typeof body.agent !== 'string' || !body.agent.trim()) {
    return { ok: false, error: 'missing "agent" field' };
  }
  const id = body.agent.trim();
  if (!AGENT_ID_PATTERN.test(id)) {
    return { ok: false, error: `invalid agent id "${id}"` };
  }
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : '';
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: `invalid status "${body.status}"` };
  }
  const agent = upsertAgent(id, typeof body.name === 'string' ? body.name : undefined);
  agent.status = status;
  if (typeof body.task === 'string') agent.task = body.task.slice(0, 500);
  agent.lastHeartbeat = status === 'offline' ? 0 : Date.now();
  return { ok: true };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

loadConfig();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HTTP_HOST}:${HTTP_PORT}`);

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(PAGE_PATH));
    }
    if (req.method === 'POST' && url.pathname === '/status') {
      const result = applyReport(await readJsonBody(req));
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === 'GET' && (url.pathname === '/agents' || url.pathname === '/api/state')) {
      return sendJson(res, 200, { ok: true, agents: serializeAgents() });
    }
    if (req.method === 'POST' && url.pathname === '/agents') {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== 'string' || !AGENT_ID_PATTERN.test(body.id.trim())) {
        return sendJson(res, 400, { ok: false, error: 'missing or invalid "id"' });
      }
      upsertAgent(body.id.trim(), typeof body.name === 'string' ? body.name : undefined);
      return sendJson(res, 200, { ok: true });
    }
    const deleteMatch = url.pathname.match(/^\/agents\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const removed = agents.delete(deleteMatch[1]);
      if (removed) saveConfig();
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: 'agent not found' });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[fallback] AI Status Light fallback running.`);
  console.log(`[fallback] Open http://${HTTP_HOST}:${HTTP_PORT}/ in your browser for the status page.`);
  console.log(`[fallback] Report status: POST http://${HTTP_HOST}:${HTTP_PORT}/status`);
});
