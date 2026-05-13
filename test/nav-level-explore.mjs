/**
 * nav-level-explore.mjs — NetHack Navigation AI: Level exploration
 *
 * Systematic level exploration when no stairs are visible.
 * This is the PRIMARY exploration strategy — called BEFORE corridor following
 * when stairs are not yet found.
 *
 * Uses BFS to find unexplored areas and navigates toward them.
 * When exploration is stuck (blocked by boulde/pet), falls back to waiting.
 *
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-level-explore.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
          bfs, bfsAvoiding, scanMap } = NH;

  /**
   * Systematic level exploration when no stairs visible.
   * Returns true if this handler consumed the tick.
   *
   * This handler runs BEFORE corridor following when stairs are not found.
   * It BFSes to unexplored areas and prefers directions leading to new rooms.
   */
  function handleLevelExplore(navCtx) {
    const { env, player, grid, stairs, features, isInCorridor,
            stuckCount, tickCount, recentPositions, knownTrapPositions } = navCtx;
    const blocked = knownTrapPositions || new Set();

    // Only active when no stairs are visible
    if (stairs) return false;

    // Critical hunger override: if we're starving (Weak/Fainting/Fainted) and
    // no stairs/food visible, ignore wall-search phase and force exploration.
    // Better to wander aimlessly than die starving in a room.
    const hungerTrimmed = (env.getHunger() || '').trim();
    const isCriticalHunger = hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainting' ||
                             hungerTrimmed === 'Fainted';
    if (isCriticalHunger && !navCtx.stairs && !navCtx.food) {
      navCtx.wallSearchPhase = false; // Break out of wall search
      // Continue below to force-explore
    }

    // Defer to wall search when it's active (unless critical hunger override above)
    if (navCtx.wallSearchPhase) return false;

    // When in a corridor, let corridor handler deal with it
    // UNLESS we're stuck (same position for too long) or critical hunger
    if (isInCorridor && stuckCount < 10 && !isCriticalHunger) return false;

    // ---- Oscillation check ----
    let isOscillating = false;
    if (recentPositions.length >= 8) {
      const posSet = new Set();
      for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
      isOscillating = posSet.size <= 4;
    }

    // ---- CRITICAL: Navigate to untried doors FIRST ----
    // Stairs are always in rooms. Each door potentially leads to a room with stairs.
    // This is the MOST IMPORTANT step — must run before findNearestUnexplored.
    if (!isInCorridor && features.doors.length > 0) {
      let nearestUntriedDoor = null, nearestDoorDist = Infinity;
      for (const door of features.doors) {
        const key = door.x + ',' + door.y;
        if (navCtx.triedDoors.has(key)) continue;
        const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
        if (dist > 0 && dist < nearestDoorDist) {
          nearestDoorDist = dist; nearestUntriedDoor = door;
        }
      }
      if (nearestUntriedDoor) {
        // Adjacent to door — open it
        const ddx = nearestUntriedDoor.x - player.x;
        const ddy = nearestUntriedDoor.y - player.y;
        if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===ddx && ddy===ddy);
          if (idx >= 0) {
            const doorKey = nearestUntriedDoor.x + ',' + nearestUntriedDoor.y;
            if (navCtx.triedDoors.has(doorKey)) return false;
            console.log(`[NAV] Level-explore: opening untried door at ${doorKey}`);
            env.sendKey('o'.charCodeAt(0));
            navCtx.pendingDir = idx;
            return true;
          }
        }
        // Non-adjacent — BFS to it
        const next = bfsAvoiding(player.x, player.y, nearestUntriedDoor.x, nearestUntriedDoor.y, grid, blocked, navCtx.openedDoors);
        if (next) {
          const nch = (grid[next.y]||'')[next.x] || ' ';
          if (nch === '+') {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              console.log(`[NAV] Level-explore: navigating to untried door at ${nearestUntriedDoor.x},${nearestUntriedDoor.y} and opening`);
              env.sendKey('o'.charCodeAt(0));
              navCtx.pendingDir = idx;
              return true;
            }
          }
          if (!PET_CHARS.has(nch)) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
    }

    // ---- BFS to unexplored areas (fallback when no untried doors) ----
    // Only search for unexplored boundaries after all doors have been tried.
    // Capped BFS in findNearestUnexplored prevents chasing distant targets.
    const boundary = NH.findNearestUnexplored(grid, player.x, player.y, blocked);
    if (boundary) {
      const bch = (grid[boundary.y]||'')[boundary.x] || ' ';
      if (isWalkable(bch) && !MONSTERS.has(bch)) {
        const next = bfsAvoiding(player.x, player.y, boundary.x, boundary.y, grid, blocked, navCtx.openedDoors);
        if (next) {
          const nch = (grid[next.y]||'')[next.x] || ' ';
          if (nch === '`') {
            // Boulder in path — try to push it
            const dx = next.x - player.x, dy = next.y - player.y;
            const di = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
            if (di >= 0) {
              const pushX = next.x + dx, pushY = next.y + dy;
              if (pushX >= 0 && pushX < W && pushY >= 0 && pushY < H) {
                const pushCh = (grid[pushY]||'')[pushX] || ' ';
                if (pushCh === '#' || pushCh === '.' || pushCh === ' ') {
                  env.sendKey(KEY[di].charCodeAt(0));
                  return true;
                }
              }
            }
          }
          // If next step is a closed door, open it instead of bumping
          if (nch === '+') {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0 && !navCtx.triedDoors.has(next.x + ',' + next.y)) {
              console.log(`[NAV] Level-explore: opening door at ${next.x},${next.y}`);
              env.sendKey('o'.charCodeAt(0));
              navCtx.pendingDir = idx;
              return true;
            }
          }
          if (!PET_CHARS.has(nch) || !(nch === 'd' && navCtx.hadPetBlock)) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
    }

    // ---- Corridor/room navigation (when no untried doors) ----
    // Navigate to nearest corridor tile to enter corridor network
    if (!isInCorridor) {
      let bestCorridor = null, bestDist = Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if ((grid[y]||'')[x] !== '#') continue;
          const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
          // Prefer corridor junctions (tiles with 3+ walkable neighbors)
          let walkableNeighbors = 0;
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nch = (grid[ny]||'')[nx] || ' ';
            if (isBfsWalkable(nch)) walkableNeighbors++;
          }
          const score = dist + (walkableNeighbors >= 3 ? -10 : 0);
          if (score < bestDist) { bestDist = score; bestCorridor = { x, y }; }
        }
      }
      if (bestCorridor) {
        const next = bfsAvoiding(player.x, player.y, bestCorridor.x, bestCorridor.y, grid, blocked, navCtx.openedDoors);
        if (next) {
          const nch = (grid[next.y]||'')[next.x] || ' ';
          // If next step is a closed door, open it
          if (nch === '+') {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0 && !navCtx.triedDoors.has(next.x + ',' + next.y)) {
              console.log(`[NAV] Level-explore (corridor): opening door at ${next.x},${next.y}`);
              env.sendKey('o'.charCodeAt(0));
              navCtx.pendingDir = idx;
              return true;
            }
          }
          if (!PET_CHARS.has(nch)) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
    }

    // ---- Corridor junction navigation ----
    // When in corridor, navigate to unexplored junction
    if (isInCorridor) {
      // Find corridor junctions (tiles with 3+ walkable neighbors)
      let bestJunction = null, bestDist = Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if ((grid[y]||'')[x] !== '#') continue;
          let walkableNeighbors = 0;
          let isJunction = false;
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nch = (grid[ny]||'')[nx] || ' ';
            if (isBfsWalkable(nch)) {
              walkableNeighbors++;
              if (walkableNeighbors >= 3) isJunction = true;
            }
          }
          if (!isJunction) continue;
          // Check if this junction leads to unexplored areas
          let leadsToUnexplored = false;
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nch = (grid[ny]||'')[nx] || ' ';
            // Corridor continuing or room entrance
            if (nch === '#' || nch === '.' || nch === '<' || nch === '>') {
              // Check if there's unexplored space beyond
              for (const [ddx, ddy] of DIRS) {
                const nnx = nx + ddx, nny = ny + ddy;
                if (nnx < 0 || nnx >= W || nny < 0 || nny >= H) continue;
                const nnch = (grid[nny]||'')[nnx] || ' ';
                if (isBfsWalkable(nnch)) { leadsToUnexplored = true; break; }
              }
            }
          }
          const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
          if (dist > 0 && dist < bestDist) { bestDist = dist; bestJunction = { x, y }; }
        }
      }
      if (bestJunction) {
        const next = bfsAvoiding(player.x, player.y, bestJunction.x, bestJunction.y, grid, blocked, navCtx.openedDoors);
        if (next) {
          const nch = (grid[next.y]||'')[next.x] || ' ';
          if (!PET_CHARS.has(nch)) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
    }

    // ---- Stuck: try waiting a few ticks to let pets move ----
    if (stuckCount > 3) {
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleLevelExplore });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleLevelExplore } = global.NHNav || {};
