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
    const { env, player, lastPlayerPos, stuckCount, wallSearchPhase,
            tickCount, lastSentDir, lastMoveDir } = navCtx;

    const moved = !lastPlayerPos || player.x !== lastPlayerPos.x || player.y !== lastPlayerPos.y;

    // Update stuck count
    if (moved) {
      navCtx.stuckCount = 0;
      navCtx.doorAttemptCount = 0;
    } else if (!wallSearchPhase) {
      navCtx.stuckCount++;
    }
    navCtx.lastPlayerPos = { x: player.x, y: player.y };

    if (navCtx.stuckCount > 1500) {
      navCtx.stopped = true;
      if (navCtx.onDone) navCtx.onDone('stuck');
      return true;
    }

    // ---- Stuck recovery: same direction failing, or hidden prompt blocking ----
    if (stuckCount > 20 && (stuckCount % 20 === 0)) {
      console.log(`[NAV] Stuck recovery: sending ESC at tick=${tickCount} stuck=${stuckCount}`);
      env.sendKey(27);
      return true;
    }

    const isInCorridor = navCtx.isInCorridor;
    if (stuckCount > 40 && !isInCorridor) {
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
