/* =====================================================================
 * P2P networking — WebRTC mesh.
 *
 * Game traffic flows directly between players over RTCDataChannels; the
 * Python signalling server only brokers the connection (offers/answers/ICE).
 *
 * Events: open, close, status, welcome, joined, left, snap, shot, hit, kill,
 * respawn, peerOpen
 * =================================================================== */
"use strict";

class P2PNet {
  constructor(url, name, opts) {
    this.url = url;
    this.name = name;
    this.room = (opts && opts.room) || "arena";
    this.iceServers = (opts && opts.iceServers) ||
      [{ urls: "stun:stun.l.google.com:19302" }];
    this.p2p = true;

    this.handlers = new Map();
    this.ws = null;              // signalling socket
    this.closed = false;
    this.connected = false;      // signalling reachable
    this.everConnected = false;
    this.failures = 0;
    this.selfId = null;
    this.color = "#ffffff";
    this.peers = new Map();      // peerId -> { id, name, color, pc, dc, open, pending, remoteSet }
    this.known = new Map();      // peerId -> { name, color } announced via signalling
    this._earlyCand = new Map(); // peerId -> ICE candidates that arrived before the SDP
    this._timer = null;
  }

  /* ---------------- event plumbing ---------------- */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, data) {
    const list = this.handlers.get(type);
    if (list) list.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  }

  /* ---------------- signalling connection ---------------- */
  connect() {
    this.closed = false;
    this.failures = 0;
    this.everConnected = false;
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

    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (!this.connected) this._reportOffline();
    }, 2500);

    ws.onopen = () => {
      clearTimeout(this._timer);
      this.connected = true;
      this.everConnected = true;
      this.failures = 0;
      this.emit("open");
      this._ws({ type: "join", name: this.name, room: this.room });
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && typeof m === "object" && m.type) this._signalMsg(m);
    };

    ws.onclose = () => {
      clearTimeout(this._timer);
      this.connected = false;
      // the signalling link is the session lifeline: if it goes, restart clean
      this._dropAllPeers();
      this.known.clear();
      this.emit("close");
      if (this.closed) return;

      this.failures++;
      this._reportOffline();
      const delay = this.everConnected
        ? Math.min(6000, 1000 * Math.pow(1.6, this.failures))
        : Math.min(4000, 1500 + this.failures * 500);
      setTimeout(() => this._open(), delay);
    };

    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  _reportOffline() {
    if (this.everConnected) {
      this.emit("status", { msg: "Signalling lost — reconnecting…", kind: "", offline: true });
    } else {
      this.emit("status", {
        msg: "Can't reach " + this.url + " — start the server with:  ./run.sh",
        kind: "err", offline: true,
      });
    }
  }

  /* ---------------- signalling messages ---------------- */
  _signalMsg(m) {
    switch (m.type) {
      case "welcome": {
        this.selfId = m.self.id;
        this.color = m.self.color;
        const peers = Array.isArray(m.peers) ? m.peers : [];
        peers.forEach((p) => this.known.set(p.id, { name: p.name, color: p.color }));
        this.emit("welcome", {
          self: m.self,
          room: m.room,
          players: peers.map((p) => this._placeholder(p)),
        });
        // the newcomer dials everyone already in the room (no offer glare)
        peers.forEach((p) => this._offerTo(p.id));
        break;
      }
      case "peer-join":
        if (m.id === this.selfId) break;
        this.known.set(m.id, { name: m.name, color: m.color });
        this.emit("joined", { id: m.id, name: m.name, color: m.color, p: [0, 0, 0], ry: 0 });
        break;   // we wait for their offer
      case "peer-leave":
        this._dropPeer(m.id);
        this.known.delete(m.id);
        this.emit("left", { id: m.id, name: m.name });
        break;
      case "signal":
        this._onSignal(m.from, m.data);
        break;
      case "full":
        this.emit("full", m);
        break;
      default:
        break;
    }
  }

  _placeholder(p) {
    return {
      id: p.id, name: p.name, color: p.color,
      p: [0, 0, 0], ry: 0, hp: 100, alive: true, kills: 0,
    };
  }

  /* ---------------- peer connections ---------------- */
  _offerTo(peerId) {
    const rec = this._ensurePeer(peerId, true);
    if (!rec || rec.offered) return null;
    rec.offered = true;

    const dc = rec.pc.createDataChannel("game", { ordered: true });
    this._bindChannel(rec, dc);

    rec.pc.createOffer()
      .then((offer) => rec.pc.setLocalDescription(offer))
      .then(() => this._ws({ type: "signal", to: peerId, data: { sdp: rec.pc.localDescription } }))
      .catch((e) => console.warn("offer failed", e));
    return rec;
  }

  _ensurePeer(peerId, createPc) {
    let rec = this.peers.get(peerId);
    if (rec) return rec;
    if (!createPc) return null;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const info = this.known.get(peerId) || { name: "peer " + peerId, color: "#90a4ae" };
    rec = {
      id: peerId, name: info.name, color: info.color,
      pc, dc: null, open: false, offered: false, pending: [], remoteSet: false,
    };
    this.peers.set(peerId, rec);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._ws({ type: "signal", to: peerId, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.emit("status", { msg: "Peer connection failed (" + rec.name + ")", kind: "err" });      }
    };
    pc.ondatachannel = (e) => this._bindChannel(rec, e.channel);
    return rec;
  }

  _bindChannel(rec, dc) {
    rec.dc = dc;
    dc.onopen = () => {
      rec.open = true;
      this.emit("status", { msg: "Peer connected: " + rec.name, kind: "good" });
      this.emit("peerOpen", { id: rec.id, name: rec.name, color: rec.color });
    };
    dc.onclose = () => { rec.open = false; };
    dc.onerror = () => { rec.open = false; };
    dc.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== "object" || !m.type) return;
      if (m.type === "state" && m.player) {
        // one peer's state looks exactly like a relay snapshot entry
        this.emit("snap", { players: [m.player] });
      } else {
        this.emit(m.type, m);
      }
    };
  }

  _onSignal(from, data) {
    if (!data) return;
    let rec = this.peers.get(from);

    if (data.sdp) {
      if (!rec) rec = this._ensurePeer(from, true);
      if (!rec) return;
      const pc = rec.pc;
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => {
          rec.remoteSet = true;
          // flush candidates that raced ahead of the SDP
          const early = this._earlyCand.get(from);
          if (early) {
            this._earlyCand.delete(from);
            early.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
          }
          rec.pending.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
          rec.pending = [];
          if (data.sdp.type === "offer") {
            return pc.createAnswer()
              .then((answer) => pc.setLocalDescription(answer))
              .then(() => this._ws({ type: "signal", to: from, data: { sdp: pc.localDescription } }));
          }
        })
        .catch((e) => console.warn("sdp failed", e));
    } else if (data.candidate) {
      const cand = new RTCIceCandidate(data.candidate);
      if (!rec) {
        // ICE can start before the SDP is delivered — keep the candidate for later
        const arr = this._earlyCand.get(from) || [];
        arr.push(cand);
        this._earlyCand.set(from, arr);
        return;
      }
      if (rec.remoteSet) rec.pc.addIceCandidate(cand).catch(() => {});
      else rec.pending.push(cand);
    }
  }

  _dropPeer(id) {
    const rec = this.peers.get(id);
    if (!rec) return;
    try { if (rec.dc) rec.dc.close(); } catch (e) { /* ignore */ }
    try { rec.pc.close(); } catch (e) { /* ignore */ }
    this.peers.delete(id);
    this._earlyCand.delete(id);
  }

  _dropAllPeers() {
    Array.from(this.peers.keys()).forEach((id) => this._dropPeer(id));
  }

  /* ---------------- messaging ---------------- */
  _ws(obj) {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  /* game traffic: broadcast straight to the other players */
  send(obj) {
    const text = JSON.stringify(obj);
    this.peers.forEach((rec) => {
      if (rec.dc && rec.dc.readyState === "open") {
        try { rec.dc.send(text); } catch (e) { /* ignore */ }
      }
    });
  }

  peerCount() {
    let n = 0;
    this.peers.forEach((rec) => { if (rec.open) n++; });
    return n;
  }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    this._dropAllPeers();
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
  }
}
