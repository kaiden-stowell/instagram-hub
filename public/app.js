'use strict';
// Instagram Hub — frontend
// Vanilla JS, same style as agent-hub/public/app.js

const state = {
  view: 'overview',
  stats: {},
  account: null,
  threads: [],
  activeThreadId: null,
  messages: [],
  posts: [],
  analytics: [],
  chats: [],
  mock: false,
};

// ── Fetch helper ─────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}
const GET  = (u)   => api('GET',  u);
const POST = (u, b) => api('POST', u, b);
const DEL  = (u)   => api('DELETE', u);

// ── Routing ─────────────────────────────────────────────────────────────
function showView(name) {
  state.view = name;
  document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  document.querySelectorAll('.view').forEach(el => el.hidden = el.dataset.view !== name);
  if (name === 'overview')  loadOverview();
  if (name === 'dms')       loadDms();
  if (name === 'posts')     loadPosts();
  if (name === 'analytics') loadAnalytics();
  if (name === 'chat')      loadChat();
  if (name === 'settings')  loadSettings();
}

document.querySelectorAll('.nav-link').forEach(el => {
  el.addEventListener('click', () => showView(el.dataset.view));
});

// ── Overview ────────────────────────────────────────────────────────────
async function loadOverview() {
  const [stats, accounts, posts] = await Promise.all([GET('/api/stats'), GET('/api/accounts'), GET('/api/posts')]);
  state.stats = stats;
  state.account = accounts[0] || null;
  renderStats(stats);
  renderAccount(state.account);
  renderOverviewPosts(posts.slice(0, 6));
  renderEmptyStateIfNeeded(accounts.length === 0);
}

function renderEmptyStateIfNeeded(empty) {
  const host = document.querySelector('.view[data-view="overview"]');
  const existing = host.querySelector('.empty-state');
  if (!empty) { if (existing) existing.remove(); return; }
  if (existing) return;
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-title">No Instagram account connected</div>
    <div class="empty-sub">Connect your Instagram Business or Creator account via Composio to start pulling DMs, posts, and analytics.</div>
    <button class="btn" id="btn-go-settings">Open Settings →</button>`;
  host.prepend(el);
  el.querySelector('#btn-go-settings').addEventListener('click', () => showView('settings'));
}

function renderStats(s) {
  document.getElementById('s-followers').textContent = (s.followers || 0).toLocaleString();
  document.getElementById('s-reach').textContent = (s.reach || 0).toLocaleString();
  document.getElementById('s-impressions').textContent = (s.impressions || 0).toLocaleString();
  document.getElementById('s-engagement').textContent = (s.engagement || 0) + '%';
  document.getElementById('s-posts').textContent = s.posts || 0;
  document.getElementById('s-unread').textContent = s.unread || 0;
  const badge = document.getElementById('dm-badge');
  if (s.unread > 0) { badge.hidden = false; badge.textContent = s.unread; }
  else badge.hidden = true;
}

function renderAccount(a) {
  const el = document.getElementById('account-card');
  if (!a) { el.textContent = 'No account connected.'; return; }
  el.innerHTML = `
    <div class="username">@${escape(a.username)}</div>
    <div class="name">${escape(a.name || '')}</div>
    <div class="meta">
      <span><strong>${(a.followers || 0).toLocaleString()}</strong> followers</span>
      <span><strong>${(a.following || 0).toLocaleString()}</strong> following</span>
      <span><strong>${a.media_count || 0}</strong> posts</span>
    </div>`;
}

function renderOverviewPosts(posts) {
  const el = document.getElementById('overview-posts');
  el.innerHTML = posts.map(postCardHtml).join('');
}

// ── Posts ───────────────────────────────────────────────────────────────
async function loadPosts() {
  state.posts = await GET('/api/posts');
  document.getElementById('post-grid').innerHTML = state.posts.map(postCardHtml).join('');
}

function postCardHtml(p) {
  return `
    <div class="post">
      <img src="${escape(p.media_url || '')}" alt="" loading="lazy" />
      <div class="post-body">
        <div class="post-caption">${escape(p.caption || '')}</div>
        <div class="post-meta">
          <span>♥ <strong>${(p.like_count || 0).toLocaleString()}</strong></span>
          <span>💬 <strong>${(p.comments_count || 0).toLocaleString()}</strong></span>
          <span>${(p.ts || '').slice(0, 10)}</span>
        </div>
      </div>
    </div>`;
}

// ── DMs ─────────────────────────────────────────────────────────────────
async function loadDms() {
  state.threads = await GET('/api/threads');
  renderThreadList();
  if (state.activeThreadId) openThread(state.activeThreadId);
}

function renderThreadList() {
  const el = document.getElementById('thread-list');
  if (!state.threads.length) { el.innerHTML = '<div style="padding:20px;color:var(--text-dim)">No conversations</div>'; return; }
  el.innerHTML = state.threads.map(t => `
    <div class="thread-item ${t.id === state.activeThreadId ? 'active' : ''}" data-id="${t.id}">
      <div class="name">
        ${escape(t.participant_name)}
        ${t.unread ? '<span class="dot"></span>' : ''}
      </div>
      <div class="preview">${(t.last_message_at || '').replace('T', ' ').slice(0, 16)}</div>
    </div>`).join('');
  el.querySelectorAll('.thread-item').forEach(el => {
    el.addEventListener('click', () => openThread(el.dataset.id));
  });
}

async function openThread(id) {
  state.activeThreadId = id;
  renderThreadList();
  const { thread, messages } = await GET(`/api/threads/${id}`);
  state.messages = messages;
  document.getElementById('thread-header').textContent = thread.participant_name;
  renderMessages();
  const input = document.getElementById('composer-input');
  const btn   = document.querySelector('#composer button');
  input.disabled = false; btn.disabled = false;
  input.focus();
  if (thread.unread) { await POST(`/api/threads/${id}/read`); }
}

function renderMessages() {
  const el = document.getElementById('messages');
  el.innerHTML = state.messages.map(m => `
    <div class="msg ${m.outbound ? 'out' : 'in'}">
      ${escape(m.text)}
      <div class="ts">${(m.ts || '').slice(11, 16)}</div>
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

document.getElementById('composer').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('composer-input');
  const text = input.value.trim();
  if (!text || !state.activeThreadId) return;
  input.value = '';
  await POST(`/api/threads/${state.activeThreadId}/send`, { text });
  openThread(state.activeThreadId);
});

// ── Analytics ───────────────────────────────────────────────────────────
async function loadAnalytics() {
  state.analytics = (await GET('/api/analytics?limit=14')).reverse();
  const latest = state.analytics[state.analytics.length - 1] || {};
  const el = document.getElementById('analytics-stats');
  el.innerHTML = `
    <div class="stat"><div class="stat-label">Followers</div><div class="stat-value">${(latest.followers || 0).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Reach</div><div class="stat-value">${(latest.reach || 0).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Impressions</div><div class="stat-value">${(latest.impressions || 0).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Profile views</div><div class="stat-value">${(latest.profile_views || 0).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Engagement</div><div class="stat-value">${latest.engagement_rate || 0}%</div></div>`;

  renderBars('chart-followers', state.analytics.map(a => a.followers));
  renderBars('chart-reach', state.analytics.map(a => a.reach), state.analytics.map(a => a.impressions));

  const table = document.getElementById('analytics-table');
  table.innerHTML = `
    <thead><tr><th>Date</th><th>Followers</th><th>Reach</th><th>Impressions</th><th>Profile views</th><th>ER</th></tr></thead>
    <tbody>${state.analytics.slice().reverse().map(a => `
      <tr>
        <td>${(a.ts || '').slice(0, 10)}</td>
        <td>${(a.followers || 0).toLocaleString()}</td>
        <td>${(a.reach || 0).toLocaleString()}</td>
        <td>${(a.impressions || 0).toLocaleString()}</td>
        <td>${(a.profile_views || 0).toLocaleString()}</td>
        <td>${a.engagement_rate || 0}%</td>
      </tr>`).join('')}</tbody>`;
}

function renderBars(id, values, overlay) {
  const el = document.getElementById(id);
  const max = Math.max(...values, ...(overlay || []), 1);
  el.innerHTML = values.map((v, i) => {
    const h1 = (v / max * 100).toFixed(1);
    const bars = [`<div class="bar" style="height:${h1}%" data-value="${v.toLocaleString()}"></div>`];
    if (overlay) {
      const h2 = (overlay[i] / max * 100).toFixed(1);
      bars.push(`<div class="bar b" style="height:${h2}%" data-value="${overlay[i].toLocaleString()}"></div>`);
    }
    return bars.join('');
  }).join('');
}

// ── Chat ───────────────────────────────────────────────────────────────
async function loadChat() {
  state.chats = await GET('/api/chat');
  renderChat();
}

function renderChat() {
  const el = document.getElementById('chat');
  if (!state.chats.length) {
    el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:40px">Ask about your account, posts, DMs, or analytics…</div>';
    return;
  }
  el.innerHTML = state.chats.map(m => `
    <div class="chat-msg ${m.role}">
      <div class="role">${m.role}</div>
      <div class="body ${m.streaming ? 'streaming' : ''}">${escape(m.content || '')}</div>
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

document.getElementById('chat-composer').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await POST('/api/chat', { text });
});

document.getElementById('btn-clear-chat').addEventListener('click', async () => {
  if (!confirm('Clear chat history?')) return;
  await DEL('/api/chat');
  state.chats = [];
  renderChat();
});

// ── Settings / Composio ────────────────────────────────────────────────
async function loadSettings() {
  const s = await GET('/api/settings/composio');
  const pill   = document.getElementById('composio-pill');
  const keyIn  = document.getElementById('composio-key');
  const userIn = document.getElementById('composio-user');
  const disc   = document.getElementById('btn-disconnect-composio');
  const connect = document.getElementById('btn-connect-ig');
  const refresh = document.getElementById('btn-refresh-ig');
  const igStatus = document.getElementById('ig-status');

  userIn.value = s.userId || 'default';

  if (s.configured) {
    pill.textContent = 'KEY SET'; pill.className = 'pill ok';
    keyIn.placeholder = s.keyMasked || 'ck_••••';
    disc.hidden = false;
    connect.disabled = false;
    refresh.disabled = false;
  } else {
    pill.textContent = 'NOT CONFIGURED'; pill.className = 'pill warn';
    keyIn.placeholder = 'ck_...';
    disc.hidden = true;
    connect.disabled = true;
    refresh.disabled = true;
  }

  if (!s.configured) {
    igStatus.innerHTML = '<span class="pill warn">Save a Composio API key to continue.</span>';
  } else if (s.instagramConnected) {
    const c = s.connections[0] || {};
    igStatus.innerHTML = `<span class="pill ok">CONNECTED</span> <span style="color:var(--text-dim);font-size:12px;margin-left:8px">Mode: <strong style="color:var(--text)">${(s.mode || '').toUpperCase()}</strong></span>`;
  } else {
    igStatus.innerHTML = '<span class="pill warn">NO INSTAGRAM LINKED</span> <span style="color:var(--text-dim);font-size:12px;margin-left:8px">Click Connect Instagram below.</span>';
  }

  if (s.error) {
    igStatus.innerHTML += `<div class="help" style="color:var(--err);margin-top:8px">${escape(s.error)}</div>`;
  }
}

document.getElementById('btn-save-composio').addEventListener('click', async () => {
  const apiKey = document.getElementById('composio-key').value.trim();
  const userId = document.getElementById('composio-user').value.trim() || 'default';
  if (!apiKey) { alert('Paste your Composio API key first.'); return; }
  if (!apiKey.startsWith('ck_')) {
    if (!confirm('That doesn\'t look like a Composio client key (expected ck_...). Save anyway?')) return;
  }
  try {
    const r = await POST('/api/settings/composio', { apiKey, userId });
    document.getElementById('composio-key').value = '';
    document.getElementById('mode-badge').textContent = (r.mode || 'mock').toUpperCase() + ' MODE';
    showBanner('ok', `Composio key saved — mode: ${r.mode.toUpperCase()}`);
    setTimeout(clearBanner, 2500);
    loadSettings();
  } catch (e) { alert('Save failed: ' + e.message); }
});

document.getElementById('btn-disconnect-composio').addEventListener('click', async () => {
  if (!confirm('Remove the Composio API key? The dashboard will fall back to mock mode.')) return;
  await DEL('/api/settings/composio');
  loadSettings();
});

document.getElementById('btn-connect-ig').addEventListener('click', async () => {
  const btn = document.getElementById('btn-connect-ig');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/settings/composio/connect-instagram', { method: 'POST' });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body.redirect_url) {
      window.open(body.redirect_url, '_blank', 'noopener');
      const label = body.source === 'rest' ? 'Instagram' : 'Composio';
      showBanner('info', `Complete the ${label} login in the new tab, then come back and click Refresh now.`);
      setTimeout(clearBanner, 8000);
    } else {
      const msg = body.error || 'Could not generate a connect link.';
      const useFallback = body.fallback_url &&
        confirm(`${msg}\n\nOpen the generic Composio connect page as a fallback?`);
      if (useFallback) window.open(body.fallback_url, '_blank', 'noopener');
      else alert(msg);
    }
  } catch (e) { alert('Connect failed: ' + e.message); }
  btn.disabled = false;
});

document.getElementById('btn-refresh-ig').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-ig');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await POST('/api/settings/composio/refresh');
    showBanner('ok', 'Pulled latest data from Composio.');
    setTimeout(clearBanner, 2000);
    loadSettings();
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = 'Refresh now';
});

// ── Refresh button ─────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', async () => {
  try { await POST('/api/refresh'); } catch {}
  loadOverview();
});

// ── WebSocket ──────────────────────────────────────────────────────────
let ws = null;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen  = () => setConn('ok', 'live');
  ws.onclose = () => { setConn('err', 'disconnected'); setTimeout(connectWs, 2000); };
  ws.onerror = () => setConn('err', 'error');
  ws.onmessage = e => {
    try { handleWs(JSON.parse(e.data)); } catch {}
  };
}

function setConn(cls, text) {
  const el = document.getElementById('conn');
  el.className = 'conn ' + cls;
  el.textContent = text;
}

function handleWs({ event, data }) {
  if (event === 'hello') {
    state.mock = data.mode === 'mock';
    document.getElementById('mode-badge').textContent = modeLabel(data.mode);
  }
  if (event === 'dm:message') {
    if (state.view === 'dms') loadDms();
    if (state.view === 'overview') loadOverview();
  }
  if (event === 'analytics:updated') {
    if (state.view === 'overview')  loadOverview();
    if (state.view === 'analytics') loadAnalytics();
  }
  if (event === 'post:updated' || event === 'account:updated') {
    if (state.view === 'overview') loadOverview();
    if (state.view === 'posts')    loadPosts();
  }
  if (event === 'chat:message') {
    state.chats.push(data);
    if (state.view === 'chat') renderChat();
  }
  if (event === 'chat:chunk') {
    const last = state.chats[state.chats.length - 1];
    if (last && last.id === data.id) { last.content = data.content; }
    if (state.view === 'chat') renderChat();
  }
  if (event === 'chat:done') {
    const last = state.chats[state.chats.length - 1];
    if (last && last.id === data.id) { last.content = data.content; last.streaming = false; }
    if (state.view === 'chat') renderChat();
  }
  if (event === 'chat:cleared') {
    state.chats = [];
    if (state.view === 'chat') renderChat();
  }
}

function modeLabel(m) {
  if (m === 'composio') return 'COMPOSIO';
  if (m === 'live')     return 'LIVE';
  return 'NOT CONNECTED';
}

// ── Utilities ───────────────────────────────────────────────────────────
function escape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Update flow ────────────────────────────────────────────────────────
function showBanner(cls, text) {
  let el = document.querySelector('.banner');
  if (!el) { el = document.createElement('div'); document.body.appendChild(el); }
  el.className = 'banner ' + cls;
  el.textContent = text;
}
function clearBanner() { document.querySelector('.banner')?.remove(); }

async function checkForUpdates() {
  try {
    const r = await GET('/api/update/check');
    const label = 'v' + (r.local || '—');
    document.getElementById('version-label').textContent = label;
    const chip = document.getElementById('version-chip');
    const btn = document.getElementById('btn-update');
    const sub = document.getElementById('version-sub');
    if (r.updateAvailable) {
      chip.textContent = `v${r.local} → v${r.remote}`;
      chip.classList.add('update');
      chip.title = `Update to v${r.remote}`;
      btn.hidden = false;
      sub.textContent = `v${r.remote} available`;
    } else {
      chip.textContent = label;
      chip.classList.remove('update');
      chip.title = 'Up to date';
      btn.hidden = true;
      sub.textContent = r.remote ? 'up to date' : '';
    }
  } catch (e) {
    document.getElementById('version-sub').textContent = 'check failed';
  }
}

document.getElementById('version-chip').addEventListener('click', () => {
  const chip = document.getElementById('version-chip');
  if (chip.classList.contains('update')) document.getElementById('btn-update').click();
});

document.getElementById('btn-update').addEventListener('click', async () => {
  if (!confirm('Pull the latest version from GitHub and restart the server?')) return;
  const btn = document.getElementById('btn-update');
  btn.disabled = true;
  showBanner('info', 'Updating — pulling latest from GitHub…');
  try {
    const r = await POST('/api/update/apply');
    if (r.ok) {
      showBanner('ok', `Updated to v${r.version} — restarting…`);
      // Poll /api/status until server comes back up, then reload
      setTimeout(pollAfterUpdate, 2500);
    } else {
      showBanner('err', 'Update failed: ' + (r.error || 'unknown'));
      btn.disabled = false;
    }
  } catch (e) {
    // Server probably killed the socket during restart — treat as success and poll
    showBanner('ok', 'Restarting…');
    setTimeout(pollAfterUpdate, 2500);
  }
});

async function pollAfterUpdate(attempt = 0) {
  if (attempt > 30) { showBanner('err', 'Server did not come back up. Check logs.'); return; }
  try {
    const r = await GET('/api/status');
    showBanner('ok', `Updated to v${r.version} — reloading`);
    setTimeout(() => location.reload(), 800);
  } catch {
    setTimeout(() => pollAfterUpdate(attempt + 1), 1000);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────
(async function boot() {
  try {
    const status = await GET('/api/status');
    state.mock = status.mode === 'mock';
    document.getElementById('mode-badge').textContent = modeLabel(status.mode);
    document.getElementById('version-label').textContent = 'v' + (status.version || '—');
    document.getElementById('version-chip').textContent = 'v' + (status.version || '—');
  } catch {}
  connectWs();
  showView('overview');
  checkForUpdates();
  setInterval(checkForUpdates, 10 * 60 * 1000); // re-check every 10 min
})();
