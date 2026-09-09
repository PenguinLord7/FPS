/* Tiny WebAudio synthesizer for all game sounds — no audio assets needed. */
"use strict";

const SFX = {
  ctx: null,
  master: null,

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  },

  _noiseBuffer(dur) {
    const c = this.ctx, n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },

  _env(gainNode, t0, a, peak, decay, end) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + decay);
    void end;
  },

  /* sharp gunshot: filtered noise + low thump */
  shoot() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuffer(0.12);
    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    f.Q.value = 0.8;
    const g = c.createGain();
    this._env(g, t, 0.002, 0.9, 0.12);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.14);

    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g2 = c.createGain();
    this._env(g2, t, 0.001, 0.7, 0.09);
    osc.connect(g2).connect(this.master);
    osc.start(t); osc.stop(t + 0.1);
  },

  hitmark() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "square"; osc.frequency.value = 1500;
    const g = c.createGain();
    this._env(g, t, 0.001, 0.22, 0.07);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.08);
  },

  hurt() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.18);
    const g = c.createGain();
    this._env(g, t, 0.01, 0.6, 0.2);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.22);
  },

  kill() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = c.createOscillator();
      osc.type = "triangle"; osc.frequency.value = freq;
      const g = c.createGain();
      this._env(g, t + i * 0.06, 0.005, 0.3, 0.12);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.06); osc.stop(t + i * 0.06 + 0.14);
    });
  },

  died() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.7);
    const g = c.createGain();
    this._env(g, t, 0.01, 0.6, 0.7);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.75);
  },

  spawn() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.15);
    const g = c.createGain();
    this._env(g, t, 0.01, 0.25, 0.2);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.22);
  },

  connect() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "triangle"; osc.frequency.value = 620;
    const g = c.createGain();
    this._env(g, t, 0.005, 0.18, 0.1);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.12);
  },

  click() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "square"; osc.frequency.value = 1000;
    const g = c.createGain();
    this._env(g, t, 0.001, 0.12, 0.05);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.06);
  },
};
