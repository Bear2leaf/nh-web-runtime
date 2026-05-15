/**
 * nav-state-update.mjs — NetHack Navigation AI: Map & State Updater
 *
 * Updates navCtx with current map, player position, features,
 * HP, hunger, messages, and detects enclosed rooms (to trigger wall search).
 * Called every tick before the step dispatcher.
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-state-update.mjs'); return; }

  const { W, H, DIRS, findOnMap, scanMap, buildWallFollowPath } = NH;

  // ---- Update map and derived state (called every tick) ----
  function updateMapAndState(navCtx) {
    navCtx.grid = navCtx.env.getMap();
    if (!navCtx.grid || navCtx.grid.length === 0) return;

    const found = findOnMap(navCtx.grid);
    navCtx.player = found.player;
    navCtx.stairs = found.stairs;
    navCtx.food = found.food;

    if (!navCtx.player) return;

    navCtx.msgs = navCtx.env.getRecentMessages(30);

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
    const sawPetSwap = navCtx.msgs.some(m => m.includes('swap places with'));
    const sawPetBlockMsg = navCtx.msgs.some(m => m.includes('is in the way'));
    const sawPetRefuseSwap = navCtx.msgs.some(m => m.includes("doesn't want to swap places"));
    navCtx.hadPetBlock = sawPetSwap || sawPetBlockMsg || sawPetRefuseSwap;

    // Count recent pet swap messages for deadlock detection (leapfrogging resets stuckCount)
    navCtx._recentPetSwapCount = navCtx.msgs.slice(-10).filter(m => m.includes('swap places with')).length;
    if ((navCtx._recentPetSwapCount || 0) >= 3) {
      navCtx._petSwapBurstActive = true;
      navCtx._petSwapBurstTick = navCtx.tickCount;
    } else if (navCtx._petSwapBurstActive && navCtx.tickCount - (navCtx._petSwapBurstTick || 0) > 8) {
      navCtx._petSwapBurstActive = false;
    }

    // Track pet position from swap/block messages (use NEW messages only)
    // Compare current buffer with previous to detect genuinely new events
    const prevSwapCount = navCtx._prevSwapMsgCount || 0;
    const currentSwapCount = navCtx.msgs.filter(m =>
      m.includes('swap places with') || m.includes('is in the way') || m.includes("doesn't want to swap places")
    ).length;
    const newSwapEvents = Math.max(0, currentSwapCount - prevSwapCount);
    navCtx._prevSwapMsgCount = currentSwapCount;

    if (newSwapEvents > 0 && navCtx.lastMoveDir >= 0) {
      const [dx, dy] = DIRS[navCtx.lastMoveDir];
      // Determine pet position from the most recent swap/block message
      const lastSwapMsg = navCtx.msgs.slice().reverse().find(m =>
        m.includes('swap places with') || m.includes('is in the way') || m.includes("doesn't want to swap places")
      );
      if (lastSwapMsg && lastSwapMsg.includes('swap places with')) {
        navCtx.petPosition = { x: navCtx.player.x - dx, y: navCtx.player.y - dy };
      } else {
        navCtx.petPosition = { x: navCtx.player.x + dx, y: navCtx.player.y + dy };
      }
      navCtx.petPositionTick = navCtx.tickCount;
    }
    // Clear stale pet position after 300 ticks without interaction.
    // Pets follow the player closely; they rarely disappear within a few hundred
    // ticks. A longer timeout prevents accidental pet attacks when swap messages
    // age out of the buffer during long corridor walks.
    if (navCtx.petPositionTick && navCtx.tickCount - navCtx.petPositionTick > 300) {
      navCtx.petPosition = null;
      navCtx.petPositionTick = 0;
    }

    // (Pet swap throttle counter moved below, after position tracking)

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

    // ---- Pet swap throttle: DISABLED ----
    // Previous approaches (cooldown, direction-counting, position-based) all
    // caused either excessive waiting (max-ticks) or failed to prevent loops.
    // Pet blocking is now handled locally by corridor and boulder-pet handlers.
    navCtx.petSwapBlocked = false;

    // Read HP & hunger
    navCtx.currentHp = navCtx.env.getHp();
    navCtx.maxHp = navCtx.env.getMaxHp();
    navCtx.hungerText = navCtx.env.getHunger();
    navCtx.hpRatio = navCtx.maxHp > 0 ? navCtx.currentHp / navCtx.maxHp : 1;
    navCtx.lowHp = navCtx.hpRatio < 0.7;
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

    // Persist "no food" state so handlers don't spam 'e' after the message drops from buffer
    if (navCtx.msgs.some(m => m.includes("don't have anything to eat"))) {
      navCtx.noFoodUntilTick = navCtx.tickCount + 150;
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
    // NetHack messages: "Really step into that pit?" / "Really step onto that bear trap?"
    const trapMsg = navCtx.msgs.find(m => m.includes('Really step') || m.includes('Step into') || m.includes('step into') || m.includes('avoid stepping'));
    if (trapMsg) {
      console.log(`[NAV-TRAP] Detected trap message: "${trapMsg.substring(0, 60)}" lastMoveDir=${navCtx.lastMoveDir} knownTraps=${navCtx.knownTrapPositions.size}`);
      if (navCtx.lastMoveDir >= 0) {
        const [dx, dy] = DIRS[navCtx.lastMoveDir];
        // For diagonal moves, the trap could be on either cardinal tile the move passes through.
        // Mark all possible trap positions to be safe.
        const trapPositions = [];
        if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
          trapPositions.push({x: navCtx.player.x + dx, y: navCtx.player.y});
          trapPositions.push({x: navCtx.player.x, y: navCtx.player.y + dy});
        }
        trapPositions.push({x: navCtx.player.x + dx, y: navCtx.player.y + dy});
        for (const tp of trapPositions) {
          const key = tp.x + ',' + tp.y;
          if (!navCtx.knownTrapPositions.has(key)) {
            navCtx.knownTrapPositions.add(key);
            console.log(`[NAV] Discovered trap at ${tp.x},${tp.y} (from Really step msg, dir=${navCtx.lastMoveDir}), total=${navCtx.knownTrapPositions.size}`);
          }
        }
      } else {
        // Fallback: lastMoveDir not set (handler sent key without setting it).
        // Mark ALL adjacent tiles as potential traps to be safe.
        // We mark even non-walkable tiles because visible traps (^) are not walkable
        // but BFS already avoids them. The key case is invisible traps that appear
        // as floor/corridor — but marking all adjacent tiles is the safest fallback.
        for (const [dx, dy] of DIRS) {
          const tx = navCtx.player.x + dx, ty = navCtx.player.y + dy;
          if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
          const key = tx + ',' + ty;
          if (!navCtx.knownTrapPositions.has(key)) {
            navCtx.knownTrapPositions.add(key);
            console.log(`[NAV] Discovered trap at ${tx},${ty} (fallback, lastMoveDir=-1), total=${navCtx.knownTrapPositions.size}`);
          }
        }
      }
    }

    // Detect wall-hitting loops — if the player keeps walking into walls, reset lastMoveDir
    // so that oscillation/stuck detection can kick in and force a different direction.
    if (navCtx.msgs.some(m => m.includes('harmlessly attack') || m.includes('attack the wall') ||
                              m.includes('attack the stone') || m.includes('It\'s a wall'))) {
      if (navCtx.lastMoveDir >= 0) {
        console.log(`[NAV] Wall hit detected in dir=${navCtx.lastMoveDir}, resetting movement direction`);
        navCtx.lastMoveDir = -1;
        navCtx.sentDirCount = 0;
      }
    }

    // Detect trap under player from "Waiting doesn't feel like a good idea" message
    // This happens when searching/resting on a trap tile.
    const waitingTrapMsg = navCtx.msgs.find(m => m.includes("Waiting doesn't feel like a good idea"));
    if (waitingTrapMsg) {
      const key = navCtx.player.x + ',' + navCtx.player.y;
      if (!navCtx.knownTrapPositions.has(key)) {
        navCtx.knownTrapPositions.add(key);
        console.log(`[NAV] Discovered trap UNDER PLAYER at ${navCtx.player.x},${navCtx.player.y} (from waiting msg), total=${navCtx.knownTrapPositions.size}`);
      }
    }

    // Track position changes for stuck detection
    const moved = !navCtx.lastPlayerPos ||
      navCtx.player.x !== navCtx.lastPlayerPos.x ||
      navCtx.player.y !== navCtx.lastPlayerPos.y;
    if (moved) {
      navCtx.stuckCount = 0;
      navCtx.doorAttemptCount = 0;
      navCtx._stuckTargetTicks = 0;
      navCtx._stuckTargetKey = null;
      navCtx.petSwapConsecutive = 0;
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
      // If a corridor is visible, the room is not truly enclosed — corridor handler owns corridors
      let corridorVisible = false;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if ((navCtx.grid[y]||'')[x] === '#') { corridorVisible = true; break; }
        }
        if (corridorVisible) break;
      }
      const hasTrueExits = !!navCtx.stairs || navCtx.features.doors.length > 0 || corridorVisible;
      const recentSearchCooldown = navCtx.searchCooldownTick > 0 &&
        navCtx.tickCount - navCtx.searchCooldownTick <= 10;
      const isEnclosed = noStairsOrDoors && !recentSearchCooldown && !navCtx.isInCorridor;
      const levelSearchTimeout = navCtx.tickCount > 800 && noStairsOrDoors;

      if (isEnclosed) {
        navCtx.enclosedTick++;
      } else if (navCtx.isOscillating && !navCtx.isInCorridor) {
        navCtx.enclosedTick += 0.2;  // reduced from 0.5 — oscillation alone shouldn't trigger wall search too quickly
      } else if (noStairsOrDoors && !navCtx.isInCorridor && !navCtx.wallSearchPhase) {
        navCtx.enclosedTick += 0.1;
      } else if (!navCtx.wallSearchPhase) {
        navCtx.enclosedTick = 0;
      }

      // During wall search, also increment enclosedTick so teleport can trigger
      // when wall search is stuck for too long (enclosedTick > 500 check in nav-teleport)
      if (navCtx.wallSearchPhase && !navCtx.isInCorridor) {
        navCtx.enclosedTick += 0.2;  // Slow growth during wall search when stuck
      }

      // If corridors are visible, the player is not enclosed — reset enclosedTick
      // so wall search doesn't accidentally trigger when corridors are the obvious exit
      if (corridorVisible && !navCtx.wallSearchPhase) {
        navCtx.enclosedTick = Math.max(0, navCtx.enclosedTick - 1);
      }

      // Trigger wall search when enclosed for sustained period.
      // Increased thresholds to give door exploration more time to work.
      // If corridors are visible on the map, the room has exits — corridor handler
      // should explore them instead of wall search wasting ticks.
      const wallSearchSuppressed = navCtx.wallSearchSuppressUntilTick &&
                                   navCtx.tickCount < navCtx.wallSearchSuppressUntilTick;
      // Don't trigger wall search if stairs are visible — navigate directly to them
      if (!navCtx.wallSearchPhase && !navCtx.isInCorridor && !wallSearchSuppressed && !corridorVisible && !navCtx.stairs) {
        const heavyOscillation = navCtx.isOscillating && navCtx.enclosedTick > 40;
        if ((isEnclosed && navCtx.enclosedTick > 50) ||
            (levelSearchTimeout && navCtx.enclosedTick > 20) ||
            heavyOscillation) {
          navCtx.wallFollowPath = buildWallFollowPath(navCtx.player.x, navCtx.player.y, navCtx.grid);
          navCtx.wallFollowIdx = 0;
          navCtx.wallSearchPhase = true;
          navCtx.wallFollowPasses = 0;
          navCtx.wallFollowTargetRetries = 0;
          navCtx.wallSearchStep = 0;
          console.log(`[NAV] Wall search started (enclosed=${isEnclosed} osc=${navCtx.isOscillating} enclosedTick=${navCtx.enclosedTick.toFixed(1)} timeout=${levelSearchTimeout}): ${navCtx.wallFollowPath.length} perimeter positions`);
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

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { updateMapAndState });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { updateMapAndState } = globalThis.NHNav || {};
