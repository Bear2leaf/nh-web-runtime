/**
 * WASM initialization, nethackGlobal setup, and keyboard event wiring.
 *
 * This is the "bootstrap" module — imported by game.js and nothing else.
 * It wires together all other modules and starts the game.
 */

import S from './state.js';
import { log, addMessage } from './ui.js';
import { initMap } from './map.js';
import { sendKey, submitCommand } from './input.js';
import { nethackShimCallback, SHIM_FORMATS, getPointerValue, setPointerValue } from './shim.js';

// ---- nethackGlobal pre-init (must happen before WASM loads) ---------------

export function initGame() {
    log('初始化 NetHack WASM...');

    globalThis.nethackShimCallback = nethackShimCallback;

    globalThis.nethackGlobal = {
        helpers: {
            getPointerValue,
            setPointerValue,
            sendKey,
            displayInventory() {
                if (S.mod && S.mod._display_inventory) S.mod._display_inventory(0, 0);
            },
            getMap() {
                // Return a copy of the current map grid (80x21 array of chars)
                return S.mapRows.map(row => row.slice());
            },
        },
        constants: {},
        globals: {
            get inputResolve() { return S.inputResolve; },
            get inputBufferLen() { return S.inputBuffer.length; },
            get callback_call_count() { return S.callback_call_count; },
        },
        pointers: {},
        shimFunctionRunning: null,
        statusValues: {},
    };
    log('nethackGlobal 已预初始化');

    // Module config
    const moduleConfig = {
        noInitialRun: true,
        arguments: ['nethack', '-D', 'notutorial'],
        print: (text) => {
            log('WASM-OUT:', text);
            if (text && text.trim()) addMessage(text.trim());
        },
        printErr: (text) => {
            log('WASM-ERR:', text);
        },

        onRuntimeInitialized() {
            log('onRuntimeInitialized - 设置 shim 回调');
            const mod = this;
            globalThis.nethackModule = mod;

            try {
                mod.ccall('shim_graphics_set_callback', null, ['string'], ['nethackShimCallback']);
                log('shim 回调已设置');
            } catch (e) {
                log('设置失败:', e);
            }
        },
    };

    log('初始化 WASM 模块...');

    const factory = globalThis.nethackModuleFactory;
    if (typeof factory !== 'function') {
        log('错误: Module factory 未找到');
        addMessage('加载失败');
        return;
    }

    factory(moduleConfig).then((instance) => {
        S.mod = instance;
        log('WASM 加载完成，启动游戏...');
        document.getElementById('loading').classList.add('hidden');
        S.nethackReady = true;
        log('nethackReady = true');
        try {
            log('Calling main...');
            S.mod.ccall('main', 'number', ['number', 'string'], [0, ''], { async: true })
                .then(() => log('main 函数返回（正常不应返回）'))
                .catch((err) => log('main 函数错误:', err));
            log('游戏已启动');
        } catch (e) {
            log('启动失败:', e);
            addMessage('启动失败: ' + e.message);
        }
    }).catch((e) => {
        log('加载失败:', e);
        addMessage('加载失败: ' + e.message);
        document.getElementById('loading').classList.add('hidden');
    });
}

// ---- Keyboard event listeners ----------------------------------------------

document.addEventListener('keydown', function(e) {
    if (!S.nethackReady) return;

    // YN modal
    const ynModal = document.getElementById('yn-modal');
    if (ynModal && !ynModal.classList.contains('hidden')) {
        let keyCode;
        if (e.key === '*') {
            keyCode = '*'.charCodeAt(0);
        } else if (e.key.length === 1) {
            keyCode = e.key.charCodeAt(0);
        } else {
            const keyMap = { 'Enter': 13, 'Escape': 27, 'NumpadMultiply': 42 };
            keyCode = keyMap[e.key] || e.keyCode || e.which;
        }
        e.preventDefault();
        e.stopPropagation();
        if (S.currentYnResolve) {
            S.currentYnResolve(keyCode);
        }
        return;
    }

    // Menu modal
    const menuModal = document.getElementById('menu-modal');
    if (menuModal && !menuModal.classList.contains('hidden')) {
        let keyCode;
        if (e.key.length === 1) {
            keyCode = e.key.charCodeAt(0);
        } else {
            const keyMap = { 'Enter': 13, 'Escape': 27, 'Space': 32 };
            keyCode = keyMap[e.key] || e.keyCode || e.which;
        }
        e.preventDefault();
        e.stopPropagation();
        if (S.currentMenuResolve) {
            S.currentMenuResolve(keyCode);
        }
        return;
    }

    if (document.activeElement === document.getElementById('command-input') && e.key !== 'Enter') {
        return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', ' '].includes(e.key)) {
        e.preventDefault();
    }

    let keyCode;
    // Ignore modifier-only and special keys
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const GAME_KEYS = {
        'Enter': 13, 'Escape': 27, 'Backspace': 8,
        'ArrowUp': 107, 'ArrowDown': 106, 'ArrowLeft': 104, 'ArrowRight': 108,
    };

    if (e.key.length === 1) {
        keyCode = e.key.charCodeAt(0);
    } else if (GAME_KEYS[e.key]) {
        keyCode = GAME_KEYS[e.key];
    } else {
        return; // ignore Tab, F1-F12, Shift, CapsLock, etc.
    }
    sendKey(keyCode);
});

// Command input box
document.getElementById('command-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submitCommand();
    }
});

// Virtual keyboard buttons
document.querySelectorAll('.vkey').forEach(el => {
    el.addEventListener('click', function() {
        sendKey(this.dataset.key.charCodeAt(0));
    });
});
