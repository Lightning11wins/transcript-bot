#!/usr/bin/env bash
# Sets DISCORD_TOKEN in .env without touching the other settings, then restarts the bot if it's installed.
# The token isn't echoed or passed as an argument, so it stays out of your shell history.
set -euo pipefail
cd "$(dirname "$0")"

read -rsp 'Bot token: ' token
echo
if [ -z "$token" ]; then echo "No token given." >&2; exit 1; fi

umask 077
touch .env
{ grep -v '^DISCORD_TOKEN=' .env || true; printf 'DISCORD_TOKEN=%s\n' "$token"; } > .env.new
mv .env.new .env
echo "Saved."

if systemctl --user is-enabled -q transcript-bot 2>/dev/null; then
  systemctl --user restart transcript-bot
  echo "Restarted the bot."
fi
