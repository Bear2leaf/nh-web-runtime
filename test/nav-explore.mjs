/**
 * nav-explore.mjs — NetHack Navigation AI: Exploration & fallback movement
 *
 * Handles: unexplored boundary navigation, random walkable direction fallback,
 * and the last-resort wait action.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-explore.js'); return; }

  const { W, H, DIRS, KEY, PET_CHARS, isWalkable, shuffleDirs } = NH;

  /**
   * Explore unexplored boundaries and fall back to random walk.
   * Always returns true (last resort handler).
   */
  function handleExplore(navCtx) {
    const { env, player, grid } = navCtx;

    // ---- Unexplored boundary ----
    const boundary = NH.findNearestUnexplored(grid, player.x, player.y);
    if (boundary) {
      const bch = (grid[boundary.y]||'')[boundary.x] || ' ';
      if (!PET_CHARS.has(bch) && isWalkable(bch)) {
        const dx = boundary.x - player.x, dy = boundary.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
        if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
      }
    }

    // ---- Random walkable direction ----
    const shuffled = shuffleDirs();
    for (const di of shuffled) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) {
          // Avoid swapping places with pets
          if (PET_CHARS.has(ch)) continue;
          env.sendKey(KEY[di].charCodeAt(0));
          return true;
        }
      }
    }

    // No walkable moves — wait
    env.sendKey('.'.charCodeAt(0));
    return true;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleExplore });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleExplore } = global.NHNav || {};