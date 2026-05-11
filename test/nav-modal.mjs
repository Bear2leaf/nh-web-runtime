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
      // Teleport confirmation: accept default
      if (ynText.toLowerCase().includes('teleport') || ynText.toLowerCase().includes('where')) {
        env.sendKey('y'.charCodeAt(0));
        return true;
      }
      // Generic Y/N: prefer yes
      if (!env.clickYnButton()) env.sendKey(121);
      return true;
    }

    // Menu prompt (eat/drink/read selection)
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
        menuText.includes('What do you want')
      ) {
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
