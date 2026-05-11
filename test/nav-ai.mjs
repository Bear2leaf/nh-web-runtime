/**
 * nav-ai.mjs — NetHack Navigation AI: Main loop
 *
 * Entry point: startNavigation(startDlvl, onDone, env)
 *   env: NavEnv adapter (NHBrowserEnv for browser, NHNodeEnv for Node)
 * Depends on window.NHNav (from nav-core.mjs and nav-strategy.mjs).
 *
 * Loop: microtask iteration with input-readiness check.
 */

(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.mjs must be loaded before nav-ai.mjs'); return; }

  const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
          findOnMap, scanMap, bfs, shuffleDirs } = NH;

  // Direction indices: 0=W 1=E 2=N 3=S 4=NW 5=NE 6=SE 7=SW
  const CW_NEXT = [2, 3, 5, 6, 0, 1, 7, 4]; // clockwise turn from each dir
  const CCW_NEXT = [4, 5, 0, 1, 7, 6, 2, 3]; // counter-clockwise turn

  // Use setTimeout(0) in browser to yield to WASM input processing;
  // queueMicrotask in Node for speed.
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const scheduleNext = isBrowser
    ? (fn) => setTimeout(fn, 0)
    : (typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn));

  function startNavigation(startDlvl, onDone, env) {
    console.log('[NAV] startNavigation called, env=' + typeof env);
    if (!env) { if (onDone) onDone('no-env'); return; }

    let tickCount = 0;
    let stuckCount = 0;
    let lastPlayerPos = null;
    let pendingDir = null;
    let pendingKickDir = null;
    let lastEatTick = 0;
    let stopped = false;
    let choked = false;
    let lastStairsPos = null;
    let lastDoorDir = null;
    let doorAttemptCount = 0;
    // Track consecutive corridor navigation failures (declared once, not in block)
    let corridorFailCount = 0;
    let lastCorridorTarget = null;
    // Track corridor visits for oscillation detection
    const corridorVisitCounts = new Map();
    let corridorOscillationTick = 0;
    let lastOscHandlerTick = 0; // Cooldown: don't fire oscillation handler every tick
    let legInjured = false; // Set if "in no shape for kicking" — prevent further kicking
    // Track the last direction moved in a corridor (for forward bias)
    let lastMoveDir = -1;
    // Track last non-corridor position (to avoid immediately going back)
    let lastRoomPos = null;
    // Track whether player was in corridor last tick (persistent across ticks)
    let wasInCorridorLastTick = false;
    // Track last sent direction to detect when the same direction fails repeatedly
    let lastSentDir = -1;
    let sentDirCount = 0;

    // Oscillation detection: track recent positions to detect looping
    const recentPositions = [];
    const MAX_RECENT = 20;
    let enclosedTick = 0;

    // Wall search state
    let wallSearchPhase = false;
    let wallSearchStep = 0;
    let lastSearchTick = 0;
    const searchedWallPos = new Set();
    let searchesAtCurrentPos = 0;
    let lastWallPosKey = null;
    // Wall-following: ordered list of wall-edge positions to visit
    let wallFollowPath = [];
    let wallFollowIdx = 0;
    let wallFollowPasses = 0;
    let wallFollowTargetRetries = 0; // prevent infinite retry on same target

    // Track doors we've tried to open (locked doors)
    const triedDoors = new Set();
    let lastDoorPos = null;
    let doorOpenAttempts = 0;

    // Cooldown after search reveals something (prevents immediate wall-search re-entry)
    let searchCooldownTick = 0;

    // Teleport fallback: how many times we've tried teleporting
    let teleportAttempts = 0;
    let teleportFailed = false; // Set to true if teleport spell is unknown
    const MAX_TELEPORT_ATTEMPTS = 3;

    const MAX_TICKS = 20000;

    function stop(reason) {
      stopped = true;
      if (onDone) onDone(reason);
    }

    // Check if a position is adjacent to a wall, door, or corridor edge
    function isAdjacentToWall(px, py, grid) {
      for (let di = 0; di < 8; di++) {
        const [dx, dy] = DIRS[di];
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ch = (grid[ny]||'')[nx] || ' ';
        if (ch === '|' || ch === '-' || ch === '+' || ch === '#') return true;
      }
      return false;
    }

    // Build a limited perimeter path around the room using right-hand rule.
    // Returns array of {x,y} positions along the wall edge, in visit order.
    // Capped to ~60 positions to avoid spending too many ticks in large rooms.
    function buildWallFollowPath(px, py, grid) {
      // BFS to find all reachable walkable positions adjacent to walls.
      // Uses isBfsWalkable for traversal (allows corridors) to find room perimeter positions.
      const visited = Array.from({length: H}, () => new Uint8Array(W));
      const queue = [{x: px, y: py}];
      visited[py][px] = 1;
      let head = 0;
      const wallAdj = [];
      while (head < queue.length) {
        const cur = queue[head++];
        // Only add ROOM positions that are adjacent to walls (not corridor positions)
        const curCh = (grid[cur.y]||'')[cur.x] || ' ';
        if (curCh !== '#' && isAdjacentToWall(cur.x, cur.y, grid)) {
          wallAdj.push(cur);
        }
        for (const [dx, dy] of DIRS) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (visited[ny][nx]) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (!isBfsWalkable(ch)) continue;
          // Skip monsters (but allow target if it's a monster — we'll attack it)
          if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) continue;
          visited[ny][nx] = 1;
          queue.push({x: nx, y: ny});
        }
      }

      if (wallAdj.length === 0) return [];

      // Sort wall-adjacent positions into perimeter order (clockwise from top-left)
      wallAdj.sort((a, b) => {
        const ay = a.y, by = b.y, ax = a.x, bx = b.x;
        if (ay !== by) return ay - by; // top to bottom
        return ax - bx; // left to right within same row
      });

      // Cap to ~60 positions to avoid spending hundreds of ticks in large rooms
      if (wallAdj.length > 60) {
        // Sample evenly across the perimeter
        const sampled = [];
        const step = Math.floor(wallAdj.length / 60);
        for (let i = 0; i < wallAdj.length; i += step) {
          sampled.push(wallAdj[i]);
        }
        return sampled;
      }

      return wallAdj;
    }

    // Check messages for search results — returns true if something was found
    function checkSearchResults(msgs) {
      return msgs.some(m =>
        m.includes('find a hidden door') || m.includes('find a hidden passage') ||
        m.includes('find a staircase') || m.includes('find a secret door') ||
        m.includes('You find a') || m.includes('find a secret corridor')
      );
    }

    // Try to teleport: ^T (Ctrl+T = char code 20)
    // Returns true if teleport was sent
    function tryTeleport() {
      if (teleportAttempts >= MAX_TELEPORT_ATTEMPTS) return false;
      if (teleportFailed) return false;
      teleportAttempts++;
      console.log(`[NAV] Attempting teleport (${teleportAttempts}/${MAX_TELEPORT_ATTEMPTS})`);
      env.sendKey(20); // ^T
      return true;
    }

    // Detect if player is stuck in a corridor dead-end
    // Returns exit direction index if in dead-end, or -1 if not
    function isInDeadEnd(px, py, grid) {
      const ch = (grid[py]||'')[px] || ' ';
      if (ch !== '#') return -1; // Only check corridors
      let walkableDirs = 0;
      let exitDir = -1;
      for (let di = 0; di < 8; di++) {
        const [dx, dy] = DIRS[di];
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if (isWalkable(nch) && !MONSTERS.has(nch)) {
          walkableDirs++;
          exitDir = di;
        }
      }
      // Dead end = 1 walkable direction (can only go back)
      return walkableDirs <= 1 ? exitDir : -1;
    }

    function step() {
      if (stopped) return false;
      tickCount++;
      if (tickCount <= 3) console.log('[NAV] step() tick=' + tickCount);

      // ---- Pending direction keys ----
      if (pendingDir !== null) {
        const dir = pendingDir;
        pendingDir = null;
        env.sendKey(KEY[dir].charCodeAt(0));
        return true;
      }
      if (pendingKickDir !== null) {
        const dir = pendingKickDir;
        pendingKickDir = null;
        env.sendKey(KEY[dir].charCodeAt(0));
        return true;
      }

      // ---- Win / lose checks ----
      if (env.getDlvl() !== startDlvl) { stop('descended'); return false; }
      if (env.getHp() === 0) { stop('died'); return false; }
      if (env.isGameDone && env.isGameDone()) { stop('game-ended'); return false; }

      // ---- Modal handling ----
      if (env.isYnVisible()) {
        const ynText = env.getYnText();
        if (ynText.includes('possessions identified') || ynText.includes('identified?')) {
          stop('died'); return false;
        }
        if (ynText.toLowerCase().includes('direction')) {
          if (pendingDir !== null) {
            env.sendKey(KEY[pendingDir].charCodeAt(0));
            pendingDir = null;
          } else if (pendingKickDir !== null) {
            env.sendKey(KEY[pendingKickDir].charCodeAt(0));
            pendingKickDir = null;
          } else {
            // No pending direction — cancel
            env.sendKey(27);
          }
          return true;
        }
        // Teleport confirmation: "To what position?" or similar
        if (ynText.toLowerCase().includes('teleport') || ynText.toLowerCase().includes('where')) {
          // Just accept the default/random destination
          env.sendKey('y'.charCodeAt(0));
          return true;
        }
        if (!env.clickYnButton()) env.sendKey(121);
        return true;
      }

      if (env.isMenuVisible()) {
        const menuText = env.getMenuText();
        const itemMatch = menuText.match(/\[([a-z])(?:-([a-z]))?\s*(?:or\s+)?\?\*\]/);
        if (itemMatch) { env.sendKey(itemMatch[1].charCodeAt(0)); }
        else if (menuText.includes('Really') || menuText.includes('Really?')) { env.sendKey('y'.charCodeAt(0)); }
        else if (menuText.includes('eat') || menuText.includes('Eat') ||
                 menuText.includes('drink') || menuText.includes('read') ||
                 menuText.includes('What do you want')) { env.sendKey('a'.charCodeAt(0)); }
        else { env.sendKey(27); }
        return true;
      }

      // ---- Read the map ----
      const grid = env.getMap();
      if (!grid || grid.length === 0) { env.sendKey('.'.charCodeAt(0)); return true; }
      let { player, stairs, food } = findOnMap(grid);
      const msgs = env.getRecentMessages(15);
      if (!player) { env.sendKey('.'.charCodeAt(0)); return true; }

      // Detect leg injury (can't kick anymore)
      if (msgs.some(m => m.includes('in no shape for kicking'))) {
        legInjured = true;
      }

      // Scan features once and cache — used by multiple sections below
      let features = scanMap(grid);

      // Early corridor detection (needed for monster handling and corridor navigation)
      // Player '@' overwrites the underlying tile, so infer corridor status from cardinal neighbors
      const playerCh = (grid[player.y]||'')[player.x] || ' ';
      let cardCorridorCount = 0;
      let cardFloorCount = 0;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const nx = player.x + dx, ny = player.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if (nch === '#') cardCorridorCount++;
        if (nch === '.' || nch === '<' || nch === '>' || nch === '%') cardFloorCount++;
      }
      const isInCorridor = playerCh === '#' || (cardCorridorCount >= 2 && cardFloorCount === 0);

      // ---- Check for visible corridors on map ----
      const hasVisibleCorridors = (() => {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if ((grid[y]||'')[x] === '#') return true;
          }
        }
        return false;
      })();

      // ---- Level search timeout: trigger wall search if exploring too long without stairs ----
      const _noStairsOrDoors = !stairs && features.doors.length === 0;
      const _levelSearchTimeout = tickCount > 800 && _noStairsOrDoors;
      if (_levelSearchTimeout && !wallSearchPhase) {
        wallFollowPath = buildWallFollowPath(player.x, player.y, grid);
        wallFollowIdx = 0;
        wallSearchPhase = true;
        wallFollowPasses = 0;
        wallSearchStep = 0;
        console.log(`[NAV] Level search timeout at tick ${tickCount}: ${wallFollowPath.length} perimeter positions`);
      }
      // In corridor with no stairs: try teleport only if stuck for a while
      if (isInCorridor && stuckCount > 80 && _noStairsOrDoors && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        console.log(`[NAV] Stuck in corridor for ${stuckCount} ticks, teleporting`);
        if (tryTeleport()) return true;
      }

      // Track corridor/room transitions
      const wasInCorridor = wasInCorridorLastTick;
      wasInCorridorLastTick = isInCorridor;
      if (isInCorridor && !wasInCorridor) {
        // Just entered corridor from a room
        lastRoomPos = lastPlayerPos ? { ...lastPlayerPos } : null;
      }
      if (!isInCorridor && wasInCorridor) {
        // Just left corridor, entered a new room
        lastMoveDir = -1; // Reset corridor direction when entering a new room
      }

      // Detect pet blocking from recent messages (for 'd' canines etc.)
      const hadPetBlock = msgs.some(m => m.includes('is in the way') || m.includes('swap places with'));

      // ---- Adjacent monster handling (HIGHEST priority after eat/faint) ----
      {
        // Check all 8 directions for adjacent hostile monsters
        // Use direct grid check instead of findNearestMonster for reliability
        let adjHostile = null;
        for (let di = 0; di < 8; di++) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          // Monster characters that aren't in PET_CHARS are hostile
          if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) {
            // 'd' (canine) can be pet dog or hostile fox — skip if recent messages indicate it's our pet
            if (ch === 'd' && hadPetBlock) continue;
            adjHostile = { x: nx, y: ny, ch, di };
            break;
          }
        }
        if (adjHostile) {
          const dx = adjHostile.x - player.x;
          const dy = adjHostile.y - player.y;
          const _mhp = env.getMaxHp() || 1;
          const _chp = env.getHp();
          const _lowHp = _chp / _mhp < 0.5;
          if (_lowHp) {
            // Low HP: try to flee from monster (in room or corridor)
            const fleeDirs = shuffleDirs();
            for (const fi of fleeDirs) {
              const [fdx, fdy] = DIRS[fi];
              if (fdx * dx + fdy * dy >= 0) continue; // move AWAY from monster
              const nx = player.x + fdx, ny = player.y + fdy;
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                const ch = (grid[ny]||'')[nx] || ' ';
                if (isWalkable(ch) && !MONSTERS.has(ch)) { env.sendKey(KEY[fi].charCodeAt(0)); return true; }
              }
            }
          }
          // Fight the monster — attack in its direction
          const fightIdx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
          if (fightIdx >= 0) { env.sendKey(KEY[fightIdx].charCodeAt(0)); return true; }
        }
      }

      // ---- Track recent positions for oscillation detection ----
      recentPositions.push({x: player.x, y: player.y});
      if (recentPositions.length > MAX_RECENT) recentPositions.shift();

      // ---- Track corridor visits for oscillation detection ----
      if (isInCorridor) {
        const cKey = player.x + ',' + player.y;
        corridorVisitCounts.set(cKey, (corridorVisitCounts.get(cKey) || 0) + 1);
        corridorOscillationTick++;
      } else {
        // Reset corridor tracking when leaving corridor
        corridorVisitCounts.clear();
        corridorOscillationTick = 0;
      }

      // ---- Read HP / hunger ----
      const currentHp = env.getHp();
      const maxHp = env.getMaxHp();
      const hungerText = env.getHunger();
      const hpRatio = maxHp > 0 ? currentHp / maxHp : 1;
      const lowHp = hpRatio < 0.5; // flee/avoid combat when HP < 50%
      const fightHp = hpRatio >= 0.5; // fight only when HP >= 50%
      const hungerTrimmed = (hungerText || '').trim();
      // Detect hunger from status field (values include "Hungry  ", "Weak    ", "Fainted ")
      const isHungry = hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting';
      // Also check messages for more reliable detection
      const hungerFromMsgs = msgs.some(m =>
        m.toLowerCase().includes('hungry') || m.toLowerCase().includes('weak') ||
        m.toLowerCase().includes('faint') || m.toLowerCase().includes('starving')
      );
      const isHungryCombined = isHungry || hungerFromMsgs;
      // Debug: log hunger state every 200 ticks
      if (tickCount % 200 === 0) console.log(`[NAV-DEBUG] hunger="${hungerTrimmed}" isHungry=${isHungry} fromMsgs=${hungerFromMsgs} combined=${isHungryCombined}`);
      const noFood = msgs.some(m => m.includes("don't have anything to eat"));
      // Detect teleport failure — player doesn't have teleport ability
      if (msgs.some(m => m.includes("don't know that spell") || m.includes("You can't teleport"))) {
        if (!teleportFailed) {
          teleportFailed = true;
          console.log('[NAV] Teleport failed — player lacks teleport ability, disabling future attempts');
        }
      }
      const justChoked = msgs.some(m => m.includes('choke') || m.includes('choking'));
      if (justChoked) choked = true;

      // ---- Periodic debug ----
      if (tickCount % 50 === 0) {
        const feat = scanMap(grid);
        const chars = new Set();
        for (let y = Math.max(0, player.y - 5); y < Math.min(H, player.y + 6); y++) {
          for (let x = Math.max(0, player.x - 10); x < Math.min(W, player.x + 11); x++) {
            const ch = (grid[y]||'')[x] || ' ';
            if (ch !== ' ') chars.add(`'${ch}'@${x},${y}`);
          }
        }
        console.log(`[NAV] tick=${tickCount} stuck=${stuckCount} enclosed=${enclosedTick} wallSearch=${wallSearchPhase} wfIdx=${wallFollowIdx}/${wallFollowPath.length} teleports=${teleportAttempts} pos=${player.x},${player.y} stairs=${!!stairs} doors=${feat.doors.length} chars=${[...chars].join(',')}`);
      }

      // ---- Stuck detection (no position change) ----
      const moved = !lastPlayerPos || player.x !== lastPlayerPos.x || player.y !== lastPlayerPos.y;
      if (moved) { stuckCount = 0; doorAttemptCount = 0; }
      else if (!wallSearchPhase) { stuckCount++; } // Don't count search ticks as stuck
      lastPlayerPos = { ...player };
      if (stuckCount > 1500) { stop('stuck'); return false; }

      // ---- Stuck recovery: same direction failing, or hidden prompt blocking ----
      if (stuckCount > 20 && (stuckCount % 20 === 0)) {
        console.log(`[NAV] Stuck recovery: sending ESC at tick=${tickCount} stuck=${stuckCount}`);
        env.sendKey(27); return true;
      }
      if (stuckCount > 40 && !isInCorridor) {
        console.log(`[NAV] Stuck in room, searching for hidden doors at tick=${tickCount}`);
        lastSearchTick = tickCount;
        env.sendKey('s'.charCodeAt(0)); return true;
      }
      // If same direction keeps failing, force a different one
      if (lastMoveDir >= 0 && lastMoveDir === lastSentDir) {
        sentDirCount++;
      } else {
        sentDirCount = 0;
      }
      lastSentDir = lastMoveDir;
      const forcedDirChange = sentDirCount > 3 && lastMoveDir >= 0;

      // ---- Fainted: unconscious, can't act. Just advance time until recovery ----
      if (hungerTrimmed === 'Fainted') {
        env.sendKey('.'.charCodeAt(0));
        return true;
      }

      // ---- Eat when hungry/weak/fainting (starvation is worse than rotten food) ----
      const isWeak = hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainting';
      const eatCooldown = isWeak ? 5 : 20; // Eat faster when weak/fainting
      if (isHungryCombined && !noFood && !choked && (tickCount - lastEatTick) > eatCooldown) {
        lastEatTick = tickCount; choked = false;
        env.sendKey('e'.charCodeAt(0)); return true;
      }
      if (!justChoked && choked && (tickCount - lastEatTick) > 200) { choked = false; } // Wait longer after choking

      // ---- Check search results from last tick ----
      if (lastSearchTick > 0 && tickCount === lastSearchTick + 1) {
        const foundSomething = checkSearchResults(msgs);
        if (foundSomething) {
          console.log(`[NAV] Search revealed something! msgs=${JSON.stringify(msgs.filter(m => m.includes('find')))}`);
          // Reset wall search — the map has changed, re-scan from scratch
          wallSearchPhase = false;
          enclosedTick = 0;
          wallFollowPath = [];
          wallFollowIdx = 0;
          searchedWallPos.clear();
          // Re-scan the map to pick up revealed features immediately
          const freshFeatures = scanMap(grid);
          if (freshFeatures.doors.length > 0) {
            console.log(`[NAV] ${freshFeatures.doors.length} doors now visible after search!`);
          }
          if (freshFeatures.stairsDown.length > 0) {
            console.log(`[NAV] Stairs down discovered after search!`);
          }
          // Set cooldown to prevent immediate re-entry into wall-search
          searchCooldownTick = tickCount;
          // Re-read stairs position since search may have revealed them
          const freshMap = findOnMap(grid);
          if (freshMap.stairs && !stairs) {
            stairs = freshMap.stairs;
            console.log(`[NAV] Stairs found at ${freshMap.stairs.x},${freshMap.stairs.y} after search`);
          }
          // Fall through to re-read the map and navigate to the new feature
        }
        lastSearchTick = 0;
      }

      // ---- Stairs navigation (highest priority) ----
      if (stairs) {
        lastStairsPos = { x: stairs.x, y: stairs.y };
        if (player.x === stairs.x && player.y === stairs.y) {
          env.sendKey(62); return true; // '>'
        }
        const next = bfs(player.x, player.y, stairs.x, stairs.y, grid);
        if (next) {
          // We have a path to stairs
          wallSearchPhase = false;
          enclosedTick = 0;
          const nextCh = (grid[next.y]||'')[next.x] || ' ';
          if (nextCh === '+') {
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            return true;
          }
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        } else {
          // BFS to stairs failed — try to open doors that might be blocking the path
          // Find doors that are roughly in the direction of the stairs
          const dx = stairs.x - player.x, dy = stairs.y - player.y;
          const blockingDoors = features.doors.filter(d => {
            // Door is roughly between player and stairs
            const doorDx = d.x - player.x, doorDy = d.y - player.y;
            return (Math.sign(doorDx) === Math.sign(dx) || doorDx === 0) &&
                   (Math.sign(doorDy) === Math.sign(dy) || doorDy === 0);
          });
          if (blockingDoors.length > 0) {
            // Try the closest blocking door
            let bestDoor = null, bestDist = Infinity;
            for (const door of blockingDoors) {
              const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
              if (dist < bestDist) { bestDist = dist; bestDoor = door; }
            }
            const ddx = bestDoor.x - player.x, ddy = bestDoor.y - player.y;
            if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
              // Adjacent — open it
              env.sendKey('o'.charCodeAt(0));
              pendingDir = DIRS.findIndex(([dx2,dy2]) => dx2===ddx && dy2===ddy);
              return true;
            }
            // Navigate to the door
            const doorNext = bfs(player.x, player.y, bestDoor.x, bestDoor.y, grid);
            if (doorNext) {
              const idx = DIRS.findIndex(([ddx2,ddy2]) => ddx2===(doorNext.x-player.x) && ddy2===(doorNext.y-player.y));
              if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
            }
          }
          // Can't reach stairs and no obvious blocking door — fall through to corridor exploration
        }
      }
      // Stairs may have been visible before but not now (monster on top?)
      if (lastStairsPos && player.x === lastStairsPos.x && player.y === lastStairsPos.y) {
        env.sendKey(62); return true;
      }

      // ---- Door navigation ----
      const untriedDoors = features.doors.filter(d => !triedDoors.has(d.x + ',' + d.y));
      if (untriedDoors.length > 0) {
        let bestDoor = null, bestNext = null, bestDist = Infinity;
        for (const door of untriedDoors) {
          const ddx = door.x - player.x, ddy = door.y - player.y;
          if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
            const doorKey = door.x + ',' + door.y;
            if (lastDoorPos === doorKey) {
              doorOpenAttempts++;
            } else {
              lastDoorPos = doorKey;
              doorOpenAttempts = 1;
            }
            if (doorOpenAttempts > 2) {
              triedDoors.add(doorKey); // Mark as tried so we move on
              doorOpenAttempts = 0;
              lastDoorPos = null;
              if (legInjured) {
                console.log(`[NAV] Door at ${doorKey} is locked, leg injured — giving up`);
                // Fall through to try other navigation instead of kicking
              } else {
                console.log(`[NAV] Door at ${doorKey} seems locked, kicking`);
                env.sendKey(4); // ^D = kick
                pendingKickDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
                return true;
              }
            }
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
            return true;
          }
          const next = bfs(player.x, player.y, door.x, door.y, grid);
          if (next) {
            const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
            if (dist < bestDist) { bestDist = dist; bestDoor = door; bestNext = next; }
          }
        }
        if (bestNext) {
          // Only cancel wall search when we actually have a path to the door
          wallSearchPhase = false;
          enclosedTick = 0;
          const nextCh = (grid[bestNext.y]||'')[bestNext.x] || ' ';
          if (nextCh === '+') {
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
            return true;
          }
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
        // BFS to door failed — do NOT reset wallSearchPhase; fall through to wall-search
      }

      // ---- Corridor/exit navigation (highest priority after doors/stairs) ----
      // Skip if wall search is active — wall search takes priority for exploring hidden paths

      // ---- Corridor dead-end detection: backtrack or teleport ----
      const deadEndExit = isInDeadEnd(player.x, player.y, grid);
      if (deadEndExit >= 0 && stuckCount > 10) {
        console.log(`[NAV] Dead-end corridor detected at ${player.x},${player.y}, exit dir=${deadEndExit}`);
        const [edx, edy] = DIRS[deadEndExit];
        const enx = player.x + edx, eny = player.y + edy;
        if (enx >= 0 && enx < W && eny >= 0 && eny < H) {
          const ech = (grid[eny]||'')[enx] || ' ';
          if (isWalkable(ech) && !MONSTERS.has(ech)) {
            env.sendKey(KEY[deadEndExit].charCodeAt(0));
            return true;
          }
        }
        if (teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
          if (tryTeleport()) return true;
        }
      }
      // Stuck in corridor for too long with no progress — teleport
      if (isInCorridor && stuckCount > 100 && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        console.log(`[NAV] Stuck in corridor for ${stuckCount} ticks, trying teleport`);
        if (tryTeleport()) return true;
      }

      let nearestRoomEntrance = null, roomEntranceDist = Infinity;
      if (!wallSearchPhase) {
        // ---- Room-to-corridor navigation: only when NOT in a corridor ----
        if (!isInCorridor) {
          // Skip corridor navigation after retreating from corridor oscillation.
          // But allow if no stairs/doors found (wall search failed, corridors are last resort).
          const noRoomExit = !stairs && features.doors.length === 0;
          if (corridorFailCount === 0 || noRoomExit) {
            // First try: find floor tiles adjacent to corridors (room exits)
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                const ch = (grid[y]||'')[x] || ' ';
                const isFloor = (ch === '.' || ch === '<' || ch === '>' || ch === '%' ||
                                (ch !== ' ' && ch !== '#' && ch !== '|' && ch !== '-' && ch !== '+' && ch !== '`'));
                if (isFloor) {
                  let adjacentToCorridor = false;
                  for (const [dx, dy] of DIRS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                      if ((grid[ny]||'')[nx] === '#') { adjacentToCorridor = true; break; }
                    }
                  }
                  if (adjacentToCorridor) {
                    const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
                    if (dist > 0 && dist < roomEntranceDist) {
                      roomEntranceDist = dist;
                      nearestRoomEntrance = { x, y };
                    }
                  }
                }
              }
            }

            // If found a room exit, navigate to it
            if (nearestRoomEntrance) {
              const next = bfs(player.x, player.y, nearestRoomEntrance.x, nearestRoomEntrance.y, grid);
              if (next) {
                enclosedTick = 0;
                corridorFailCount = 0;
                let idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                if (forcedDirChange && idx === lastSentDir) {
                  // Same direction keeps failing — try another walkable direction
                  const alt = shuffleDirs().find(di => {
                    const [dx, dy] = DIRS[di];
                    const nx = player.x + dx, ny = player.y + dy;
                    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
                    const ch = (grid[ny]||'')[nx] || ' ';
                    return isWalkable(ch) && !PET_CHARS.has(ch) && di !== lastSentDir;
                  });
                  if (alt !== undefined) idx = alt;
                }
                if (idx >= 0) {
                  lastMoveDir = idx;
                  env.sendKey(KEY[idx].charCodeAt(0)); return true;
                }
              }
            }

            // No room exit found — try to BFS directly to a corridor tile
            let bestCorridor = null, bestCorridorDist = Infinity;
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                if ((grid[y]||'')[x] !== '#') continue;
                const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
                if (dist > 0 && dist < bestCorridorDist) {
                  bestCorridorDist = dist;
                  bestCorridor = { x, y };
                }
              }
            }
            if (bestCorridor) {
              const next = bfs(player.x, player.y, bestCorridor.x, bestCorridor.y, grid);
              if (next) {
                enclosedTick = 0;
                corridorFailCount = 0;
                const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                if (idx >= 0) {
                  lastMoveDir = idx;
                  env.sendKey(KEY[idx].charCodeAt(0)); return true;
                }
              }
            }
          } // end if (corridorFailCount === 0)
        } // end if (!isInCorridor)

        // ---- Corridor following: explore corridors systematically ----
        // Active when in a corridor — continue deeper, avoid going back.
        if (isInCorridor) {
          // ---- Corridor oscillation detection & forced retreat ----
          // Detect oscillation FIRST so we can break the loop before scoring directions.
          const cKey = player.x + ',' + player.y;
          const revisits = corridorVisitCounts.get(cKey) || 0;
          let corridorOsc = false;
          if (recentPositions.length >= 8) {
            const posSet = new Set();
            for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
            if (posSet.size <= 4) corridorOsc = true;
          }
          const overVisited = revisits >= 3;
          // Trigger retreat earlier — don't wait for AI to die
          if (corridorOsc || overVisited || corridorOscillationTick > 30) {
            // Cooldown: only handle oscillation every 5 ticks to avoid flooding with same commands
            if (tickCount - lastOscHandlerTick < 5) {
              // Still in cooldown — just wait for pet to move
              if (hadPetBlock) { env.sendKey('.'.charCodeAt(0)); return true; }
              // Not pet-related — do minimal movement
              env.sendKey('.'.charCodeAt(0)); return true;
            }
            lastOscHandlerTick = tickCount;
            console.log(`[NAV] Corridor oscillation detected: revisits=${revisits} oscTick=${corridorOscillationTick} stuck=${stuckCount} hadPet=${hadPetBlock}`);

            // Pet blocking corridor — try to swap places or retreat past the pet
            if (hadPetBlock) {
              // Find the nearest pet and try to swap places (NetHack allows this)
              let nearestPet = null, nearestPetDist = Infinity;
              for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                  const ch = (grid[y]||'')[x] || ' ';
                  if (PET_CHARS.has(ch)) {
                    const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
                    if (dist <= 2 && dist < nearestPetDist) { nearestPetDist = dist; nearestPet = {x, y}; }
                  }
                }
              }
              if (nearestPet) {
                const pdx = nearestPet.x - player.x, pdy = nearestPet.y - player.y;
                const pidx = DIRS.findIndex(([dx,dy]) => dx===pdx && dy===pdy);
                if (pidx >= 0) {
                  console.log(`[NAV] Pet blocking at ${nearestPet.x},${nearestPet.y}, swapping places (dir=${pidx})`);
                  env.sendKey(KEY[pidx].charCodeAt(0));
                  return true;
                }
              }
              // If can't find pet to swap, fall through to retreat logic
            }

            // First option: try teleport if available
            if (teleportAttempts < MAX_TELEPORT_ATTEMPTS && (stuckCount > 10 || corridorOscillationTick > 30)) {
              if (tryTeleport()) {
                corridorVisitCounts.clear();
                corridorOscillationTick = 0;
                return true;
              }
            }

            // Second option: force retreat to nearest room floor tile (away from pet)
            let nearestRoom = null, roomDist = Infinity;
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                const ch = (grid[y]||'')[x] || ' ';
                if (ch === '.' || ch === '>' || ch === '<') {
                  const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
                  if (dist > 0 && dist < roomDist) {
                    roomDist = dist;
                    nearestRoom = { x, y };
                  }
                }
              }
            }
            if (nearestRoom) {
              const next = bfs(player.x, player.y, nearestRoom.x, nearestRoom.y, grid);
              if (next) {
                // Avoid stepping onto pet/monster tile if possible
                const nextCh = (grid[next.y]||'')[next.x] || ' ';
                const safeRetreat = !PET_CHARS.has(nextCh) && !(nextCh === 'd' && hadPetBlock);
                if (safeRetreat) {
                  const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                  if (idx >= 0) {
                    console.log(`[NAV] Retreating from corridor to room at ${nearestRoom.x},${nearestRoom.y} via dir ${idx}`);
                    // Clear corridor tracking — we're escaping
                    corridorVisitCounts.clear();
                    corridorOscillationTick = 0;
                    corridorFailCount++;
                    // Boost enclosedTick so wall search triggers quickly after room entry
                    enclosedTick = corridorFailCount >= 2 ? 200 : 150;
                    lastMoveDir = idx;
                    env.sendKey(KEY[idx].charCodeAt(0));
                    return true;
                  }
                }
              }
            }

            // Third option: search current position for hidden door/passage
            if (isAdjacentToWall(player.x, player.y, grid) && !searchedWallPos.has(cKey)) {
              searchedWallPos.add(cKey);
              console.log(`[NAV] Search-from-corridor at ${cKey} (oscillation fallback)`);
              lastSearchTick = tickCount;
              env.sendKey('s'.charCodeAt(0));
              return true;
            }
          }

          // Check if we should search from corridor (adjacent to wall, no progress)
          if (stuckCount > 30 && isAdjacentToWall(player.x, player.y, grid)) {
            // Try searching for hidden doors from corridor
            const curKey = player.x + ',' + player.y;
            if (!searchedWallPos.has(curKey)) {
              searchedWallPos.add(curKey);
              console.log(`[NAV] Searching from corridor at ${curKey}`);
              lastSearchTick = tickCount;
              env.sendKey('s'.charCodeAt(0));
              return true;
            }
          }

          // Score each direction: prefer continuing forward, avoid recent positions
          let bestCorridorDir = -1, bestCorridorScore = -Infinity;
          for (let di = 0; di < 8; di++) {
            const [dx, dy] = DIRS[di];
            const nx = player.x + dx, ny = player.y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nch = (grid[ny]||'')[nx] || ' ';
            // Block walls, doors, unseen tiles, and boulders
            if (nch === '|' || nch === '-' || nch === '+' || nch === ' ' || nch === '`') continue;
            // Avoid hostile monsters when low HP
            if (MONSTERS.has(nch) && !PET_CHARS.has(nch) && (nch !== 'd' || !hadPetBlock) && lowHp) continue;
            // Heavy penalty for recently visited positions (prevent oscillation)
            let recentPenalty = 0;
            for (let i = recentPositions.length - 1; i >= Math.max(0, recentPositions.length - 12); i--) {
              const rp = recentPositions[i];
              if (rp.x === nx && rp.y === ny) recentPenalty += 5;
            }
            // Skip pet tiles entirely if we've been stuck (they cause swap oscillations)
            if (PET_CHARS.has(nch) || (nch === 'd' && hadPetBlock)) {
              if (stuckCount > 10) continue;
              recentPenalty += 20;
            }
            // Tile scoring: stairs down >> new room >> corridor
            let tileBonus = 0;
            if (nch === '>') tileBonus = 100;      // Stairs down: highest priority
            else if (nch === '%') tileBonus = 15;   // Food: worth picking up
            else if (nch === '.') tileBonus = 10;    // Room: explore to find stairs
            else if (nch === '<') tileBonus = 2;     // Stairs up: very low priority
            else if (nch === '#') tileBonus = 1;     // Continue in corridor
            // Pets and other walkable chars on floor tiles get small bonus
            else if (PET_CHARS.has(nch)) tileBonus = 2;

            // Forward bonus: prefer continuing in the same direction
            // Reduce forward bias when no stairs found to avoid deep unproductive corridors
            const forwardBonus = stairs ? 6 : 3;
            if (lastMoveDir >= 0 && di === lastMoveDir) tileBonus += forwardBonus;

            // Count corridor tiles ahead (prefer straight corridors)
            let corridorAhead = 0;
            let monsterAhead = 0;
            for (let step = 1; step <= 8; step++) {
              const ax = player.x + dx * step, ay = player.y + dy * step;
              if (ax < 0 || ax >= W || ay < 0 || ay >= H) break;
              const ach = (grid[ay]||'')[ax] || ' ';
              if (ach === '#') { corridorAhead++; continue; }
              // Monster ahead = danger when HP is low
              if (MONSTERS.has(ach) && !PET_CHARS.has(ach) && ach !== 'd' && lowHp) monsterAhead++;
              break;
            }
            const score = tileBonus + corridorAhead * 3 - recentPenalty - monsterAhead * 15;
            // If forced direction change, penalize the stuck direction
            if (forcedDirChange && di === lastSentDir) {
              continue; // skip the direction that's been failing
            }
            if (score > bestCorridorScore) { bestCorridorScore = score; bestCorridorDir = di; }
          }
          if (bestCorridorDir >= 0) {
            lastMoveDir = bestCorridorDir;
            env.sendKey(KEY[bestCorridorDir].charCodeAt(0));
            return true;
          }
          // All directions blocked by forcedDirChange — try any walkable direction instead
          if (forcedDirChange) {
            const shuffled = shuffleDirs();
            for (const di of shuffled) {
              if (di === lastSentDir) continue;
              const [dx, dy] = DIRS[di];
              const nx = player.x + dx, ny = player.y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const ch = (grid[ny]||'')[nx] || ' ';
              if (isWalkable(ch) && !PET_CHARS.has(ch)) {
                lastMoveDir = di;
                env.sendKey(KEY[di].charCodeAt(0)); return true;
              }
            }
          }
          // All corridor directions exhausted — backtrack to nearest room
          let nearestFloor = null, floorDist = Infinity;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const ch = (grid[y]||'')[x] || ' ';
              if (ch === '.' || ch === '>' || ch === '<') {
                const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
                if (dist > 0 && dist < floorDist) {
                  floorDist = dist;
                  nearestFloor = { x, y };
                }
              }
            }
          }
          if (nearestFloor) {
            const next = bfs(player.x, player.y, nearestFloor.x, nearestFloor.y, grid);
            if (next) {
              const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
              if (idx >= 0) {
                lastMoveDir = idx;
                env.sendKey(KEY[idx].charCodeAt(0)); return true;
              }
            }
          }
        }
      } // end if (!wallSearchPhase)

      // (Monster handling moved to top of step() for immediate response)

      // ---- Oscillation detection (independent of enclosure) ----
      let isOscillating = false;
      if (recentPositions.length >= 8) {
        const posSet = new Set();
        for (const p of recentPositions) posSet.add(p.x + ',' + p.y);
        // Strict: oscillating if barely moving (≤4 unique positions in last 8+ moves)
        if (posSet.size <= 4) isOscillating = true;
      }

      // ---- Enclosed room detection & hidden door search ----
      // Don't count as enclosed if surrounded by corridors (player can explore further)
      const isSurroundedByCorridors = (() => {
        let corridorCount = 0, wallCount = 0;
        for (const [dx, dy] of DIRS) {
          const nx = player.x + dx, ny = player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (ch === '#') corridorCount++;
          if (ch === '|' || ch === '-') wallCount++;
        }
        return corridorCount > 0 && wallCount === 0;
      })();
      // After a successful search, wait a few ticks for the map to update before re-checking enclosure
      // This prevents re-entering wall-search immediately after finding a hidden door
      const recentSearchCooldown = searchCooldownTick > 0 && tickCount - searchCooldownTick <= 10;
      // Enclosed = no stairs, no doors, not in corridor, and has visible corridors to explore
      const noStairsOrDoors = !stairs && features.doors.length === 0;
      // Level search timeout: trigger wall search after exploring long enough
      const levelSearchTimeout = tickCount > 800 && noStairsOrDoors;
      if (tickCount % 100 === 0) console.log(`[NAV-DEBUG] levelSearchTimeout=${levelSearchTimeout} noStairsOrDoors=${noStairsOrDoors} stairs=${!!stairs} doors=${features.doors.length} hasCorridors=${hasVisibleCorridors} wallSearch=${wallSearchPhase}`);
      const isEnclosed = noStairsOrDoors && !isSurroundedByCorridors && !recentSearchCooldown && !isInCorridor;
      if (isEnclosed) {
        enclosedTick++;
      } else if (isOscillating && !isInCorridor && !isSurroundedByCorridors) {
        // Oscillating in room (not corridor) counts as pseudo-enclosed
        enclosedTick += 0.5;
      } else if (!wallSearchPhase) {
        // Only reset enclosed tracking if we're not actively in wall-search
        enclosedTick = 0;
      }

      // Start wall search if enclosed, oscillating, or level search timeout
      // After corridor retreat: enclosedTick is boosted to 150-200, so wall search starts immediately
      // Still don't start wall search from within a corridor — retreat to room first
      if (((isEnclosed && enclosedTick > 100) || (isOscillating && !isInCorridor) || levelSearchTimeout) && !isInCorridor) {
        if (!wallSearchPhase) {
          // Initialize wall-following path
          wallFollowPath = buildWallFollowPath(player.x, player.y, grid);
          wallFollowIdx = 0;
          wallSearchPhase = true;
          wallFollowPasses = 0;
          wallFollowTargetRetries = 0;
          wallSearchStep = 0;
          console.log(`[NAV] Wall search started (enclosed=${isEnclosed} oscillating=${isOscillating}): ${wallFollowPath.length} perimeter positions`);
        } else if (isOscillating && !isInCorridor) {
          // Oscillation detected during wall search — update path but don't reset progress
          const newWallFollowPath = buildWallFollowPath(player.x, player.y, grid);
          if (newWallFollowPath.length !== wallFollowPath.length) {
            wallFollowPath = newWallFollowPath;
            if (wallFollowIdx >= wallFollowPath.length) wallFollowIdx = 0;
            console.log(`[NAV] Wall path updated during oscillation: ${wallFollowPath.length} positions (idx=${wallFollowIdx})`);
          }
        }
      }

      // ---- Corridor oscillation: teleport instead of wall search ----
      if (isOscillating && isInCorridor && stuckCount > 20 && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
        if (tryTeleport()) {
          wallSearchPhase = false;
          wallFollowPath = [];
          wallFollowIdx = 0;
          wallFollowPasses = 0;
          searchedWallPos.clear();
          return true;
        }
      }

      if (wallSearchPhase) {
        wallSearchStep++;
        const wallSearchRatio = wallFollowPath.length > 0 ? searchedWallPos.size / wallFollowPath.length : 0;

        // Teleport fallback: if we've done enough passes or search ratio is low, try teleport
        if (((wallFollowPasses >= 2 && wallSearchRatio >= 0.4) || (wallFollowPasses >= 1 && wallSearchRatio < 0.3)) && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
          if (tryTeleport()) {
            // Reset search state after teleport
            wallSearchPhase = false;
            wallFollowPath = [];
            wallFollowIdx = 0;
            wallFollowPasses = 0;
            searchedWallPos.clear();
            return true;
          }
        }

        // Give up wall search if we've searched most positions — let normal exploration try corridors
        if ((enclosedTick > 500 && wallFollowPasses >= 2 && wallSearchRatio >= 0.5) ||
            (wallFollowPasses >= 3 && wallSearchRatio >= 0.8)) {
          // Exit wall search, let normal navigation explore corridors
          wallSearchPhase = false;
          wallFollowPath = [];
          wallFollowIdx = 0;
          wallFollowPasses = 0;
          searchedWallPos.clear();
          enclosedTick = 0;
          corridorFailCount++; // mark that room-based search failed, corridors next
          console.log(`[NAV] Wall search gave up (${wallSearchRatio|0}% searched). Trying corridors.`);
          return true;
        }

        // Mark current position searched if we've been here too long
        const curKey = player.x + ',' + player.y;
        if (searchesAtCurrentPos > 3 && lastWallPosKey === curKey) {
          searchedWallPos.add(curKey);
          searchesAtCurrentPos = 0;
          lastWallPosKey = null;
        }

        // Walk the perimeter path
        if (wallFollowPath.length > 0) {
          // Advance past already-searched positions
          while (wallFollowIdx < wallFollowPath.length &&
                 searchedWallPos.has(wallFollowPath[wallFollowIdx].x + ',' + wallFollowPath[wallFollowIdx].y)) {
            wallFollowIdx++;
          }

          if (wallFollowIdx >= wallFollowPath.length) {
            // Completed one full pass of the perimeter
            wallFollowIdx = 0;
            wallFollowPasses++;
            console.log(`[NAV] Wall perimeter pass ${wallFollowPasses} complete, searched=${searchedWallPos.size}/${wallFollowPath.length}`);
          }

          if (wallFollowIdx < wallFollowPath.length) {
            const target = wallFollowPath[wallFollowIdx];

            // If we're at the target, search it
            if (target.x === player.x && target.y === player.y) {
              searchedWallPos.add(curKey);
              searchesAtCurrentPos = (lastWallPosKey === curKey) ? searchesAtCurrentPos + 1 : 1;
              lastWallPosKey = curKey;
              lastSearchTick = tickCount;
              wallFollowIdx++; // advance for next time
              wallFollowTargetRetries = 0; // reset retry on success
              env.sendKey('s'.charCodeAt(0));
              return true;
            }

            // Navigate to the next target
            const next = bfs(player.x, player.y, target.x, target.y, grid);
            if (next) {
              // If next step is the target itself, search it when we arrive
              const nextCh = (grid[next.y]||'')[next.x] || ' ';
              // Pet blocking path — search current position or move around pet
              if (PET_CHARS.has(nextCh)) {
                wallFollowTargetRetries++;
                if (wallFollowTargetRetries > 3) {
                  // Tried too many times — skip this target
                  wallFollowIdx++;
                  wallFollowTargetRetries = 0;
                  return true;
                }
                // Search current position if wall-adjacent and not yet searched
                if (isAdjacentToWall(player.x, player.y, grid)) {
                  const tKey = player.x + ',' + player.y;
                  if (!searchedWallPos.has(tKey)) {
                    searchedWallPos.add(tKey);
                    lastSearchTick = tickCount;
                    env.sendKey('s'.charCodeAt(0));
                    return true;
                  }
                }
                // Try to swap places with the pet (normal NetHack behavior)
                const nextIdx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                if (nextIdx >= 0) {
                  env.sendKey(KEY[nextIdx].charCodeAt(0));
                  return true;
                }
                // Fallback: move toward target directly (swap with pet is fine)
                for (const di of shuffleDirs()) {
                  const [ddx, ddy] = DIRS[di];
                  const nx = player.x + ddx, ny = player.y + ddy;
                  if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                    const ch = (grid[ny]||'')[nx] || ' ';
                    if (isWalkable(ch) && !MONSTERS.has(ch)) {
                      env.sendKey(KEY[di].charCodeAt(0));
                      return true;
                    }
                  }
                }
                // Everything blocked — wait for pet to move
                env.sendKey('.'.charCodeAt(0));
                return true;
              }
              // If next step is a door, open it
              if (nextCh === '+') {
                const doorKey = next.x + ',' + next.y;
                if (triedDoors.has(doorKey)) {
                  // Door is locked — skip this wall-follow target entirely
                  wallFollowIdx++;
                  wallFollowTargetRetries = 0;
                  return true;
                }
                env.sendKey('o'.charCodeAt(0));
                pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                return true;
              }
              const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
              if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
            }

            // BFS failed to target — search current position if wall-adjacent (pet may be blocking)
            if (isAdjacentToWall(player.x, player.y, grid)) {
              const tKey = player.x + ',' + player.y;
              if (!searchedWallPos.has(tKey)) {
                searchedWallPos.add(tKey);
                lastSearchTick = tickCount;
                env.sendKey('s'.charCodeAt(0));
                return true;
              }
            }
            // Can't reach this target — skip it
            wallFollowIdx++;
          }
        }

        // Every 4th tick while navigating: search if adjacent to wall
        // (Reduce search frequency so AI moves more)
        if (wallSearchStep % 4 === 0 && isAdjacentToWall(player.x, player.y, grid)) {
          const tKey = player.x + ',' + player.y;
          if (!searchedWallPos.has(tKey)) {
            searchedWallPos.add(tKey);
            lastSearchTick = tickCount;
            env.sendKey('s'.charCodeAt(0));
            return true;
          }
        }

        // If search just revealed a door or stairs, navigate to it immediately
        if (lastSearchTick > 0 && tickCount === lastSearchTick + 1 && features) {
          // Prioritize stairs over doors
          if (features.stairsDown.length > 0) {
            const stairs = features.stairsDown[0];
            const next = bfs(player.x, player.y, stairs.x, stairs.y, grid);
            if (next) {
              const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
              if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
            }
          }
          // Navigate to nearest newly revealed door
          if (features.doors.length > 0) {
            let bestDoor = null, bestDist = Infinity;
            for (const door of features.doors) {
              const dist = Math.abs(door.x - player.x) + Math.abs(door.y - player.y);
              if (dist < bestDist) { bestDist = dist; bestDoor = door; }
            }
            if (bestDoor) {
              const doorNext = bfs(player.x, player.y, bestDoor.x, bestDoor.y, grid);
              if (doorNext) {
                const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(doorNext.x-player.x) && ddy===(doorNext.y-player.y));
                if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
              }
            }
          }
        }

        // Fallback: move toward nearest unsearched wall position
        const target = findNearestUnsearchedWall(player.x, player.y, grid);
        if (target) {
          const next = bfs(player.x, player.y, target.x, target.y, grid);
          if (next) {
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }

        // Final fallback: random walkable direction
        const shuffled = shuffleDirs();
        for (const di of shuffled) {
          const [ddx, ddy] = DIRS[di];
          const nx = player.x + ddx, ny = player.y + ddy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ch = (grid[ny]||'')[nx] || ' ';
            if (isWalkable(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
          }
        }
      }

      // ---- Unexplored boundary ----
      const boundary = NH.findNearestUnexplored(grid, player.x, player.y);
      if (boundary) {
        const bch = (grid[boundary.y]||'')[boundary.x] || ' ';
        if (!PET_CHARS.has(bch) && isWalkable(bch)) {
          const dx = boundary.x - player.x, dy = boundary.y - player.y;
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }

      // ---- Fallback: random walkable direction ----
      const shuffled = shuffleDirs();
      for (const di of shuffled) {
        const [ddx, ddy] = DIRS[di];
        const nx = player.x + ddx, ny = player.y + ddy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ch = (grid[ny]||'')[nx] || ' ';
          if (isWalkable(ch)) {
            // Avoid swapping places with pets — they block progress in enclosed rooms
            if (PET_CHARS.has(ch)) continue;
            env.sendKey(KEY[di].charCodeAt(0)); return true;
          }
        }
      }

      // No walkable moves — wait
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // Find nearest wall-adjacent position not yet searched
    function findNearestUnsearchedWall(px, py, grid) {
      const visited = Array.from({length: H}, () => new Uint8Array(W));
      const parent = Array.from({length: H}, () => new Array(W).fill(null));
      const queue = [{x: px, y: py}];
      visited[py][px] = 1;
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        const curCh = (grid[cur.y]||'')[cur.x] || ' ';
        if (curCh !== '#' && isAdjacentToWall(cur.x, cur.y, grid)) {
          const key = cur.x + ',' + cur.y;
          if (!searchedWallPos.has(key)) {
            if (cur.x === px && cur.y === py) return cur;
            // Trace back to first step
            let step = cur;
            while (parent[step.y][step.x] && !(parent[step.y][step.x].x === px && parent[step.y][step.x].y === py)) {
              step = parent[step.y][step.x];
            }
            return step;
          }
        }
        for (const [dx, dy] of DIRS) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (visited[ny][nx]) continue;
          const ch = (grid[ny]||'')[nx] || ' ';
          if (!isBfsWalkable(ch)) continue;
          // Skip monsters
          if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) continue;
          visited[ny][nx] = 1;
          parent[ny][nx] = cur;
          queue.push({x: nx, y: ny});
        }
      }
      // All searched — reset
      if (searchedWallPos.size > 0) {
        searchedWallPos.clear();
        return null; // next tick will retry
      }
      return null;
    }

    function loop() {
      if (stopped) return;
      if (tickCount >= MAX_TICKS) { stop('max-ticks'); return; }
      if (env.isGameDone && env.isGameDone()) { stop('game-ended'); return; }
      if (env.isReadyForInput && !env.isReadyForInput()) { scheduleNext(loop); return; }
      step();
      if (!stopped) scheduleNext(loop);
    }

    scheduleNext(loop);
  }

  global.startNavigation = startNavigation;
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module export (for Node)
export const startNavigation = globalThis.startNavigation;
