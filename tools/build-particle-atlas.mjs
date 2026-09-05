// Build a 4x2 particle atlas from the Kenney particle pack (CC0).
// Tiles (index = row-major, 4 per row):
//   0 circle   1 flame    2 smoke    3 spark
//   4 star     5 magic    6 light    7 trace
// -> public/textures/particles.png  (1024x512, 256px tiles, premultiplied-safe)
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC = 'tools/kenney-src';   // trimmed to the 8 used sprites + License.txt
const TILE = 256;
const COLS = 4, ROWS = 2;

const files = [
  'circle_05', 'flame_04', 'smoke_04', 'spark_04',
  'star_05', 'magic_05', 'light_02', 'trace_06',
];

mkdirSync('public/textures', { recursive: true });

const layers = await Promise.all(files.map(async (name, i) => {
  const buf = await sharp(`${SRC}/${name}.png`)
    .resize(TILE, TILE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { input: buf, left: (i % COLS) * TILE, top: Math.floor(i / COLS) * TILE };
}));

await sharp({
  create: { width: COLS * TILE, height: ROWS * TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(layers)
  .png({ compressionLevel: 9 })
  .toFile('public/textures/particles.png');

console.log('wrote public/textures/particles.png', COLS * TILE + 'x' + ROWS * TILE, '\ntiles:', files.join(', '));
