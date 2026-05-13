/**
 * node-runner.js — NetHack Navigation AI batch test runner.
 *
 * Usage: node test/node-runner.js [max_tries] [concurrency]
 *   max_tries:   total number of trials (default: 1)
 *   concurrency: number of parallel workers (default: 4)
 *
 * Dual-mode file:
 *   - Default (scheduler): forks worker pool, assigns trials, prints stats.
 *   - Worker (NH_WORKER=1): loads WASM once, runs trials via IPC on demand.
 *
 * Each trial re-instantiates the WASM module (~25ms), keeping trials isolated
 * without the per-trial process spawn overhead.
 */

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import shimNode from '../src/shim-node.js';
import { NHNodeEnv } from './nav-env-node.js';

// Nav modules (IIFEs set globalThis.NHNav)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── WASM paths ────────────────────────────────────────────────────────────
const WASM_DIR = join(__dirname, '..', 'NetHack', 'targets', 'wasm');
const WASM_JS  = join(WASM_DIR, 'nethack.js');
const WASM_BIN = join(WASM_DIR, 'nethack.wasm');

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED CORE
// ═══════════════════════════════════════════════════════════════════════════

let _moduleFactory = null;

async function getModuleFactory() {
    if (_moduleFactory) return _moduleFactory;
    const nethackModuleUrl = `file://${WASM_JS}`;
    const { default: ModuleFactory } = await import(nethackModuleUrl).catch(e => {
        console.error('[RUNNER] Failed to load nethack.js:', e.message);
        console.error('[RUNNER] Make sure you have built the WASM: make');
        process.exit(1);
    });
    _moduleFactory = ModuleFactory;
    return ModuleFactory;
}

async function runOneTrial(trialNum, totalTrials) {
    shimNode.resetShimState();

    const mod = await (await getModuleFactory())({
        noInitialRun: true,
        arguments: ['nethack', '-D', 'notutorial'],
        print: () => {},
        printErr: () => {},
        locateFile: (f) => (f === 'nethack.wasm' || f.endsWith('.wasm')) ? `file://${WASM_BIN}` : f,
        onRuntimeInitialized() {
            globalThis.nethackShimCallback = shimNode.nethackShimCallback;
            this.ccall('shim_graphics_set_callback', null, ['string'], ['nethackShimCallback']);
        },
    });
    shimNode.setModule(mod);

    const mainPromise = mod.ccall('main', 'number', ['number', 'string'], [0, ''], { async: true });
    mainPromise.then(() => { shimNode.shimState.done = true; })
        .catch((err) => { console.log(`[RUNNER] Trial ${trialNum} main() error:`, err.message); shimNode.shimState.done = true; });

    await shimNode.waitForCondition(() => shimNode.shimState.dlvl !== '', 60000, 200);
    const startDlvl = shimNode.shimState.dlvl;
    const env = new NHNodeEnv(shimNode.shimState, shimNode.sendKey);

    return new Promise((resolve) => {
        let resolved = false;
        let timeoutId;

        const onDone = (reason) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);

            const finalDlvl = shimNode.shimState.dlvl;
            const lastMsgs = shimNode.shimState.messages
                .filter(m => !m.includes('Do you want') && !m.includes('Shall I') && !m.includes('What do you want'))
                .slice(-20);
            const hpText = shimNode.shimState.hp;
            const maxHpText = shimNode.shimState.maxHp;
            const hp = hpText && maxHpText ? `${hpText}/${maxHpText}` : '?';

            let code = 1;
            if (finalDlvl !== startDlvl) code = 0;
            else if (reason === 'stuck') code = 2;
            else if (reason === 'max-ticks') code = 124;

            console.log(`[SINGLE] trial=${trialNum}/${totalTrials} result=${reason} code=${code} hp=${hp} msgs=${JSON.stringify(lastMsgs)}`);
            resolve({ reason, code, hp, lastMsgs });
        };

        startNavigation(startDlvl, onDone, env);

        timeoutId = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            console.log(`[SINGLE] trial=${trialNum}/${totalTrials} result=max-ticks code=124`);
            resolve({ reason: 'max-ticks', code: 124, hp: '?', lastMsgs: [] });
        }, 5 * 60 * 1000);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  WORKER MODE
// ═══════════════════════════════════════════════════════════════════════════

if (process.env.NH_WORKER === '1') {
    await getModuleFactory();
    if (process.send) process.send({ type: 'ready' });

    process.on('message', async (msg) => {
        if (msg.type === 'run') {
            const result = await runOneTrial(msg.trialNum, msg.trialNum);
            if (process.send) process.send({ type: 'result', result });
        } else if (msg.type === 'exit') {
            process.exit(0);
        }
    });

    // Keep alive until 'exit' message
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCHEDULER MODE
// ═══════════════════════════════════════════════════════════════════════════

else {
    const max_tries = parseInt(process.argv[2], 10) || 1;
    const concurrency = parseInt(process.argv[3], 10) || 4;

    const results = { descended: 0, died: 0, 'game-ended': 0, stuck: 0, 'max-ticks': 0, other: 0 };
    const details = [];

    function createWorkerPool(size) {
        const workers = [];
        const readyPromises = [];
        for (let i = 0; i < size; i++) {
            const worker = fork(__filename, [], {
                cwd: process.cwd(),
                env: { ...process.env, NH_WORKER: '1' },
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
            const ready = new Promise((resolve) => {
                worker.once('message', (msg) => { if (msg.type === 'ready') resolve(); });
            });
            readyPromises.push(ready);
            workers.push(worker);
        }
        return { workers, ready: Promise.all(readyPromises) };
    }

    console.log(`[RUNNER] Starting ${max_tries} trials with concurrency=${concurrency}...`);

    const { workers, ready } = createWorkerPool(concurrency);
    await ready;

    let nextTrial = 1;
    let completed = 0;

    function assignNext(worker) {
        if (nextTrial > max_tries) return;
        const trialNum = nextTrial++;
        const startTime = Date.now();

        worker.once('message', (msg) => {
            if (msg.type !== 'result') return;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const r = msg.result;

            let reason = 'other';
            if (r.code === 0) reason = 'descended';
            else if (r.code === 1) {
                if (r.reason === 'died' || r.reason === 'game-ended') reason = 'died';
                else reason = 'other';
            } else if (r.code === 2) reason = 'stuck';
            else if (r.code === 124) reason = 'max-ticks';

            const lastMsgs = (r.lastMsgs || []).slice(-5).map(m => m.slice(0, 100)).join(' | ');
            details.push({ i: trialNum, reason, code: r.code, elapsed, hp: r.hp, lastMsgs: lastMsgs.slice(0, 120) });
            results[reason] = (results[reason] || 0) + 1;
            completed++;

            process.stdout.write(`\r[RUNNER] ${completed}/${max_tries} — success=${results.descended} died=${results.died} stuck=${results.stuck} other=${results.other + results['game-ended'] + results['max-ticks']}`);
            assignNext(worker);
        });

        worker.send({ type: 'run', trialNum });
    }

    for (const worker of workers) assignNext(worker);

    await new Promise((resolve) => {
        const check = () => { if (completed >= max_tries) resolve(); else setTimeout(check, 100); };
        check();
    });

    // Shutdown workers
    for (const worker of workers) {
        worker.send({ type: 'exit' });
    }

    // Wait for all workers to actually exit (prevents zombie processes)
    await Promise.all(workers.map(w => new Promise(r => w.on('exit', r))));

    console.log('\n');
    console.log('=== Results ===');
    for (const [k, v] of Object.entries(results)) {
        if (v > 0) console.log(`  ${k}: ${v}/${max_tries} (${(v / max_tries * 100).toFixed(1)}%)`);
    }

    const stuckRuns = details.filter(d => d.reason === 'stuck');
    if (stuckRuns.length > 0) {
        console.log('\n=== Stuck details ===');
        for (const d of stuckRuns.slice(0, 10)) {
            console.log(`  Run #${d.i}: code=${d.code} hp=${d.hp} msgs=${JSON.stringify(d.lastMsgs.slice(0, 120))}`);
        }
    }

    const diedRuns = details.filter(d => d.reason === 'died');
    if (diedRuns.length > 0) {
        console.log('\n=== Died details (last 5) ===');
        for (const d of diedRuns.slice(-5)) {
            console.log(`  Run #${d.i}: hp=${d.hp} msgs=${JSON.stringify(d.lastMsgs.slice(0, 120))}`);
        }
    }

    process.exit(0);
}
