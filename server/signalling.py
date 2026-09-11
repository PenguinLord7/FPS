#!/usr/bin/env python3
"""
Pulse Arena — P2P signalling server
===================================
The match itself is peer-to-peer: players exchange game traffic directly over
WebRTC data channels.  This server only:

  * puts players into a named room
  * tells each newcomer which peers are already in the room
  * relays WebRTC offers / answers / ICE candidates between peers

No game state (positions, hits, kills) ever passes through here.

Run:
    pip install -r requirements.txt
    python signal.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import ssl

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("signal")

MAX_PEERS = 12

PALETTE = [
    "#ff5252", "#ffab40", "#ffee58", "#69f0ae",
    "#40c4ff", "#b388ff", "#f48fb1", "#80deea",
    "#a5d6a7", "#ffcc80", "#90a4ae", "#ef9a9a",
]

# room name -> {peer_id: Peer}
rooms: dict[str, dict[int, "Peer"]] = {}
_next_id = 0


class Peer:
    """One client connected to the signalling channel."""

    def __init__(self, pid: int, name: str, color: str, ws, room: str, q: asyncio.Queue):
        self.id = pid
        self.name = name
        self.color = color
        self.ws = ws
        self.room = room
        self.q = q

    def brief(self) -> dict:
        return {"id": self.id, "name": self.name, "color": self.color}


def push(peer: Peer, obj: dict) -> None:
    try:
        peer.q.put_nowait(json.dumps(obj))
    except Exception:
        pass


def broadcast(room: str, obj: dict, skip: int | None = None) -> None:
    data = json.dumps(obj)
    for p in list(rooms.get(room, {}).values()):
        if p.id == skip:
            continue
        try:
            p.q.put_nowait(data)
        except Exception:
            pass


async def writer(ws, q: asyncio.Queue) -> None:
    while True:
        payload = await q.get()
        try:
            await ws.send(payload)
        except Exception:
            return


async def reader(ws, peer: Peer) -> None:
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        if msg.get("type") == "signal":
            to = msg.get("to")
            if not isinstance(to, int) or isinstance(to, bool):
                continue
            target = rooms.get(peer.room, {}).get(to)
            if target is not None and target is not peer:
                push(target, {"type": "signal", "from": peer.id, "data": msg.get("data")})


async def connection(ws) -> None:
    global _next_id

    # --- join handshake --------------------------------------------------- #
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("type") != "join":
            await ws.send(json.dumps({"type": "error", "msg": "send {type:join} first"}))
            return
    except Exception:
        return

    room = str(data.get("room") or "arena").strip().lower()[:24] or "arena"
    name = str(data.get("name") or "").strip()[:16] or f"Player{random.randint(100, 999)}"

    members = rooms.setdefault(room, {})
    if len(members) >= MAX_PEERS:
        await ws.send(json.dumps({"type": "full", "msg": f"room '{room}' is full"}))
        return

    _next_id += 1
    pid = _next_id
    q: asyncio.Queue = asyncio.Queue()
    peer = Peer(pid, name, PALETTE[pid % len(PALETTE)], ws, room, q)
    members[pid] = peer
    log.info("join: %s (#%d) room=%s — %d in room", name, pid, room, len(members))

    others = [p.brief() for p in members.values() if p.id != pid]
    push(peer, {
        "type": "welcome",
        "self": {"id": pid, "name": name, "color": peer.color},
        "room": room,
        "peers": others,
    })
    broadcast(room, {"type": "peer-join", "id": pid, "name": name, "color": peer.color}, skip=pid)

    # --- relay signals until the socket closes ---------------------------- #
    w = asyncio.create_task(writer(ws, q))
    r = asyncio.create_task(reader(ws, peer))
    try:
        done, pending = await asyncio.wait({r, w}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    finally:
        members.pop(pid, None)
        if not members:
            rooms.pop(room, None)
        broadcast(room, {"type": "peer-leave", "id": pid, "name": name})
        try:
            await ws.close()
        except Exception:
            pass
        log.info("left: %s (#%d) room=%s — %d in room", name, pid, room, len(members))


async def main() -> None:
    ap = argparse.ArgumentParser(description="Pulse Arena P2P signalling server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--certfile", help="TLS certificate (PEM) to serve wss://")
    ap.add_argument("--keyfile", help="TLS private key (PEM) to serve wss://")
    args = ap.parse_args()

    ssl_ctx = None
    scheme = "ws"
    if args.certfile:
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(args.certfile, args.keyfile)
        scheme = "wss"

    async with websockets.serve(connection, args.host, args.port,
                                ssl=ssl_ctx,
                                max_size=1 << 20,
                                ping_interval=20,
                                ping_timeout=20):
        log.info("signalling server listening on %s://%s:%d", scheme, args.host, args.port)
        if scheme == "ws":
            log.info("note: pages served over HTTPS (e.g. GitHub Pages) can only reach wss:// — "
                     "pass --certfile/--keyfile, or tunnel this port")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
