import * as THREE from 'three';
import { toonMaterial, outlineGroup } from '../rendering/toon.js';

/**
 * Non-combat island NPC (villager / shopkeeper / elder). Blocky civilian body,
 * gentle idle sway, turns to face the player when near, and carries dialogue
 * lines the Game surfaces on interact.
 */

const PRESETS = {
  villager: {
    names: ['Aldeano', 'Aldeana', 'Pescador', 'Herrero', 'Panadera', 'Grumete'],
    shirts: [0x4f7a52, 0x8a5a3c, 0x5a6f8c, 0x9c7b3f, 0x6b5b8c],
    lines: [
      ['Bienvenido al Pueblo del Alba.', 'Los bandidos de la Cala llevan semanas dando problemas.'],
      ['¿Vas a hacerte pirata? Ten cuidado ahí fuera.'],
      ['Dicen que en las Ruinas de Esmeralda hay un guardián que nadie ha vencido.'],
      ['El mar está raro últimamente. Bestias más grandes de lo normal.']
    ]
  },
  shopkeeper: {
    names: ['Tendero Boro'],
    shirts: [0x8c6b2f],
    lines: [['Objetos y mejoras, marinero.', 'Vuelve cuando tengas berries de sobra.']]
  },
  elder: {
    names: ['Anciano del Faro'],
    shirts: [0xb8b0a0],
    lines: [['Cada isla del Primer Mar es más dura que la anterior.', 'Sube de nivel derrotando a enemigos de tu talla.', 'Abre el mapa con M para ver la ruta.']]
  }
};

export function makeNPC(scene, pos, { type = 'villager', seed = 1 } = {}) {
  const preset = PRESETS[type] || PRESETS.villager;
  const ri = Math.floor(_rand(seed) * preset.names.length) % preset.names.length;
  const si = Math.floor(_rand(seed * 7 + 3) * preset.shirts.length) % preset.shirts.length;

  const g = new THREE.Group();
  const M = {
    skin: toonMaterial({ color: 0xe7b98c, stops: 3 }),
    shirt: toonMaterial({ color: preset.shirts[si], stops: 3, rim: 0xffe9cf, rimStrength: 0.2 }),
    pants: toonMaterial({ color: 0x4a4a52, stops: 3 }),
    hair: toonMaterial({ color: type === 'elder' ? 0xdadada : 0x2a2320, stops: 3 })
  };
  const torso = new THREE.Group(); torso.position.y = 1.1; g.add(torso);
  _box(torso, 0.62, 0.82, 0.36, M.shirt, 0, 0, 0);
  const head = _box(torso, 0.42, 0.44, 0.42, M.skin, 0, 0.64, 0);
  _box(head, 0.46, 0.18, 0.46, M.hair, 0, 0.24, 0);
  const armL = new THREE.Group(); armL.position.set(-0.42, 0.28, 0); torso.add(armL);
  _box(armL, 0.17, 0.64, 0.18, M.shirt, 0, -0.32, 0);
  const armR = new THREE.Group(); armR.position.set(0.42, 0.28, 0); torso.add(armR);
  _box(armR, 0.17, 0.64, 0.18, M.shirt, 0, -0.32, 0);
  _box(torso, 0.24, 0.7, 0.26, M.pants, -0.15, -0.75, 0);
  _box(torso, 0.24, 0.7, 0.26, M.pants, 0.15, -0.75, 0);

  g.position.copy(pos);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  outlineGroup(g, { thickness: 0.004 });
  scene.add(g);

  const npc = {
    obj: g, type,
    name: preset.names[ri],
    lines: preset.lines,
    radius: 2.6,
    _t: _rand(seed * 13) * 6,
    _armL: armL, _armR: armR, _torso: torso, _head: head,
    nearPlayer: false
  };

  npc.pickLine = () => npc.lines[Math.floor(Math.random() * npc.lines.length)];

  npc.update = (dt, playerPos) => {
    npc._t += dt;
    npc._torso.position.y = 1.1 + Math.sin(npc._t * 1.6) * 0.02;
    npc._armL.rotation.x = Math.sin(npc._t * 1.3) * 0.08;
    npc._armR.rotation.x = Math.sin(npc._t * 1.3 + 1) * 0.08;
    if (playerPos) {
      const dx = playerPos.x - g.position.x, dz = playerPos.z - g.position.z;
      const d = Math.hypot(dx, dz);
      npc.nearPlayer = d < 4.5;
      if (d < 12) {
        const want = Math.atan2(dx, dz);
        g.rotation.y += (((want - g.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-6 * dt));
      }
    }
  };

  return npc;
}

function _box(parent, w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function _rand(s) {
  s = Math.sin(s * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
