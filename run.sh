#!/usr/bin/env bash
#
# Pulse Arena launcher — starts the Python game server AND a static web server
# for the client, then waits. Ctrl-C stops both.
#
set -u
cd "$(dirname "$0")"

PORT_GAME=8765
PORT_WEB=8000

# --- pick a python, creating a venv + installing deps if needed -------------
PY=python3
if [ -x .venv/bin/python ]; then
  PY=.venv/bin/python
elif ! python3 -c "import websockets" >/dev/null 2>&1; then
  echo "==> Creating virtualenv + installing dependencies (one time)…"
  python3 -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r server/requirements.txt
  PY=.venv/bin/python
fi

if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
  echo "!! 'websockets' is not available. Run:" >&2
  echo "     python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt" >&2
  exit 1
fi

# --- don't fight over ports (e.g. run.sh started twice) ---------------------
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if port_busy "$PORT_GAME"; then
  echo "!! Port $PORT_GAME is already in use — the game server is probably already running."
  echo "   Either play against the server that's up, or stop it first (Ctrl-C in its terminal)."
  exit 1
fi
if port_busy "$PORT_WEB"; then
  echo "!! Port $PORT_WEB is already in use — close the other web server first."
  exit 1
fi

echo "=============================================================="
echo "  PULSE ARENA"
echo "    game server : ws://localhost:$PORT_GAME"
echo "    play here   : http://localhost:$PORT_WEB"
echo "  (open the link in two browser tabs to play against yourself)"
echo "  Ctrl-C to stop."
echo "=============================================================="

"$PY" server/server.py &
SRV=$!
python3 client/serve.py --port "$PORT_WEB" --dir client &
WEB=$!

cleanup() {
  echo
  echo "==> shutting down…"
  kill "$SRV" "$WEB" 2>/dev/null
  wait "$SRV" "$WEB" 2>/dev/null
}
trap cleanup EXIT INT TERM

# exit (and clean up) if either process dies
while kill -0 "$SRV" 2>/dev/null && kill -0 "$WEB" 2>/dev/null; do
  sleep 1
done
exit 1
