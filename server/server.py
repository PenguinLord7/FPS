#!/usr/bin/env python3
"""
Pulse Arena — Python game server
=================================
Runs the multiplayer logic for the Three.js browser FPS:

  * assigns player ids / colours and tracks the last known state of everyone
  * validates shots (fire-rate + range), applies damage, resolves kills,
    and auto-respawns dead players
  * broadcasts full state snapshots ~20x/sec plus realtime gameplay events

Run:
    pip install -r requirements.txt
    python server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fps")

HOST = "0.0.0.0"
PORT = 8765

TICK = 0.05            # snapshot broadcast interval (s) -> 20 Hz
RESPAWN_TIME = 3.0     # seconds a dead player waits before respawning
START_HP = 100
DAMAGE = 34            # 3 hits => one kill
MAX_SHOT_RANGE = 260.0
FIRE_COOLDOWN = 0.12   # server-side safety net (client also enforces fire rate)
MAX_PLAYERS = 12
MAP_HALF = 48.0

PALETTE = [
    "#ff5252", "#ffab40", "#ffee58", "#69f0ae",
    "#40c4ff", "#b388ff", "#f48fb1", "#80deea",
    "#a5d6a7", "#ffcc80", "#90a4ae", "#ef9a9a",
]

SPAWNS = [
    (-40.0, -40.0), (40.0, -40.0), (-40.0, 40.0), (40.0, 40.0),
    (-24.0, 10.0), (22.0, -14.0), (6.0, 30.0), (30.0, 24.0),
]

players: dict[int, "Player"] = {}
_next_id = 0


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def vec3(value):
    """Return a tuple of three finite floats from an untrusted payload, or None."""
    if not (isinstance(value, (list, tuple)) and len(value) >= 3):
        return None
    try:
        out = tuple(float(v) for v in value[:3])
    except (TypeError, ValueError):
        return None
    if any(math.isnan(v) or math.isinf(v) for v in out):
        return None
    return out


def ray_hits_point(origin, direction, point, radius: float) -> bool:
    """Shortest distance between a ray and a point.

    Used to sanity-check a client's claimed hit without needing the full level
    on the server: accept only if the shot actually passes close to the victim.
    """
    ox, oy, oz = origin
    dx, dy, dz = direction
    ln = math.sqrt(dx * dx + dy * dy + dz * dz)
    if ln < 1e-6:
        return False
    dx, dy, dz = dx / ln, dy / ln, dz / ln

    px, py, pz = point[0] - ox, point[1] - oy, point[2] - oz
    t = px * dx + py * dy + pz * dz
    if t < 0 or t > MAX_SHOT_RANGE:
        return False
    cx, cy, cz = px - t * dx, py - t * dy, pz - t * dz
    return math.sqrt(cx * cx + cy * cy + cz * cz) <= radius


class Player:
    """Server-side view of one connected client."""

    def __init__(self, ws, pid: int, name: str, color: str, q: asyncio.Queue):
        self.ws = ws
        self.id = pid
        self.name = name
        self.color = color
        self.q = q
        sx, sz = random.choice(SPAWNS)
        self.x, self.y, self.z = sx, 0.0, sz
        self.ry = random.uniform(0, math.tau)
        self.hp = START_HP
        self.alive = True
        self.kills = 0
        self.last_shot = 0.0
        self.respawn_task: asyncio.Task | None = None

    def state(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "p": [self.x, self.y, self.z],
            "ry": self.ry,
            "hp": self.hp,
            "alive": self.alive,
            "kills": self.kills,
        }


# --------------------------------------------------------------------------- #
#  Messaging helpers
# --------------------------------------------------------------------------- #

def push(pl: "Player | None", obj: dict) -> None:
    """Queue a message for one connection (serialised here, sent by its writer)."""
    if pl is not None:
        try:
            pl.q.put_nowait(json.dumps(obj))
        except Exception:
            pass


def push_all(obj: dict) -> None:
    """Serialise once, then fan the same payload out to every player."""
    data = json.dumps(obj)
    for pl in list(players.values()):
        try:
            pl.q.put_nowait(data)
        except Exception:
            pass


async def snapshot_loop() -> None:
    """Periodically broadcast the full game state to everyone."""
    while True:
        await asyncio.sleep(TICK)
        if not players:
            continue
        data = {"type": "snap", "players": [p.state() for p in players.values()]}
        push_all(data)


# --------------------------------------------------------------------------- #
#  Gameplay
# --------------------------------------------------------------------------- #

def pick_spawn() -> tuple[float, float]:
    for _ in range(10):
        sx, sz = random.choice(SPAWNS)
        if all(
            not (p.alive and (p.x - sx) ** 2 + (p.z - sz) ** 2 < 9.0)
            for p in players.values()
        ):
            return sx, sz
    return random.choice(SPAWNS)


async def respawn_player(victim: Player) -> None:
    try:
        await asyncio.sleep(RESPAWN_TIME)
    except asyncio.CancelledError:
        return
    if victim.id not in players:
        return
    victim.alive = True
    victim.hp = START_HP
    victim.y = 0.0
    victim.x, victim.z = pick_spawn()
    push_all({"type": "respawn", "id": victim.id, "p": [victim.x, victim.y, victim.z]})


def handle_shot(shooter: Player, data: dict) -> None:
    """Validate + apply a shot, then broadcast tracers / damage / kills."""
    if not shooter.alive:
        return
    now = time.monotonic()
    if now - shooter.last_shot < FIRE_COOLDOWN:
        return  # drop runaway clients
    shooter.last_shot = now

    origin = vec3(data.get("p")) or [shooter.x, shooter.y + 1.6, shooter.z]
    direction = vec3(data.get("d")) or [0.0, 0.0, -1.0]

    v_id = data.get("victim")
    victim = players.get(v_id) if isinstance(v_id, int) and not isinstance(v_id, bool) else None

    # only accept the claimed victim if the ray really passes near them
    if victim is not None and (
        victim is shooter
        or not victim.alive
        or not ray_hits_point(origin, direction, (victim.x, victim.y + 1.0, victim.z), 1.1)
    ):
        victim = None

    push_all({
        "type": "shot",
        "id": shooter.id,
        "p": origin,
        "d": direction,
        "victim": victim.id if victim else None,
    })

    if victim is None:
        return

    victim.hp -= DAMAGE
    victim.hp = max(0, victim.hp)
    push_all({"type": "hit", "shooter": shooter.id, "victim": victim.id,
              "damage": DAMAGE, "hp": victim.hp})

    if victim.hp <= 0:
        victim.alive = False
        shooter.kills += 1
        push_all({"type": "kill", "killer": shooter.id, "killerName": shooter.name,
                  "victim": victim.id, "victimName": victim.name})
        if victim.respawn_task and not victim.respawn_task.done():
            victim.respawn_task.cancel()
        victim.respawn_task = asyncio.create_task(respawn_player(victim))
    return



# --------------------------------------------------------------------------- #
#  Connection handling
# --------------------------------------------------------------------------- #

async def reader_loop(ws, pl: Player) -> None:
    async for raw in ws:
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        try:
            kind = data.get("type")
            if kind == "state":
                p = vec3(data.get("p"))
                if p is not None:
                    pl.x = clamp(p[0], -MAP_HALF, MAP_HALF)
                    pl.y = max(0.0, p[1])
                    pl.z = clamp(p[2], -MAP_HALF, MAP_HALF)
                ry = data.get("ry")
                if isinstance(ry, (int, float)) and not isinstance(ry, bool):
                    ry = float(ry)
                    if not math.isnan(ry) and not math.isinf(ry):
                        pl.ry = ry
            elif kind == "shoot":
                handle_shot(pl, data)
        except Exception:
            # a malformed message must never take the connection down
            continue


async def writer_loop(ws, q: asyncio.Queue) -> None:
    while True:
        payload = await q.get()          # already-serialised JSON text
        try:
            await ws.send(payload)
        except Exception:
            return


async def connection(ws) -> None:
    global _next_id
    q: asyncio.Queue = asyncio.Queue()

    # --- join handshake --------------------------------------------------- #
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("type") != "join":
            await ws.send(json.dumps({"type": "error", "msg": "send {type:join} first"}))
            return
    except Exception:
        return

    if len(players) >= MAX_PLAYERS:
        await ws.send(json.dumps({"type": "full"}))
        return

    name = str(data.get("name") or "").strip()[:16]
    if not name:
        name = f"Player{random.randint(100, 999)}"

    _next_id += 1
    pid = _next_id
    color = PALETTE[pid % len(PALETTE)]
    pl = Player(ws, pid, name, color, q)
    players[pid] = pl
    log.info("join: %s (#%d) — %d online", name, pid, len(players))

    push(pl, {"type": "welcome",
              "self": {"id": pid, "name": name, "color": color},
              "players": [p.state() for p in players.values()]})
    push_all({"type": "joined", "id": pid, "name": name, "color": color,
              "p": [pl.x, pl.y, pl.z], "ry": pl.ry})

    # --- run reader + writer until either finishes ------------------------ #
    writer = asyncio.create_task(writer_loop(ws, q))
    reader = asyncio.create_task(reader_loop(ws, pl))
    try:
        done, pending = await asyncio.wait({reader, writer},
                                           return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            try:
                t.result()
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        players.pop(pid, None)
        if pl.respawn_task and not pl.respawn_task.done():
            pl.respawn_task.cancel()
        push_all({"type": "left", "id": pid, "name": pl.name})
        try:
            await ws.close()
        except Exception:
            pass
        log.info("left: %s (#%d) — %d online", name, pid, len(players))


async def main() -> None:
    async with websockets.serve(connection, HOST, PORT,
                                max_size=65536,
                                ping_interval=20,
                                ping_timeout=20):
        log.info("Pulse Arena server listening on ws://%s:%d", HOST, PORT)
        snap = asyncio.create_task(snapshot_loop())
        try:
            await asyncio.Future()  # run forever
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            snap.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
