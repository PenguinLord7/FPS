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

## 1. Start the server

```bash
cd server
python -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python server.py
```

The server listens on `ws://0.0.0.0:8765`.

## 2. Open the client

Just open `client/index.html` in two browser tabs/windows (WebSocket connections work
fine from `file://`), **or** serve the folder and open `http://localhost:8000`:

```bash
cd client
python -m http.server 8000
```

Each tab needs its own nickname, then hit **DEPLOY**. Both players should see each
other on the arena. If you host the server on another machine, change the *Server
address* field in the menu (e.g. `ws://192.168.1.20:8765`).

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
spheres) so shooting feels instant; the server double-checks each shot (alive,
cooldown, range) and owns HP / kills / respawns, so a cheated "victim" claim can't
help you much.

## Tests

With the server running:

```bash
cd tests
python smoke_test.py     # expects the server on 127.0.0.1:8765
```

It connects two fake clients, makes one shoot the other and asserts that `hit`,
`kill`, `snap` and `respawn` messages all arrive.
