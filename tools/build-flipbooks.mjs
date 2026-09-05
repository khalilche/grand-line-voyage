// Pack the animated "Particles.zip" frame sets into grid atlases the Flipbook
// effect plays through. Output -> public/textures/fx/<name>.png  (+ a small JSON
// manifest with cols/rows/frames).
import sharp from 'sharp';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const SRC = 'tools/pk-particles/Particles';
const OUT = 'public/textures/fx';
mkdirSync(OUT, { recursive: true });

// name -> { dir, frame px, max frames (evenly sampled), grid cols,
//          recolor?: 'blueflame' — remap warm source frames to a cool blue
//          phoenix flame (R<->B channel swap + slight brighten), keeping the
//          white-hot cores white and mids cyan. }
const SETS = {
  impact:     { dir: 'Complex/impacts',       px: 128, take: 20, cols: 5 },
  muzzle:     { dir: 'Complex/muzzle flash',  px: 128, take: 20, cols: 5 },
  fire:       { dir: 'Color/fire',            px: 128, take: 32, cols: 8 },
  smoke:      { dir: 'Complex/smoke',         px: 128, take: 40, cols: 8 },
  energyball: { dir: 'Color/energyball',      px: 160, take: 10, cols: 5 },
  magic:      { dir: 'Color/magic particles', px: 128, take: 20, cols: 5 },
  shock:      { dir: 'Complex/circle',        px: 128, take: 24, cols: 6 },
  // --- phoenix set: white streak/burst sprites (tint cleanly at runtime) ---
  slash:      { dir: 'Complex/lines',         px: 128, take: 10, cols: 5 },
  flare:      { dir: 'Complex/flare',         px: 128, take: 24, cols: 6 },
  // --- phoenix set: warm packs recoloured to blue flame at BAKE time ---
  phxfire:    { dir: 'Color/fire',            px: 128, take: 32, cols: 8, recolor: 'blueflame' },
  phxball:    { dir: 'Color/energyball',      px: 160, take: 10, cols: 5, recolor: 'blueflame' },
  phxmuzzle:  { dir: 'Complex/muzzle flash',  px: 128, take: 20, cols: 5, recolor: 'blueflame' },
};

// output channel = row; input weights = [R, G, B]. Orange fire (R hi, B lo)
// -> blue flame (B hi, R lo); white cores stay white; yellow mids -> cyan.
const BLUEFLAME_RECOMB = [
  [0.0, 0.0, 1.0],
  [0.0, 0.7, 0.3],
  [1.0, 0.15, 0.0],
];

const natSort = (a, b) => {
  const na = +(a.match(/(\d+)\.png$/)?.[1] ?? 0);
  const nb = +(b.match(/(\d+)\.png$/)?.[1] ?? 0);
  return na - nb;
};

const manifest = {};
for (const [name, s] of Object.entries(SETS)) {
  let files = readdirSync(`${SRC}/${s.dir}`).filter((f) => f.endsWith('.png')).sort(natSort);
  // evenly sample down to `take` frames
  if (files.length > s.take) {
    const step = files.length / s.take;
    files = Array.from({ length: s.take }, (_, i) => files[Math.floor(i * step)]);
  }
  const frames = files.length;
  const cols = s.cols;
  const rows = Math.ceil(frames / cols);
  const layers = await Promise.all(files.map(async (f, i) => {
    let img = sharp(`${SRC}/${s.dir}/${f}`).resize(s.px, s.px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
    if (s.recolor === 'blueflame') img = img.recomb(BLUEFLAME_RECOMB).linear(1.12, 0);
    return { input: await img.toBuffer(), left: (i % cols) * s.px, top: Math.floor(i / cols) * s.px };
  }));
  await sharp({ create: { width: cols * s.px, height: rows * s.px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).png({ compressionLevel: 9 }).toFile(`${OUT}/${name}.png`);
  manifest[name] = { cols, rows, frames };
  console.log(`${name}: ${frames} frames -> ${cols}x${rows} @ ${s.px}px  (${cols * s.px}x${rows * s.px})`);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log('wrote', OUT + '/manifest.json');
