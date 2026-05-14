/**
 * nav-stairs.mjs — NetHack Navigation AI: Stairs navigation
 *
 * Navigates toward known stairs using BFS. Opens doors blocking the path.
 * Handles the case where stairs were previously visible but now obscured.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-stairs.js'); return; }

  const { W, H, DIRS, KEY, bfs, bfsAvoiding, bfsRush } = NH;

  /**
   * Navigate to stairs if visible. Opens doors blocking the path.
   * Returns true if this handler consumed the tick.
   */
  function handleStairs(navCtx) {
    const { env, player, grid, stairs, features, triedDoors } = navCtx;

    if (stairs) {
      navCtx.lastStairsPos = { x: stairs.x, y: stairs.y, stairsType: '>' };

      // On the stairs — descend
      if (player.x === stairs.x && player.y === stairs.y) {
        env.sendKey(62); // '>'
        return true;
      }

      // BFS path to stairs — use rush BFS (ignores monsters) when in combat or low HP
      const blocked = navCtx.knownTrapPositions || new Set();
      const inCombat = navCtx.features && navCtx.features.monsters.some(m => {
        const dist = Math.abs(m.x - player.x) + Math.abs(m.y - player.y);
        return dist <= 1;
      });
      const useRush = inCombat || (navCtx.maxHp > 0 && navCtx.currentHp / navCtx.maxHp < 0.5);
      const next = useRush
        ? bfsRush(player.x, player.y, stairs.x, stairs.y, grid, navCtx.openedDoors, blocked)
        : bfsAvoiding(player.x, player.y, stairs.x, stairs.y, grid, blocked, navCtx.openedDoors);
      if (next) {
        navCtx.wallSearchPhase = false;
        navCtx.enclosedTick = 0;
        const nextCh = (grid[next.y]||'')[next.x] || ' ';
        // If pet swap is blocked, don't path through pets — it causes oscillation
        if (MONSTERS.has(nextCh) && navCtx.petSwapBlocked) {
          return false;
        }
        // Open door on the path
        if (nextCh === '+') {
          env.sendKey('o'.charCodeAt(0));
          navCtx.pendingDir = DIRS.findIndex(([ddx,ddy]) =>
            ddx===(next.x-player.x) && ddy===(next.y-player.y));
          return true;
        }
        const idx = DIRS.findIndex(([ddx,ddy]) =>
          ddx===(next.x-player.x) && ddy===(next.y-player.y));
        if (idx >= 0) { navCtx.lastMoveDir = idx; env.sendKey(KEY[idx].charCodeAt(0)); return true; }
      } else {
        // BFS failed — the path is blocked. Find and mark blocking doors as tried
        // so the level search knows to try other approaches (wall search, etc.)
        const dx = stairs.x - player.x, dy = stairs.y - player.y;
        const blockingDoors = features.doors.filter(d => {
          // Only consider doors roughly in the direction of stairs
          const doorDx = d.x - player.x, doorDy = d.y - player.y;
          return (Math.sign(doorDx) === Math.sign(dx) || doorDx === 0) &&
                 (Math.sign(doorDy) === Math.sign(dy) || doorDy === 0);
        });
        for (const door of blockingDoors) {
          const doorKey = door.x + ',' + door.y;
          if (!triedDoors.has(doorKey)) {
            console.log(`[NAV] BFS to stairs blocked by door at ${doorKey}, marking as tried`);
            triedDoors.add(doorKey);
          }
        }
        // Also try to open doors that might be blocking the path
        if (blockingDoors.length > 0) {
          let bestDoor = null, bestDist = Infinity;
          for (const door of blockingDoors) {
            const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
            if (dist < bestDist) { bestDist = dist; bestDoor = door; }
          }
          const ddx = bestDoor.x - player.x, ddy = bestDoor.y - player.y;
          if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
            env.sendKey('o'.charCodeAt(0));
            navCtx.pendingDir = DIRS.findIndex(([dx2,dy2]) => dx2===ddx && dy2===ddy);
            return true;
          }
          const doorNext = bfsAvoiding(player.x, player.y, bestDoor.x, bestDoor.y, grid, blocked, navCtx.openedDoors);
          if (doorNext) {
            const idx = DIRS.findIndex(([ddx2,ddy2]) =>
              ddx2===(doorNext.x-player.x) && ddy2===(doorNext.y-player.y));
            if (idx >= 0) { navCtx.lastMoveDir = idx; env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }
      }
    }

    // Stairs may have been visible before but not now (monster on top?)
    const { lastStairsPos } = navCtx;
    if (lastStairsPos && player.x === lastStairsPos.x && player.y === lastStairsPos.y) {
      // Only descend if stairs are actually present on the grid
      // Note: when player is on stairs, grid shows '@' not '<' or '>'
      const tileCh = (grid[player.y]||'')[player.x] || ' ';
      if (tileCh === '>' || (tileCh === '@' && lastStairsPos.stairsType !== '<')) {
        env.sendKey(62);
        return true;
      }
      // Standing on up-stairs ('<') — don't try to descend
      if (tileCh === '<') {
        navCtx.lastStairsPos = null;
      }
      // Stairs not actually here anymore — clear stale reference
      navCtx.lastStairsPos = null;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleStairs });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleStairs } = global.NHNav || {};
