// Pack the animated "Particles.zip" frame sets into grid atlases the Flipbook
// effect plays through. Output -> public/textures/fx/<name>.png  (+ a small JSON
// manifest with cols/rows/frames).
import sharp from 'sharp';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const SRC = 'tools/pk-particles/Particles';
const OUT = 'public/textures/fx';
mkdirSync(OUT, { recursive: true });

// name -> { dir, frame px, max frames (evenly sampled), grid cols }
const SETS = {
  impact:     { dir: 'Complex/impacts',       px: 128, take: 20, cols: 5 },
  muzzle:     { dir: 'Complex/muzzle flash',  px: 128, take: 20, cols: 5 },
  fire:       { dir: 'Color/fire',            px: 128, take: 32, cols: 8 },
  smoke:      { dir: 'Complex/smoke',         px: 128, take: 40, cols: 8 },
  energyball: { dir: 'Color/energyball',      px: 160, take: 10, cols: 5 },
  magic:      { dir: 'Color/magic particles', px: 128, take: 20, cols: 5 },
  shock:      { dir: 'Complex/circle',        px: 128, take: 24, cols: 6 },
};

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
  const layers = await Promise.all(files.map(async (f, i) => ({
    input: await sharp(`${SRC}/${s.dir}/${f}`).resize(s.px, s.px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(),
    left: (i % cols) * s.px, top: Math.floor(i / cols) * s.px,
  })));
  await sharp({ create: { width: cols * s.px, height: rows * s.px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).png({ compressionLevel: 9 }).toFile(`${OUT}/${name}.png`);
  manifest[name] = { cols, rows, frames };
  console.log(`${name}: ${frames} frames -> ${cols}x${rows} @ ${s.px}px  (${cols * s.px}x${rows * s.px})`);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log('wrote', OUT + '/manifest.json');
