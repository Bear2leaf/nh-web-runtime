/**
 * Node.js shim — replaces browser DOM callbacks with a plain state object.
 *
 * Called by the WASM runtime via shim_graphics_set_callback bridge.
 * Every case returns a Promise (local_callback uses .then()).
 */

import { SHIM_FORMATS, getPointerValue, setPointerValue } from './shim.js';
import { BL } from './status.js';
import { MAP_WIDTH, MAP_HEIGHT } from './map.js';

// ---- Logging (Node-friendly) -----------------------------------------------

function log(...args) {
    console.log('[NH-NODE]', ...args);
}

// ---- Mutable state (replaces DOM) ------------------------------------------

export const shimState = {
    // Map grid
    mapRows: [],
    mapColors: [],

    // Messages
    messages: [],

    // Status
    hp: '',
    maxHp: '',
    hunger: '',
    dlvl: '',
    role: '',
    str: '', dex: '', con: '', int: '', wis: '', cha: '',
    align: '', score: '', cap: '', gold: '', energy: '', maxEnergy: '',
    xp: '', ac: '', time: '', condition: '', weapon: '', armor: '',
    terrain: '', vers: '',

    // YN modal
    ynVisible: false,
    ynText: '',
    ynValidChars: '',
    ynDefaultChar: 'n'.charCodeAt(0),

    // Menu modal
    menuVisible: false,
    menuText: '',
    menuItems: [],
    lastMenuPrompt: '',

    // Input
    inputBuffer: [],
    inputResolve: null,

    // Resolvers
    ynResolve: null,
    menuResolve: null,

    // Game state
    done: false,
    nethackReady: false,

    // Window tracking
    mapWinId: null,
    inventoryWinId: null,

    // Menu / inventory
    isInventoryMenuFlag: false,

    // Debug
    callback_call_count: {},
    get_nh_event_count: 0,
    last_log_time: Date.now(),

    // Cursor
    cursorX: 0,
    cursorY: 0,

    // Level change
    lastLevelDesc: '',
};

// ---- Module reference (set by runner) --------------------------------------

let _mod = null;

export function setModule(mod) {
    _mod = mod;
}

export function resetShimState() {
    shimState.mapRows = [];
    shimState.mapColors = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        shimState.mapRows[y] = new Array(MAP_WIDTH).fill(' ');
        shimState.mapColors[y] = new Array(MAP_WIDTH).fill(0);
    }
    shimState.messages = [];
    shimState.hp = '';
    shimState.maxHp = '';
    shimState.hunger = '';
    shimState.dlvl = '';
    shimState.role = '';
    shimState.str = ''; shimState.dex = ''; shimState.con = ''; shimState.int = ''; shimState.wis = ''; shimState.cha = '';
    shimState.align = ''; shimState.score = ''; shimState.cap = ''; shimState.gold = '';
    shimState.energy = ''; shimState.maxEnergy = '';
    shimState.xp = ''; shimState.ac = ''; shimState.time = ''; shimState.condition = '';
    shimState.weapon = ''; shimState.armor = ''; shimState.terrain = ''; shimState.vers = '';
    shimState.ynVisible = false;
    shimState.ynText = '';
    shimState.ynValidChars = '';
    shimState.ynDefaultChar = 'n'.charCodeAt(0);
    shimState.menuVisible = false;
    shimState.menuText = '';
    shimState.menuItems = [];
    shimState.lastMenuPrompt = '';
    shimState.inputBuffer = [];
    shimState.inputResolve = null;
    shimState.ynResolve = null;
    shimState.menuResolve = null;
    shimState.done = false;
    shimState.nethackReady = false;
    shimState.mapWinId = null;
    shimState.inventoryWinId = null;
    shimState.isInventoryMenuFlag = false;
    shimState.callback_call_count = {};
    shimState.get_nh_event_count = 0;
    shimState.last_log_time = Date.now();
    shimState.cursorX = 0;
    shimState.cursorY = 0;
    shimState.lastLevelDesc = '';
}

// ---- Map init --------------------------------------------------------------

function initMap() {
    shimState.mapRows = [];
    shimState.mapColors = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        shimState.mapRows[y] = new Array(MAP_WIDTH).fill(' ');
        shimState.mapColors[y] = new Array(MAP_WIDTH).fill(0);
    }
}

// ---- Input helpers ---------------------------------------------------------

export function sendKey(keyCode) {
    log('sendKey:', keyCode, 'inputResolve=', shimState.inputResolve ? 'yes' : 'null', 'ynResolve=', shimState.ynResolve ? 'yes' : 'null');
    // If there's a pending YN direction query, resolve it with this key
    if (shimState.ynResolve) {
        const resolve = shimState.ynResolve;
        shimState.ynResolve = null;
        resolve(keyCode);
        return;
    }
    if (shimState.inputResolve) {
        const resolve = shimState.inputResolve;
        shimState.inputResolve = null;
        resolve(keyCode);
    } else {
        shimState.inputBuffer.push(keyCode);
        log('key buffered, buffer len:', shimState.inputBuffer.length);
    }
}

export function waitForKey() {
    log('waitForKey called, buffer len:', shimState.inputBuffer.length);
    return new Promise((resolve) => {
        if (shimState.inputBuffer.length > 0) {
            const key = shimState.inputBuffer.shift();
            log('waitForKey: resolving with buffered key:', key);
            resolve(key);
        } else {
            shimState.inputResolve = resolve;
            log('waitForKey: waiting for input...');
        }
    });
}

export function clearInputBuffer() {
    if (shimState.inputBuffer.length > 0) {
        log('Clearing input buffer, removed', shimState.inputBuffer.length, 'keys');
        shimState.inputBuffer.length = 0;
    }
}

// ---- Condition wait helper -------------------------------------------------

export function waitForCondition(fn, timeout = 60000, interval = 100) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (fn()) {
                resolve();
            } else if (Date.now() - start > timeout) {
                reject(new Error('waitForCondition timeout'));
            } else {
                setTimeout(check, interval);
            }
        };
        check();
    });
}

// ---- Status update (replaces DOM updateStatusUI) ---------------------------

function updateStatusUI(fldidx, rawValue, valueType) {
    const displayValue = valueType === 's' ? String(rawValue || '') : String(rawValue || 0);

    switch (fldidx) {
        case BL.BL_TITLE:    shimState.role = displayValue; break;
        case BL.BL_STR:      shimState.str = displayValue; break;
        case BL.BL_DX:       shimState.dex = displayValue; break;
        case BL.BL_CO:       shimState.con = displayValue; break;
        case BL.BL_IN:       shimState.int = displayValue; break;
        case BL.BL_WI:       shimState.wis = displayValue; break;
        case BL.BL_CH:       shimState.cha = displayValue; break;
        case BL.BL_ALIGN:    shimState.align = displayValue; break;
        case BL.BL_SCORE:    shimState.score = displayValue; break;
        case BL.BL_CAP:      shimState.cap = displayValue; break;
        case BL.BL_GOLD:     shimState.gold = displayValue; break;
        case BL.BL_ENE:      shimState.energy = displayValue; break;
        case BL.BL_ENEMAX:   shimState.maxEnergy = displayValue; break;
        case BL.BL_XP:       shimState.xp = displayValue; break;
        case BL.BL_AC:       shimState.ac = displayValue; break;
        case BL.BL_TIME:     shimState.time = displayValue; break;
        case BL.BL_HUNGER:   shimState.hunger = displayValue; break;
        case BL.BL_HP:       shimState.hp = displayValue; break;
        case BL.BL_HPMAX:    shimState.maxHp = displayValue; break;
        case BL.BL_LEVELDESC: {
            const levelChanged = shimState.lastLevelDesc && displayValue !== shimState.lastLevelDesc;
            if (levelChanged) {
                log('Level changed: clearing map');
                for (let y = 0; y < MAP_HEIGHT; y++) {
                    for (let x = 0; x < MAP_WIDTH; x++) {
                        shimState.mapRows[y][x] = ' ';
                        shimState.mapColors[y][x] = 0;
                    }
                }
            }
            shimState.lastLevelDesc = displayValue;
            shimState.dlvl = displayValue;
            break;
        }
        case BL.BL_EXP:      shimState.xp = displayValue; break;
        case BL.BL_CONDITION: shimState.condition = displayValue; break;
        case BL.BL_WEAPON:   shimState.weapon = displayValue; break;
        case BL.BL_ARMOR:    shimState.armor = displayValue; break;
        case BL.BL_TERRAIN:  shimState.terrain = displayValue; break;
        case BL.BL_VERS:     shimState.vers = displayValue; break;
        default: break;
    }
}

// ---- Main callback dispatcher ----------------------------------------------

export async function nethackShimCallback(name, ...args) {
    shimState.callback_call_count[name] = (shimState.callback_call_count[name] || 0) + 1;

    const logNames = ['shim_askname', 'shim_select_menu', 'shim_player_selection',
                      'shim_nhgetch', 'shim_nh_poskey', 'shim_yn_function'];
    if (logNames.includes(name)) {
        log('CB:', name, 'args:', args);
    }

    switch (name) {

    case 'shim_init_nhwindows': {
        initMap();
        shimState.nethackReady = false;
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
        shimState.get_nh_event_count++;
        const now = Date.now();
        if (now - shimState.last_log_time > 3000) {
            log('get_nh_event called ' + shimState.get_nh_event_count +
                ' times, buffer=' + shimState.inputBuffer.length +
                ', waiting=' + (shimState.inputResolve ? 'yes' : 'no'));
            shimState.last_log_time = now;
        }
        if (shimState.inputBuffer.length > 0 && shimState.inputResolve) {
            const key = shimState.inputBuffer.shift();
            const resolve = shimState.inputResolve;
            shimState.inputResolve = null;
            log('get_nh_event: flushing buffered key:', key);
            resolve(key);
        }
        return Promise.resolve();
    }

    case 'shim_exit_nhwindows': {
        shimState.messages.push('--- 游戏结束 ---');
        shimState.nethackReady = false;
        shimState.done = true;
        return Promise.resolve();
    }

    case 'shim_suspend_nhwindows':
    case 'shim_resume_nhwindows': {
        return Promise.resolve();
    }

    case 'shim_create_nhwindow': {
        const type = args[0];
        log('create_nhwindow type=' + type);
        if (!nethackShimCallback._nextWinId) nethackShimCallback._nextWinId = 1;
        const winid = nethackShimCallback._nextWinId++;

        if (type === 6) {
            nethackShimCallback._inventoryWinId = winid;
            log('Inventory window created with id=' + winid);
        }
        if (type === 2) {
            shimState.mapWinId = winid;
            log('Map window created with id=' + winid + ' (NHW_MAP)');
        }
        return Promise.resolve(winid);
    }

    case 'shim_clear_nhwindow': {
        const winid = args[0];
        if (winid === shimState.mapWinId) {
            log('clear_nhwindow: clearing MAP winid=' + winid);
            for (let y = 0; y < MAP_HEIGHT; y++) {
                for (let x = 0; x < MAP_WIDTH; x++) {
                    shimState.mapRows[y][x] = ' ';
                    shimState.mapColors[y][x] = 0;
                }
            }
        }
        return Promise.resolve();
    }

    case 'shim_display_nhwindow':
    case 'shim_wait_synch': {
        return Promise.resolve();
    }

    case 'shim_destroy_nhwindow': {
        return Promise.resolve();
    }

    case 'shim_curs': {
        shimState.cursorX = args[1];
        shimState.cursorY = args[2];
        return Promise.resolve();
    }

    case 'shim_putstr': {
        const winid = args[0], str = args[2];
        if (str) {
            shimState.messages.push(str);
            if (shimState.messages.length > 200) {
                shimState.messages.shift();
            }
        }
        return Promise.resolve();
    }

    case 'shim_display_file': {
        log('display_file:', args[0]);
        shimState.messages.push('-- 按任意键继续 --');
        return waitForKey().then(() => 0);
    }

    case 'shim_start_menu': {
        const winid = args[0], mbehavior = args[1];
        log('start_menu: winid=' + winid + ' mbehavior=' + mbehavior);
        shimState.menuItems = [];
        shimState.isInventoryMenuFlag = (winid === 6) || (mbehavior === 1);
        return Promise.resolve();
    }

    case 'shim_add_menu': {
        const strArg = args[7], ch = args[3], acc = args[4], identifier = args[2], attr = args[5];
        let str = '';
        if (typeof strArg === 'string') {
            str = strArg;
        } else if (_mod && strArg && typeof strArg === 'number') {
            try { str = _mod.UTF8ToString(strArg); } catch (e) { str = ''; }
        }
        if (str) {
            const chStr = ch ? String.fromCharCode(ch) : '';
            const accStr = acc ? String.fromCharCode(acc) : '';
            const isHeader = !ch && !acc && !identifier;
            shimState.menuItems.push({ ch: chStr, acc: accStr, identifier, text: str, selected: false, isHeader });
        }
        return Promise.resolve();
    }

    case 'shim_end_menu': {
        const winid = args[0], promptPtr = args[1];
        let prompt = '选择:';
        if (_mod && promptPtr) {
            try { prompt = _mod.UTF8ToString(promptPtr) || '选择:'; } catch (e) { prompt = '选择:'; }
        }
        shimState.lastMenuPrompt = prompt;
        log('end_menu: winid=' + winid + ' prompt="' + prompt + '" items=' + shimState.menuItems.length);
        return Promise.resolve();
    }

    case 'shim_select_menu': {
        const winid = args[0], how = args[1], menuListPtr = args[2];
        log('select_menu called: winid=' + winid + ' how=' + how + ' items=' + shimState.menuItems.length);

        if (how === 0) return Promise.resolve(0);
        if (shimState.menuItems.length === 0) return Promise.resolve(0);

        clearInputBuffer();
        const selectableItems = shimState.menuItems.filter(item => (item.ch || item.acc) && item.ch !== ' ');

        // Auto-resolve: skip tutorial items, prefer "Start"/"Yes" items
        if (selectableItems.length > 0) {
            // First, try to find a non-tutorial item with "start", "yes", or "play"
            let selectedItem = selectableItems.find(item => {
                const textLower = item.text.toLowerCase();
                return !textLower.includes('tutorial') &&
                       (textLower.includes('start') || textLower.includes('yes') || textLower.includes('play'));
            });
            // If no good match, skip items with "tutorial" in text
            if (!selectedItem) {
                selectedItem = selectableItems.find(item => {
                    const textLower = item.text.toLowerCase();
                    return !textLower.includes('tutorial') && !textLower.includes('how to');
                });
            }
            // Fallback: first selectable item
            if (!selectedItem) {
                selectedItem = selectableItems[0];
            }
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
            if (_mod && menuListPtr) {
                const menuItemSize = 16;
                const menuList = _mod._malloc(menuItemSize);
                for (let i = 0; i < menuItemSize; i++) _mod.setValue(menuList + i, 0, 'i8');
                _mod.setValue(menuList, itemIdentifier, 'i32');
                _mod.setValue(menuList + 8, 1, 'i32');
                _mod.setValue(menuListPtr, menuList, '*');
            }
            return Promise.resolve(1);
        }

        return Promise.resolve(0);
    }

    case 'shim_message_menu': {
        const mesg = args[2];
        if (mesg) shimState.messages.push(mesg);
        return waitForKey().then((key) => key);
    }

    case 'shim_mark_synch':
    case 'shim_cliparound':
    case 'shim_update_positionbar': {
        return Promise.resolve();
    }

    case 'shim_print_glyph': {
        const winid = args[0], x = args[1], y = args[2];
        const glyphinfoPtr = args[3];
        let sym = 0, color = 7;
        if (_mod && glyphinfoPtr) {
            try {
                sym = _mod.getValue(glyphinfoPtr + 4, 'i32');
                color = _mod.getValue(glyphinfoPtr + 16, 'i32') & 0xF;
            } catch (e) { log('读取glyphinfo失败:', e); }
        }
        const ch = sym > 0 ? String.fromCharCode(sym) : ' ';
        if (y >= 0 && y < MAP_HEIGHT && x >= 0 && x < MAP_WIDTH) {
            shimState.mapRows[y][x] = ch;
            shimState.mapColors[y][x] = color;
        }
        return Promise.resolve();
    }

    case 'shim_raw_print': {
        if (args[0]) shimState.messages.push(args[0]);
        return Promise.resolve();
    }

    case 'shim_raw_print_bold': {
        if (args[0]) shimState.messages.push(args[0]);
        return Promise.resolve();
    }

    case 'shim_nhgetch': {
        log('*** shim_nhgetch called, buffer=' + shimState.inputBuffer.length + ' ***');
        return waitForKey().then((key) => {
            log('*** nhgetch returning key:', key, '***');
            return key;
        });
    }

    case 'shim_nh_poskey': {
        log('*** shim_nh_poskey called, buffer=' + shimState.inputBuffer.length + ' ***');
        return waitForKey().then((key) => {
            if (_mod && args[0]) _mod.setValue(args[0], 0, 'i16');
            if (_mod && args[1]) _mod.setValue(args[1], 0, 'i16');
            if (_mod && args[2]) _mod.setValue(args[2], 0, 'i32');
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
        if (typeof query === 'number' && _mod) {
            try { query = _mod.UTF8ToString(query) || '?'; } catch (e) { query = '?'; }
        }
        if (typeof resp === 'number' && _mod) {
            try { resp = _mod.UTF8ToString(resp) || ''; } catch (e) { resp = ''; }
        }
        const defaultChar = (typeof def === 'number' && def > 0) ? def : 'n'.charCodeAt(0);
        let validChars = 'yn';
        if (resp && resp.length > 0 && resp !== '(null)') {
            validChars = resp.toLowerCase().replace(/[^a-z?*]/g, '');
        }
        const isDirectionQuery = !resp && query.toLowerCase().includes('direction');
        if (isDirectionQuery) {
            // Direction queries must be handled by the AI (pendingDir mechanism).
            // Return a promise that gets resolved when the AI sends the direction key.
            log('yn_function: direction query — waiting for AI to send direction');
            return new Promise((resolve) => {
                shimState.ynResolve = resolve;
            });
        }
        if (validChars === 'yn' && query.includes('[') && query.includes(']')) {
            const match = query.match(/\[([^\]]+)\]/);
            if (match) {
                const options = match[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                if (options.length > 0) validChars = options.toLowerCase();
            }
        }
        log('yn_function:', query, 'resp:', resp, 'default:', String.fromCharCode(defaultChar), 'valid:', validChars);
        shimState.messages.push(query);
        clearInputBuffer();

        // Auto-resolve: pick/select -> y, "Really step" -> n, eat prompts -> y/'a', other -> default
        let autoChar;
        if (query.toLowerCase().includes('pick') || query.toLowerCase().includes('select') || query.toLowerCase().includes('swap places')) {
            autoChar = 'y'.charCodeAt(0);
        } else if (query.includes('Really step')) {
            autoChar = 'n'.charCodeAt(0); // Don't step on traps
        } else if (query.toLowerCase().includes('eat it') || query.toLowerCase().includes('eat that') || query.toLowerCase().includes('eat one')) {
            // "There is a lichen corpse here; eat it?" / "eat one?" — YES, we're starving!
            log('yn_function: eat floor item prompt, answering YES');
            autoChar = 'y'.charCodeAt(0);
        } else if (query.toLowerCase().includes('what do you want to eat')) {
            log('yn_function: eat prompt detected, query=', query);
            // Parse valid food choices from the prompt, e.g. [fg or ?*] means f or g are food items
            // Always default to 'a' — the generic 'n' default from def=0 would cancel the action.
            let foodChar = 'a'.charCodeAt(0);
            const choiceMatch = query.match(/\[([^\]]+)\]/);
            if (choiceMatch) {
                const options = choiceMatch[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                // Pick the first letter that's not '?' or '*' (those are help/all commands)
                for (const c of options) {
                    if (c !== '?' && c !== '*') { foodChar = c.charCodeAt(0); break; }
                }
            }
            autoChar = foodChar;
        } else if (query.toLowerCase().includes('what do you want to read')) {
            // "What do you want to read? [abcdefghijklmnopqrstuvwxyz or ?*]"
            // Parse valid scroll/spellbook choices and pick the first one.
            log('yn_function: read prompt detected, query=', query);
            // Always default to 'a' — the generic 'n' default from def=0 would cancel the action.
            let readChar = 'a'.charCodeAt(0);
            const choiceMatch = query.match(/\[([^\]]+)\]/);
            if (choiceMatch) {
                const options = choiceMatch[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                for (const c of options) {
                    if (c !== '?' && c !== '*') { readChar = c.charCodeAt(0); break; }
                }
            }
            autoChar = readChar;
        } else if (query.toLowerCase().includes('what do you want to drink')) {
            // "What do you want to drink? [abcdefghijklmnopqrstuvwxyz or ?*]"
            log('yn_function: drink prompt detected, query=', query);
            // Always default to 'a' — the generic 'n' default from def=0 would cancel the action.
            let drinkChar = 'a'.charCodeAt(0);
            const choiceMatch = query.match(/\[([^\]]+)\]/);
            if (choiceMatch) {
                const options = choiceMatch[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                for (const c of options) {
                    if (c !== '?' && c !== '*') { drinkChar = c.charCodeAt(0); break; }
                }
            }
            autoChar = drinkChar;
        } else if (query.toLowerCase().includes('unlock it with')) {
            // Unlock doors with credit card / skeleton key / lock pick
            log('yn_function: unlock prompt detected, answering YES');
            autoChar = 'y'.charCodeAt(0);
        } else {
            autoChar = defaultChar;
        }
        // Guard: if auto-resolved char is invalid (def=0 returns NUL), fall back to 'n'
        if (!autoChar || autoChar < 32) autoChar = 'n'.charCodeAt(0);
        log('yn_function: auto-resolving with', String.fromCharCode(autoChar));
        return Promise.resolve(autoChar);
    }

    case 'shim_getlin': {
        const query = args[0] || '';
        shimState.messages.push(query);
        return waitForKey().then((key) => String.fromCharCode(key));
    }

    case 'shim_get_ext_cmd': {
        shimState.messages.push('请输入扩展命令:');
        return waitForKey().then(() => -1);
    }

    case 'shim_number_pad': {
        return Promise.resolve();
    }

    case 'shim_delay_output': {
        return Promise.resolve();
    }

    case 'shim_status_init': {
        return Promise.resolve();
    }

    case 'shim_status_enablefield': {
        return Promise.resolve();
    }

    case 'shim_status_update': {
        const fldidx = args[0], ptrValue = args[1];
        const stringFields = [0, 17, 20, 21, 22, 25, 26];
        let value = '', valueType = 'i';

        if (typeof ptrValue === 'number' && ptrValue > 65536 && _mod) {
            try {
                const str = _mod.UTF8ToString(ptrValue);
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

        log('status_update: fld=' + fldidx + ' val="' + value + '"');
        updateStatusUI(fldidx, value, valueType);
        return Promise.resolve();
    }

    case 'shim_preference_update': {
        return Promise.resolve();
    }

    case 'shim_getmsghistory': {
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

// ---- Default export for compatibility ----------------------------------------

export default {
    shimState,
    sendKey,
    waitForKey,
    clearInputBuffer,
    waitForCondition,
    nethackShimCallback,
    setModule,
    resetShimState,
};
