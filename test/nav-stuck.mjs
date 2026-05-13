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

    // When wall search is active, don't intercept — let wall search/teleport handle it.
    // Handle stuck should only run as a last resort when other handlers have failed.
    if (wallSearchPhase && stuckCount < 500) {
      // Don't consume the tick; let wall search/teleport handler deal with it
      // But still track forced direction changes below
    } else if (stuckCount > 20 && (stuckCount % 20 === 0)) {
      // Check if stuck because of a trap — if so, mark it and pathfind around it
      // OUTSIDE the trap check: first try perpendicular movement, then fall back to ESC
      if (lastMoveDir >= 0) {
        const { DIRS, KEY } = NH;
        const trapMsg = msgs.find(m => m.includes('Really step'));
        if (trapMsg) {
          // Compute the trap direction and mark it
          const [tdx, tdy] = DIRS[lastMoveDir];
          const trapX = navCtx.player.x + tdx;
          const trapY = navCtx.player.y + tdy;
          const trapKey = trapX + ',' + trapY;
          if (!navCtx.knownTrapPositions.has(trapKey)) {
            navCtx.knownTrapPositions.add(trapKey);
            console.log(`[NAV] Stuck handler discovered trap at ${trapKey} from Really step msg`);
          }
          // Try perpendicular directions first (cardinal only)
          const perp = lastMoveDir < 2 ? [2, 3] : [0, 1];
          let moved = false;
          for (const di of [...perp, ...[4,5,6,7]]) {
            if (di === lastMoveDir) continue;
            const [ddx, ddy] = DIRS[di];
            const nx = navCtx.player.x + ddx, ny = navCtx.player.y + ddy;
            if (nx < 0 || nx >= NH.W || ny < 0 || ny >= NH.H) continue;
            const ch = (navCtx.grid || [])[ny] ? (navCtx.grid[ny][nx] || ' ') : ' ';
            if (NH.isWalkable(ch) && !NH.MONSTERS.has(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
              const idx = DIRS.findIndex(([xx,yy]) => xx===ddx && yy===ddy);
              if (idx >= 0) {
                console.log(`[NAV] Stuck trap recovery: trying perpendicular dir=${idx} around trap`);
                navCtx.lastMoveDir = idx;
                env.sendKey(KEY[idx].charCodeAt(0));
                return true;
              }
            }
          }
          // Perpendicular all blocked — try going backward
          const oppositeDir = lastMoveDir < 2 ? (lastMoveDir === 0 ? 1 : 0) : (lastMoveDir === 2 ? 3 : 2);
          const [odx, ody] = DIRS[oppositeDir];
          const ox = navCtx.player.x + odx, oy = navCtx.player.y + ody;
          if (ox >= 0 && ox < NH.W && oy >= 0 && oy < NH.H) {
            const och = (navCtx.grid || [])[oy] ? ((navCtx.grid || [])[oy][ox] || ' ') : ' ';
            if (NH.isWalkable(och) && !NH.MONSTERS.has(och)) {
              const oidx = DIRS.findIndex(([xx,yy]) => xx===odx && yy===ody);
              if (oidx >= 0) {
                console.log(`[NAV] Stuck trap: backing up opposite dir=${oidx} to escape corridor`);
                navCtx.lastMoveDir = oidx;
                env.sendKey(KEY[oidx].charCodeAt(0));
                return true;
              }
            }
          }
          // Last resort: ESC to dismiss prompt
          console.log(`[NAV] Stuck recovery: sending ESC at tick=${tickCount} stuck=${stuckCount}`);
          env.sendKey(27);
          return true;
        }
      }
      console.log(`[NAV] Stuck recovery: sending ESC at tick=${tickCount} stuck=${stuckCount}`);
      env.sendKey(27);
      return true;
    }

    const isInCorridor = navCtx.isInCorridor;
    if (stuckCount > 40 && !isInCorridor && stuckCount % 20 === 0) {
      // Don't search while standing on a known trap — NetHack warns "Waiting doesn't
      // feel like a good idea right now" and searching accomplishes nothing.
      const onTrap = navCtx.knownTrapPositions && navCtx.knownTrapPositions.has(
        navCtx.player.x + ',' + navCtx.player.y);
      if (onTrap) {
        console.log(`[NAV] Stuck on known trap at ${navCtx.player.x},${navCtx.player.y}, skipping search`);
        return false;
      }
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
