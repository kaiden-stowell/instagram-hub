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

// ── Auth configs ────────────────────────────────────────────────────────
// Composio v3 requires an auth_config to exist before you can initiate a
// connection. We find-or-create a composio-managed one per toolkit so the
// user doesn't have to set anything up in the Composio dashboard first.
async function findOrCreateAuthConfig(toolkit) {
  // Try to reuse an existing one
  try {
    const r = await _request('GET', `/api/v3/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
    const items = r?.items || r?.data || [];
    if (items.length) return items[0].id || items[0].nanoid;
  } catch {}

  // Create a new composio-managed auth config
  try {
    const r = await _request('POST', '/api/v3/auth_configs', {
      toolkit: { slug: toolkit },
      auth_config: {
        type: 'use_composio_managed_auth',
        name: `instagram-hub/${toolkit}`,
      },
    });
    const id = r?.auth_config?.id || r?.data?.auth_config?.id || r?.id;
    if (id) return id;
  } catch (e) {
    throw new Error(`auth_config create failed: ${e.message}`);
  }
  throw new Error('auth_config create returned no id');
}

// Initiate a new OAuth connection for a toolkit. Returns { redirect_url } on success.
async function initiateConnection(toolkit) {
  const userId = process.env.COMPOSIO_USER_ID?.trim() || 'default';
  const authConfigId = await findOrCreateAuthConfig(toolkit);

  // v3 shape — wraps connection metadata under { auth_config, connection }
  // We try a couple of body variants because the SDKs use slightly different
  // envelopes for the same endpoint.
  const bodyVariants = [
    {
      auth_config: { id: authConfigId },
      connection: {
        user_id: userId,
        state: { authScheme: 'OAUTH2', val: { status: 'INITIATING' } },
      },
    },
    {
      auth_config_id: authConfigId,
      user_id: userId,
      config: { auth_scheme: 'OAUTH2' },
    },
  ];

  for (const body of bodyVariants) {
    try {
      const resp = await _request('POST', '/api/v3/connected_accounts', body);
      const url =
        resp?.connectionData?.val?.redirectUrl ||
        resp?.redirect_url ||
        resp?.redirectUrl ||
        resp?.data?.redirect_url ||
        resp?.connected_account?.redirect_url;
      if (url) return { redirect_url: url, auth_config_id: authConfigId };
    } catch (e) {
      // Log and try next body shape
      console.error('[composio] initiate variant failed:', e.message);
    }
  }
  throw new Error('Composio did not return a redirect_url — check your API key and that the Instagram toolkit supports composio-managed auth.');
}

module.exports = { isEnabled, execute, listConnections, initiateConnection, findOrCreateAuthConfig };
