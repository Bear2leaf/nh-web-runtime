const { test, expect } = require('@playwright/test');

const PAGE_URL = 'http://127.0.0.1:8100/index.html';

/**
 * Navigate through NetHack's character creation flow.
 * YN prompt -> confirmation menu -> dungeon entrance.
 */
async function completeCharacterCreation(page) {
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
      return /[|@.#\-+<>]/.test(map.innerText);
    },
    { timeout: 30000 }
  );
}

async function dismissAnyModal(page) {
  const ynVisible = await page.locator('#yn-modal').isVisible().catch(() => false);
  const menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);
  if (ynVisible || menuVisible) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

test.describe('NetHack Web Runtime', () => {

  test.beforeEach(async ({ page }) => {
    page.on('pageerror', err => console.log(`[PAGE ERROR] ${err.message}`));
  });

  test('page loads and title is correct', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('.header h1')).toHaveText(/NetHack/);
  });

  test('WASM loads and dungeon renders after character creation', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    const mapText = await page.locator('#game-map').innerText();
    expect(mapText.length).toBeGreaterThan(100);
    expect(/[|@.#\-+<]/.test(mapText)).toBe(true);
  });

  test('status bar shows character stats', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);
    await page.waitForTimeout(2000);

    const hp = await page.locator('#stat-hp').textContent();
    expect(hp).not.toBe('--');

    const level = await page.locator('#stat-level').textContent();
    expect(level).not.toBe('--');
  });

  test('character movement with keyboard', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    await page.click('body');
    await page.waitForTimeout(200);

    await page.keyboard.press('j');
    await page.waitForTimeout(800);

    const mapVisible = await page.locator('#game-map').isVisible();
    expect(mapVisible).toBe(true);
  });

  test('message panel accumulates messages', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);
    await page.waitForTimeout(1000);

    const messages = await page.locator('#message-panel .message').count();
    expect(messages).toBeGreaterThan(0);
  });

  test('YN dialog responds to prompts', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    await page.click('body');
    await page.waitForTimeout(200);
    await page.keyboard.press('q');
    await page.waitForTimeout(1000);

    const ynVisible = await page.locator('#yn-modal').isVisible().catch(() => false);
    const menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);
    expect(ynVisible || menuVisible).toBe(true);

    await dismissAnyModal(page);
  });

  test('inventory panel populates', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    const input = page.locator('#command-input');
    await input.fill('i');
    await input.press('Enter');
    await page.waitForTimeout(1500);

    const invText = await page.locator('#inventory-list').textContent();
    expect(invText.length).toBeGreaterThan(0);

    await dismissAnyModal(page);
  });

  test('extended play session', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    await page.click('body');
    await page.waitForTimeout(200);

    for (const key of ['j', 'j', 'l', 'l', 'k', 'h', '.', 'j', 'j', 'l']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(400);
    }

    await page.screenshot({ path: 'playtest-screenshot.png', fullPage: true });
    const hp = await page.locator('#stat-hp').textContent();
    expect(hp).not.toBe('--');
  });

  test('virtual keyboard on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    const vk = page.locator('.virtual-keyboard');
    await expect(vk).toBeVisible({ timeout: 5000 });

    await page.locator('.vkey[data-key="j"]').click();
    await page.waitForTimeout(500);

    const mapVisible = await page.locator('#game-map').isVisible();
    expect(mapVisible).toBe(true);
  });
});
