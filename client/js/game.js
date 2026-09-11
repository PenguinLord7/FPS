/* =====================================================================
 * Pulse Arena — Three.js game client
 *  - first-person movement + collision on a simple blocky map
 *  - networked players interpolated from server snapshots
 *  - hitscan shooting with client raycast + server validation
 * =================================================================== */
"use strict";

/* ---------------- helpers ---------------- */
const CFG = window.CFG;
const EPS = 1e-3;

const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpNum = (a, b, t) => a + (b - a) * t;
const dampNum = (a, b, l, dt) => lerpNum(a, b, 1 - Math.exp(-l * dt));

function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* ---------------- engine + world ---------------- */
let renderer, scene, camera, container;
let blockMeshes = [];      // static geometry (visual + raycast blockers)
let colliders = [];        // axis-aligned footprints for player collision
let tracers = [];          // active tracer beams
let gunGroup, gunTip, muzzleSprite, muzzleLight, muzzleTex;
let clock;
let unloadBound = false;

const GUN_BASE = { x: 0.26, y: -0.30, z: -0.30 };  // viewmodel rest position

/* These need THREE, which is fetched at boot (with CDN fallbacks). They stay
 * undefined until initThreeRefs() runs — nothing may touch them before that, so
 * failing to load the engine can never stop the menu from responding. */
let UP, _fwd, _right, _want, _shootDir, _hitPoint, _muzzle, _traceDir, raycaster;

function initThreeRefs() {
  UP = new THREE.Vector3(0, 1, 0);
  clock = new THREE.Clock();
  _fwd = new THREE.Vector3();
  _right = new THREE.Vector3();
  _want = new THREE.Vector3();
  _shootDir = new THREE.Vector3();
  _hitPoint = new THREE.Vector3();
  _muzzle = new THREE.Vector3();
  _traceDir = new THREE.Vector3();
  raycaster = new THREE.Raycaster();
  state.pos = new THREE.Vector3(0, 0, 20);
  state.vel = new THREE.Vector3();
}

/* shared material palette (guns + player hands) */
const MATS = {};
function initMaterials() {
  MATS.body = new THREE.MeshStandardMaterial({ color: 0xd79a35, roughness: 0.72, metalness: 0.15, flatShading: true });
  MATS.bodyDark = new THREE.MeshStandardMaterial({ color: 0xb87f28, roughness: 0.78, metalness: 0.12, flatShading: true });
  MATS.metal = new THREE.MeshStandardMaterial({ color: 0x39434f, roughness: 0.5, metalness: 0.55, flatShading: true });
  MATS.metalDark = new THREE.MeshStandardMaterial({ color: 0x2b333c, roughness: 0.6, metalness: 0.5, flatShading: true });
  MATS.glove = new THREE.MeshStandardMaterial({ color: 0x2f3742, roughness: 0.85, flatShading: true });
}

/* ---------------- local player state ---------------- */
const state = {
  inGame: false,     // playing a session (menu hidden)
  connected: false,
  joined: false,
  selfId: null,
  name: "",
  color: "#ffffff",
  hp: 100,
  maxHp: 100,
  kills: 0,
  alive: true,
  pos: null,         // THREE.Vector3 — created with the engine (see initThreeRefs)
  vel: null,
  yaw: 0,            // default camera looks down -Z, toward arena centre
  pitch: 0,
  recoil: 0,
  vy: 0,
  onGround: true,
  keys: {},
  locked: false,
  steerMode: false,        // fallback aiming when pointer lock isn't available
  mouse: { x: 0, y: 0 },   // cursor position, used by steering
  fireHeld: false,
  lastShot: 0,
  shotsFired: 0,
  deathAt: 0,
  stateTimer: 0,
  uiTimer: 0,
  offline: false,
  offlineNotified: false,
  respawnAt: 0,        // when we respawn ourselves after a death
};

/* remote players keyed by server id */
const remotes = new Map();
let net = null;

/* ---------------- init ---------------- */
function initEngine() {
  initThreeRefs();
  container = document.getElementById("scene-container");

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b7d9);
  scene.fog = new THREE.Fog(0x87b7d9, 150, 340);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  // lights
  const hemi = new THREE.HemisphereLight(0xdff1ff, 0x50452e, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 0.85);
  sun.position.set(45, 80, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.camera.far = 250;
  scene.add(sun);
  scene.add(sun.target);

  buildWorld();
  initMaterials();
  buildGun();
  bindInput();
  window.addEventListener("resize", onResize);

  clock.start();
  requestAnimationFrame(tick);
}

function buildWorld() {
  // collider footprints for movement
  colliders = CFG.blocks.map((b) => ({
    minX: b.x - b.w / 2, maxX: b.x + b.w / 2,
    minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2,
  }));

  // textured ground
  const gcanvas = document.createElement("canvas");
  gcanvas.width = gcanvas.height = 256;
  const gctx = gcanvas.getContext("2d");
  gctx.fillStyle = "#5d6b52";
  gctx.fillRect(0, 0, 256, 256);
  gctx.fillStyle = "#68765a";
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
    if ((x + z) % 2 === 0) gctx.fillRect(x * 64, z * 64, 64, 64);
  }
  const gtex = new THREE.CanvasTexture(gcanvas);
  gtex.wrapS = gtex.wrapT = THREE.RepeatWrapping;
  gtex.repeat.set(24, 24);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.mapHalf * 2, CFG.mapHalf * 2),
    new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // blocks
  CFG.blocks.forEach((b, i) => {
    const isWall = b.w >= 8 || b.d >= 8;
    const color = isWall ? CFG.wallColor : CFG.crateColors[i % CFG.crateColors.length];
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mat);
    mesh.position.set(b.x, b.h / 2, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.block = true;
    scene.add(mesh);
    blockMeshes.push(mesh);
  });

  // a couple of glowing "energy" pillars for looks
  for (const [x, z] of [[-44, 44], [44, -44]]) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 8, 10),
      new THREE.MeshBasicMaterial({ color: 0x40c4ff })
    );
    m.position.set(x, 4, z);
    scene.add(m);
  }
}

/* ---------------- low-poly rifle --------------------------------------
 * Two-tone, faceted rifle based on the reference art:
 *   mustard-yellow upper/lower receiver, handguard, stock, pistol grip
 *   dark slate barrel, muzzle brake, rail, sights, magazine, buttpad
 * Models point down -Z.  detail: "high" (viewmodel) | "low" (remote players)
 * Returns { group, muzzle } where muzzle is the tracer/flash anchor.
 * ------------------------------------------------------------------- */
function buildRifle(detail) {
  const g = new THREE.Group();
  const high = detail !== "low";

  const box = (w, h, d, x, y, z, mat, rx) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // receiver body (yellow)
  box(0.085, 0.075, 0.34, 0, 0.025, -0.10, MATS.body);       // upper receiver
  box(0.085, 0.085, 0.30, 0, -0.065, -0.08, MATS.bodyDark);  // lower receiver

  // handguard with side slots (yellow)
  box(0.078, 0.090, 0.32, 0, 0.005, -0.44, MATS.body);
  if (high) {
    box(0.086, 0.030, 0.05, 0, 0.005, -0.34, MATS.bodyDark);
    box(0.086, 0.030, 0.05, 0, 0.005, -0.53, MATS.bodyDark);
  }

  // top picatinny rail + teeth (dark)
  box(0.050, 0.022, 0.60, 0, 0.082, -0.30, MATS.metalDark);
  if (high) {
    for (let i = 0; i < 8; i++)
      box(0.052, 0.014, 0.018, 0, 0.100, -0.02 - i * 0.072, MATS.metalDark);
  }

  // barrel + muzzle brake (dark)
  box(0.030, 0.030, 0.28, 0, 0.010, -0.70, MATS.metal);
  box(0.046, 0.046, 0.075, 0, 0.010, -0.875, MATS.metalDark);

  // iron sights (dark)
  box(0.020, 0.060, 0.020, 0, 0.100, -0.585, MATS.metalDark); // front post
  box(0.034, 0.042, 0.040, 0, 0.095, -0.055, MATS.metalDark); // rear

  // curved box magazine, trigger guard, angled pistol grip
  box(0.056, 0.165, 0.090, 0, -0.195, -0.155, MATS.metalDark, 0.30);
  box(0.016, 0.012, 0.075, 0, -0.125, -0.005, MATS.metalDark);
  box(0.055, 0.135, 0.075, 0, -0.165, 0.045, MATS.body, -0.42);

  // buffer tube + collapsible stock + buttpad
  box(0.042, 0.042, 0.13, 0, -0.010, 0.175, MATS.metalDark);
  box(0.062, 0.095, 0.20, 0, -0.020, 0.315, MATS.body);
  box(0.072, 0.150, 0.038, 0, -0.030, 0.432, MATS.metalDark);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.010, -0.96);
  g.add(muzzle);
  return { group: g, muzzle };
}

/* ---------------- first-person viewmodel ---------------- */
function buildGun() {
  gunGroup = new THREE.Group();

  const rifle = buildRifle("high");
  rifle.group.scale.setScalar(0.95);
  gunGroup.add(rifle.group);
  gunTip = rifle.muzzle;

  // gloved cube hands gripping the rifle
  const frontHand = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.115, 0.14), MATS.glove);
  frontHand.position.set(0, -0.075, -0.46);
  const backHand = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.125, 0.15), MATS.glove);
  backHand.position.set(0, -0.155, -0.02);
  gunGroup.add(frontHand, backHand);

  // placed right of centre and angled inward so the barrel converges on the crosshair
  gunGroup.position.set(GUN_BASE.x, GUN_BASE.y, GUN_BASE.z);
  gunGroup.rotation.y = 0.10;

  // muzzle flash sprite + light, parented to the muzzle so recoil carries them
  const mc = document.createElement("canvas");
  mc.width = mc.height = 64;
  const mx = mc.getContext("2d");
  const grad = mx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,214,120,0.9)");
  grad.addColorStop(1, "rgba(255,150,40,0)");
  mx.fillStyle = grad; mx.fillRect(0, 0, 64, 64);
  muzzleTex = new THREE.CanvasTexture(mc);

  muzzleSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: muzzleTex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  muzzleSprite.scale.set(0.5, 0.5, 1);
  gunTip.add(muzzleSprite);

  muzzleLight = new THREE.PointLight(0xffb25c, 0, 10, 2);
  gunTip.add(muzzleLight);

  camera.add(gunGroup);
}

function gunTipWorld(out) {
  gunTip.getWorldPosition(out);
  return out;
}

/* ---------------- menu / session ---------------- */
function wireMenu() {
  if (wireMenu._bound) return;
  wireMenu._bound = true;
  UI.rememberName();

  const play = () => {
    try {
      startFromMenu();
    } catch (err) {
      console.error(err);
      UI.setMenuStatus("Could not start: " + (err && err.message ? err.message : err), "err");
    }
  };
  const btn = document.getElementById("play");
  const nameEl = document.getElementById("name");
  const srvEl = document.getElementById("server");
  if (btn) btn.addEventListener("click", play);
  if (nameEl) nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") play(); });
  if (srvEl) srvEl.addEventListener("keydown", (e) => { if (e.key === "Enter") play(); });

  const pause = document.getElementById("pause");
  if (pause) pause.addEventListener("click", lockPointer);
}

/* Returns an error message for a bad target, or null when it's usable. */
function validateTarget(target) {
  if (!target) {
    return "That server address doesn't look right. Use host:port/room — e.g. wss://my-host:8765/arena";
  }
  if (!target.secure && location.protocol === "https:") {
    return "This page is served over HTTPS, so the server must be wss:// (secure WebSocket). " +
           "Plain ws:// is blocked by the browser on HTTPS pages.";
  }
  if (location.hostname.endsWith("github.io") && /(^|\.)github\.io$/i.test(target.url)) {
    return "GitHub Pages can only serve static files — it can't run the signalling server. " +
           "Point the address at a signalling server you run (see README).";
  }
  return null;
}

function startFromMenu() {
  const cfg = UI.readConfig();
  if (!cfg.name) { UI.setMenuStatus("Please enter a nickname.", "err"); return; }
  if (!window.THREE) {
    UI.setMenuStatus("The 3D engine hasn't loaded yet (or failed to). Check your connection and reload.", "err");
    return;
  }

  const target = UI.parseServer(cfg.server);
  const problem = validateTarget(target);
  if (problem) { UI.setMenuStatus(problem, "err"); return; }

  UI.saveSession(cfg.name, cfg.server);
  SFX.ensure();
  SFX.click();
  UI.setMenuStatus("", "");
  beginSession(cfg.name, target);
}

function beginSession(name, target) {
  UI.hideMenu();
  UI.hudShow();
  UI.setHP(state.maxHp, state.maxHp);
  state.inGame = true;
  state.name = name;
  state.stateTimer = 0;
  state.uiTimer = 0;
  state.fireHeld = false;
  state.keys = {};
  state.respawnAt = 0;

  if (net) { try { net.close(); } catch (e) { /* ignore */ } net = null; }

  net = new P2PNet(target.url, name, {
    room: target.room,
    iceServers: CFG.p2p.iceServers,
  });
  wireNet(net);
  net.connect();
  UI.setNet("connecting");
  UI.toast("Joining room '" + target.room + "' via " + target.url + " …", "", 2600);
  lockPointer();
}

function lockPointer() {
  if (!renderer) return;
  if (state.steerMode && !state.locked) return; // steering is explicitly enabled
  const el = renderer.domElement;
  if (document.pointerLockElement === el) return;
  if (!el.requestPointerLock) { enableSteering(); return; }
  let res;
  try { res = el.requestPointerLock(); } catch (e) { enableSteering(); return; }
  // Chrome returns a promise — a rejection means we can't capture the mouse
  if (res && typeof res.catch === "function") res.catch(() => enableSteering());

  // some embedded browsers fail silently: if the lock never arrives, fall back
  clearTimeout(lockPointer._t);
  lockPointer._t = setTimeout(() => {
    if (!state.locked && state.inGame) enableSteering();
  }, 800);
}

/* Pointer lock is blocked in iframes / embedded browsers. Rather than leaving
   the player unable to aim or shoot, switch to cursor-steering: the view turns
   while the cursor is away from the centre of the screen. */
function enableSteering() {
  if (state.steerMode) return;
  state.steerMode = true;
  UI.setAim("steer");
  UI.toast("Mouse capture unavailable — aim by moving the cursor away from the centre. Press V to retry.", "", 7000);
}

function steerAim(dt) {
  if (state.locked || !state.steerMode) return;
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  const nx = (state.mouse.x - cx) / Math.max(1, cx);
  const ny = (state.mouse.y - cy) / Math.max(1, cy);
  const dz = CFG.steer.dead;
  const rx = Math.sign(nx) * Math.max(0, Math.abs(nx) - dz) / (1 - dz);
  const ry = Math.sign(ny) * Math.max(0, Math.abs(ny) - dz) / (1 - dz);
  state.yaw -= rx * CFG.steer.yawRate * dt;
  state.pitch -= ry * CFG.steer.pitchRate * dt;
}

/* Tear the session down and show the menu again (fatal connect errors, kick, …) */
function returnToMenu() {
  if (net) { try { net.close(); } catch (e) { /* ignore */ } net = null; }
  clearRemotes();
  clearTracers();
  state.inGame = false;
  state.connected = false;
  state.joined = false;
  state.alive = true;
  state.deathAt = 0;
  state.respawnAt = 0;
  state.fireHeld = false;
  state.keys = {};
  UI.hideDeath();
  UI.setPause(false);
  if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
  UI.showMenu();
}

/* ---------------- networking ---------------- */
function wireNet(n) {
  n.on("open", () => {
    state.connected = true;
    state.offline = false;
    state.offlineNotified = false;
    UI.setNet("connecting");
    UI.toast("Connected — awaiting spawn…", "good", 1500);
  });

  n.on("close", () => {
    state.connected = false;
    state.joined = false;
    state.offline = true;
    UI.setNet("offline");
  });

  n.on("status", (s) => {
    if (!state.inGame) return;
    if (s.offline) {
      UI.setNet("offline");
      // only surface the failure once per outage instead of on every retry
      if (!state.offlineNotified) {
        state.offlineNotified = true;
        UI.toast(s.msg, s.kind || "", 6000);
      }
    } else {
      UI.toast(s.msg, s.kind || "", 2200);   // informational (e.g. peer connected)
    }
    if (s.fatal) returnToMenu();
  });

  n.on("welcome", (m) => {
    // assign ALL session state first — UI calls must never be able to abort it
    state.joined = true;
    state.connected = true;
    state.offline = false;
    state.offlineNotified = false;
    state.selfId = m.self.id;
    state.name = m.self.name;
    state.color = m.self.color;
    state.hp = state.maxHp;
    state.kills = 0;
    state.alive = true;
    state.deathAt = 0;
    // fresh session: clear remotes (new player id may differ after reconnect)
    clearRemotes();
    m.players.forEach(syncFromSnap);

    UI.setNet("online");
    UI.hideDeath();
    UI.setHP(state.maxHp, state.maxHp);
    SFX.spawn();
    UI.toast(`Welcome, ${m.self.name}!`, "good", 1800);
  });

  n.on("full", () => {
    UI.setMenuStatus("Server is full — try again soon.", "err");
    UI.toast("Server is full — try again soon.", "err", 3500);
    returnToMenu();
  });
  n.on("error", () => {});

  n.on("joined", (m) => {
    if (m.id === state.selfId) return;
    // no model yet — that appears when they actually send state over the data
    // channel, otherwise a peer that fails to connect shows as a ghost at 0,0,0
    UI.feedAdd(`<span style="color:${m.color}">${esc(m.name)}</span> joined the arena`);
  });

  n.on("left", (m) => {
    removeRemote(m.id);
    if (m.id !== state.selfId)
      UI.feedAdd(`<span style="color:#8b96a8">${esc(m.name)}</span> left`);
  });

  n.on("snap", (m) => {
    m.players.forEach(syncFromSnap);
  });

  n.on("shot", (m) => {
    if (m.id === state.selfId) return; // already drew our own tracer
    spawnRemoteTracer(m);
  });

  n.on("hit", (m) => {
    if (m.victim === state.selfId) {
      state.hp = m.hp;
      UI.setHP(state.hp, state.maxHp);
      UI.damage(m.damage / 100);
      SFX.hurt();
    }
  });

  n.on("kill", (m) => {
    const kv = m.killer === state.selfId ? "You" : m.killerName;
    const vv = m.victim === state.selfId ? "you" : m.victimName;
    UI.feedAdd(
      `<span style="color:${colorOf(m.killer)}">${esc(kv)}</span>` +
      `<span style="color:#8b96a8"> ✕ </span>` +
      `<span style="color:${colorOf(m.victim)}">${esc(vv)}</span>`
    );
    if (m.victim === state.selfId) {
      localDeath(m.killer === state.selfId ? null : m.killerName);
    } else if (m.killer === state.selfId) {
      UI.hitmark(true);
      SFX.kill();
      state.kills++;   // we're the authority on our own score
    }
    // hide the remote victim right away (the victim told everyone it died)
    const victimRemote = remotes.get(m.victim);
    if (victimRemote) { victimRemote.alive = false; victimRemote.hp = 0; victimRemote.lastHp = -1; }
  });

  n.on("respawn", (m) => {
    if (m.id === state.selfId) {
      localRespawn(m.p);
    } else {
      const r = remotes.get(m.id);
      if (r) { r.alive = true; r.hp = state.maxHp; r.tpos.set(m.p[0], m.p[1], m.p[2]); r.lastHp = -1; }
    }
  });

  // ---- P2P only ------------------------------------------------------- //
  // There is no server to arbitrate in P2P, so the *victim* owns its own HP:
  // peers send us their shots and we decide whether we were hit. That keeps
  // each player's health out of everyone else's hands.
  if (n.p2p) {
    n.on("shoot", onPeerShot);
    n.on("peerOpen", (p) => {
      UI.feedAdd(`<span style="color:${p.color}">${esc(p.name)}</span> connected (direct)`);
    });
  }

  if (!unloadBound) {
    unloadBound = true;
    window.addEventListener("beforeunload", () => { if (net) net.close(); });
  }
}

/* ---------------------------------------------------------------------
 * Peer-to-peer combat
 * ------------------------------------------------------------------- */

/* shortest distance between a ray and a point (mirrors the relay server) */
function rayNearPoint(origin, dir, point, radius) {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  let dx = dir[0], dy = dir[1], dz = dir[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return false;
  dx /= len; dy /= len; dz /= len;
  const px = point[0] - ox, py = point[1] - oy, pz = point[2] - oz;
  const t = px * dx + py * dy + pz * dz;
  if (t < 0 || t > CFG.weapon.range) return false;
  const cx = px - t * dx, cy = py - t * dy, cz = pz - t * dz;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) <= radius;
}

/* a peer says they hit us — validate it against where we actually are */
function onPeerShot(m) {
  if (!state.alive) return;
  if (m.victim !== state.selfId) return;
  if (!Array.isArray(m.p) || !Array.isArray(m.d)) return;
  const me = [state.pos.x, state.pos.y + 1.0, state.pos.z];
  if (!rayNearPoint(m.p, m.d, me, 1.6)) return;   // ignore wild claims
  takeDamage(m.id, CFG.weapon.damage);
}

function takeDamage(shooterId, dmg) {
  state.hp = Math.max(0, state.hp - dmg);
  UI.setHP(state.hp, state.maxHp);
  UI.setLowHp(state.hp <= 30);
  UI.damage(dmg / 100);
  SFX.hurt();
  net.send({ type: "hit", shooter: shooterId, victim: state.selfId, damage: dmg, hp: state.hp });

  if (state.hp > 0) return;

  const shooter = remotes.get(shooterId);
  const shooterName = shooter ? shooter.name : "another player";
  net.send({
    type: "kill", killer: shooterId, killerName: shooterName,
    victim: state.selfId, victimName: state.name,
  });
  localDeath(shooterName);
  // we own our own respawn in P2P
  state.respawnAt = performance.now() + CFG.respawnTime * 1000;
}

function randomSpawn() {
  const list = CFG.spawns;
  const pick = list[(Math.random() * list.length) | 0];
  return [pick[0], 0, pick[1]];
}

/* our own state, in the same shape as a relay snapshot entry */
function buildSelfState() {
  return {
    id: state.selfId, name: state.name, color: state.color,
    p: [state.pos.x, state.pos.y, state.pos.z],
    ry: state.yaw, hp: state.hp, alive: state.alive, kills: state.kills,
  };
}

function colorOf(id) {
  if (id === state.selfId) return state.color;
  const r = remotes.get(id);
  return r ? r.color : "#ffffff";
}

function syncFromSnap(e) {
  if (e.id === state.selfId) {
    state.hp = e.hp;
    state.kills = e.kills;
    UI.setHP(state.hp, state.maxHp);
    UI.setLowHp(state.hp <= 30 && state.alive);
    if (!e.alive && state.alive) {
      localDeath(null); // missed the kill event somehow
    } else if (e.alive && !state.alive && state.deathAt) {
      // respawned (fallback if the respawn event was missed)
      if (e.hp >= state.maxHp) localRespawn(e.p);
    }
    return;
  }
  const r = ensureRemote(e);
  r.tpos.set(e.p[0], e.p[1], e.p[2]);
  r.try_ = e.ry || 0;
  r.name = e.name;
  r.color = e.color;
  r.hp = e.hp;
  r.kills = e.kills;
  r.alive = e.alive !== false;
}

function clearRemotes() {
  remotes.forEach((r) => disposeRemote(r));
  remotes.clear();
}

/* ---------------- remote players ---------------- */
function makeTag() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 96;
  const ctx = cv.getContext("2d");
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  spr.scale.set(3.4, 1.28, 1);
  const refresh = (name, color, hp, max) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = '700 42px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 9; ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(name, 128, 24);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, 128, 24);
    // hp bar
    const bw = 190, bh = 16, bx = (256 - bw) / 2, by = 64;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(bx, by, bw, bh);
    const pct = clampNum(hp / max, 0, 1);
    ctx.fillStyle = pct > 0.5 ? "#69f0ae" : pct > 0.25 ? "#ffd54f" : "#ff5252";
    if (pct > 0) ctx.fillRect(bx + 2, by + 2, (bw - 4) * pct, bh - 4);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    tex.needsUpdate = true;
  };
  return { spr, refresh, tex };
}

function createRemote(info) {
  const g = new THREE.Group();
  const col = new THREE.Color(info.color || 0xff5252);
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.75, flatShading: true });

  // --- capsule body (cylinder + rounded caps; r128 has no CapsuleGeometry) ---
  const radius = 0.4, cylH = 1.0;
  const capsule = new THREE.Group();
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, cylH, 10, 1), bodyMat);
  cyl.position.y = radius + cylH / 2;
  const topCap = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 6), bodyMat);
  topCap.position.y = radius + cylH;
  const botCap = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 6), bodyMat);
  botCap.position.y = radius;
  [cyl, topCap, botCap].forEach((m) => { m.castShadow = true; capsule.add(m); });
  g.add(capsule);

  // --- floating cube hands out front, holding the rifle ---
  const handGeo = new THREE.BoxGeometry(0.13, 0.13, 0.15);
  const frontHand = new THREE.Mesh(handGeo, MATS.glove);
  frontHand.position.set(0, 0.99, -0.47);
  const backHand = new THREE.Mesh(handGeo, MATS.glove);
  backHand.position.set(0, 0.89, -0.15);
  frontHand.castShadow = backHand.castShadow = true;
  g.add(frontHand, backHand);

  const rifle = buildRifle("low");
  rifle.group.scale.setScalar(0.62);
  rifle.group.position.set(0, 0.99, -0.32);
  g.add(rifle.group);

  // --- invisible hit proxies covering the capsule ---
  const hitSpheres = [];
  const mk = (r, y) => {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(r, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, visible: false })
    );
    p.position.y = y;
    p.userData.isProxy = true;
    p.userData.id = info.id;
    p.visible = false;
    g.add(p);
    hitSpheres.push(p);
    return p;
  };
  mk(0.46, 0.45);   // legs / lower body
  mk(0.46, 0.95);   // torso
  mk(0.43, 1.42);   // shoulders
  mk(0.34, 1.74);   // head

  const tag = makeTag();
  tag.spr.position.y = 2.35;
  g.add(tag.spr);

  scene.add(g);

  const rec = {
    id: info.id, group: g, tag, bodyMat, hitSpheres,
    name: info.name || "?",
    color: info.color || "#ff5252",
    pos: recPos(info),
    tpos: recPos(info),
    ry: info.ry || 0,
    try_: info.ry || 0,
    hp: info.hp != null ? info.hp : 100,
    alive: info.alive !== false,
    kills: info.kills || 0,
    lastHp: -1,
    lastAlive: null,
    lastName: null,
  };
  g.position.copy(rec.pos);
  g.rotation.y = rec.ry;
  refreshTag(rec);
  return rec;
}
function recPos(info) {
  const p = info.p;
  return new THREE.Vector3(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
}

function ensureRemote(info) {
  let r = remotes.get(info.id);
  if (!r) {
    r = createRemote(info);
    remotes.set(info.id, r);
  }
  return r;
}

function refreshTag(r) {
  if (r.hp === r.lastHp && r.alive === r.lastAlive && r.name === r.lastName) return;
  r.lastHp = r.hp; r.lastAlive = r.alive; r.lastName = r.name;
  r.tag.refresh(r.name, r.color, r.alive ? r.hp : 0, state.maxHp);
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { disposeRemote(r); remotes.delete(id); }
}

function disposeRemote(r) {
  scene.remove(r.group);
  // geometry is per-player, but materials are shared (MATS) — never dispose those
  r.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  if (r.bodyMat) r.bodyMat.dispose();
  if (r.tag) {
    if (r.tag.spr && r.tag.spr.material) r.tag.spr.material.dispose();
    if (r.tag.tex) r.tag.tex.dispose();
  }
}

function updateRemote(r, dt) {
  const k = 1 - Math.exp(-dt * 14);
  if (r.pos.distanceToSquared(r.tpos) > 2500) r.pos.copy(r.tpos); // teleport (respawn)
  r.pos.lerp(r.tpos, k);
  r.ry = angleLerp(r.ry, r.try_, k);
  r.group.position.copy(r.pos);
  r.group.rotation.y = r.ry;
  const vis = r.alive;
  if (r.group.visible !== vis) r.group.visible = vis;
  refreshTag(r);
}

/* ---------------- local physics / collision ---------------- */
function overlapX(x, z) {
  const R = CFG.radius;
  for (const c of colliders) {
    if (x + R > c.minX && x - R < c.maxX && z + R > c.minZ && z - R < c.maxZ) return true;
  }
  return false;
}
function overlapZ(x, z) {
  const R = CFG.radius;
  for (const c of colliders) {
    if (z + R > c.minZ && z - R < c.maxZ && x + R > c.minX && x - R < c.maxX) return true;
  }
  return false;
}

function moveAxisX(p, dx) {
  if (!dx) return;
  const R = CFG.radius, B = CFG.mapHalf - R;
  const target = p.x + dx;
  if (!overlapX(target, p.z)) { p.x = target; return; }
  let best = dx > 0 ? B : -B;
  for (const c of colliders) {
    if (p.z + R <= c.minZ || p.z - R >= c.maxZ) continue;
    if (dx > 0) best = Math.min(best, c.minX - R - EPS);
    else best = Math.max(best, c.maxX + R + EPS);
  }
  p.x = dx > 0 ? Math.max(p.x, Math.min(target, best)) : Math.min(p.x, Math.max(target, best));
}
function moveAxisZ(p, dz) {
  if (!dz) return;
  const R = CFG.radius, B = CFG.mapHalf - R;
  const target = p.z + dz;
  if (!overlapZ(p.x, target)) { p.z = target; return; }
  let best = dz > 0 ? B : -B;
  for (const c of colliders) {
    if (p.x + R <= c.minX || p.x - R >= c.maxX) continue;
    if (dz > 0) best = Math.min(best, c.minZ - R - EPS);
    else best = Math.max(best, c.maxZ + R + EPS);
  }
  p.z = dz > 0 ? Math.max(p.z, Math.min(target, best)) : Math.min(p.z, Math.max(target, best));
}

function physics(dt) {
  if (!state.inGame || !state.alive) {
    state.vel.set(0, 0, 0);
    state.vy = 0;
    _want.set(0, 0, 0);
    return;
  }
  const k = state.keys;

  // Ground-plane basis derived straight from yaw. We deliberately don't read the
  // camera matrix here: the camera is positioned *after* physics each frame, so
  // reading it would make every shot/tracer a frame stale (the "bullet dragged
  // behind / off to the side while sprinting" bug).
  _fwd.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  _right.crossVectors(_fwd, UP).normalize();

  const mx = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
  const mz = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
  _want.set(0, 0, 0).addScaledVector(_fwd, mz).addScaledVector(_right, mx);
  if (_want.lengthSq() > 0) {
    _want.normalize();
    const sp = (k.ShiftLeft || k.ShiftRight) ? CFG.speedRun : CFG.speedWalk;
    _want.multiplyScalar(sp);
  }
  state.vel.x = dampNum(state.vel.x, _want.x, 10, dt);
  state.vel.z = dampNum(state.vel.z, _want.z, 10, dt);

  moveAxisX(state.pos, state.vel.x * dt);
  moveAxisZ(state.pos, state.vel.z * dt);

  // gravity + jump
  if (k.Space && state.onGround) { state.vy = CFG.jumpVel; state.onGround = false; }
  state.vy -= CFG.gravity * dt;
  state.pos.y += state.vy * dt;
  if (state.pos.y <= 0) {
    if (state.vy < 0) state.vy = 0;
    state.pos.y = 0;
    state.onGround = true;
  }
}

/* ---------------- camera ---------------- */
let eyeCur = CFG.eye;

function applyCamera(dt) {
  const targetEye = state.alive ? CFG.eye : 0.6;
  eyeCur = dampNum(eyeCur, targetEye, 8, dt);

  state.pitch = clampNum(state.pitch, -CFG.pitchMax, CFG.pitchMax);
  state.recoil = dampNum(state.recoil, 0, 9, dt);

  camera.position.set(state.pos.x, state.pos.y + eyeCur, state.pos.z);
  camera.rotation.set(state.pitch + state.recoil, state.yaw, 0);
  camera.updateMatrixWorld(true);

  // gun sway while moving + visible recoil kick (offsets applied on top of rest pose)
  const moving = state.alive && (_want.x !== 0 || _want.z !== 0) && state.onGround;
  const bob = moving ? Math.sin(clock.elapsedTime * 9) * 0.012 : 0;
  gunGroup.position.set(
    GUN_BASE.x + bob * 0.6,
    GUN_BASE.y + bob * 0.5,
    GUN_BASE.z + state.recoil * 0.5
  );
  gunGroup.rotation.x = -state.recoil * 0.6;
}

/* ---------------- shooting ---------------- */
function liveProxies() {
  const arr = [];
  remotes.forEach((r) => { if (r.alive) arr.push(...r.hitSpheres); });
  return arr;
}

function tryShoot() {
  const now = performance.now();
  if (!state.alive || now - state.lastShot < CFG.weapon.cooldown * 1000) return;
  state.lastShot = now;
  state.shotsFired++;

  // ray straight out of the (just-updated) camera through the crosshair
  camera.getWorldDirection(_shootDir);
  raycaster.set(camera.position, _shootDir);
  raycaster.near = 0;
  raycaster.far = CFG.weapon.range;

  const hits = raycaster.intersectObjects(blockMeshes.concat(liveProxies()), false);

  let victimId = null;
  if (hits.length) {
    const h = hits[0];
    if (h.object.userData.isProxy) victimId = h.object.userData.id;
    _hitPoint.copy(h.point);
  } else {
    _hitPoint.copy(camera.position).addScaledVector(_shootDir, CFG.weapon.range);
  }

  // tracer runs from the current muzzle to the impact point
  gunTipWorld(_muzzle);
  if (_muzzle.distanceToSquared(_hitPoint) > 0.09) {
    spawnTracer(_muzzle, _hitPoint, CFG.weapon.tracerColor);
  }

  // muzzle flash + recoil kick
  muzzleSprite.material.opacity = 1;
  muzzleSprite.rotation.z = Math.random() * Math.PI;
  muzzleLight.intensity = 2.4;
  state.recoil += 0.012 + Math.random() * 0.005;

  SFX.shoot();
  net.send({
    type: "shoot",
    id: state.selfId,
    victim: victimId,
    p: [camera.position.x, camera.position.y, camera.position.z],
    d: [_shootDir.x, _shootDir.y, _shootDir.z],
    ry: state.yaw,
  });

  if (victimId) { UI.hitmark(false); SFX.hitmark(); }
}

/* tracer bullets
 * A short streak that travels from the muzzle to the impact point, then is
 * removed. This matters: a full-length beam frozen in world space gets "left
 * behind" when you sprint, so the bullet appears dragged backwards or off to
 * one side. A moving streak always flies away from the gun. */
function spawnTracer(from, to, color) {
  const dir = _traceDir.copy(to).sub(from);
  const dist = dir.length();
  if (dist < 0.4) return;
  dir.normalize();

  // never let bullets accumulate, whatever else happens
  while (tracers.length >= CFG.weapon.tracerMax) {
    const old = tracers.shift();
    scene.remove(old.mesh);
    old.mesh.material.dispose();
  }

  const life = clampNum(dist / CFG.weapon.tracerSpeed,
                        CFG.weapon.tracerLifeMin, CFG.weapon.tracerLifeMax);
  const streak = clampNum(dist * CFG.weapon.tracerStreak, 1.0, 5.0);

  const mat = new THREE.MeshBasicMaterial({
    color: color, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 6, 1, true), mat);
  mesh.quaternion.setFromUnitVectors(UP, dir);
  mesh.renderOrder = 5;
  scene.add(mesh);

  tracers.push({
    mesh,
    origin: from.clone(),
    dir: dir.clone(),
    dist,
    streak,
    speed: dist / life,
    traveled: 0,
  });
}

/* drop every live bullet (death, respawn, leaving the arena) */
function clearTracers() {
  for (const tr of tracers) {
    scene.remove(tr.mesh);
    tr.mesh.material.dispose();
  }
  tracers.length = 0;
}

function spawnRemoteTracer(m) {
  if (!Array.isArray(m.p) || !Array.isArray(m.d)) return;
  const from = new THREE.Vector3(m.p[0], m.p[1], m.p[2]);
  const dir = new THREE.Vector3(m.d[0], m.d[1], m.d[2]);
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();

  raycaster.set(from, dir);
  raycaster.near = 0;
  raycaster.far = CFG.weapon.range;
  const hits = raycaster.intersectObjects(blockMeshes, false);

  const to = hits.length
    ? hits[0].point.clone()
    : from.clone().addScaledVector(dir, CFG.weapon.range);
  const start = from.clone().addScaledVector(dir, 0.5);
  spawnTracer(start, to, 0xffca6e);
}

function updateFX(dt) {
  // bullets: advance each streak along its own path, then remove it on impact
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.traveled += tr.speed * dt;

    if (tr.traveled >= tr.dist) {           // reached the impact point
      scene.remove(tr.mesh);
      tr.mesh.material.dispose();
      tracers.splice(i, 1);
      continue;
    }

    const head = tr.traveled;                       // leading edge
    const tail = Math.max(0, head - tr.streak);     // trailing edge
    const len = Math.max(0.001, head - tail);
    tr.mesh.position.copy(tr.origin).addScaledVector(tr.dir, (head + tail) * 0.5);
    tr.mesh.scale.set(1, len, 1);
    // subtle fade over the last third so it vanishes cleanly
    tr.mesh.material.opacity = clampNum((1 - tr.traveled / tr.dist) * 3, 0, 1);
  }
  // muzzle flash
  if (muzzleSprite.material.opacity > 0)
    muzzleSprite.material.opacity = Math.max(0, muzzleSprite.material.opacity - dt * 14);
  if (muzzleLight.intensity > 0)
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 40);
}

/* ---------------- input ---------------- */
function bindInput() {
  const canvas = renderer.domElement;

  document.addEventListener("pointerlockchange", () => {
    state.locked = document.pointerLockElement === canvas;
    if (state.locked) {
      state.steerMode = false;   // capture works — use normal mouse look
      UI.setAim("lock");
      UI.setPause(false);
    } else {
      state.fireHeld = false;
      UI.setPause(state.inGame && !state.steerMode);
    }
  });

  document.addEventListener("pointerlockerror", enableSteering);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { state.keys = {}; state.fireHeld = false; }
  });

  canvas.addEventListener("click", () => {
    if (state.inGame) lockPointer();
  });

  document.addEventListener("mousemove", (e) => {
    state.mouse.x = e.clientX;
    state.mouse.y = e.clientY;
    if (!state.locked) return;   // steering uses the cursor position instead
    state.yaw -= e.movementX * CFG.sensX;
    state.pitch -= e.movementY * CFG.sensY;
  });

  document.addEventListener("mousedown", (e) => {
    if (e.button === 0 && state.alive && (state.locked || state.steerMode)) {
      state.fireHeld = true;
    }
  });
  document.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.fireHeld = false;
  });
  // safety nets for a missed mouseup (pointer lock always keeps the cursor
  // captured, so these are belt-and-braces rather than the primary path)
  document.addEventListener("mouseleave", () => { state.fireHeld = false; });
  document.addEventListener("contextmenu", (e) => { e.preventDefault(); });

  document.addEventListener("keydown", (e) => {
    state.keys[e.code] = true;
    if (e.code === "Tab") { e.preventDefault(); UI.scoreboard(true); }
    if (e.code === "KeyV") toggleAim();
  });
  document.addEventListener("keyup", (e) => {
    state.keys[e.code] = false;
    if (e.code === "Tab") UI.scoreboard(false);
  });
  window.addEventListener("blur", () => { state.keys = {}; state.fireHeld = false; });
}

/* V — retry mouse capture, or force cursor-steering when capture is blocked */
function toggleAim() {
  if (!state.inGame) return;
  if (state.steerMode) {
    state.steerMode = false;
    UI.setAim("lock");
    UI.toast("Retrying mouse capture…", "", 1600);
    lockPointer();
    if (!state.locked) setTimeout(() => { if (!state.locked) enableSteering(); }, 900);
  } else {
    document.exitPointerLock && document.exitPointerLock();
    enableSteering();
  }
}
function onResize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

/* ---------------- main loop ---------------- */
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state.inGame) {
    // aiming: pointer-lock deltas, or cursor-steering when lock is unavailable
    steerAim(dt);

    // physics moves the player first, then the camera is placed from the new
    // position — so shooting later in this same frame uses a fresh transform.
    physics(dt);
    applyCamera(dt);
    updateRemotesAll(dt);

    // continuous fire while holding LMB. Deliberately NOT gated on the network
    // state: movement and shooting stay responsive even if the server is down
    // (shots just aren't transmitted until we're connected).
    if (state.fireHeld && (state.locked || state.steerMode) && state.alive) tryShoot();

    sendState(dt);
    updateHud(dt);

    // we reschedule ourselves once our own timer runs out
    if (!state.alive && state.respawnAt && performance.now() >= state.respawnAt) {
      state.respawnAt = 0;
      const sp = randomSpawn();
      localRespawn(sp);
      net.send({ type: "respawn", id: state.selfId, p: sp });
    }

    // death countdown
    if (!state.alive && state.deathAt) {
      const left = Math.max(0, CFG.respawnTime - (performance.now() - state.deathAt) / 1000);
      UI.setDeathCount(Math.ceil(left));
    }
  }
  updateFX(dt);

  // debug hook
  window.__fps = {
    connected: state.connected, joined: state.joined,
    self: state.selfId, players: remotes.size,
    hp: state.hp, alive: state.alive,
    locked: state.locked, fireHeld: state.fireHeld,
    shotsFired: state.shotsFired, tracers: tracers.length,
    directPeers: (net && net.peerCount) ? net.peerCount() : 0,
    pos: [+state.pos.x.toFixed(2), +state.pos.y.toFixed(2), +state.pos.z.toFixed(2)],
  };

  renderer.render(scene, camera);
}

function updateRemotesAll(dt) {
  remotes.forEach((r) => updateRemote(r, dt));
}

/* position + health updates (~20 Hz) — we're the authority on our own player */
function sendState(dt) {
  if (!state.connected || !state.joined) return;
  state.stateTimer += dt;
  if (state.stateTimer < 0.05) return;
  state.stateTimer = 0;
  net.send({ type: "state", player: buildSelfState() });
}

/* HUD/scoreboard refresh — kept independent of the network timer so it keeps
   running while dead or briefly disconnected */
function updateHud(dt) {
  state.uiTimer += dt;
  if (state.uiTimer < 0.25) return;
  state.uiTimer = 0;

  UI.setPlayerLabel(state.name, state.color, state.kills);

  const rows = [];
  remotes.forEach((r) => {
    rows.push({ name: r.name, color: r.color, hp: r.hp, kills: r.kills, alive: r.alive, self: false });
  });
  rows.push({
    name: state.name + " (you)", color: state.color,
    hp: state.hp, kills: state.kills, alive: state.alive, self: true,
  });
  rows.sort((a, b) => b.kills - a.kills || b.hp - a.hp);
  UI.renderScoreboard(rows);
}

/* ---------------- death / respawn ---------------- */
function localDeath(killerName) {
  if (!state.alive) return;
  state.alive = false;
  state.deathAt = performance.now();
  state.vy = 0;
  state.fireHeld = false;
  clearTracers();
  UI.setHP(0, state.maxHp);
  UI.setLowHp(false);
  UI.showDeath(killerName);
  UI.setDeathCount(CFG.respawnTime);
  SFX.died();
}

function localRespawn(p) {
  state.alive = true;
  state.hp = state.maxHp;
  state.pos.set(p[0], p[1], p[2]);
  state.vel.set(0, 0, 0);
  state.vy = 0;
  state.onGround = true;
  state.deathAt = 0;
  clearTracers();
  UI.hideDeath();
  UI.setHP(state.hp, state.maxHp);
  UI.setLowHp(false);
  SFX.spawn();
}

/* ---------------- boot ---------------- */
/* Three.js is fetched from a CDN at runtime, with fallbacks. If every CDN is
 * unreachable the menu must still work and say so — a dead DEPLOY button with
 * no explanation is the worst possible failure mode. */
const THREE_CDNS = [
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://unpkg.com/three@0.128.0/build/three.min.js",
  "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
];

function loadThree(i, done) {
  if (window.THREE) return done(true);
  if (i >= THREE_CDNS.length) return done(false);
  const s = document.createElement("script");
  s.src = THREE_CDNS[i];
  s.async = false;
  s.onload = () => done(!!window.THREE);
  s.onerror = () => loadThree(i + 1, done);
  document.head.appendChild(s);
}

/* wire the menu as soon as the DOM is there, engine or not */
window.addEventListener("DOMContentLoaded", () => {
  UI.rememberName();
  wireMenu();
});

window.addEventListener("load", () => {
  loadThree(0, (ok) => {
    if (!ok) {
      UI.setMenuStatus("Couldn't load the 3D engine (Three.js) — check your connection or ad-blocker, then reload.", "err");
      return;
    }
    try {
      initEngine();
    } catch (err) {
      console.error(err);
      UI.setMenuStatus("Failed to start the renderer: " + (err && err.message ? err.message : err), "err");
    }
  });
});
