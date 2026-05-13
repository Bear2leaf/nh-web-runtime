/**
 * nav-combat.mjs — NetHack Navigation AI: Combat handler
 *
 * Simple combat: fight monsters directly, don't flee.
 * NetHack is a combat game — player should defeat Level 1 monsters.
 * Also handles invisible monsters that attack without being visible on map.
 * Depends on window.NHNav (from nav-core.mjs).
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-combat.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, shuffleDirs } = NH;

  /**
   * Handle combat: fight adjacent monsters directly, including invisible ones.
   * Returns true if this handler consumed the tick.
   */
  function handleCombat(navCtx) {
    const { env, player, grid, tickCount } = navCtx;

    // Fainted/Fainting: player is unconscious, can't fight
    const hungerTrimmed = (env.getHunger() || '').trim();
    if (hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting') {
      return false;
    }

    // Check all 8 directions for adjacent hostile monsters
    let adjHostile = null;
    for (let di = 0; di < 8; di++) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ch = (grid[ny]||'')[nx] || ' ';
      if (MONSTERS.has(ch)) {
        // Skip pets — don't attack them
        if (PET_CHARS.has(ch)) continue;
        adjHostile = { x: nx, y: ny, ch, di };
        break;
      }
    }

    // If adjacent hostile monster, attack it
    if (adjHostile) {
      const dx = adjHostile.x - player.x;
      const dy = adjHostile.y - player.y;
      const fightIdx = DIRS.findIndex(([ddx, ddy]) => ddx === dx && ddy === dy);
      if (fightIdx >= 0) {
        navCtx.lastMoveDir = fightIdx;
        env.sendKey(KEY[fightIdx].charCodeAt(0));
        return true;
      }
    }

    // Invisible monster attack: "It bites!" / "It hits!" messages mean invisible monster on our tile
    // Force-fight in a random direction to hit it
    const invisibleHitMsg = navCtx.msgs.some(m =>
      m.includes('It bites!') || m.includes('It hits!') ||
      m.includes('It stings!') || m.includes('It claws!')
    );
    const onTileCooldown = navCtx.lastOnTileTick && (tickCount - navCtx.lastOnTileTick) < 5;
    if (invisibleHitMsg && !onTileCooldown) {
      navCtx.lastOnTileTick = tickCount;
      // Try force-fight in random direction to hit invisible monster
      const shuffled = shuffleDirs();
      const fightDir = shuffled[0];
      const [ddx, ddy] = DIRS[fightDir];
      navCtx.lastMoveDir = fightDir;
      env.sendKey('F'.charCodeAt(0)); // Force fight
      navCtx.pendingDir = fightDir;
      return true;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleCombat });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleCombat } = global.NHNav || {};
