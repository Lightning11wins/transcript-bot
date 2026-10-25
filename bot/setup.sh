#!/usr/bin/env bash
# Installs dependencies and runs the bot as a systemd user service that starts with the VM.
# Rerun it after moving the repo or upgrading Node, since it records both paths.
set -euo pipefail
cd "$(dirname "$0")"

node=$(command -v node) || { echo "Node.js 22.18 or newer is needed: sudo dnf install nodejs" >&2; exit 1; }
if ! "$node" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "Node.js 22.18 or newer is needed (found $("$node" --version)): sudo dnf install nodejs" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "Create .env first: cp .env.example .env, then fill it in." >&2
  exit 1
fi
chmod 600 .env

npm ci

unit=~/.config/systemd/user/transcript-bot.service
mkdir -p "$(dirname "$unit")"
cat > "$unit" <<UNIT
[Unit]
Description=Discord call transcriber

[Service]
WorkingDirectory=$PWD
ExecStart=$node --env-file=.env src/index.ts
# Also covers starting before the network is up: login fails, systemd retries.
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable transcript-bot.service
systemctl --user restart transcript-bot.service
# Lets user services start at boot without anyone logging in.
loginctl enable-linger "$USER"
systemctl --user status transcript-bot.service --no-pager
