'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'db.json');
const DB_BACKUP = path.join(DATA_DIR, 'db.backup.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function blankState() {
  return {
    accounts: [],           // { id, username, name, followers, following, media_count, connected_at }
    threads:  [],           // { id, account_id, participant, participant_name, unread, last_message_at }
    messages: [],           // { id, thread_id, from, text, ts, outbound }
    posts:    [],           // { id, account_id, caption, media_url, permalink, like_count, comments_count, ts }
    analytics:[],           // { id, account_id, ts, followers, reach, impressions, profile_views, engagement_rate }
    chats:    [],           // Claude Code chat history { id, role, content, ts }
    runs:     [],           // Claude Code run history { id, prompt, output, status, started_at, finished_at }
  };
}

function load() {
  for (const file of [DB_FILE, DB_BACKUP]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) continue;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') continue;
      const blank = blankState();
      for (const k of Object.keys(blank)) if (!d[k]) d[k] = blank[k];
      if (file === DB_BACKUP) {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); } catch {}
      }
      return d;
    } catch (e) {
      console.error(`[db] failed to load ${file}: ${e.message}`);
    }
  }
  return blankState();
}

function save(data) {
  const json = JSON.stringify(data, null, 2);
  try { if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BACKUP); } catch {}
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_FILE);
}

// ── Accounts ──────────────────────────────────────────────────────────────
function getAccounts()        { return load().accounts; }
function getAccount(id)       { return load().accounts.find(a => a.id === id) || null; }
function upsertAccount(acct)  {
  const d = load();
  const i = d.accounts.findIndex(a => a.id === acct.id);
  if (i === -1) d.accounts.push(acct);
  else d.accounts[i] = { ...d.accounts[i], ...acct };
  save(d);
  return acct;
}
function deleteAccount(id) {
  const d = load();
  d.accounts  = d.accounts.filter(a => a.id !== id);
  d.threads   = d.threads.filter(t => t.account_id !== id);
  d.posts     = d.posts.filter(p => p.account_id !== id);
  d.analytics = d.analytics.filter(a => a.account_id !== id);
  save(d);
}

// ── Threads / DMs ─────────────────────────────────────────────────────────
function getThreads(accountId) {
  const d = load();
  let t = d.threads;
  if (accountId) t = t.filter(x => x.account_id === accountId);
  return t.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
}
function getThread(id) { return load().threads.find(t => t.id === id) || null; }
function upsertThread(thread) {
  const d = load();
  const i = d.threads.findIndex(t => t.id === thread.id);
  if (i === -1) d.threads.push(thread);
  else d.threads[i] = { ...d.threads[i], ...thread };
  save(d);
}
function getMessages(threadId) {
  return load().messages.filter(m => m.thread_id === threadId).sort((a, b) => a.ts.localeCompare(b.ts));
}
function appendMessage(msg) {
  const d = load();
  d.messages.push(msg);
  const t = d.threads.find(x => x.id === msg.thread_id);
  if (t) {
    t.last_message_at = msg.ts;
    if (!msg.outbound) t.unread = (t.unread || 0) + 1;
  }
  save(d);
}
function markThreadRead(threadId) {
  const d = load();
  const t = d.threads.find(x => x.id === threadId);
  if (t) { t.unread = 0; save(d); }
}

// ── Posts ─────────────────────────────────────────────────────────────────
function getPosts(accountId) {
  let p = load().posts;
  if (accountId) p = p.filter(x => x.account_id === accountId);
  return p.sort((a, b) => b.ts.localeCompare(a.ts));
}
function upsertPost(post) {
  const d = load();
  const i = d.posts.findIndex(p => p.id === post.id);
  if (i === -1) d.posts.push(post);
  else d.posts[i] = { ...d.posts[i], ...post };
  save(d);
}

// ── Analytics ─────────────────────────────────────────────────────────────
function getAnalytics(accountId, limit = 30) {
  let a = load().analytics;
  if (accountId) a = a.filter(x => x.account_id === accountId);
  return a.sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, limit);
}
function insertAnalytics(snap) { const d = load(); d.analytics.push(snap); save(d); }

// ── Claude Code chat ──────────────────────────────────────────────────────
function getChats()        { return load().chats; }
function appendChat(msg)   { const d = load(); d.chats.push(msg); save(d); }
function updateLastChat(patch) {
  const d = load();
  if (!d.chats.length) return;
  d.chats[d.chats.length - 1] = { ...d.chats[d.chats.length - 1], ...patch };
  save(d);
}
function clearChats()      { const d = load(); d.chats = []; save(d); }

// ── Runs ──────────────────────────────────────────────────────────────────
function getRuns(limit = 50) {
  return load().runs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}
function insertRun(run)         { const d = load(); d.runs.push(run); save(d); }
function updateRun(id, patch) {
  const d = load();
  const i = d.runs.findIndex(r => r.id === id);
  if (i === -1) return null;
  d.runs[i] = { ...d.runs[i], ...patch };
  save(d);
  return d.runs[i];
}

// ── Stats ─────────────────────────────────────────────────────────────────
function getStats(accountId) {
  const d = load();
  const accounts = accountId ? d.accounts.filter(a => a.id === accountId) : d.accounts;
  const threads  = accountId ? d.threads.filter(t => t.account_id === accountId) : d.threads;
  const posts    = accountId ? d.posts.filter(p => p.account_id === accountId) : d.posts;
  const latest   = getAnalytics(accountId, 1)[0] || null;
  return {
    accounts: accounts.length,
    threads:  threads.length,
    unread:   threads.reduce((n, t) => n + (t.unread || 0), 0),
    posts:    posts.length,
    followers: latest?.followers ?? accounts[0]?.followers ?? 0,
    reach:    latest?.reach ?? 0,
    impressions: latest?.impressions ?? 0,
    engagement: latest?.engagement_rate ?? 0,
  };
}

module.exports = {
  getAccounts, getAccount, upsertAccount, deleteAccount,
  getThreads, getThread, upsertThread, getMessages, appendMessage, markThreadRead,
  getPosts, upsertPost,
  getAnalytics, insertAnalytics,
  getChats, appendChat, updateLastChat, clearChats,
  getRuns, insertRun, updateRun,
  getStats,
};
