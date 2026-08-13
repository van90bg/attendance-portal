#!/usr/bin/env bash
# Cloud Agent sandbox bootstrap - chay 1 dong: ./start.sh
# Dung duoc o: Codespace, Linux, macOS, Git Bash / WSL tren Windows.
# YEU CAU: .env phai co day du key (tu dong tao tu .env.example khi chua co).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example - fill in keys, then run again."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js >= 18 required (node not found)."
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

exec npm start