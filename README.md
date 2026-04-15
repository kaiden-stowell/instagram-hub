# Instagram Hub

Dashboard for Instagram DMs, posts, and analytics — with a built-in Claude Code
chat that has live context about your account. Modeled on
[agent-hub](https://github.com/kaiden-stowell/agent-hub).

Runs in **mock mode** out of the box (fake accounts/DMs/posts/analytics that
update in real time over WebSocket), so you can build out the UI and Claude
flows without touching the Meta developer console. Drop in an
`INSTAGRAM_TOKEN` to switch to live mode.

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

## Going live

1. Create a Meta developer app and link an Instagram Business/Creator account
   to a Facebook Page.
2. Generate a long-lived user access token with
   `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement`,
   `pages_show_list`.
3. Set `INSTAGRAM_TOKEN` and `INSTAGRAM_BUSINESS_ID` in `.env`.
4. Restart — the server will poll `graph.instagram.com` every 60s.

DM send/receive uses the Instagram Messaging API and requires
`instagram_manage_messages` permission (Meta App Review). The code for
`fetchThreads()` in `instagram.js` is stubbed until those permissions are
approved — wire up the `/me/conversations` endpoint there.

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
