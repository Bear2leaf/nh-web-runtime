/**
 * nethackShimCallback — all shim_xxx callback implementations.
 *
 * Called by the WASM runtime via the shim_graphics_set_callback bridge.
 * Every case must return a Promise (local_callback uses .then()).
 */

import S from './state.js';
import { log, addMessage, clearMessages, clearInventory, addInventoryItem,
         showMenuModal, hideMenuModal, selectMenuItem,
         showYnModal, hideYnModal, selectYnOption,
         setStatusField } from './ui.js';
import { initMap, renderMap, MAP_WIDTH, MAP_HEIGHT } from './map.js';
import { waitForKey, clearInputBuffer, sendKey, submitCommand } from './input.js';
import { updateStatusUI, BL } from './status.js';

// ---- Callback format table (for nethackGlobal.helpers reference) ---------

export const SHIM_FORMATS = {
    'shim_init_nhwindows': { ret: 'v', args: ['p', 'p'] },
    'shim_player_selection_or_tty': { ret: 'b', args: [] },
    'shim_askname': { ret: 'v', args: [] },
    'shim_get_nh_event': { ret: 'v', args: [] },
    'shim_exit_nhwindows': { ret: 'v', args: ['s'] },
    'shim_suspend_nhwindows': { ret: 'v', args: ['s'] },
    'shim_resume_nhwindows': { ret: 'v', args: [] },
    'shim_create_nhwindow': { ret: 'i', args: ['i'] },
    'shim_clear_nhwindow': { ret: 'v', args: ['i'] },
    'shim_display_nhwindow': { ret: 'v', args: ['i', 'b'] },
    'shim_destroy_nhwindow': { ret: 'v', args: ['i'] },
    'shim_curs': { ret: 'v', args: ['i', 'i', 'i'] },
    'shim_putstr': { ret: 'v', args: ['i', 'i', 's'] },
    'shim_display_file': { ret: 'v', args: ['s', 'b'] },
    'shim_start_menu': { ret: 'v', args: ['i', 'i'] },
    'shim_add_menu': { ret: 'v', args: ['i', 'p', 'p', 'c', 'c', 'i', 'i', 's', 'i'] },
    'shim_end_menu': { ret: 'v', args: ['i', 's'] },
    'shim_select_menu': { ret: 'i', args: ['i', 'i', 'p'] },
    'shim_message_menu': { ret: 'c', args: ['c', 'i', 's'] },
    'shim_mark_synch': { ret: 'v', args: [] },
    'shim_wait_synch': { ret: 'v', args: [] },
    'shim_cliparound': { ret: 'v', args: ['i', 'i'] },
    'shim_update_positionbar': { ret: 'v', args: ['s'] },
    'shim_print_glyph': { ret: 'v', args: ['i', 'i', 'i', 'p', 'p'] },
    'shim_raw_print': { ret: 'v', args: ['s'] },
    'shim_raw_print_bold': { ret: 'v', args: ['s'] },
    'shim_nhgetch': { ret: 'i', args: [] },
    'shim_nh_poskey': { ret: 'i', args: ['p', 'p', 'p'] },
    'shim_nhbell': { ret: 'v', args: [] },
    'shim_doprev_message': { ret: 'i', args: [] },
    'shim_yn_function': { ret: 'c', args: ['s', 's', 'c'] },
    'shim_getlin': { ret: 'v', args: ['s', 'p'] },
    'shim_get_ext_cmd': { ret: 'i', args: [] },
    'shim_number_pad': { ret: 'v', args: ['i'] },
    'shim_delay_output': { ret: 'v', args: [] },
    'shim_change_color': { ret: 'v', args: ['i', 'i', 'i'] },
    'shim_change_background': { ret: 'v', args: ['i'] },
    'set_shim_font_name': { ret: 'i', args: ['i', 's'] },
    'shim_get_color_string': { ret: 's', args: [] },
    'shim_preference_update': { ret: 'v', args: ['p'] },
    'shim_getmsghistory': { ret: 's', args: ['b'] },
    'shim_putmsghistory': { ret: 'v', args: ['s', 'b'] },
    'shim_status_init': { ret: 'v', args: [] },
    'shim_status_enablefield': { ret: 'v', args: ['i', 'p', 'p', 'b'] },
    'shim_status_update': { ret: 'v', args: ['i', 'p', 'i', 'i', 'i', 'p'] },
    'shim_player_selection': { ret: 'v', args: [] },
};

// ---- Helpers used by init.js for nethackGlobal.helpers ---------------------

export function getPointerValue(name, ptr, type) {
    if (!S.mod || !S.mod.getValue) return ptr;

    // shim_status_update: ptr is a raw pointer, handled in the callback itself
    if (name === 'shim_status_update' && type === 'p') {
        return ptr;
    }

    switch (type) {
        case 's': return ptr ? S.mod.UTF8ToString(ptr) : '';
        case 'p':
            if (ptr < 1000) return ptr;
            return ptr ? S.mod.getValue(ptr, '*') : 0;
        case 'c': return String.fromCharCode(S.mod.getValue(ptr, 'i8'));
        case 'b': return S.mod.getValue(ptr, 'i8') === 1;
        case '0': return S.mod.getValue(ptr, 'i8');
        case '1': return S.mod.getValue(ptr, 'i16');
        case '2': case 'n': return S.mod.getValue(ptr, 'i32');
        case 'i':
            if (name === 'shim_print_glyph' || name === 'shim_cliparound') {
                return S.mod.getValue(ptr, 'i16');
            }
            return S.mod.getValue(ptr, 'i32');
        case 'f': return S.mod.getValue(ptr, 'float');
        case 'd': return S.mod.getValue(ptr, 'double');
        case 'o': return ptr;
        default: return ptr;
    }
}

export function setPointerValue(name, ptr, type, value) {
    if (!ptr) {
        log('setPointerValue: ptr is null, name=' + name + ' type=' + type);
        return;
    }

    const fmt = SHIM_FORMATS[name] || { ret: type };
    const actualType = fmt.ret || type;

    if (actualType === 's') {
        if (value === null || value === undefined) {
            S.mod.setValue(ptr, 0, 'i32');
            return;
        }
        const str = String(value);
        const len = lengthBytesUTF8(str) + 1;
        const strPtr = S.mod._malloc(len);
        stringToUTF8(str, strPtr, len);
        S.mod.setValue(ptr, strPtr, 'i32');
        return;
    }

    switch (actualType) {
        case 'i': case '2': case 'n':
            S.mod.setValue(ptr, value || 0, 'i32');
            break;
        case 'c': {
            let charCode = 0;
            if (typeof value === 'number') charCode = value;
            else if (typeof value === 'string' && value.length > 0) charCode = value.charCodeAt(0);
            S.mod.setValue(ptr, charCode, 'i8');
            break;
        }
        case 'b':
            S.mod.setValue(ptr, value ? 1 : 0, 'i8');
            break;
        case 'd': case 'f':
            S.mod.setValue(ptr, value || 0, 'double');
            break;
        case 'v':
            break;
        default:
            log('setPointerValue [' + name + ']: unknown type ' + actualType);
    }
}

// ---- Main callback ---------------------------------------------------------

export async function nethackShimCallback(name, ...args) {
    // Track call counts for diagnostics
    S.callback_call_count[name] = (S.callback_call_count[name] || 0) + 1;

    const logNames = ['shim_askname', 'shim_select_menu', 'shim_player_selection',
                      'shim_nhgetch', 'shim_nh_poskey', 'shim_yn_function'];
    if (logNames.includes(name)) {
        log('CB:', name, 'args:', args);
    }

    switch (name) {

    case 'shim_init_nhwindows': {
        initMap();
        globalThis.nethackGlobal._inputLoop = false;
        log('init_nhwindows called');
        return Promise.resolve(0);
    }

    case 'shim_player_selection_or_tty': {
        log('player_selection_or_tty -> true (use genl mode)');
        return Promise.resolve(true);
    }

    case 'shim_askname': {
        log('askname: returning empty (use default)');
        return Promise.resolve('');
    }

    case 'shim_player_selection': {
        log('*** player_selection (选择完成) ***');
        return Promise.resolve();
    }

    case 'shim_get_nh_event': {
        S.get_nh_event_count++;
        const now = Date.now();
        if (now - S.last_log_time > 3000) {
            log('get_nh_event called ' + S.get_nh_event_count +
                ' times, buffer=' + S.inputBuffer.length +
                ', waiting=' + (S.inputResolve ? 'yes' : 'no'));
            S.last_log_time = now;
        }
        if (S.inputBuffer.length > 0 && S.inputResolve) {
            const key = S.inputBuffer.shift();
            const resolve = S.inputResolve;
            S.inputResolve = null;
            log('get_nh_event: flushing buffered key:', key);
            resolve(key);
        }
        return Promise.resolve();
    }

    case 'shim_exit_nhwindows': {
        addMessage('--- 游戏结束 ---');
        S.nethackReady = false;
        return Promise.resolve();
    }

    case 'shim_suspend_nhwindows':
    case 'shim_resume_nhwindows': {
        return Promise.resolve();
    }

    case 'shim_create_nhwindow': {
        // NetHack window types: NHW_MESSAGE=0, NHW_STATUS=1, NHW_MAP=2, NHW_MENU=3, NHW_TEXT=4, NHW_PERMINVENT=6
        const type = args[0];
        log('create_nhwindow type=' + type);
        if (!nethackShimCallback._nextWinId) nethackShimCallback._nextWinId = 1;
        const winid = nethackShimCallback._nextWinId++;

        if (type === 6) { // NHW_PERMINVENT
            nethackShimCallback._inventoryWinId = winid;
            log('Inventory window created with id=' + winid);
        }
        if (type === 2) { // NHW_MAP = 2
            S.mapWinId = winid;
            log('Map window created with id=' + winid + ' (NHW_MAP)');
        }
        return Promise.resolve(winid);
    }

    case 'shim_clear_nhwindow': {
        const winid = args[0];

        if (winid === nethackShimCallback._inventoryWinId) {
            log('clear_nhwindow: clearing inventory winid=' + winid);
            clearInventory();
        }
        if (winid === S.mapWinId) {
            log('clear_nhwindow: clearing MAP winid=' + winid);
            for (let y = 0; y < MAP_HEIGHT; y++) {
                for (let x = 0; x < MAP_WIDTH; x++) {
                    S.mapRows[y][x] = ' ';
                    S.mapColors[y][x] = 0;
                }
            }
        }
        return Promise.resolve();
    }

    case 'shim_display_nhwindow': {
        renderMap();
        return Promise.resolve();
    }

    case 'shim_wait_synch': {
        renderMap();
        return Promise.resolve();
    }

    case 'shim_destroy_nhwindow': {
        return Promise.resolve();
    }

    case 'shim_curs': {
        S.cursorX = args[1];
        S.cursorY = args[2];
        return Promise.resolve();
    }

    case 'shim_putstr': {
        const winid = args[0], attr = args[1], str = args[2];
        const invWinId = nethackShimCallback ? nethackShimCallback._inventoryWinId : null;
        log('putstr: winid=' + winid + ' invWinId=' + invWinId + ' str=' + (str ? str.substring(0, 30) : 'null'));
        if (winid === invWinId && str) {
            log('putstr: adding to inventory');
            addInventoryItem(str, attr);
        } else if (str) {
            addMessage(str, attr);
        }
        return Promise.resolve();
    }

    case 'shim_display_file': {
        const name = args[0];
        log('display_file:', name);
        addMessage('-- 按任意键继续 --');
        renderMap();
        return waitForKey().then(() => 0);
    }

    case 'shim_start_menu': {
        const winid = args[0], mbehavior = args[1];
        log('start_menu: winid=' + winid + ' mbehavior=' + mbehavior);
        S.menuItems = [];
        S.currentMenuWinId = winid;
        S.isInventoryMenuFlag = (winid === 6) || (mbehavior === 1);
        log('start_menu: isInventory=' + S.isInventoryMenuFlag);
        return Promise.resolve();
    }

    case 'shim_add_menu': {
        const strArg = args[7], ch = args[3], acc = args[4], identifier = args[2], attr = args[5];
        let str = '';
        if (typeof strArg === 'string') {
            str = strArg;
        } else if (S.mod && strArg && typeof strArg === 'number') {
            try { str = S.mod.UTF8ToString(strArg); } catch (e) { str = ''; }
        }
        if (str) {
            const chStr = ch ? String.fromCharCode(ch) : '';
            const accStr = acc ? String.fromCharCode(acc) : '';
            // A true header: no group accelerator, no selector, no identifier
            const isHeader = !ch && !acc && !identifier;
            S.menuItems.push({ ch: chStr, acc: accStr, identifier, text: str, selected: false, isHeader });
        }
        return Promise.resolve();
    }

    case 'shim_end_menu': {
        const winid = args[0], promptPtr = args[1];
        let prompt = '选择:';
        if (S.mod && promptPtr) {
            try { prompt = S.mod.UTF8ToString(promptPtr) || '选择:'; } catch (e) { prompt = '选择:'; }
        }
        const hasInventoryHeaders = S.menuItems.some(item =>
            item.isHeader &&
            (item.text.includes('Weapons') || item.text.includes('Armor') ||
             item.text.includes('Comestibles') || item.text.includes('Gems') ||
             item.text.includes('Tools') || item.text.includes('Potions') ||
             item.text.includes('Scrolls'))
        );
        const isRealInventory = S.isInventoryMenuFlag && hasInventoryHeaders;
        const isSelectionPrompt = prompt && (prompt.includes('选择') || prompt.includes('Select') ||
            prompt.includes('drop') || prompt.includes('use'));
        S.lastMenuPrompt = prompt;
        log('end_menu: winid=' + winid + ' prompt="' + prompt + '" items=' + S.menuItems.length +
            ' isInventoryFlag=' + S.isInventoryMenuFlag + ' hasInvHeaders=' + hasInventoryHeaders +
            ' isRealInv=' + isRealInventory + ' isSelection=' + isSelectionPrompt);
        if (isRealInventory && !isSelectionPrompt) {
            log('end_menu: updating inventory panel');
            const list = document.getElementById('inventory-list');
            if (list) {
                list.innerHTML = '';
                list.className = '';
                S.menuItems.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'inventory-item';
                    if (item.isHeader) {
                        div.style.fontWeight = 'bold';
                        div.style.color = '#ffcc00';
                        div.style.marginTop = '8px';
                    }
                    div.textContent = (item.ch ? '[' + item.ch + '] ' : '') + item.text;
                    list.appendChild(div);
                });
            }
        }
        return Promise.resolve();
    }

    case 'shim_select_menu': {
        const winid = args[0], how = args[1], menuListPtr = args[2];
        log('select_menu called: winid=' + winid + ' how=' + how + ' items=' + S.menuItems.length + ' isInventory=' + S.isInventoryMenuFlag);

        const hasInventoryHeaders = S.menuItems.some(item =>
            item.isHeader &&
            (item.text.includes('Weapons') || item.text.includes('Armor') ||
             item.text.includes('Comestibles') || item.text.includes('Gems') ||
             item.text.includes('Tools') || item.text.includes('Potions') ||
             item.text.includes('Scrolls'))
        );
        const isRealInventory = S.isInventoryMenuFlag && hasInventoryHeaders;

        if (isRealInventory && how === 0) {
            log('select_menu: inventory menu (no selection), updating panel');
            const list = document.getElementById('inventory-list');
            if (list) {
                list.innerHTML = '';
                S.menuItems.forEach(item => {
                    if (!item.isHeader && item.ch) {
                        const div = document.createElement('div');
                        div.className = 'inventory-item';
                        div.textContent = '[' + item.ch + '] ' + item.text;
                        list.appendChild(div);
                    }
                });
            }
            return Promise.resolve(0);
        }

        if (how === 0) return Promise.resolve(0);
        if (S.menuItems.length === 0) return Promise.resolve(0);

        clearInputBuffer();
        const selectableItems = S.menuItems.filter(item => (item.ch || item.acc) && item.ch !== ' ');
        showMenuModal(S.lastMenuPrompt, S.menuItems);

        return new Promise((resolve) => {
            const finish = (val) => {
                S.currentMenuResolve = null;
                hideMenuModal();
                resolve(val);
            };
            S.currentMenuResolve = (keyCode) => {
                const ch = String.fromCharCode(keyCode).toLowerCase();
                log('select_menu: key pressed:', ch, 'keyCode:', keyCode);

                if (keyCode === 27) { finish(-1); return; }

                const isPrintable = (keyCode >= 32 && keyCode <= 126);
                if (!isPrintable && keyCode !== 27 && keyCode !== 32 && keyCode !== 13) {
                    log('select_menu: ignoring non-printable key', keyCode);
                    return;
                }
                let code = keyCode;
                if ((code === 32 || code === 13) && selectableItems.length > 0) {
                    code = selectableItems[0].ch.charCodeAt(0);
                }
                let selectedIdx = -1;
                for (let i = 0; i < S.menuItems.length; i++) {
                    const itemCh = S.menuItems[i].ch ? S.menuItems[i].ch.toLowerCase() : '';
                    const itemAcc = S.menuItems[i].acc ? S.menuItems[i].acc.toLowerCase() : '';
                    if (itemCh && itemCh === String.fromCharCode(code).toLowerCase()) {
                        selectedIdx = i; break;
                    }
                    if (itemAcc && itemAcc === String.fromCharCode(code).toLowerCase()) {
                        selectedIdx = i; break;
                    }
                }
                if (selectedIdx >= 0 && S.mod && menuListPtr) {
                    const menuItemSize = 16;
                    const menuList = S.mod._malloc(menuItemSize);
                    for (let i = 0; i < menuItemSize; i++) S.mod.setValue(menuList + i, 0, 'i8');
                    const selectedItem = S.menuItems[selectedIdx];
                    let itemIdentifier;
                    if (selectedItem.identifier !== undefined && selectedItem.identifier !== null) {
                        itemIdentifier = selectedItem.identifier;
                    } else if (selectedItem.ch) {
                        itemIdentifier = selectedItem.ch.charCodeAt(0);
                    } else if (selectedItem.acc) {
                        itemIdentifier = selectedItem.acc.charCodeAt(0);
                    } else {
                        itemIdentifier = 0;
                    }
                    S.mod.setValue(menuList, itemIdentifier, 'i32');
                    S.mod.setValue(menuList + 8, 1, 'i32');
                    S.mod.setValue(menuListPtr, menuList, '*');
                    finish(1);
                } else {
                    finish(0);
                }
            };
        });
    }

    case 'shim_message_menu': {
        const mesg = args[2];
        if (mesg) addMessage(mesg);
        renderMap();
        return waitForKey().then((key) => key);
    }

    case 'shim_mark_synch': {
        renderMap();
        return Promise.resolve();
    }

    case 'shim_cliparound': {
        return Promise.resolve();
    }

    case 'shim_update_positionbar': {
        return Promise.resolve();
    }

    case 'shim_print_glyph': {
        const winid = args[0], x = args[1], y = args[2];
        const glyphinfoPtr = args[3];
        let sym = 0, color = 7;
        if (S.mod && glyphinfoPtr) {
            try {
                sym = S.mod.getValue(glyphinfoPtr + 4, 'i32');
                color = S.mod.getValue(glyphinfoPtr + 16, 'i32') & 0xF;
            } catch (e) { log('读取glyphinfo失败:', e); }
        }
        const ch = sym > 0 ? String.fromCharCode(sym) : ' ';
        if (y >= 0 && y < MAP_HEIGHT && x >= 0 && x < MAP_WIDTH) {
            S.mapRows[y][x] = ch;
            S.mapColors[y][x] = color;
        }
        return Promise.resolve();
    }

    case 'shim_raw_print': {
        if (args[0]) addMessage(args[0]);
        return Promise.resolve();
    }

    case 'shim_raw_print_bold': {
        if (args[0]) addMessage(args[0], 1);
        return Promise.resolve();
    }

    case 'shim_nhgetch': {
        log('*** shim_nhgetch called, buffer=' + S.inputBuffer.length + ' ***');
        renderMap();
        return waitForKey().then((key) => {
            log('*** nhgetch returning key:', key, '***');
            return key;
        });
    }

    case 'shim_nh_poskey': {
        log('*** shim_nh_poskey called, buffer=' + S.inputBuffer.length + ', x_ptr=' + args[0] + ' ***');
        renderMap();
        return waitForKey().then((key) => {
            if (S.mod && args[0]) S.mod.setValue(args[0], 0, 'i16');
            if (S.mod && args[1]) S.mod.setValue(args[1], 0, 'i16');
            if (S.mod && args[2]) S.mod.setValue(args[2], 0, 'i32');
            log('*** nh_poskey returning key:', key, '***');
            return key;
        });
    }

    case 'shim_nhbell': {
        return Promise.resolve();
    }

    case 'shim_doprev_message': {
        return Promise.resolve(0);
    }

    case 'shim_yn_function': {
        let query = args[0] || '?', resp = args[1] || '', def = args[2];
        if (typeof query === 'number' && S.mod) {
            try { query = S.mod.UTF8ToString(query) || '?'; } catch (e) { query = '?'; }
        }
        if (typeof resp === 'number' && S.mod) {
            try { resp = S.mod.UTF8ToString(resp) || ''; } catch (e) { resp = ''; }
        }
        const defaultChar = (typeof def === 'number' && def > 0) ? def : 'n'.charCodeAt(0);
        let validChars = 'yn';
        if (resp && resp.length > 0 && resp !== '(null)') {
            validChars = resp.toLowerCase().replace(/[^a-z?*]/g, '');
        }
        const isDirectionQuery = !resp && query.toLowerCase().includes('direction');
        if (validChars === 'yn' && query.includes('[') && query.includes(']')) {
            const match = query.match(/\[([^\]]+)\]/);
            if (match) {
                const options = match[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                if (options.length > 0) validChars = options.toLowerCase();
            }
        }
        log('yn_function:', query, 'resp:', resp, 'default:', String.fromCharCode(defaultChar), 'valid:', validChars);
        S.lastQuery = query;
        addMessage(query);
        renderMap();
        clearInputBuffer();

        if (isDirectionQuery) {
            log('yn_function: direction query, waiting for direct key');
            return waitForKey();
        }

        showYnModal(query, validChars, defaultChar);
        return new Promise((resolve) => {
            const finish = (val) => {
                S.currentYnResolve = null;
                hideYnModal();
                resolve(val);
            };
            S.currentYnResolve = (keyCode) => {
                const ch = String.fromCharCode(keyCode).toLowerCase();
                log('yn_function: selected', ch);
                if (keyCode === 27) { finish('q'.charCodeAt(0)); return; }
                if (validChars.includes(ch)) {
                    finish(keyCode);
                } else {
                    log('yn_function: invalid key', ch);
                }
            };
        });
    }

    case 'shim_getlin': {
        const query = args[0] || '';
        addMessage(query);
        renderMap();
        document.getElementById('command-input').placeholder = query;
        return waitForKey().then((key) => String.fromCharCode(key));
    }

    case 'shim_get_ext_cmd': {
        addMessage('请输入扩展命令:');
        renderMap();
        return waitForKey().then(() => -1);
    }

    case 'shim_number_pad': {
        return Promise.resolve();
    }

    case 'shim_delay_output': {
        return new Promise(resolve => setTimeout(resolve, 50));
    }

    case 'shim_status_init': {
        return Promise.resolve();
    }

    case 'shim_status_enablefield': {
        return Promise.resolve();
    }

    case 'shim_status_update': {
        const fldidx = args[0], ptrValue = args[1];
        const chg = args[2] || 0, percent = args[3] || 0, colorVal = args[4] || 0;

        const stringFields = [0, 20, 21, 22, 25, 26];
        let value = '', valueType = 'i';

        if (typeof ptrValue === 'number' && ptrValue > 65536 && S.mod) {
            try {
                const str = S.mod.UTF8ToString(ptrValue);
                if (stringFields.includes(fldidx)) {
                    value = str; valueType = 's';
                } else {
                    value = parseInt(str) || 0; valueType = 'i';
                }
            } catch (e) {
                value = stringFields.includes(fldidx) ? '' : 0;
                valueType = stringFields.includes(fldidx) ? 's' : 'i';
            }
        } else {
            value = ptrValue;
            valueType = stringFields.includes(fldidx) ? 's' : 'i';
        }

        let memDump = '';
        if (typeof ptrValue === 'number' && ptrValue > 65536 && S.mod) {
            try {
                const b0 = S.mod.getValue(ptrValue, 'i8');
                const b1 = S.mod.getValue(ptrValue + 1, 'i8');
                const b2 = S.mod.getValue(ptrValue + 2, 'i8');
                const b3 = S.mod.getValue(ptrValue + 3, 'i8');
                memDump = ` mem=[${b0},${b1},${b2},${b3}] i16=${S.mod.getValue(ptrValue,'i16')} i32=${S.mod.getValue(ptrValue,'i32')}`;
            } catch (e) { memDump = ' mem=error'; }
        }
        log('status_update: fld=' + fldidx + ' raw=' + ptrValue + ' final="' + value + '"' + memDump);
        updateStatusUI(fldidx, value, valueType, chg, percent, colorVal);
        return Promise.resolve();
    }

    case 'shim_preference_update': {
        return Promise.resolve();
    }

    case 'shim_getmsghistory': {
        const count = (S.callback_call_count['shim_getmsghistory'] || 0);
        if (count === 1) log('getmsghistory: init=' + args[0]);
        S.callback_call_count['shim_getmsghistory'] = count + 1;
        return Promise.resolve('');
    }

    case 'shim_putmsghistory': {
        return Promise.resolve();
    }

    default:
        log('未处理的回调:', name, args);
        return Promise.resolve(0);
    }
}
