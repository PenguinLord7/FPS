/* =====================================================================
 * Pulse Arena — Three.js game client
 *  - first-person movement + collision on a simple blocky map
 *  - networked players interpolated from server snapshots
 *  - hitscan shooting with client raycast + server validation
 * =================================================================== */
"use strict";

/* ---------------- helpers ---------------- */
const CFG = window.CFG;
const UP = new THREE.Vector3(0, 1, 0);
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
let clock = new THREE.Clock();

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _want = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

const raycaster = new THREE.Raycaster();

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
  pos: new THREE.Vector3(0, 0, 20),
  vel: new THREE.Vector3(),
  yaw: 0,            // default camera looks down -Z, toward arena centre
  pitch: 0,
  recoil: 0,
  vy: 0,
  onGround: true,
  keys: {},
  locked: false,
  fireHeld: false,
  lastShot: 0,
  deathAt: 0,
  stateTimer: 0,
  uiTimer: 0,
};

/* remote players keyed by server id */
const remotes = new Map();
let net = null;

/* ---------------- init ---------------- */
function initEngine() {
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
  buildGun();
  bindInput();
  wireMenu();
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

/* ---------------- first-person gun (viewmodel) ---------------- */
function buildGun() {
  gunGroup = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.45, metalness: 0.55 });
  const dark2 = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.6, metalness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x40c4ff, roughness: 0.3, metalness: 0.4, emissive: 0x113a4d });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.95), dark);
  body.position.set(0.28, -0.22, -0.5);
  const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.42), dark2);
  shroud.position.set(0.28, -0.15, -0.95);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.08), dark2);
  grip.position.set(0.28, -0.36, -0.3);
  grip.rotation.x = 0.3;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), accent);
  barrel.position.set(0.28, -0.18, -1.18);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.5), accent);
  top.position.set(0.28, -0.11, -0.7);
  gunGroup.add(body, shroud, grip, barrel, top);

  // where tracers / muzzle flash originate
  gunTip = new THREE.Object3D();
  gunTip.position.set(0.28, -0.18, -1.28);
  gunGroup.add(gunTip);

  // muzzle flash sprite
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
    map: muzzleTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  muzzleSprite.position.copy(gunTip.position);
  muzzleSprite.scale.set(0.6, 0.6, 1);
  gunGroup.add(muzzleSprite);

  muzzleLight = new THREE.PointLight(0xffb25c, 0, 10, 2);
  muzzleLight.position.copy(gunTip.position);
  gunGroup.add(muzzleLight);

  camera.add(gunGroup);
}

function gunTipWorld(out) {
  gunTip.getWorldPosition(out);
  return out;
}

/* ---------------- menu / session ---------------- */
function wireMenu() {
  UI.rememberName();
  const play = () => {
    const cfg = UI.readConfig();
    if (!cfg.name) { UI.setMenuStatus("Please enter a nickname.", "err"); return; }
    UI.saveName(cfg.name);
    SFX.ensure();
    SFX.click();
    beginSession(cfg.name, cfg.server);
  };
  document.getElementById("play").addEventListener("click", play);
  document.getElementById("name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") play();
  });
  // resume from pause
  document.getElementById("pause").addEventListener("click", lockPointer);
}

function beginSession(name, server) {
  UI.hideMenu();
  UI.hudShow();
  UI.setHP(state.maxHp, state.maxHp);
  UI.setMenuStatus("", "");
  state.inGame = true;
  state.name = name;

  if (net) { try { net.close(); } catch (e) { /* ignore */ } net = null; }

  net = new FPSNet(server, name);
  wireNet(net);
  net.connect();
  UI.toast("Connecting…", "");
  lockPointer();
}

function lockPointer() {
  if (!renderer) return;
  const el = renderer.domElement;
  if (document.pointerLockElement !== el) {
    try { el.requestPointerLock && el.requestPointerLock(); } catch (e) { /* ignore */ }
  }
}

/* ---------------- networking ---------------- */
function wireNet(n) {
  n.on("open", () => {
    state.connected = true;
    UI.toast("Connected — awaiting spawn…", "good", 1500);
  });

  n.on("status", (s) => { if (state.inGame) UI.toast(s.msg, s.kind || "", 2200); });

  n.on("welcome", (m) => {
    state.joined = true;
    state.selfId = m.self.id;
    state.name = m.self.name;
    state.color = m.self.color;
    state.hp = state.maxHp;
    state.kills = 0;
    state.alive = true;
    state.deathAt = 0;
    UI.hideDeath();
    // fresh session: clear remotes (new player id may differ after reconnect)
    clearRemotes();
    m.players.forEach(syncFromSnap);
    SFX.spawn();
    UI.toast(`Welcome, ${m.self.name}!`, "good", 1800);
  });

  n.on("full", () => {
    UI.toast("Server is full — try again soon.", "err");
    UI.setMenuStatus("Server full.", "err");
  });
  n.on("error", () => {});

  n.on("joined", (m) => {
    if (m.id === state.selfId) return;
    ensureRemote(m);
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
    }
    // hide the remote victim right away (server has already done so)
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

  window.addEventListener("beforeunload", () => { if (net) net.close(); });
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
  const matBody = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 });
  const matHead = new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.35), roughness: 0.6 });
  const matGun = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.4, metalness: 0.6 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.5, 1.3, 10), matBody);
  body.position.y = 1.15; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), matHead);
  head.position.y = 2.0; head.castShadow = true;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.0), matGun);
  gun.position.set(0, 1.55, -0.6); gun.castShadow = true;
  g.add(body, head, gun);

  // two invisible hit proxies (torso + head) used for the hitscan raycast
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
  mk(0.62, 1.05);
  mk(0.34, 1.85);

  const tag = makeTag();
  tag.spr.position.y = 2.85;
  g.add(tag.spr);

  scene.add(g);

  const rec = {
    id: info.id, group: g, tag,
    hitSpheres,
    name: info.name || "?",
    color: info.color || "#ff5252",
    pos: new THREE.Vector3(info.p ? info.p[0] : 0, info.p ? info.p[1] : 0, info.p ? info.p[2] : 0),
    tpos: new THREE.Vector3().copy(recPos(info)),
    ry: info.ry || 0,
    try_: info.ry || 0,
    hp: info.hp != null ? info.hp : 100,
    alive: info.alive !== false,
    kills: info.kills || 0,
    lastHp: -1,
    lastAlive: null,
  };
  g.position.copy(rec.pos);
  g.rotation.y = rec.ry;
  refreshTag(rec);
  return rec;
}
function recPos(info) {
  return new THREE.Vector3(info.p ? info.p[0] : 0, info.p ? info.p[1] : 0, info.p ? info.p[2] : 0);
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
  r.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
  if (r.tag && r.tag.tex) r.tag.tex.dispose();
}

function updateRemote(r, dt) {
  const k = 1 - Math.exp(-dt * 10);
  if (r.pos.distanceToSquared(r.tpos) > 2500) r.pos.copy(r.tpos); // teleport
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
  if (!state.inGame || !state.alive) { state.vel.set(0, 0, 0); state.vy = 0; return; }
  const k = state.keys;

  // movement direction projected onto the ground, from the camera view
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  _right.crossVectors(_fwd, UP).normalize();

  let mx = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
  let mz = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
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

  // subtle gun idle sway while moving + visible recoil kick
  const moving = state.alive && (_want.x || _want.z) && state.onGround;
  const t = clock.elapsedTime;
  const bob = moving ? Math.sin(t * 9) * 0.012 : 0;
  gunGroup.position.set(bob * 0.6, bob * 0.5, state.recoil * 0.35);
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
  if (now - state.lastShot < CFG.weapon.cooldown * 1000) return;
  if (!state.alive) return;
  state.lastShot = now;

  raycaster.setFromCamera(_tmp.set(0, 0, 0), camera);
  raycaster.far = CFG.weapon.range;

  const targets = blockMeshes.concat(liveProxies());
  const hits = raycaster.intersectObjects(targets, false);

  let victimId = null;
  let end = null;
  if (hits.length) {
    const h = hits[0];
    if (h.object.userData.isProxy) victimId = h.object.userData.id;
    end = _tmp2.copy(h.point);
  } else {
    camera.getWorldDirection(_dir);
    end = _tmp2.copy(camera.position).addScaledVector(_dir, CFG.weapon.range);
  }

  // FX: tracer from the muzzle tip to the impact point
  const origin = camera.position;
  gunTipWorld(_dir); // _dir reused as muzzle world pos
  spawnTracer(_dir, end, CFG.weapon.tracerColor);

  // muzzle flash
  muzzleSprite.material.opacity = 1;
  muzzleSprite.rotation.z = Math.random() * Math.PI;
  muzzleLight.intensity = 2.4;
  state.recoil += 0.012 + Math.random() * 0.005;

  SFX.shoot();
  net.send({
    type: "shoot",
    victim: victimId,
    p: [origin.x, origin.y, origin.z],
    d: (camera.getWorldDirection(_tmp).toArray()),
  });

  if (victimId) { UI.hitmark(false); SFX.hitmark(); }
}

/* tracer beams */
function spawnTracer(from, to, color) {
  const dir = _tmp.copy(to).sub(from);
  const len = dir.length();
  if (len < 0.5) return;
  dir.normalize();
  const mat = new THREE.MeshBasicMaterial({
    color: color, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1, 6, 1, true), mat);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir);
  mesh.scale.y = len;
  mesh.renderOrder = 5;
  scene.add(mesh);
  tracers.push({ mesh, life: CFG.weapon.tracerLife, max: CFG.weapon.tracerLife });
}

function spawnRemoteTracer(m) {
  const from = _tmp.set(m.p[0], m.p[1], m.p[2]);
  const dir = _tmp2.set(m.d[0], m.d[1], m.d[2]).normalize();
  // clip against world geometry
  raycaster.set(from, dir);
  raycaster.far = CFG.weapon.range;
  const hits = raycaster.intersectObjects(blockMeshes, false);
  const to = hits.length ? _tmp.copy(hits[0].point) : from.clone().addScaledVector(dir, CFG.weapon.range);
  const start = from.clone().addScaledVector(dir, 0.4);
  spawnTracer(start, to, 0xffca6e);
}

function updateFX(dt) {
  // tracers
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life -= dt;
    if (tr.life <= 0) {
      scene.remove(tr.mesh);
      tr.mesh.material.dispose();
      tracers.splice(i, 1);
    } else {
      tr.mesh.material.opacity = tr.life / tr.max;
    }
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
    if (state.inGame && !state.locked) UI.setPause(true);
    else UI.setPause(false);
  });

  canvas.addEventListener("click", () => {
    if (state.inGame) lockPointer();
  });

  document.addEventListener("mousemove", (e) => {
    if (!state.locked) return;
    state.yaw -= e.movementX * CFG.sensX;
    state.pitch -= e.movementY * CFG.sensY;
  });

  document.addEventListener("mousedown", (e) => {
    if (e.button === 0 && state.locked && state.alive) {
      state.fireHeld = true;
    }
  });
  document.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.fireHeld = false;
  });

  document.addEventListener("keydown", (e) => {
    state.keys[e.code] = true;
    if (e.code === "Tab") { e.preventDefault(); UI.scoreboard(true); }
  });
  document.addEventListener("keyup", (e) => {
    state.keys[e.code] = false;
    if (e.code === "Tab") UI.scoreboard(false);
  });
  window.addEventListener("blur", () => { state.keys = {}; state.fireHeld = false; });
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
    applyCamera(dt);
    physics(dt);
    updateRemotesAll(dt);

    // continuous fire while holding LMB
    if (state.fireHeld && state.locked && state.alive && state.joined) tryShoot();

    sendState(dt);

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
  };

  renderer.render(scene, camera);
}

function updateRemotesAll(dt) {
  remotes.forEach((r) => updateRemote(r, dt));
}

function sendState(dt) {
  if (!state.connected || !state.joined) return;
  state.stateTimer += dt;
  if (state.stateTimer < 0.05) return;
  state.stateTimer = 0;
  if (!state.alive) return;
  net.send({
    type: "state",
    p: [state.pos.x, state.pos.y, state.pos.z],
    ry: state.yaw,
  });

  // throttle UI-only refresh
  state.uiTimer += dt;
  if (state.uiTimer >= 0.25) {
    state.uiTimer = 0;
    UI.setPlayerLabel(state.name, state.color, state.kills);
    // scoreboard rows
    const rows = [];
    remotes.forEach((r) => {
      rows.push({ name: r.name, color: r.color, hp: r.hp, kills: r.kills, alive: r.alive, self: false });
    });
    rows.push({ name: state.name + " (you)", color: state.color, hp: state.hp, kills: state.kills, alive: state.alive, self: true });
    rows.sort((a, b) => b.kills - a.kills || b.hp - a.hp);
    UI.renderScoreboard(rows);
  }
}

/* ---------------- death / respawn ---------------- */
function localDeath(killerName) {
  if (!state.alive) return;
  state.alive = false;
  state.deathAt = performance.now();
  state.vy = 0;
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
  UI.hideDeath();
  UI.setHP(state.hp, state.maxHp);
  UI.setLowHp(false);
  SFX.spawn();
}

/* ---------------- boot ---------------- */
window.addEventListener("load", () => {
  if (!window.THREE) {
    UI.setMenuStatus("Three.js failed to load — check your internet connection.", "err");
    return;
  }
  initEngine();
});
