#!/bin/bash
# ── Instagram Hub Installer ──────────────────────────────────────────────
# curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/instagram-hub/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────

set -e

REPO="https://github.com/kaiden-stowell/instagram-hub.git"
DEST="$HOME/instagram-hub"
PORT=12790

echo ""
echo "  Instagram Hub Installer"
echo "  ────────────────────────"
echo ""

# Check dependencies
for cmd in node npm git; do
  if ! command -v $cmd &>/dev/null; then
    echo "  Error: '$cmd' is required but not installed."
    exit 1
  fi
done

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Error: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

if [ -d "$DEST" ]; then
  echo "  Found existing install at $DEST"
  read -p "  Overwrite code files? (data + .env will be preserved) [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
  TEMP_DATA=$(mktemp -d)
  [ -f "$DEST/.env" ] && cp "$DEST/.env" "$TEMP_DATA/.env"
  [ -d "$DEST/data" ] && cp -r "$DEST/data" "$TEMP_DATA/data"
  [ -d "$DEST/logs" ] && cp -r "$DEST/logs" "$TEMP_DATA/logs"
  echo "  Backed up user data"
fi

echo "  Downloading Instagram Hub..."
if [ -d "$DEST/.git" ]; then
  cd "$DEST" && git stash 2>/dev/null; git pull --ff-only origin main
else
  rm -rf "$DEST"
  git clone "$REPO" "$DEST"
fi

cd "$DEST"

# Restore preserved data
if [ -d "${TEMP_DATA:-/nonexistent}" ]; then
  [ -f "$TEMP_DATA/.env" ] && cp "$TEMP_DATA/.env" .env
  [ -d "$TEMP_DATA/data" ] && cp -r "$TEMP_DATA/data" .
  [ -d "$TEMP_DATA/logs" ] && cp -r "$TEMP_DATA/logs" .
  rm -rf "$TEMP_DATA"
  echo "  Restored user data"
fi

echo "  Installing dependencies..."
npm install --production --silent 2>/dev/null || npm install --production

mkdir -p data logs

# Create .env if missing (mock mode by default)
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env (mock mode — edit to add INSTAGRAM_TOKEN for live mode)"
fi

chmod +x install.sh 2>/dev/null || true

# ── launchd service (macOS) ──────────────────────────────────────────────
PLIST_NAME="com.instagram-hub.server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
NODE_BIN=$(which node)

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DEST}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DEST}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${DEST}/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${DEST}/logs/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
    </dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

sleep 2
echo ""
if curl -s -o /dev/null http://127.0.0.1:${PORT}/api/status 2>/dev/null; then
  echo "  ✅ Instagram Hub installed and running!"
  echo ""
  echo "  Open http://127.0.0.1:${PORT}"
else
  echo "  ✅ Instagram Hub installed!"
  echo "  ⚠️  Server may still be starting. Check logs at: $DEST/logs/"
fi
echo ""
echo "  The server runs in the background and starts automatically on boot."
echo "  To stop:    launchctl unload ~/Library/LaunchAgents/${PLIST_NAME}.plist"
echo "  To restart: launchctl unload ~/Library/LaunchAgents/${PLIST_NAME}.plist && launchctl load ~/Library/LaunchAgents/${PLIST_NAME}.plist"
echo ""
