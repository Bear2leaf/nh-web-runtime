/**
 * nav-corridor.mjs — NetHack Navigation AI: Corridor navigation
 *
 * Handles: corridor dead-end detection, room-to-corridor navigation,
 * corridor following with direction scoring, oscillation detection & retreat.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-corridor.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, bfs, shuffleDirs,
          isInDeadEnd, tryTeleport, MAX_TELEPORT_ATTEMPTS } = NH;

  /**
   * Handle corridor navigation: dead-end, room-to-corridor, following, oscillation.
   * This is a compound handler that covers multiple corridor-related behaviors.
   * Returns true if this handler consumed the tick.
   */
  function handleCorridor(navCtx) {
    const { env, player, grid, features, stairs, stuckCount, teleportAttempts,
            isInCorridor, wallSearchPhase, hadPetBlock, lowHp, lastMoveDir,
            corridorFailCount, lastSentDir, forcedDirChange, recentPositions,
            corridorVisitCounts, corridorOscillationTick, lastOscHandlerTick,
            tickCount, searchedWallPos, lastSearchTick } = navCtx;

    // ---- Corridor dead-end detection: backtrack or teleport ----
    const deadEndExit = isInDeadEnd(player.x, player.y, grid);
    if (deadEndExit >= 0 && stuckCount > 10) {
      console.log(`[NAV] Dead-end corridor detected at ${player.x},${player.y}, exit dir=${deadEndExit}`);
      const [edx, edy] = DIRS[deadEndExit];
      const enx = player.x + edx, eny = player.y + edy;
      if (enx >= 0 && enx < W && eny >= 0 && eny < H) {
        const ech = (grid[eny]||'')[enx] || ' ';
        if (isWalkable(ech) && !MONSTERS.has(ech)) {
          navCtx.lastMoveDir = deadEndExit;
          env.sendKey(KEY[deadEndExit].charCodeAt(0));
          return true;
        }
      }
      if (teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        if (tryTeleport(navCtx)) return true;
      }
    }

    // Stuck in corridor for too long — teleport
    if (isInCorridor && stuckCount > 100 && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
      console.log(`[NAV] Stuck in corridor for ${stuckCount} ticks, trying teleport`);
      if (tryTeleport(navCtx)) return true;
    }

    // ---- Room-to-corridor navigation (when NOT in a corridor) ----
    // During wall search, defer to the wall handler entirely — don't consume
    // ticks with room-to-corridor navigation that prevents wall path progress.
    if (!isInCorridor && !wallSearchPhase) {
      if (handleRoomToCorridor(navCtx)) return true;
    }

    // ---- Corridor following ----
    // During wall search, defer to the wall handler entirely — don't consume
    // ticks with corridor oscillation that prevents wall path progress.
    if (isInCorridor && !wallSearchPhase) {
      if (handleCorridorFollow(navCtx)) return true;
    }

    return false;
  }

  // ---- Room-to-corridor navigation ----
  function handleRoomToCorridor(navCtx) {
    const { env, player, grid, features, stairs, corridorFailCount,
            lastSentDir, forcedDirChange, isAdjacentToWall } = navCtx;

    // Always try to exit to corridor when in room with no stairs — retry even after failures
    // The guard clause `if (corridorFailCount !== 0 && !noRoomExit) return false` was removed
    // because it caused the AI to get stuck oscillating in rooms when corridor navigation had
    // previously failed but the room had a door. The AI should always try to exit.

    // Find floor tiles adjacent to corridors (room exits)
    let nearestRoomEntrance = null, roomEntranceDist = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = (grid[y]||'')[x] || ' ';
        const isFloor = (ch === '.' || ch === '<' || ch === '>' || ch === '%' ||
                        (ch !== ' ' && ch !== '#' && ch !== '|' && ch !== '-' && ch !== '+' && ch !== '`'));
        if (isFloor) {
          let adjacentToCorridor = false;
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              if ((grid[ny]||'')[nx] === '#') { adjacentToCorridor = true; break; }
            }
          }
          if (adjacentToCorridor) {
            const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
            if (dist > 0 && dist < roomEntranceDist) {
              roomEntranceDist = dist;
              nearestRoomEntrance = { x, y };
            }
          }
        }
      }
    }

    if (nearestRoomEntrance) {
      const next = bfs(player.x, player.y, nearestRoomEntrance.x, nearestRoomEntrance.y, grid, navCtx.openedDoors, navCtx.knownTrapPositions);
      if (next) {
        // Only reset failure counters when making genuine progress — not when oscillating
        // between room and corridor. If corridorFailCount is already elevated, preserve it
        // so that wall search / enclosed detection can trigger.
        // NOTE: We do NOT reset corridorFailCount here — once failures start accumulating,
        // they should persist until the AI either descends or force-forwards past the corridor.
        if (navCtx.corridorFailCount === 0) {
          navCtx.enclosedTick = 0;
        }
        const nextCh = (grid[next.y]||'')[next.x] || ' ';
        let idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
        // If next BFS step is a closed door, open it instead of bumping
        if (nextCh === '+' && idx >= 0) {
          const doorKey = next.x + ',' + next.y;
          if (!navCtx.triedDoors.has(doorKey)) {
            console.log(`[NAV] Room-to-corridor: opening door at ${next.x},${next.y}`);
            env.sendKey('o'.charCodeAt(0));
            navCtx.pendingDir = idx;
            return true;
          }
        }
        if (forcedDirChange && idx === lastSentDir) {
          const alt = shuffleDirs().find(di => {
            const [dx, dy] = DIRS[di];
            const nx = player.x + dx, ny = player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
            const ch = (grid[ny]||'')[nx] || ' ';
            return isWalkable(ch) && di !== lastSentDir &&
                   !navCtx.knownTrapPositions.has(nx + ',' + ny);
          });
          if (alt !== undefined) idx = alt;
        }
        if (idx >= 0) {
          navCtx.lastMoveDir = idx;
          env.sendKey(KEY[idx].charCodeAt(0));
          return true;
        }
      }
    }

    // No room exit found — BFS directly to a corridor tile
    let bestCorridor = null, bestCorridorDist = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((grid[y]||'')[x] !== '#') continue;
        const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
        if (dist > 0 && dist < bestCorridorDist) {
          bestCorridorDist = dist;
          bestCorridor = { x, y };
        }
      }
    }
    if (bestCorridor) {
      const next = bfs(player.x, player.y, bestCorridor.x, bestCorridor.y, grid, navCtx.openedDoors, navCtx.knownTrapPositions);
      if (next) {
        if (navCtx.corridorFailCount === 0) {
          navCtx.enclosedTick = 0;
        }
        const nextCh = (grid[next.y]||'')[next.x] || ' ';
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
        // If next BFS step is a closed door, open it instead of bumping
        if (nextCh === '+' && idx >= 0) {
          const doorKey = next.x + ',' + next.y;
          if (!navCtx.triedDoors.has(doorKey)) {
            console.log(`[NAV] Room-to-corridor (fallback): opening door at ${next.x},${next.y}`);
            env.sendKey('o'.charCodeAt(0));
            navCtx.pendingDir = idx;
            return true;
          }
        }
        if (idx >= 0) {
          navCtx.lastMoveDir = idx;
          env.sendKey(KEY[idx].charCodeAt(0));
          return true;
        }
      }
    }

    return false;
  }

  // ---- Corridor following & oscillation handling ----
  function handleCorridorFollow(navCtx) {
    const { env, player, grid, stuckCount, teleportAttempts, isAdjacentToWall,
            hadPetBlock, lowHp, lastMoveDir, lastSentDir, forcedDirChange,
            recentPositions, corridorVisitCounts, corridorOscillationTick,
            lastOscHandlerTick, tickCount, searchedWallPos, lastSearchTick,
            stairs } = navCtx;

    const cKey = player.x + ',' + player.y;
    const revisits = corridorVisitCounts.get(cKey) || 0;

    // ---- Oscillation detection ----
    // Only flag genuine oscillation (1-2 unique tiles in 8 ticks). Narrow
    // corridors naturally have few reachable positions — don't mistake normal
    // corridor traversal for oscillation.
    let corridorOsc = false;
    if (recentPositions.length >= 8) {
      const posSet = new Set();
      for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
      if (posSet.size <= 2) corridorOsc = true;
    }
    const overVisited = revisits >= 3;

    if (corridorOsc || overVisited || corridorOscillationTick > 30) {
      // Cooldown: only handle oscillation every 5 ticks
      if (tickCount - lastOscHandlerTick < 5) {
        if (hadPetBlock) { env.sendKey('.'.charCodeAt(0)); return true; }
        env.sendKey('.'.charCodeAt(0));
        return true;
      }
      navCtx.lastOscHandlerTick = tickCount;
      console.log(`[NAV] Corridor oscillation detected: revisits=${revisits} oscTick=${corridorOscillationTick} stuck=${stuckCount} hadPet=${hadPetBlock}`);

      // Pet blocking — try to swap places, but give up after too many swaps
      if (hadPetBlock) {
        // Respect global pet swap throttle from nav-ai.mjs
        if (navCtx.petSwapBlocked) {
          console.log(`[NAV] Pet swap blocked globally, giving up on corridor handling`);
          navCtx.petSwapConsecutive = 0;
          corridorVisitCounts.clear();
          navCtx.corridorOscillationTick = 0;
          return false;
        }

        // Track consecutive pet swap attempts
        if (!navCtx.petSwapConsecutive) navCtx.petSwapConsecutive = 0;
        navCtx.petSwapConsecutive++;

        // Too many consecutive swaps — force a consistent direction instead of
        // giving up. Letting other handlers run just causes more direction flips.
        if (navCtx.petSwapConsecutive > 2) {
          console.log(`[NAV] Too many pet swaps (${navCtx.petSwapConsecutive}), forcing consistent direction`);
          navCtx.petSwapConsecutive = 0;
          // Try to keep moving in lastMoveDir (away from pet after a swap)
          if (lastMoveDir >= 0) {
            const [ldx, ldy] = DIRS[lastMoveDir];
            const lnx = player.x + ldx, lny = player.y + ldy;
            if (lnx >= 0 && lnx < W && lny >= 0 && lny < H) {
              const lch = (grid[lny]||'')[lnx] || ' ';
              if (isWalkable(lch) && !navCtx.knownTrapPositions.has(lnx + ',' + lny)) {
                navCtx.lastMoveDir = lastMoveDir;
                env.sendKey(KEY[lastMoveDir].charCodeAt(0));
                return true;
              }
            }
          }
          // Fallback: any corridor direction
          for (let di = 0; di < 8; di++) {
            const [dx, dy] = DIRS[di];
            const nx = player.x + dx, ny = player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (grid[ny]||'')[nx] || ' ';
            if (ch === '#' && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
              navCtx.lastMoveDir = di;
              env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
          }
          // Last resort: any walkable direction
          for (const di of shuffleDirs()) {
            const [dx, dy] = DIRS[di];
            const nx = player.x + dx, ny = player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
              navCtx.lastMoveDir = di;
              env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
          }
          corridorVisitCounts.clear();
          navCtx.corridorOscillationTick = 0;
          return false;
        }

        let nearestPet = null, nearestPetDist = Infinity;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const ch = (grid[y]||'')[x] || ' ';
            if (PET_CHARS.has(ch)) {
              const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
              if (dist <= 2 && dist < nearestPetDist) {
                nearestPetDist = dist; nearestPet = {x, y};
              }
            }
          }
        }
        if (nearestPet) {
          const pdx = nearestPet.x - player.x, pdy = nearestPet.y - player.y;
          const pidx = DIRS.findIndex(([dx,dy]) => dx===pdx && dy===pdy);
          if (pidx >= 0) {
            console.log(`[NAV] Pet blocking at ${nearestPet.x},${nearestPet.y}, swapping places (dir=${pidx}, attempt=${navCtx.petSwapConsecutive})`);
            navCtx.lastMoveDir = pidx;
            env.sendKey(KEY[pidx].charCodeAt(0));
            return true;
          }
        }
      }

      // No pet block or pet swap failed — reset counter
      navCtx.petSwapConsecutive = 0;

      // Option 1: teleport
      if (teleportAttempts < MAX_TELEPORT_ATTEMPTS &&
          (stuckCount > 10 || corridorOscillationTick > 30)) {
        if (tryTeleport(navCtx)) {
          corridorVisitCounts.clear();
          navCtx.corridorOscillationTick = 0;
          return true;
        }
      }

      // Option 2: retreat to nearest room (but NOT if we've already retreated too many times)
      const corridorFailCount = navCtx.corridorFailCount || 0;
      if (corridorFailCount < 5) {
      let nearestRoom = null, roomDist = Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ch = (grid[y]||'')[x] || ' ';
          if (ch === '.' || ch === '>' || ch === '<') {
            const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
            if (dist > 0 && dist < roomDist) { roomDist = dist; nearestRoom = { x, y }; }
          }
        }
      }
      if (nearestRoom) {
        const next = bfs(player.x, player.y, nearestRoom.x, nearestRoom.y, grid, navCtx.openedDoors, navCtx.knownTrapPositions);
        if (next) {
          const nextCh = (grid[next.y]||'')[next.x] || ' ';
          if (!MONSTERS.has(nextCh)) {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) {
              console.log(`[NAV] Retreating from corridor to room at ${nearestRoom.x},${nearestRoom.y} via dir ${idx}`);
              corridorVisitCounts.clear();
              navCtx.corridorOscillationTick = 0;
              navCtx.corridorFailCount++;
              // Don't trigger wall search immediately — give normal navigation a chance
              navCtx.enclosedTick = navCtx.corridorFailCount >= 3 ? 200 : 50;
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
      } // end corridorFailCount < 5 guard

      // When retreats are exhausted (corridorFailCount >= 5), try to force forward
      // through the corridor instead of going back to the same room.
      // Prefer corridor tiles (#) — room floor (.) has visit-count=0 which would
      // cause the AI to always go back to the room it just left.
      if (corridorFailCount >= 5) {
        console.log(`[NAV] Corridor retreats exhausted (${corridorFailCount}), forcing forward`);
        corridorVisitCounts.clear();
        navCtx.corridorOscillationTick = 0;
        const shuffled = shuffleDirs();
        // First: pick a corridor tile direction (preferred, avoid traps)
        for (const di of shuffled) {
          const [dx, dy] = DIRS[di];
          const nx = player.x + dx, ny = player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (ch === '#' && !MONSTERS.has(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = di;
            env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
        // Second: pick any walkable non-room direction (no monsters/pets, avoid traps)
        for (const di of shuffled) {
          const [dx, dy] = DIRS[di];
          const nx = player.x + dx, ny = player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          // Room floor (.) leads back to room — skip unless nothing else is available
          if (ch === '.' || ch === '<' || ch === '>') continue;
          if (isWalkable(ch) && !MONSTERS.has(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = di;
            env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
        // Last resort: any walkable direction (including room floor, but avoid traps)
        for (const di of shuffled) {
          const [dx, dy] = DIRS[di];
          const nx = player.x + dx, ny = player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = di;
            env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
      }

      // Option 3: search current position
      if (isAdjacentToWall(player.x, player.y, grid) && !searchedWallPos.has(cKey)) {
        searchedWallPos.add(cKey);
        console.log(`[NAV] Search-from-corridor at ${cKey} (oscillation fallback)`);
        navCtx.lastSearchTick = tickCount;
        navCtx.lastMoveDir = -1;
        env.sendKey('s'.charCodeAt(0));
        return true;
      }
    }

    // ---- Search from corridor when stuck ----
    if (stuckCount > 30 && isAdjacentToWall(player.x, player.y, grid)) {
      const curKey = player.x + ',' + player.y;
      if (!searchedWallPos.has(curKey)) {
        // Don't search while standing on a known trap — it's useless and spams
        // "Waiting doesn't feel like a good idea" messages.
        if (navCtx.knownTrapPositions && navCtx.knownTrapPositions.has(curKey)) {
          return false;
        }
        searchedWallPos.add(curKey);
        console.log(`[NAV] Searching from corridor at ${curKey}`);
        navCtx.lastSearchTick = tickCount;
        navCtx.lastMoveDir = -1;
        env.sendKey('s'.charCodeAt(0));
        return true;
      }
    }

    // ---- Score each direction ----
    const trapSet = navCtx.knownTrapPositions || new Set();
    let bestCorridorDir = -1, bestCorridorScore = -Infinity;
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (trapSet.has(nx + ',' + ny)) continue; // skip known traps
      const nch = (grid[ny]||'')[nx] || ' ';
      if (nch === '|' || nch === '-' || nch === '+' || nch === ' ' || nch === '`') continue;
      if (MONSTERS.has(nch) && lowHp) continue;

      // Recent position penalty
      let recentPenalty = 0;
      for (let i = recentPositions.length - 1; i >= Math.max(0, recentPositions.length - 12); i--) {
        const rp = recentPositions[i];
        if (rp.x === nx && rp.y === ny) recentPenalty += 5;
      }
      // Pet penalty / block
      if (MONSTERS.has(nch)) {
        if (stuckCount > 10) continue;
        if (navCtx.petSwapBlocked) continue; // avoid pets when swaps are throttled
        recentPenalty += 20;
      }

      // Tile scoring
      let tileBonus = 0;
      if (nch === '>') tileBonus = 100;
      else if (nch === '%') tileBonus = 15;
      else if (nch === '.') tileBonus = 10;
      else if (nch === '<') tileBonus = 2;
      else if (nch === '#') tileBonus = 1;
      // Removed pet tile bonus

      const forwardBonus = stairs ? 6 : 3;
      if (lastMoveDir >= 0 && di === lastMoveDir) tileBonus += forwardBonus;

      // Corridor/ monster ahead
      let corridorAhead = 0;
      let monsterAhead = 0;
      for (let step = 1; step <= 8; step++) {
        const ax = player.x + dx * step, ay = player.y + dy * step;
        if (ax < 0 || ax >= W || ay < 0 || ay >= H) break;
        const ach = (grid[ay]||'')[ax] || ' ';
        if (ach === '#') { corridorAhead++; continue; }
        if (MONSTERS.has(ach) && lowHp) monsterAhead++;
        break;
      }
      const score = tileBonus + corridorAhead * 3 - recentPenalty - monsterAhead * 15;
      if (forcedDirChange && di === lastSentDir) continue;
      if (score > bestCorridorScore) { bestCorridorScore = score; bestCorridorDir = di; }
    }

    if (bestCorridorDir >= 0) {
      navCtx.lastMoveDir = bestCorridorDir;
      env.sendKey(KEY[bestCorridorDir].charCodeAt(0));
      return true;
    }

    // All directions blocked by forcedDirChange — try any walkable direction
    if (forcedDirChange) {
      const shuffled = shuffleDirs();
      for (const di of shuffled) {
        if (di === lastSentDir) continue;
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch) && !MONSTERS.has(ch)) {
          navCtx.lastMoveDir = di;
          env.sendKey(KEY[di].charCodeAt(0));
          return true;
        }
      }
    }

    // All exhausted — backtrack to nearest room
    let nearestFloor = null, floorDist = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = (grid[y]||'')[x] || ' ';
        if (ch === '.' || ch === '>' || ch === '<') {
          const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
          if (dist > 0 && dist < floorDist) { floorDist = dist; nearestFloor = { x, y }; }
        }
      }
    }
    if (nearestFloor) {
      const next = bfs(player.x, player.y, nearestFloor.x, nearestFloor.y, grid, navCtx.openedDoors, navCtx.knownTrapPositions);
      if (next) {
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
        if (idx >= 0) {
          navCtx.lastMoveDir = idx;
          env.sendKey(KEY[idx].charCodeAt(0));
          return true;
        }
      }
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleCorridor });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleCorridor } = global.NHNav || {};