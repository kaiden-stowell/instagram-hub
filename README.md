# Instagram Hub

Dashboard for Instagram DMs, posts, and analytics — with a built-in Claude Code
chat that has live context about your account. Modeled on
[agent-hub](https://github.com/kaiden-stowell/agent-hub).

Three data modes, picked automatically from `.env`:

| Mode | When | How |
|------|------|------|
| **COMPOSIO** (recommended) | `COMPOSIO_API_KEY` is set | Pulls via [Composio](https://composio.dev) — no Meta developer app needed, one click to connect your IG account |
| **LIVE** | `INSTAGRAM_TOKEN` is set | Direct Instagram Graph API calls |
| **MOCK** | neither | Seeded fake account/DMs/posts/analytics, useful for demos + UI work |

## Requirements

- Node.js 18+ and npm
- Claude Code CLI (`claude`) on your PATH — used for the "Ask Claude" panel
- (optional) Instagram Graph API token + business account ID for live mode

## Install

```bash
cd instagram-hub
npm install
cp .env.example .env   # leave INSTAGRAM_TOKEN blank for mock mode
npm start
```

Open <http://127.0.0.1:12790>.

## Views

- **Overview** — followers, reach, impressions, engagement, unread DMs, latest posts
- **Direct Messages** — thread list, conversation view, reply composer
- **Posts** — grid of recent posts with like/comment counts
- **Analytics** — followers + reach/impressions charts, 14-day snapshot table
- **Ask Claude** — chat with Claude Code; it receives a live snapshot of your
  stats, recent posts, threads, and analytics on every question

## Architecture (mirrors agent-hub)

| File | Role |
|------|------|
| `server.js` | Express + WebSocket server, REST API, static hosting |
| `db.js` | JSON file store (`data/db.json`) with atomic writes + backup |
| `instagram.js` | Integration module: mock seed, live Graph API fetchers, DM send |
| `runner.js` | Spawns `claude` CLI as subprocess, streams `stream-json` output |
| `public/` | Vanilla JS frontend (index.html, app.js, style.css) |

The integration-module pattern (`init`, `setBroadcast`, `sendDirectMessage`,
`fetchAll`, `stop`) is lifted directly from `agent-hub/telegram.js` and
`agent-hub/imessage.js`, so dropping in additional platforms later
(Threads, TikTok, etc.) is straightforward.

## Connecting Instagram via Composio (recommended)

Composio handles the Meta OAuth dance for you — no Meta developer app required.

1. Create a Composio account at <https://app.composio.dev> and grab an API key
   from the Developers page.
2. In the Composio dashboard, connect your Instagram Business/Creator account
   (Apps → Instagram → Connect).
3. Paste the key into `.env`:
   ```
   COMPOSIO_API_KEY=sk_...
   COMPOSIO_USER_ID=default
   ```
4. Restart — `npm start`. On boot you'll see `Mode: COMPOSIO` and the server
   will pull profile, media (30 most recent), insights (last 30 days),
   conversations, and messages every 60s.

Behind the scenes, instagram-hub executes these Composio tools directly via
its REST API (`backend.composio.dev/api/v3/tools/execute/<slug>`):

- `INSTAGRAM_GET_USER_INFO` — profile + follower counts
- `INSTAGRAM_GET_IG_USER_MEDIA` — recent posts
- `INSTAGRAM_GET_USER_INSIGHTS` — reach, follower_count, engagement
- `INSTAGRAM_LIST_ALL_CONVERSATIONS` / `INSTAGRAM_LIST_ALL_MESSAGES` — DMs
- `INSTAGRAM_SEND_TEXT_MESSAGE` — reply composer

## Going live via Meta directly (alternative)

1. Create a Meta developer app and link an Instagram Business/Creator account
   to a Facebook Page.
2. Generate a long-lived user access token with
   `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement`,
   `pages_show_list`.
3. Set `INSTAGRAM_TOKEN` and `INSTAGRAM_BUSINESS_ID` in `.env`.
4. Restart — the server will poll `graph.instagram.com` every 60s.

## Endpoints

```
GET  /api/status                    → { mode, connected, claudeBin }
GET  /api/stats                     → { followers, reach, impressions, ... }
GET  /api/accounts                  → list
GET  /api/threads                   → list DM threads
GET  /api/threads/:id               → { thread, messages }
POST /api/threads/:id/send          → { text } — send a DM
POST /api/threads/:id/read          → mark read
GET  /api/posts                     → list
GET  /api/analytics?limit=30        → analytics snapshots
POST /api/refresh                   → force pull from IG Graph API
GET  /api/chat                      → Claude chat history
POST /api/chat                      → { text } — ask Claude
POST /api/chat/stop                 → stop in-flight run
DELETE /api/chat                    → clear history
```

WebSocket at `ws://host/ws` broadcasts: `hello`, `dm:message`, `post:updated`,
`account:updated`, `analytics:updated`, `chat:message`, `chat:chunk`,
`chat:done`, `chat:cleared`.
