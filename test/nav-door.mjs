/**
 * nav-door.mjs — NetHack Navigation AI: Door navigation
 *
 * Navigates to visible doors, opens adjacent doors, kicks locked doors.
 * Skips doors in triedDoors set. Respects legInjured flag.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-door.js'); return; }

  const { W, H, DIRS, KEY, bfs } = NH;

  /**
   * Navigate to and open doors. Kick locked doors (unless leg is injured).
   * Returns true if this handler consumed the tick.
   */
  function handleDoors(navCtx) {
    const { env, player, grid, features, triedDoors, legInjured } = navCtx;

    const untriedDoors = features.doors.filter(d => !triedDoors.has(d.x + ',' + d.y));
    if (untriedDoors.length === 0) return false;

    let bestDoor = null, bestNext = null, bestDist = Infinity;

    for (const door of untriedDoors) {
      const ddx = door.x - player.x, ddy = door.y - player.y;

      // Adjacent door — try to open it
      if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
        const doorKey = door.x + ',' + door.y;
        if (navCtx.lastDoorPos === doorKey) {
          navCtx.doorOpenAttempts++;
        } else {
          navCtx.lastDoorPos = doorKey;
          navCtx.doorOpenAttempts = 1;
        }

        // Locked after multiple open attempts
        if (navCtx.doorOpenAttempts > 2) {
          triedDoors.add(doorKey);
          navCtx.doorOpenAttempts = 0;
          navCtx.lastDoorPos = null;
          if (legInjured) {
            console.log(`[NAV] Door at ${doorKey} is locked, leg injured — giving up`);
            // Fall through to try other navigation
          } else {
            console.log(`[NAV] Door at ${doorKey} seems locked, kicking`);
            env.sendKey(4); // ^D = kick
            navCtx.pendingKickDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
            return true;
          }
        }

        env.sendKey('o'.charCodeAt(0));
        navCtx.pendingDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
        return true;
      }

      // Non-adjacent door — BFS to it
      const next = bfs(player.x, player.y, door.x, door.y, grid);
      if (next) {
        const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
        if (dist < bestDist) { bestDist = dist; bestDoor = door; bestNext = next; }
      }
    }

    // Navigate to the nearest reachable door
    if (bestNext) {
      navCtx.wallSearchPhase = false;
      navCtx.enclosedTick = 0;
      const nextCh = (grid[bestNext.y]||'')[bestNext.x] || ' ';
      if (nextCh === '+') {
        env.sendKey('o'.charCodeAt(0));
        navCtx.pendingDir = DIRS.findIndex(([ddx,ddy]) =>
          ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
        return true;
      }
      const idx = DIRS.findIndex(([ddx,ddy]) =>
        ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
      if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleDoors });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleDoors } = global.NHNav || {};
