/**
 * nav-wall-search.mjs — NetHack Navigation AI: Wall search / perimeter walking
 *
 * Handles: enclosed room detection, wall-follow path building, perimeter
 * position traversal, wall-adjacent searching, post-search navigation.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-wall-search.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
          bfs, scanMap, findOnMap, shuffleDirs, tryTeleport, buildWallFollowPath,
          isAdjacentToWall, findNearestUnsearchedWall } = NH;

  /**
   * Main handler: enclosed detection, wall search triggering, and execution.
   * Returns true if this handler consumed the tick.
   */
  function handleWallSearch(navCtx) {
    const { env, player, grid, features, stairs, tickCount, isInCorridor,
            recentPositions, wallSearchPhase, stuckCount, teleportAttempts,
            isAdjacentToWall } = navCtx;

    // NOTE: enclosedTick accumulation and wall search triggering are now done in
    // updateMapAndState() in nav-ai.mjs (before handlers run). This ensures the
    // logic always executes even when higher-priority handlers would consume the tick.

    // If player is hungry (not just weak/fainting), bail out of wall search
    // so the food handler can eat from inventory before starving
    if (navCtx.wallSearchPhase) {
      const hungerText = (env.getHunger() || '').trim();
      const isHungry = hungerText === 'Hungry' || hungerText === 'Weak' ||
                       hungerText === 'Fainting' || hungerText === 'Fainted';
      const noFood = navCtx.msgs.some(m => m.includes("don't have anything to eat"));
      if (isHungry) {
        navCtx.wallSearchPhase = false;
        navCtx.wallSearchSuppressUntilTick = tickCount + 2000;
        console.log(`[NAV] Exiting wall search — hungry="${hungerText}" noFood=${noFood}, suppressing re-entry for 2000 ticks`);
        return false;
      }
    }

    // ---- Oscillation detection (for wall path updates) ----
    let isOscillating = false;
    if (recentPositions.length >= 8) {
      const posSet = new Set();
      for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
      if (posSet.size <= 4) isOscillating = true;
    }

    // NOTE: We previously exited wall search when entering a corridor or when a
    // corridor tile was within reach. Those checks caused infinite oscillation
    // between room and corridor when both were visible but neither led to stairs.
    // The corridor handler now defers to wall search (returns false when
    // wallSearchPhase is true), so wall search can navigate through corridors
    // back to room perimeter positions. Wall search still exits naturally when:
    //   - Stairs become visible (below)
    //   - Hunger becomes critical (above)
    //   - Perimeter is mostly searched (in executeWallSearch give-up logic)

    // If in wall search but stairs became visible, exit wall search
    if (navCtx.wallSearchPhase && stairs) {
      navCtx.wallSearchPhase = false;
      navCtx.wallFollowPath = [];
      navCtx.enclosedTick = 0;
      console.log('[NAV] Exiting wall search — stairs found');
      return false;
    }

    // Update wall path during oscillation only when already in wall search
    if (navCtx.wallSearchPhase && isOscillating && !isInCorridor) {
      const newPath = buildWallFollowPath(player.x, player.y, grid);
      if (newPath.length !== navCtx.wallFollowPath.length) {
        navCtx.wallFollowPath = newPath;
        if (navCtx.wallFollowIdx >= newPath.length) navCtx.wallFollowIdx = 0;
        console.log(`[NAV] Wall path updated during oscillation: ${newPath.length} positions`);
      }
    }

    // Corridor oscillation: teleport instead of wall search
    if (isOscillating && isInCorridor && stuckCount > 20 &&
        teleportAttempts < 3) {
      if (tryTeleport(navCtx)) {
        navCtx.wallSearchPhase = false;
        navCtx.wallFollowPath = [];
        navCtx.wallFollowIdx = 0;
        navCtx.wallFollowPasses = 0;
        navCtx.searchedWallPos.clear();
        return true;
      }
    }

    // ---- Wall search execution ----
    if (!navCtx.wallSearchPhase) return false;
    return executeWallSearch(navCtx);
  }

  // ---- Wall search execution ----
  function executeWallSearch(navCtx) {
    const { env, player, grid, features, stairs, tickCount, isAdjacentToWall } = navCtx;

    navCtx.wallSearchStep++;
    const ratio = navCtx.wallFollowPath.length > 0
      ? navCtx.searchedWallPos.size / navCtx.wallFollowPath.length : 0;

    // Teleport fallback
    if (((navCtx.wallFollowPasses >= 2 && ratio >= 0.4) ||
         (navCtx.wallFollowPasses >= 1 && ratio < 0.3)) &&
        navCtx.teleportAttempts < 3) {
      if (tryTeleport(navCtx)) {
        navCtx.wallSearchPhase = false;
        navCtx.wallFollowPath = [];
        navCtx.wallFollowIdx = 0;
        navCtx.wallFollowPasses = 0;
        navCtx.searchedWallPos.clear();
        return true;
      }
    }

    // Give up wall search if mostly searched
    if ((navCtx.enclosedTick > 500 && navCtx.wallFollowPasses >= 2 && ratio >= 0.5) ||
        (navCtx.wallFollowPasses >= 3 && ratio >= 0.8)) {
      navCtx.wallSearchPhase = false;
      navCtx.wallFollowPath = [];
      navCtx.wallFollowIdx = 0;
      navCtx.wallFollowPasses = 0;
      navCtx.searchedWallPos.clear();
      navCtx.enclosedTick = 0;
      // Jump corridorFailCount to 5 immediately so the corridor handler force-forwards
      // through dead-end corridors instead of retreating back to this same room.
      navCtx.corridorFailCount = Math.max(navCtx.corridorFailCount + 1, 5);
      // Suppress re-triggering wall search for ~300 ticks — give corridor force-forward
      // a chance to actually escape the area.
      navCtx.wallSearchSuppressUntilTick = tickCount + 2000;
      console.log(`[NAV] Wall search gave up (${ratio|0}% searched). Trying corridors. corridorFailCount=${navCtx.corridorFailCount}`);
      return true;
    }

    // Mark current position searched if stuck too long
    const curKey = player.x + ',' + player.y;
    if (navCtx.searchesAtCurrentPos > 3 && navCtx.lastWallPosKey === curKey) {
      navCtx.searchedWallPos.add(curKey);
      navCtx.searchesAtCurrentPos = 0;
      navCtx.lastWallPosKey = null;
    }

    // Walk the perimeter path
    if (navCtx.wallFollowPath.length > 0) {
      // Advance past already-searched positions
      while (navCtx.wallFollowIdx < navCtx.wallFollowPath.length &&
             navCtx.searchedWallPos.has(
               navCtx.wallFollowPath[navCtx.wallFollowIdx].x + ',' +
               navCtx.wallFollowPath[navCtx.wallFollowIdx].y)) {
        navCtx.wallFollowIdx++;
      }

      if (navCtx.wallFollowIdx >= navCtx.wallFollowPath.length) {
        navCtx.wallFollowIdx = 0;
        navCtx.wallFollowPasses++;
        console.log(`[NAV] Wall perimeter pass ${navCtx.wallFollowPasses} complete, searched=${navCtx.searchedWallPos.size}/${navCtx.wallFollowPath.length}`);
      }

      if (navCtx.wallFollowIdx < navCtx.wallFollowPath.length) {
        const target = navCtx.wallFollowPath[navCtx.wallFollowIdx];

        // At target — search
        if (target.x === player.x && target.y === player.y) {
          navCtx.searchedWallPos.add(curKey);
          navCtx.searchesAtCurrentPos = (navCtx.lastWallPosKey === curKey)
            ? navCtx.searchesAtCurrentPos + 1 : 1;
          navCtx.lastWallPosKey = curKey;
          navCtx.lastSearchTick = tickCount;
          navCtx.wallFollowIdx++;
          navCtx.wallFollowTargetRetries = 0;
          env.sendKey('s'.charCodeAt(0));
          return true;
        }

        // Navigate to target
        const next = bfs(player.x, player.y, target.x, target.y, grid, navCtx.openedDoors);
        if (next) {
          const nextCh = (grid[next.y]||'')[next.x] || ' ';

          // Pet blocking — try to work around
          if (PET_CHARS.has(nextCh)) {
            navCtx.wallFollowTargetRetries++;
            if (navCtx.wallFollowTargetRetries > 3) {
              navCtx.searchedWallPos.add(target.x + ',' + target.y);
              navCtx.wallFollowIdx++;
              navCtx.wallFollowTargetRetries = 0;
              return true;
            }
            // Search current position if wall-adjacent
            if (isAdjacentToWall(player.x, player.y, grid)) {
              const tKey = player.x + ',' + player.y;
              if (!navCtx.searchedWallPos.has(tKey)) {
                navCtx.searchedWallPos.add(tKey);
                navCtx.lastSearchTick = tickCount;
                env.sendKey('s'.charCodeAt(0));
                return true;
              }
            }
            // Try to swap with pet
            const nextIdx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (nextIdx >= 0) { env.sendKey(KEY[nextIdx].charCodeAt(0)); return true; }
            // Fallback: move toward target
            for (const di of shuffleDirs()) {
              const [ddx, ddy] = DIRS[di];
              const nx = player.x + ddx, ny = player.y + ddy;
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                const ch = (grid[ny]||'')[nx] || ' ';
                if (isWalkable(ch) && !MONSTERS.has(ch)) {
                  env.sendKey(KEY[di].charCodeAt(0));
                  return true;
                }
              }
            }
            env.sendKey('.'.charCodeAt(0));
            return true;
          }

          // Door in the way
          if (nextCh === '+') {
            const doorKey = next.x + ',' + next.y;
            if (navCtx.triedDoors.has(doorKey)) {
              navCtx.searchedWallPos.add(target.x + ',' + target.y);
              navCtx.wallFollowIdx++;
              navCtx.wallFollowTargetRetries = 0;
              return true;
            }
            env.sendKey('o'.charCodeAt(0));
            navCtx.pendingDir = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(next.x-player.x) && ddy===(next.y-player.y));
            return true;
          }

          const idx = DIRS.findIndex(([ddx,ddy]) =>
            ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }

        // BFS failed — mark target as unreachable and move on
        navCtx.searchedWallPos.add(target.x + ',' + target.y);
        navCtx.wallFollowIdx++;
        navCtx.wallFollowTargetRetries = 0;

        // If stuck for many ticks without making progress, try teleport
        if (navCtx.stuckCount > 40 && navCtx.teleportAttempts < 3) {
          if (tryTeleport(navCtx)) {
            navCtx.wallSearchPhase = false;
            navCtx.wallFollowPath = [];
            navCtx.wallFollowIdx = 0;
            navCtx.wallFollowPasses = 0;
            navCtx.searchedWallPos.clear();
            return true;
          }
        }
      }
    }

    // Periodic wall-adjacent searching
    if (navCtx.wallSearchStep % 4 === 0 && isAdjacentToWall(player.x, player.y, grid)) {
      const tKey = player.x + ',' + player.y;
      if (!navCtx.searchedWallPos.has(tKey)) {
        navCtx.searchedWallPos.add(tKey);
        navCtx.lastSearchTick = tickCount;
        env.sendKey('s'.charCodeAt(0));
        return true;
      }
    }

    // Post-search navigation to revealed features
    if (navCtx.lastSearchTick > 0 && tickCount === navCtx.lastSearchTick + 1 && features) {
      if (features.stairsDown.length > 0) {
        const s = features.stairsDown[0];
        const n = bfs(player.x, player.y, s.x, s.y, grid, navCtx.openedDoors);
        if (n) {
          const idx = DIRS.findIndex(([ddx,ddy]) =>
            ddx===(n.x-player.x) && ddy===(n.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }
      if (features.doors.length > 0) {
        let bestDoor = null, bestDist = Infinity;
        for (const door of features.doors) {
          const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
          if (dist < bestDist) { bestDist = dist; bestDoor = door; }
        }
        if (bestDoor) {
          const n = bfs(player.x, player.y, bestDoor.x, bestDoor.y, grid, navCtx.openedDoors);
          if (n) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===(n.x-player.x) && ddy===(n.y-player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }
      }
    }

    // Fallback: move toward nearest unsearched wall position
    const target = findNearestUnsearchedWall(player.x, player.y, grid, navCtx.searchedWallPos);
    if (target) {
      const next = bfs(player.x, player.y, target.x, target.y, grid, navCtx.openedDoors);
      if (next) {
        const idx = DIRS.findIndex(([ddx,ddy]) =>
          ddx===(next.x-player.x) && ddy===(next.y-player.y));
        if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
      }
    }

    // Final fallback: random walkable direction
    const shuffled = shuffleDirs();
    for (const di of shuffled) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
      }
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleWallSearch });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleWallSearch } = globalThis.NHNav || {};