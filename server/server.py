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

def push(pl: Player | None, obj: dict) -> None:
    if pl is not None:
        try:
            pl.q.put_nowait(obj)
        except Exception:
            pass


def push_all(obj: dict) -> None:
    for pl in list(players.values()):
        push(pl, obj)


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

    origin = data.get("p")
    if not (isinstance(origin, list) and len(origin) >= 3):
        origin = [shooter.x, shooter.y + 1.6, shooter.z]
    direction = data.get("d")
    if not (isinstance(direction, list) and len(direction) >= 3):
        direction = [0.0, 0.0, -1.0]

    v_id = data.get("victim")
    victim = players.get(v_id) if isinstance(v_id, int) else None

    push_all({
        "type": "shot",
        "id": shooter.id,
        "p": origin,
        "d": direction,
        "victim": victim.id if victim else None,
    })

    if victim is None or victim is shooter or not victim.alive:
        return
    dist = math.dist((shooter.x, shooter.y + 1, shooter.z),
                     (victim.x, victim.y + 1, victim.z))
    if dist > MAX_SHOT_RANGE:
        return

    victim.hp -= DAMAGE
    if victim.hp <= 0:
        victim.hp = 0
        victim.alive = False
        shooter.kills += 1
        push_all({"type": "hit", "shooter": shooter.id, "victim": victim.id,
                  "damage": DAMAGE, "hp": 0})
        push_all({"type": "kill", "killer": shooter.id, "killerName": shooter.name,
                  "victim": victim.id, "victimName": victim.name})
        if victim.respawn_task and not victim.respawn_task.done():
            victim.respawn_task.cancel()
        victim.respawn_task = asyncio.create_task(respawn_player(victim))
    else:
        push_all({"type": "hit", "shooter": shooter.id, "victim": victim.id,
                  "damage": DAMAGE, "hp": victim.hp})


# --------------------------------------------------------------------------- #
#  Connection handling
# --------------------------------------------------------------------------- #

async def reader_loop(ws, pl: Player) -> None:
    async for raw in ws:
        try:
            data = json.loads(raw)
        except Exception:
            continue
        kind = data.get("type")
        if kind == "state":
            p = data.get("p")
            if isinstance(p, list) and len(p) >= 3:
                pl.x = clamp(float(p[0]), -MAP_HALF, MAP_HALF)
                pl.y = max(0.0, float(p[1]))
                pl.z = clamp(float(p[2]), -MAP_HALF, MAP_HALF)
            ry = data.get("ry")
            if isinstance(ry, (int, float)):
                pl.ry = float(ry)
        elif kind == "shoot":
            handle_shot(pl, data)


async def writer_loop(ws, q: asyncio.Queue) -> None:
    while True:
        obj = await q.get()
        try:
            await ws.send(json.dumps(obj))
        except Exception:
            return


async def connection(ws) -> None:
    global _next_id
    q: asyncio.Queue = asyncio.Queue()

    # --- join handshake --------------------------------------------------- #
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        data = json.loads(raw)
        if data.get("type") != "join":
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
