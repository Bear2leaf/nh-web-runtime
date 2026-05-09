/**
 * Input buffering and key dispatch.
 *
 * NetHack's input loop calls shim_nhgetch/shim_nh_poskey which
 * return Promises. This module manages the queue that resolves them.
 */

import S from './state.js';
import { log } from './ui.js';

export function waitForKey() {
    log('waitForKey called, buffer len:', S.inputBuffer.length);
    return new Promise((resolve) => {
        if (S.inputBuffer.length > 0) {
            const key = S.inputBuffer.shift();
            log('waitForKey: resolving with buffered key:', key);
            resolve(key);
        } else {
            S.inputResolve = resolve;
            log('waitForKey: waiting for input...');
        }
    });
}

export function clearInputBuffer() {
    const cleared = S.inputBuffer.length;
    if (cleared > 0) {
        log('Clearing input buffer, removed', cleared, 'keys');
        S.inputBuffer.length = 0;
    }
}

export function sendKey(keyCode) {
    log('sendKey:', keyCode, 'inputResolve=', S.inputResolve ? 'yes' : 'null', 'bufferLen=', S.inputBuffer.length);
    if (S.inputResolve) {
        const resolve = S.inputResolve;
        S.inputResolve = null;
        resolve(keyCode);
    } else {
        S.inputBuffer.push(keyCode);
        log('key buffered, buffer len:', S.inputBuffer.length);
    }
}

export function submitCommand() {
    const input = document.getElementById('command-input');
    const cmd = input.value;
    input.value = '';
    if (cmd) {
        for (let i = 0; i < cmd.length; i++) {
            sendKey(cmd.charCodeAt(i));
        }
        sendKey(13); // Enter
    }
}

// ---- Periodic safety flushes (prevent stuck input) ---------------------

setInterval(() => {
    if (S.inputBuffer.length > 0 && S.inputResolve) {
        log('interval: flushing buffered key');
        const key = S.inputBuffer.shift();
        const resolve = S.inputResolve;
        S.inputResolve = null;
        resolve(key);
    }
}, 100);

setInterval(() => {
    if (S.inputBuffer.length > 0 && S.inputBuffer.length === S.lastInputBufferLen) {
        S.stuckCounter++;
        if (S.stuckCounter > 5) {
            log('WARNING: input appears stuck, buffer=' + S.inputBuffer.length +
                ', waiting=' + (S.inputResolve ? 'yes' : 'no') +
                ', nethackReady=' + S.nethackReady);
            log('menuItems count=' + S.menuItems.length + ', lastQuery=' + S.lastQuery);
            log('Callback stats:', JSON.stringify(S.callback_call_count));
            if (!S.callback_call_count['shim_nhgetch'] && !S.callback_call_count['shim_nh_poskey']) {
                log('ERROR: nhgetch/nh_poskey never called! Game may be stuck before moveloop.');
            }
        }
    } else {
        S.stuckCounter = 0;
    }
    S.lastInputBufferLen = S.inputBuffer.length;
}, 200);
