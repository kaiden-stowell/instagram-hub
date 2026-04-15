'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { v4: uuidv4 } = require('uuid');
const db        = require('./db');
const composio  = require('./composio');

// Integration module (mirrors agent-hub/telegram.js pattern).
//
// Modes, chosen at boot based on .env:
//   1. "composio"     — COMPOSIO_API_KEY set → pull via Composio REST tools
//   2. "live"         — INSTAGRAM_TOKEN set  → pull directly from Graph API
//   3. "unconfigured" — neither → dashboard shows empty-state onboarding
//
// No mock/demo data in production mode — if nothing is configured, the
// dashboard stays empty and guides the user to Settings → Composio.

const GRAPH = 'https://graph.instagram.com/v21.0';

let _broadcast = () => {};
let _mode      = 'unconfigured';
let _pollTimer = null;

function setBroadcast(fn) { _broadcast = fn || (() => {}); }
function isConnected()    { return _mode === 'composio' || _mode === 'live'; }
function isMock()         { return false; }
function getMode()        { return _mode; }

// ── Boot ─────────────────────────────────────────────────────────────────
function init() {
  // Always clean up any leftover demo/mock data on boot so upgraded installs
  // don't keep showing fake posts/DMs/analytics from a previous version.
  _clearDemoData();

  if (composio.isEnabled()) {
    _mode = 'composio';
    console.log('[instagram] COMPOSIO mode — pulling via Composio tool API');
    fetchAll().catch(e => console.error('[instagram] initial composio fetch failed:', e.message));
    _pollTimer = setInterval(() => {
      fetchAll().catch(e => console.error('[instagram] composio poll failed:', e.message));
    }, 60_000);
    return;
  }
  if (process.env.INSTAGRAM_TOKEN?.trim()) {
    _mode = 'live';
    console.log('[instagram] LIVE mode — direct Graph API');
    fetchAll().catch(e => console.error('[instagram] initial graph fetch failed:', e.message));
    _pollTimer = setInterval(() => {
      fetchAll().catch(e => console.error('[instagram] graph poll failed:', e.message));
    }, 60_000);
    return;
  }
  _mode = 'unconfigured';
  console.log('[instagram] UNCONFIGURED — set COMPOSIO_API_KEY in Settings to go live');
}

function stop() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

// Wipe any legacy demo-seeded records so upgraded installs start clean.
function _clearDemoData() {
  try { db.deleteAccount('ig-mock-acct'); } catch {}
}

// ── Composio fetchers ────────────────────────────────────────────────────
let _composioIgUserId = null;

async function fetchAll() {
  if (_mode === 'mock') return;
  if (_mode === 'composio') {
    await _composioFetchProfile();
    await _composioFetchMedia();
    await _composioFetchInsights();
    await _composioFetchThreads();
    return;
  }
  // live (direct Graph) — original fetchers
  await _liveFetchAccount();
  await _liveFetchPosts();
  await _liveFetchAnalytics();
}

async function _composioFetchProfile() {
  const r = await composio.execute('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me' });
  // Composio returns Graph API response at r.data (or r itself depending on shape)
  const profile = r?.data || r || {};
  const id = profile.id || 'composio-me';
  _composioIgUserId = id;

  const acct = {
    id,
    username: profile.username || 'me',
    name: profile.name || profile.username || '',
    followers: profile.followers_count ?? 0,
    following: profile.follows_count ?? 0,
    media_count: profile.media_count ?? 0,
    biography: profile.biography || '',
    profile_picture_url: profile.profile_picture_url || '',
    connected_at: new Date().toISOString(),
  };
  db.upsertAccount(acct);
  _broadcast('account:updated', acct);
  return acct;
}

async function _composioFetchMedia() {
  if (!_composioIgUserId) return;
  const r = await composio.execute('INSTAGRAM_GET_IG_USER_MEDIA', {
    ig_user_id: _composioIgUserId,
    limit: 30,
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
  });
  const items = r?.data?.data || r?.data || [];
  for (const m of items) {
    const post = {
      id: m.id,
      account_id: _composioIgUserId,
      caption: m.caption || '',
      media_url: m.media_url || m.thumbnail_url || '',
      permalink: m.permalink || '',
      like_count: m.like_count || 0,
      comments_count: m.comments_count || 0,
      media_type: m.media_type || '',
      ts: m.timestamp || new Date().toISOString(),
    };
    db.upsertPost(post);
  }
  _broadcast('post:updated', { count: items.length });
}

async function _composioFetchInsights() {
  if (!_composioIgUserId) return;
  const now = Math.floor(Date.now() / 1000);
  const since = now - 30 * 86400;
  try {
    const r = await composio.execute('INSTAGRAM_GET_USER_INSIGHTS', {
      ig_user_id: _composioIgUserId,
      metric: ['reach', 'follower_count', 'accounts_engaged', 'total_interactions', 'views'],
      period: 'day',
      since,
      until: now,
    });
    const series = r?.data?.data || r?.data || [];
    // Walk each metric's time series and create one snapshot per day
    // (dedupe by date — last write wins)
    const byDate = new Map();
    for (const metric of series) {
      const name = metric.name;
      for (const pt of (metric.values || [])) {
        const date = (pt.end_time || '').slice(0, 10);
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, { date, ts: pt.end_time });
        byDate.get(date)[name] = pt.value;
      }
    }
    for (const [date, row] of byDate) {
      db.insertAnalytics({
        id: uuidv4(),
        account_id: _composioIgUserId,
        ts: row.ts || date,
        followers: row.follower_count ?? db.getAccount(_composioIgUserId)?.followers ?? 0,
        reach: row.reach ?? 0,
        impressions: row.views ?? 0,
        profile_views: 0,
        engagement_rate: row.accounts_engaged && row.reach
          ? +((row.accounts_engaged / row.reach) * 100).toFixed(2) : 0,
      });
    }
    _broadcast('analytics:updated', { snapshots: byDate.size });
  } catch (e) {
    console.error('[instagram] insights fetch failed:', e.message);
  }
}

async function _composioFetchThreads() {
  try {
    const r = await composio.execute('INSTAGRAM_LIST_ALL_CONVERSATIONS', { limit: 25 });
    const threads = r?.data?.data || r?.data || [];
    for (const t of threads) {
      const threadId = t.id;
      // Try to fetch recent messages for this thread
      let participantName = 'Instagram user';
      try {
        const mr = await composio.execute('INSTAGRAM_LIST_ALL_MESSAGES', {
          conversation_id: threadId,
          limit: 20,
        });
        const msgs = mr?.data?.data || mr?.data || [];
        // Newest first from API — reverse for chronological order
        const ordered = msgs.slice().reverse();

        // Use first non-me sender as participant name
        const other = ordered.find(m => m.from && m.from.username && m.from.username !== 'me');
        if (other?.from?.username) participantName = other.from.username;

        db.upsertThread({
          id: threadId,
          account_id: _composioIgUserId || 'composio-me',
          participant: other?.from?.id || 'unknown',
          participant_name: participantName,
          unread: 0,
          last_message_at: ordered[ordered.length - 1]?.created_time || t.updated_time || new Date().toISOString(),
        });

        // Append any messages we haven't stored yet
        const existing = new Set(db.getMessages(threadId).map(m => m.id));
        for (const m of ordered) {
          if (existing.has(m.id)) continue;
          db.appendMessage({
            id: m.id,
            thread_id: threadId,
            from: m.from?.username || m.from?.id || 'unknown',
            text: m.message || '',
            ts: m.created_time || new Date().toISOString(),
            outbound: Boolean(m.from?.username === db.getAccount(_composioIgUserId)?.username),
          });
        }
      } catch (e) {
        // Some conversations return 400 — just register the thread shell
        db.upsertThread({
          id: threadId,
          account_id: _composioIgUserId || 'composio-me',
          participant: 'unknown',
          participant_name: 'Instagram user',
          unread: 0,
          last_message_at: t.updated_time || new Date().toISOString(),
        });
      }
    }
    _broadcast('threads:updated', { count: threads.length });
  } catch (e) {
    console.error('[instagram] threads fetch failed:', e.message);
  }
}

// ── Direct-Graph fetchers (LIVE mode) ───────────────────────────────────
async function _liveFetchAccount() {
  const token = process.env.INSTAGRAM_TOKEN;
  const bid = process.env.INSTAGRAM_BUSINESS_ID;
  const url = `${GRAPH}/${bid}?fields=id,username,name,followers_count,follows_count,media_count&access_token=${token}`;
  const r = await _get(url);
  const acct = {
    id: r.id, username: r.username, name: r.name,
    followers: r.followers_count, following: r.follows_count,
    media_count: r.media_count, connected_at: new Date().toISOString(),
  };
  db.upsertAccount(acct);
  _broadcast('account:updated', acct);
}

async function _liveFetchPosts() {
  const token = process.env.INSTAGRAM_TOKEN;
  const bid = process.env.INSTAGRAM_BUSINESS_ID;
  const url = `${GRAPH}/${bid}/media?fields=id,caption,media_url,permalink,like_count,comments_count,timestamp&access_token=${token}`;
  const r = await _get(url);
  for (const m of r.data || []) {
    db.upsertPost({
      id: m.id, account_id: bid,
      caption: m.caption || '', media_url: m.media_url, permalink: m.permalink,
      like_count: m.like_count || 0, comments_count: m.comments_count || 0, ts: m.timestamp,
    });
  }
}

async function _liveFetchAnalytics() {
  const token = process.env.INSTAGRAM_TOKEN;
  const bid = process.env.INSTAGRAM_BUSINESS_ID;
  const url = `${GRAPH}/${bid}/insights?metric=reach,follower_count,accounts_engaged&period=day&access_token=${token}`;
  const r = await _get(url);
  const snap = {
    id: uuidv4(), account_id: bid, ts: new Date().toISOString(),
    followers: _latest(r, 'follower_count'), reach: _latest(r, 'reach'),
    impressions: 0, profile_views: 0, engagement_rate: 0,
  };
  db.insertAnalytics(snap);
  _broadcast('analytics:updated', snap);
}

function _latest(resp, metric) {
  const m = (resp.data || []).find(x => x.name === metric);
  return m?.values?.slice(-1)[0]?.value ?? 0;
}

// ── Send DM ─────────────────────────────────────────────────────────────
async function sendDirectMessage(threadId, text) {
  const thread = db.getThread(threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);

  const msg = {
    id: uuidv4(), thread_id: threadId, from: 'me',
    text, ts: new Date().toISOString(), outbound: true,
  };

  if (_mode === 'composio') {
    try {
      await composio.execute('INSTAGRAM_SEND_TEXT_MESSAGE', {
        recipient_id: thread.participant,
        text,
      });
    } catch (e) {
      console.error('[instagram] composio send failed:', e.message);
      throw e;
    }
  }
  // mock + live: record locally, nothing else

  db.appendMessage(msg);
  _broadcast('dm:message', msg);
  return msg;
}

// ── HTTP helper ─────────────────────────────────────────────────────────
function _get(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      r.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  init, stop, setBroadcast, isConnected, isMock, getMode,
  fetchAll, sendDirectMessage,
};
