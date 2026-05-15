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

      // Pet block wait tracking
      lastPetWaitTick: 0,
      petBlockWaitUntil: 0,
      _doorwayPetWaitUntil: 0,

      // Hidden monster timeout tracker
      _hiddenMonsterStartTick: 0,

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

      // ---- Intro text / display-file safety net ----
      // Some roles (Valkyrie, Healer, Priest) show a quest intro that can
      // stall the game if the usual key flow doesn't dismiss it. If we haven't
      // moved for a while and see intro text markers, send SPACE to advance.
      if (navCtx.stuckCount > 30) {
        const introMarkers = ['welcome to NetHack', 'Go bravely with',
          'hour of destiny has come', 'For the sake of us all'];
        const hasIntroText = navCtx.msgs.some(m =>
          introMarkers.some(marker => m.toLowerCase().includes(marker.toLowerCase()))
        );
        if (hasIntroText) {
          console.log(`[NAV] Intro text detected — sending SPACE to advance at tick=${navCtx.tickCount}`);
          navCtx.env.sendKey(' '.charCodeAt(0));
          return true;
        }
      }

      // ---- Read map and update all derived state ----
      // MUST run before handlers that read navCtx state (msgs, stuckCount, etc.)
      // so the buffer is fresh and stuckCount increments every tick.
      NH.updateMapAndState(navCtx);
      if (!navCtx.grid || !navCtx.player) {
        navCtx.env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // ---- Intro text / display-file safety net ----
      // Some roles (Valkyrie, Healer, Priest) show a quest intro that can
      // stall the game if the usual key flow doesn't dismiss it. If we haven't
      // moved for a while and see intro text markers, send SPACE to advance.
      // Only active early in the game (tickCount < 500) — intro text never
      // appears mid-game, and stale buffer messages must not trigger a SPACE
      // spam loop that produces "Unknown command" and max-ticks.
      if (navCtx.stuckCount > 30 && navCtx.tickCount < 500) {
        const introMarkers = ['welcome to NetHack', 'Go bravely with',
          'hour of destiny has come', 'For the sake of us all'];
        const hasIntroText = navCtx.msgs.some(m =>
          introMarkers.some(marker => m.toLowerCase().includes(marker.toLowerCase()))
        );
        if (hasIntroText) {
          console.log(`[NAV] Intro text detected — sending SPACE to advance at tick=${navCtx.tickCount}`);
          navCtx.env.sendKey(' '.charCodeAt(0));
          return true;
        }
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

      // Detect hidden adjacent monster:
      // "Are you waiting to get hit?" = invisible/hidden monster adjacent, or held (lichen).
      // "It bites!/hits!/misses!" = unseen attacker (invisible or hidden).
      // Don't wait — move or attack aggressively.
      // Fire every tick the message is present; the message may persist but
      // we need to keep trying to escape or kill the monster.
      // Only check the last few messages to avoid firing on stale buffer entries
      const lastFewMsgs = navCtx.msgs.slice(-5);
      const waitingForHit = lastFewMsgs.some(m => m.includes('waiting to get hit'));
      const heldByLichen = lastFewMsgs.some(m => m.includes('cannot escape'));
      const unseenAttack = lastFewMsgs.some(m => /^It\s+(bites|hits|misses)!/.test(m));
      // If there's a visible adjacent hostile monster, let handleCombat deal with it first.
      // The hidden-monster handler can run next tick if combat doesn't clear the message.
      // Skip the known pet — combat won't attack it anyway, so we should handle the
      // hidden monster ourselves instead of falling through to handlers that send '.'
      const hasVisibleAdjMonster = navCtx.features && navCtx.features.monsters.some(m => {
        const dist = Math.abs(m.x - navCtx.player.x) + Math.abs(m.y - navCtx.player.y);
        if (dist > 1) return false;
        if (navCtx.petPosition && m.x === navCtx.petPosition.x && m.y === navCtx.petPosition.y) return false;
        return true;
      });
      const hiddenMonsterActive = waitingForHit || heldByLichen || unseenAttack;
      // Reset hidden-monster tracker when message is gone
      if (!hiddenMonsterActive) {
        navCtx._hiddenMonsterStartTick = 0;
      }
      if (hiddenMonsterActive && !hasVisibleAdjMonster) {
        // Keep attacking hidden monsters, but add a timeout. Some hidden monsters
        // can't be hit (floating eye, wrong position, trap under player) and the
        // player just wastes ticks attacking air until stuckCount exceeds 1200.
        if (!navCtx._hiddenMonsterStartTick) navCtx._hiddenMonsterStartTick = navCtx.tickCount;
        const hiddenMonsterTicks = navCtx.tickCount - navCtx._hiddenMonsterStartTick;
        navCtx.lastWaitingHitTick = navCtx.tickCount;
        // After 40 ticks of hidden-monster combat without escaping, try teleport.
        // Only teleport when genuinely stuck (hasn't moved recently) to avoid
        // wasting teleports on monsters that are being killed but slowly.
        if (hiddenMonsterTicks > 40 && navCtx.stuckCount > 30 &&
            navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
          console.log(`[NAV] Hidden monster timeout after ${hiddenMonsterTicks} ticks, trying teleport`);
          if (tryTeleport(navCtx)) return true;
        }
        console.log(`[NAV] Hidden monster detected (${waitingForHit ? 'waiting' : ''}${heldByLichen ? 'held' : ''}${unseenAttack ? 'unseen-attack' : ''}) at tick=${navCtx.tickCount}`);
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
        // Skip walls (hitting walls wastes turns) and skip the known pet position.
        let attackDir = (navCtx.hiddenMonsterAttackDir || 0) % 8;
        const knownPet = navCtx.petPosition;
        let attempts = 0;
        while (attempts < 8) {
          const [adx, ady] = DIRS[attackDir];
          const ax = navCtx.player.x + adx, ay = navCtx.player.y + ady;
          if (ax < 0 || ax >= W || ay < 0 || ay >= H) {
            attackDir = (attackDir + 1) % 8;
            attempts++;
            continue;
          }
          const ach = (navCtx.grid[ay]||'')[ax] || ' ';
          const isPetTile = knownPet && ax === knownPet.x && ay === knownPet.y;
          const isWall = !isWalkable(ach);
          if (!isPetTile && !isWall) {
            break; // Valid attack direction found
          }
          attackDir = (attackDir + 1) % 8;
          attempts++;
        }
        if (attempts >= 8) {
          // All directions are walls/pets/out-of-bounds — can't attack effectively.
          // Try teleport as last resort. If no teleport, attack the first in-bounds
          // non-pet direction (even if it's a wall). Attacking a wall wastes a turn
          // but so does waiting, and attacking doesn't trigger the "waiting to get hit"
          // feedback loop that keeps the hidden-monster handler active indefinitely.
          if (navCtx.teleportAttempts < MAX_TELEPORT_ATTEMPTS && tryTeleport(navCtx)) {
            return true;
          }
          let fallbackDir = (navCtx.hiddenMonsterAttackDir || 0) % 8;
          for (let i = 0; i < 8; i++) {
            const fdi = (fallbackDir + i) % 8;
            const [fdx, fdy] = DIRS[fdi];
            const fx = navCtx.player.x + fdx, fy = navCtx.player.y + fdy;
            if (fx < 0 || fx >= W || fy < 0 || fy >= H) continue;
            const fch = (navCtx.grid[fy]||'')[fx] || ' ';
            if (knownPet && fx === knownPet.x && fy === knownPet.y) continue;
            fallbackDir = fdi;
            break;
          }
          navCtx.hiddenMonsterAttackDir = fallbackDir + 1;
          console.log(`[NAV] Hidden monster fully trapped — attacking fallback dir ${fallbackDir} at tick=${navCtx.tickCount}`);
          navCtx.env.sendKey('F'.charCodeAt(0));
          navCtx.pendingDir = fallbackDir;
          return true;
        }
        navCtx.hiddenMonsterAttackDir = attackDir + 1;
        console.log(`[NAV] Hidden monster trapped — force-attacking direction ${attackDir} at tick=${navCtx.tickCount}`);
        navCtx.env.sendKey('F'.charCodeAt(0));
        navCtx.pendingDir = attackDir;
        return true;
      }

      // ---- Oscillation breaker: if stuck bouncing between same tiles, force a direction ----
      // Note: stuckCount is reset on movement, so oscillation can happen with low stuckCount.
      // We use a position-history-based check (isOscillating) instead.
      if (navCtx.isOscillating && !navCtx._petSwapBurstActive &&
          navCtx.tickCount - (navCtx.lastOscBreakTick || 0) > 15) {
        navCtx.lastOscBreakTick = navCtx.tickCount;
        // Build a scored list of candidate directions. Prefer directions toward
        // stairs, then walkable tiles, and allow pet swaps as a last resort
        // (swapping with a pet is better than spinning in place forever).
        const candidates = [];
        for (let di = 0; di < 8; di++) {
          if (di === navCtx.lastMoveDir) continue;
          const [dx, dy] = DIRS[di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (!isWalkable(ch)) continue;
          if (navCtx.knownTrapPositions.has(nx + ',' + ny)) continue;
          let score = 0;
          if (navCtx.stairs) {
            const distBefore = Math.abs(navCtx.player.x - navCtx.stairs.x) + Math.abs(navCtx.player.y - navCtx.stairs.y);
            const distAfter = Math.abs(nx - navCtx.stairs.x) + Math.abs(ny - navCtx.stairs.y);
            score += (distBefore - distAfter) * 10;
          }
          if (MONSTERS.has(ch)) {
            score -= 5; // slight penalty for pets, not a hard block
          } else {
            score += 3; // bonus for clear tiles
          }
          candidates.push({di, score});
        }
        // First pass: prefer non-pet directions
        candidates.sort((a, b) => b.score - a.score);
        for (const c of candidates) {
          const [dx, dy] = DIRS[c.di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (!MONSTERS.has(ch)) {
            console.log(`[NAV] Oscillation breaker: forcing dir ${c.di} (score=${c.score}) at tick=${navCtx.tickCount}`);
            navCtx.lastMoveDir = c.di;
            navCtx.env.sendKey(KEY[c.di].charCodeAt(0));
            return true;
          }
        }
        // Second pass: allow pet swap if nothing else is available
        for (const c of candidates) {
          console.log(`[NAV] Oscillation breaker: forcing pet-swap dir ${c.di} (score=${c.score}) at tick=${navCtx.tickCount}`);
          navCtx.lastMoveDir = c.di;
          navCtx.env.sendKey(KEY[c.di].charCodeAt(0));
          return true;
        }
      }

      // Pre-compute inCombat for use by pet-wait and stairs rush
      const inCombat = navCtx.features && navCtx.features.monsters.some(m => {
        const dist = Math.abs(m.x - navCtx.player.x) + Math.abs(m.y - navCtx.player.y);
        return dist <= 1;
      });
      // Count adjacent hostiles excluding known pet (pet is in monsters now)
      const adjHostileExclPet = navCtx.features ? navCtx.features.monsters.filter(m => {
        const dist = Math.abs(m.x - navCtx.player.x) + Math.abs(m.y - navCtx.player.y);
        if (dist > 1) return false;
        if (navCtx.petPosition && m.x === navCtx.petPosition.x && m.y === navCtx.petPosition.y) return false;
        return true;
      }).length : 0;

      // ---- Pet block wait: if pet REFUSES to swap in a corridor, wait briefly ----
      // to let the pet move on its own turn. Only wait on refusal messages
      // ("is in the way", "doesn't want to swap"); successful swaps are normal
      // corridor movement — waiting just wastes ticks and prevents progress.
      // Only safe when no hostile monsters are adjacent (hidden monster will
      // reject wait with "doesn't feel like a good idea").
      const petRefusedSwap = navCtx.msgs.slice(-5).some(m =>
        m.includes('is in the way') || m.includes("doesn't want to swap places")
      );
      if (petRefusedSwap && navCtx.isInCorridor && adjHostileExclPet === 0 &&
          navCtx.tickCount >= navCtx.petBlockWaitUntil) {
        if (navCtx.petBlockWaitUntil === 0) {
          // Start a 5-tick wait burst
          navCtx.petBlockWaitUntil = navCtx.tickCount + 5;
          console.log(`[NAV] Pet refused swap in corridor — starting 5-tick wait to let pet move`);
        }
        if (navCtx.tickCount < navCtx.petBlockWaitUntil) {
          navCtx.env.sendKey('.'.charCodeAt(0));
          return true;
        }
        // Wait burst done — clear flag and let normal navigation retry
        navCtx.petBlockWaitUntil = 0;
      }

      // ---- Stairs rush: if stairs are visible and close, run to them instead of fighting ----
      // Getting to stairs is the primary goal. Adjacent monsters can be ignored if
      // stairs are within reach — descending ends combat instantly.
      if (navCtx.stairs) {
        // Always rush to visible stairs — descending is the primary goal
        if (NH.handleStairs && NH.handleStairs(navCtx)) return true;
      } else if (navCtx.lastStairsPos && (navCtx.lowHp || inCombat)) {
        // Stairs not visible but we remember where they were — rush there when in danger
        const ls = navCtx.lastStairsPos;
        const next = NH.bfs(navCtx.player.x, navCtx.player.y, ls.x, ls.y,
                            navCtx.grid, navCtx.openedDoors, navCtx.knownTrapPositions);
        if (next) {
          const idx = DIRS.findIndex(([ddx,ddy]) =>
            ddx === (next.x - navCtx.player.x) && ddy === (next.y - navCtx.player.y));
          if (idx >= 0) {
            const nextCh = (navCtx.grid[next.y]||'')[next.x] || ' ';
            // Don't walk into hostile monsters, but swapping with pet is OK
            if (!MONSTERS.has(nextCh) || NH.PET_CHARS.has(nextCh)) {
              console.log(`[NAV] Rushing to last known stairs at ${ls.x},${ls.y}`);
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
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

      // ---- Pet deadlock escape: if stuck for a while with adjacent monster,
      // try to move away from it BEFORE handleBoulderPet sends '.'. ----
      if (navCtx.stuckCount > 50 && !navCtx.lowHp) {
        let adjMonsterDi = -1;
        for (let di = 0; di < 8; di++) {
          const [dx, dy] = DIRS[di];
          const nx = navCtx.player.x + dx, ny = navCtx.player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (navCtx.grid[ny]||'')[nx] || ' ';
          if (MONSTERS.has(ch)) { adjMonsterDi = di; break; }
        }
        if (adjMonsterDi >= 0) {
          const [pdx, pdy] = DIRS[adjMonsterDi];
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
            console.log(`[NAV] Pet deadlock escape: stuck=${navCtx.stuckCount}, moving away from adjacent monster in dir ${di}`);
            navCtx.lastMoveDir = di;
            navCtx.env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
        }
      }

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
