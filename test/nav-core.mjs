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
  const PET_CHARS = new Set(['c','d','f','n','q','r','s','t','w','y']); // d=canine (dog/wolf), f=feline (cat), others=common pets

  function isWalkable(ch) {
    if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) return false;
    if (ch === '|' || ch === '-' || ch === ' ' || ch === '`') return false;
    if (ch === '^') return false; // known traps
    return true;
  }

  function isBfsWalkable(ch) {
    if (ch === '|' || ch === '-' || ch === ' ') return false;
    if (ch === '#') return true; // corridors are walkable
    if (ch === '^') return false; // known traps
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
        if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) features.monsters.push({x, y, ch});
        if (ch === '>') features.stairsDown.push({x, y});
        if (ch === '<') features.stairsUp.push({x, y});
      }
    }
    return features;
  }

  function bfs(sx, sy, tx, ty, grid) {
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
        // Skip monsters (but allow target if it's a monster — we'll attack it)
        if (MONSTERS.has(ch) && !PET_CHARS.has(ch) && !(nx === tx && ny === ty)) continue;
        visited[ny][nx] = 1;
        parent[ny][nx] = cur;
        queue.push({x: nx, y: ny});
      }
    }
    return null;
  }

  function findNearestUnexplored(grid, px, py) {
    const visited = Array.from({length: H}, () => new Uint8Array(W));
    const parent = Array.from({length: H}, () => new Array(W).fill(null));
    const queue = [{x: px, y: py}];
    visited[py][px] = 1;
    let head = 0;
    const seen = Array.from({length: H}, () => new Uint8Array(W));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (isBfsWalkable((grid[y]||'')[x] || ' ')) seen[y][x] = 1;

    while (head < queue.length) {
      const cur = queue[head++];
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
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (visited[ny][nx]) continue;
        const nch = (grid[ny]||'')[nx] || ' ';
        if (!isBfsWalkable(nch)) continue;
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
        if (MONSTERS.has(ch) && !PET_CHARS.has(ch)) {
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
    findOnMap, scanMap, bfs,
    findNearestUnexplored, getRecentMessages,
    isSearchSpam, findNearestMonster, shuffleDirs,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module exports (for Node)
export const { W, H, DIRS, KEY, MONSTERS, PET_CHARS, isWalkable, isBfsWalkable,
                findOnMap, scanMap, bfs, findNearestUnexplored,
                getRecentMessages, isSearchSpam, findNearestMonster, shuffleDirs } = global.NHNav || {};
