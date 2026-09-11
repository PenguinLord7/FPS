# Pulse Arena — a tiny online FPS

A simple multiplayer first-person shooter:
- **JavaScript (Three.js)** — 3D rendering, first-person movement, shooting FX, all client-side.
- **Peer-to-peer by default** — players exchange game traffic directly over WebRTC data
  channels; the Python server only brokers the connection.
- **Python (`websockets`)** — acts as the P2P *signalling* server, and can still run the
  original server-hosted **relay** mode as a fallback.

```
FPS/
├── server/
│   ├── signalling.py      # P2P: rooms + WebRTC offer/answer/ICE relay (no game data)
│   ├── server.py          # optional relay mode: authoritative game server
│   └── requirements.txt
├── client/
│   ├── index.html         # menu + HUD + loads the game scripts
│   ├── serve.py           # static server with caching disabled
│   ├── css/style.css
│   └── js/
│       ├── config.js      # settings + static level data
│       ├── audio.js       # WebAudio synth SFX (no asset files)
│       ├── ui.js          # HUD / menu / feed / scoreboard helpers
│       ├── net.js         # relay transport (websocket w/ reconnect)
│       ├── rtc.js         # P2P transport (WebRTC mesh)
│       └── game.js        # Three.js engine, physics, players, shooting
└── tests/
    └── smoke_test.py      # scripted 2-client check for the relay server
```

## 1. Start everything

One command starts the signalling server, the optional relay server and the web server:

```bash
./run.sh
```

```
  signalling  : ws://localhost:8765   (P2P mode)
  relay server: ws://localhost:8766   (relay mode)
  play here   : http://localhost:8000
```

Then open **http://localhost:8000**, pick a nickname, and hit **DEPLOY**. Open a second
browser tab (or a browser on another machine) to play against yourself.

<details>
<summary>Or start the pieces manually</summary>

```bash
cd server
pip install -r requirements.txt
python signalling.py          # P2P signalling on ws://0.0.0.0:8765
python server.py              # optional relay mode on ws://0.0.0.0:8766

# serve the client on http://localhost:8000
cd ../client
python serve.py               # caching disabled, so edits always take effect
```
</details>

You can also just open `client/index.html` directly (WebSockets work from `file://`).

### Playing with friends

1. Everyone sets the **same Room** name.
2. P2P mode needs a reachable signalling address. When the page is served over HTTP the
   field auto-fills with the page's own host on port 8765, so a friend on your LAN just
   visits `http://<your-ip>:8000` and hits DEPLOY — nothing else to configure.
3. Across the internet you also need the signalling port reachable, and WebRTC must be
   able to punch through NAT. A public STUN server is configured by default, which
   covers most home networks; strict/symmetric NATs would need a TURN server added to
   `CFG.p2p.iceServers` in `client/js/config.js`.

### P2P vs Relay

The menu's **Mode** selector picks the transport:

| | **P2P** (default) | **Relay** |
|---|---|---|
| Game traffic | direct between browsers (WebRTC) | through the Python server |
| Server role | signalling only | authoritative |
| Who owns HP/kills | each player owns their own health | the server |
| Best for | LAN / small groups, no host burden | strict NATs, anti-cheat, always works |

Both modes use the identical client protocol, so gameplay is the same either way.

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

### P2P mode (default)

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

### Relay mode

**Client → server**
- `join` — handshake with nickname
- `state` — position + facing (sent ~20×/s)
- `shoot` — origin/direction + which player your raycast hit (if any)

**Server → clients**
- `welcome` / `joined` / `left` — session & presence
- `snap` — full player state broadcast ~20×/s (positions are interpolated on the client)
- `shot` — replay a tracer for every shot so everyone sees the bullets
- `hit` / `kill` / `respawn` — damage, eliminations and auto-respawns

The client does the fine-grained raycast (against the world + other players' hit
spheres) so shooting feels instant; the server re-checks every shot — shooter alive,
fire-rate cooldown, and a ray-vs-victim test that rejects hits aimed nowhere near the
target — and owns HP / kills / respawns.

### Models

The first-person weapon is a faceted low-poly rifle (mustard-yellow receiver,
handguard, stock and grip with a dark slate barrel, rail, sights, magazine and
buttpad). Other players are drawn as a capsule with two floating cube "hands" holding
the same rifle, plus an overhead name/health tag.

## Tests

With the server running:

```bash
cd tests
python smoke_test.py     # expects the server on 127.0.0.1:8765
```

It connects two fake clients, makes one shoot the other and asserts that `hit`,
`kill`, `snap` and `respawn` messages all arrive.
