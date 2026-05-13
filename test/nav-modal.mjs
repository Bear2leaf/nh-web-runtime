/**
 * nav-modal.mjs — NetHack Navigation AI: Pending keys & modal dialog handling
 *
 * Handles: pending direction keys, Y/N prompts, menu prompts, teleport confirmation.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern (same as nav-core.mjs).
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-modal.js'); return; }

  const { KEY } = NH;

  /**
   * Handle pending direction keys (from door opening, kicking).
   * Returns true if this handler consumed the tick.
   */
  function handlePendingKeys(navCtx) {
    const { env, pendingDir, pendingKickDir } = navCtx;
    if (pendingDir !== null) {
      navCtx.pendingDir = null;
      env.sendKey(KEY[pendingDir].charCodeAt(0));
      return true;
    }
    if (pendingKickDir !== null) {
      navCtx.pendingKickDir = null;
      env.sendKey(KEY[pendingKickDir].charCodeAt(0));
      return true;
    }
    return false;
  }

  /**
   * Handle modal dialogs: Y/N prompts, menu prompts, teleport confirmation.
   * Returns true if this handler consumed the tick.
   */
  function handleModal(navCtx) {
    const { env, pendingDir, pendingKickDir, stopped, onDone } = navCtx;

    // Pending prayer invocation: handle the prayer menu / confirmation
    if (navCtx.pendingPray) {
      navCtx.pendingPray = false;
      // After sending '#', NetHack may ask "Really pray?" — handle YN
      if (env.isYnVisible()) {
        const ynText = env.getYnText();
        if (ynText.toLowerCase().includes('pray')) {
          env.sendKey(121); // 'y'
          return true;
        }
        env.sendKey(121); // default to yes
        return true;
      }
      // Or it opens a menu — handle that
      if (env.isMenuVisible()) {
        const menuText = env.getMenuText();
        // Pick first option (usually "pray" or god name)
        const itemMatch = menuText.match(/\[([a-z])(?:-([a-z]))?\s*(?:or\s+)?\?\*\]/);
        if (itemMatch) {
          env.sendKey(itemMatch[1].charCodeAt(0));
        } else if (menuText.includes('invoke') || menuText.includes('pray') || menuText.includes('god')) {
          env.sendKey('a'.charCodeAt(0)); // first option
        } else {
          env.sendKey(27); // cancel
        }
        return true;
      }
      // Neither YN nor menu yet — keep sending pray
      env.sendKey('#'.charCodeAt(0));
      return true;
    }

    // Direction query (e.g. after failed teleport)
    if (env.isYnVisible()) {
      const ynText = env.getYnText();
      if (ynText.includes('possessions identified') || ynText.includes('identified?')) {
        navCtx.stopped = true;
        if (navCtx.onDone) navCtx.onDone('died');
        return true;
      }
      if (ynText.toLowerCase().includes('direction')) {
        if (pendingDir !== null) {
          env.sendKey(KEY[pendingDir].charCodeAt(0));
          navCtx.pendingDir = null;
        } else if (pendingKickDir !== null) {
          env.sendKey(KEY[pendingKickDir].charCodeAt(0));
          navCtx.pendingKickDir = null;
        } else {
          env.sendKey(27); // ESC — cancel
        }
        return true;
      }
      // Trap prompt: decline stepping onto known trap, mark trap position
      if (ynText.includes('Really step')) {
        env.sendKey('n'.charCodeAt(0));
        // Mark trap position so pathfinding avoids it
        let trapDir = navCtx.lastMoveDir;
        if (trapDir < 0 && navCtx.lastSentDir >= 0) trapDir = navCtx.lastSentDir;
        if (trapDir >= 0 && navCtx.player) {
          const { DIRS } = NH;
          const [tdx, tdy] = DIRS[trapDir];
          const trapX = navCtx.player.x + tdx;
          const trapY = navCtx.player.y + tdy;
          const trapKey = trapX + ',' + trapY;
          if (!navCtx.knownTrapPositions.has(trapKey)) {
            navCtx.knownTrapPositions.add(trapKey);
            console.log(`[NAV-MODAL] Trap prompt detected, marking trap at ${trapKey} (dir=${trapDir})`);
          }
        } else if (navCtx.player) {
          // Fallback: mark all adjacent walkable tiles as potential traps
          const { DIRS, W, H } = NH;
          for (const [dx, dy] of DIRS) {
            const tx = navCtx.player.x + dx, ty = navCtx.player.y + dy;
            if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
            const ch = (navCtx.grid[ty]||'')[tx] || ' ';
            if (NH.isWalkable(ch)) {
              const trapKey = tx + ',' + ty;
              if (!navCtx.knownTrapPositions.has(trapKey)) {
                navCtx.knownTrapPositions.add(trapKey);
                console.log(`[NAV-MODAL] Trap prompt with no direction, marking adjacent ${trapKey}`);
              }
            }
          }
        }
        return true;
      }
      // Door unlock/lock prompts — answer no so we can kick instead
      if (ynText.toLowerCase().includes('unlock it with') || ynText.toLowerCase().includes('lock it with')) {
        env.sendKey('n'.charCodeAt(0));
        return true;
      }
      // Catch-all for unknown YN prompts — default to no (safer)
      env.sendKey('n'.charCodeAt(0));
      console.log(`[NAV-MODAL] Unknown YN prompt: ${ynText.slice(0, 80)} — defaulting to no`);
      return true;
      // Teleport confirmation: accept default
      if (ynText.toLowerCase().includes('teleport') || ynText.toLowerCase().includes('where')) {
        env.sendKey('y'.charCodeAt(0));
        return true;
      }
      // Prayer prompt: always accept (praying while starving can create food)
      if (ynText.toLowerCase().includes('pray')) {
        env.sendKey('y'.charCodeAt(0));
        return true;
      }
      // Generic Y/N: prefer yes
      if (!env.clickYnButton()) env.sendKey(121);
      return true;
    }

    // Menu prompt (eat/drink/read selection, prayer invocation)
    if (env.isMenuVisible()) {
      const menuText = env.getMenuText();
      const itemMatch = menuText.match(/\[([a-z])(?:-([a-z]))?\s*(?:or\s+)?\?\*\]/);
      if (itemMatch) {
        env.sendKey(itemMatch[1].charCodeAt(0));
      } else if (menuText.includes('Really') || menuText.includes('Really?')) {
        env.sendKey('y'.charCodeAt(0));
      } else if (
        menuText.includes('eat') || menuText.includes('Eat') ||
        menuText.includes('drink') || menuText.includes('read') ||
        menuText.includes('What do you want') ||
        // Prayer invocation menus
        menuText.includes('invoke') || menuText.includes('pray') ||
        menuText.includes('god') || menuText.includes('gods') ||
        menuText.includes('What god')
      ) {
        // For prayer: pick first option (usually your god), or accept default
        env.sendKey('a'.charCodeAt(0));
      } else {
        env.sendKey(27); // ESC — cancel
      }
      return true;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handlePendingKeys, handleModal });
})(typeof globalThis !== 'undefined' ? globalThis : window);

// ES module exports
export const { handlePendingKeys, handleModal } = global.NHNav || {};
