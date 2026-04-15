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
//
// Endpoints and body shapes are derived from the Composio TypeScript SDK
// source (ts/packages/core/src/models/{AuthConfigs,ConnectedAccounts}.ts).
async function findOrCreateAuthConfig(toolkit) {
  // Reuse an existing composio-managed auth config if one exists
  try {
    const qs = `toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true`;
    const r = await _request('GET', `/api/v3/auth_configs?${qs}`);
    const items = r?.items || r?.data?.items || r?.data || [];
    const first = items[0];
    const id = first?.id || first?.nanoid || first?.auth_config?.id;
    if (id) return id;
  } catch (e) {
    console.error('[composio] list auth_configs failed:', e.message);
  }

  // Create a fresh composio-managed auth config
  const createBody = {
    toolkit: { slug: toolkit },
    auth_config: {
      type: 'use_composio_managed_auth',
      name: `instagram-hub/${toolkit}`,
    },
  };
  const r = await _request('POST', '/api/v3/auth_configs', createBody);
  const id = r?.auth_config?.id || r?.data?.auth_config?.id || r?.id;
  if (!id) throw new Error('auth_config create returned no id: ' + JSON.stringify(r).slice(0, 200));
  return id;
}

// Initiate a new OAuth connection for a toolkit. Returns the real provider
// OAuth URL (e.g. https://www.instagram.com/accounts/login/...) on success.
async function initiateConnection(toolkit, callbackUrl) {
  const userId = process.env.COMPOSIO_USER_ID?.trim() || 'default';
  const authConfigId = await findOrCreateAuthConfig(toolkit);

  // Body shape matches the SDK's ConnectedAccountCreateParamsRaw:
  //   { auth_config: { id }, connection: { user_id, callback_url?, state? } }
  const body = {
    auth_config: { id: authConfigId },
    connection: {
      user_id: userId,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    },
  };

  const resp = await _request('POST', '/api/v3/connected_accounts', body);

  // SDK parses response.connectionData.val.redirectUrl
  const url =
    resp?.connectionData?.val?.redirectUrl ||
    resp?.connection_data?.val?.redirectUrl ||
    resp?.redirectUrl ||
    resp?.redirect_url;

  if (!url) {
    throw new Error(
      'Composio returned no redirectUrl. Response: ' + JSON.stringify(resp).slice(0, 300)
    );
  }
  return {
    redirect_url: url,
    auth_config_id: authConfigId,
    connected_account_id: resp?.id || resp?.nanoid,
  };
}

module.exports = { isEnabled, execute, listConnections, initiateConnection, findOrCreateAuthConfig };
