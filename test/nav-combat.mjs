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

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, shuffleDirs, isWalkable, isBfsWalkable, bfsAvoiding } = NH;

  /**
   * Handle adjacent hostile monster: flee if low HP, otherwise fight.
   * Returns true if this handler consumed the tick.
   */
  function handleCombat(navCtx) {
    const { env, player, grid, hadPetBlock, knownTrapPositions, isInCorridor, tickCount } = navCtx;
    const blocked = knownTrapPositions || new Set();

    // Fainted/Fainting: player is unconscious, can't move. Combat flee is futile.
    // Return false so food/hp-hunger handlers can run (they send '.' to wait).
    const hungerTrimmed = (env.getHunger() || '').trim();
    if (hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting') {
      return false;
    }

    // Check all 8 directions for adjacent hostile monsters
    let adjHostile = null;
    const stuckCount = navCtx.stuckCount || 0;
    for (let di = 0; di < 8; di++) {
      const [ddx, ddy] = DIRS[di];
      const nx = player.x + ddx, ny = player.y + ddy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ch = (grid[ny]||'')[nx] || ' ';
      // Monster characters are hostile — we can't visually distinguish pets from hostiles
      // on the map, so treat all as hostile (better to attack than be killed)
      if (MONSTERS.has(ch)) {
        // NEVER try to fight pets with normal movement — NetHack blocks it ("is in the way").
        // Skipping lets the door/corridor handlers run, which can open doors or navigate around.
        // On-tile monster detection (below) still catches pets that are truly attacking.
        if (PET_CHARS.has(ch)) continue;
        adjHostile = { x: nx, y: ny, ch, di };
        break;
      }
    }

    // On-tile monster detection: messages like "The X bites!" / "The X hits!" without
    // a visible adjacent monster means a monster is on our tile (invisible, displaced, etc.)
    // Also: if we're being hit, ALWAYS flee regardless of HP — getting hit is worse than
    // any tactical advantage from fighting.
    // Use reverse iteration to find the MOST RECENT hit message, not the oldest.
    const hitMsgMatcher = m =>
      (m.includes(' bites!') || m.includes(' hits!') || m.includes(' stings!') ||
       m.includes(' claws!') || m.includes(' butts!')) && !m.includes('misses');
    // Find the LAST (most recent) hit message in the buffer, not the first
    let hitMsg = null;
    for (let i = navCtx.msgs.length - 1; i >= 0; i--) {
      if (hitMsgMatcher(navCtx.msgs[i])) { hitMsg = navCtx.msgs[i]; break; }
    }

    // Debounce: hitMsgs stay in the buffer for many ticks.
    // KEY FIX: Use ANY hit message in buffer as trigger (not just most-recent).
    // Interface prompts (e.g., "What do you want to read?") can push the bite message
    // out of the last-5 window. Being hit is always urgent — respond immediately.
    // Action-based debounce: after handling, wait 3 ticks before re-triggering.
    const hasHitMsg = navCtx.msgs.some(m => hitMsgMatcher(m));
    const onTileCooldown = navCtx.lastOnTileTick && (tickCount - navCtx.lastOnTileTick) < 3;
    if (!adjHostile && hasHitMsg && !onTileCooldown) {
      navCtx.lastOnTileTick = tickCount;
      navCtx.lastHitMsg = hitMsg;
      navCtx.lastHitTick = tickCount;
      const maxHp = env.getMaxHp() || 1;
      const curHp = env.getHp();
      const hpRatio = curHp / maxHp;
      console.log(`[NAV-CBT] On-tile hitMsg="${hitMsg}" hp=${curHp}/${maxHp} tick=${tickCount}`);

      // At >= 30% HP, force-fight immediately. Fleeing doesn't help because
      // on-tile monsters follow. At low HP, try to flee first.
      if (hpRatio >= 0.3) {
        // Cycle through directions so we try all 8 before repeating.
        navCtx._onTileFightIdx = (navCtx._onTileFightIdx || 0) % 8;
        const fightDir = navCtx._onTileFightIdx;
        navCtx._onTileFightIdx++;
        console.log(`[NAV-CBT] On-tile force-fight dir=${fightDir} hp=${curHp}/${maxHp} tick=${tickCount}`);
        env.sendKey('F'.charCodeAt(0));
        navCtx.pendingDir = fightDir;
        return true;
      }

      // Low HP: try to flee first.
      const shuffled = shuffleDirs();
      for (const fi of shuffled) {
        const [fdx, fdy] = DIRS[fi];
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (!isWalkable(ch) || MONSTERS.has(ch) || blocked.has(nx + ',' + ny)) continue;
        const isDiag = Math.abs(fdx) === 1 && Math.abs(fdy) === 1;
        if (isDiag && isInCorridor) continue;
        if (isDiag) {
          const ch1 = (grid[player.y]||'')[player.x + fdx] || ' ';
          const ch2 = (grid[player.y + fdy]||'')[player.x] || ' ';
          if (!isBfsWalkable(ch1) && !isBfsWalkable(ch2)) continue;
        }
        navCtx.lastMoveDir = fi;
        env.sendKey(KEY[fi].charCodeAt(0));
        return true;
      }
      // Can't flee — force-fight even at low HP, cycle through directions
      navCtx._onTileFightIdx = (navCtx._onTileFightIdx || 0) % 8;
      const fightDir = navCtx._onTileFightIdx;
      navCtx._onTileFightIdx++;
      console.log(`[NAV-CBT] On-tile can't flee — force-fighting dir=${fightDir} tick=${tickCount}`);
      env.sendKey('F'.charCodeAt(0));
      navCtx.pendingDir = fightDir;
      return true;
    }

    // If no adjacent hostile and no hit message, let other handlers run
    if (!adjHostile) return false;

    const dx = adjHostile.x - player.x;
    const dy = adjHostile.y - player.y;
    const maxHp = env.getMaxHp() || 1;
    const curHp = env.getHp();
    const hpRatio = curHp / maxHp;
    // Flee threshold: 10% — in NetHack, fleeing from an adjacent monster triggers
    // an attack of opportunity and the monster follows. Fighting almost always
    // deals more damage to the monster than fleeing costs the player.
    // Only flee when critically low (1 HP out of 10 = 10%).
    const lowHp = hpRatio < 0.1;
    // Critical HP: try prayer as last resort when at 10% or below
    const criticalHp = hpRatio < 0.1;

    // Low HP: try to escape first. At >40% HP, always fight.
    // fightIdx computed here so Phase 5 (cornered) can reference it
    const fightIdx = adjHostile ? DIRS.findIndex(([ddx, ddy]) => ddx === dx && ddy === dy) : -1;
    if (lowHp) {
      console.log(`[NAV-CBT] FLEE at tick=${navCtx.tickCount} hp=${curHp}/${maxHp} ratio=${hpRatio.toFixed(2)} lowHp=${lowHp}`);
      // Phase 1: BFS flee — find a safe tile at least 3 tiles from monster.
      // Dropped from 4 to 3 to work in small rooms (e.g., 10×5).
      let escapeTarget = null;
      let bestScore = -Infinity;
      for (let ty = Math.max(0, player.y - 6); ty < Math.min(H, player.y + 7); ty++) {
        for (let tx = Math.max(0, player.x - 8); tx < Math.min(W, player.x + 9); tx++) {
          if (tx === player.x && ty === player.y) continue;
          const ch = (grid[ty]||'')[tx] || ' ';
          if (!isWalkable(ch)) continue;
          const fromMon = Math.abs(tx - adjHostile.x) + Math.abs(ty - adjHostile.y);
          const fromPlayer = Math.abs(tx - player.x) + Math.abs(ty - player.y);
          if (fromMon < 3) continue; // not safe enough
          if (fromPlayer > 8) continue; // too far to reach quickly
          // Score: high distance from monster, low distance from player
          const score = fromMon * 2 - fromPlayer;
          if (score > bestScore) { bestScore = score; escapeTarget = {x: tx, y: ty}; }
        }
      }
      if (escapeTarget && bfsAvoiding) {
        const next = bfsAvoiding(player.x, player.y, escapeTarget.x, escapeTarget.y, grid, blocked);
        if (next) {
          const stepDx = next.x - player.x, stepDy = next.y - player.y;
          // Step must move away from monster (not toward it) and not be stationary
          if ((stepDx * dx + stepDy * dy < 0) || (stepDx === 0 && stepDy === 0)) {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===stepDx && ddy===stepDy);
            if (idx >= 0) {
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }

      // Phase 2: Any direction moving away from monster (ignore pet tiles — pet swap IS escape)
      const fleeDirs = shuffleDirs();
      for (const fi of fleeDirs) {
        const [fdx, fdy] = DIRS[fi];
        if (fdx * dx + fdy * dy >= 0) continue;
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          // Pet tiles: swapping with pet is a valid escape — it breaks contact
          if (isWalkable(ch) && !MONSTERS.has(ch) && !blocked.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = fi;
            env.sendKey(KEY[fi].charCodeAt(0));
            return true;
          }
        }
      }

      // Phase 3: Pet swap — move onto pet even though MONSTERS.has(pet)
      // This is the last resort before fighting. Swapping breaks monster contact.
      for (const fi of fleeDirs) {
        const [fdx, fdy] = DIRS[fi];
        if (fdx * dx + fdy * dy >= 0) continue;
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (PET_CHARS.has(ch) && isWalkable(ch) && !blocked.has(nx + ',' + ny)) {
            navCtx.lastMoveDir = fi;
            env.sendKey(KEY[fi].charCodeAt(0));
            return true;
          }
        }
      }

      // Phase 4: Critical HP — try prayer as last resort
      if (criticalHp && (tickCount - (navCtx.lastPrayTick || -1000)) > 500) {
        navCtx.lastPrayTick = tickCount;
        console.log(`[NAV] Critical HP (${curHp}/${maxHp}) and cornered — attempting prayer`);
        env.sendKey('#'.charCodeAt(0));
        navCtx.pendingPray = true;
        return true;
      }

      // Phase 5: Cornered — try any walkable direction WITHOUT monsters/pets.
      // Pet swap was already attempted in Phase 3. Retrying pet tiles here
      // causes failed swaps → stuckCount growth → pets become "hostile".
      const shuffled = shuffleDirs();
      for (const fi of shuffled) {
        const [fdx, fdy] = DIRS[fi];
        const nx = player.x + fdx, ny = player.y + fdy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch) && !MONSTERS.has(ch)) {
            navCtx.lastMoveDir = fi;
            env.sendKey(KEY[fi].charCodeAt(0));
            return true;
          }
        }
      }
      // TRULY cornered — fight back instead of waiting (waiting = free hits for monster)
      console.log(`[NAV-CBT] Cornered at low HP (${curHp}/${maxHp}) — fighting instead of waiting`);
      env.sendKey(KEY[fightIdx].charCodeAt(0));
      return true;
    }

    // Fight the monster — move into its tile
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
