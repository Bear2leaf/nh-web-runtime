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
    // NetHack messages: "Really step into that pit?" / "Really step onto that bear trap?"
    const trapMsg = navCtx.msgs.find(m => m.includes('Really step'));
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

      // Trigger wall search when enclosed for sustained period.
      // Also trigger when heavily oscillating in a room — even with visible doors,
      // the AI may be unable to reach them (locked doors, BFS path blocked).
      const wallSearchSuppressed = navCtx.wallSearchSuppressUntilTick &&
                                   navCtx.tickCount < navCtx.wallSearchSuppressUntilTick;
      if (!navCtx.wallSearchPhase && !navCtx.isInCorridor && !wallSearchSuppressed) {
        const heavyOscillation = navCtx.isOscillating && navCtx.enclosedTick > 50 &&
                                 !navCtx.stairs;
        if ((isEnclosed && navCtx.enclosedTick > 100) ||
            (levelSearchTimeout && navCtx.enclosedTick > 40) ||
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
