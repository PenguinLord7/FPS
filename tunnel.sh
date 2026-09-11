#!/usr/bin/env bash
#
# Pulse Arena — play from anywhere (including a GitHub Pages client).
#
# GitHub Pages can only serve static files, and an HTTPS page cannot open a
# plain ws:// connection. This starts the signalling server and exposes it
# through a free Cloudflare "quick tunnel", giving you a wss:// address that
# works from any HTTPS page.
#
#   ./tunnel.sh          ->  signalling + tunnel (+ local web server)
#
# It downloads cloudflared into .tools/ the first time (single static binary,
# no root needed, nothing installed system-wide).
#
set -u
cd "$(dirname "$0")"

PORT_SIGNAL=8765
PORT_WEB=8000
ROOM="${1:-arena}"
BIN=".tools/cloudflared"
LOG=".tools/tunnel.log"

# ---------------------------------------------------------------- python/deps
PY=python3
if [ -x .venv/bin/python ]; then
  PY=.venv/bin/python
elif ! python3 -c "import websockets" >/dev/null 2>&1; then
  echo "==> creating virtualenv + installing dependencies (one time)…"
  python3 -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r server/requirements.txt
  PY=.venv/bin/python
fi
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
  echo "!! 'websockets' is missing. Run:" >&2
  echo "     python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt" >&2
  exit 1
fi

# ---------------------------------------------------------------- cloudflared
if [ ! -x "$BIN" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "!! unsupported CPU '$(uname -m)'. Install cloudflared yourself and re-run." >&2; exit 1 ;;
  esac
  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
  mkdir -p .tools
  echo "==> downloading cloudflared (~40 MB, one time)…"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$URL" -o "$BIN" || { echo "!! download failed"; exit 1; }
  else
    wget -q --show-progress "$URL" -O "$BIN" || { echo "!! download failed"; exit 1; }
  fi
  chmod +x "$BIN"
fi

# ---------------------------------------------------------------- start up
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if port_busy "$PORT_SIGNAL"; then
  echo "!! port $PORT_SIGNAL is already in use — stop the other server first (Ctrl-C there)." >&2
  exit 1
fi

"$PY" server/signalling.py --port "$PORT_SIGNAL" &
SIG=$!

# --protocol http2 gets through restrictive networks far more reliably than QUIC
"$BIN" tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT_SIGNAL" \
  > "$LOG" 2>&1 &
TUN=$!

WEB=""
if ! port_busy "$PORT_WEB"; then
  python3 client/serve.py --port "$PORT_WEB" --dir client >/dev/null 2>&1 &
  WEB=$!
fi

cleanup() {
  echo
  echo "==> shutting down…"
  [ -n "$WEB" ] && kill "$WEB" 2>/dev/null
  kill "$SIG" "$TUN" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- wait for URL
echo "==> waiting for the tunnel (up to 45s)…"
URL=""
for _ in $(seq 1 45); do
  sleep 1
  URL=$(grep -Eo 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
done

if [ -z "$URL" ]; then
  echo "!! Could not get a tunnel URL. Last lines of $LOG:" >&2
  tail -n 15 "$LOG" >&2 2>/dev/null
  exit 1
fi

WSS="wss://${URL#https://}/${ROOM}"

echo
echo "==============================================================="
echo "  PASTE THIS INTO THE GAME'S \"Room\" FIELD (just the first time):"
echo
echo "      $WSS"
echo
echo "  Share that exact address with your friends — everyone using"
echo "  it lands in room '$ROOM'. It works from a GitHub Pages client."
echo "  After pasting it once, the game remembers the server and you"
echo "  only need to type a room code."
[ -n "$WEB" ] && echo
[ -n "$WEB" ] && echo "  Local copy of the game: http://localhost:$PORT_WEB"
echo
echo "  Keep this window open while playing. Voice/text chat and the"
echo "  game itself do NOT go through the tunnel — only the initial"
echo "  handshake — so it stays cheap and low-latency."
echo
echo "  NOTE: this free URL changes every time you restart the script."
echo "  Ctrl-C to stop."
echo "==============================================================="

while kill -0 "$SIG" 2>/dev/null && kill -0 "$TUN" 2>/dev/null; do
  sleep 1
done
exit 1
