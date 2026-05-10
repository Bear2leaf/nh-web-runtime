/**
 * nav-strategy.js — NetHack Navigation AI: State machine handlers
 *
 * Implements the explore/search/fight/open_door/kick_door state handlers.
 * Depends on window.NHNav (from nav-core.js).
 */

(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-strategy.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, isWalkable, isBfsWalkable,
          findOnMap, scanMap, bfs, findNearestUnexplored,
          getRecentMessages, isSearchSpam, findNearestMonster, shuffleDirs } = NH;

  // ---------- helper: wall-following search path --------------------------------
  // Returns a circular walk order that hugs walls — good for finding hidden doors
  function wallFollowOrder(startX, startY, grid) {
    // Pick the direction that has a wall adjacent (best starting edge of the room)
    let bestDi = -1, bestWallCount = -1;
    for (let d = 0; d < 8; d++) {
      const [dx, dy] = DIRS[d];
      const nx = startX + dx, ny = startY + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      let wallCount = 0;
      for (let dd = 0; dd < 8; dd++) {
        const [ddx, ddy] = DIRS[dd];
        const nnx = nx + ddx, nny = ny + ddy;
        if (nnx >= 0 && nnx < W && nny >= 0 && nny < H) {
          const ch = (grid[nny]||'')[nnx] || ' ';
          if (ch === '|' || ch === '-' || ch === '+') wallCount++;
        }
      }
      if (wallCount > bestWallCount) { bestWallCount = wallCount; bestDi = d; }
    }
    if (bestDi < 0) return shuffleDirs();
    // Build a circle around the starting position: start from wall side, go clockwise
    const order = [];
    const seen = new Set();
    // 8 directions in clockwise order starting from bestDi
    const CW = [0,1,2,3,4,5,6,7];
    const start = CW.indexOf(bestDi);
    const circ = [...CW.slice(start), ...CW.slice(0, start)];
    for (const d of circ) {
      if (seen.has(d)) continue;
      seen.add(d);
      const [dx, dy] = DIRS[d];
      const nx = startX + dx, ny = startY + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) order.push(d);
      }
    }
    // Fill in remaining shuffled
    const remaining = shuffleDirs().filter(d => !seen.has(d) &&
      (() => {
        const [dx, dy] = DIRS[d];
        const nx = startX + dx, ny = startY + dy;
        return nx >= 0 && nx < W && ny >= 0 && ny < H && isWalkable((grid[ny]||'')[nx]||' ');
      })()
    );
    return [...order, ...remaining];
  }

  function handleExplore(stateObj, grid, player, stairs, food) {
    let { stuckCount, searchCount, exploredDirs, pendingDir,
          doorAttemptDir, lastStairsPos, petBlockCount, sendKey, starving } = stateObj;
    let code = null, nextState = 'explore';

    // If monster is adjacent, fight or flee based on HP
    const nearestMonster = findNearestMonster(grid, player.x, player.y);
    const monsterAdj = nearestMonster &&
      Math.abs(nearestMonster.x - player.x) <= 1 &&
      Math.abs(nearestMonster.y - player.y) <= 1;
    if (monsterAdj) {
      // Fight the adjacent monster — move toward it
      const idx = DIRS.findIndex(([ddx,ddy]) =>
        ddx === (nearestMonster.x - player.x) && ddy === (nearestMonster.y - player.y));
      if (idx >= 0) {
        return { code: KEY[idx].charCodeAt(0), state: 'fight', stuckCount: 0, searchCount: 0,
                 exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir: null, petBlockCount };
      }
    }

    // Try adjacent doors first (highest explore priority)
    const adjDoors = [];
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if ((grid[ny]||'')[nx] === '+') adjDoors.push(di);
    }
    if (adjDoors.length > 0) {
      code = 'o'.charCodeAt(0);
      pendingDir = adjDoors[0];
      doorAttemptDir = adjDoors[0];
      return { code, state: nextState, stuckCount, searchCount, exploredDirs, pendingDir, doorAttemptDir, petBlockCount };
    }

    // Navigate to nearest visible door via BFS — always, not just when stuck
    const features = scanMap(grid);
    if (features.doors.length > 0) {
      let bestDoor = null, bestNext = null, bestDist = Infinity;
      for (const door of features.doors) {
        // Skip doors that are adjacent to player (handled above)
        if (Math.abs(door.x - player.x) <= 1 && Math.abs(door.y - player.y) <= 1) continue;
        const next = bfs(player.x, player.y, door.x, door.y, grid);
        if (next) {
          const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
          if (dist < bestDist) { bestDist = dist; bestDoor = door; bestNext = next; }
        }
      }
      if (bestNext) {
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
        if (idx >= 0) {
          // If the next tile is a monster, switch to fight instead of getting stuck
          const nextCh = (grid[bestNext.y]||'')[bestNext.x] || ' ';
          if (MONSTERS.has(nextCh)) {
            return { code: KEY[idx].charCodeAt(0), state: 'fight', stuckCount: 0, searchCount: 0,
                     exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir: null, petBlockCount };
          }
          code = KEY[idx].charCodeAt(0);
          return { code, state: nextState, stuckCount, searchCount, exploredDirs, pendingDir, doorAttemptDir, petBlockCount };
        }
      }
    }

    // If very stuck, search for hidden passages (but prefer moving)
    if (stuckCount > 30) {
      nextState = 'search';
      searchCount = 0;
      // Try a random walkable direction instead of 's' (which wastes turns)
      const shuffled = shuffleDirs();
      for (const di of shuffled) {
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch)) {
            return { code: KEY[di].charCodeAt(0), state: nextState, stuckCount: 0, searchCount: 1,
                     exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir, petBlockCount };
          }
        }
      }
      // Only do 's' as a last resort
      return { code: 's'.charCodeAt(0), state: nextState, stuckCount: 0, searchCount: 1,
               exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir, petBlockCount };
    }

    // Try to reach nearest unexplored boundary
    const boundary = findNearestUnexplored(grid, player.x, player.y);
    if (boundary) {
      const dx = boundary.x - player.x, dy = boundary.y - player.y;
      const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
      if (idx >= 0) {
        // If the next tile is a monster, switch to fight instead of getting stuck
        const nextCh = (grid[boundary.y]||'')[boundary.x] || ' ';
        if (MONSTERS.has(nextCh)) {
          return { code: KEY[idx].charCodeAt(0), state: 'fight', stuckCount: 0, searchCount: 0,
                   exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir: null, petBlockCount };
        }
        code = KEY[idx].charCodeAt(0);
        return { code, state: nextState, stuckCount, searchCount, exploredDirs, pendingDir, doorAttemptDir, petBlockCount };
      }
    }

    // Wall-following exploration
    if (exploredDirs.length === 0) {
      exploredDirs = wallFollowOrder(player.x, player.y, grid);
    }
    let foundDir = false;
    while (exploredDirs.length > 0 && !foundDir) {
      const di = exploredDirs.shift();
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) {
          code = KEY[di].charCodeAt(0);
          foundDir = true;
        }
      }
    }
    if (!code) {
      exploredDirs = shuffleDirs();
      for (const di of exploredDirs) {
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch)) {
            code = KEY[di].charCodeAt(0);
            break;
          }
        }
      }
      if (!code) code = KEY[Math.floor(Math.random() * 8)].charCodeAt(0);
    }

    return { code, state: nextState, stuckCount, searchCount, exploredDirs, pendingDir, doorAttemptDir, petBlockCount };
  }

  function handleSearch(stateObj, grid, player) {
    let { searchCount, exploredDirs, stuckCount } = stateObj;
    searchCount++;

    // Every 5 searches, relocate to a new wall-adjacent position
    if (searchCount > 0 && searchCount % 5 === 0) {
      const order = wallFollowOrder(player.x, player.y, grid);
      for (const di of order) {
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch)) {
            return { code: KEY[di].charCodeAt(0), state: 'search', searchCount, stuckCount,
                     exploredDirs: order, pendingDir: null, doorAttemptDir: null, petBlockCount: stateObj.petBlockCount };
          }
        }
      }
    }

    // If stuck for a long time, try scanning for hidden doors
    if (stuckCount > 20 && searchCount % 3 === 0) {
      return { code: 's'.charCodeAt(0), state: 'search', searchCount, stuckCount,
               exploredDirs, pendingDir: null, doorAttemptDir: null, petBlockCount: stateObj.petBlockCount };
    }

    // Default: move to a random walkable adjacent cell (don't stay in place)
    const shuffled = shuffleDirs();
    for (const di of shuffled) {
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch)) {
          return { code: KEY[di].charCodeAt(0), state: 'search', searchCount, stuckCount,
                   exploredDirs, pendingDir: null, doorAttemptDir: null, petBlockCount: stateObj.petBlockCount };
        }
      }
    }

    // No walkable moves — scan
    return { code: 's'.charCodeAt(0), state: 'search', searchCount, stuckCount, exploredDirs, pendingDir: null, doorAttemptDir: null, petBlockCount: stateObj.petBlockCount };
  }

  function handleFight(stateObj, grid, player, stairs) {
    let { petBlockCount, lastStairsPos } = stateObj;
    const monster = findNearestMonster(grid, player.x, player.y);

    // Monster gone or dead — return to explore immediately
    if (!monster) {
      return { code: null, state: 'explore', stuckCount: 0, searchCount: 0,
               exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir: null, petBlockCount };
    }

    const dx = monster.x - player.x, dy = monster.y - player.y;

    // Only attack if monster is truly adjacent (distance 1)
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
      if (idx >= 0) {
        return { code: KEY[idx].charCodeAt(0), state: 'fight', stuckCount: stateObj.stuckCount,
                 searchCount: stateObj.searchCount, exploredDirs: stateObj.exploredDirs,
                 pendingDir: null, doorAttemptDir: null, petBlockCount };
      }
    }

    // Monster not adjacent — chase it using BFS
    const next = bfs(player.x, player.y, monster.x, monster.y, grid);
    if (next) {
      const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
      if (idx >= 0) {
        return { code: KEY[idx].charCodeAt(0), state: 'fight', stuckCount: stateObj.stuckCount,
                 searchCount: stateObj.searchCount, exploredDirs: stateObj.exploredDirs,
                 pendingDir: null, doorAttemptDir: null, petBlockCount };
      }
    }

    // Can't find path to monster — wait and let it come to us
    return { code: '.'.charCodeAt(0), state: 'fight', stuckCount: stateObj.stuckCount,
             searchCount: stateObj.searchCount, exploredDirs: stateObj.exploredDirs,
             pendingDir: null, doorAttemptDir: null, petBlockCount };
  }

  function handleOpenDoor(stateObj, grid, player) {
    let { doorAttemptDir, pendingDir, petBlockCount } = stateObj;
    const adjDoors = [];
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if ((grid[ny]||'')[nx] === '+') adjDoors.push(di);
    }

    let code = null, nextState = 'open_door';
    if (adjDoors.length > 0 && doorAttemptDir === null) {
      doorAttemptDir = adjDoors[0];
      code = 'o'.charCodeAt(0);
      pendingDir = doorAttemptDir;
    } else if (doorAttemptDir !== null) {
      nextState = 'kick_door';
      code = null;
    } else {
      nextState = 'search';
      code = 's'.charCodeAt(0);
    }

    return { code, state: nextState, stuckCount: stateObj.stuckCount, searchCount: 0, exploredDirs: stateObj.exploredDirs, pendingDir, doorAttemptDir, petBlockCount };
  }

  function handleKickDoor(stateObj, grid, player) {
    let { doorAttemptDir, petBlockCount } = stateObj;
    const adjDoors = [];
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const nx = player.x + dx, ny = player.y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if ((grid[ny]||'')[nx] === '+') adjDoors.push(di);
    }

    let code = null, nextState = 'kick_door';
    if (adjDoors.length > 0) {
      code = 4; // ^D (kick)
      pendingKickDir = adjDoors[0];
    } else {
      nextState = 'explore';
      if (doorAttemptDir !== null) {
        code = KEY[doorAttemptDir].charCodeAt(0);
        doorAttemptDir = null;
      } else {
        code = KEY[Math.floor(Math.random() * 8)].charCodeAt(0);
      }
    }

    return { code, state: nextState, stuckCount: 0, searchCount: 0, exploredDirs: shuffleDirs(), pendingDir: null, doorAttemptDir, pendingKickDir, petBlockCount };
  }

  // Expose handlers
  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, {
    handleExplore, handleSearch, handleFight,
    handleOpenDoor, handleKickDoor,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module exports (for Node)
export const { handleExplore, handleSearch, handleFight, handleOpenDoor, handleKickDoor } = global.NHNav || {};
