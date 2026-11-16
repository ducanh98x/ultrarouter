#!/usr/bin/env bash
set -euo pipefail

HOME="${HOME:-/data}"
export HOME

mkdir -p "$HOME/work" "$HOME/.gemini"

# agy stores its OAuth session in
#   $HOME/.gemini/antigravity-cli/antigravity-oauth-token
# which lives on the /data volume, so a restart keeps the login. Linux needs no
# keyring daemon (the Windows build uses Credential Manager instead).
exec node /app/gateway.mjs
