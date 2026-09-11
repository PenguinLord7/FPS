#!/usr/bin/env python3
"""
Smoke test for the FPS relay server.

Assumes the relay server is already running (python server.py) on 127.0.0.1:8766.
Connects two fake clients, moves one, shoots the other until it dies, and
verifies the kill/respawn events arrive.
"""
import asyncio
import json
import sys
import time

import websockets

SERVER = "ws://127.0.0.1:8766"


async def collect(ws, seen, secs):
    end = time.time() + secs
    while time.time() < end:
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
        except asyncio.TimeoutError:
            continue
        except Exception:
            break
        data = json.loads(msg)
        seen.append(data)


async def main():
    results = {"hits": 0, "kills": 0, "snaps": 0, "respawns": 0}
    alice_msgs, bob_msgs = [], []

    async with websockets.connect(SERVER) as a, websockets.connect(SERVER) as b:
        await a.send(json.dumps({"type": "join", "name": "Alice"}))
        await b.send(json.dumps({"type": "join", "name": "Bob"}))

        # wait for welcome messages
        aw = json.loads(await asyncio.wait_for(a.recv(), timeout=5))
        bw = json.loads(await asyncio.wait_for(b.recv(), timeout=5))
        assert aw["type"] == "welcome", aw
        assert bw["type"] == "welcome", bw
        alice_id, bob_id = aw["self"]["id"], bw["self"]["id"]
        print(f"joined: alice={alice_id} bob={bob_id}")

        # start collectors
        a_task = asyncio.create_task(collect(a, alice_msgs, 5))
        b_task = asyncio.create_task(collect(b, bob_msgs, 5))

        # bob moves to a known spot, alice close by
        await b.send(json.dumps({"type": "state", "p": [0, 0, 0], "ry": 0}))
        await a.send(json.dumps({"type": "state", "p": [2, 0, 0], "ry": 3.14}))
        await asyncio.sleep(0.2)

        # a shot that claims a victim it isn't aimed at must be rejected
        await a.send(json.dumps({"type": "shoot", "victim": bob_id,
                                 "p": [0, 1.6, 40], "d": [0, 0, 1]}))
        await asyncio.sleep(0.35)
        bogus_hits = sum(1 for m in alice_msgs + bob_msgs if m["type"] == "hit")
        print("bogus hits rejected:", bogus_hits == 0)

        # alice shoots bob until the kill event arrives
        shot = {"type": "shoot", "victim": bob_id, "p": [2, 1.6, 0], "d": [-1, 0, 0]}
        for _ in range(5):
            await a.send(json.dumps(shot))
            await asyncio.sleep(0.16)

        await asyncio.sleep(3.6)  # allow the respawn timer to elapse
        a_task.cancel()
        b_task.cancel()

    for msg in alice_msgs + bob_msgs:
        t = msg["type"]
        if t == "hit":
            results["hits"] += 1
        elif t == "kill":
            results["kills"] += 1
        elif t == "snap":
            results["snaps"] += 1
        elif t == "respawn":
            results["respawns"] += 1

    print("summary:", results)
    ok = (results["kills"] >= 1 and results["hits"] >= 1
          and results["snaps"] > 0 and bogus_hits == 0)
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
