/**
 * nav-hp-hunger.mjs — NetHack Navigation AI: HP reading, hunger, eating
 *
 * Handles: faint recovery (wait), eating when hungry/weak/fainting.
 * Depends on window.NHNav (from nav-core.mjs).
 *
 * IIFE + ESM dual export pattern.
 */
(function(global) {
  'use strict';

  const NH = global.NHNav;
  if (!NH) { console.error('[NAV] nav-core.js must be loaded before nav-hp-hunger.js'); return; }

  /**
   * Handle HP/hunger: faint recovery and eating when hungry.
   * Returns true if this handler consumed the tick.
   *
   * KEY INSIGHT (from NetHack/src/eat.c): Choking is locked-in at start_eating
   * based on u.uhs == SATIATED. Once you start eating in SATIATED state, any
   * food that pushes u.uhunger >= 2000 kills you (e.g., a corpse). The "hard
   * time getting it down" warning at 1500 is your last safe stop.
   *
   * Therefore: NEVER eat when status shows "Satiated".
   */
  function handleHpHunger(navCtx) {
    const { env, tickCount, msgs } = navCtx;
    const hungerText = env.getHunger();
    const hungerTrimmed = (hungerText || '').trim();

    // ---- Fainted or Fainting: unconscious or about to faint, can't act.
    // Just advance time until recovery ----
    if (hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting') {
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // SATIATED: never eat — choking will kill us. Just keep navigating.
    if (hungerTrimmed === 'Satiated') return false;

    // Detect hunger from status field
    const isHungry = hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak' ||
                     hungerTrimmed === 'Fainted' || hungerTrimmed === 'Fainting';
    // Also check messages for more reliable detection
    const hungerFromMsgs = msgs.some(m =>
      m.toLowerCase().includes('hungry') || m.toLowerCase().includes('weak') ||
      m.toLowerCase().includes('faint') || m.toLowerCase().includes('starving')
    );
    const isHungryCombined = isHungry || hungerFromMsgs;

    const noFood = msgs.some(m => m.includes("don't have anything to eat"));
    const justChoked = msgs.some(m => m.includes('choke') || m.includes('choking'));
    if (justChoked) navCtx.choked = true;

    // Eat when hungry/weak/fainting
    const isWeak = hungerTrimmed === 'Weak' || hungerTrimmed === 'Fainting';
    const eatCooldown = isWeak ? 5 : 20;
    if (isHungryCombined && !noFood && !navCtx.choked && (tickCount - navCtx.lastEatTick) > eatCooldown) {
      navCtx.lastEatTick = tickCount;
      navCtx.choked = false;
      env.sendKey('e'.charCodeAt(0));
      return true;
    }

    // Recover from choking after a longer wait
    if (!justChoked && navCtx.choked && (tickCount - navCtx.lastEatTick) > 200) {
      navCtx.choked = false;
    }

    return false;
  }

  global.NHNav = global.NHNav || {};
  Object.assign(global.NHNav, { handleHpHunger });
})(typeof globalThis !== 'undefined' ? globalThis : window);

export const { handleHpHunger } = global.NHNav || {};
