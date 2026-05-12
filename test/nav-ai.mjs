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

      // Teleport
      teleportAttempts: 0,
      teleportFailed: false,

      // Boulder tracking
      failedBoulders: new Set(),
      boulderFailCount: {},

      // Trap avoidance
      knownTrapPositions: new Set(),

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
      NH.updateMapAndState(navCtx);
      if (!navCtx.grid || !navCtx.player) {
        navCtx.env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // Detect hidden adjacent monster: "Are you waiting to get hit?" means
      // there's an invisible monster adjacent. Don't wait — move in a random direction.
      // Debounced: only fire once per ~10 ticks since the message stays in the
      // message buffer for many ticks after the actual event.
      const waitingForHit = navCtx.msgs.some(m => m.includes('waiting to get hit'));
      if (waitingForHit && navCtx.tickCount - (navCtx.lastWaitingHitTick || 0) > 10) {
        navCtx.lastWaitingHitTick = navCtx.tickCount;
        console.log(`[NAV] Hidden monster detected (waiting to get hit) at tick=${navCtx.tickCount}`);
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          const [dx, dy] = DIRS[di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch)) {
            navCtx.lastMoveDir = di;
            navCtx.env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
        // All directions blocked — fight in a random direction
        navCtx.env.sendKey(KEY[shuffled[0]].charCodeAt(0));
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

      // ---- Level exploration (no stairs visible) ----
      if (NH.handleLevelExplore && NH.handleLevelExplore(navCtx)) return true;

      // ---- Door navigation: open/kick visible doors ----
      if (NH.handleDoors && NH.handleDoors(navCtx)) return true;

      // ---- Corridor navigation ----
      if (NH.handleCorridor && NH.handleCorridor(navCtx)) return true;

      // ---- Teleport fallback (before wall search, so it can interrupt) ----
      if (NH.handleTeleport && NH.handleTeleport(navCtx)) return true;

      // ---- Wall search / perimeter walking ----
      if (NH.handleWallSearch && NH.handleWallSearch(navCtx)) return true;

      // ---- Hard stuck timeout teleport ----
      if (navCtx.stuckCount > 500 && navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        console.log(`[NAV] Hard stuck timeout at tick=${navCtx.tickCount} stuck=${navCtx.stuckCount}, teleporting`);
        if (tryTeleport(navCtx)) return true;
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

    // Start the loop
    loop();
  }

  // Export to global for browser, and module export for Node
  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { startNavigation });

})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { startNavigation } = globalThis.NHNav || {};
