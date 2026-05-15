/**
 * nav-boulder-pet.mjs — NetHack Navigation AI: Boulder & Pet handling
 *
 * Handles:
 * - Pushing boulders when they block corridor/path navigation
 * - Pet avoidance and blocking resolution
 * - Breaking out of dead-end corridors with boulders
 *
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-boulder-pet.js'); return; }

  const { W, H, DIRS, KEY, MONSTERS, bfs } = NH;

  /**
   * Handle boulder pushing and pet blocking.
   * Returns true if this handler consumed the tick.
   *
   * Call this AFTER movement handlers fail, to handle blocked paths.
   */
  function handleBoulderPet(navCtx) {
    const { env, player, grid, stairs, lowHp, stuckCount, msgs } = navCtx;

    // Track failed boulder pushes from messages
    if (!navCtx.failedBoulders) navCtx.failedBoulders = new Set();
    if (msgs && msgs.some(m => m.includes('in vain'))) {
      for (let di = 0; di < 8; di++) {
        const [dx, dy] = DIRS[di];
        const bx = player.x + dx, by = player.y + dy;
        if (bx >= 0 && bx < W && by >= 0 && by < H && (grid[by]||'')[bx] === '`') {
          const bKey = bx + ',' + by;
          if (!navCtx.failedBoulders.has(bKey)) {
            navCtx.failedBoulders.add(bKey);
            console.log(`[NAV] Boulder push failed at ${bKey}, marking as blocked`);
          }
        }
      }
    }

    // ---- Check for blocking boulders in adjacent tiles ----
    for (let di = 0; di < 8; di++) {
      const [dx, dy] = DIRS[di];
      const bx = player.x + dx, by = player.y + dy;
      if (bx < 0 || bx >= W || by < 0 || by >= H) continue;
      const bch = (grid[by]||'')[bx] || ' ';
      if (bch === '`') {
        const bKey = bx + ',' + by;
        // Skip boulders we've already failed to push
        if (navCtx.failedBoulders && navCtx.failedBoulders.has(bKey)) continue;

        // Boulder here — check if we can push it into adjacent walkable space
        const pushX = bx + dx, pushY = by + dy;
        if (pushX >= 0 && pushX < W && pushY >= 0 && pushY < H) {
          const pushCh = (grid[pushY]||'')[pushX] || ' ';
          // Can push into empty corridor floor or room floor
          if (pushCh === '#' || pushCh === '.' || pushCh === ' ' || pushCh === '>') {
            // Try to push the boulder
            navCtx.lastMoveDir = di;
            env.sendKey(KEY[di].charCodeAt(0));
            return true;
          }
          // Try to kick the boulder (may destroy it or move it)
          // Kick when push target is a wall, another boulder, or any blocking monster/item
          if (pushCh === '|' || pushCh === '-' || pushCh === '`' ||
              MONSTERS.has(pushCh) || (pushCh !== '.' && pushCh !== '#' && pushCh !== ' ' && pushCh !== '>')) {
            if (!navCtx.legInjured) {
              env.sendKey(4); // ^D = kick
              navCtx.pendingKickDir = di;
              return true;
            }
          }
        }
        // Push target is walkable but push might fail (boulder stuck) — track failed attempts
        // Only try pushing if we haven't failed before
        const failKey = bx + ',' + by;
        const failCount = (navCtx.boulderFailCount || {})[failKey] || 0;
        if (failCount < 2) {
          navCtx.boulderFailCount = navCtx.boulderFailCount || {};
          navCtx.boulderFailCount[failKey] = failCount + 1;
          navCtx.lastMoveDir = di;
          env.sendKey(KEY[di].charCodeAt(0));
          return true;
        }
      }
    }

    // ---- Find any boulder in the path to stairs/door target and try to push it ----
    if (!stairs) return false;
    const path = bfsPathToTarget(player.x, player.y, stairs.x, stairs.y, grid);
    if (path && path.length > 0) {
      const next = path[0];
      const nch = (grid[next.y]||'')[next.x] || ' ';
      if (nch === '`') {
        const bKey = next.x + ',' + next.y;
        if (!navCtx.failedBoulders.has(bKey)) {
          // Boulder blocking path to stairs — try to push it
          const dx = next.x - player.x, dy = next.y - player.y;
          const di = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
          if (di >= 0) {
            const pushX = next.x + dx, pushY = next.y + dy;
            if (pushX >= 0 && pushX < W && pushY >= 0 && pushY < H) {
              const pushCh = (grid[pushY]||'')[pushX] || ' ';
              if (pushCh === '#' || pushCh === '.' || pushCh === ' ') {
                navCtx.lastMoveDir = di;
                env.sendKey(KEY[di].charCodeAt(0));
                return true;
              }
            }
          }
        }
      }
    }

    // ---- Check for pet blocking corridor exits ----
    // When stuck with adjacent pet, try to move around it.
    // Skip this in corridors — the corridor handler has dedicated pet-swap
    // logic that works better in 1-tile corridors. This handler's perpendicular
    // fallback just sends '.' in corridors, causing infinite waits.
    // Only react to actual block/refusal messages (not stale successful swaps).
    // hadPetBlock stays true for 30 messages, causing this handler to send '.'
    // for up to 30 ticks after a swap — wasting time and preventing corridor handler
    // from running when the player is in a corridor on subsequent ticks.
    const recentMsgs = navCtx.msgs.slice(-3);
    const petBlockedRecently = recentMsgs.some(m =>
      m.includes('is in the way') || m.includes("doesn't want to swap places")
    );
    if ((petBlockedRecently || navCtx.stuckCount > 5) && !navCtx.isInCorridor) {
      // Find adjacent pet
      let petPos = null;
      for (let di = 0; di < 8; di++) {
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if (MONSTERS.has(nch)) { petPos = {x: nx, y: ny, di}; break; }
      }
      if (petPos) {
        // Try to move around the pet (perpendicular directions)
        const perpDirs = [
          rotateCW(petPos.di), rotateCCW(petPos.di),
          rotateCW(rotateCW(petPos.di)), rotateCCW(rotateCCW(petPos.di))
        ];
        for (const pdi of perpDirs) {
          const [pdx, pdy] = DIRS[pdi];
          const px = player.x + pdx, py = player.y + pdy;
          if (px < 0 || px >= W || py < 0 || py >= H) continue;
          const pch = (grid[py]||'')[px] || ' ';
          if (NH.isWalkable(pch) && !MONSTERS.has(pch) && !navCtx.knownTrapPositions.has(px + ',' + py)) {
            navCtx.lastMoveDir = pdi;
            env.sendKey(KEY[pdi].charCodeAt(0));
            return true;
          }
        }
        // Can't move around — wait a tick
        env.sendKey('.'.charCodeAt(0));
        return true;
      }
    }

    return false;
  }

  // Use NH.isWalkable for consistency

  function rotateCW(di) { return (di + 1) % 8; }
  function rotateCCW(di) { return (di + 7) % 8; }

  // BFS that returns full path (not just first step)
  function bfsPathToTarget(sx, sy, tx, ty, grid) {
    if (sx === tx && sy === ty) return [];
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const parent = Array.from({length: H}, () => new Array(W).fill(null));
    const queue = [{x: sx, y: sy}];
    visited[sy][sx] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur.x === tx && cur.y === ty) {
        const path = [];
        let node = cur;
        while (node && !(node.x === sx && node.y === sy)) {
          path.unshift(node);
          node = parent[node.y][node.x];
        }
        return path;
      }
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (ch === '|' || ch === '-' || ch === ' ') continue;
        // Allow pets in path (they move)
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleBoulderPet });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleBoulderPet } = global.NHNav || {};
