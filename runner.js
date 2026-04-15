'use strict';
// Thin Claude Code runner — spawns the `claude` CLI as a subprocess and streams
// stream-json output back over a broadcast hook (wired to WebSocket in server.js).
// Modeled on agent-hub/runner.js but slimmed down: no agents, no COO, one chat lane.

const { spawn }   = require('child_process');
const fs          = require('fs');
const path        = require('path');
const { v4: uuidv4 } = require('uuid');
const db          = require('./db');
const instagram   = require('./instagram');

let _broadcast = () => {};
function setBroadcast(fn) { _broadcast = fn || (() => {}); }

// ── Locate claude binary ─────────────────────────────────────────────────
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '', '.npm', 'bin', 'claude'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return require('child_process').execSync('which claude', { stdio: 'pipe' }).toString().trim(); } catch {}
  return 'claude';
}
const CLAUDE_BIN = findClaude();
console.log(`[runner] claude binary: ${CLAUDE_BIN}`);

function claudeArgs(prompt) {
  return [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
    prompt,
  ];
}

function parseStreamLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) out.push(block.text);
          else if (block.type === 'tool_use')       out.push(`\`[tool: ${block.name}]\``);
        }
      }
    } catch {}
  }
  return out.join('');
}

// Build a system prompt that describes the current IG state so Claude can reason about it.
function buildContext() {
  const stats    = db.getStats();
  const posts    = db.getPosts().slice(0, 5);
  const threads  = db.getThreads().slice(0, 5);
  const analytics = db.getAnalytics(null, 7);

  const lines = [
    '# Instagram Hub — live context',
    `Mode: ${instagram.isMock() ? 'MOCK (seeded data)' : 'LIVE (Graph API)'}`,
    '',
    '## Account stats',
    `- Followers: ${stats.followers}`,
    `- Reach (latest): ${stats.reach}`,
    `- Impressions (latest): ${stats.impressions}`,
    `- Engagement rate: ${stats.engagement}%`,
    `- Unread DMs: ${stats.unread}`,
    '',
    '## Recent posts',
    ...posts.map(p => `- [${p.ts.slice(0, 10)}] ${p.like_count} likes, ${p.comments_count} comments — "${(p.caption || '').slice(0, 80)}"`),
    '',
    '## Recent DM threads',
    ...threads.map(t => `- ${t.participant_name} (${t.unread || 0} unread) — last ${t.last_message_at?.slice(0, 16) || '?'}`),
    '',
    '## Analytics (last 7 snapshots)',
    ...analytics.map(a => `- ${a.ts.slice(0, 10)}: followers=${a.followers} reach=${a.reach} impressions=${a.impressions} er=${a.engagement_rate}%`),
    '',
    '---',
    'You are an Instagram analytics assistant. Answer the user\'s question using the context above. Be concise.',
    '',
  ];
  return lines.join('\n');
}

// ── Chat (one global lane) ───────────────────────────────────────────────
let activeChat = null;

function sendChat(userText) {
  // Kill any in-flight chat
  if (activeChat) { try { activeChat.kill('SIGTERM'); } catch {} activeChat = null; }

  const userMsg = { id: uuidv4(), role: 'user', content: userText, ts: new Date().toISOString() };
  db.appendChat(userMsg);
  _broadcast('chat:message', userMsg);

  const assistantId = uuidv4();
  const asstMsg = { id: assistantId, role: 'assistant', content: '', ts: new Date().toISOString(), streaming: true };
  db.appendChat(asstMsg);
  _broadcast('chat:message', asstMsg);

  const prompt = buildContext() + '\n\nUser: ' + userText;
  const proc = spawn(CLAUDE_BIN, claudeArgs(prompt), {
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChat = proc;

  let buf = '';
  proc.stdout.on('data', d => {
    const text = parseStreamLines(d.toString());
    if (text) {
      buf += text;
      db.updateLastChat({ content: buf });
      _broadcast('chat:chunk', { id: assistantId, chunk: text, content: buf });
    }
  });
  proc.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m) console.error('[runner] stderr:', m);
  });
  proc.on('close', code => {
    activeChat = null;
    db.updateLastChat({ content: buf || `[no output — exit ${code}]`, streaming: false });
    _broadcast('chat:done', { id: assistantId, content: buf, exit_code: code });
  });
  proc.on('error', err => {
    activeChat = null;
    const msg = `failed to start claude: ${err.message} (binary: ${CLAUDE_BIN})`;
    db.updateLastChat({ content: msg, streaming: false, error: true });
    _broadcast('chat:done', { id: assistantId, content: msg, exit_code: -1 });
  });

  return assistantId;
}

function stopChat() {
  if (activeChat) { try { activeChat.kill('SIGTERM'); } catch {} activeChat = null; return true; }
  return false;
}

module.exports = { setBroadcast, sendChat, stopChat, CLAUDE_BIN };
