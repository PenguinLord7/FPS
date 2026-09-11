/* DOM / HUD helpers. Pure UI — no game logic here. */
"use strict";

const UI = {
  $: (id) => document.getElementById(id),

  // ---------- menu ----------
  readConfig() {
    const serverEl = this.$("server");
    const nameEl = this.$("name");
    return {
      name: (nameEl && nameEl.value || "").trim(),
      server: (serverEl && serverEl.value || "").trim(),
    };
  },

  /* "wss://host:8765/arena" -> { url: "wss://host:8765", room: "arena" } */
  parseServer(raw) {
    let s = (raw || "").trim();
    if (!s) return null;
    if (!/^[a-z]+:\/\//i.test(s)) s = (location.protocol === "https:" ? "wss://" : "ws://") + s;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    const room = decodeURIComponent(u.pathname.replace(/^\/+/, "")).trim() || CFG.p2p.defaultRoom;
    return { url: u.protocol + "//" + u.host, room: room, secure: u.protocol === "wss:" };
  },

  /* a sane starting value for wherever the page happens to be running */
  defaultServer() {
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      || location.protocol === "file:";
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    if (local) return "ws://localhost:8765/" + CFG.p2p.defaultRoom;
    return scheme + location.hostname + ":8765/" + CFG.p2p.defaultRoom;
  },

  rememberName() {
    try {
      const nameEl = this.$("name"), srvEl = this.$("server");
      if (nameEl) nameEl.value = localStorage.getItem("pa_name") || "";
      if (srvEl) srvEl.value = localStorage.getItem("pa_server") || this.defaultServer();
    } catch (e) { /* ignore */ }
  },

  saveSession(name, server) {
    try {
      localStorage.setItem("pa_name", name);
      localStorage.setItem("pa_server", server);
    } catch (e) { /* ignore */ }
  },
  showMenu() { this.$("menu").classList.remove("hidden"); },
  hideMenu() { this.$("menu").classList.add("hidden"); },
  setNet(status) {
    const el = this.$("netstatus");
    if (!el) return;
    el.className = status;
    el.textContent = status === "online" ? "● ONLINE"
      : status === "connecting" ? "● CONNECTING" : "● OFFLINE";
  },
  setAim(mode) {
    const el = this.$("aimstatus");
    if (!el) return;
    el.classList.toggle("hidden", mode !== "steer");
  },
  setMenuStatus(msg, cls) {
    const el = this.$("mstatus");
    el.textContent = msg || "";
    el.className = cls || "";
  },

  // ---------- toast ----------
  toast(msg, kind, ms) {
    const el = this.$("toast");
    el.textContent = msg;
    el.className = (kind ? "toast " + kind : "toast");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.add("hidden"), ms || 2600);
  },

  // ---------- HUD ----------
  hudShow() { this.$("hud").classList.remove("hidden"); },
  setHP(cur, max) {
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    this.$("hpfill").style.width = pct + "%";
    this.$("hptext").textContent = Math.ceil(cur);
    this.$("hpfill").style.background =
      pct > 50 ? "linear-gradient(90deg,#69f0ae,#3dd68c)"
        : pct > 25 ? "linear-gradient(90deg,#ffd54f,#ffb300)"
        : "linear-gradient(90deg,#ff5252,#d50000)";
  },
  setPlayerLabel(name, color, kills) {
    this.$("plabel").innerHTML =
      `<span style="color:${color}">■</span> ${esc(name)} <small>· ${kills} kills</small>`;
  },

  // ---------- feed ----------
  feedAdd(html) {
    const feed = this.$("feed");
    const div = document.createElement("div");
    div.className = "feed-item";
    div.innerHTML = html;
    feed.appendChild(div);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
    setTimeout(() => { div.classList.add("fade"); setTimeout(() => div.remove(), 900); }, 3200);
  },

  // ---------- scoreboard ----------
  renderScoreboard(rows) {
    const t = this.$("sbtable");
    t.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sb-row sb-head";
    head.innerHTML = `<span></span><span>player</span><span class="sb-num">HP</span><span class="sb-num">K</span>`;
    t.appendChild(head);
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "sb-row" + (r.self ? " self" : "");
      const hp = r.alive ? r.hp : 0;
      row.innerHTML =
        `<span class="sb-dot" style="background:${r.color}"></span>` +
        `<span class="sb-name">${esc(r.name)}</span>` +
        `<span class="sb-num ${r.alive ? "" : "sb-dead"}">${r.alive ? hp : "✝"}</span>` +
        `<span class="sb-num">${r.kills}</span>`;
      t.appendChild(row);
    });
  },
  scoreboard(show) { this.$("scoreboard").classList.toggle("hidden", !show); },

  // ---------- combat feedback ----------
  hitmark(kill) {
    const h = this.$("hitmarker");
    h.classList.remove("show", "kill");
    if (kill) h.classList.add("kill");
    void h.offsetWidth; // restart animation
    h.classList.add("show");
  },
  damage(amount) {
    const d = this.$("damage");
    d.style.opacity = Math.min(1, amount * 1.4);
    clearTimeout(this._dmgT);
    this._dmgT = setTimeout(() => { d.style.opacity = 0; }, 220);
  },
  setLowHp(on) {
    this.$("lowhp").style.opacity = on ? 1 : 0;
  },

  // ---------- death / respawn ----------
  showDeath(killerName) {
    const sub = this.$("deathsub");
    sub.innerHTML = killerName ? `Killed by <b>${esc(killerName)}</b>` : "Respawning…";
    this.$("death").classList.remove("hidden");
  },
  hideDeath() { this.$("death").classList.add("hidden"); },
  setDeathCount(n) { this.$("deathcount").textContent = n; },

  // ---------- pause ----------
  setPause(on) { this.$("pause").classList.toggle("hidden", !on); },

  bodyClass(name, on) { document.body.classList.toggle(name, on); },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
