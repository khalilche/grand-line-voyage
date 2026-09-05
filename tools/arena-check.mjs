// Greybox validation for the e-sports stadium ARENA (src/world/Arena.js).
import { Arena } from '../src/world/Arena.js';

const a = new Arena({ add() {} });
const D = a.debugPoints();
const dt = 1 / 60, SPD = 11.5, GRAV = 26, SNAP = 0.5, RAD = 0.4;

console.log(`\nARENA — ESTADIO E-SPORTS  (H=${D.H})`);
console.log(`suelo r=${D.arenaR} (⌀${D.arenaR * 2}) | pódium r=${D.podiumR.toFixed(1)} h${D.podiumTopY.toFixed(1)} | anillo ${D.ringIn}..${D.ringOut}`);
console.log(`BANDA LED 360°: rInt ${D.screen.inR} rExt ${D.screen.outR} h${D.screen.h} · ${D.screen.seg} segmentos · baseY ${D.screen.baseY.toFixed(1)} midY ${D.screen.midY.toFixed(1)}`);
console.log(`anillo superior: rInt ${D.upperRing.inR.toFixed(1)} rExt ${D.upperRing.outR.toFixed(1)} @ y${D.upperRing.y.toFixed(1)} | 3 banners @ ${D.banners.map((b) => (b.a * 180 / Math.PI).toFixed(0) + '°').join(', ')}`);
console.log(`\nTriángulos: ${D.visTris}\nDraw calls: ${D.drawCalls}\nsólidos: ${D.solids}\nspawn: (${D.spawn.x.toFixed(0)}, ${D.spawn.y.toFixed(2)}, ${D.spawn.z.toFixed(0)})`);

let pass = 0, fail = 0;
const P = (ok, l, x = '') => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${l}${x ? '  — ' + x : ''}`); ok ? pass++ : fail++; };

function walk(from, to, { startY, jump = 0 } = {}) {
  const p = { x: from[0], y: startY != null ? startY : a.sampleGround(from[0], from[1], Infinity).height + 0.1, z: from[1] };
  let vy = jump, grounded = false, fell = false, f = 0;
  for (; f < 60 * 20; f++) {
    const dx = to[0] - p.x, dz = to[1] - p.z, d = Math.hypot(dx, dz);
    if (d < 0.7 && grounded) break;
    if (d > 1e-4) { p.x += (dx / d) * SPD * dt; p.z += (dz / d) * SPD * dt; }
    vy -= GRAV * dt; p.y += vy * dt;
    a.resolveSolids(p, RAD);
    const g = a.sampleGround(p.x, p.z, p.y);
    if (!g.onLand) { grounded = false; if (p.y < a.voidY) { fell = true; break; } continue; }
    if (p.y <= g.height + 0.02 || (vy <= 0 && p.y - g.height < SNAP)) { p.y = g.height; vy = 0; grounded = true; } else grounded = false;
  }
  return { p, grounded, fell, reached: Math.hypot(to[0] - p.x, to[1] - p.z) < 3, f, r: Math.hypot(p.x, p.z) };
}
const polar = (r, aR) => [Math.cos(aR) * r, Math.sin(aR) * r];

console.log('\n--- tests ---');
{ const g = a.sampleGround(0, 12, Infinity); P(g.onLand && Math.abs(g.height - D.spawn.y) < 0.2, 'Spawn válido en el suelo', `y=${g.height.toFixed(2)}`); }

// recorrer el suelo del centro al borde en varias direcciones
{
  let ok = 0;
  for (const ang of [0, 0.9, 1.8, 2.7, -0.9, -1.8, -2.7, 3.0]) { const r = walk([2, 4], polar(D.arenaR - 2, ang)); if (r.grounded && r.reached) ok++; }
  P(ok === 8, 'Suelo plano: centro -> borde en las 8 direcciones', `${ok}/8`);
}
// suelo continuo (sin agujeros) en malla
{
  let holes = 0;
  for (let x = -D.arenaR; x <= D.arenaR; x += 3) for (let z = -D.arenaR; z <= D.arenaR; z += 3) {
    if (Math.hypot(x, z) > D.arenaR - 1) continue;
    if (!a.sampleGround(x, z, Infinity).onLand) holes++;
  }
  P(holes === 0, 'Suelo circular continuo (sin huecos)');
}
// NO se puede salir de la arena (estadio cerrado, sin ring-out)
{
  const r = walk([0, 0], polar(200, 0.5));
  P(!r.fell && r.grounded && r.r <= D.boundsR + 0.5, 'Límite circular: no se sale de la arena', `r final=${r.r.toFixed(1)} (bound ${D.boundsR.toFixed(1)})`);
}
{
  const r = walk([0, 0], polar(200, -2.1));
  P(!r.fell && r.r <= D.boundsR + 0.5, 'Límite circular en otra dirección', `r=${r.r.toFixed(1)}`);
}
// pódium central: subir de un salto, superficie sólida
{
  const r = walk([D.podiumR + 1.5, 0], [0, 0], { jump: 10.8 });   // hop up from the edge
  P(r.grounded && Math.abs(r.p.y - D.podiumTopY) < 0.6, 'Pódium: se sube de un salto y es superficie sólida', `y=${r.p.y.toFixed(2)}`);
  const blocked = walk([20, 0], [-20, 0]);   // caminando en el suelo choca con el pódium
  P(!blocked.reached && blocked.grounded, 'Pódium: NO se traspasa caminando (bloquea)');
}
// la geometría clave existe con las medidas exactas
P(D.screen.seg === 64 && D.screen.inR === 38 && D.screen.outR === 42 && D.screen.h === 3.5, 'Banda LED 360°: 64 seg · rInt 38 · rExt 42 · h 3.5', 'exacto');
P(Math.abs(D.screen.baseY - 8 * D.H) < 0.01, 'Banda LED: baseY = 8H', `${D.screen.baseY.toFixed(2)}`);
P(Math.abs(D.podiumR - 4 * D.H) < 0.01 && Math.abs(D.podiumTopY - 1 * D.H) < 0.01, 'Pódium: radio 4H · altura 1H', 'exacto');
P(Math.abs(D.upperRing.y - 15 * D.H) < 0.01 && Math.abs(D.upperRing.outR - 7 * D.H) < 0.01, 'Anillo superior: y 15H · rExt 7H', 'exacto');
P(D.banners.length === 3, '3 banners verticales (-90° / 0° / +90°)');
P(a.spot && a.spot.isSpotLight, 'Foco central (SpotLight) hacia el pódium');
P(a.waterHeight() < -9000, 'Sin agua (estadio interior)');

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
