/**
 * node-runner.js — NetHack Navigation AI batch test runner.
 *
 * Usage: node test/node-runner.js [max_tries] [concurrency]
 *   max_tries:   total number of trials (default: 1)
 *   concurrency: number of parallel workers (default: 4)
 *
 * Dual-mode file:
 *   - Default (scheduler): forks worker pool, assigns trials, prints stats.
 *   - Worker (NH_WORKER=1): loads WASM factory once, creates a fresh module
 *     instance for each trial via IPC on demand.
 *
 * Each trial gets a brand-new WASM module instance to avoid Asyncify state
 * corruption that occurs when trying to restart a game within the same
 * instance. Module instantiation is fast (~30 ms) so per-trial overhead is
 * minimal.
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

async function createModule() {
    const ModuleFactory = await getModuleFactory();
    const mod = await ModuleFactory({
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
    globalThis.nethackModule = mod;
    return mod;
}

async function runOneTrial(trialNum, totalTrials) {
    console.log(`[WORKER] runOneTrial(${trialNum}) starting...`);

    // Stagger starts to avoid seed clustering: NetHack seeds from the
    // current time (second granularity), so workers starting in the same
    // second get the same map. Use trialNum to spread across seconds.
    await new Promise(r => setTimeout(r, (trialNum % 10) * 1200 + Math.random() * 500));

    // Create a fresh module instance for every trial to avoid Asyncify
    // state corruption from prior games.
    const mod = await createModule();
    shimNode.resetShimState();

    mod.ccall('main', 'number', ['number', 'string'], [0, ''], { async: true })
        .then(() => { shimNode.shimState.done = true; })
        .catch((err) => {
            const msg = err?.message || String(err);
            // Emscripten may throw ExitStatus when the game ends naturally
            if (msg.includes('program exited') || msg.includes('ExitStatus') || err?.status === 0) {
                shimNode.shimState.done = true;
            } else {
                console.log(`[RUNNER] main() error:`, msg);
            }
        });
    console.log(`[WORKER] Trial ${trialNum}: main() called`);

    // Wait for dlvl to be populated (the game may still be initializing).
    console.log(`[WORKER] Trial ${trialNum}: waiting for dlvl...`);
    await shimNode.waitForCondition(() => shimNode.shimState.dlvl !== '', 60000, 200);
    console.log(`[WORKER] Trial ${trialNum}: dlvl = ${shimNode.shimState.dlvl}`);
    const startDlvl = shimNode.shimState.dlvl;
    const env = new NHNodeEnv(shimNode.shimState, shimNode.sendKey);

    return new Promise((resolve) => {
        let resolved = false;
        let timeoutId;
        let counterCheckId;
        const startCounter = mod.ccall('shim_get_game_counter', 'number', [], [], { async: false });

        const onDone = (reason) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            clearInterval(counterCheckId);

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

        // Poll game counter: if it increments, player died and game restarted
        counterCheckId = setInterval(() => {
            if (resolved) return;
            try {
                const currentCounter = mod.ccall('shim_get_game_counter', 'number', [], [], { async: false });
                if (currentCounter > startCounter) {
                    console.log(`[SINGLE] trial=${trialNum}/${totalTrials} detected death (counter ${startCounter} -> ${currentCounter})`);
                    onDone('died');
                }
            } catch (e) {
                // ignore
            }
        }, 500);

        timeoutId = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            clearInterval(counterCheckId);
            console.log(`[SINGLE] trial=${trialNum}/${totalTrials} result=max-ticks code=124`);
            resolve({ reason: 'max-ticks', code: 124, hp: '?', lastMsgs: [] });
        }, 2 * 60 * 1000);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  WORKER MODE
// ═══════════════════════════════════════════════════════════════════════════

if (process.env.NH_WORKER === '1') {
    // Set up message handler BEFORE any async work so we don't miss the
    // first 'run' message from the scheduler.
    process.on('message', async (msg) => {
        if (msg.type === 'run') {
            try {
                const result = await runOneTrial(msg.trialNum, msg.trialNum);
                if (process.send) process.send({ type: 'result', result });
            } catch (e) {
                console.error('[WORKER] Error in runOneTrial:', e?.message || e);
                if (process.send) process.send({ type: 'result', result: { reason: 'error', code: 1, hp: '?', lastMsgs: [e?.message || String(e)] } });
            }
            // Exit after each trial so the next trial gets a clean process.
            process.exit(0);
        } else if (msg.type === 'exit') {
            process.exit(0);
        }
    });

    if (process.send) process.send({ type: 'ready' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCHEDULER MODE
// ═══════════════════════════════════════════════════════════════════════════

else {
    const max_tries = parseInt(process.argv[2], 10) || 1;
    const concurrency = parseInt(process.argv[3], 10) || 4;

    const results = { descended: 0, died: 0, 'game-ended': 0, stuck: 0, 'max-ticks': 0, other: 0 };
    const details = [];

    console.log(`[RUNNER] Starting ${max_tries} trials with concurrency=${concurrency}...`);

    let nextTrial = 1;
    let completed = 0;
    let activeWorkers = 0;

    function spawnWorkerAndAssign() {
        if (nextTrial > max_tries) return;
        const trialNum = nextTrial++;
        const startTime = Date.now();
        activeWorkers++;

        const worker = fork(__filename, [], {
            cwd: process.cwd(),
            env: { ...process.env, NH_WORKER: '1' },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });

        let readyReceived = false;
        worker.on('message', (msg) => {
            if (msg.type === 'ready' && !readyReceived) {
                readyReceived = true;
                worker.send({ type: 'run', trialNum });
                return;
            }
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
        });

        worker.on('exit', () => {
            activeWorkers--;
            if (nextTrial <= max_tries) {
                spawnWorkerAndAssign();
            }
        });

        worker.on('error', (err) => {
            console.error(`[RUNNER] Worker error for trial ${trialNum}:`, err);
            activeWorkers--;
            results['other'] = (results['other'] || 0) + 1;
            completed++;
            if (nextTrial <= max_tries) {
                spawnWorkerAndAssign();
            }
        });
    }

    // Seed the initial worker pool
    for (let i = 0; i < concurrency; i++) {
        spawnWorkerAndAssign();
    }

    await new Promise((resolve) => {
        const check = () => {
            if (completed >= max_tries && activeWorkers === 0) {
                resolve();
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });

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
