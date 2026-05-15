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

  const { W, H, DIRS, KEY, MONSTERS, isWalkable, shuffleDirs } = NH;

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
    // Skip the known pet position to avoid swap loops / attacking our own pet
    const knownPet = navCtx.petPosition;
    let adjHostile = null;
    for (let di = 0; di < 8; di++) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ch = (grid[ny]||'')[nx] || ' ';
      if (MONSTERS.has(ch)) {
        // Skip known pet position
        if (knownPet && nx === knownPet.x && ny === knownPet.y) {
          continue;
        }
        adjHostile = { x: nx, y: ny, ch, di };
        break;
      }
    }

    // If adjacent hostile monster, attack it (or kite if very low HP)
    if (adjHostile) {
      const currentHp = navCtx.currentHp || player.hp || 10;
      const maxHp = navCtx.maxHp || env.getMaxHp ? env.getMaxHp() : 10;
      const hpPercent = maxHp > 0 ? (currentHp / maxHp) : 1;
      
      // Kite: if HP < 30% or surrounded by 2+ monsters, try to retreat.
      // On DL1 most monsters are weak; fighting a single monster is usually
      // faster and safer than kiting (which can trap us in corridors/doors).
      const adjMonsterCount = (() => { let c=0; for (let di=0; di<8; di++) {
        const [ddx,ddy]=DIRS[di]; const nx=player.x+ddx, ny=player.y+ddy;
        if (nx<0||nx>=W||ny<0||ny>=H) continue;
        if (MONSTERS.has((grid[ny]||'')[nx]||' ')) c++;
      } return c; })();
      if (hpPercent < 0.3 || adjMonsterCount >= 2) {
        // Find a retreat direction (not towards any monster, walkable, no trap)
        const monsterDirs = new Set();
        for (let di = 0; di < 8; di++) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (MONSTERS.has(ch)) {
            monsterDirs.add(di);
          }
        }
        // Prefer opposite direction of the closest monster
        const retreatDi = (adjHostile.di + 4) % 8;
        const [rdx, rdy] = DIRS[retreatDi];
        const rx = player.x + rdx, ry = player.y + rdy;
        if (rx >= 0 && rx < W && ry >= 0 && ry < H) {
          const rch = (grid[ry]||'')[rx] || ' ';
          if (isWalkable(rch) && !MONSTERS.has(rch) && !monsterDirs.has(retreatDi)) {
            if (!navCtx.knownTrapPositions || !navCtx.knownTrapPositions.has(rx + ',' + ry)) {
              console.log(`[NAV] Kiting: retreating dir=${retreatDi} from ${adjHostile.ch} at low HP ${currentHp}/${maxHp}`);
              navCtx.lastMoveDir = retreatDi;
              env.sendKey(KEY[retreatDi].charCodeAt(0));
              return true;
            }
          }
        }
        // Fallback: try any safe non-monster direction
        for (let di = 0; di < 8; di++) {
          if (monsterDirs.has(di)) continue;
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch)) {
            if (!navCtx.knownTrapPositions || !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
              console.log(`[NAV] Kiting fallback: moving dir=${di} at low HP`);
              navCtx.lastMoveDir = di;
              env.sendKey(KEY[di].charCodeAt(0));
              return true;
            }
          }
        }
      }
      
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
    // Force-fight in a random direction to hit it.
    // Also catch named monsters that attack but may not be visible on the map due to async
    // display timing — if adjHostile is null but messages show a monster attacking us,
    // force-fight to defend ourselves.
    const namedAttack = navCtx.msgs.some(m => /The \w+ (bites|hits|misses|stings)!/.test(m) || /The \w+ just misses!/.test(m));
    const invisibleHitMsg = navCtx.msgs.some(m =>
      m.includes('It bites!') || m.includes('It hits!') ||
      m.includes('It stings!') || m.includes('It claws!')
    );
    const onTileCooldown = navCtx.lastOnTileTick && (tickCount - navCtx.lastOnTileTick) < 5;
    if ((invisibleHitMsg || (namedAttack && !adjHostile)) && !onTileCooldown) {
      navCtx.lastOnTileTick = tickCount;
      // Monster is attacking but not visible on map (async display timing).
      // Walk in a random safe direction instead of force-fighting — walking into
      // the monster will attack it, and if we miss, we at least don't hit walls.
      const shuffled = shuffleDirs();
      for (const di of shuffled) {
        const [ddx, ddy] = DIRS[di];
        const nx = player.x + ddx, ny = player.y + ddy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(ch) && !navCtx.knownTrapPositions.has(nx + ',' + ny)) {
          navCtx.lastMoveDir = di;
          env.sendKey(KEY[di].charCodeAt(0));
          return true;
        }
      }
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleCombat });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleCombat } = global.NHNav || {};
