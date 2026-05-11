/**
 * node-runner.js — Node.js test runner for NetHack WASM with nav-ai.
 *
 * Loads the WASM module directly, bypasses the browser, and runs
 * the same nav-ai code via the NHNodeEnv adapter.
 *
 * Usage: node test/node-runner.js
 */

import shimNode from '../src/shim-node.js';
import { NHNodeEnv } from './nav-env-node.js';

// Import nav modules in dependency order (IIFEs set globalThis.NHNav)
import './nav-core.mjs';
import './nav-modal.mjs';
import './nav-hp-hunger.mjs';
import './nav-combat.mjs';
import './nav-food.mjs';
import './nav-stuck.mjs';
import './nav-stairs.mjs';
import './nav-door.mjs';
import './nav-corridor.mjs';
import './nav-wall-search.mjs';
import './nav-explore.mjs';
import './nav-boulder-pet.mjs';
import './nav-level-explore.mjs';
import './nav-teleport.mjs';
import { startNavigation } from './nav-ai.mjs';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// Locate WASM files
const WASM_DIR = join(ROOT, 'NetHack', 'targets', 'wasm');
const WASM_JS = join(WASM_DIR, 'nethack.js');
const WASM_BIN = join(WASM_DIR, 'nethack.wasm');

console.log('[RUNNER] WASM JS:', WASM_JS);
console.log('[RUNNER] WASM BIN:', WASM_BIN);

// ---- Load WASM module ----

const require = createRequire(import.meta.url);

// Load the nethack.js ESM module
const nethackModuleUrl = `file://${WASM_JS}`;
const { default: ModuleFactory } = await import(nethackModuleUrl).catch(e => {
    console.error('[RUNNER] Failed to load nethack.js:', e.message);
    console.error('[RUNNER] Make sure you have built the WASM: make');
    process.exit(1);
});

console.log('[RUNNER] Module factory loaded');

// ---- Instantiate WASM ----

const mod = await ModuleFactory({
    noInitialRun: true,
    arguments: ['nethack', '-D', 'notutorial'],
    print: (text) => console.log('[WASM-OUT]', text),
    printErr: (text) => console.log('[WASM-ERR]', text),
    locateFile: (f) => {
        if (f === 'nethack.wasm' || f.endsWith('.wasm')) {
            return `file://${WASM_BIN}`;
        }
        return f;
    },

    onRuntimeInitialized() {
        console.log('[RUNNER] onRuntimeInitialized');
        globalThis.nethackShimCallback = shimNode.nethackShimCallback;
        this.ccall('shim_graphics_set_callback', null, ['string'], ['nethackShimCallback']);
    },
});

console.log('[RUNNER] WASM module instantiated');

// Give shim access to the module for malloc/UTF8 operations
shimNode.setModule(mod);

// ---- Start the game ----

console.log('[RUNNER] Starting game main()...');
const mainPromise = mod.ccall('main', 'number', ['number', 'string'], [0, ''], { async: true });
mainPromise.then(() => {
    console.log('[RUNNER] main() returned — game loop ended');
    shimNode.shimState.done = true;
}).catch((err) => {
    console.log('[RUNNER] main() error:', err.message);
    shimNode.shimState.done = true;
});

// ---- Wait for character creation ----

console.log('[RUNNER] Waiting for character creation...');
try {
    await shimNode.waitForCondition(() => shimNode.shimState.dlvl !== '', 60000, 200);
    console.log('[RUNNER] Character creation complete, dlvl=' + shimNode.shimState.dlvl);
} catch (e) {
    console.error('[RUNNER] Timeout waiting for character creation');
    console.error('[RUNNER] State:', JSON.stringify({
        dlvl: shimNode.shimState.dlvl,
        hp: shimNode.shimState.hp,
        msgs: shimNode.shimState.messages.slice(-5),
        callbacks: shimNode.shimState.callback_call_count,
    }));
    process.exit(1);
}

// ---- Start nav-ai ----

const startDlvl = shimNode.shimState.dlvl;
const env = new NHNodeEnv(shimNode.shimState, shimNode.sendKey);

console.log('[RUNNER] Starting nav-ai with startDlvl=' + startDlvl);

startNavigation(startDlvl, (reason) => {
    console.log(`[RUNNER] Navigation ended: ${reason}`);
    const finalDlvl = shimNode.shimState.dlvl;
    const lastMsgs = shimNode.shimState.messages.slice(-10);
    console.log(`[RUNNER] Last messages: ${JSON.stringify(lastMsgs)}`);
    if (finalDlvl !== startDlvl) {
        console.log(`[RUNNER] SUCCESS: Descended from ${startDlvl} to ${finalDlvl}`);
        process.exit(0);
    } else if (reason === 'died' || reason === 'game-ended') {
        console.log(`[RUNNER] Player died on level ${finalDlvl} (HP=${shimNode.shimState.hp}/${shimNode.shimState.maxHp})`);
        process.exit(1);
    } else {
        console.log(`[RUNNER] Navigation stopped: ${reason}`);
        process.exit(reason === 'stuck' ? 2 : 1);
    }
}, env);

// ---- Keep event loop alive ----

function drive() {
    if (shimNode.shimState.done) {
        console.log('[RUNNER] Game exited (shim_exit_nhwindows)');
        process.exit(0);
    }
    setImmediate(drive);
}
drive();

// ---- Timeout ----

const TIMEOUT = 5 * 60 * 1000; // 5 minutes
setTimeout(() => {
    console.log(`[RUNNER] Timeout after ${TIMEOUT / 1000}s`);
    console.log('[RUNNER] State:', JSON.stringify({
        dlvl: shimNode.shimState.dlvl,
        hp: shimNode.shimState.hp,
        msgs: shimNode.shimState.messages.slice(-5),
        callbacks: shimNode.shimState.callback_call_count,
    }));
    process.exit(124);
}, TIMEOUT);
