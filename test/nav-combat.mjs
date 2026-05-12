/**
 * nav-combat.mjs — NetHack Navigation AI: Adjacent monster fight/flee
 *
 * Checks all 8 adjacent tiles for hostile monsters. Flees if HP < 50%,
 * otherwise attacks the monster.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-combat.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, shuffleDirs, isWalkable, bfsAvoiding } = NH;

  /**
   * Handle adjacent hostile monster: flee if low HP, otherwise fight.
   * Returns true if this handler consumed the tick.
   */
  function handleCombat(navCtx) {
    const { env, player, grid, hadPetBlock, knownTrapPositions, isInCorridor, tickCount } = navCtx;
    const blocked = knownTrapPositions || new Set();

    // Check all 8 directions for adjacent hostile monsters
    let adjHostile = null;
    const stuckCount = navCtx.stuckCount || 0;
    for (let di = 0; di < 8; di++) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ch = (grid[ny]||'')[nx] || ' ';
      // Monster characters that aren't in PET_CHARS are hostile
      if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) {
        // 'd' (canine) can be pet dog or hostile fox — skip if pet
        if (ch === 'd' && hadPetBlock) continue;
        adjHostile = { x: nx, y: ny, ch, di };
        break;
      }
      // PET_CHARS monster blocking for too long — treat as hostile
      if (MONSTERS.has(ch) && PET_CHARS.has(ch) && stuckCount > 30) {
        adjHostile = { x: nx, y: ny, ch, di };
        break;
      }
    }

    if (!adjHostile) return false;

    const dx = adjHostile.x - player.x;
    const dy = adjHostile.y - player.y;
    const maxHp = env.getMaxHp() || 1;
    const curHp = env.getHp();
    const hpRatio = curHp / maxHp;
    // More aggressive flee threshold: 70% (was 50%).
    // Level 1 monsters can deal 4-6 damage per turn — fleeing earlier helps.
    const lowHp = hpRatio < 0.7;
    // Critical HP: even harder to recover from
    const criticalHp = hpRatio < 0.4;

    if (lowHp) {
      // Try to flee using BFS to find a safe destination at least 5 tiles away
      // from the monster. This is smarter than the simple dot-product check below.
      let escapeTarget = null;
      let bestEscapeDist = -1;
      // Search a small radius for safe escape tiles
      for (let ty = Math.max(0, player.y - 6); ty < Math.min(H, player.y + 7); ty++) {
        for (let tx = Math.max(0, player.x - 8); tx < Math.min(W, player.x + 9); tx++) {
          if (tx === player.x && ty === player.y) continue;
          const ch = (grid[ty]||'')[tx] || ' ';
          if (!isWalkable(ch) || MONSTERS.has(ch)) continue;
          // Distance from monster (we want to maximize)
          const fromMon = Math.abs(tx - adjHostile.x) + Math.abs(ty - adjHostile.y);
          // Distance from player (we prefer closer reachable points)
          const fromPlayer = Math.abs(tx - player.x) + Math.abs(ty - player.y);
          if (fromMon < 4) continue; // not safe enough
          if (fromPlayer > 8) continue; // too far to reach quickly
          // Score: high distance from monster, low distance from player
          const score = fromMon * 2 - fromPlayer;
          if (score > bestEscapeDist) { bestEscapeDist = score; escapeTarget = {x: tx, y: ty}; }
        }
      }
      if (escapeTarget && bfsAvoiding) {
        const next = bfsAvoiding(player.x, player.y, escapeTarget.x, escapeTarget.y, grid, blocked);
        if (next) {
          // Don't step toward the monster
          const stepDx = next.x - player.x, stepDy = next.y - player.y;
          if (stepDx * dx + stepDy * dy < 0 || (stepDx === 0 && stepDy === 0)) {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===stepDx && ddy===stepDy);
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }

      // Fall back to old behavior: pick any direction moving away from monster
      const fleeDirs = shuffleDirs();
      for (const fi of fleeDirs) {
        const [fdx, fdy] = DIRS[fi];
        if (fdx * dx + fdy * dy >= 0) continue;
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch) && !blocked.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = fi;
            env.sendKey(KEY[fi].charCodeAt(0));
            return true;
          }
        }
      }

      // Critical HP and can't flee: try to pray (NetHack '#pray') as a Hail-Mary
      // Only attempt this once per few hundred ticks to avoid spamming.
      if (criticalHp && (tickCount - (navCtx.lastPrayTick || -1000)) > 500) {
        navCtx.lastPrayTick = tickCount;
        console.log(`[NAV] Critical HP (${curHp}/${maxHp}) and cornered — attempting prayer`);
        // '#' prefix + "pray" + Enter
        env.sendKey('#'.charCodeAt(0));
        navCtx.pendingPray = true;
        return true;
      }

      // No valid flee direction — fall through (will try to fight)
    }

    // Fight the monster — move into its tile
    const fightIdx = DIRS.findIndex(([ddx, ddy]) => ddx === dx && ddy === dy);
    if (fightIdx >= 0) {
      env.sendKey(KEY[fightIdx].charCodeAt(0));
      return true;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleCombat });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleCombat } = global.NHNav || {};
