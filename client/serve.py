#!/usr/bin/env python3
"""
Static file server for the Pulse Arena client.

`python -m http.server` lets browsers heuristically cache .js/.css files, which
makes code edits look like they "didn't apply" (or throws errors from a stale
file). This serves the client with caching fully disabled.

    python3 client/serve.py --port 8000 --dir client
"""
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the launcher console readable


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dir", default="client")
    args = ap.parse_args()

    handler = functools.partial(NoCacheHandler, directory=args.dir)
    with ThreadingHTTPServer(("0.0.0.0", args.port), handler) as httpd:
        print(f"Serving {args.dir} on http://localhost:{args.port} (caching disabled)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
