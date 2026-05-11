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

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, shuffleDirs, isWalkable } = NH;

  /**
   * Handle adjacent hostile monster: flee if low HP, otherwise fight.
   * Returns true if this handler consumed the tick.
   */
  function handleCombat(navCtx) {
    const { env, player, grid, hadPetBlock } = navCtx;

    // Check all 8 directions for adjacent hostile monsters
    let adjHostile = null;
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
    }

    if (!adjHostile) return false;

    const dx = adjHostile.x - player.x;
    const dy = adjHostile.y - player.y;
    const maxHp = env.getMaxHp() || 1;
    const curHp = env.getHp();
    const lowHp = curHp / maxHp < 0.5;

    if (lowHp) {
      // Low HP: try to flee from monster (move away)
      const fleeDirs = shuffleDirs();
      for (const fi of fleeDirs) {
        const [fdx, fdy] = DIRS[fi];
        // Dot product < 0 means moving away from monster
        if (fdx * dx + fdy * dy >= 0) continue;
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch)) {
            env.sendKey(KEY[fi].charCodeAt(0));
            return true;
          }
        }
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
