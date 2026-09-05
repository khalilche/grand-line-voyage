/**
 * Quality tiers. `?lite` (or ?q=lite) trims the expensive passes so the game
 * boots on software GL / weak hardware; `?q=ultra` pushes everything up.
 */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
let tier = params.get('q') || (params.has('lite') ? 'lite' : 'high');
if (!['lite', 'high', 'ultra'].includes(tier)) tier = 'high';

const TIERS = {
  lite: {
    post: false, bloom: false, smaa: false, grade: false,
    shadowMap: 1024, oceanSegments: 120, oceanSize: 600,
    grassBlades: 250, pixelRatioCap: 1, shadows: true
  },
  high: {
    post: true, bloom: true, smaa: true, grade: true,
    shadowMap: 2048, oceanSegments: 190, oceanSize: 780,
    grassBlades: 1100, pixelRatioCap: 2, shadows: true
  },
  ultra: {
    post: true, bloom: true, smaa: true, grade: true,
    shadowMap: 4096, oceanSegments: 420, oceanSize: 1100,
    grassBlades: 1600, pixelRatioCap: 2, shadows: true
  }
};

export const QUALITY = { tier, ...TIERS[tier] };
