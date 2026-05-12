/**
 * nav-teleport.mjs — NetHack Navigation AI: Teleport fallback
 *
 * Triggers teleport when the AI is stuck for too long:
 * - Wall search stuck: no new positions visited in 200+ ticks
 * - Room dead-end: no doors/stairs visible after extended search
 * - Corridor dead-end: no progress after oscillation detection
 *
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-teleport.js'); return; }

  /**
   * Handle teleport fallback when AI is stuck.
   * Returns true if this handler consumed the tick.
   *
   * Called as a mid-priority handler after door/corridor/explore have failed.
   * Checks if the AI has made any progress and triggers teleport if stuck.
   */
  function handleTeleport(navCtx) {
    const { env, player, grid, stairs, features, tickCount, stuckCount,
            isInCorridor, wallSearchPhase, wallFollowPath, wallFollowIdx,
            searchedWallPos, enclosedTick, teleportAttempts, teleportFailed } = navCtx;

    // Don't try to teleport if max attempts reached
    if (teleportAttempts >= MAX_TELEPORT_ATTEMPTS) {
      // Truly trapped: no exits, teleport exhausted — exit gracefully
      const noExits = !stairs && (!features || features.doors.length === 0);
      const noFood = !navCtx.food;
      if (noExits && noFood && enclosedTick > 300) {
        console.log(`[NAV] Truly trapped: no exits, no food, teleport exhausted. Exiting.`);
        navCtx.stopped = true;
        if (navCtx.onDone) navCtx.onDone('trapped');
        return true;
      }
      return false;
    }
    // If teleport previously failed, retry periodically — player may have
    // learned teleport spell or found a scroll in the meantime.
    if (teleportFailed && (tickCount - (navCtx._lastTeleportRetry || 0)) < 200) return false;

    const noStairsOrDoors = !stairs && (features.doors.length === 0 ||
      (navCtx.triedDoors && navCtx.triedDoors.size >= features.doors.length));

    // ---- Wall search stuck detection ----
    if (wallSearchPhase && noStairsOrDoors) {
      // If wall search hasn't advanced to a new target position for 200+ ticks
      if (navCtx._lastWallSearchTargetKey && stuckCount > 200) {
        console.log(`[NAV] Wall search stuck at target for ${stuckCount} ticks, trying teleport`);
        navCtx._lastWallSearchTargetKey = null;
        if (doTeleport(navCtx)) return true;
      }

      // Track current wall search target
      if (wallFollowPath.length > 0 && wallFollowIdx < wallFollowPath.length) {
        const target = wallFollowPath[wallFollowIdx];
        const targetKey = target.x + ',' + target.y;
        navCtx._lastWallSearchTargetKey = targetKey;
      }
    }

    // ---- Room dead-end: no progress after enclosed room detection ----
    if (!isInCorridor && noStairsOrDoors && enclosedTick > 300 && !wallSearchPhase) {
      console.log(`[NAV] Room dead-end for ${enclosedTick} ticks, no progress, teleporting`);
      if (doTeleport(navCtx)) return true;
    }

    // ---- Enclosed room with wall search failing ----
    if (!isInCorridor && enclosedTick > 500 && wallSearchPhase) {
      console.log(`[NAV] Wall search exhausted ${enclosedTick} ticks, teleporting`);
      if (doTeleport(navCtx)) return true;
    }

    // ---- Corridor stuck with no stairs ----
    if (isInCorridor && stuckCount > 80 && noStairsOrDoors) {
      console.log(`[NAV] Corridor stuck for ${stuckCount} ticks, no stairs, teleporting`);
      if (doTeleport(navCtx)) return true;
    }

    return false;
  }

  function doTeleport(navCtx) {
    navCtx.teleportAttempts++;
    navCtx._lastTeleportRetry = navCtx.tickCount;
    navCtx.teleportFailed = false; // Reset so we can retry later
    console.log(`[NAV] Attempting teleport (${navCtx.teleportAttempts}/${MAX_TELEPORT_ATTEMPTS})`);
    navCtx.env.sendKey(20); // ^T
    // Reset wall search state when teleporting
    navCtx.wallSearchPhase = false;
    navCtx.wallFollowPath = [];
    navCtx.wallFollowIdx = 0;
    navCtx.wallFollowPasses = 0;
    navCtx.wallFollowTargetRetries = 0;
    navCtx.searchedWallPos.clear();
    navCtx.enclosedTick = 0;
    return true;
  }

  const MAX_TELEPORT_ATTEMPTS = 3;

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleTeleport });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleTeleport } = global.NHNav || {};