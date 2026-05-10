/**
 * NHBrowserEnv — Browser environment adapter for nav-ai.
 *
 * Implements the NavEnv interface by reading from the browser DOM.
 * Used by Playwright e2e tests.
 */

(function(global) {
  'use strict';

  class NHBrowserEnv {
    getDlvl() {
      return document.getElementById('stat-dlvl')?.textContent?.trim() || '1';
    }

    getHp() {
      return parseInt(document.getElementById('stat-hp')?.textContent?.trim()) || 999;
    }

    getMaxHp() {
      return parseInt(document.getElementById('stat-maxhp')?.textContent?.trim()) || 999;
    }

    getHunger() {
      return document.getElementById('stat-hunger')?.textContent?.trim() || '';
    }

    isYnVisible() {
      const modal = document.getElementById('yn-modal');
      return modal ? !modal.classList.contains('hidden') : false;
    }

    getYnText() {
      return document.getElementById('yn-modal')?.textContent || '';
    }

    isMenuVisible() {
      const modal = document.getElementById('menu-modal');
      return modal ? !modal.classList.contains('hidden') : false;
    }

    getMenuText() {
      return document.getElementById('menu-modal')?.textContent || '';
    }

    getMap() {
      return window.nethackGlobal?.helpers?.getMap() || [];
    }

    getRecentMessages(n) {
      const panel = document.getElementById('message-panel');
      if (!panel) return [];
      const msgs = panel.querySelectorAll('.message');
      const result = [];
      for (let i = Math.max(0, msgs.length - n); i < msgs.length; i++) {
        result.push(msgs[i].textContent || '');
      }
      return result;
    }

    sendKey(code) {
      window.nethackGlobal?.helpers?.sendKey(code);
    }

    clickYnButton() {
      const btn = document.getElementById('yn-modal')?.querySelector('button');
      if (btn) { btn.click(); return true; }
      return false;
    }
  }

  global.NHBrowserEnv = NHBrowserEnv;
})(typeof globalThis !== 'undefined' ? globalThis : window);
