'use strict';
// Thin wrapper around the Composio v3 REST API — lets instagram-hub execute
// Composio tools (INSTAGRAM_GET_USER_INFO, INSTAGRAM_LIST_ALL_CONVERSATIONS, …)
// directly from the server without going through Claude.
//
// Usage:
//   const composio = require('./composio');
//   const r = await composio.execute('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me' });
//
// Env:
//   COMPOSIO_API_KEY   — required
//   COMPOSIO_USER_ID   — optional; defaults to 'default'
//   COMPOSIO_BASE_URL  — optional; defaults to https://backend.composio.dev

const https = require('https');
const { URL } = require('url');

const BASE = (process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev').replace(/\/$/, '');

function isEnabled() {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

function _request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.COMPOSIO_API_KEY?.trim();
    if (!apiKey) return reject(new Error('COMPOSIO_API_KEY not set'));

    const url = new URL(BASE + pathname);
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error(`composio ${method} ${pathname} → ${r.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('composio request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Execute a Composio tool. Returns the .data field of a successful response
// (which is whatever the underlying Instagram Graph API returned), or throws.
async function execute(toolSlug, args = {}) {
  const userId = process.env.COMPOSIO_USER_ID?.trim() || 'default';
  const body = { user_id: userId, arguments: args };
  const resp = await _request('POST', `/api/v3/tools/execute/${toolSlug}`, body);

  if (resp && resp.successful === false) {
    throw new Error(`composio tool ${toolSlug} failed: ${resp.error || JSON.stringify(resp).slice(0, 200)}`);
  }
  // Composio wraps responses as { successful, data, error }
  return resp?.data ?? resp;
}

// List connected accounts for a toolkit (used to verify IG is connected at boot)
async function listConnections(toolkit) {
  try {
    const resp = await _request('GET', `/api/v3/connected_accounts?toolkit_slug=${encodeURIComponent(toolkit)}`);
    return resp?.items || resp?.data || [];
  } catch (e) {
    return [];
  }
}

module.exports = { isEnabled, execute, listConnections };
