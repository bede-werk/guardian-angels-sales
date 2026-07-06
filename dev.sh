#!/usr/bin/env bash
# Convenience launcher for local development on this machine.
# Ensures nvm's Node is on PATH, then starts the backend (:4000) and frontend (:5173).
# Stop both with Ctrl+C.
set -e

# Make nvm's Node available even in a non-login shell.
if [ -d "$HOME/.nvm/versions/node/v24.18.0/bin" ]; then
  export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting backend (http://localhost:4000)…"
(cd "$ROOT/server" && npm run dev) &
BACKEND_PID=$!

echo "Starting frontend (http://localhost:5173)…"
(cd "$ROOT/client" && npm run dev) &
FRONTEND_PID=$!

# Shut both down together.
trap 'echo; echo "Stopping…"; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null' INT TERM
wait
