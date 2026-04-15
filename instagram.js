'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// Mirrors the integration-module shape from agent-hub (telegram.js / imessage.js):
//   init, setBroadcast, isConnected, fetchAll, sendDirectMessage, stop
//
// When INSTAGRAM_TOKEN is blank we operate in MOCK mode — we seed a fake account,
// threads, messages, posts, and analytics so the dashboard is usable end-to-end
// without a Meta developer app. Swap out _mockFetch* for real Graph API calls
// once credentials are available.

const GRAPH = 'https://graph.instagram.com/v21.0';

let _broadcast = () => {};
let _token     = null;
let _businessId = null;
let _pollTimer = null;
let _mockTimer = null;

function setBroadcast(fn) { _broadcast = fn || (() => {}); }
function isConnected()    { return Boolean(_token) || isMock(); }
function isMock()         { return !process.env.INSTAGRAM_TOKEN?.trim(); }

// ── Startup ──────────────────────────────────────────────────────────────
function init() {
  _token      = process.env.INSTAGRAM_TOKEN?.trim() || null;
  _businessId = process.env.INSTAGRAM_BUSINESS_ID?.trim() || null;

  if (isMock()) {
    console.log('[instagram] MOCK mode — seeding fake data. Set INSTAGRAM_TOKEN in .env for live mode.');
    _seedMock();
    // Simulate new DMs and analytics every 20s
    _mockTimer = setInterval(_mockTick, 20000);
    return;
  }

  console.log('[instagram] live mode');
  fetchAll().catch(e => console.error('[instagram] initial fetch failed:', e.message));
  _pollTimer = setInterval(() => {
    fetchAll().catch(e => console.error('[instagram] poll failed:', e.message));
  }, 60_000);
}

function stop() {
  if (_pollTimer) clearInterval(_pollTimer);
  if (_mockTimer) clearInterval(_mockTimer);
  _pollTimer = null;
  _mockTimer = null;
}

// ── Public fetchers ──────────────────────────────────────────────────────
async function fetchAll() {
  if (isMock()) return; // mock seeds itself
  await fetchAccount();
  await fetchPosts();
  await fetchThreads();
  await fetchAnalytics();
}

async function fetchAccount() {
  if (isMock()) return db.getAccounts()[0];
  const url = `${GRAPH}/${_businessId}?fields=id,username,name,followers_count,follows_count,media_count&access_token=${_token}`;
  const r = await _get(url);
  const acct = {
    id: r.id,
    username: r.username,
    name: r.name,
    followers: r.followers_count,
    following: r.follows_count,
    media_count: r.media_count,
    connected_at: new Date().toISOString(),
  };
  db.upsertAccount(acct);
  _broadcast('account:updated', acct);
  return acct;
}

async function fetchPosts() {
  if (isMock()) return;
  const url = `${GRAPH}/${_businessId}/media?fields=id,caption,media_url,permalink,like_count,comments_count,timestamp&access_token=${_token}`;
  const r = await _get(url);
  for (const m of r.data || []) {
    const post = {
      id: m.id,
      account_id: _businessId,
      caption: m.caption || '',
      media_url: m.media_url,
      permalink: m.permalink,
      like_count: m.like_count || 0,
      comments_count: m.comments_count || 0,
      ts: m.timestamp,
    };
    db.upsertPost(post);
    _broadcast('post:updated', post);
  }
}

async function fetchThreads() {
  if (isMock()) return;
  // Instagram Messaging API — requires Page-scoped token + instagram_manage_messages
  // Left as a stub — wire up conversations endpoint once permissions are approved.
}

async function fetchAnalytics() {
  if (isMock()) return;
  const metrics = 'reach,impressions,profile_views,follower_count';
  const url = `${GRAPH}/${_businessId}/insights?metric=${metrics}&period=day&access_token=${_token}`;
  const r = await _get(url);
  const snap = {
    id: uuidv4(),
    account_id: _businessId,
    ts: new Date().toISOString(),
    followers: _latest(r, 'follower_count'),
    reach: _latest(r, 'reach'),
    impressions: _latest(r, 'impressions'),
    profile_views: _latest(r, 'profile_views'),
    engagement_rate: 0,
  };
  db.insertAnalytics(snap);
  _broadcast('analytics:updated', snap);
}

function _latest(resp, metric) {
  const m = (resp.data || []).find(x => x.name === metric);
  return m?.values?.slice(-1)[0]?.value ?? 0;
}

// ── Send ────────────────────────────────────────────────────────────────
async function sendDirectMessage(threadId, text) {
  const thread = db.getThread(threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);
  const msg = {
    id: uuidv4(),
    thread_id: threadId,
    from: 'me',
    text,
    ts: new Date().toISOString(),
    outbound: true,
  };
  db.appendMessage(msg);
  _broadcast('dm:message', msg);

  if (isMock()) return msg;

  // Real send — Graph API Send message endpoint (requires page access token)
  // const url = `${GRAPH}/me/messages?access_token=${_token}`;
  // await _post(url, { recipient: { id: thread.participant }, message: { text } });
  return msg;
}

// ── HTTP helpers ────────────────────────────────────────────────────────
function _get(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      r.on('error', reject);
    }).on('error', reject);
  });
}

// ── Mock data ───────────────────────────────────────────────────────────
const MOCK_ACCOUNT_ID = 'ig-mock-acct';
const MOCK_NAMES = ['Maya Chen', 'Jordan Rivers', 'Sam Patel', 'Alex Kim', 'Riley Novak', 'Taylor Ford'];
const MOCK_DM_TEXTS = [
  'heyy love your last post 🔥',
  'is this collab still open?',
  'where did you get that jacket??',
  'can we do a shoot next week?',
  'just followed you back 👋',
  'brand partnership opportunity — DM for details',
];
const MOCK_CAPTIONS = [
  'golden hour hits different ✨',
  'new drop dropping tomorrow 👀',
  'behind the scenes of today\'s shoot',
  'thank you for 10k 🙏',
  'weekend mood',
  'studio day',
];

function _rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function _seedMock() {
  if (db.getAccounts().length) return; // already seeded

  const now = Date.now();
  db.upsertAccount({
    id: MOCK_ACCOUNT_ID,
    username: 'your_brand',
    name: 'Your Brand',
    followers: 10432,
    following: 287,
    media_count: 42,
    connected_at: new Date().toISOString(),
  });

  // Threads + messages
  for (let i = 0; i < 6; i++) {
    const threadId = `thread-${i}`;
    const name = MOCK_NAMES[i];
    db.upsertThread({
      id: threadId,
      account_id: MOCK_ACCOUNT_ID,
      participant: `user_${i}`,
      participant_name: name,
      unread: i < 2 ? 1 : 0,
      last_message_at: new Date(now - i * 3600_000).toISOString(),
    });
    for (let j = 0; j < 3; j++) {
      db.appendMessage({
        id: uuidv4(),
        thread_id: threadId,
        from: j % 2 === 0 ? `user_${i}` : 'me',
        text: j % 2 === 0 ? _rand(MOCK_DM_TEXTS) : 'thanks for reaching out!',
        ts: new Date(now - (i * 3600_000) - ((2 - j) * 60_000)).toISOString(),
        outbound: j % 2 === 1,
      });
    }
  }

  // Posts
  for (let i = 0; i < 8; i++) {
    db.upsertPost({
      id: `post-${i}`,
      account_id: MOCK_ACCOUNT_ID,
      caption: MOCK_CAPTIONS[i % MOCK_CAPTIONS.length],
      media_url: `https://picsum.photos/seed/ig${i}/600/600`,
      permalink: `https://instagram.com/p/mock${i}`,
      like_count: Math.floor(200 + Math.random() * 1800),
      comments_count: Math.floor(5 + Math.random() * 120),
      ts: new Date(now - i * 86400_000).toISOString(),
    });
  }

  // Analytics — last 14 days
  let followers = 10000;
  for (let i = 13; i >= 0; i--) {
    followers += Math.floor(Math.random() * 80 - 10);
    db.insertAnalytics({
      id: uuidv4(),
      account_id: MOCK_ACCOUNT_ID,
      ts: new Date(now - i * 86400_000).toISOString(),
      followers,
      reach: Math.floor(3000 + Math.random() * 5000),
      impressions: Math.floor(5000 + Math.random() * 9000),
      profile_views: Math.floor(150 + Math.random() * 400),
      engagement_rate: +(3 + Math.random() * 4).toFixed(2),
    });
  }
}

function _mockTick() {
  // 40% chance: new inbound DM on a random thread
  if (Math.random() < 0.4) {
    const threads = db.getThreads(MOCK_ACCOUNT_ID);
    if (threads.length) {
      const t = threads[Math.floor(Math.random() * threads.length)];
      const msg = {
        id: uuidv4(),
        thread_id: t.id,
        from: t.participant,
        text: _rand(MOCK_DM_TEXTS),
        ts: new Date().toISOString(),
        outbound: false,
      };
      db.appendMessage(msg);
      _broadcast('dm:message', msg);
    }
  }
  // 20% chance: new analytics snapshot
  if (Math.random() < 0.2) {
    const last = db.getAnalytics(MOCK_ACCOUNT_ID, 1)[0];
    const snap = {
      id: uuidv4(),
      account_id: MOCK_ACCOUNT_ID,
      ts: new Date().toISOString(),
      followers: (last?.followers || 10000) + Math.floor(Math.random() * 30 - 5),
      reach: Math.floor(3000 + Math.random() * 5000),
      impressions: Math.floor(5000 + Math.random() * 9000),
      profile_views: Math.floor(150 + Math.random() * 400),
      engagement_rate: +(3 + Math.random() * 4).toFixed(2),
    };
    db.insertAnalytics(snap);
    _broadcast('analytics:updated', snap);
  }
}

module.exports = {
  init, stop, setBroadcast, isConnected, isMock,
  fetchAll, fetchAccount, fetchPosts, fetchThreads, fetchAnalytics,
  sendDirectMessage,
};
