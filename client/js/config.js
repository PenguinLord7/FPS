/* Shared client configuration + static level data. Loaded first. */
"use strict";

window.CFG = {
  mapHalf: 48,

  // player
  radius: 0.5,
  eye: 1.7,
  speedWalk: 9,
  speedRun: 15,
  jumpVel: 8.0,
  gravity: 22,
  respawnTime: 3.0,

  // mouse
  sensX: 0.0021,
  sensY: 0.0021,
  pitchMax: 1.53,

  // weapon
  weapon: {
    name: "VK-9 · PULSE RIFLE",
    damage: 34,
    cooldown: 0.14,
    range: 260,
    tracerColor: 0xffd54f,
    tracerLife: 0.14,
  },

  // Level blocks: { x, z, w, d, h } centred on (x, z), resting on y = 0.
  blocks: [
    // perimeter walls
    { x: 0, z: -48.5, w: 98, d: 1, h: 4 },
    { x: 0, z: 48.5, w: 98, d: 1, h: 4 },
    { x: -48.5, z: 0, w: 1, d: 98, h: 4 },
    { x: 48.5, z: 0, w: 1, d: 98, h: 4 },
    // central tower + corner blocks
    { x: 0, z: 0, w: 8, d: 8, h: 3 },
    { x: -24, z: -24, w: 5, d: 5, h: 3 },
    { x: 24, z: -24, w: 5, d: 5, h: 3 },
    { x: -24, z: 24, w: 5, d: 5, h: 3 },
    { x: 24, z: 24, w: 5, d: 5, h: 3 },
    // interior walls
    { x: -8, z: 18, w: 2.5, d: 12, h: 3 },
    { x: 18, z: -8, w: 12, d: 2.5, h: 3 },
    { x: -18, z: -8, w: 2.5, d: 12, h: 3 },
    { x: -34, z: 0, w: 2.5, d: 10, h: 3 },
    { x: 34, z: 0, w: 2.5, d: 10, h: 3 },
    { x: 0, z: -34, w: 12, d: 2.5, h: 3 },
    { x: 0, z: 34, w: 12, d: 2.5, h: 3 },
    // scattered crates
    { x: -14, z: -12, w: 3.5, d: 3.5, h: 3 },
    { x: 14, z: -12, w: 3.5, d: 3.5, h: 3 },
    { x: -14, z: 12, w: 3.5, d: 3.5, h: 3 },
    { x: 14, z: 12, w: 3.5, d: 3.5, h: 3 },
    { x: 8, z: -20, w: 3, d: 3, h: 3 },
    { x: -8, z: 20, w: 3, d: 3, h: 3 },
    { x: 32, z: 16, w: 3.5, d: 3.5, h: 3 },
    { x: -32, z: -16, w: 3.5, d: 3.5, h: 3 },
  ],

  // visual colours for blocks (walls vs crates)
  wallColor: 0x54616f,
  crateColors: [0xb06a3a, 0x9c5a30, 0x7a6a4a, 0x5567a0, 0x5d8f6f, 0x95507a],
};
