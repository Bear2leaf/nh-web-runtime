/**
 * nav-food.mjs — NetHack Navigation AI: Food detection & pickup
 *
 * Handles: navigating to food on floor when hungry, picking it up and eating.
 * Also picks up food when standing on it (regardless of hunger).
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-food.js'); return; }

  const { W, H, DIRS, KEY, bfs, scanMap, PET_CHARS, isBfsWalkable } = NH;

  /**
   * BFS that avoids positions in a blocked set.
   * Returns first step {x,y} or null.
   */
  function bfsAvoiding(sx, sy, tx, ty, grid, blockedPositions) {
    if (sx === tx && sy === ty) return null;
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const parent = Array.from({length: H}, () => new Array(W).fill(null));
    const queue = [{x: sx, y: sy}];
    visited[sy][sx] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur.x === tx && cur.y === ty) {
        let step = cur;
        while (parent[step.y][step.x] && !(parent[step.y][step.x].x === sx && parent[step.y][step.x].y === sy)) {
          step = parent[step.y][step.x];
        }
        return step;
      }
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (!isBfsWalkable(ch)) continue;
        // Skip known trap/blocked positions
        if (blockedPositions && blockedPositions.has(nx + ',' + ny)) continue;
        // Skip monsters (but allow target)
        const { MONSTERS } = NH;
        if (MONSTERS.has(ch) && !PET_CHARS.has(ch) && !(nx === tx && ny === ty)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  /**
   * Find nearest food tile from player position.
   * Returns {x, y} or null.
   */
  function findNearestFood(px, py, grid) {
    const features = scanMap(grid);
    if (features.food.length === 0) return null;
    let best = null, bestDist = Infinity;
    for (const f of features.food) {
      const dist = Math.abs(f.x - px) + Math.abs(f.y - py);
      if (dist < bestDist) { bestDist = dist; best = f; }
    }
    return best;
  }

  /**
   * Handle food: navigate to food, pick it up, eat.
   * Returns true if this handler consumed the tick.
   */
  function handleFood(navCtx) {
    const { env, player, grid, tickCount, msgs, stuckCount,
            knownTrapPositions, lastMoveDir } = navCtx;

    const hungerText = env.getHunger();
    const hungerTrimmed = (hungerText || '').trim();
    const isHungry = hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak' ||
                     hungerTrimmed === 'Fainting' || hungerTrimmed === 'Fainted';
    const isFainted = hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting';

    // If fainted, just wait for recovery
    if (isFainted) {
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    const nearestFood = findNearestFood(player.x, player.y, grid);
    const noFood = msgs.some(m => m.includes("don't have anything to eat"));

    // Always pick up food when standing on it or adjacent — don't wait until hungry
    if (nearestFood) {
      const foodDist = Math.abs(nearestFood.x - player.x) + Math.abs(nearestFood.y - player.y);

      // Standing on food — pick it up
      if (foodDist === 0) {
        env.sendKey(','.charCodeAt(0));
        console.log(`[NAV] Picking up food at ${nearestFood.x},${nearestFood.y}`);
        return true;
      }

      // Adjacent to food — step onto it (only if not blocked by pet/trap)
      if (foodDist === 1) {
        const dx = nearestFood.x - player.x;
        const dy = nearestFood.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) =>
          ddx===dx && ddy===dy);
        if (idx >= 0) {
          // Check if target is a pet (pet blocks us from picking up adjacent food)
          const nx = player.x + dx, ny = player.y + dy;
          const nch = (grid[ny]||'')[nx] || ' ';
          if (PET_CHARS.has(nch)) {
            // Pet is on the food — don't override pet avoidance; let other handlers run
            return false;
          }
          navCtx.lastMoveDir = idx;
          env.sendKey(KEY[idx].charCodeAt(0));
          return true;
        }
      }

      // If stuck approaching food, bail out and let other handlers deal with it
      if (stuckCount > 3) {
        return false;
      }

      // If hungry, navigate to food and eat when we get there
      if (isHungry) {
        const blocked = knownTrapPositions || new Set();
        const next = bfsAvoiding(player.x, player.y, nearestFood.x, nearestFood.y, grid, blocked);
        if (next) {
          const idx = DIRS.findIndex(([ddx,ddy]) =>
            ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) {
            console.log(`[NAV] Navigating to food at ${nearestFood.x},${nearestFood.y} (hungry, dist=${foodDist})`);
            navCtx.lastMoveDir = idx;
            env.sendKey(KEY[idx].charCodeAt(0));
            return true;
          }
        }
      }

      // Not hungry but food is nearby (dist <= 5) → navigate to pick it up for later
      if (!isHungry && foodDist <= 5 && stuckCount === 0) {
        const blocked = knownTrapPositions || new Set();
        const next = bfsAvoiding(player.x, player.y, nearestFood.x, nearestFood.y, grid, blocked);
        if (next) {
          const idx = DIRS.findIndex(([ddx,ddy]) =>
            ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) {
            console.log(`[NAV] Approaching food at ${nearestFood.x},${nearestFood.y} for pickup (dist=${foodDist})`);
            navCtx.lastMoveDir = idx;
            env.sendKey(KEY[idx].charCodeAt(0));
            return true;
          }
        }
      }
    }

    // Hungry but no floor food — try eating from inventory
    if (isHungry && !noFood && (tickCount - navCtx.lastEatTick) > 5) {
      navCtx.lastEatTick = tickCount;
      console.log('[NAV] Trying to eat from inventory (hungry)');
      env.sendKey('e'.charCodeAt(0));
      return true;
    }

    // No food at all — reset noFood flag periodically
    if (noFood && (tickCount - navCtx.lastEatTick) > 200) {
      navCtx.lastEatTick = tickCount;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleFood });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleFood } = global.NHNav || {};
