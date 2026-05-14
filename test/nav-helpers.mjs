// Module-scoped constants (need to be outside IIFE for ESM export)
const MAX_TELEPORT_ATTEMPTS = 3;

/**
 * nav-helpers.mjs — NetHack Navigation AI: Shared helper functions
 *
 * Pure utility functions used by multiple handler modules.
 * Attached to window.NHNav so handlers can destructure them from navCtx.
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-helpers.mjs'); return; }

  const { W, H, DIRS, MONSTERS, isWalkable, isBfsWalkable } = NH;

  // Check if a position is adjacent to a wall, door, or corridor edge
  function isAdjacentToWall(px, py, grid) {
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ch = (grid[ny]||'')[nx] || ' ';
      if (ch === '|' || ch === '-' || ch === '+' || ch === '#') return true;
    }
    return false;
  }

  // Build a limited perimeter path around the room using right-hand rule.
  // Returns array of {x,y} positions along the wall edge, in visit order.
  // Capped to ~60 positions to avoid spending too many ticks in large rooms.
  function buildWallFollowPath(px, py, grid) {
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const queue = [{x: px, y: py}];
    visited[py][px] = 1;
    let head = 0;
    const wallAdj = [];
    while (head < queue.length) {
      const cur = queue[head++];
      const curCh = (grid[cur.y]||'')[cur.x] || ' ';
      if (curCh !== '#' && isBfsWalkable(curCh) &&
          curCh !== '|' && curCh !== '-' &&
          isAdjacentToWall(cur.x, cur.y, grid)) {
        wallAdj.push(cur);
      }
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (!isBfsWalkable(ch)) continue;
        if (MONSTERS.has(ch)) continue;
        visited[ny][nx] = 1;
        queue.push({x: nx, y: ny});
      }
    }
    if (wallAdj.length === 0) return [];
    wallAdj.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
    if (wallAdj.length > 60) {
      const sampled = [];
      const step = Math.floor(wallAdj.length / 60);
      for (let i = 0; i < wallAdj.length; i += step) sampled.push(wallAdj[i]);
      return sampled;
    }
    return wallAdj;
  }

  // Check if position is a corridor dead end (only one walkable direction)
  function isInDeadEnd(px, py, grid) {
    const ch = (grid[py]||'')[px] || ' ';
    if (ch !== '#') return -1;
    let walkableDirs = 0;
    let exitDir = -1;
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nch = (grid[ny]||'')[nx] || ' ';
      if (isWalkable(nch) && !MONSTERS.has(nch)) {
        walkableDirs++;
        exitDir = di;
      }
    }
    return walkableDirs <= 1 ? exitDir : -1;
  }

  // Find nearest wall-adjacent position not yet searched
  // searchedWallPos: Set of "x,y" strings for already-searched positions
  function findNearestUnsearchedWall(px, py, grid, searchedWallPos) {
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const parent = Array.from({length: H}, () => new Array(W).fill(null));
    const queue = [{x: px, y: py}];
    visited[py][px] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const curCh = (grid[cur.y]||'')[cur.x] || ' ';
      if (curCh !== '#' && isAdjacentToWall(cur.x, cur.y, grid)) {
        const key = cur.x + ',' + cur.y;
        if (!searchedWallPos.has(key)) {
          if (cur.x === px && cur.y === py) return cur;
          let step = cur;
          while (parent[step.y][step.x] &&
                 !(parent[step.y][step.x].x === px && parent[step.y][step.x].y === py)) {
            step = parent[step.y][step.x];
          }
          return step;
        }
      }
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (!isBfsWalkable(ch)) continue;
        if (MONSTERS.has(ch)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    searchedWallPos.clear();
    return null;
  }

  // Check search results from recent messages
  function checkSearchResults(msgs) {
    return msgs.some(m => m.toLowerCase().includes('find'));
  }

  // Attempt to teleport (returns true if teleport was initiated)
  // navCtx: navigation context (needs teleportAttempts, teleportFailed, env)
  function tryTeleport(navCtx) {
    if (navCtx.teleportAttempts >= MAX_TELEPORT_ATTEMPTS) return false;
    if (navCtx.teleportFailed) return false;
    navCtx.teleportAttempts++;
    console.log(`[NAV] Attempting teleport (${navCtx.teleportAttempts}/${MAX_TELEPORT_ATTEMPTS})`);
    navCtx.env.sendKey(20); // ^T = teleport in this NetHack build
    return true;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, {
    isAdjacentToWall,
    buildWallFollowPath,
    isInDeadEnd,
    findNearestUnsearchedWall,
    checkSearchResults,
    tryTeleport,
    MAX_TELEPORT_ATTEMPTS,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const {
  isAdjacentToWall,
  buildWallFollowPath,
  isInDeadEnd,
  findNearestUnsearchedWall,
  checkSearchResults,
  tryTeleport,
} = globalThis.NHNav || {};

export { MAX_TELEPORT_ATTEMPTS };
