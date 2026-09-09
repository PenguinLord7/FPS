/* WebSocket wrapper with typed-message dispatch + auto-reconnect. */
"use strict";

class FPSNet {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.ws = null;
    this.handlers = new Map();
    this.retryDelay = 1000;
    this.closed = false;
    this.connected = false;
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
    this._open();
  }

  _open() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.emit("status", { msg: "Invalid server address", kind: "err" });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retryDelay = 1000;
      this.emit("open");
      this.send({ type: "join", name: this.name });
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.type) {
        this.emit(data.type, data);
        this.emit("message", data);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      if (this.closed) return;
      this.emit("status", { msg: "Connection lost — reconnecting…", kind: "" });
      setTimeout(() => this._open(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 1.6, 6000);
    };

    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  send(obj) {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  close() {
    this.closed = true;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
  }
}
