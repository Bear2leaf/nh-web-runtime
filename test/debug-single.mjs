import shimNode from '../src/shim-node.js';
import { NHNodeEnv } from './nav-env-node.js';

import './nav-core.mjs';
import './nav-helpers.mjs';
import './nav-state-update.mjs';
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

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WASM_DIR = join(__dirname, '..', 'NetHack', 'targets', 'wasm');
const WASM_JS  = join(WASM_DIR, 'nethack.js');
const WASM_BIN = join(WASM_DIR, 'nethack.wasm');

const nethackModuleUrl = `file://${WASM_JS}`;
const { default: ModuleFactory } = await import(nethackModuleUrl);

const mod = await ModuleFactory({
    noInitialRun: true,
    arguments: ['nethack', '-D', 'notutorial'],
    print: (s) => console.log('[WASM]', s),
    printErr: (s) => console.error('[WASM-ERR]', s),
    locateFile: (f) => (f === 'nethack.wasm' || f.endsWith('.wasm')) ? `file://${WASM_BIN}` : f,
    onRuntimeInitialized() {
        globalThis.nethackShimCallback = shimNode.nethackShimCallback;
        this.ccall('shim_graphics_set_callback', null, ['string'], ['nethackShimCallback']);
    },
});

shimNode.setModule(mod);
globalThis.nethackModule = mod;

// Create module and start game
mod.ccall('main', 'number', ['number', 'string'], [0, ''], { async: true })
    .then(() => { shimNode.shimState.done = true; })
    .catch((err) => {
        const msg = err?.message || String(err);
        if (msg.includes('program exited') || msg.includes('ExitStatus') || err?.status === 0) {
            shimNode.shimState.done = true;
        } else {
            console.log('[RUNNER] main() error:', msg);
        }
    });

await shimNode.waitForCondition(() => shimNode.shimState.dlvl !== '', 60000, 200);
console.log(`[DEBUG] dlvl = ${shimNode.shimState.dlvl}`);
const startDlvl = shimNode.shimState.dlvl;
const env = new NHNodeEnv(shimNode.shimState, shimNode.sendKey);

const startCounter = mod.ccall('shim_get_game_counter', 'number', [], [], { async: false });

const onDone = (reason) => {
    const finalDlvl = shimNode.shimState.dlvl;
    const lastMsgs = shimNode.shimState.messages.slice(-20);
    const hp = `${shimNode.shimState.hp}/${shimNode.shimState.maxHp}`;
    let code = 1;
    if (finalDlvl !== startDlvl) code = 0;
    else if (reason === 'stuck') code = 2;
    else if (reason === 'max-ticks') code = 124;
    console.log(`[DEBUG] result=${reason} code=${code} hp=${hp} msgs=${JSON.stringify(lastMsgs)}`);
    process.exit(0);
};

startNavigation(startDlvl, onDone, env);

// Poll game counter
setInterval(() => {
    try {
        const currentCounter = mod.ccall('shim_get_game_counter', 'number', [], [], { async: false });
        if (currentCounter > startCounter) {
            console.log(`[DEBUG] detected death (counter ${startCounter} -> ${currentCounter})`);
            onDone('died');
        }
    } catch (e) {
        // ignore
    }
}, 500);

setTimeout(() => {
    console.log('[DEBUG] max-ticks timeout');
    onDone('max-ticks');
}, 5 * 60 * 1000);
