// One-off: turn the raw Hunyuan 3D meteor export into a game-ready prop.
//   - strips normal / metallic-roughness / occlusion maps (stylized game)
//   - bakes node transforms, recenters geometry on the origin
//   - downsizes the base-colour texture to 512
// Geometry was already decimated 1M -> 20k tris by `gltf-transform optimize`.
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, flatten, weld, center, clearNodeTransform, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

const FILE = 'public/models/meteor.glb';

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(FILE);
const root = doc.getRoot();

for (const mat of root.listMaterials()) {
  mat.setNormalTexture(null);
  mat.setMetallicRoughnessTexture(null);
  mat.setOcclusionTexture(null);
  mat.setMetallicFactor(0);
  mat.setRoughnessFactor(1);
}

await doc.transform(flatten());
for (const node of root.listNodes()) clearNodeTransform(node);

await doc.transform(
  dedup(),
  weld(),
  center({ pivot: 'center' }),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'png', resize: [512, 512] }),
);

await io.write(FILE, doc);
console.log('wrote', FILE);
