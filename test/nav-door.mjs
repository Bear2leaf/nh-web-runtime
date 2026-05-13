/**
 * nav-door.mjs — NetHack Navigation AI: Door navigation
 *
 * Navigates to visible doors, opens adjacent doors, kicks locked doors.
 * Skips doors in triedDoors set. Respects legInjured flag.
 * Kicks locked doors multiple times before giving up.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-door.js'); return; }

  const { W, H, DIRS, KEY, bfs } = NH;

  const MAX_KICK_ATTEMPTS = 5;
  const MAX_OPEN_ATTEMPTS = 3;

  /**
   * Navigate to and open doors. Kick locked doors (unless leg is injured).
   * Returns true if this handler consumed the tick.
   */
  function handleDoors(navCtx) {
    const { env, player, grid, features, triedDoors, legInjured } = navCtx;

    // During wall search, let the wall search handler deal with navigation to distant
    // doors. But we ALWAYS handle adjacent doors — stuck + locked door + pet blocking
    // can deadlock if we defer to wall search here (wall search can't unstick).
    const isWallSearchActive = navCtx.wallSearchPhase;
    if (isWallSearchActive) {
      // Check if any door is adjacent — if so, handle it immediately
      const adjDoor = features.doors.find(d => {
        const ddx = d.x - player.x, ddy = d.y - player.y;
        return Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1;
      });
      if (!adjDoor) return false; // Defer to wall search for non-adjacent doors
    }

    if (!navCtx.kickAttempts) navCtx.kickAttempts = new Map();

    const untriedDoors = features.doors.filter(d => {
      const key = d.x + ',' + d.y;
      if (triedDoors.has(key)) return false;
      // Also skip doors where we've exhausted kick attempts
      const kicks = navCtx.kickAttempts.get(key) || 0;
      if (kicks >= MAX_KICK_ATTEMPTS) return false;
      // During wall search, only consider adjacent doors
      if (isWallSearchActive) {
        const ddx = d.x - player.x, ddy = d.y - player.y;
        if (Math.abs(ddx) > 1 || Math.abs(ddy) > 1) return false;
      }
      return true;
    });
    if (untriedDoors.length === 0) return false;

    // Track consecutive failed attempts at the same door — if pet or monster keeps
    // blocking the same door for many ticks, give up and let teleport/unexplore run.
    const doorFailKey = untriedDoors[0] ? (untriedDoors[0].x + ',' + untriedDoors[0].y) : null;
    if (doorFailKey) {
      if (navCtx._lastDoorFailKey === doorFailKey) {
        navCtx._doorFailCount = (navCtx._doorFailCount || 0) + 1;
        if (navCtx._doorFailCount > 10) {
          triedDoors.add(doorFailKey);
          console.log(`[NAV] Door ${doorFailKey} blocked too long, marking as tried`);
          navCtx._doorFailCount = 0;
          navCtx._lastDoorFailKey = null;
          return false; // Let other handlers try something else
        }
      } else {
        navCtx._lastDoorFailKey = doorFailKey;
        navCtx._doorFailCount = 1;
      }
    }

    let bestDoor = null, bestNext = null, bestDist = Infinity;

    for (const door of untriedDoors) {
      const ddx = door.x - player.x, ddy = door.y - player.y;
      const doorKey = door.x + ',' + door.y;

      // Adjacent door — try to open it
      if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
        if (navCtx.lastDoorPos === doorKey) {
          navCtx.doorOpenAttempts++;
        } else {
          navCtx.lastDoorPos = doorKey;
          navCtx.doorOpenAttempts = 1;
        }

        // Locked after multiple open attempts — try kicking
        if (navCtx.doorOpenAttempts > MAX_OPEN_ATTEMPTS) {
          const kickCount = navCtx.kickAttempts.get(doorKey) || 0;
          if (kickCount >= MAX_KICK_ATTEMPTS) {
            // Exhausted all kick attempts — mark as tried
            triedDoors.add(doorKey);
            navCtx.doorOpenAttempts = 0;
            navCtx.lastDoorPos = null;
            console.log(`[NAV] Door at ${doorKey} still locked after ${MAX_KICK_ATTEMPTS} kicks, giving up`);
            continue;
          }
          if (legInjured) {
            triedDoors.add(doorKey);
            navCtx.doorOpenAttempts = 0;
            navCtx.lastDoorPos = null;
            console.log(`[NAV] Door at ${doorKey} is locked, leg injured — giving up`);
            continue;
          }
          navCtx.kickAttempts.set(doorKey, kickCount + 1);
          // Once kicked, the tile may become '-'/'|' (broken door) — mark walkable
          if (navCtx.openedDoors) navCtx.openedDoors.add(doorKey);
          console.log(`[NAV] Kicking door at ${doorKey} (attempt ${kickCount + 1}/${MAX_KICK_ATTEMPTS})`);
          env.sendKey(4); // ^D = kick
          navCtx.pendingKickDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
          return true;
        }

        // Optimistically remember door position as walkable — once opened, the tile
        // becomes '-' or '|', which BFS otherwise treats as a wall.
        if (navCtx.openedDoors) navCtx.openedDoors.add(doorKey);
        env.sendKey('o'.charCodeAt(0));
        navCtx.pendingDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
        return true;
      }

      // Non-adjacent door — BFS to it
      const next = bfs(player.x, player.y, door.x, door.y, grid, navCtx.openedDoors);
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
