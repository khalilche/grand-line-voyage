/**
 * Biome palettes + prop kits. An island definition names a biome; the Island
 * builder pulls colours, tree species and scatter densities from here so every
 * themed island shares one coherent art language.
 */
export const BIOMES = {
  pirate_village: {
    grass: 0x62ac4d, grassLight: 0x84c95b, grassDark: 0x3b7a37,
    sand: 0xe7d3a1, sandWet: 0xccb888, rock: 0x565b64, cliff: 0x4b5058,
    tree: 'palm', treeCount: 22, rockCount: 8, grassMul: 1.0,
    fog: 0xbcdcf2
  },
  bandit_cove: {
    grass: 0x8f9a58, grassLight: 0xaab070, grassDark: 0x5f6a39,
    sand: 0xd7c69a, sandWet: 0xbdaa7c, rock: 0x504a43, cliff: 0x453f39,
    tree: 'deadwood', treeCount: 12, rockCount: 24, grassMul: 0.35,
    fog: 0xcdd0c0
  },
  jungle_ruins: {
    grass: 0x2f7d3c, grassLight: 0x45994a, grassDark: 0x1d5330,
    sand: 0xcab98a, sandWet: 0xac9a72, rock: 0x4c5147, cliff: 0x40453c,
    tree: 'jungle', treeCount: 30, rockCount: 16, grassMul: 1.4,
    fog: 0xa9c9b0
  },
  marine_base: {
    grass: 0x6fae5a, grassLight: 0x8ac866, grassDark: 0x477e3e,
    sand: 0xe4d3a8, sandWet: 0xc9b788, rock: 0x646a74, cliff: 0x565c66,
    tree: 'pine', treeCount: 18, rockCount: 14, grassMul: 0.8,
    fog: 0xc4dcee
  },
  frozen: {
    grass: 0xd8e6ec, grassLight: 0xeef6fa, grassDark: 0xa9c1cc,
    sand: 0xe9eef2, sandWet: 0xc9d6dd, rock: 0x8e9aa6, cliff: 0x7c8894,
    tree: 'pine_snow', treeCount: 16, rockCount: 22, grassMul: 0.2,
    fog: 0xdfeaf0
  },
  // Fruit-Battlegrounds-style arena: bright open grass field, grey stone,
  // scattered rock cover, ringed by cliffs falling to the sea.
  arena: {
    grass: 0x6fbf52, grassLight: 0x93d968, grassDark: 0x4a8f3c,
    sand: 0xd9c9a4, sandWet: 0xbfae82, rock: 0x707680, cliff: 0x5a6069,
    tree: 'palm', treeCount: 0, rockCount: 30, grassMul: 1.1,
    fog: 0xbfe0f2
  }
};

export function biome(name) {
  return BIOMES[name] || BIOMES.pirate_village;
}
