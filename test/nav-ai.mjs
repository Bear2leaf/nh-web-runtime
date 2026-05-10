/**
 * nav-ai.mjs — NetHack Navigation AI: Main loop
 *
 * Entry point: startNavigation(startDlvl, onDone, env)
 *   env: NavEnv adapter (NHBrowserEnv for browser, NHNodeEnv for Node)
 * Depends on window.NHNav (from nav-core.mjs and nav-strategy.mjs).
 *
 * Loop: microtask iteration with input-readiness check.
 * No setTimeout/setImmediate — uses queueMicrotask and only steps
 * when the WASM shim is waiting for input (inputResolve !== null).
 */

(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-ai.mjs'); return; }

  const { W, H, DIRS, KEY, MONSTERS, isWalkable, isBfsWalkable,
          findOnMap, scanMap, bfs, findNearestUnexplored,
          findNearestMonster, shuffleDirs,
          handleExplore, handleSearch, handleFight,
          handleOpenDoor, handleKickDoor } = NH;

  const scheduleNext = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn) => Promise.resolve().then(fn);

  function startNavigation(startDlvl, onDone, env) {
    console.log('[NAV] startNavigation called, env=' + typeof env);
    if (!env) {
      console.log('[NAV] missing env, aborting');
      if (onDone) onDone('no-env');
      return;
    }

    let state = 'explore';
    let lastPlayerPos = null;
    let stuckCount = 0;
    let tickCount = 0;
    let pendingDir = null;
    let pendingKickDir = null;
    let exploredDirs = shuffleDirs();
    let searchCount = 0;
    let doorAttemptDir = null;
    let lastEatTick = 0;
    let choked = false;
    let stopped = false;
    let positionHistory = [];
    let petBlockCount = 0;
    let lastStairsPos = null;
    let blind = false;
    let fightTicks = 0;

    const MAX_TICKS = 50000;

    function stop(reason) {
      stopped = true;
      if (onDone) onDone(reason);
    }

    // Returns true if a key was sent, false if we should stop.
    // Guarantees at most one sendKey() call per invocation.
    function step() {
      if (stopped) return false;

      tickCount++;

      if (tickCount <= 3) {
        console.log('[NAV] step() tick=' + tickCount);
      }

      // ---- Pending direction keys (for multi-key commands like 'o'+dir) ----
      if (pendingDir !== null) {
        env.sendKey(KEY[pendingDir].charCodeAt(0));
        pendingDir = null;
        return true;
      }
      if (pendingKickDir !== null) {
        env.sendKey(KEY[pendingKickDir].charCodeAt(0));
        pendingKickDir = null;
        return true;
      }

      // ---- Win / lose checks ----
      if (env.getDlvl() !== startDlvl) {
        stop('descended');
        return false;
      }

      if (env.getHp() === 0) {
        stop('died');
        return false;
      }

      if (env.isGameDone && env.isGameDone()) {
        stop('game-ended');
        return false;
      }

      // ---- Modal handling (YN prompts, menus) ----
      if (env.isYnVisible()) {
        const ynText = env.getYnText();
        if (ynText.includes('possessions identified') || ynText.includes('identified?')) {
          stop('died');
          return false;
        }
        if (!env.clickYnButton()) {
          env.sendKey(121); // 'y'
        }
        return true;
      }

      if (env.isMenuVisible()) {
        const menuText = env.getMenuText();
        const itemMatch = menuText.match(/\[([a-z])(?:-([a-z]))?\s*(?:or\s+)?\?\*\]/);
        if (itemMatch) {
          env.sendKey(itemMatch[1].charCodeAt(0));
        } else if (menuText.includes('Really') || menuText.includes('Really?')) {
          env.sendKey('y'.charCodeAt(0));
        } else if (menuText.includes('eat') || menuText.includes('Eat') ||
                   menuText.includes('drink') || menuText.includes('read') ||
                   menuText.includes('What do you want')) {
          env.sendKey('a'.charCodeAt(0));
        } else {
          env.sendKey(27);
        }
        return true;
      }

      // ---- Read the map ----
      const grid = env.getMap();
      if (!grid || grid.length === 0) {
        // Map not ready yet — send wait action
        env.sendKey('.'.charCodeAt(0));
        return true;
      }
      const { player, stairs, food } = findOnMap(grid);
      const msgs = env.getRecentMessages(15);
      if (!player) {
        const blindMsgs = msgs.filter(m => m.includes('see yourself') || m.includes('blind'));
        if (blindMsgs.length > 0) {
          blind = true;
          env.sendKey(KEY[Math.floor(Math.random() * 8)].charCodeAt(0));
        } else {
          // Can't see player but not blind — send wait
          env.sendKey('.'.charCodeAt(0));
        }
        return true;
      }
      blind = false;

      // ---- Read HP and hunger ----
      const currentHp = env.getHp();
      const maxHp = env.getMaxHp();
      const hungerText = env.getHunger();
      const hpRatio = currentHp / maxHp;
      const lowHp = hpRatio < 0.4;
      const hungerNum = parseInt(hungerText) || 0;
      const isHungry = hungerNum >= 1 || hungerText === 'Hungry' || hungerText === 'Weak' || hungerText === 'Fainting';
      const isStarving = hungerNum >= 2 || hungerText === 'Fainting' || hungerText === 'Weak' ||
                         msgs.some(m => m.includes('faint from lack of food') || m.includes('weak from lack of food'));
      const noFood = msgs.some(m => m.includes("don't have anything to eat"));
      const justChoked = msgs.some(m => m.includes('choke') || m.includes('choking'));
      if (justChoked) choked = true;

      // ---- Periodic debug log ----
      if (tickCount % 200 === 0) {
        const feat = scanMap(grid);
        console.log(`[NAV] tick=${tickCount} state=${state} stuck=${stuckCount} fight=${fightTicks} pos=${player.x},${player.y} doors=${feat.doors.length} mon=${feat.monsters.length} walls=${feat.walls.length} hp=${currentHp}/${maxHp} hunger=${hungerText}`);
      }

      // ---- Low HP: immediately flee ----
      if (lowHp && state === 'fight') {
        const monster = findNearestMonster(grid, player.x, player.y);
        if (monster) {
          const fleeDirs = shuffleDirs();
          for (const di of fleeDirs) {
            const [ddx, ddy] = DIRS[di];
            const nx = player.x + ddx, ny = player.y + ddy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              const ch = (grid[ny]||'')[nx] || ' ';
              if (isWalkable(ch)) {
                env.sendKey(KEY[di].charCodeAt(0));
                state = 'explore';
                fightTicks = 0;
                exploredDirs = shuffleDirs();
                return true;
              }
            }
          }
        }
      }

      // ---- Eat when hungry ----
      if ((isHungry || lowHp) && !noFood && !choked && (tickCount - lastEatTick) > 20) {
        lastEatTick = tickCount;
        choked = false;
        env.sendKey('e'.charCodeAt(0));
        return true;
      }
      if (!justChoked && choked && (tickCount - lastEatTick) > 10) {
        choked = false;
      }

      if (isStarving && state === 'fight') {
        state = 'explore';
        fightTicks = 0;
      }

      // ---- Movement detection & stuck counting ----
      const moved = !lastPlayerPos || player.x !== lastPlayerPos.x || player.y !== lastPlayerPos.y;
      if (moved) {
        stuckCount = 0;
        if (state === 'explore') { exploredDirs = shuffleDirs(); }
        if (state === 'fight') fightTicks = Math.max(0, fightTicks - 2);
      } else {
        stuckCount++;
        if (state === 'fight') fightTicks++;
      }
      lastPlayerPos = { ...player };
      positionHistory.push(`${player.x},${player.y}`);
      if (positionHistory.length > 20) positionHistory.shift();

      if (positionHistory.length >= 10) {
        const last = positionHistory.slice(-10);
        const unique = new Set(last);
        if (unique.size <= 3) {
          stuckCount += 5;
          positionHistory = [];
          exploredDirs = shuffleDirs();
          if (state === 'explore') { state = 'search'; searchCount = 0; }
        }
      }

      if (state === 'fight' && fightTicks > 15) {
        state = 'explore';
        fightTicks = 0;
        exploredDirs = shuffleDirs();
        stuckCount = 0;
      }

      const recentMsgs5 = env.getRecentMessages(5);
      const isSearchSpamNow = recentMsgs5.length >= 3 &&
        recentMsgs5.filter(m => m.includes('already found a monster')).length >= 3;
      if (isSearchSpamNow && state === 'search') {
        state = 'explore'; searchCount = 0;
        exploredDirs = shuffleDirs(); stuckCount = 0;
      }

      const swapCount = msgs.filter(m => m.includes('swap places')).length;
      const petBlocking = msgs.some(m => m.includes('is in the way'));
      if (swapCount >= 3 || petBlocking) { petBlockCount++; } else { petBlockCount = Math.max(0, petBlockCount - 1); }
      if (petBlockCount > 3) {
        petBlockCount = 0; exploredDirs = shuffleDirs();
        env.sendKey('.'.charCodeAt(0));
        return true;
      }

      if (stuckCount > 500) { stop('stuck'); return false; }

      // ---- Stuck-escape: random walkable move ----
      if (stuckCount > 80 && state === 'explore') {
        stuckCount = 0;
        const randDirs = shuffleDirs();
        for (const di of randDirs) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ch = (grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch)) {
              env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
          }
        }
      }

      // ---- Food pathfinding ----
      if (isStarving && noFood && food) {
        const fdx = Math.abs(player.x - food.x);
        const fdy = Math.abs(player.y - food.y);
        if (fdx === 0 && fdy === 0) { env.sendKey('g'.charCodeAt(0)); return true; }
        else {
          const next = bfs(player.x, player.y, food.x, food.y, grid);
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
      }

      // ---- Stairs tracking & navigation ----
      if (stairs) {
        lastStairsPos = { x: stairs.x, y: stairs.y };
        let stairsCode = null;
        if (player.x === stairs.x && player.y === stairs.y) {
          stairsCode = 62;
        } else {
          const next = bfs(player.x, player.y, stairs.x, stairs.y, grid);
          if (next) {
            const nextCh = (grid[next.y]||'')[next.x] || ' ';
            if (nextCh === '+') {
              stairsCode = 'o'.charCodeAt(0);
              pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            } else {
              const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
              stairsCode = KEY[idx]?.charCodeAt(0);
            }
          }
        }
        if (stairsCode) {
          state = 'explore'; fightTicks = 0;
          env.sendKey(stairsCode);
          return true;
        }
      }

      if (!stairs && lastStairsPos && player.x === lastStairsPos.x && player.y === lastStairsPos.y) {
        env.sendKey(62);
        return true;
      }

      if (!stairs) {
        const currentFeat = scanMap(grid);
        if (currentFeat.doors.length === 0 && state === 'explore' && stuckCount > 3) {
          state = 'search'; searchCount = 0;
        }
      }

      if (food && (hungerNum >= 1 || !noFood)) {
        const fdx = Math.abs(player.x - food.x);
        const fdy = Math.abs(player.y - food.y);
        if (fdx === 0 && fdy === 0) { env.sendKey('e'.charCodeAt(0)); return true; }
        else if (fdx + fdy <= 5) {
          const next = bfs(player.x, player.y, food.x, food.y, grid);
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
      }

      // ---- State machine ----
      let code = null;
      const stateObj = { stuckCount, searchCount, exploredDirs, pendingDir, doorAttemptDir, petBlockCount, lastStairsPos, starving: isStarving };

      if (state !== 'fight') {
        const monster = findNearestMonster(grid, player.x, player.y);
        if (monster) {
          const mdx = Math.abs(monster.x - player.x);
          const mdy = Math.abs(monster.y - player.y);
          if (mdx <= 1 && mdy <= 1) {
            let bestDir = -1, bestDist = 0;
            for (let di = 0; di < 8; di++) {
              const [ddx, ddy] = DIRS[di];
              const nx = player.x + ddx, ny = player.y + ddy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const ch = (grid[ny]||'')[nx] || ' ';
              if (!isWalkable(ch)) continue;
              const dist = Math.abs(nx - monster.x) + Math.abs(ny - monster.y);
              if (dist > bestDist) { bestDist = dist; bestDir = di; }
            }
            if (bestDir >= 0) {
              env.sendKey(KEY[bestDir].charCodeAt(0));
              state = 'explore'; exploredDirs = shuffleDirs();
              return true;
            }
            state = 'fight'; fightTicks = 0;
          }
        }
      }

      if (state === 'fight') {
        const monster = findNearestMonster(grid, player.x, player.y);
        if (monster) {
          let bestDir = -1, bestDist = 0;
          for (let di = 0; di < 8; di++) {
            const [ddx, ddy] = DIRS[di];
            const nx = player.x + ddx, ny = player.y + ddy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (grid[ny]||'')[nx] || ' ';
            if (!isWalkable(ch)) continue;
            const dist = Math.abs(nx - monster.x) + Math.abs(ny - monster.y);
            if (dist > bestDist) { bestDist = dist; bestDir = di; }
          }
          if (bestDir >= 0) {
            env.sendKey(KEY[bestDir].charCodeAt(0));
            state = 'explore'; fightTicks = 0; exploredDirs = shuffleDirs();
            return true;
          }
          const adjacentMonsters = [];
          for (let di = 0; di < 8; di++) {
            const [ddx, ddy] = DIRS[di];
            const nx = player.x + ddx, ny = player.y + ddy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (grid[ny]||'')[nx] || ' ';
            if (MONSTERS.has(ch)) {
              adjacentMonsters.push({ di, ch, dist: Math.abs(nx - monster.x) + Math.abs(ny - monster.y) });
            }
          }
          if (adjacentMonsters.length > 0) {
            adjacentMonsters.sort((a, b) => a.dist - b.dist);
            env.sendKey(KEY[adjacentMonsters[0].di].charCodeAt(0));
            return true;
          }
        }
      }

      switch (state) {
        case 'explore': {
          const result = handleExplore(stateObj, grid, player, stairs, food);
          code = result.code; state = result.state; stuckCount = result.stuckCount;
          searchCount = result.searchCount; exploredDirs = result.exploredDirs;
          pendingDir = result.pendingDir; doorAttemptDir = result.doorAttemptDir;
          petBlockCount = result.petBlockCount;
          if (state === 'fight') fightTicks = 0;
          break;
        }
        case 'search': {
          const result = handleSearch(stateObj, grid, player);
          code = result.code; state = result.state; stuckCount = result.stuckCount;
          searchCount = result.searchCount; exploredDirs = result.exploredDirs;
          break;
        }
        case 'fight': {
          const result = handleFight(stateObj, grid, player, stairs);
          code = result.code; state = result.state; stuckCount = result.stuckCount;
          searchCount = result.searchCount; exploredDirs = result.exploredDirs;
          petBlockCount = result.petBlockCount;
          break;
        }
        case 'open_door': {
          const result = handleOpenDoor(stateObj, grid, player);
          code = result.code; state = result.state; stuckCount = result.stuckCount;
          searchCount = result.searchCount; exploredDirs = result.exploredDirs;
          pendingDir = result.pendingDir; doorAttemptDir = result.doorAttemptDir;
          petBlockCount = result.petBlockCount;
          break;
        }
        case 'kick_door': {
          const result = handleKickDoor(stateObj, grid, player);
          code = result.code; state = result.state; stuckCount = result.stuckCount;
          searchCount = result.searchCount; exploredDirs = result.exploredDirs;
          pendingDir = result.pendingDir; doorAttemptDir = result.doorAttemptDir;
          petBlockCount = result.petBlockCount; pendingKickDir = result.pendingKickDir;
          break;
        }
      }

      // Always send a key — if state machine didn't decide, send random move
      if (!code) {
        code = KEY[Math.floor(Math.random() * 8)].charCodeAt(0);
      }

      env.sendKey(code);
      if (tickCount % 200 === 0) {
        console.log(`[NAV] tick=${tickCount} key=${String.fromCharCode(code)} (${code}) state=${state} pos=${player.x},${player.y}`);
      }
      return true;
    }

    // ---- Input-driven loop ----
    // Uses queueMicrotask for scheduling. Before each step(), checks
    // env.isReadyForInput() to ensure WASM is waiting for input.
    // This prevents key buffering and eliminates the need for setTimeout/setImmediate.
    function loop() {
      if (stopped) return;
      if (tickCount >= MAX_TICKS) {
        stop('max-ticks');
        return;
      }

      // Check if game ended externally (death, exit)
      if (env.isGameDone && env.isGameDone()) {
        stop('game-ended');
        return;
      }

      // If WASM isn't waiting for input yet, spin-wait via microtask
      if (env.isReadyForInput && !env.isReadyForInput()) {
        scheduleNext(loop);
        return;
      }

      step();
      if (!stopped) {
        scheduleNext(loop);
      }
    }

    // Kick off the first step
    scheduleNext(loop);
  }

  global.startNavigation = startNavigation;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module export (for Node)
export const startNavigation = globalThis.startNavigation;
