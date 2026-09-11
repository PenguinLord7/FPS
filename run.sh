#!/usr/bin/env bash
#
# Pulse Arena launcher — starts the Python game server AND a static web server
# for the client, then waits. Ctrl-C stops both.
#
set -u
cd "$(dirname "$0")"

PORT_SIGNAL=8765
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

if port_busy "$PORT_SIGNAL"; then
  echo "!! Port $PORT_SIGNAL is already in use — the signalling server is probably already running."
  echo "   Either play against the server that's up, or stop it first (Ctrl-C in its terminal)."
  exit 1
fi
if port_busy "$PORT_WEB"; then
  echo "!! Port $PORT_WEB is already in use — close the other web server first."
  exit 1
fi

echo "=============================================================="
echo "  PULSE ARENA  (peer-to-peer)"
echo "    signalling : ws://localhost:$PORT_SIGNAL"
echo "    play here  : http://localhost:$PORT_WEB"
echo "  Enter this in the game:  ws://localhost:$PORT_SIGNAL/arena"
echo "  Ctrl-C to stop."
echo "--------------------------------------------------------------"
echo "  Playing from an HTTPS page (e.g. GitHub Pages)? Plain ws:// is"
echo "  blocked there — you need a wss:// address. Either tunnel this"
echo "  port (cloudflared / ngrok) or pass --certfile/--keyfile."
echo "=============================================================="

SIGNAL_ARGS=(--port "$PORT_SIGNAL")
[ -n "${TLS_CERT:-}" ] && SIGNAL_ARGS+=(--certfile "$TLS_CERT" --keyfile "${TLS_KEY:-}")

"$PY" server/signalling.py "${SIGNAL_ARGS[@]}" &
SIG=$!
python3 client/serve.py --port "$PORT_WEB" --dir client &
WEB=$!

cleanup() {
  echo
  echo "==> shutting down…"
  kill "$SIG" "$WEB" 2>/dev/null
  wait "$SIG" "$WEB" 2>/dev/null
}
trap cleanup EXIT INT TERM

# exit (and clean up) if either process dies
while kill -0 "$SIG" 2>/dev/null && kill -0 "$WEB" 2>/dev/null; do
  sleep 1
done
exit 1
