# Pulse Arena — a tiny online FPS

A simple multiplayer first-person shooter. It is **fully peer-to-peer**: players
connect straight to each other over WebRTC data channels, and no game traffic passes
through a server.

- **JavaScript (Three.js)** — 3D rendering, first-person movement, shooting FX.
- **WebRTC mesh** — positions, shots, hits, kills and respawns go peer to peer.
- **Python (`websockets`)** — a *signalling* server: it puts players in a room and
  brokers the WebRTC handshake. That's all it does.

```
FPS/
├── server/
│   ├── signalling.py      # rooms + WebRTC offer/answer/ICE relay (no game data)
│   └── requirements.txt
├── client/
│   ├── index.html         # menu + HUD + loads the game scripts
│   ├── serve.py           # static server with caching disabled
│   ├── css/style.css
│   └── js/
│       ├── config.js      # settings + static level data
│       ├── audio.js       # WebAudio synth SFX (no asset files)
│       ├── ui.js          # HUD / menu / feed / scoreboard helpers
│       ├── rtc.js         # the P2P transport (WebRTC mesh)
│       └── game.js        # Three.js engine, physics, players, shooting
└── run.sh
```

## 1. Quick start (playing locally / on a LAN)

```bash
./run.sh
```

```
  signalling : ws://localhost:8765
  play here  : http://localhost:8000
```

Open **http://localhost:8000**, enter a nickname, and use:

```
ws://localhost:8765/arena
```

as the **Server / room** address. Open a second tab (or a browser on another machine on
your LAN, using your machine's IP) to play against yourself.

> The address is one field: `host:port/room`. Everything after the `/` is the room name,
> so `wss://my-host:8765/duel` puts you in room `duel`. Everyone who types the same
> address ends up in the same match.

<details>
<summary>Or start the pieces manually</summary>

```bash
cd server
pip install -r requirements.txt
python signalling.py              # ws://0.0.0.0:8765

cd ../client
python serve.py                   # http://localhost:8000 (caching disabled)
```
</details>

You can also just open `client/index.html` directly — `ws://` works from `file://`.

## 2. Playing from GitHub Pages (or any HTTPS site)

**GitHub Pages can only serve static files — it cannot run the signalling server.**
The client files can live there, but the game still needs a signalling address, and
because an HTTPS page cannot open a plain `ws://` connection (the browser blocks it as
mixed content), that address must be **`wss://`** (secure WebSocket).

The game checks this for you and tells you if the address is wrong.

### Easiest: the tunnel helper

You have a GitHub Pages client but no server? Run one command:

```bash
./tunnel.sh                 # or: ./tunnel.sh myroom
```

It starts the signalling server, opens a free Cloudflare tunnel, and prints the exact
address to paste into the game:

```
===============================================================
  PASTE THIS INTO THE GAME'S "Server / room" FIELD:

      wss://something-random-words.trycloudflare.com/arena
===============================================================
```

Share that address with your friends — it works from the GitHub Pages client, needs no
domain, no account and no port forwarding. The first run downloads `cloudflared` into
`.tools/` (a single binary; nothing is installed system-wide).

Worth knowing:

- Keep the script running while you play. Once players have connected, the game traffic
  goes **directly** between them — the tunnel is only used for the handshake.
- The free URL **changes every time you restart** the script, so send the new one.
- It has to be `wss://`; that's what the script prints.

### Alternatives

**Run it on a VPS/domain you own** with a certificate (e.g. Let's Encrypt) for a
permanent address:

```bash
python server/signalling.py --port 8765 \
    --certfile /etc/letsencrypt/live/example.com/fullchain.pem \
    --keyfile  /etc/letsencrypt/live/example.com/privkey.pem
```

**Put it behind a TLS reverse proxy** (nginx / Caddy) and use
`wss://your-domain/some-room`.

**Use your own tunnel** — `ngrok http 8765` does the same job as `./tunnel.sh`; then use
`wss://<ngrok-host>/<room>`.

### NAT note

WebRTC has to punch through NAT. A public STUN server is configured by default, which
covers most home networks. A strict/symmetric NAT can still fail to connect — that
would need a TURN server, added to `CFG.p2p.iceServers` in `client/js/config.js`.

## Controls

| Input     | Action                      |
|-----------|-----------------------------|
| `W A S D` | move                        |
| `Shift`   | run                         |
| `Space`   | jump                        |
| Mouse     | look                        |
| `LMB`     | fire (3 hits to kill)       |
| `Tab`     | scoreboard                  |
| `Esc`     | release the mouse / pause   |
| `V`       | toggle mouse capture (for browsers that block pointer lock) |

Death screen shows a 3-second respawn countdown, then you drop back in at a random
spawn point.

## How it works

### The signalling handshake

The Python server only runs the signalling handshake:

**Client → signalling server**
- `join` — nickname + room name
- `signal` — WebRTC offer / answer / ICE candidate, addressed to one peer

**Signalling server → clients**
- `welcome` — your id, plus the peers already in the room
- `peer-join` / `peer-leave` — who is in the room
- `signal` — the relayed offer/answer/ICE

Once the `RTCDataChannel` is open, the game is fully peer-to-peer:
- `state` — your position/health/kills, broadcast ~20×/s straight to the other players
- `shoot` — origin/direction + who you hit
- `hit` / `kill` / `respawn` — sent by the **victim**, who owns its own health

A claimed hit is still sanity-checked by the victim (the shot must actually pass near
it), and the shooter's own raycast decides what it hit locally.

### Models

The first-person weapon is a faceted low-poly rifle (mustard-yellow receiver,
handguard, stock and grip with a dark slate barrel, rail, sights, magazine and
buttpad). Other players are drawn as a capsule with two floating cube "hands" holding
the same rifle, plus an overhead name/health tag.

## Troubleshooting

| Symptom | Cause |
|---|---|
| **DEPLOY does nothing** | The 3D engine (Three.js) couldn't be fetched from any CDN. The menu now says so — check your connection/ad-blocker and reload. |
| "Can't reach `wss://…`" | The signalling server isn't running, or the address/port is wrong. |
| Address rejected on an HTTPS page | An HTTPS page can only open `wss://`, never `ws://`. See section 2. |
| "GitHub Pages can't run the signalling server" | Point the address at a tunnel/VPS from section 2. |
| Connected, but you never see the other player | You're in different **rooms** (the part after the `/` in the address). |
| Mouse doesn't look around | Some embedded browsers block pointer lock; the game switches to *mouse steering* automatically — move the cursor away from the centre to turn, and press `V` to retry capture. |
