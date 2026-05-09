/**
 * NetHack Web Runtime — Entry Point
 *
 * Loads as an ES module from index.html.
 * Re-exports the public API so callers can import from here,
 * and kicks off the game on DOMContentLoaded.
 *
 * Version: 2026-05-09-001
 */

import { initGame } from './src/init.js';
import { nethackShimCallback } from './src/shim.js';

// Global error handlers
window.addEventListener('error', (e) => {
    console.error('[NH] Global error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[NH] Unhandled promise rejection:', e.reason);
});

console.log('[NH] game.js loaded, version 2026-05-09-001');

// Expose public API on global for external callers (e.g. Playwright tests)
globalThis.sendKey = (await import('./src/input.js')).sendKey;
globalThis.nethackShimCallback = nethackShimCallback;

// Boot
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[NH] DOM 就绪，初始化...');

    globalThis._NH_USE_ORIGINAL_SHIM = true;

    try {
        console.log('[NH] 导入 nethack.js 模块...');
        const nethackModule = await import('./NetHack/targets/wasm/nethack.js');
        globalThis.nethackModuleFactory = nethackModule.default;
        console.log('[NH] nethack.js 模块已加载（原始 shim 模式）');
        initGame();
    } catch (e) {
        console.error('[NH] 导入 nethack.js 失败:', e);
        const loading = document.getElementById('loading');
        if (loading) loading.classList.add('hidden');
    }
});
