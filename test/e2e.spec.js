import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { completeCharacterCreation, dismissAnyModal } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAGE_URL = 'http://127.0.0.1:8100/index.html';

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

  test('YN dialog responds to keyboard input', async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);

    // Trigger a YN prompt by trying to quit
    await page.keyboard.press('S');
    await page.waitForTimeout(1000);

    const ynVisible = await page.locator('#yn-modal').isVisible().catch(() => false);
    const menuVisible = await page.locator('#menu-modal').isVisible().catch(() => false);

    // A YN or menu should appear
    expect(ynVisible || menuVisible).toBe(true);

    // Dismiss it with 'n' or Escape
    if (ynVisible) {
      await page.keyboard.press('n');
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(500);

    // Verify the modal is gone
    const ynGone = !(await page.locator('#yn-modal').isVisible().catch(() => false));
    const menuGone = !(await page.locator('#menu-modal').isVisible().catch(() => false));
    expect(ynGone && menuGone).toBe(true);
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

  /**
   * Walk to the next level by finding and descending a staircase.
   *
   * Loads nav-ai.js into the browser and starts the autonomous navigation AI.
   */
  test('walks to next level', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await completeCharacterCreation(page);
    await page.waitForTimeout(500);

    // Capture browser console for nav-ai debugging
    const navLogs = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.startsWith('[NAV]') || text.startsWith('[TEST]')) {
        navLogs.push(text);
        console.log(text);
      }
    });

    const startDlvl = (await page.locator('#stat-dlvl').textContent() || '').trim();

    // Expose a global result that the test can poll
    await page.evaluate(() => { window.__navResult = null; });

    // Inject nav modules in dependency order: core -> strategy -> ai -> browser-env
    for (const filename of ['nav-core.mjs', 'nav-strategy.mjs', 'nav-ai.mjs', 'nav-browser-env.mjs']) {
      const modulePath = path.join(__dirname, filename);
      const code = fs.readFileSync(modulePath, 'utf-8')
        .replace(/^export\b[\s\S]*$/m, ''); // Strip ES module exports (multiline-safe)
      await page.evaluate((c) => {
        const script = document.createElement('script');
        script.textContent = c;
        document.head.appendChild(script);
      }, code);
    }

    // Verify the AI loaded
    const aiLoaded = await page.evaluate(() => typeof window.startNavigation === 'function');
    if (!aiLoaded) {
      console.log('[TEST] ERROR: nav-ai.js failed to load!');
    }

    // Start the navigation AI with the browser env adapter
    const aiStarted = await page.evaluate((start) => {
      if (typeof window.startNavigation !== 'function') {
        console.error('[NAV] startNavigation not found!');
        return false;
      }
      if (typeof window.NHBrowserEnv !== 'function') {
        console.error('[NAV] NHBrowserEnv not found!');
        return false;
      }
      console.log('[TEST] Calling startNavigation with startDlvl=' + start);
      const env = new window.NHBrowserEnv();
      window.startNavigation(start, (reason) => {
        console.log('[NAV] Navigation ended:', reason);
        window.__navResult = reason;
      }, env);
      return true;
    }, startDlvl);
    console.log('[TEST] AI started:', aiStarted);

    // Quick check: is the AI actually running?
    await page.waitForTimeout(2000);
    const aiCheck = await page.evaluate(() => {
      const nhNav = window.nethackGlobal?.helpers;
      const globals = window.nethackGlobal?.globals || {};
      const hasResolve = globals?.inputResolve ? 'yes' : 'no';
      const bufLen = globals?.inputBufferLen || 0;
      const sendKeyType = typeof nhNav?.sendKey;
      const callbacks = globals?.callback_call_count || {};
      const nhPoskey = callbacks['shim_nh_poskey'] || 0;
      const nhGetch = callbacks['shim_nhgetch'] || 0;
      return { sendKeyType, hasResolve, bufLen, nhPoskey, nhGetch };
    });
    console.log('[TEST] AI check after 2s:', JSON.stringify(aiCheck));

    // Periodic debug: log map state every 15 seconds
    const debugInterval = setInterval(async () => {
      try {
        const debug = await page.evaluate(() => {
          const map = window.nethackGlobal?.helpers?.getMap();
          const statDlvl = document.getElementById('stat-dlvl')?.textContent?.trim();
          const statHp = document.getElementById('stat-hp')?.textContent?.trim();
          let playerPos = null, stairsDown = null, stairsUp = null;
          const rowSummaries = [];
          if (map) {
            for (let y = 0; y < 21; y++) {
              const row = (map[y]||'');
              const nonSpace = [];
              for (let x = 0; x < 80; x++) {
                const ch = row[x] || ' ';
                if (ch !== ' ') {
                  nonSpace.push(`${ch}@${x}`);
                  if (ch === '@') playerPos = `${x},${y}`;
                  if (ch === '>') stairsDown = `${x},${y}`;
                  if (ch === '<') stairsUp = `${x},${y}`;
                }
              }
              if (nonSpace.length > 0) rowSummaries.push(`r${y}:${nonSpace.join(',')}`);
            }
          }
          const msgs = document.querySelectorAll('#message-panel .message');
          const last3 = [];
          for (let i = Math.max(0, msgs.length - 3); i < msgs.length; i++) {
            last3.push(msgs[i].textContent?.trim());
          }
          const stats = window.nethackGlobal?.globals?.callback_call_count || {};
          const inputWaiting = window.nethackGlobal?.globals?.inputResolve ? 'yes' : 'no';
          return { dlvl: statDlvl, hp: statHp, player: playerPos, down: stairsDown, up: stairsUp, rows: rowSummaries.length, msgs: last3, stats, inputWaiting };
        });
        console.log(`[TEST-DEBUG] dlvl=${debug.dlvl} hp=${debug.hp} p=${debug.player} dn=${debug.down} up=${debug.up} rows=${debug.rows} input=${debug.inputWaiting} stats=${JSON.stringify(debug.stats)} msgs=${JSON.stringify(debug.msgs)}`);
      } catch (e) { console.log('[TEST-DEBUG] Error:', e.message); }
    }, 15_000);

    // Wait for either: dlvl change (success), death (HP=0), or nav result (stuck/died/etc)
    const finalResult = await page.waitForFunction(
      (start) => {
        const dlvlEl = document.getElementById('stat-dlvl');
        const hpEl = document.getElementById('stat-hp');
        const hp = hpEl ? parseInt(hpEl.textContent.trim()) : 999;
        const dlvl = dlvlEl ? dlvlEl.textContent.trim() : start;
        if (dlvl !== start) return { reason: 'descended', dlvl };
        if (hp === 0) return { reason: 'died', dlvl };
        if (window.__navResult) return { reason: window.__navResult, dlvl };
        return null;
      },
      startDlvl,
      { timeout: 180_000, polling: 500 }
    );

    clearInterval(debugInterval);

    const result = await finalResult.jsonValue();
    console.log('[TEST] Final result:', JSON.stringify(result));
    expect(result.reason).toBe('descended');
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
