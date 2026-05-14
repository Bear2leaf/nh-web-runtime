/**
 * nav-core.js — NetHack Navigation AI: Core utilities
 *
 * Exposes constants and pure functions on window.NHNav.
 * Must be loaded before nav-strategy.js and nav-ai.js.
 */

(function(global) {
  'use strict';

  const W = 80, H = 21;
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[1,1],[-1,1]];
  const KEY  = ['h','l','k','j','y','u','n','b'];
  const MONSTERS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ&;:\'I');
  const PET_CHARS = new Set(['d','f','u']); // actual starting pet types (dog, cat, horse/pony)

  function isWalkable(ch) {
    if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) return false;
    if (ch === '|' || ch === '-' || ch === ' ' || ch === '`') return false;
    if (ch === "'" || ch === '"') return false; // room walls
    if (ch === '^') return false; // known traps
    if (ch === '}' || ch === '~') return false; // water, lava, moat
    return true;
  }

  function isBfsWalkable(ch) {
    if (ch === '|' || ch === '-' || ch === ' ') return false;
    if (ch === "'" || ch === '"') return false; // room walls
    if (ch === '#') return true; // corridors are walkable
    if (ch === '^') return false; // known traps
    if (ch === '}' || ch === '~') return false; // water, lava, moat
    return true;
  }

  function findOnMap(grid) {
    let player = null, stairs = null, food = null;
    let foodDist = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = (grid[y] || '')[x] || ' ';
        if (ch === '@') player = { x, y };
        // Only target down-stairs ('>') — AI descends levels
        if (ch === '>') stairs = { x, y };
        if (ch === '%') {
          if (player) {
            const dist = Math.abs(x - player.x) + Math.abs(y - player.y);
            if (dist < foodDist) { foodDist = dist; food = { x, y }; }
          } else {
            food = food || { x, y };
          }
        }
      }
    }
    return { player, stairs, food };
  }

  function scanMap(grid) {
    const features = { doors: [], walls: [], food: [], monsters: [], stairsDown: [], stairsUp: [] };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = (grid[y] || '')[x] || ' ';
        if (ch === '+') features.doors.push({x, y});
        if (ch === '|' || ch === '-') features.walls.push({x, y});
        if (ch === '%') features.food.push({x, y});
        if (MONSTERS.has(ch)) features.monsters.push({x, y, ch});
        if (ch === '>') features.stairsDown.push({x, y});
        if (ch === '<') features.stairsUp.push({x, y});
      }
    }
    return features;
  }

  /**
   * BFS pathfinding that avoids a set of blocked positions.
   * blockedPositions: Set of "x,y" strings to treat as impassable.
   * Returns first step {x,y} toward target, or null.
   */
  function bfsAvoiding(sx, sy, tx, ty, grid, blockedPositions, openDoors) {
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
        if (!isBfsWalkable(ch) && !(nx === tx && ny === ty) && !(openDoors && openDoors.has(nx + ',' + ny))) continue;
        // Avoid known traps even if they're the target — stepping on them causes "Really step" loops
        if (blockedPositions && blockedPositions.has(nx + ',' + ny)) continue;
        if (MONSTERS.has(ch) && !(nx === tx && ny === ty)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  function bfs(sx, sy, tx, ty, grid, openDoors, blockedPositions) {
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
        if (!(nx === tx && ny === ty) &&
            !isBfsWalkable(ch) && !(openDoors && openDoors.has(nx + ',' + ny))) continue;
        // Avoid known traps even if they're the target — stepping on them causes "Really step" loops
        if (blockedPositions && blockedPositions.has(nx + ',' + ny)) continue;
        // Skip monsters and pets (but allow target if it's a monster — we'll attack it)
        if (MONSTERS.has(ch) && !(nx === tx && ny === ty)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  /**
   * BFS that ignores monsters (for stairs rushing). Still avoids traps.
   */
  function bfsRush(sx, sy, tx, ty, grid, openDoors, blockedPositions) {
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
        if (!(nx === tx && ny === ty) &&
            !isBfsWalkable(ch) && !(openDoors && openDoors.has(nx + ',' + ny))) continue;
        // Avoid known traps
        if (blockedPositions && blockedPositions.has(nx + ',' + ny)) continue;
        // Don't skip monsters — we want to rush past them to stairs
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  /**
   * Find the nearest walkable tile adjacent to an unexplored boundary.
   * BFS is capped at MAX_BFS_NODES nodes to avoid chasing distant unexplored
   * tiles when nearby doors might lead to rooms with stairs.
   */
  const MAX_BFS_NODES = 500;

  function findNearestUnexplored(grid, px, py, blockedPositions) {
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const parent = Array.from({length: H}, () => new Array(W).fill(null));
    const queue = [{x: px, y: py}];
    visited[py][px] = 1;
    let head = 0;
    const seen = Array.from({length: H}, () => new Uint8Array(W));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (isBfsWalkable((grid[y]||'')[x] || ' ')) seen[y][x] = 1;

    let nodesExplored = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      nodesExplored++;
      // Check for boundary: adjacent to an unseen tile
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if ((nch === '|' || nch === '-' || nch === '+') && seen[cur.y][cur.x]) {
          if (cur.x === px && cur.y === py) continue;
          let step = cur;
          while (parent[step.y][step.x] && !(parent[step.y][step.x].x === px && parent[step.y][step.x].y === py)) {
            step = parent[step.y][step.x];
          }
          return step;
        }
      }
      // Cap BFS expansion to avoid chasing very distant boundaries
      if (nodesExplored >= MAX_BFS_NODES) break;
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if (!isBfsWalkable(nch)) continue;
        if (blockedPositions && blockedPositions.has(nx + ',' + ny)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  function getRecentMessages(n) {
    const panel = document.getElementById('message-panel');
    if (!panel) return [];
    const msgs = panel.querySelectorAll('.message');
    const result = [];
    for (let i = Math.max(0, msgs.length - n); i < msgs.length; i++) {
      result.push(msgs[i].textContent || '');
    }
    return result;
  }

  function isSearchSpam() {
    const msgs = getRecentMessages(5);
    if (msgs.length < 3) return false;
    return msgs.filter(m => m.includes('already found a monster')).length >= 3;
  }

  function findNearestMonster(grid, px, py) {
    let best = null, bestDist = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = (grid[y] || '')[x] || ' ';
        if (MONSTERS.has(ch)) {
          const dist = Math.abs(x - px) + Math.abs(y - py);
          if (dist < bestDist) { bestDist = dist; best = { x, y, ch }; }
        }
      }
    }
    return best;
  }

  function shuffleDirs() {
    const dirs = [0,1,2,3,4,5,6,7];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    return dirs;
  }

  // Expose to window.NHNav
  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, {
    W, H, DIRS, KEY, MONSTERS, PET_CHARS,
    isWalkable, isBfsWalkable,
    findOnMap, scanMap, bfs, bfsAvoiding, bfsRush,
    findNearestUnexplored, getRecentMessages,
    isSearchSpam, findNearestMonster, shuffleDirs,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module exports (for Node)
export const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
                findOnMap, scanMap, bfs, bfsAvoiding, bfsRush, findNearestUnexplored,
                getRecentMessages, isSearchSpam, findNearestMonster, shuffleDirs } = global.NHNav || {};
