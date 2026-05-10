/**
 * nav-ai.mjs — NetHack Navigation AI: Main loop
 *
 * Entry point: startNavigation(startDlvl, onDone, env)
 *   env: NavEnv adapter (NHBrowserEnv for browser, NHNodeEnv for Node)
 * Depends on window.NHNav (from nav-core.mjs and nav-strategy.mjs).
 *
 * Loop: microtask iteration with input-readiness check.
 */

(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-ai.mjs'); return; }

  const { W, H, DIRS, KEY, MONSTERS, isWalkable,
          findOnMap, scanMap, bfs, shuffleDirs } = NH;

  const scheduleNext = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn) => Promise.resolve().then(fn);

  function startNavigation(startDlvl, onDone, env) {
    console.log('[NAV] startNavigation called, env=' + typeof env);
    if (!env) { if (onDone) onDone('no-env'); return; }

    let tickCount = 0;
    let stuckCount = 0;
    let lastPlayerPos = null;
    let pendingDir = null;
    let pendingKickDir = null;
    let lastEatTick = 0;
    let stopped = false;
    let choked = false;
    let lastStairsPos = null;
    let lastDoorDir = null;
    let doorAttemptCount = 0;

    // Oscillation detection: track recent positions to detect looping
    const recentPositions = [];
    const MAX_RECENT = 20;
    let enclosedTick = 0; // ticks spent in enclosed room with no exits

    // Wall search state: systematically move along walls and search
    let wallSearchPhase = false;
    let wallSearchStep = 0;
    let lastSearchTick = 0;
    // Track wall-adjacent positions we've already searched (by "x,y")
    const searchedWallPos = new Set();
    // How many consecutive searches we've done at the current position
    let searchesAtCurrentPos = 0;
    let lastWallPosKey = null;

    // Track doors we've tried to open (locked/iron doors that won't open)
    const triedDoors = new Set();
    let lastDoorOpenTick = 0;
    let lastDoorPos = null;
    let doorOpenAttempts = 0;

    const MAX_TICKS = 500;

    function stop(reason) {
      stopped = true;
      if (onDone) onDone(reason);
    }

    // Check if a position is adjacent to a wall
    function isAdjacentToWall(px, py, grid) {
      for (let di = 0; di < 8; di++) {
        const [dx, dy] = DIRS[di];
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (ch === '|' || ch === '-') return true;
      }
      return false;
    }

    // Find a wall-adjacent position that hasn't been searched yet
    function findUnsearchedWallPosition(px, py, grid) {
      // BFS to find all reachable wall-adjacent positions
      const visited = Array.from({length: H}, () => new Uint8Array(W));
      const queue = [{x: px, y: py}];
      visited[py][px] = 1;
      let head = 0;
      const candidates = [];
      while (head < queue.length) {
        const cur = queue[head++];
        if (isAdjacentToWall(cur.x, cur.y, grid)) {
          const key = cur.x + ',' + cur.y;
          if (!searchedWallPos.has(key)) {
            candidates.push(cur);
          }
        }
        for (const [dx, dy] of DIRS) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (visited[ny][nx]) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (ch === '|' || ch === '-' || ch === ' ' || ch === '+') continue;
          visited[ny][nx] = 1;
          queue.push({x: nx, y: ny});
        }
      }
      if (candidates.length === 0) {
        // All positions searched — reset and try again
        searchedWallPos.clear();
        return candidates.length > 0 ? candidates[0] : null;
      }
      // Pick a random candidate to avoid oscillation
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    function step() {
      if (stopped) return false;
      tickCount++;
      if (tickCount <= 3) console.log('[NAV] step() tick=' + tickCount);

      // ---- Pending direction keys ----
      if (pendingDir !== null) {
        const dir = pendingDir;
        pendingDir = null;
        env.sendKey(KEY[dir].charCodeAt(0));
        return true;
      }
      if (pendingKickDir !== null) {
        const dir = pendingKickDir;
        pendingKickDir = null;
        env.sendKey(KEY[dir].charCodeAt(0));
        return true;
      }

      // ---- Win / lose checks ----
      if (env.getDlvl() !== startDlvl) { stop('descended'); return false; }
      if (env.getHp() === 0) { stop('died'); return false; }
      if (env.isGameDone && env.isGameDone()) { stop('game-ended'); return false; }

      // ---- Modal handling ----
      if (env.isYnVisible()) {
        const ynText = env.getYnText();
        if (ynText.includes('possessions identified') || ynText.includes('identified?')) {
          stop('died'); return false;
        }
        // "In what direction?" — this is the 'o' (open) or 's' (search) direction prompt
        if (ynText.toLowerCase().includes('direction')) {
          // If we have a pending direction for door opening, send it
          if (pendingDir !== null) {
            env.sendKey(KEY[pendingDir].charCodeAt(0));
            pendingDir = null;
          } else {
            // For search, pick a wall direction
            const msgs = env.getRecentMessages(5);
            const lastMsg = msgs[msgs.length - 1] || '';
            if (lastMsg.includes('fountain') || lastMsg.includes('trap')) {
              env.sendKey(27); // cancel
            } else {
              env.sendKey('y'.charCodeAt(0)); // default: search NW direction
            }
          }
          return true;
        }
        if (!env.clickYnButton()) env.sendKey(121);
        return true;
      }

      if (env.isMenuVisible()) {
        const menuText = env.getMenuText();
        const itemMatch = menuText.match(/\[([a-z])(?:-([a-z]))?\s*(?:or\s+)?\?\*\]/);
        if (itemMatch) { env.sendKey(itemMatch[1].charCodeAt(0)); }
        else if (menuText.includes('Really') || menuText.includes('Really?')) { env.sendKey('y'.charCodeAt(0)); }
        else if (menuText.includes('eat') || menuText.includes('Eat') ||
                 menuText.includes('drink') || menuText.includes('read') ||
                 menuText.includes('What do you want')) { env.sendKey('a'.charCodeAt(0)); }
        else { env.sendKey(27); }
        return true;
      }

      // ---- Read the map ----
      const grid = env.getMap();
      if (!grid || grid.length === 0) { env.sendKey('.'.charCodeAt(0)); return true; }
      const { player, stairs, food } = findOnMap(grid);
      const msgs = env.getRecentMessages(15);
      if (!player) { env.sendKey('.'.charCodeAt(0)); return true; }

      // ---- Track recent positions for oscillation detection ----
      recentPositions.push({x: player.x, y: player.y});
      if (recentPositions.length > MAX_RECENT) recentPositions.shift();

      // ---- Read HP / hunger ----
      const currentHp = env.getHp();
      const maxHp = env.getMaxHp();
      const hungerText = env.getHunger();
      const hpRatio = currentHp / maxHp;
      const lowHp = hpRatio < 0.4;
      const hungerNum = parseInt(hungerText) || 0;
      const isHungry = hungerNum >= 1 || hungerText === 'Hungry' || hungerText === 'Weak' || hungerText === 'Fainting';
      const isStarving = hungerNum >= 2 || hungerText === 'Fainting' || hungerText === 'Weak' ||
                         msgs.some(m => m.includes('faint from lack of food') || m.includes('weak from lack of food') || m.includes('starve'));
      const noFood = msgs.some(m => m.includes("don't have anything to eat"));
      const justChoked = msgs.some(m => m.includes('choke') || m.includes('choking'));
      if (justChoked) choked = true;

      // ---- Periodic debug ----
      if (tickCount % 25 === 0) {
        const feat = scanMap(grid);
        const chars = new Set();
        for (let y = Math.max(0, player.y - 5); y < Math.min(H, player.y + 6); y++) {
          for (let x = Math.max(0, player.x - 10); x < Math.min(W, player.x + 11); x++) {
            const ch = (grid[y]||'')[x] || ' ';
            if (ch !== ' ') chars.add(`'${ch}'@${x},${y}`);
          }
        }
        console.log(`[NAV] tick=${tickCount} stuck=${stuckCount} enclosed=${enclosedTick} wallSearch=${wallSearchPhase} pos=${player.x},${player.y} stairs=${!!stairs} doors=${feat.doors.length} walls=${feat.walls.length} chars=${[...chars].join(',')}`);
      }

      // ---- Stuck detection (no position change) ----
      const moved = !lastPlayerPos || player.x !== lastPlayerPos.x || player.y !== lastPlayerPos.y;
      if (moved) { stuckCount = 0; doorAttemptCount = 0; }
      else { stuckCount++; }
      lastPlayerPos = { ...player };
      if (stuckCount > 200) { stop('stuck'); return false; }

      // ---- Eat when hungry ----
      if ((isHungry || lowHp) && !noFood && !choked && (tickCount - lastEatTick) > 20) {
        lastEatTick = tickCount; choked = false;
        env.sendKey('e'.charCodeAt(0)); return true;
      }
      if (!justChoked && choked && (tickCount - lastEatTick) > 10) { choked = false; }

      // ---- Low HP: flee ----
      if (lowHp) {
        const monster = NH.findNearestMonster(grid, player.x, player.y);
        if (monster) {
          const fleeDirs = shuffleDirs();
          for (const di of fleeDirs) {
            const [ddx, ddy] = DIRS[di];
            const nx = player.x + ddx, ny = player.y + ddy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              const ch = (grid[ny]||'')[nx] || ' ';
              if (isWalkable(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
            }
          }
        }
      }

      // ---- Use travel (t) to auto-navigate to stairs ----
      // Travel command lets NetHack auto-walk to a target
      if (!stairs && tickCount > 30 && !wallSearchPhase) {
        // Send travel command, then coordinates of nearest corridor
        env.sendKey('t'.charCodeAt(0));
        return true;
      }

      // ---- Stairs navigation (highest priority) ----
      if (stairs) {
        wallSearchPhase = false;
        enclosedTick = 0;
        lastStairsPos = { x: stairs.x, y: stairs.y };
        if (player.x === stairs.x && player.y === stairs.y) {
          env.sendKey(62); return true; // '>'
        }
        const next = bfs(player.x, player.y, stairs.x, stairs.y, grid);
        if (next) {
          const nextCh = (grid[next.y]||'')[next.x] || ' ';
          if (nextCh === '+') {
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            return true;
          }
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }
      // Stairs may have been visible before but not now (monster on top?)
      if (lastStairsPos && player.x === lastStairsPos.x && player.y === lastStairsPos.y) {
        env.sendKey(62); return true;
      }

      // ---- Door navigation ----
      const features = scanMap(grid);
      // Filter out doors we've already tried multiple times (locked doors)
      const untriedDoors = features.doors.filter(d => !triedDoors.has(d.x + ',' + d.y));
      if (untriedDoors.length > 0) {
        wallSearchPhase = false;
        enclosedTick = 0;
        let bestDoor = null, bestNext = null, bestDist = Infinity;
        for (const door of untriedDoors) {
          // Adjacent door — open it (direction will be sent next tick via pendingDir)
          const ddx = door.x - player.x, ddy = door.y - player.y;
          if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
            // Track door open attempts to detect locked doors
            const doorKey = door.x + ',' + door.y;
            if (lastDoorPos === doorKey) {
              doorOpenAttempts++;
            } else {
              lastDoorPos = doorKey;
              doorOpenAttempts = 1;
            }
            if (doorOpenAttempts > 3) {
              // This door is probably locked — kick it
              console.log(`[NAV] Door at ${doorKey} seems locked, kicking`);
              env.sendKey(4); // ^D = kick
              pendingKickDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
              doorOpenAttempts = 0;
              lastDoorPos = null;
              return true;
            }
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
            return true;
          }
          const next = bfs(player.x, player.y, door.x, door.y, grid);
          if (next) {
            const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
            if (dist < bestDist) { bestDist = dist; bestDoor = door; bestNext = next; }
          }
        }
        if (bestNext) {
          const nextCh = (grid[bestNext.y]||'')[bestNext.x] || ' ';
          if (nextCh === '+') {
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
            return true;
          }
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }

      // ---- Monster: attack if adjacent (skip pets) ----
      const monster = NH.findNearestMonster(grid, player.x, player.y);
      if (monster) {
        const mdx = Math.abs(monster.x - player.x);
        const mdy = Math.abs(monster.y - player.y);
        if (mdx <= 1 && mdy <= 1) {
          const ch = (grid[monster.y]||'')[monster.x] || ' ';
          const petChars = ['d','c','f','n','q','r','s','t','w','y'];
          if (petChars.includes(ch)) {
            // Pet is adjacent — ignore it, keep exploring
          } else {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx === (monster.x - player.x) && ddy === (monster.y - player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }
      }

      // ---- Corridor navigation: find '#' and walk towards it ----
      let nearestCorridor = null, corridorDist = Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if ((grid[y]||'')[x] === '#') {
            const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
            if (dist < corridorDist) {
              corridorDist = dist;
              nearestCorridor = { x, y };
            }
          }
        }
      }
      if (nearestCorridor) {
        wallSearchPhase = false;
        enclosedTick = 0;
        const next = bfs(player.x, player.y, nearestCorridor.x, nearestCorridor.y, grid);
        if (next) {
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
        // Direct step if adjacent
        if (corridorDist <= 1) {
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(nearestCorridor.x-player.x) && ddy===(nearestCorridor.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }

      // ---- Enclosed room detection & hidden door search ----
      // If no stairs, no doors, no corridors visible — we're in an enclosed room
      const isEnclosed = !stairs && features.doors.length === 0 && nearestCorridor === null;
      if (isEnclosed) {
        enclosedTick++;
        if (enclosedTick > 150) { stop('stuck'); return false; }
      } else {
        enclosedTick = 0;
        wallSearchPhase = false;
      }

      // Oscillation detection: check if we've been visiting the same small set of positions
      let isOscillating = false;
      if (recentPositions.length >= 10 && isEnclosed) {
        const posSet = new Set();
        for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
        // If we've only visited <= 6 unique positions in last 20 ticks, we're oscillating
        if (posSet.size <= 6) isOscillating = true;
      }

      // Start wall search if enclosed for too long or oscillating
      if (isEnclosed && (enclosedTick > 30 || isOscillating)) {
        wallSearchPhase = true;
      }

      if (wallSearchPhase && isEnclosed) {
        wallSearchStep++;

        // If we've searched at current position too many times, mark it searched and move on
        const curKey = player.x + ',' + player.y;
        if (searchesAtCurrentPos > 5 && lastWallPosKey === curKey) {
          searchedWallPos.add(curKey);
          searchesAtCurrentPos = 0;
          lastWallPosKey = null;
        }

        // Every 3rd tick: search (s command) if adjacent to wall
        if (wallSearchStep % 3 === 0) {
          if (isAdjacentToWall(player.x, player.y, grid)) {
            searchesAtCurrentPos = (lastWallPosKey === curKey) ? searchesAtCurrentPos + 1 : 1;
            lastWallPosKey = curKey;
            env.sendKey('s'.charCodeAt(0));
            return true;
          }
        }

        // Move to a new wall-adjacent position that hasn't been searched
        const target = findUnsearchedWallPosition(player.x, player.y, grid);
        if (target) {
          if (target.x === player.x && target.y === player.y) {
            // Already at a wall-adjacent position — search it
            searchesAtCurrentPos = (lastWallPosKey === curKey) ? searchesAtCurrentPos + 1 : 1;
            lastWallPosKey = curKey;
            env.sendKey('s'.charCodeAt(0));
            return true;
          }
          const next = bfs(player.x, player.y, target.x, target.y, grid);
          if (next) {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }

        // Fallback: move randomly
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ch = (grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
          }
        }
      }

      // ---- Unexplored boundary ----
      const boundary = NH.findNearestUnexplored(grid, player.x, player.y);
      if (boundary) {
        const dx = boundary.x - player.x, dy = boundary.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
        if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
      }

      // ---- Fallback: random walkable direction ----
      const shuffled = shuffleDirs();
      for (const di of shuffled) {
        const [ddx, ddy] = DIRS[di];
        const nx = player.x + ddx, ny = player.y + ddy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
        }
      }

      // No walkable moves — wait
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    function loop() {
      if (stopped) return;
      if (tickCount >= MAX_TICKS) { stop('max-ticks'); return; }
      if (env.isGameDone && env.isGameDone()) { stop('game-ended'); return; }
      if (env.isReadyForInput && !env.isReadyForInput()) { scheduleNext(loop); return; }
      step();
      if (!stopped) scheduleNext(loop);
    }

    scheduleNext(loop);
  }

  global.startNavigation = startNavigation;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module export (for Node)
export const startNavigation = globalThis.startNavigation;
