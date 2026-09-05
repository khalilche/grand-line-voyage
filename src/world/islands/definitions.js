/**
 * Battleground mode. `arena: true` on the first entry makes World build the
 * handcrafted Arena (src/world/Arena.js) instead of the procedural islands —
 * geometry, spawn, walkable surface and training dummies all live there.
 * No exploration, sailing, world map or NPCs.
 */
export const ISLANDS = [
  { id: 'battleground', name: 'Plaza del Juicio', arena: true }
];

/** No map stubs in battleground mode. */
export const ISLAND_STUBS = [];

export const SEA_BOUNDS = { minX: -520, maxX: 520, minZ: -520, maxZ: 520 };
