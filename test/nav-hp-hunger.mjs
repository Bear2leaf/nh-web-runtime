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

    // SATIATED: never eat — choking will kill us. Just keep navigating.
    if (hungerTrimmed === 'Satiated') return false;

    // Fainting = LAST TICK before unconsciousness. Eat immediately, no cooldown.
    // This is critical — if we let the player slip into Fainted, NetHack ignores 'e'.
    // But don't spam 'e' if we already got "no food" message.
    const noFood = msgs.some(m => m.includes("don't have anything to eat"));
    if (hungerTrimmed === 'Fainting') {
      if (!navCtx.choked && !noFood) {
        navCtx.lastEatTick = tickCount;
        console.log('[NAV-HH] Fainting — eating immediately (no cooldown, last chance)');
        env.sendKey('e'.charCodeAt(0));
        return true;
      }
      // No food available or choked — will transition to Fainted next
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // Fainted = unconscious. NetHack ignores all input keys.
    // Try 'e' every few ticks in case we JUST recovered this tick.
    if (hungerTrimmed === 'Fainted') {
      if (!navCtx.choked && !noFood && (tickCount - navCtx.lastEatTick) > 3) {
        navCtx.lastEatTick = tickCount;
        env.sendKey('e'.charCodeAt(0));
        return true;
      }
      env.sendKey('.'.charCodeAt(0));
      return true;
    }

    // Detect hunger from status field
    const isHungry = hungerTrimmed === 'Hungry' || hungerTrimmed === 'Weak';
    // Also check messages for more reliable detection
    const hungerFromMsgs = msgs.some(m =>
      m.toLowerCase().includes('hungry') || m.toLowerCase().includes('weak') ||
      m.toLowerCase().includes('faint') || m.toLowerCase().includes('starving')
    );
    const isHungryCombined = isHungry || hungerFromMsgs;

    const justChoked = msgs.some(m => m.includes('choke') || m.includes('choking'));
    if (justChoked) navCtx.choked = true;

    // Eat when hungry/weak/fainting
    // During wall search, only eat when Weak — Hungry can wait until
    // wall search finishes or finds something. Wall search is time-critical.
    const isWeak = hungerTrimmed === 'Weak';
    // Lowered cooldown for "Hungry" from 20 to 5 — eat aggressively to avoid faint.
    const eatCooldown = 5;
    const wallSearchActive = navCtx.wallSearchPhase;
    // CHOKED FIX: If choked but not Satiated, clear the flag and try to eat anyway.
    // Choking only kills in SATIATED state; when hungry, clearing the flag lets us
    // eat corpses that the pet drops (e.g. "lichen corpse").
    if (navCtx.choked && hungerTrimmed !== 'Satiated') {
      navCtx.choked = false;
    }
    const shouldEat = isHungryCombined && !noFood && !navCtx.choked &&
                      (tickCount - navCtx.lastEatTick) > eatCooldown &&
                      (!wallSearchActive || isWeak);
    if (shouldEat) {
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
