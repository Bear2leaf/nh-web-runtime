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

    // Track doors we've tried to open (locked doors)
    const triedDoors = new Set();
    let lastDoorPos = null;
    let doorOpenAttempts = 0;

    // Cooldown after search reveals something (prevents immediate wall-search re-entry)
    let searchCooldownTick = 0;

    // Teleport fallback: how many times we've tried teleporting
    let teleportAttempts = 0;
    const MAX_TELEPORT_ATTEMPTS = 3;

    const MAX_TICKS = 3000;

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
      teleportAttempts++;
      console.log(`[NAV] Attempting teleport (${teleportAttempts}/${MAX_TELEPORT_ATTEMPTS})`);
      env.sendKey(20); // ^T
      return true;
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
      const { player, stairs, food } = findOnMap(grid);
      const msgs = env.getRecentMessages(15);
      if (!player) { env.sendKey('.'.charCodeAt(0)); return true; }

      // ---- Track recent positions for oscillation detection ----
      recentPositions.push({x: player.x, y: player.y});
      if (recentPositions.length > MAX_RECENT) recentPositions.shift();

      // ---- Read HP / hunger ----
      const currentHp = env.getHp();
      const maxHp = env.getMaxHp();
      const hungerText = env.getHunger();
      const hpRatio = currentHp / maxHp;
      const lowHp = hpRatio < 0.8; // flee at 80% HP — prioritize survival
      const hungerNum = parseInt(hungerText) || 0;
      const hungerTrimmed = (hungerText || '').trim();
      // Detect hunger from status field (values include "Hungry  ", "Weak    ", "Fainted ")
      const isHungry = hungerNum >= 1 || hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting';
      // Also check messages for more reliable detection
      const hungerFromMsgs = msgs.some(m =>
        m.toLowerCase().includes('hungry') || m.toLowerCase().includes('weak') ||
        m.toLowerCase().includes('faint') || m.toLowerCase().includes('starving')
      );
      const isHungryCombined = isHungry || hungerFromMsgs;
      // Debug: log hunger state every 200 ticks
      if (tickCount % 200 === 0) console.log(`[NAV-DEBUG] hunger="${hungerTrimmed}" isHungry=${isHungry} fromMsgs=${hungerFromMsgs} combined=${isHungryCombined}`);
      const noFood = msgs.some(m => m.includes("don't have anything to eat"));
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
      else { stuckCount++; }
      lastPlayerPos = { ...player };
      if (stuckCount > 400) { stop('stuck'); return false; }

      // ---- Eat when hungry (but not just for low HP — eating doesn't heal) ----
      if (isHungryCombined && !noFood && !choked && (tickCount - lastEatTick) > 20) {
        lastEatTick = tickCount; choked = false;
        env.sendKey('e'.charCodeAt(0)); return true;
      }
      if (!justChoked && choked && (tickCount - lastEatTick) > 10) { choked = false; }

      // ---- Adjacent monster avoidance ----
      {
        const adjMonster = NH.findNearestMonster(grid, player.x, player.y);
        if (adjMonster) {
          const adx = Math.abs(adjMonster.x - player.x);
          const ady = Math.abs(adjMonster.y - player.y);
          if (adx <= 1 && ady <= 1 && !PET_CHARS.has((grid[adjMonster.y]||'')[adjMonster.x] || ' ')) {
            // Monster adjacent - flee at low HP, fight at high HP
            if (lowHp) {
              const dx = adjMonster.x - player.x;
              const dy = adjMonster.y - player.y;
              const fleeDirs = shuffleDirs();
              for (const di of fleeDirs) {
                const [ddx, ddy] = DIRS[di];
                if (ddx * dx + ddy * dy >= 0) continue;
                const nx = player.x + ddx, ny = player.y + ddy;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                  const ch = (grid[ny]||'')[nx] || ' ';
                  if (isWalkable(ch) && !PET_CHARS.has(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
                }
              }
              // Can't flee — try any walkable direction (might randomly escape)
              const shuffledDirs = shuffleDirs();
              for (const di of shuffledDirs) {
                const [ddx, ddy] = DIRS[di];
                const nx = player.x + ddx, ny = player.y + ddy;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                  const ch = (grid[ny]||'')[nx] || ' ';
                  if (isWalkable(ch) && !PET_CHARS.has(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
                }
              }
              // No valid directions — fight even at low HP
              const fightDx2 = adjMonster.x - player.x;
              const fightDy2 = adjMonster.y - player.y;
              const fightIdx2 = DIRS.findIndex(([ddx,ddy]) => ddx===fightDx2 && ddy===fightDy2);
              if (fightIdx2 >= 0) { env.sendKey(KEY[fightIdx2].charCodeAt(0)); return true; }
              env.sendKey('.'.charCodeAt(0));
              return true;
            }
            // High HP - fight back
            const fightDx = adjMonster.x - player.x;
            const fightDy = adjMonster.y - player.y;
            const fightIdx = DIRS.findIndex(([ddx,ddy]) => ddx===fightDx && ddy===fightDy);
            if (fightIdx >= 0) { env.sendKey(KEY[fightIdx].charCodeAt(0)); return true; }
            // Can't fight - try to flee any direction
            const fleeDirs = shuffleDirs();
            for (const di of fleeDirs) {
              const [ddx, ddy] = DIRS[di];
              const nx = player.x + ddx, ny = player.y + ddy;
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                const ch = (grid[ny]||'')[nx] || ' ';
                if (isWalkable(ch) && !PET_CHARS.has(ch)) { env.sendKey(KEY[di].charCodeAt(0)); return true; }
              }
            }
          }
        }
      }

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
          const features = scanMap(grid);
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
      const features = scanMap(grid);
      const untriedDoors = features.doors.filter(d => !triedDoors.has(d.x + ',' + d.y));
      if (untriedDoors.length > 0) {
        wallSearchPhase = false;
        enclosedTick = 0;
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
              console.log(`[NAV] Door at ${doorKey} seems locked, kicking`);
              triedDoors.add(doorKey); // Mark as tried so we move on after kick
              env.sendKey(4); // ^D = kick
              pendingKickDir = DIRS.findIndex(([dx,dy]) => dx===ddx && dy===ddy);
              doorOpenAttempts = 0;
              lastDoorPos = null;
              return true;
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
          const nextCh = (grid[bestNext.y]||'')[bestNext.x] || ' ';
          if (nextCh === '+') {
            env.sendKey('o'.charCodeAt(0));
            pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
            return true;
          }
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(bestNext.x-player.x) && ddy===(bestNext.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        }
      }

      // ---- Corridor/exit navigation (highest priority after doors/stairs) ----
      // Find exits from the current room: floor tiles adjacent to corridors.
      // Only use room floor tiles as targets — corridor tiles are pass-through, not destinations.
      // Also treat pet positions as valid entrances (player can walk onto pets in BFS).
      const playerCh = (grid[player.y]||'')[player.x] || ' ';
      const isInCorridor = playerCh === '#';
      let nearestRoomEntrance = null, roomEntranceDist = Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ch = (grid[y]||'')[x] || ' ';
          // Floor tile or pet adjacent to a corridor = room entrance/exit
          const isFloor = (ch === '.' || ch === '<' || ch === '>' || ch === '%' ||
                          (ch !== ' ' && ch !== '#' && ch !== '|' && ch !== '-' && ch !== '+'));
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
      // If no room entrance found, try to BFS directly to a corridor tile
      if (!nearestRoomEntrance) {
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
            if (!wallSearchPhase) enclosedTick = 0;
            corridorFailCount = 0;
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }
      }
      if (nearestRoomEntrance) {
        const next = bfs(player.x, player.y, nearestRoomEntrance.x, nearestRoomEntrance.y, grid);
        if (next) {
          if (!wallSearchPhase) enclosedTick = 0;
          corridorFailCount = 0;
          const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
          if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
        } else {
          // BFS to exit failed — try adjacent tiles
          let bestAdj = null, bestAdjDist = Infinity;
          for (const [dx, dy] of DIRS) {
            const ax = nearestRoomEntrance.x + dx, ay = nearestRoomEntrance.y + dy;
            if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
            const ach = (grid[ay]||'')[ax] || ' ';
            if (ach === '|' || ach === '-' || ach === ' ') continue;
            const adjNext = bfs(player.x, player.y, ax, ay, grid);
            if (adjNext) {
              const dist = Math.abs(ax - player.x) + Math.abs(ay - player.y);
              if (dist < bestAdjDist) { bestAdjDist = dist; bestAdj = adjNext; }
            }
          }
          if (bestAdj) {
            if (!wallSearchPhase) { enclosedTick = 0; corridorFailCount = 0; }
            const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(bestAdj.x-player.x) && ddy===(bestAdj.y-player.y));
            if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
          }
        }
      } else {
        corridorFailCount = 0;
      }

      // ---- Corridor following: when in a corridor with no visible room entrance ----
      // Prefer to move into corridors, avoiding backtracking to recent positions.
      // If there's a nearby door we're heading toward, bias toward it.
      if (!nearestRoomEntrance && isInCorridor) {
        // Find best direction toward the nearest door we're navigating to
        const allDoors = features.doors;
        let targetDx = 0, targetDy = 0, hasTarget = false;
        if (allDoors.length > 0) {
          // Pick the nearest door
          let bestDoorDist = Infinity, bestDx = 0, bestDy = 0;
          for (const d of allDoors) {
            const dd = Math.abs(d.x - player.x) + Math.abs(d.y - player.y);
            if (dd < bestDoorDist) {
              bestDoorDist = dd;
              bestDx = d.x - player.x;
              bestDy = d.y - player.y;
            }
          }
          if (bestDx !== 0 || bestDy !== 0) {
            const mag = Math.sqrt(bestDx * bestDx + bestDy * bestDy);
            targetDx = Math.round(bestDx / mag);
            targetDy = Math.round(bestDy / mag);
            hasTarget = true;
          }
        }
        let bestCorridorDir = -1, bestCorridorScore = -Infinity;
        for (let di = 0; di < 8; di++) {
          const [dx, dy] = DIRS[di];
          const nx = player.x + dx, ny = player.y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const nch = (grid[ny]||'')[nx] || ' ';
          // Skip walls, doors, space, pets — everything else is OK (including monsters to fight)
          if (nch === '|' || nch === '-' || nch === ' ' || nch === '+' || PET_CHARS.has(nch)) continue;
          // Penalize directions we've been in recently
          let recentPenalty = 0;
          for (let i = recentPositions.length - 1; i >= Math.max(0, recentPositions.length - 4); i--) {
            const rp = recentPositions[i];
            const rdx = rp.x - player.x, rdy = rp.y - player.y;
            if (rdx === dx && rdy === dy) recentPenalty += 2;
          }
          // Prefer directions toward the nearest door
          let doorBonus = 0;
          if (hasTarget) {
            if (dx === targetDx && dy === targetDy) doorBonus = 5;
            else if (dx === targetDx || dy === targetDy) doorBonus = 2;
          }
          // Count corridor tiles ahead (prefer straight corridors)
          let corridorAhead = 0;
          for (let step = 1; step <= 3; step++) {
            const ax = player.x + dx * step, ay = player.y + dy * step;
            if (ax < 0 || ax >= W || ay < 0 || ay >= H) break;
            const ach = (grid[ay]||'')[ax] || ' ';
            if (ach === '#') corridorAhead++; else break;
          }
          const score = corridorAhead * 3 + doorBonus - recentPenalty;
          if (score > bestCorridorScore) { bestCorridorScore = score; bestCorridorDir = di; }
        }
        if (bestCorridorDir >= 0) {
          const [dx, dy] = DIRS[bestCorridorDir];
          const nx = player.x + dx, ny = player.y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const nch = (grid[ny]||'')[nx] || ' ';
            if (nch === '#' || nch === '.' || nch === '<' || nch === '>' || nch === '%') {
              env.sendKey(KEY[bestCorridorDir].charCodeAt(0));
              return true;
            }
          }
        }
      }

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
      const isEnclosed = !stairs && features.doors.length === 0 && !nearestRoomEntrance && !isSurroundedByCorridors && !recentSearchCooldown && !isInCorridor;
      if (isEnclosed) {
        enclosedTick++;
      } else if (isOscillating) {
        // Oscillating counts as pseudo-enclosed — increment slower
        enclosedTick += 0.5;
      } else if (!wallSearchPhase) {
        // Only reset enclosed tracking if we're not actively in wall-search
        enclosedTick = 0;
      }

      // Start wall search if enclosed or oscillating
      // Oscillation triggers immediately (no enclosedTick threshold needed)
      if ((isEnclosed && enclosedTick > 15) || isOscillating) {
        if (!wallSearchPhase) {
          // Initialize wall-following path
          wallFollowPath = buildWallFollowPath(player.x, player.y, grid);
          wallFollowIdx = 0;
          wallSearchPhase = true;
          wallFollowPasses = 0;
          wallSearchStep = 0;
          console.log(`[NAV] Wall search started (enclosed=${isEnclosed} oscillating=${isOscillating}): ${wallFollowPath.length} perimeter positions`);
        } else if (isOscillating) {
          // Oscillation detected during wall search — don't reset, just continue
          // But update the path if the map has changed
          const newWallFollowPath = buildWallFollowPath(player.x, player.y, grid);
          if (newWallFollowPath.length !== wallFollowPath.length) {
            wallFollowPath = newWallFollowPath;
            wallFollowIdx = 0;
            wallFollowPasses = 0;
            wallSearchStep = 0;
            console.log(`[NAV] Wall path updated during oscillation: ${wallFollowPath.length} positions`);
          }
        }
      }

      if (wallSearchPhase) {
        wallSearchStep++;

        // If wall search was triggered by oscillation and we've completed a perimeter pass,
        // or if we've been in wall-search for a long time, yield to corridor exploration
        if (isOscillating && wallFollowPasses >= 1) {
          wallSearchPhase = false;
          wallFollowPath = [];
          wallFollowIdx = 0;
          wallFollowPasses = 0;
          wallSearchStep = 0;
          searchedWallPos.clear();
          // Fall through — let corridor/other logic take over
        }

        // Teleport fallback: if we've done 2 full passes with no results, try teleport
        if (wallFollowPasses >= 2 && teleportAttempts < MAX_TELEPORT_ATTEMPTS) {
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

        // Stuck in truly enclosed room
        if (enclosedTick > 500 && wallFollowPasses >= 2) {
          stop('stuck'); return false;
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
              searchesAtCurrentPos = (lastWallPosKey === curKey) ? searchesAtCurrentPos + 1 : 1;
              lastWallPosKey = curKey;
              lastSearchTick = tickCount;
              wallFollowIdx++; // advance for next time
              env.sendKey('s'.charCodeAt(0));
              return true;
            }

            // Navigate to the next target
            const next = bfs(player.x, player.y, target.x, target.y, grid);
            if (next) {
              // If next step is the target itself, search it when we arrive
              const nextCh = (grid[next.y]||'')[next.x] || ' ';
              // Skip if a pet is blocking this direction (avoid place-swapping)
              if (PET_CHARS.has(nextCh)) { wallFollowIdx++; return true; }
              // If next step is a door, open it
              if (nextCh === '+') {
                const doorKey = next.x + ',' + next.y;
                if (triedDoors.has(doorKey)) {
                  // Door is locked — kick it
                  env.sendKey(4); // ^D = kick
                  pendingKickDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                  return true;
                }
                env.sendKey('o'.charCodeAt(0));
                pendingDir = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
                return true;
              }
              const idx = DIRS.findIndex(([ddx,ddy]) => ddx===(next.x-player.x) && ddy===(next.y-player.y));
              if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
            }

            // BFS failed to target (shouldn't happen in same room) — skip it
            wallFollowIdx++;
          }
        }

        // Every 4th tick while navigating: search if adjacent to wall
        // (Reduce search frequency so AI moves more)
        if (wallSearchStep % 4 === 0 && isAdjacentToWall(player.x, player.y, grid)) {
          const tKey = player.x + ',' + player.y;
          if (!searchedWallPos.has(tKey)) {
            searchesAtCurrentPos = (lastWallPosKey === curKey) ? searchesAtCurrentPos + 1 : 1;
            lastWallPosKey = curKey;
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
        const dx = boundary.x - player.x, dy = boundary.y - player.y;
        const idx = DIRS.findIndex(([ddx,ddy]) => ddx===dx && ddy===dy);
        if (idx >= 0) { env.sendKey(KEY[idx].charCodeAt(0)); return true; }
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
