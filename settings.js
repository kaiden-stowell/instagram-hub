'use strict';
// Read/write helpers for .env — used by the Settings UI so users can wire up
// Composio without shelling into the server.
const fs   = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// Update/insert keys while preserving comments + ordering of the existing file.
function writeEnv(patch) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const seen = new Set();
  const next = lines.map(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(patch, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${patch[m[1]] ?? ''}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) next.push(`${k}=${v ?? ''}`);
  }
  fs.writeFileSync(ENV_FILE, next.join('\n'));
  // Also mutate process.env so running code picks up changes without restart
  for (const [k, v] of Object.entries(patch)) process.env[k] = v ?? '';
}

function maskKey(val) {
  if (!val) return '';
  if (val.length <= 8) return '•'.repeat(val.length);
  return val.slice(0, 4) + '•'.repeat(Math.max(4, val.length - 8)) + val.slice(-4);
}

module.exports = { readEnv, writeEnv, maskKey };
