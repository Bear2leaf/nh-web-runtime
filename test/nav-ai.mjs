/**
 * nav-ai.mjs — NetHack Navigation AI: Main loop
 *
 * Entry point: startNavigation(startDlvl, onDone, env)
 *   env: NavEnv adapter (NHBrowserEnv for browser, NHNodeEnv for Node)
 * Depends on window.NHNav from nav-core.mjs and handler modules.
 *
 * Loop: microtask iteration with input-readiness check.
 *
 * Refactored: All behaviors extracted to handler modules.
 * step() is now a thin priority chain dispatcher.
 * All state lives in navCtx object passed by reference to handlers.
 */

(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-ai.mjs'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
          findOnMap, scanMap, bfs, shuffleDirs } = NH;

  // Direction indices: 0=W 1=E 2=N 3=S 4=NW 5=NE 6=SE 7=SW
  const CW_NEXT = [2, 3, 5, 6, 0, 1, 7, 4]; // clockwise turn from each dir
  const CCW_NEXT = [4, 5, 0, 1, 7, 6, 2, 3]; // counter-clockwise turn

  // Use setTimeout(0) in browser to yield to WASM input processing;
  // queueMicrotask in Node for speed.
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const scheduleNext = isBrowser
    ? (fn) => setTimeout(fn, 0)
    : (typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn));

  // Maximum teleport attempts before giving up
  const MAX_TELEPORT_ATTEMPTS = 3;

  function startNavigation(startDlvl, onDone, env) {
    console.log('[NAV] startNavigation called, env=' + typeof env);
    if (!env) { if (onDone) onDone('no-env'); return; }

    // ---- Navigation State Context ----
    // All state variables live here. Handlers receive this object by reference.
    const navCtx = {
      // Environment
      env,
      startDlvl,
      onDone,

      // Tick & position tracking
      tickCount: 0,
      stuckCount: 0,
      lastPlayerPos: null,
      recentPositions: [],
      MAX_RECENT: 20,

      // Pending key dispatch
      pendingDir: null,
      pendingKickDir: null,

      // HP & hunger
      lastEatTick: 0,
      choked: false,

      // Stopping condition
      stopped: false,

      // Stairs tracking
      lastStairsPos: null,

      // Door tracking
      lastDoorDir: null,
      doorAttemptCount: 0,
      triedDoors: new Set(),
      lastDoorPos: null,
      doorOpenAttempts: 0,
      legInjured: false,

      // Corridor navigation
      corridorFailCount: 0,
      lastCorridorTarget: null,
      corridorVisitCounts: new Map(),
      corridorOscillationTick: 0,
      lastOscHandlerTick: 0,
      lastMoveDir: -1,
      lastRoomPos: null,
      wasInCorridorLastTick: false,
      isInCorridor: false,
      hasVisibleCorridors: false,

      // Direction forcing
      lastSentDir: -1,
      sentDirCount: 0,
      forcedDirChange: false,

      // Wall search
      wallSearchPhase: false,
      wallSearchStep: 0,
      lastSearchTick: 0,
      searchedWallPos: new Set(),
      searchesAtCurrentPos: 0,
      lastWallPosKey: null,
      wallFollowPath: [],
      wallFollowIdx: 0,
      wallFollowPasses: 0,
      wallFollowTargetRetries: 0,
      enclosedTick: 0,
      searchCooldownTick: 0,

      // Teleport
      teleportAttempts: 0,
      teleportFailed: false,

      // Boulder tracking
      failedBoulders: new Set(),
      boulderFailCount: {},

      // Trap avoidance
      knownTrapPositions: new Set(),

      // Derived state (updated each tick in updateMapAndState)
      grid: null,
      player: null,
      stairs: null,
      food: null,
      features: null,
      msgs: [],
      currentHp: 0,
      maxHp: 0,
      hpRatio: 1,
      lowHp: false,
      hungerText: '',
      hungerTrimmed: '',
      isHungryCombined: false,
      noFood: false,
      justChoked: false,
      hadPetBlock: false,
      isOscillating: false,

      // Constants (for handlers to access)
      W, H, DIRS, KEY, MONSTERS, PET_CHARS,
      MAX_TICKS: 20000,
      MAX_TELEPORT_ATTEMPTS,
    };

    // ---- Helper Functions (shared by handlers) ----

    function stop(reason) {
      navCtx.stopped = true;
      if (navCtx.onDone) navCtx.onDone(reason);
    }

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
        // Only include walkable tiles (not walls, not corridor, not rock)
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
          if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) continue;
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
    function findNearestUnsearchedWall(px, py, grid) {
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
          if (!navCtx.searchedWallPos.has(key)) {
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
          if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) continue;
          visited[ny][nx] = 1;
          parent[ny][nx] = cur;
          queue.push({x: nx, y: ny});
        }
      }
      if (navCtx.searchedWallPos.size > 0) navCtx.searchedWallPos.clear();
      return null;
    }

    // Check search results from recent messages
    function checkSearchResults(msgs) {
      // Search reveals things like "You find a secret door", "You find a hidden passage",
      // or "You find a trap". If any of these, return true.
      // More permissive: any "find" in messages.
      return msgs.some(m => m.toLowerCase().includes('find'));
    }

    // Attempt to teleport (returns true if teleport was initiated)
    function tryTeleport() {
      if (navCtx.teleportAttempts >= MAX_TELEPORT_ATTEMPTS) return false;
      if (navCtx.teleportFailed) return false;
      navCtx.teleportAttempts++;
      console.log(`[NAV] Attempting teleport (${navCtx.teleportAttempts}/${MAX_TELEPORT_ATTEMPTS})`);
      navCtx.env.sendKey(20); // ^T = teleport in this NetHack build
      return true;
    }

    // ---- Update map and derived state (called every tick) ----
    function updateMapAndState() {
      navCtx.grid = navCtx.env.getMap();
      if (!navCtx.grid || navCtx.grid.length === 0) return;

      const found = findOnMap(navCtx.grid);
      navCtx.player = found.player;
      navCtx.stairs = found.stairs;
      navCtx.food = found.food;

      if (!navCtx.player) return;

      navCtx.msgs = navCtx.env.getRecentMessages(15);

      // Detect leg injury (can't kick anymore)
      if (navCtx.msgs.some(m => m.includes('in no shape for kicking'))) {
        navCtx.legInjured = true;
      }

      navCtx.features = scanMap(navCtx.grid);

      // Early corridor detection
      const playerCh = (navCtx.grid[navCtx.player.y]||'')[navCtx.player.x] || ' ';
      let cardCorridorCount = 0;
      let cardFloorCount = 0;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nch = (navCtx.grid[ny]||'')[nx] || ' ';
        if (nch === '#') cardCorridorCount++;
        if (nch === '.' || nch === '<' || nch === '>' || nch === '%') cardFloorCount++;
      }
      navCtx.isInCorridor = playerCh === '#' || (cardCorridorCount >= 2 && cardFloorCount === 0);

      // Check for visible corridors on map
      navCtx.hasVisibleCorridors = false;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if ((navCtx.grid[y]||'')[x] === '#') {
            navCtx.hasVisibleCorridors = true;
            break;
          }
        }
        if (navCtx.hasVisibleCorridors) break;
      }

      // Track corridor/room transitions
      const wasInCorridor = navCtx.wasInCorridorLastTick;
      navCtx.wasInCorridorLastTick = navCtx.isInCorridor;
      if (navCtx.isInCorridor && !wasInCorridor) {
        navCtx.lastRoomPos = navCtx.lastPlayerPos ? { ...navCtx.lastPlayerPos } : null;
      }
      if (!navCtx.isInCorridor && wasInCorridor) {
        navCtx.lastMoveDir = -1; // Reset corridor direction when entering a new room
      }

      // Detect pet blocking from recent messages
      navCtx.hadPetBlock = navCtx.msgs.some(m => m.includes('is in the way') || m.includes('swap places with'));

      // Track recent positions for oscillation detection
      navCtx.recentPositions.push({x: navCtx.player.x, y: navCtx.player.y});
      if (navCtx.recentPositions.length > navCtx.MAX_RECENT) navCtx.recentPositions.shift();

      // Track corridor visits for oscillation detection
      if (navCtx.isInCorridor) {
        const cKey = navCtx.player.x + ',' + navCtx.player.y;
        navCtx.corridorVisitCounts.set(cKey, (navCtx.corridorVisitCounts.get(cKey) || 0) + 1);
        navCtx.corridorOscillationTick++;
      } else {
        navCtx.corridorVisitCounts.clear();
        navCtx.corridorOscillationTick = 0;
      }

      // Read HP & hunger
      navCtx.currentHp = navCtx.env.getHp();
      navCtx.maxHp = navCtx.env.getMaxHp();
      navCtx.hungerText = navCtx.env.getHunger();
      navCtx.hpRatio = navCtx.maxHp > 0 ? navCtx.currentHp / navCtx.maxHp : 1;
      navCtx.lowHp = navCtx.hpRatio < 0.5;
      navCtx.hungerTrimmed = (navCtx.hungerText || '').trim();
      const isHungry = navCtx.hungerTrimmed === 'Hungry' || navCtx.hungerTrimmed === 'Weak' ||
                       navCtx.hungerTrimmed === 'Fainted' || navCtx.hungerTrimmed === 'Fainting';
      const hungerFromMsgs = navCtx.msgs.some(m =>
        m.toLowerCase().includes('hungry') || m.toLowerCase().includes('weak') ||
        m.toLowerCase().includes('faint') || m.toLowerCase().includes('starving'));
      navCtx.isHungryCombined = isHungry || hungerFromMsgs;
      navCtx.noFood = navCtx.msgs.some(m => m.includes("don't have anything to eat"));
      navCtx.justChoked = navCtx.msgs.some(m => m.includes('choke') || m.includes('choking'));
      if (navCtx.justChoked) navCtx.choked = true;

      // Detect teleport failure
      if (navCtx.msgs.some(m => m.includes("don't know that spell") || m.includes("You can't teleport"))) {
        if (!navCtx.teleportFailed) {
          navCtx.teleportFailed = true;
          console.log('[NAV] Teleport failed — player lacks teleport ability, disabling future attempts');
        }
      }

      // Detect unpushable boulders from failure messages
      if (navCtx.msgs.some(m => m.includes('but in vain'))) {
        // Find adjacent boulder and mark it as failed
        for (let di = 0; di < 8; di++) {
          const [dx, dy] = DIRS[di];
          const bx = navCtx.player.x + dx, by = navCtx.player.y + dy;
          if (bx >= 0 && bx < W && by >= 0 && by < H) {
            const ch = (navCtx.grid[by] || '')[bx] || ' ';
            if (ch === '`') {
              const bKey = bx + ',' + by;
              if (!navCtx.failedBoulders.has(bKey)) {
                navCtx.failedBoulders.add(bKey);
                console.log(`[NAV] Marked boulder at ${bx},${by} as unpushable`);
              }
            }
          }
        }
      }

      // Detect trap positions from "Really step" messages (trap was avoided by shim saying 'n')
      const trapMsg = navCtx.msgs.find(m => m.includes('Really step') && m.includes('trap'));
      if (trapMsg && navCtx.lastMoveDir >= 0) {
        const [dx, dy] = DIRS[navCtx.lastMoveDir];
        const trapX = navCtx.player.x + dx;
        const trapY = navCtx.player.y + dy;
        const key = trapX + ',' + trapY;
        if (!navCtx.knownTrapPositions.has(key)) {
          navCtx.knownTrapPositions.add(key);
          console.log(`[NAV] Discovered trap at ${trapX},${trapY} (from Really step msg), total=${navCtx.knownTrapPositions.size}`);
        }
      }

      // Track position changes for stuck detection
      const moved = !navCtx.lastPlayerPos ||
        navCtx.player.x !== navCtx.lastPlayerPos.x ||
        navCtx.player.y !== navCtx.lastPlayerPos.y;
      if (moved) {
        navCtx.stuckCount = 0;
        navCtx.doorAttemptCount = 0;
        // Clear lastStairsPos when player moves away — avoid stale reference
        if (navCtx.lastStairsPos &&
            (navCtx.player.x !== navCtx.lastStairsPos.x ||
             navCtx.player.y !== navCtx.lastStairsPos.y)) {
          navCtx.lastStairsPos = null;
        }
      } else {
        // Always track stuck count, even during wall search
        navCtx.stuckCount++;
      }
      navCtx.lastPlayerPos = { ...navCtx.player };

      // Direction forcing: same direction keeps failing
      navCtx.forcedDirChange = navCtx.sentDirCount > 3 && navCtx.lastSentDir >= 0;

      // Oscillation detection (independent of enclosure)
      navCtx.isOscillating = false;
      if (navCtx.recentPositions.length >= 8) {
        const posSet = new Set();
        for (const p of navCtx.recentPositions) posSet.add(p.x + ',' + p.y);
        if (posSet.size <= 4) navCtx.isOscillating = true;
      }

      // ---- Enclosed room detection (runs here so it can trigger wall search
      // ---- BEFORE lower-priority handlers consume the tick) ----
      {
        const noStairsOrDoors = !navCtx.stairs && navCtx.features &&
          (navCtx.features.doors.length === 0 ||
           (navCtx.triedDoors && navCtx.triedDoors.size >= navCtx.features.doors.length));
        const recentSearchCooldown = navCtx.searchCooldownTick > 0 &&
          navCtx.tickCount - navCtx.searchCooldownTick <= 10;
        const isEnclosed = noStairsOrDoors && !recentSearchCooldown && !navCtx.isInCorridor;
        const levelSearchTimeout = navCtx.tickCount > 800 && noStairsOrDoors;

        if (isEnclosed) {
          navCtx.enclosedTick++;
        } else if (navCtx.isOscillating && !navCtx.isInCorridor) {
          navCtx.enclosedTick += 0.5;
        } else if (noStairsOrDoors && !navCtx.isInCorridor && !navCtx.wallSearchPhase) {
          navCtx.enclosedTick += 0.1;
        } else if (!navCtx.wallSearchPhase) {
          navCtx.enclosedTick = 0;
        }

        // Trigger wall search when enclosed for sustained period
        if (!navCtx.wallSearchPhase && !navCtx.isInCorridor) {
          if ((isEnclosed && navCtx.enclosedTick > 100) ||
              (levelSearchTimeout && navCtx.enclosedTick > 40)) {
            navCtx.wallFollowPath = buildWallFollowPath(navCtx.player.x, navCtx.player.y, navCtx.grid);
            navCtx.wallFollowIdx = 0;
            navCtx.wallSearchPhase = true;
            navCtx.wallFollowPasses = 0;
            navCtx.wallFollowTargetRetries = 0;
            navCtx.wallSearchStep = 0;
            console.log(`[NAV] Wall search started in updateMapAndState (enclosed=${isEnclosed} enclosedTick=${navCtx.enclosedTick.toFixed(1)} timeout=${levelSearchTimeout}): ${navCtx.wallFollowPath.length} perimeter positions`);
          }
        }
      }

      // Periodic debug
      if (navCtx.tickCount % 50 === 0) {
        const feat = scanMap(navCtx.grid);
        const chars = new Set();
        for (let y = Math.max(0, navCtx.player.y - 5); y < Math.min(H, navCtx.player.y + 6); y++) {
          for (let x = Math.max(0, navCtx.player.x - 10); x < Math.min(W, navCtx.player.x + 11); x++) {
            const ch = (navCtx.grid[y]||'')[x] || ' ';
            if (ch !== ' ') chars.add(`'${ch}'@${x},${y}`);
          }
        }
        console.log(`[NAV] tick=${navCtx.tickCount} stuck=${navCtx.stuckCount} enclosed=${navCtx.enclosedTick} wallSearch=${navCtx.wallSearchPhase} wfIdx=${navCtx.wallFollowIdx}/${navCtx.wallFollowPath.length} teleports=${navCtx.teleportAttempts} pos=${navCtx.player.x},${navCtx.player.y} stairs=${!!navCtx.stairs} doors=${feat.doors.length} chars=${[...chars].join(',')}`);
      }
    }

    // ---- Get handlers from NHNav (loaded by module files) ----
    const getHandler = (name) => {
      const h = NH[name];
      if (!h) console.error(`[NAV] Handler ${name} not found — check module load order`);
      return h;
    };

    // ---- Thin Step Dispatcher ----
    // Priority chain: first handler to return true wins the tick.
    function step() {
      if (navCtx.stopped) return false;
      navCtx.tickCount++;
      if (navCtx.tickCount <= 3) console.log('[NAV] step() tick=' + navCtx.tickCount);

      // Stuck timeout
      if (navCtx.stuckCount > 1500) { stop('stuck'); return false; }
      // Max ticks timeout
      if (navCtx.tickCount > navCtx.MAX_TICKS) { stop('max-ticks'); return false; }

      // ---- Pending key dispatch (highest priority) ----
      if (navCtx.pendingDir !== null || navCtx.pendingKickDir !== null) {
        if (NH.handlePendingKeys && NH.handlePendingKeys(navCtx)) return true;
      }

      // ---- Win / lose checks ----
      if (navCtx.env.getDlvl() !== navCtx.startDlvl) { stop('descended'); return false; }
      if (navCtx.env.getHp() === 0) { stop('died'); return false; }
      if (navCtx.env.isGameDone && navCtx.env.isGameDone()) { stop('game-ended'); return false; }

      // ---- Modal handling (YN prompts, menus) ----
      if (NH.handleModal && NH.handleModal(navCtx)) return true;

      // ---- Read map and update all derived state ----
      updateMapAndState();
      if (!navCtx.grid || !navCtx.player) {
        navCtx.env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // ---- Food: navigate to & pick up floor food first ----
      if (NH.handleFood && NH.handleFood(navCtx)) return true;

      // ---- HP / hunger / eating from inventory ----
      if (NH.handleHpHunger && NH.handleHpHunger(navCtx)) return true;

      // ---- Combat: adjacent monster ----
      if (NH.handleCombat && NH.handleCombat(navCtx)) return true;

      // ---- Stuck recovery ----
      if (NH.handleStuck && NH.handleStuck(navCtx)) return true;

      // ---- Check search results from previous tick ----
      if (navCtx.lastSearchTick > 0 && navCtx.tickCount === navCtx.lastSearchTick + 1) {
        const foundSomething = navCtx.msgs.some(m => m.toLowerCase().includes('find'));
        if (foundSomething) {
          console.log(`[NAV] Search revealed something! msgs=${JSON.stringify(navCtx.msgs.filter(m => m.includes('find')))}`);
          navCtx.wallSearchPhase = false;
          navCtx.enclosedTick = 0;
          navCtx.wallFollowPath = [];
          navCtx.wallFollowIdx = 0;
          navCtx.searchedWallPos.clear();
          const freshFeatures = scanMap(navCtx.grid);
          if (freshFeatures.doors.length > 0) {
            console.log(`[NAV] ${freshFeatures.doors.length} doors now visible after search!`);
          }
          if (freshFeatures.stairsDown.length > 0) {
            console.log('[NAV] Stairs down discovered after search!');
          }
          navCtx.searchCooldownTick = navCtx.tickCount;
          const freshMap = findOnMap(navCtx.grid);
          if (freshMap.stairs && !navCtx.stairs) {
            navCtx.stairs = freshMap.stairs;
            console.log(`[NAV] Stairs found at ${freshMap.stairs.x},${freshMap.stairs.y} after search`);
          }
        }
        navCtx.lastSearchTick = 0;
      }

      // ---- Stairs navigation ----
      if (NH.handleStairs && NH.handleStairs(navCtx)) return true;

      // ---- Boulder / Pet blocking (before corridor, so pet swap gets priority) ----
      if (NH.handleBoulderPet && NH.handleBoulderPet(navCtx)) return true;

      // ---- Level exploration (no stairs visible) ----
      if (NH.handleLevelExplore && NH.handleLevelExplore(navCtx)) return true;

      // ---- Corridor navigation ----
      if (NH.handleCorridor && NH.handleCorridor(navCtx)) return true;

      // ---- Teleport fallback (before wall search, so it can interrupt) ----
      if (NH.handleTeleport && NH.handleTeleport(navCtx)) return true;

      // ---- Wall search / perimeter walking ----
      if (NH.handleWallSearch && NH.handleWallSearch(navCtx)) return true;

      // ---- Hard stuck timeout teleport ----
      if (navCtx.stuckCount > 500 && navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        console.log(`[NAV] Hard stuck timeout at tick=${navCtx.tickCount} stuck=${navCtx.stuckCount}, teleporting`);
        if (tryTeleport()) return true;
      }

      // ---- Explore: unexplored boundary + fallback random walk ----
      if (NH.handleExplore && NH.handleExplore(navCtx)) return true;

      // Final fallback: wait
      navCtx.env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // ---- Loop scheduler ----
    function loop() {
      if (navCtx.stopped) return;
      try {
        if (!navCtx.env.isReadyForInput || navCtx.env.isReadyForInput()) {
          step();
        }
      } catch (e) {
        console.error('[NAV] Exception in step():', e);
      }
      scheduleNext(loop);
    }

    // Attach helpers to navCtx for handlers that need them
    navCtx.isAdjacentToWall = isAdjacentToWall;
    navCtx.buildWallFollowPath = buildWallFollowPath;
    navCtx.isInDeadEnd = isInDeadEnd;
    navCtx.findNearestUnsearchedWall = findNearestUnsearchedWall;
    navCtx.checkSearchResults = checkSearchResults;
    navCtx.tryTeleport = tryTeleport;

    // Start the loop
    loop();
  }

  // Export to global for browser, and module export for Node
  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { startNavigation });

})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { startNavigation } = global.NHNav || {};
