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
   * Sticks to a previously chosen food target until reached or no longer on map.
   * Returns {x, y} or null.
   */
  function findNearestFood(navCtx, px, py, grid) {
    const features = scanMap(grid);
    if (features.food.length === 0) return null;

    // Prefer the sticky food target if it's still reachable on the map
    if (navCtx.foodTarget) {
      const ft = navCtx.foodTarget;
      const stillExists = features.food.some(f => f.x === ft.x && f.y === ft.y);
      if (stillExists) {
        const dist = Math.abs(ft.x - px) + Math.abs(ft.y - py);
        // Only use sticky target if we haven't gotten further from it
        if (dist <= (navCtx.foodTargetDist || Infinity) + 2) {
          return ft;
        }
      }
    }

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
            knownTrapPositions, lastMoveDir, isInCorridor, wallSearchPhase } = navCtx;

    const hungerText = env.getHunger();
    const hungerTrimmed = (hungerText || '').trim();
    const isHungry = hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak' ||
                     hungerTrimmed === 'Fainting' || hungerTrimmed === 'Fainted';
    const isFainting = hungerTrimmed === 'Fainting';
    const isFainted = hungerTrimmed === 'Fainted';

    const nearestFood = findNearestFood(navCtx, player.x, player.y, grid);
    const noFood = msgs.some(m => m.includes("don't have anything to eat"));

    // Detect food at the player's feet from messages.
    // When standing on food (e.g. "You see here a lichen corpse"), the food character
    // is hidden under the player '@' on the map. The food scanner won't see it.
    // But the message buffer tells us it's there — eat it immediately.
    // Also catch pet-drop messages like "The little dog drops a lichen corpse".
    const floorFoodMsg = msgs.some(m => {
      const ml = m.toLowerCase();
      // "You see here ..." — food is on our tile
      if (ml.includes('you see here') &&
          (ml.includes('corpse') || ml.includes('food') ||
           ml.includes('apple') || ml.includes('banana') ||
           ml.includes('carrot') || ml.includes('egg') ||
           ml.includes('lump') || ml.includes('ration') ||
           ml.includes('tripe'))) return true;
      // Pet drops food on our tile: "The little dog drops a lichen corpse"
      if ((ml.includes('drops') || ml.includes('drops a') || ml.includes('drops the')) &&
          (ml.includes('corpse') || ml.includes('food')) &&
          ml.includes('you')) return true; // "drops it at your feet" variant
      return false;
    });

    // Fainting = LAST TICK before unconsciousness. Must eat NOW.
    // No cooldown, no waiting. But don't spam 'e' if we already got "no food" message.
    if (isFainting) {
      if (!navCtx.choked && !noFood) {
        navCtx.lastEatTick = tickCount;
        console.log('[NAV] FAINTING — eating immediately (last chance before unconsciousness)');
        env.sendKey('e'.charCodeAt(0));
        return true;
      }
      // No food available or choked — wait for Fainted state
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // Fainted = unconscious. NetHack ignores all input keys.
    // Send 'e' anyway on the hope that the player JUST recovered this tick,
    // so the eat command processes before the pet re-grabs the food.
    // But only try every few ticks to avoid spamming.
    if (isFainted) {
      if (!navCtx.choked && (tickCount - navCtx.lastEatTick) > 3) {
        navCtx.lastEatTick = tickCount;
        console.log('[NAV] FAINTED — sending eat key in case just recovered');
        env.sendKey('e'.charCodeAt(0));
        return true;
      }
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // Food at our feet (from "You see here a ... corpse" message) — eat it directly.
    // The food char is hidden under the player '@', so the map scanner misses it,
    // but we can still eat from the floor. Only eat when HUNGRY — eating when Satiated
    // triggers the choking mechanic and kills the player.
    // NO eat cooldown for floor food — the food might be picked up by the pet at any
    // moment, so we need to eat immediately when detected.
    if (floorFoodMsg && isHungry && !navCtx.choked) {
      navCtx.lastEatTick = tickCount;
      navCtx.choked = false;
      console.log('[NAV] Eating food at feet (from "You see here" msg)');
      env.sendKey('e'.charCodeAt(0));
      return true;
    }

    // Track sticky food target
    if (nearestFood) {
      navCtx.foodTarget = nearestFood;
      navCtx.foodTargetDist = Math.abs(nearestFood.x - player.x) + Math.abs(nearestFood.y - player.y);
    } else {
      navCtx.foodTarget = null;
      navCtx.foodTargetDist = Infinity;
    }

    // Always pick up food when standing on it or adjacent — don't wait until hungry
    if (nearestFood) {
      const foodDist = Math.abs(nearestFood.x - player.x) + Math.abs(nearestFood.y - player.y);

      // Standing on food — pick it up
      if (foodDist === 0) {
        env.sendKey(','.charCodeAt(0));
        console.log(`[NAV] Picking up food at ${nearestFood.x},${nearestFood.y}`);
        return true;
      }

      // Adjacent to food — step onto it (attempt pet swap if pet is on food)
      if (foodDist === 1) {
        const dx = nearestFood.x - player.x;
        const dy = nearestFood.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) =>
          ddx===dx && ddy===dy);
        if (idx >= 0) {
          navCtx.lastMoveDir = idx;
          env.sendKey(KEY[idx].charCodeAt(0));
          return true;
        }
      }

      // If stuck approaching food, bail out and let other handlers deal with it.
      // BUT: always keep trying when hungry (any dist) or when food is close (dist <= 8).
      // Without these exceptions, the player starves when stuckCount > 3 blocks
      // food navigation and corridor oscillation takes over.
      if (stuckCount > 3 && !(isHungry || foodDist <= 8)) {
        return false;
      }

      // If hungry, navigate to food. When hungry, ignore the door/foodDist tradeoff
      // — starving to death is worse than missing a door. When not hungry, only
      // approach nearby food (dist <= 5) to avoid oscillating far from doors.
      // We DO navigate to food during wall search when hungry — otherwise the
      // pet steals the food before wall search exits on critical hunger.
      const shouldNavigateToFood = isHungry;
      if (shouldNavigateToFood) {
        const blocked = knownTrapPositions || new Set();
        const next = bfsAvoiding(player.x, player.y, nearestFood.x, nearestFood.y, grid, blocked);
        if (next) {
          const stepDx = next.x - player.x;
          const stepDy = next.y - player.y;
          const isDiag = Math.abs(stepDx) === 1 && Math.abs(stepDy) === 1;
          let diagBlocked = false;
          if (isDiag && isInCorridor) {
            diagBlocked = true; // corridor diagonal almost always hits wall corner
          } else if (isDiag) {
            const ch1 = (grid[player.y]||'')[player.x + stepDx] || ' ';
            const ch2 = (grid[player.y + stepDy]||'')[player.x] || ' ';
            if (!isBfsWalkable(ch1) && !isBfsWalkable(ch2)) {
              diagBlocked = true;
            }
          }
          if (!diagBlocked) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===stepDx && ddy===stepDy);
            if (idx >= 0) {
              console.log(`[NAV] Navigating to food at ${nearestFood.x},${nearestFood.y} (hungry, dist=${foodDist})`);
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }

      // Not hungry but food is nearby → navigate to pick it up for later
      // Skip during wall search — escaping the room is more important
      // Skip when in corridor — corridor handler should explore instead
      // Diagonal moves in corridors are usually wall-cornering attempts; only approach in rooms
      const isDiagonalMove = (Math.abs(nearestFood.x - player.x) === 1 &&
                               Math.abs(nearestFood.y - player.y) === 1);
      const shouldApproachFood = (!isHungry && foodDist <= 8 && !navCtx.wallSearchPhase && !isInCorridor) ||
                               (isHungry && foodDist > 8);
      if (shouldApproachFood) {
        const blocked = knownTrapPositions || new Set();
        const next = bfsAvoiding(player.x, player.y, nearestFood.x, nearestFood.y, grid, blocked);
        if (next) {
          // Reject diagonal steps that would go through a wall corner.
          // In corridors (1-tile-wide), diagonal into room wall = wall corner = blocked.
          // Only reject diagonal if one of the cardinal-adjacent tiles is a wall.
          const stepDx = next.x - player.x;
          const stepDy = next.y - player.y;
          const isDiag = Math.abs(stepDx) === 1 && Math.abs(stepDy) === 1;
          if (isDiag && isInCorridor) {
            // In corridor, diagonal almost always hits a wall corner — skip to let corridor handler run
            shouldApproachFood = false;
          } else if (isDiag) {
            // In room, verify both cardinal-adjacent tiles are walkable
            const ch1 = (grid[player.y]||'')[player.x + stepDx] || ' ';
            const ch2 = (grid[player.y + stepDy]||'')[player.x] || ' ';
            if (!isBfsWalkable(ch1) && !isBfsWalkable(ch2)) {
              shouldApproachFood = false;
            }
          }
          if (shouldApproachFood) {
            const idx = DIRS.findIndex(([ddx,ddy]) =>
              ddx===stepDx && ddy===stepDy);
            if (idx >= 0) {
              console.log(`[NAV] Approaching food at ${nearestFood.x},${nearestFood.y} (dist=${foodDist}, hungry=${isHungry})`);
              navCtx.lastMoveDir = idx;
              env.sendKey(KEY[idx].charCodeAt(0));
              return true;
            }
          }
        }
      }
    }

    // Hungry but no floor food — try eating from inventory.
    // Only eat when truly starving (Weak/Fainting), not just mild Hunger.
    // This avoids eating rotten corpses from inventory (which cause sickness).
    const isStarving = hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainting' ||
                       hungerTrimmed === 'Fainted';
    if (isHungry && isStarving && !noFood && (tickCount - navCtx.lastEatTick) > 5) {
      navCtx.lastEatTick = tickCount;
      console.log(`[NAV] Trying to eat from inventory (status=${hungerTrimmed})`);
      env.sendKey('e'.charCodeAt(0));
      return true;
    }

    // Starving with no food at all — try prayer as last resort.
    // In NetHack, praying while starving can produce food from your god.
    // Only try once every ~1000 ticks to avoid angering the god.
    if (isHungry && noFood && !nearestFood && (tickCount - (navCtx.lastPrayTick || -1000)) > 1000) {
      navCtx.lastPrayTick = tickCount;
      // No pendingPray needed — just send the full prayer sequence directly.
      // NetHack extended command: #pray followed by <CR>
      console.log(`[NAV] Starving with no food (hungry="${hungerTrimmed}") — attempting prayer at tick=${tickCount}`);
      env.sendKey('#'.charCodeAt(0));
      env.sendKey('p'.charCodeAt(0));
      env.sendKey('r'.charCodeAt(0));
      env.sendKey('a'.charCodeAt(0));
      env.sendKey('y'.charCodeAt(0));
      env.sendKey(13); // Enter key
      return true;
    }

    // No food on map AND no food in inventory — try to descend to find food.
    // Return false so the stairs handler can run instead of blocking with no-op.
    if (isHungry && noFood && !nearestFood && tickCount > 10) {
      console.log(`[NAV] No food available (hungry="${hungerTrimmed}") — yielding to stairs/corridor handlers`);
      return false;
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
