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

  const { W, H, DIRS, KEY, MONSTERS, isWalkable, shuffleDirs,
          tryTeleport, MAX_TELEPORT_ATTEMPTS } = NH;

  // Use setTimeout(0) in browser to yield to WASM input processing;
  // queueMicrotask in Node for speed.
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const scheduleNext = isBrowser
    ? (fn) => setTimeout(fn, 0)
    : (typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn));

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
      lastWaitingHitTick: 0,
      foodTarget: null,
      foodTargetDist: Infinity,

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
      wallSearchSuppressUntilTick: 0,

      // Teleport
      teleportAttempts: 0,
      teleportFailed: false,

      // Boulder tracking
      failedBoulders: new Set(),
      boulderFailCount: {},

      // Trap avoidance
      knownTrapPositions: new Set(),

      // No-food cooldown (persisted across message buffer turnover)
      noFoodUntilTick: 0,

      // Oscillation breaker cooldown
      lastOscBreakTick: 0,

      // Opened doors: tiles that were '+' but are now '-' or '|' after opening.
      // BFS treats these as walkable so the AI can navigate through them.
      openedDoors: new Set(),

      // Derived state (updated each tick by updateMapAndState)
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
      W, H, DIRS, KEY, MONSTERS,
      MAX_TICKS: 20000,
      MAX_TELEPORT_ATTEMPTS,
    };

    function stop(reason) {
      navCtx.stopped = true;
      if (navCtx.onDone) navCtx.onDone(reason);
    }

    // Attach shared helpers from NHNav so handlers can destructure from navCtx
    navCtx.isAdjacentToWall = NH.isAdjacentToWall;
    navCtx.buildWallFollowPath = NH.buildWallFollowPath;
    navCtx.isInDeadEnd = NH.isInDeadEnd;
    navCtx.findNearestUnsearchedWall = NH.findNearestUnsearchedWall;
    navCtx.checkSearchResults = NH.checkSearchResults;
    navCtx.tryTeleport = tryTeleport;

    // ---- Thin Step Dispatcher ----
    // Priority chain: first handler to return true wins the tick.
    function step() {
      if (navCtx.stopped) return false;
      navCtx.tickCount++;
      if (navCtx.tickCount <= 3) console.log('[NAV] step() tick=' + navCtx.tickCount);

      // Stuck timeout
      if (navCtx.stuckCount > 1200) { stop('stuck'); return false; }
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
      NH.updateMapAndState(navCtx);
      if (!navCtx.grid || !navCtx.player) {
        navCtx.env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // ---- Trap prompt safety net: if we just got a "Really step" message,
      // mark the trap and force a different direction this tick.
      // This prevents handlers from repeatedly sending the same direction
      // when the trap marking in updateMapAndState somehow missed it.
      const trapMsg = navCtx.msgs.find(m => m.includes('Really step') || m.includes('Step into') || m.includes('step into'));
      // Only trigger safety net when actually stuck (hasn't moved recently).
      // Otherwise we might falsely mark safe tiles as traps from stale messages.
      if (trapMsg && navCtx.lastMoveDir >= 0 && navCtx.stuckCount > 3) {
        const [tdx, tdy] = DIRS[navCtx.lastMoveDir];
        const trapKey = (navCtx.player.x + tdx) + ',' + (navCtx.player.y + tdy);
        if (!navCtx.knownTrapPositions.has(trapKey)) {
          navCtx.knownTrapPositions.add(trapKey);
          console.log(`[NAV-AI] Safety-net trap mark at ${trapKey} from lastMoveDir=${navCtx.lastMoveDir}`);
        }
        // Force a different direction this tick
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          if (di === navCtx.lastMoveDir) continue;
          const [dx, dy] = DIRS[di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch) &&
              !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
            console.log(`[NAV-AI] Forcing alternate dir ${di} to avoid trap at ${trapKey}`);
            navCtx.lastMoveDir = di;
            navCtx.env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
        // All directions blocked — try teleport if stuck long enough
        if (navCtx.stuckCount > 80 && navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
          if (tryTeleport(navCtx)) return true;
        }
        // Otherwise wait
        navCtx.env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // Detect hidden adjacent monster: "Are you waiting to get hit?" means
      // there's an invisible monster adjacent, or the player is held (lichen).
      // Don't wait — move or attack aggressively.
      // Fire every tick the message is present; the message may persist but
      // we need to keep trying to escape or kill the monster.
      // Only check the last few messages to avoid firing on stale buffer entries
      const lastFewMsgs = navCtx.msgs.slice(-5);
      const waitingForHit = lastFewMsgs.some(m => m.includes('waiting to get hit'));
      const heldByLichen = lastFewMsgs.some(m => m.includes('cannot escape'));
      // If there's a visible adjacent monster, let handleCombat deal with it first.
      // The hidden-monster handler can run next tick if combat doesn't clear the message.
      const hasVisibleAdjMonster = navCtx.features && navCtx.features.monsters.some(m => {
        const dist = Math.abs(m.x - navCtx.player.x) + Math.abs(m.y - navCtx.player.y);
        return dist <= 1;
      });
      if ((waitingForHit || heldByLichen) && !hasVisibleAdjMonster) {
        navCtx.lastWaitingHitTick = navCtx.tickCount;
        console.log(`[NAV] Hidden monster detected (waiting to get hit${heldByLichen ? ', held' : ''}) at tick=${navCtx.tickCount}`);
        const shuffled = shuffleDirs();

        // If held by a monster (e.g. lichen), moving won't work — attack immediately.
        // Also attack if we've already tried moving recently and it didn't work.
        const recentMoveFailed = navCtx.stuckCount > 5 && waitingForHit;
        if (!heldByLichen && !recentMoveFailed) {
          // Prefer safe directions (no monsters, no known traps)
          for (const di of shuffled) {
            const [dx, dy] = DIRS[di];
            const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (navCtx.grid[ny]||'')[nx] || ' ';
            const trapKey = nx + ',' + ny;
            if (isWalkable(ch) && !MONSTERS.has(ch) && !navCtx.knownTrapPositions.has(trapKey)) {
              navCtx.lastMoveDir = di;
              navCtx.env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
          }
          // All safe directions blocked — try to swap with pet, open door
          for (const di of shuffled) {
            const [dx, dy] = DIRS[di];
            const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (navCtx.grid[ny]||'')[nx] || ' ';
            if (MONSTERS.has(ch)) {
              navCtx.lastMoveDir = di;
              navCtx.env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
            if (ch === '+') {
              navCtx.env.sendKey('o'.charCodeAt(0));
              navCtx.pendingDir = di;
              return true;
            }
          }
        }
        // Truly trapped or held — attack systematically in all directions.
        // Skip the known pet position to avoid making pets hostile.
        let attackDir = (navCtx.hiddenMonsterAttackDir || 0) % 8;
        const knownPet = navCtx.petPosition;
        let attempts = 0;
        while (attempts < 8) {
          const [adx, ady] = DIRS[attackDir];
          const ax = navCtx.player.x + adx, ay = navCtx.player.y + ady;
          if (!knownPet || ax !== knownPet.x || ay !== knownPet.y) {
            break; // Safe direction found
          }
          attackDir = (attackDir + 1) % 8;
          attempts++;
        }
        navCtx.hiddenMonsterAttackDir = attackDir + 1;
        console.log(`[NAV] Hidden monster trapped — force-attacking direction ${attackDir} at tick=${navCtx.tickCount}`);
        navCtx.env.sendKey('F'.charCodeAt(0));
        navCtx.pendingDir = attackDir;
        return true;
      }

      // ---- Oscillation breaker: if stuck bouncing between same tiles, force random direction ----
      // Note: stuckCount is reset on movement, so oscillation can happen with low stuckCount.
      // We use a position-history-based check (isOscillating) instead.
      if (navCtx.isOscillating &&
          navCtx.tickCount - (navCtx.lastOscBreakTick || 0) > 15) {
        navCtx.lastOscBreakTick = navCtx.tickCount;
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          if (di === navCtx.lastMoveDir) continue;
          const [dx, dy] = DIRS[di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch) &&
              !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
            console.log(`[NAV] Oscillation breaker: forcing dir ${di} at tick=${navCtx.tickCount}`);
            navCtx.lastMoveDir = di;
            navCtx.env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
      }

      // ---- Stairs rush: if stairs are visible and close, run to them instead of fighting ----
      // Getting to stairs is the primary goal. Adjacent monsters can be ignored if
      // stairs are within reach — descending ends all combat immediately.
      if (navCtx.stairs) {
        const sDist = Math.abs(navCtx.stairs.x - navCtx.player.x) +
                      Math.abs(navCtx.stairs.y - navCtx.player.y);
        // When low HP or adjacent monster, rush to stairs at any distance — descending ends combat instantly
        const inCombat = navCtx.features && navCtx.features.monsters.some(m => {
          const dist = Math.abs(m.x - navCtx.player.x) + Math.abs(m.y - navCtx.player.y);
          return dist <= 1;
        });
        const rushThreshold = (navCtx.lowHp || inCombat) ? 50 : 8;
        if (sDist <= rushThreshold) {
          if (NH.handleStairs && NH.handleStairs(navCtx)) return true;
        }
      }

      // ---- Combat: adjacent monster — ALWAYS before food (getting bitten is worse than starving) ----
      if (NH.handleCombat && NH.handleCombat(navCtx)) return true;

      // ---- Food: navigate to & pick up floor food first ----
      if (NH.handleFood && NH.handleFood(navCtx)) return true;

      // ---- HP / hunger / eating from inventory ----
      if (NH.handleHpHunger && NH.handleHpHunger(navCtx)) return true;

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
          const freshFeatures = NH.scanMap(navCtx.grid);
          if (freshFeatures.doors.length > 0) {
            console.log(`[NAV] ${freshFeatures.doors.length} doors now visible after search!`);
          }
          if (freshFeatures.stairsDown.length > 0) {
            console.log('[NAV] Stairs down discovered after search!');
          }
          navCtx.searchCooldownTick = navCtx.tickCount;
          const freshMap = NH.findOnMap(navCtx.grid);
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

      // ---- Door navigation: open/kick visible doors (BEFORE level explore) ----
      // Stairs are always in rooms; doors lead to rooms. Prioritize opening doors
      // over generic boundary exploration since each opened door may lead to stairs.
      if (NH.handleDoors && NH.handleDoors(navCtx)) return true;

      // ---- Level exploration (no stairs visible, no untried doors) ----
      if (NH.handleLevelExplore && NH.handleLevelExplore(navCtx)) return true;

      // ---- Corridor navigation ----
      if (NH.handleCorridor && NH.handleCorridor(navCtx)) return true;

      // ---- Teleport fallback (before wall search, so it can interrupt) ----
      if (NH.handleTeleport && NH.handleTeleport(navCtx)) return true;

      // ---- Wall search / perimeter walking ----
      if (NH.handleWallSearch && NH.handleWallSearch(navCtx)) return true;
      // Wall search didn't consume tick — log why once per 500 ticks
      if (navCtx.tickCount % 500 === 0 && !navCtx.wallSearchPhase) {
        console.log(`[NAV] Wall search skipped: wallSearchPhase=${navCtx.wallSearchPhase} enclosed=${navCtx.enclosedTick.toFixed(1)} tick=${navCtx.tickCount}`);
      }

      // ---- Hard stuck timeout teleport ----
      // Aggressive teleport when stuck in wall search (wfIdx=0 means no progress)
      const inWallSearch = navCtx.wallSearchPhase && navCtx.wallFollowPath.length > 0 && navCtx.wallFollowIdx === 0;
      if ((navCtx.stuckCount > 150 && inWallSearch) ||
          (navCtx.stuckCount > 500 && navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS)) {
        console.log(`[NAV] Hard stuck: tick=${navCtx.tickCount} stuck=${navCtx.stuckCount} wallSearch=${inWallSearch}, teleporting`);
        if (tryTeleport(navCtx)) return true;
      }

      // ---- Pet swap throttle: if too many consecutive swaps, wait to let pet move ----
      // Run this late so other handlers (doors, stairs, etc.) get a chance first.
      // Only block when no other handler found a valid action.
      if (navCtx.petSwapBlocked && !navCtx.lowHp) {
        // Direction has been pet-blocked too many times. Try to move away.
        if (navCtx.petPosition) {
          const pdx = navCtx.petPosition.x - navCtx.player.x;
          const pdy = navCtx.petPosition.y - navCtx.player.y;
          const awayDirs = [];
          for (let di = 0; di < 8; di++) {
            const [dx, dy] = DIRS[di];
            if (dx * pdx + dy * pdy > 0) continue;
            const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ch = (navCtx.grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch) && !MONSTERS.has(ch) &&
                !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
              awayDirs.push(di);
            }
          }
          if (awayDirs.length > 0) {
            const di = awayDirs[Math.floor(Math.random() * awayDirs.length)];
            console.log(`[NAV] Pet swap throttle: moving away from pet at ${navCtx.petPosition.x},${navCtx.petPosition.y} in dir ${di}`);
            navCtx.lastMoveDir = di;
            navCtx.env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
        // No away direction — wait briefly, then clear block counts and retry
        if (navCtx.stuckCount > 200 && navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
          console.log(`[NAV] Pet-blocked and stuck for ${navCtx.stuckCount} ticks, trying teleport`);
          if (tryTeleport(navCtx)) return true;
        }
        if (!navCtx.petSwapWaitUntil) navCtx.petSwapWaitUntil = navCtx.tickCount + 8;
        if (navCtx.tickCount < navCtx.petSwapWaitUntil) {
          navCtx.env.sendKey('.'.charCodeAt(0));
          return true;
        }
        // Wait done — clear block counts and let normal navigation retry
        navCtx.petSwapWaitUntil = 0;
        navCtx._petBlockDirCounts = {};
        console.log(`[NAV] Pet swap wait done, clearing block counts`);
        // Fall through to explore
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
      // Check game end even when isReadyForInput() is false — prevents the loop
      // from spinning on empty microtask queue when the WASM game has exited.
      if (navCtx.env.isGameDone && navCtx.env.isGameDone()) {
        stop('game-ended');
        return;
      }
      try {
        if (!navCtx.env.isReadyForInput || navCtx.env.isReadyForInput()) {
          step();
        }
      } catch (e) {
        console.error('[NAV] Exception in step():', e);
      }
      scheduleNext(loop);
    }

    // Start the loop
    loop();
  }

  // Export to global for browser, and module export for Node
  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { startNavigation });

})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { startNavigation } = globalThis.NHNav || {};
