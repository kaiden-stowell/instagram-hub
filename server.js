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

// ── Debug / status ─────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    mode: instagram.getMode(),            // 'mock' | 'live' | 'composio'
    connected: instagram.isConnected(),
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
