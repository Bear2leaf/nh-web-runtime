/**
 * nav-stuck.mjs — NetHack Navigation AI: Stuck detection & recovery
 *
 * Detects when the player hasn't moved for several ticks.
 * Sends ESC to clear hidden prompts, searches for hidden doors in rooms.
 * Tracks forced direction changes when the same direction keeps failing.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-stuck.js'); return; }

  /**
   * Handle stuck detection: ESC to clear prompts, search for hidden doors,
   * and track forced direction changes.
   * Returns true if this handler consumed the tick.
   */
  function handleStuck(navCtx) {
    const { env, tickCount, stuckCount, wallSearchPhase,
            lastSentDir, lastMoveDir, knownTrapPositions, msgs } = navCtx;

    // When wall search is active, don't intercept — let wall search handle navigation.
    // Only send ESC if wall search has been stuck for extremely long (>500).
    if (wallSearchPhase && stuckCount < 500) {
      // Don't consume the tick; let wall search handler deal with it
      // But still track forced direction changes below
    } else if (stuckCount > 20 && (stuckCount % 20 === 0)) {
      // Check if stuck because of a trap — if so, try a different direction
      const trapMsg = msgs.find(m => m.includes('Really step') && m.includes('trap'));
      if (trapMsg && lastMoveDir >= 0) {
        const { DIRS, KEY } = NH;
        // Compute the trap direction and mark it
        const [tdx, tdy] = DIRS[lastMoveDir];
        const trapX = navCtx.player.x + tdx;
        const trapY = navCtx.player.y + tdy;
        const trapKey = trapX + ',' + trapY;
        if (!navCtx.knownTrapPositions.has(trapKey)) {
          navCtx.knownTrapPositions.add(trapKey);
          console.log(`[NAV] Stuck handler discovered trap at ${trapKey} from Really step msg`);
        }
        // Try a perpendicular direction to go around the trap
        const perp = lastMoveDir < 2 ? [2, 3] : [0, 1]; // perpendicular cardinal dirs
        for (const di of [perp[0], perp[1], ...NH.shuffleDirs ? NH.shuffleDirs() : [4,5,6,7]]) {
          if (di === lastMoveDir) continue;
          const [ddx, ddy] = DIRS[di];
          const nx = navCtx.player.x + ddx, ny = navCtx.player.y + ddy;
          if (nx < 0 || nx >= NH.W || ny < 0 || ny >= NH.H) continue;
          const ch = (navCtx.grid || [])[ny] ? (navCtx.grid[ny][nx] || ' ') : ' ';
          if (NH.isWalkable(ch) && !NH.MONSTERS.has(ch)) {
            const idx = DIRS.findIndex(([xx,yy]) => xx===ddx && yy===ddy);
            if (idx >= 0) {
              console.log(`[NAV] Stuck trap recovery: trying perpendicular dir=${idx} around trap`);
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
        // If perpendicular also blocked, just ESC
      }
      console.log(`[NAV] Stuck recovery: sending ESC at tick=${tickCount} stuck=${stuckCount}`);
      env.sendKey(27);
      return true;
    }

    const isInCorridor = navCtx.isInCorridor;
    if (stuckCount > 40 && !isInCorridor && stuckCount % 20 === 0) {
      console.log(`[NAV] Stuck in room, searching for hidden doors at tick=${tickCount}`);
      navCtx.lastSearchTick = tickCount;
      env.sendKey('s'.charCodeAt(0));
      return true;
    }

    // Track forced direction changes
    if (lastMoveDir >= 0 && lastMoveDir === lastSentDir) {
      navCtx.sentDirCount++;
    } else {
      navCtx.sentDirCount = 0;
    }
    navCtx.lastSentDir = lastMoveDir;
    navCtx.forcedDirChange = navCtx.sentDirCount > 3 && lastMoveDir >= 0;

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleStuck });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleStuck } = global.NHNav || {};
