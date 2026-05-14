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

  const { W, H, DIRS, KEY, MONSTERS, isWalkable, shuffleDirs } = NH;

  /**
   * Explore unexplored boundaries and fall back to random walk.
   * Always returns true (last resort handler).
   */
  function handleExplore(navCtx) {
    const { env, player, grid, knownTrapPositions, recentPositions, tickCount } = navCtx;
    const blocked = knownTrapPositions || new Set();

    // ---- Oscillation breaker: if we're bouncing between 2 tiles, force a random direction ----
    if (recentPositions.length >= 8) {
      const posSet = new Set();
      for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
      if (posSet.size <= 2 && tickCount - (navCtx.lastOscBreakTick || 0) > 10) {
        navCtx.lastOscBreakTick = tickCount;
        console.log(`[NAV-EXPLORE] Breaking 2-tile oscillation, forcing random direction`);
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ch = (grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch) && !MONSTERS.has(ch)) {
              if (!blocked.has(nx + ',' + ny)) {
                navCtx.lastMoveDir = di;
                env.sendKey(KEY[di].charCodeAt(0));
                return true;
              }
            }
          }
        }
      }
    }

    // ---- Unexplored boundary ----
    const boundary = NH.findNearestUnexplored(grid, player.x, player.y, blocked);
    if (boundary) {
      const bch = (grid[boundary.y]||'')[boundary.x] || ' ';
      if (isWalkable(bch)) {
        const dx = boundary.x - player.x, dy = boundary.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
        if (idx >= 0) { navCtx.lastMoveDir = idx; env.sendKey(KEY[idx].charCodeAt(0)); return true; }
      }
    }

    // ---- Random walkable direction (avoiding known traps) ----
    const shuffled = shuffleDirs();
    for (const di of shuffled) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) {
          if (blocked.has(nx + ',' + ny)) continue;
          navCtx.lastMoveDir = di;
          env.sendKey(KEY[di].charCodeAt(0));
          return true;
        }
      }
    }

    // No walkable moves — wait
    navCtx.lastMoveDir = -1;
    env.sendKey('.'.charCodeAt(0));
    return true;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleExplore });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleExplore } = global.NHNav || {};