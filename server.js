'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');

const db        = require('./db');
const instagram = require('./instagram');
const runner    = require('./runner');
const composio  = require('./composio');
const settings  = require('./settings');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '12790', 10);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket ──────────────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ event: 'hello', data: { mode: instagram.getMode() } }));
});

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

instagram.setBroadcast(broadcast);
runner.setBroadcast(broadcast);

// ── Version + update ───────────────────────────────────────────────────
const REPO_API_URL = 'https://api.github.com/repos/kaiden-stowell/instagram-hub/contents/version.json?ref=main';
let cachedRemoteVersion = null;
let lastVersionCheck = 0;

function getLocalVersion() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
  } catch { return 'unknown'; }
}

app.get('/api/version', (req, res) => res.json({ version: getLocalVersion() }));

app.get('/api/update/check', async (req, res) => {
  try {
    const localVersion = getLocalVersion();
    const forceCheck = req.query.force === '1';
    if (!forceCheck && Date.now() - lastVersionCheck < 120000 && cachedRemoteVersion) {
      return res.json({ local: localVersion, remote: cachedRemoteVersion, updateAvailable: cachedRemoteVersion !== localVersion });
    }
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const r = https.get(REPO_API_URL, {
        headers: { 'User-Agent': 'instagram-hub', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, resp => {
        if (resp.statusCode !== 200) { reject(new Error(`GitHub API returned ${resp.statusCode}`)); resp.resume(); return; }
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out')); });
    });
    const json = JSON.parse(data);
    if (!json.content) throw new Error('No content in GitHub response');
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    const remote = JSON.parse(content).version;
    cachedRemoteVersion = remote;
    lastVersionCheck = Date.now();
    res.json({ local: localVersion, remote, updateAvailable: remote !== localVersion });
  } catch (e) {
    console.error('[update] check failed:', e.message);
    res.json({ local: getLocalVersion(), remote: null, updateAvailable: false, error: e.message });
  }
});

app.post('/api/update/apply', (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const gitDir = path.join(__dirname, '.git');
  if (!fs.existsSync(gitDir)) {
    return res.status(400).json({ error: 'Not a git repo. Run the install script first.' });
  }
  try {
    // Backup user data before updating
    const dataDir = path.join(__dirname, 'data');
    const backupRoot = path.join(__dirname, 'backups');
    const backupDir = path.join(backupRoot, 'pre-update_' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(dataDir)) {
      const dataBackup = path.join(backupDir, 'data');
      fs.mkdirSync(dataBackup, { recursive: true });
      for (const f of fs.readdirSync(dataDir)) {
        try { fs.copyFileSync(path.join(dataDir, f), path.join(dataBackup, f)); } catch {}
      }
    }
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(backupDir, '.env'));
    console.log('[update] backup saved to ' + backupDir);

    // Make sure remote points at the right repo
    try {
      const currentRemote = execSync('git remote get-url origin', { cwd: __dirname, stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (!currentRemote.includes('instagram-hub')) {
        execSync('git remote set-url origin https://github.com/kaiden-stowell/instagram-hub.git', { cwd: __dirname, stdio: 'pipe', timeout: 5000 });
      }
    } catch {
      try { execSync('git remote add origin https://github.com/kaiden-stowell/instagram-hub.git', { cwd: __dirname, stdio: 'pipe', timeout: 5000 }); } catch {}
    }

    // Stash local tracked changes before pulling
    try { execSync('git stash', { cwd: __dirname, stdio: 'pipe', timeout: 10000 }); } catch {}

    // Fast-forward if possible, otherwise fetch + hard reset
    try {
      execSync('git pull --ff-only origin main', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    } catch {
      console.log('[update] ff failed, fetch + reset...');
      execSync('git fetch origin main', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
      execSync('git reset --hard origin/main', { cwd: __dirname, stdio: 'pipe', timeout: 10000 });
    }

    // npm install in case dependencies changed
    try {
      execSync('npm install --production --silent', { cwd: __dirname, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      console.error('[update] npm install failed:', e.message);
    }

    // Verify db survived
    const dbFile    = path.join(dataDir, 'db.json');
    const dbBackup  = path.join(backupDir, 'data', 'db.json');
    if (fs.existsSync(dbBackup)) {
      let ok = false;
      try { ok = !!JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
      if (!ok) {
        console.log('[update] db missing/corrupt after update — restoring');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.copyFileSync(dbBackup, dbFile);
      }
    }

    const newVersion = getLocalVersion();
    cachedRemoteVersion = null;
    lastVersionCheck = 0;
    broadcast('update:applied', { version: newVersion });
    res.json({ ok: true, version: newVersion, restarting: true });

    // Restart — launchd will bring us back up
    setTimeout(() => {
      console.log('[update] restarting after update…');
      process.exit(0);
    }, 1000);
  } catch (e) {
    console.error('[update] apply failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Debug / status ─────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    mode: instagram.getMode(),            // 'mock' | 'live' | 'composio'
    connected: instagram.isConnected(),
    version: getLocalVersion(),
    claudeBin: runner.CLAUDE_BIN,
    claudeExists: require('fs').existsSync(runner.CLAUDE_BIN),
    node: process.version,
  });
});

// ── Accounts ───────────────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => res.json(db.getAccounts()));
app.get('/api/accounts/:id', (req, res) => {
  const a = db.getAccount(req.params.id);
  return a ? res.json(a) : res.status(404).json({ error: 'not found' });
});

// ── Stats (dashboard overview) ─────────────────────────────────────────
app.get('/api/stats', (req, res) => res.json(db.getStats(req.query.account_id || null)));

// ── DMs ────────────────────────────────────────────────────────────────
app.get('/api/threads', (req, res) => res.json(db.getThreads(req.query.account_id || null)));

app.get('/api/threads/:id', (req, res) => {
  const thread = db.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'not found' });
  const messages = db.getMessages(req.params.id);
  res.json({ thread, messages });
});

app.post('/api/threads/:id/read', (req, res) => {
  db.markThreadRead(req.params.id);
  broadcast('thread:read', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/threads/:id/send', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const msg = await instagram.sendDirectMessage(req.params.id, text);
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Posts ──────────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => res.json(db.getPosts(req.query.account_id || null)));

// ── Analytics ──────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  const limit = parseInt(req.query.limit || '30', 10);
  res.json(db.getAnalytics(req.query.account_id || null, limit));
});

// ── Manual refresh (live mode) ─────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  try {
    await instagram.fetchAll();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings / Composio connect ────────────────────────────────────────
app.get('/api/settings/composio', async (req, res) => {
  const env = settings.readEnv();
  const hasKey = Boolean(env.COMPOSIO_API_KEY);
  let connections = [];
  let error = null;
  if (hasKey) {
    try { connections = await composio.listConnections('instagram'); }
    catch (e) { error = e.message; }
  }
  const active = connections.find(c => (c.status || '').toLowerCase() === 'active');
  res.json({
    configured: hasKey,
    keyMasked: settings.maskKey(env.COMPOSIO_API_KEY || ''),
    userId: env.COMPOSIO_USER_ID || 'default',
    mode: instagram.getMode(),
    instagramConnected: Boolean(active),
    connections: connections.map(c => ({
      id: c.id, status: c.status, toolkit: c.toolkit_slug || 'instagram',
      created_at: c.created_at,
    })),
    error,
  });
});

app.post('/api/settings/composio', async (req, res) => {
  try {
    const { apiKey, userId } = req.body || {};
    if (!apiKey?.trim()) return res.status(400).json({ error: 'apiKey required' });
    settings.writeEnv({
      COMPOSIO_API_KEY: apiKey.trim(),
      COMPOSIO_USER_ID: (userId || 'default').trim(),
    });
    // Hot-reload the integration (no launchd restart needed)
    instagram.stop();
    instagram.init();
    broadcast('settings:updated', { mode: instagram.getMode() });
    res.json({ ok: true, mode: instagram.getMode() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/composio', (req, res) => {
  settings.writeEnv({ COMPOSIO_API_KEY: '' });
  instagram.stop();
  instagram.init();
  broadcast('settings:updated', { mode: instagram.getMode() });
  res.json({ ok: true, mode: instagram.getMode() });
});

// Initiate a new Instagram OAuth connection via Composio.
// Returns a redirect_url the user opens to authorize.
// Generate a direct Composio MCP connect link for a given app/toolkit.
// Primary path: open https://connect.composio.dev/mcp?app=<slug> so Composio
// hosts the app-specific OAuth landing. If the user has an API key we also
// attempt to initiate a programmatic connection that produces the real
// provider OAuth URL (e.g. instagram.com/accounts/login/...).
function mcpConnectUrl(app) {
  return `https://connect.composio.dev/mcp?app=${encodeURIComponent(app)}`;
}

// For now, the Connect Instagram button just opens the Composio dashboard.
// The programmatic initiate flow is flaky across API key shapes, so we let
// the user complete the connection there and come back to click Refresh.
app.post('/api/settings/composio/connect-instagram', async (req, res) => {
  res.json({
    redirect_url: 'https://dashboard.composio.dev/',
    source: 'dashboard',
  });
});

// Force a full fetch right now (useful right after connecting)
app.post('/api/settings/composio/refresh', async (req, res) => {
  try {
    await instagram.fetchAll();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Claude Code chat ───────────────────────────────────────────────────
app.get('/api/chat', (req, res) => res.json(db.getChats()));

app.post('/api/chat', (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const id = runner.sendChat(text);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/stop', (req, res) => {
  const stopped = runner.stopChat();
  res.json({ stopped });
});

app.delete('/api/chat', (req, res) => {
  db.clearChats();
  broadcast('chat:cleared', {});
  res.json({ ok: true });
});

// ── Boot ──────────────────────────────────────────────────────────────
instagram.init();

server.listen(PORT, HOST, () => {
  console.log(`\n  Instagram Hub running at http://${HOST}:${PORT}`);
  console.log(`  Mode: ${instagram.getMode().toUpperCase()}`);
  console.log(`  Claude binary: ${runner.CLAUDE_BIN}\n`);
});

process.on('SIGINT',  () => { instagram.stop(); process.exit(0); });
process.on('SIGTERM', () => { instagram.stop(); process.exit(0); });
