/* WebSocket wrapper with typed-message dispatch + auto-reconnect. */
"use strict";

class FPSNet {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.ws = null;
    this.handlers = new Map();
    this.retryDelay = 1000;
    this.failures = 0;
    this.everConnected = false;
    this.closed = false;
    this.connected = false;
    this._timer = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, data) {
    const list = this.handlers.get(type);
    if (list) list.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  }

  connect() {
    this.closed = false;
    this.failures = 0;
    this.everConnected = false;
    this.retryDelay = 1000;
    this._open();
  }

  _open() {
    if (this.closed) return;

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.emit("status", { msg: "Invalid server address: " + this.url, kind: "err", fatal: true });
      this.closed = true;
      return;
    }
    this.ws = ws;

    // nudge the player if nothing is listening, instead of hanging silently
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (!this.connected) this._reportOffline();
    }, 2500);

    ws.onopen = () => {
      clearTimeout(this._timer);
      this.connected = true;
      this.everConnected = true;
      this.failures = 0;
      this.retryDelay = 1000;
      this.emit("open");
      this.send({ type: "join", name: this.name });
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && typeof data === "object" && data.type) {
        this.emit(data.type, data);
        this.emit("message", data);
      }
    };

    ws.onclose = () => {
      clearTimeout(this._timer);
      this.connected = false;
      this.emit("close");
      if (this.closed) return;

      this.failures++;
      this._reportOffline();

      // never give up: keep retrying so the game connects by itself once the
      // server is started (fast backoff at first, then a steady slow poll)
      const delay = this.everConnected
        ? this.retryDelay
        : Math.min(4000, 1500 + this.failures * 500);
      if (this.everConnected) this.retryDelay = Math.min(this.retryDelay * 1.6, 6000);
      setTimeout(() => this._open(), delay);
    };

    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  _reportOffline() {
    if (this.everConnected) {
      this.emit("status", { msg: "Connection lost — reconnecting…", kind: "", offline: true });
    } else {
      this.emit("status", {
        msg: "Can't reach " + this.url + " — start the server with:  python server.py",
        kind: "err", offline: true,
      });
    }
  }

  send(obj) {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
  }
}
