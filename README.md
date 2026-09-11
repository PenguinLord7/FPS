# Pulse Arena — a tiny online FPS

A simple multiplayer first-person shooter:
- **JavaScript (Three.js)** — 3D rendering, first-person movement, shooting FX, all client-side.
- **Python (`websockets`)** — server tracks players, validates shots, applies damage, handles kills and respawns.

```
FPS/
├── server/
│   ├── server.py          # Python websocket game server
│   └── requirements.txt
├── client/
│   ├── index.html         # menu + HUD + loads the game scripts
│   ├── css/style.css
│   └── js/
│       ├── config.js      # settings + static level data
│       ├── audio.js       # WebAudio synth SFX (no asset files)
│       ├── ui.js          # HUD / menu / feed / scoreboard helpers
│       ├── net.js         # websocket wrapper w/ reconnect
│       └── game.js        # Three.js engine, physics, players, shooting
└── tests/
    └── smoke_test.py      # scripted 2-client server check
```

## 1. Start everything

The easiest way — one command starts the Python server **and** the web server:

```bash
./run.sh
```

Then open **http://localhost:8000** in two browser tabs, pick a nickname in each and
hit **DEPLOY**.

<details>
<summary>Or start the two pieces manually</summary>

```bash
# terminal 1 — game server (listens on ws://0.0.0.0:8765)
cd server
pip install -r requirements.txt
python server.py

# terminal 2 — serve the client on http://localhost:8000
cd client
python serve.py            # caching disabled, so edits always take effect
```
</details>

You can also just open `client/index.html` directly (WebSockets work from `file://`),
in which case the client defaults to `ws://localhost:8765`.

If you host the server on another machine, put its address in the menu's *Server
address* field (e.g. `ws://192.168.1.20:8765`) — it's remembered for next time. When the
page is served over HTTP the field auto-fills with the same host on port 8765.

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

Death screen shows a 3-second respawn countdown, then you drop back in at a random
spawn point.

## How it works

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
