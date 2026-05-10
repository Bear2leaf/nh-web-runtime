/**
 * helpers.js — Playwright test helpers for NetHack Web Runtime e2e tests.
 *
 * Exported functions:
 *   completeCharacterCreation(page) — drives the YN prompt + character menu flow
 *   dismissAnyModal(page)           — presses Escape to dismiss any visible modal
 */

import { test, expect } from '@playwright/test';

/**
 * Navigate through NetHack's character creation flow.
 * YN prompt -> confirmation menu -> dungeon entrance.
 */
export async function completeCharacterCreation(page) {
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 60000 }
  );

  // Step 1: YN prompt - auto-pick character
  await page.waitForFunction(
    () => {
      const m = document.getElementById('yn-modal');
      return m && !m.classList.contains('hidden');
    },
    { timeout: 30000 }
  );
  await page.keyboard.press('y');
  await page.waitForTimeout(800);

  // Step 2: Character confirmation menu - click "Yes; start game"
  let menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);
  if (menuVisible) {
    await page.locator('.menu-item').first().click();
    await page.waitForTimeout(800);
  }

  // Step 3: Handle any remaining menus
  for (let i = 0; i < 5; i++) {
    menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);
    const ynVisible = await page.locator('#yn-modal').isVisible().catch(() => false);

    if (ynVisible) {
      await page.keyboard.press('y');
      await page.waitForTimeout(500);
    } else if (menuVisible) {
      await page.click('body');
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    } else {
      break;
    }
  }

  // Step 4: Wait for dungeon to render
  await page.waitForFunction(
    () => {
      const map = document.getElementById('game-map');
      if (!map) return false;
      return /[|@.#\-+<]/.test(map.innerText);
    },
    { timeout: 30000 }
  );
}

export async function dismissAnyModal(page) {
  const ynVisible = await page.locator('#yn-modal').isVisible().catch(() => false);
  const menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);
  if (ynVisible || menuVisible) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}
