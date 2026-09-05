// Generates public/textures/fx/phoenix-wing.png — a stylized phoenix wing,
// pointing RIGHT, bone-root at the LEFT edge. Broad shingled feathers on a
// soft wing-shaped glow, blue->white gradient, hot bright primary tips,
// transparent bg. One texture, mirrored for the other wing = symmetry.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 1024, H = 560;

// a rounded feather pointing +X: length L, half-width Wd, rotated `a`, at (x,y).
// blunt-ish rounded tip, tapered quill.
function feather(x, y, L, Wd, a) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const P = (px, py) => `${(x + px * ca - py * sa).toFixed(1)} ${(y + px * sa + py * ca).toFixed(1)}`;
  return `M ${P(0, 0)}
    C ${P(L * 0.2, Wd * 0.9)} ${P(L * 0.62, Wd)} ${P(L * 0.9, Wd * 0.45)}
    C ${P(L * 1.02, Wd * 0.18)} ${P(L * 1.02, -Wd * 0.18)} ${P(L * 0.9, -Wd * 0.45)}
    C ${P(L * 0.62, -Wd)} ${P(L * 0.2, -Wd * 0.9)} ${P(0, 0)} Z`;
}

const root = [90, H * 0.56];
const hand = [520, H * 0.40];

const el = (d, fill, op) => `<path d="${d}" fill="${fill}" fill-opacity="${op}"/>`;
let glow = '', shadow = '', feathers = '';

// wing-shaped soft underlay
glow += `<path d="M ${root[0]} ${root[1] + 24}
  C ${root[0] + 150} ${root[1] - 40}, ${hand[0] - 40} ${hand[1] - 30}, ${hand[0] + 30} ${hand[1] - 6}
  C ${hand[0] + 300} ${hand[1] - 40}, ${hand[0] + 380} ${hand[1] + 90}, ${hand[0] + 280} ${hand[1] + 210}
  C ${hand[0] + 90} ${hand[1] + 250}, ${root[0] + 180} ${root[1] + 150}, ${root[0] + 50} ${root[1] + 110}
  C ${root[0] + 6} ${root[1] + 80}, ${root[0] - 6} ${root[1] + 52}, ${root[0]} ${root[1] + 24} Z"
  fill="url(#gGlow)" fill-opacity="0.42"/>`;

function row(n, from, to, Lbase, Ltaper, Wfrac, aFrom, aTo, matOf, op) {
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0 : i / (n - 1);
    const x = from[0] + (to[0] - from[0]) * p;
    const y = from[1] + (to[1] - from[1]) * p;
    const L = Lbase - Ltaper * Math.abs(p - 0.42);
    const a = aFrom + (aTo - aFrom) * p;
    const d = feather(x, y, L, L * Wfrac, a);
    shadow += el(feather(x, y + 6, L, L * Wfrac, a), '#0a2a70', 0.28);
    feathers += el(d, matOf(p), op);
  }
}
// primaries — long, sweeping up from the hand
row(7, hand, [hand[0] + 30, hand[1] - 10], 470, 250, 0.17,
  -1.15, 0.35, (p) => (p < 0.35 ? 'url(#gTip)' : p < 0.72 ? 'url(#gBright)' : 'url(#gMid)'), 0.94);
// secondaries — medium, along the forearm
row(8, [root[0] + 90, root[1] - 6], [hand[0] - 10, hand[1] + 6], 300, 120, 0.2,
  0.55, 0.95, () => 'url(#gMid)', 0.9);
// coverts — small, over the shoulder
row(7, [root[0] + 15, root[1] + 18], [root[0] + 250, root[1] + 44], 160, 60, 0.26,
  0.9, 1.05, () => 'url(#gDeep)', 0.9);

// hot leading-edge bone
const bone = `<path d="M ${root[0]} ${root[1] + 2}
  C ${root[0] + 180} ${root[1] - 60}, ${hand[0] - 30} ${hand[1] - 24}, ${hand[0] + 26} ${hand[1] - 4}
  L ${hand[0] + 18} ${hand[1] + 16}
  C ${hand[0] - 50} ${hand[1] + 2}, ${root[0] + 160} ${root[1] - 14}, ${root[0]} ${root[1] + 26} Z"
  fill="url(#gEdge)" fill-opacity="0.95"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="gGlow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f6fd0"/><stop offset="1" stop-color="#cdeeff"/></linearGradient>
    <linearGradient id="gDeep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#173c96"/><stop offset="1" stop-color="#3f9be8"/></linearGradient>
    <linearGradient id="gMid" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f7fdd"/><stop offset="1" stop-color="#9bdcff"/></linearGradient>
    <linearGradient id="gBright" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#79c8ff"/><stop offset="1" stop-color="#f4fcff"/></linearGradient>
    <linearGradient id="gTip" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d6f2ff"/><stop offset="0.55" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <linearGradient id="gEdge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a7dbff"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <filter id="s"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="s2"><feGaussianBlur stdDeviation="1.1"/></filter>
  </defs>
  <g filter="url(#s)">${glow}</g>
  <g filter="url(#s2)">${shadow}${feathers}${bone}</g>
</svg>`;

mkdirSync('public/textures/fx', { recursive: true });
writeFileSync('tools/_phoenix-wing.svg', svg);
await sharp(Buffer.from(svg)).png().toFile('public/textures/fx/phoenix-wing.png');
console.log('wrote public/textures/fx/phoenix-wing.png', W + 'x' + H);
