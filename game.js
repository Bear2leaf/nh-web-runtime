/**
 * NetHack Web - 游戏核心逻辑
 * 
 * 基于 libnh 的 shim graphics 回调接口
 * nethack.js 使用 MODULARIZE 模式，导出为工厂函数
 * 回调函数名带 shim_ 前缀，且必须返回 Promise
 * 
 * Version: 2026-05-08-001
 */

console.log('[NH] game.js loaded, version 2026-05-08-001');

// 全局错误处理
window.addEventListener('error', (e) => {
    console.error('[NH] Global error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[NH] Unhandled promise rejection:', e.reason);
});

// 调试计数器
let get_nh_event_count = 0;
let last_log_time = Date.now();
let callback_call_count = {};

// 全局返回值存储（因为 Asyncify 栈展开导致 C 的 ret_ptr 失效）
let shim_return_values = {};

let mod = null;              // WASM Module 实例
let nethackReady = false;     // 游戏是否就绪
let inputResolve = null;      // 当前等待输入的 resolve
let inputBuffer = [];         // 输入缓冲区
let menuItems = [];           // 当前菜单项
let lastQuery = '';           // 上次询问的问题 (yn_function)
let currentMenuResolve = null; // 菜单选择的 resolve
let currentMenuWinId = null;  // 当前菜单窗口ID
let isInventoryMenuFlag = false; // 当前是否是物品栏菜单

// ============ 地图渲染状态 ============
let mapRows = [];             // 二维字符数组 [row][col]
let mapColors = [];           // 二维颜色数组
let cursorX = 0, cursorY = 0;
const MAP_WIDTH = 80;
const MAP_HEIGHT = 21;

// ============ 状态栏字段索引 ============
// 从 botl.h 的 enum statusfields 复制
const BL = {
    BL_TITLE: 0,
    BL_STR: 1, BL_DX: 2, BL_CO: 3, BL_IN: 4, BL_WI: 5, BL_CH: 6,
    BL_ALIGN: 7, BL_SCORE: 8, BL_CAP: 9, BL_GOLD: 10,
    BL_ENE: 11, BL_ENEMAX: 12, BL_XP: 13, BL_AC: 14, BL_HD: 15,
    BL_TIME: 16, BL_HUNGER: 17, BL_HP: 18, BL_HPMAX: 19,
    BL_LEVELDESC: 20, BL_EXP: 21, BL_CONDITION: 22,
    BL_WEAPON: 23, BL_ARMOR: 24, BL_TERRAIN: 25,
    BL_VERS: 26
};

// ============ 日志 ============
function log(...args) {
    // 输出关键日志
    console.log('[NH]', ...args);
}

// ============ UI 辅助 ============
function $(id) { return document.getElementById(id); }

function addMessage(text, attr) {
    const panel = $('message-panel');
    const div = document.createElement('div');
    div.className = 'message';
    if (attr === 1) div.style.fontWeight = 'bold';
    div.textContent = text;
    panel.appendChild(div);
    // 保留最多 200 条消息
    while (panel.children.length > 200) panel.removeChild(panel.firstChild);
    panel.scrollTop = panel.scrollHeight;
}

function clearMessages() {
    $('message-panel').innerHTML = '';
}

// ============ 物品栏管理 ============
let inventoryItems = []; // 当前物品栏内容

function clearInventory() {
    inventoryItems = [];
    const list = $('inventory-list');
    if (list) {
        list.innerHTML = '空';
        list.className = 'inventory-empty';
    }
}

function addInventoryItem(text, attr) {
    const list = $('inventory-list');
    if (!list) return;

    // 第一次添加物品时清空 "空" 提示
    if (inventoryItems.length === 0) {
        list.innerHTML = '';
        list.className = '';
    }

    inventoryItems.push({ text, attr });

    const div = document.createElement('div');
    div.className = 'inventory-item';
    if (attr === 1) div.style.fontWeight = 'bold';
    div.textContent = text;
    list.appendChild(div);
}

// ============ 菜单弹窗 ============
function showMenuModal(title, items) {
    const modal = $('menu-modal');
    const titleEl = $('menu-title');
    const itemsEl = $('menu-items');

    if (!modal || !titleEl || !itemsEl) return;

    titleEl.textContent = title || '选择';
    itemsEl.innerHTML = '';

    items.forEach(item => {
        const div = document.createElement('div');
        if (item.isHeader) {
            div.className = 'menu-header';
            div.textContent = item.text;
        } else if (item.ch && item.ch !== ' ') {
            // 有选择键的可选项
            div.className = 'menu-item';
            div.dataset.key = item.ch;
            div.innerHTML = `<span class="menu-key">${item.ch}</span><span class="menu-text">${item.text}</span>`;
            div.onclick = () => selectMenuItem(item.ch);
        } else {
            // 无选择键的普通文本行（非header也非选项）
            div.className = 'menu-row';
            div.style.padding = '4px 12px';
            div.style.color = '#aaa';
            div.textContent = item.text;
        }
        itemsEl.appendChild(div);
    });

    modal.classList.remove('hidden');
}

function hideMenuModal() {
    const modal = $('menu-modal');
    if (modal) modal.classList.add('hidden');
}

function selectMenuItem(keyOrCode) {
    hideMenuModal();
    if (currentMenuResolve) {
        const resolve = currentMenuResolve;
        currentMenuResolve = null;
        // 支持传入字符或字符码
        const code = typeof keyOrCode === 'string' ? keyOrCode.charCodeAt(0) : keyOrCode;
        resolve(code);
    }
}

// ============ YN 询问弹窗 ============
let currentYnResolve = null;
let currentYnValidChars = '';

function showYnModal(question, validChars, defaultChar) {
    const modal = $('yn-modal');
    const questionEl = $('yn-question');
    const buttonsEl = $('yn-buttons');

    if (!modal || !questionEl || !buttonsEl) return;

    questionEl.textContent = question;
    buttonsEl.innerHTML = '';
    currentYnValidChars = validChars;

    // 为每个有效字符创建按钮
    for (const ch of validChars) {
        const btn = document.createElement('button');
        btn.className = 'yn-btn';
        if (ch === String.fromCharCode(defaultChar).toLowerCase()) {
            btn.classList.add('primary');
        }
        btn.textContent = ch.toUpperCase();
        btn.onclick = () => selectYnOption(ch.charCodeAt(0));
        buttonsEl.appendChild(btn);
    }

    modal.classList.remove('hidden');
}

function hideYnModal() {
    const modal = $('yn-modal');
    if (modal) modal.classList.add('hidden');
}

function selectYnOption(keyCode) {
    hideYnModal();
    if (currentYnResolve) {
        const resolve = currentYnResolve;
        currentYnResolve = null;
        resolve(keyCode);
    }
}

function setStatusField(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

// ============ 地图渲染 ============
function initMap() {
    mapRows = [];
    mapColors = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        mapRows[y] = new Array(MAP_WIDTH).fill(' ');
        mapColors[y] = new Array(MAP_WIDTH).fill(0);
    }
}

function renderMap() {
    const mapEl = $('game-map');
    if (!mapEl) return;
    // 构建带颜色的 HTML
    let html = '';
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            const ch = mapRows[y][x];
            const clr = mapColors[y][x];
            let display = ch;
            if (ch === ' ') display = '\u00A0'; // 用 nbsp 保持对齐
            if (clr === 0) {
                html += display;
            } else {
                const color = getCssColor(clr);
                html += `<span style="color:${color}">${display}</span>`;
            }
        }
        html += '\n';
    }
    mapEl.innerHTML = html;
}

function getCssColor(nhColor) {
    const colors = [
        '#aaa',      // 0  CLR_BLACK (实际灰色)
        '#ff4444',   // 1  CLR_RED
        '#44ff44',   // 2  CLR_GREEN
        '#ffff44',   // 3  CLR_BROWN
        '#4444ff',   // 4  CLR_BLUE
        '#ff44ff',   // 5  CLR_MAGENTA
        '#44ffff',   // 6  CLR_CYAN
        '#ffffff',   // 7  CLR_GRAY
        '#ff8888',   // 8  CLR_ORANGE
        '#88ff88',   // 9  CLR_BRIGHT_GREEN
        '#ffff88',   // 10 CLR_YELLOW
        '#8888ff',   // 11 CLR_BRIGHT_BLUE
        '#ff88ff',   // 12 CLR_BRIGHT_MAGENTA
        '#88ffff',   // 13 CLR_BRIGHT_CYAN
        '#ffffff',   // 14 CLR_WHITE
        '#cccccc',   // 15
    ];
    return colors[nhColor] || '#ffffff';
}

// Glyph 到字符和颜色的映射（简化版，基于 NetHack 标准 glyph 结构）
function glyphToCharAndColor(glyph) {
    // NetHack 的 glyph 编码：
    // glyph % MAX_GLYPH
    // 主要类别通过偏移区分：
    //   GLYPH_MON_OFF, GLYPH_PET_OFF, GLYPH_INVIS_OFF, GLYPH_DETECT_OFF,
    //   GLYPH_BODY_OFF, GLYPH_RIDDEN_OFF, GLYPH_OBJ_OFF, GLYPH_CMAP_OFF,
    //   GLYPH_EXPLODE_OFF, GLYPH_ZAP_OFF, GLYPH_SWALLOW_OFF, GLYPH_WARNING_OFF
    //
    // 简化实现：通过 glyph_info 结构体的 sym 字段和 color 字段来获取
    // 在 WASM 版本中，glyph_info 是作为指针传入的
    // 我们使用 mod 来读取
    
    let ch = '?';
    let color = 7; // 默认白色
    
    if (mod && mod.ccall) {
        // glyph_info 结构大致为:
        // int glyph; int tileidx; unsigned short sym; int color; unsigned short glyphflags;
        // 但这是 C 结构，我们需要从 WASM 内存中读取
        // 由于 glyphinfo 已经被 WASM 的 local_callback 转换了（作为 pointer 传入）
        // 我们需要直接读取 WASM 内存
    }
    
    return { ch, color };
}

// ============ 输入处理 ============
function waitForKey() {
    log('waitForKey called, buffer len:', inputBuffer.length);
    return new Promise((resolve) => {
        if (inputBuffer.length > 0) {
            const key = inputBuffer.shift();
            log('waitForKey: resolving with buffered key:', key);
            resolve(key);
        } else {
            inputResolve = resolve;
            log('waitForKey: waiting for input...');
        }
    });
}

// 清空输入缓冲区
function clearInputBuffer() {
    const cleared = inputBuffer.length;
    if (cleared > 0) {
        log('Clearing input buffer, removed', cleared, 'keys');
        inputBuffer.length = 0;
    }
}

function sendKey(keyCode) {
    log('sendKey:', keyCode, 'inputResolve=', inputResolve ? 'yes' : 'null', 'bufferLen=', inputBuffer.length);
    if (inputResolve) {
        const resolve = inputResolve;
        inputResolve = null;
        resolve(keyCode);
    } else {
        inputBuffer.push(keyCode);
        log('key buffered, buffer len:', inputBuffer.length);
    }
}

// 定期检查输入缓冲区（防止某些情况下 waitForKey 未被调用）
setInterval(() => {
    if (inputBuffer.length > 0 && inputResolve) {
        log('interval: flushing buffered key');
        const key = inputBuffer.shift();
        const resolve = inputResolve;
        inputResolve = null;
        resolve(key);
    }
}, 100);

// 输入状态检测 - 如果缓冲区有键但长时间没有 inputResolve，可能是输入循环卡住了
let lastInputBufferLen = 0;
let stuckCounter = 0;
setInterval(() => {
    if (inputBuffer.length > 0 && inputBuffer.length === lastInputBufferLen) {
        stuckCounter++;
        if (stuckCounter > 5) {
            log('WARNING: input appears stuck, buffer=' + inputBuffer.length + ', waiting=' + (inputResolve?'yes':'no') + ', nethackReady=' + nethackReady);
            // 尝试检查是否在菜单中
            log('menuItems count=' + menuItems.length + ', lastQuery=' + lastQuery);
            // 打印回调统计
            log('Callback stats:', JSON.stringify(callback_call_count));
            // 检查是否在调用 nhgetch/nh_poskey
            if (!callback_call_count['shim_nhgetch'] && !callback_call_count['shim_nh_poskey']) {
                log('ERROR: nhgetch/nh_poskey never called! Game may be stuck before moveloop.');
            }
        }
    } else {
        stuckCounter = 0;
    }
    lastInputBufferLen = inputBuffer.length;
}, 200);

function submitCommand() {
    const input = $('command-input');
    const cmd = input.value;
    input.value = '';
    if (cmd) {
        for (let i = 0; i < cmd.length; i++) {
            sendKey(cmd.charCodeAt(i));
        }
        sendKey(13); // Enter
    }
}

// ============ 核心 shim 回调 ============
// 回调必须返回 Promise（local_callback 会 .then(retVal => ...)）

// 回调函数格式定义（因为 Asyncify 可能导致 fmt_str 指针失效）
const SHIM_FORMATS = {
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

async function nethackShimCallback(name, ...args) {
    // 跟踪所有回调调用次数
    callback_call_count[name] = (callback_call_count[name] || 0) + 1;

    // 只记录关键回调
    const logNames = ['shim_askname', 'shim_select_menu', 'shim_player_selection',
                      'shim_nhgetch', 'shim_nh_poskey', 'shim_yn_function'];
    if (logNames.includes(name)) {
        log('CB:', name, 'args:', args);
    }

    switch (name) {

    case 'shim_init_nhwindows': {
        // args: [argcp, argv]
        initMap();
        globalThis.nethackGlobal._inputLoop = false;
        log('init_nhwindows called');
        return Promise.resolve(0);
    }

    case 'shim_player_selection_or_tty': {
        // 返回 boolean: true = 让 genl_player_setup 处理 (tty 角色选择)
        // false = 自己处理角色选择
        log('player_selection_or_tty -> true (use genl mode)');
        return Promise.resolve(true); // true = 使用内置角色选择
    }

    case 'shim_askname': {
        // 询问玩家名字 - 返回空字符串让 NetHack 使用默认名
        log('askname: returning empty (use default)');
        return Promise.resolve('');
    }

    case 'shim_player_selection': {
        // 角色/种族/阵营等选择完成后的回调
        log('*** player_selection (选择完成) ***');
        return Promise.resolve();
    }

    case 'shim_get_nh_event': {
        // 在主循环中被频繁调用，每100次记录一次
        get_nh_event_count++;
        const now = Date.now();
        if (now - last_log_time > 3000) {
            log('get_nh_event called ' + get_nh_event_count + ' times, buffer=' + inputBuffer.length + ', waiting=' + (inputResolve ? 'yes' : 'no'));
            last_log_time = now;
        }
        // 如果有按键且当前在等待输入，可以在这里处理
        if (inputBuffer.length > 0 && inputResolve) {
            const key = inputBuffer.shift();
            const resolve = inputResolve;
            inputResolve = null;
            log('get_nh_event: flushing buffered key:', key);
            resolve(key);
        }
        return Promise.resolve();
    }

    case 'shim_exit_nhwindows': {
        addMessage('--- 游戏结束 ---');
        nethackReady = false;
        return Promise.resolve();
    }

    case 'shim_suspend_nhwindows':
    case 'shim_resume_nhwindows': {
        return Promise.resolve();
    }

    case 'shim_create_nhwindow': {
        // args: [type] -> 返回 winid
        const type = args[0];
        log('create_nhwindow type=' + type);
        // 返回一个自增的 window id
        if (!nethackShimCallback._nextWinId) nethackShimCallback._nextWinId = 1;
        const winid = nethackShimCallback._nextWinId++;

        // NHW_PERMINVENT = 6 是永久物品栏窗口
        if (type === 6) {
            nethackShimCallback._inventoryWinId = winid;
            log('Inventory window created with id=' + winid);
        }
        return Promise.resolve(winid);
    }

    case 'shim_clear_nhwindow': {
        // args: [winid]
        const winid = args[0];

        // 如果是物品栏窗口，清空物品栏
        if (winid === nethackShimCallback._inventoryWinId) {
            log('clear_nhwindow: clearing inventory winid=' + winid);
            clearInventory();
        } else {
            // 不再清除地图数据，因为会导致视野问题
            log('clear_nhwindow: winid=' + winid + ' (not clearing map)');
        }
        return Promise.resolve();
    }

    case 'shim_display_nhwindow': {
        const winid = args[0];
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
        // args: [winid, x, y]
        cursorX = args[1];
        cursorY = args[2];
        return Promise.resolve();
    }

    case 'shim_putstr': {
        // args: [winid, attr, str]
        const winid = args[0];
        const attr = args[1];
        const str = args[2];

        // 检查是否是物品栏窗口
        const invWinId = nethackShimCallback ? nethackShimCallback._inventoryWinId : null;
        log('putstr: winid=' + winid + ' invWinId=' + invWinId + ' str=' + (str ? str.substring(0,30) : 'null'));
        if (winid === invWinId && str) {
            // 更新物品栏面板
            log('putstr: adding to inventory');
            addInventoryItem(str, attr);
        } else if (str) {
            // 其他窗口显示在消息面板
            addMessage(str, attr);
        }
        return Promise.resolve();
    }

    case 'shim_display_file': {
        // args: [name, complain]
        const name = args[0];
        const complain = args[1];
        log('display_file:', name);
        addMessage('-- 按任意键继续 --');
        renderMap();
        // 等待用户按键继续
        return waitForKey().then(() => 0);
    }

    case 'shim_start_menu': {
        // args: [winid, mbehavior]
        const winid = args[0];
        const mbehavior = args[1];
        log('start_menu: winid=' + winid + ' mbehavior=' + mbehavior);
        menuItems = [];
        currentMenuWinId = winid;
        // 检查是否是物品栏窗口 (winid=6 是 NHW_PERMINVENT)
        // 或者通过 mbehavior 的 MENU_BEHAVE_PERMINV 标志判断
        isInventoryMenuFlag = (winid === 6) || (mbehavior === 1);
        log('start_menu: isInventory=' + isInventoryMenuFlag);
        return Promise.resolve();
    }

    case 'shim_add_menu': {
        // args: [winid, glyphinfo, identifier, ch, gch, attr, clr, str, itemflags]
        const strArg = args[7];
        const ch = args[3]; // 选择键
        const attr = args[5];
        let str = '';

        // 检查是否已经是字符串
        if (typeof strArg === 'string') {
            str = strArg;
        } else if (mod && strArg && typeof strArg === 'number') {
            try {
                str = mod.UTF8ToString(strArg);
            } catch (e) {
                str = '';
            }
        }

        // 分类：没有选择键的是标题/分组头，有选择键的是可选项
        if (str) {
            const chStr = ch ? String.fromCharCode(ch) : '';
            // isHeader: 没有选择键(ch为0)或者是纯标题行
            const isHeader = (ch === 0 || ch === undefined || ch === null) ||
                             // 或者是分类标题行（如 Weapons, Armor 等）
                             (/^[A-Za-z][a-z]+(s)?$/.test(str) && !chStr);
            menuItems.push({
                ch: chStr,
                text: str,
                selected: false,
                isHeader: isHeader
            });
        }
        return Promise.resolve();
    }

    case 'shim_end_menu': {
        // args: [winid, prompt]
        const winid = args[0];
        const promptPtr = args[1];
        let prompt = '选择:';
        if (mod && promptPtr) {
            try {
                prompt = mod.UTF8ToString(promptPtr) || '选择:';
            } catch (e) {
                prompt = '选择:';
            }
        }

        // 判断是否是真正的物品栏（通过内容特征）
        // 物品栏通常包含 Weapons/Armor/Comestibles 等分类头
        const hasInventoryHeaders = menuItems.some(item =>
            item.isHeader &&
            (item.text.includes('Weapons') ||
             item.text.includes('Armor') ||
             item.text.includes('Comestibles') ||
             item.text.includes('Gems') ||
             item.text.includes('Tools') ||
             item.text.includes('Potions') ||
             item.text.includes('Scrolls'))
        );

        // 真正的物品栏：isInventoryMenuFlag 为真 且 包含物品分类头
        const isRealInventory = isInventoryMenuFlag && hasInventoryHeaders;

        log('end_menu: winid=' + winid + ' prompt="' + prompt + '" items=' + menuItems.length +
            ' isInventoryFlag=' + isInventoryMenuFlag + ' hasInvHeaders=' + hasInventoryHeaders +
            ' isRealInv=' + isRealInventory);

        // 判断是需要选择的操作还是仅仅显示物品栏
        // 通过 prompt 判断：如果是 "选择:" 则是需要选择的菜单；如果是空或者是其他文本，则是物品栏面板
        const isSelectionPrompt = prompt && (prompt.includes('选择') || prompt.includes('Select') || prompt.includes('drop') || prompt.includes('use'));

        // 如果是真正的物品栏菜单且不需要选择，更新物品栏面板
        if (isRealInventory && !isSelectionPrompt) {
            log('end_menu: updating inventory panel');
            const list = $('inventory-list');
            if (list) {
                list.innerHTML = '';
                list.className = '';
                menuItems.forEach(item => {
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
        } else if (isSelectionPrompt) {
            // 显示选择弹窗
            const selectableItems = menuItems.filter(item => item.ch && item.ch !== ' ');
            log('end_menu: showing selection modal, items=' + selectableItems.length);
            if (selectableItems.length > 0) {
                showMenuModal(prompt, menuItems);
            }
        }
        return Promise.resolve();
    }

    case 'shim_select_menu': {
        // args: [winid, how, menu_list_ptr] -> 返回选中的数量
        const winid = args[0];
        const how = args[1];
        const menuListPtr = args[2];
        log('select_menu called: winid=' + winid + ' how=' + how + ' items=' + menuItems.length + ' isInventory=' + isInventoryMenuFlag);

        // 检查是否是真正的物品栏（通过内容特征）
        const hasInventoryHeaders = menuItems.some(item =>
            item.isHeader &&
            (item.text.includes('Weapons') ||
             item.text.includes('Armor') ||
             item.text.includes('Comestibles') ||
             item.text.includes('Gems') ||
             item.text.includes('Tools') ||
             item.text.includes('Potions') ||
             item.text.includes('Scrolls'))
        );
        const isRealInventory = isInventoryMenuFlag && hasInventoryHeaders;

        // 真正的物品栏菜单且不需要选择时，更新物品栏面板
        // how: 0=NONE, 1=ONE, 2=ANY - 需要选择时显示弹窗
        if (isRealInventory && how === 0) {
            log('select_menu: inventory menu (no selection needed), updating panel');
            // 更新物品栏面板
            const list = $('inventory-list');
            if (list) {
                list.innerHTML = '';
                menuItems.forEach(item => {
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

        // 对于需要选择的物品栏（如丢弃、使用物品），显示选择弹窗
        // 不修改 isInventoryMenuFlag，只是跳过物品栏面板的判断

        // 如果没有菜单项，返回 0
        if (menuItems.length === 0) {
            return Promise.resolve(0);
        }

        // 清空输入缓冲区
        clearInputBuffer();

        const selectableItems = menuItems.filter(item => item.ch && item.ch !== ' ');

        // 返回 Promise，等待用户从弹窗选择
        return new Promise((resolve) => {
            currentMenuResolve = (keyCode) => {
                const ch = String.fromCharCode(keyCode).toLowerCase();
                log('select_menu: key pressed:', ch, 'keyCode:', keyCode);

                // ESC 取消
                if (keyCode === 27) {
                    resolve(-1);
                    return;
                }

                // 只处理可打印字符 (字母、数字等) 和空格/回车
                // 过滤 modifier keys (Command, Control, Alt, etc.)
                const isPrintable = (keyCode >= 32 && keyCode <= 126);
                const isFunctionKey = keyCode >= 112 && keyCode <= 123; // F1-F12
                const isModifier = keyCode === 16 || keyCode === 17 || keyCode === 18 || 
                                   keyCode === 91 || keyCode === 92 || keyCode === 93; // Shift, Ctrl, Alt, Command

                if (!isPrintable && keyCode !== 27 && keyCode !== 32 && keyCode !== 13) {
                    log('select_menu: ignoring non-printable key', keyCode);
                    return; // 忽略 modifier keys 和 function keys
                }

                // 空格/回车选择第一个
                if ((keyCode === 32 || keyCode === 13) && selectableItems.length > 0) {
                    keyCode = selectableItems[0].ch.charCodeAt(0);
                }

                // 查找匹配项
                let selectedIdx = -1;
                for (let i = 0; i < menuItems.length; i++) {
                    if (menuItems[i].ch && menuItems[i].ch.toLowerCase() === String.fromCharCode(keyCode).toLowerCase()) {
                        selectedIdx = i;
                        break;
                    }
                }

                if (selectedIdx >= 0 && mod && menuListPtr) {
                    const menuItemSize = 12;
                    const menuList = mod._malloc(menuItemSize);
                    for (let i = 0; i < menuItemSize; i++) {
                        mod.setValue(menuList + i, 0, 'i8');
                    }
                    mod.setValue(menuList, menuItems[selectedIdx].ch.charCodeAt(0), 'i8');
                    mod.setValue(menuList + 8, 1, 'i32');
                    mod.setValue(menuListPtr, menuList, '*');
                    resolve(1);
                } else {
                    resolve(0);
                }
            };
        });
    }

    case 'shim_message_menu': {
        // args: [let, how, mesg] -> 返回 char (ASCII code integer)
        const mesg = args[2];
        if (mesg) addMessage(mesg);
        renderMap();
        return waitForKey().then((key) => key); // 返回 ASCII 码数字，不是字符串
    }

    case 'shim_mark_synch': {
        renderMap();
        return Promise.resolve();
    }

    case 'shim_wait_synch': {
        renderMap();
        // wait_synch 只需要同步屏幕，不需要等待输入
        // 输入由 nhgetch/nh_poskey 处理
        return Promise.resolve();
    }

    case 'shim_cliparound': {
        // args: [x, y]
        return Promise.resolve();
    }

    case 'shim_update_positionbar': {
        return Promise.resolve();
    }

    case 'shim_print_glyph': {
        // args: [winid, x, y, glyphinfo_ptr, bkglyphinfo_ptr]
        // 注意：现在 args[1] 和 args[2] 已经是 int16 值了
        //（在 nethack.js 的 local_callback 中已经解引用）
        const winid = args[0];
        const x = args[1];  // 已经是 int16 值
        const y = args[2];  // 已经是 int16 值
        const glyphinfoPtr = args[3];
        const bkglyphinfoPtr = args[4];

        // 处理地图窗口 (winid=1) 和其他窗口的地图绘制
        // 通常 winid=1 是主地图，但其他窗口也可能需要绘制
        if (winid !== 1 && winid !== 2) {
            return Promise.resolve();
        }

        // 从 glyphinfo 读取显示字符和颜色
        // glyph_info 结构:
        //   int glyph;        // offset 0
        //   int ttychar;      // offset 4  <- 实际显示的字符
        //   uint32 framecolor;// offset 8
        //   glyph_map gm;     // offset 12
        //     unsigned glyphflags;  // offset 12
        //     classic_representation sym; // offset 16
        //       int color;    // offset 16
        //       int symidx;   // offset 20  <- 符号索引，不是字符
        // 所以 color 在 offset 16, ttychar 在 offset 4
        let sym = 0, color = 7;
        if (mod && glyphinfoPtr) {
            try {
                // 读取 ttychar (int32 at offset 4) - 实际显示的字符
                sym = mod.getValue(glyphinfoPtr + 4, 'i32');
                // 读取 color (int32 at offset 16)
                color = mod.getValue(glyphinfoPtr + 16, 'i32');
                // 颜色值可能包含标志位，取低 4 位
                color = color & 0xF;
            } catch (e) {
                log('读取glyphinfo失败:', e);
            }
        }

        const ch = sym > 0 ? String.fromCharCode(sym) : ' ';
        log('print_glyph decoded: x=' + x + ' y=' + y + ' ch="' + ch + '" (sym=' + sym + ') color=' + color);

        if (y >= 0 && y < MAP_HEIGHT && x >= 0 && x < MAP_WIDTH) {
            mapRows[y][x] = ch;
            mapColors[y][x] = color;
        }
        // 不再立即渲染，等待 display_nhwindow 或 wait_synch 时批量渲染
        return Promise.resolve();
    }

    case 'shim_raw_print': {
        // args: [str]
        if (args[0]) addMessage(args[0]);
        return Promise.resolve();
    }

    case 'shim_raw_print_bold': {
        // args: [str]
        if (args[0]) addMessage(args[0], 1);
        return Promise.resolve();
    }

    case 'shim_nhgetch': {
        // 返回 int (按键 ASCII 码)
        log('*** shim_nhgetch called, buffer=' + inputBuffer.length + ' ***');
        renderMap();
        return waitForKey().then((key) => {
            log('*** nhgetch returning key:', key, '***');
            return key;
        });
    }

    case 'shim_nh_poskey': {
        // 返回 int, 同时设置 x, y, mod
        // args: [x_ptr, y_ptr, mod_ptr] - 需要写入输出值
        log('*** shim_nh_poskey called, buffer=' + inputBuffer.length + ', x_ptr=' + args[0] + ' ***');
        renderMap();
        return waitForKey().then((key) => {
            const x_ptr = args[0];
            const y_ptr = args[1];
            const mod_ptr = args[2];
            // 写入输出值 (int16 for x, y; int32 for mod)
            if (mod && x_ptr) mod.setValue(x_ptr, 0, 'i16');
            if (mod && y_ptr) mod.setValue(y_ptr, 0, 'i16');
            if (mod && mod_ptr) mod.setValue(mod_ptr, 0, 'i32');
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
        // args: [query, resp, def] -> 返回 char (ASCII 码)
        let query = args[0] || '?';
        let resp = args[1] || '';
        let def = args[2]; // ASCII 码

        // query 和 resp 可能是数字（指针），需要解码
        if (typeof query === 'number' && mod) {
            try { query = mod.UTF8ToString(query) || '?'; } catch (e) { query = '?'; }
        }
        if (typeof resp === 'number' && mod) {
            try { resp = mod.UTF8ToString(resp) || ''; } catch (e) { resp = ''; }
        }

        const defaultChar = (typeof def === 'number' && def > 0) ? def : 'n'.charCodeAt(0);

        // validChars: 有效的响应字符
        // 如果没有指定响应，默认是 'yn'
        let validChars = 'yn';
        if (resp && resp.length > 0 && resp !== '(null)') {
            validChars = resp.toLowerCase().replace(/[^a-z?*]/g, '');
        }

        // 回退：从 query 提取 [abc] 或 (abc) 格式的选项
        if (validChars === 'yn' && query.includes('[') && query.includes(']')) {
            const match = query.match(/\[([^\]]+)\]/);
            if (match) {
                // 提取括号内的字符，如 "ef or ?*" -> "ef?*"
                const options = match[1].replace(/\s+or\s+/g, '').replace(/[^a-z?*]/gi, '');
                if (options.length > 0) {
                    validChars = options.toLowerCase();
                }
            }
        }

        log('yn_function:', query, 'resp:', resp, 'default:', String.fromCharCode(defaultChar), 'valid:', validChars);
        lastQuery = query;
        addMessage(query);
        renderMap();

        // 清空输入缓冲区，避免残留按键干扰
        clearInputBuffer();

        // 显示 YN 弹窗
        showYnModal(query, validChars, defaultChar);

        // 返回 Promise，等待用户从弹窗选择
        return new Promise((resolve) => {
            currentYnResolve = (keyCode) => {
                const ch = String.fromCharCode(keyCode).toLowerCase();
                log('yn_function: selected', ch);

                // ESC 取消 - 返回 'q'
                if (keyCode === 27) {
                    resolve('q'.charCodeAt(0));
                    return;
                }

                // 检查是否是有效响应
                if (validChars.includes(ch)) {
                    resolve(keyCode);
                } else {
                    // 无效选择，继续等待
                    log('yn_function: invalid key', ch);
                }
            };
        });
    }

    case 'shim_getlin': {
        // args: [query, bufp] - 读取一行输入
        const query = args[0] || '';
        addMessage(query);
        renderMap();
        // 在输入框中提示
        $('command-input').placeholder = query;
        return waitForKey().then((key) => {
            // 简化：直接返回按键字符
            return String.fromCharCode(key);
        });
    }

    case 'shim_get_ext_cmd': {
        // 返回 int (扩展命令索引)
        addMessage('请输入扩展命令:');
        renderMap();
        return waitForKey().then((key) => {
            return -1; // -1 表示没有匹配的命令
        });
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
        // args: [fieldidx, nm, fmt, enable]
        return Promise.resolve();
    }

    case 'shim_status_update': {
        // args: [fldidx, ptr, chg, percent, color, colormasks]
        // ptr 是 genericptr_t，可以是整数、short 指针或字符串指针
        const fldidx = args[0];
        const ptrValue = args[1];
        const chg = args[2] || 0;
        const percent = args[3] || 0;
        const colorVal = args[4] || 0;

        let value = '';
        let valueType = 'i';

        // 字段定义
        const stringFields = [0, 20, 21, 22, 25, 26]; // TITLE, LEVELDESC, EXP, CONDITION, etc
        const shortFields = [1, 2, 3, 4, 5, 6, 11, 12, 16, 17]; // STR, DEX, CON, INT, WIS, CHA, etc
        const intFields = [8, 9, 10, 13, 14, 15, 18, 19, 23, 24]; // 整数类型字段

        // ptrValue 可能是直接值或内存地址
        // 从日志看，数字字段也是以 ASCII 字符串形式存储
        // 如 [49,56,0,0] = "18"，不是二进制整数
        if (typeof ptrValue === 'number' && ptrValue > 65536) {
            // 所有字段都当作字符串读取，然后转换为数字
            try {
                const str = mod ? mod.UTF8ToString(ptrValue) : '';
                if (stringFields.includes(fldidx)) {
                    // 字符串字段直接使用
                    value = str;
                    valueType = 's';
                } else {
                    // 数字字段：解析字符串为数字
                    value = parseInt(str) || 0;
                    valueType = 'i';
                }
            } catch (e) {
                value = stringFields.includes(fldidx) ? '' : 0;
                valueType = stringFields.includes(fldidx) ? 's' : 'i';
            }
        } else {
            // 直接值
            value = ptrValue;
            valueType = stringFields.includes(fldidx) ? 's' : 'i';
        }

        // 调试日志 - 详细诊断
        if ((callback_call_count['shim_status_update'] || 0) < 20) {
            let memDump = '';
            if (typeof ptrValue === 'number' && ptrValue > 65536 && mod) {
                try {
                    // 读取前4个字节看看内存内容
                    const b0 = mod.getValue(ptrValue, 'i8');
                    const b1 = mod.getValue(ptrValue + 1, 'i8');
                    const b2 = mod.getValue(ptrValue + 2, 'i8');
                    const b3 = mod.getValue(ptrValue + 3, 'i8');
                    const i16 = mod.getValue(ptrValue, 'i16');
                    const i32 = mod.getValue(ptrValue, 'i32');
                    memDump = ` mem=[${b0},${b1},${b2},${b3}] i16=${i16} i32=${i32}`;
                } catch(e) { memDump = ' mem=error'; }
            }
            log('status_update: fld=' + fldidx + ' raw=' + ptrValue + ' final=' + value + memDump);
        }
        callback_call_count['shim_status_update'] = (callback_call_count['shim_status_update'] || 0) + 1;

        updateStatusUI(fldidx, value, valueType, chg, percent, colorVal);
        return Promise.resolve();
    }

    case 'shim_preference_update': {
        return Promise.resolve();
    }

    case 'shim_getmsghistory': {
        // args: [init] -> 返回 string 或 null
        // NetHack 期望返回 null (空指针) 来终止消息历史循环
        const count = callback_call_count['shim_getmsghistory'] || 0;
        if (count === 1) {
            log('getmsghistory: init=' + args[0]);
        }
        callback_call_count['shim_getmsghistory'] = count + 1;
        // 返回空字符串表示历史结束
        // 注意：C 代码会将空字符串转换为 null 指针
        return Promise.resolve('');
    }

    case 'shim_putmsghistory': {
        // args: [msg, restoring]
        return Promise.resolve();
    }

    default:
        log('未处理的回调:', name, args);
        return Promise.resolve(0);
    }
}

// ============ 状态栏更新 ============
function updateStatusUI(fldidx, value, valueType, chg, percent, color) {
    // fldidx 是整数 (0-26)
    const displayValue = valueType === 's' ? String(value || '') : String(value || 0);

    // 调试：记录前几次调用
    const count = callback_call_count['update_ui'] || 0;
    if (count < 20) {
        log('updateUI: fld=' + fldidx + ' val=' + displayValue);
        callback_call_count['update_ui'] = count + 1;
    }

    // 使用数字直接匹配，不使用 BL 对象
    switch (fldidx) {
        case 0: // BL_TITLE
            setStatusField('stat-role', displayValue);
            break;
        case 1: // BL_STR
            setStatusField('stat-str', displayValue);
            break;
        case 2: // BL_DX
            setStatusField('stat-dex', displayValue);
            break;
        case 3: // BL_CO
            setStatusField('stat-con', displayValue);
            break;
        case 4: // BL_IN
            setStatusField('stat-int', displayValue);
            break;
        case 5: // BL_WI
            setStatusField('stat-wis', displayValue);
            break;
        case 6: // BL_CH
            setStatusField('stat-cha', displayValue);
            break;
        case 11: // BL_ENE
            setStatusField('stat-energy', displayValue);
            break;
        case 12: // BL_ENEMAX
            setStatusField('stat-maxenergy', displayValue);
            break;
        case 13: // BL_XP (经验值，也显示为等级)
            setStatusField('stat-xp', displayValue);
            // 如果没有等级字段，用经验值作为等级
            const currentLevel = document.getElementById('stat-level')?.textContent;
            if (!currentLevel || currentLevel === '--') {
                setStatusField('stat-level', displayValue);
            }
            break;
        case 14: // BL_AC
            setStatusField('stat-ac', displayValue);
            break;
        case 15: // BL_HD (等级/Hit Dice)
            log('BL_HD (level):', displayValue);
            setStatusField('stat-level', displayValue);
            break;
        case 18: // BL_HP
            setStatusField('stat-hp', displayValue);
            break;
        case 19: // BL_HPMAX
            setStatusField('stat-maxhp', displayValue);
            break;
        case 20: // BL_LEVELDESC
            setStatusField('stat-dlvl', displayValue);
            break;
        case 21: // BL_EXP
            setStatusField('stat-level', displayValue);
            break;
        case 7: // BL_ALIGN
            setStatusField('stat-align', displayValue);
            break;
            break;
        case BL.BL_CH:
            setStatusField('stat-cha', displayValue);
            break;
        case BL.BL_HP:
            setStatusField('stat-hp', displayValue);
            break;
        case BL.BL_HPMAX:
            setStatusField('stat-maxhp', displayValue);
            break;
        case BL.BL_GOLD:
            setStatusField('stat-gold', displayValue);
            break;
        case BL.BL_ENE:
            setStatusField('stat-energy', displayValue);
            break;
        case BL.BL_ENEMAX:
            setStatusField('stat-maxenergy', displayValue);
            break;
        case BL.BL_XP:
            setStatusField('stat-xp', displayValue);
            break;
        case BL.BL_AC:
            setStatusField('stat-ac', displayValue);
            break;
        case BL.BL_LEVELDESC:
            setStatusField('stat-dlvl', displayValue);
            break;
        case BL.BL_EXP:
            setStatusField('stat-level', displayValue);
            break;
        case BL.BL_HUNGER:
            setStatusField('stat-hunger', displayValue);
            break;
        case BL.BL_ALIGN:
            setStatusField('stat-align', displayValue);
            break;
        case BL.BL_SCORE:
            setStatusField('stat-score', displayValue);
            break;
        case BL.BL_TIME:
            setStatusField('stat-time', displayValue);
            break;
    }
}

// ============ 初始化 ============
function initGame() {
    log('初始化 NetHack WASM...');

    // 注册全局回调 - 必须在任何 WASM 调用前
    globalThis.nethackShimCallback = nethackShimCallback;

    // 手动初始化 nethackGlobal.helpers（因为 js_helpers_init 在 main 中调用，太晚了）
    globalThis.nethackGlobal = {
        helpers: {
            getPointerValue: function(name, ptr, type) {
                if (!mod || !mod.getValue) return ptr;

                // shim_status_update 特殊处理：第二个参数有时是整数有时是指针
                if (name === 'shim_status_update' && type === 'p') {
                    // 如果 ptr 是小数字，直接返回整数值
                    if (typeof ptr === 'number' && ptr >= -1000 && ptr <= 99999) {
                        return ptr;
                    }
                    // 否则作为指针读取
                    return mod.getValue(ptr, 'i32');
                }

                switch (type) {
                    case 's': return ptr ? mod.UTF8ToString(ptr) : '';
                    case 'p':
                        // 对于指针类型，如果 ptr 是一个小值（< 1000），
                        // 它可能是坐标值而不是指针
                        if (ptr < 1000) return ptr;
                        return ptr ? mod.getValue(ptr, '*') : 0;
                    case 'c': return String.fromCharCode(mod.getValue(ptr, 'i8'));
                    case 'b': return mod.getValue(ptr, 'i8') === 1;
                    case '0': return mod.getValue(ptr, 'i8');
                    case '1': return mod.getValue(ptr, 'i16');
                    case '2': case 'n': return mod.getValue(ptr, 'i32');
                    case 'i':
                        // 注意：winshim.c 中的 '1' (int16) 被编译成了 'i' (int32)
                        // 但参数实际上是指向 int16 的指针，需要读取 int16 值
                        if (name === 'shim_print_glyph' || name === 'shim_cliparound') {
                            return mod.getValue(ptr, 'i16');
                        }
                        return mod.getValue(ptr, 'i32');
                    case 'f': return mod.getValue(ptr, 'float');
                    case 'd': return mod.getValue(ptr, 'double');
                    case 'o': return ptr; // opaque
                    default: return ptr;
                }
            },
            setPointerValue: function(name, ptr, type, value) {
                if (!ptr) {
                    log('setPointerValue: ptr is null, name=' + name + ' type=' + type);
                    return;
                }
                // 获取正确的返回类型
                const fmt = SHIM_FORMATS[name] || { ret: type };
                const actualType = fmt.ret || type;

                // 为 getmsghistory 添加详细调试
                if (name && name.includes('getmsghistory')) {
                    console.log('[NH] setPointerValue:', name, 'ptr=', ptr, 'type=', type, 'actualType=', actualType, 'value=', value);
                    // 存储指针供后续使用
                    if (ptr) shim_return_values[name] = ptr;
                }

                // 允许 's' 类型的 value 为 null
                if (actualType === 's' && value === null) {
                    mod.setValue(ptr, 0, 'i32');
                    return;
                }

                switch (actualType) {
                    case 's':
                        // 's' 类型返回值是 char*，需要将返回值存入 ret_ptr 指向的内存
                        if (value === null || value === undefined) {
                            mod.setValue(ptr, 0, 'i32'); // 写入 NULL 指针
                        } else {
                            // 分配内存并复制字符串
                            const str = String(value);
                            const len = lengthBytesUTF8(str) + 1;
                            const strPtr = mod._malloc(len);
                            stringToUTF8(str, strPtr, len);
                            mod.setValue(ptr, strPtr, 'i32');
                        }
                        break;
                    case 'i': case '2': case 'n':
                        mod.setValue(ptr, value || 0, 'i32');
                        break;
                    case 'c':
                        // 字符类型：可以是数字(ASCII码)或字符串(取第一个字符)
                        let charCode = 0;
                        if (typeof value === 'number') {
                            charCode = value;
                        } else if (typeof value === 'string' && value.length > 0) {
                            charCode = value.charCodeAt(0);
                        }
                        mod.setValue(ptr, charCode, 'i8');
                        break;
                    case 'b':
                        // 布尔值：接受 boolean 或 number
                        if (typeof value === 'boolean') {
                            mod.setValue(ptr, value ? 1 : 0, 'i8');
                        } else if (typeof value === 'number') {
                            mod.setValue(ptr, value ? 1 : 0, 'i8');
                        } else {
                            mod.setValue(ptr, value ? 1 : 0, 'i8');
                        }
                        break;
                    case 'd': case 'f':
                        mod.setValue(ptr, value || 0, 'double');
                        break;
                    case 'v':
                        // void 返回类型，不需要写入
                        break;
                    default:
                        log('setPointerValue [' + name + ']: unknown type ' + actualType);
                }
            },
            displayInventory: function() {
                if (mod && mod._display_inventory) mod._display_inventory(0, 0);
            }
        },
        constants: {},
        globals: {},
        pointers: {},
        shimFunctionRunning: null,
        statusValues: {}  // 缓存状态栏值
    };
    log('nethackGlobal 已预初始化');

    // Module 配置
    const moduleConfig = {
        noInitialRun: true,  // 阻止自动运行 main
        arguments: ['nethack', '-D', 'notutorial'],  // 跳过教程
        print: (text) => { 
            log('WASM-OUT:', text);
            if (text && text.trim()) addMessage(text.trim()); 
        },
        printErr: (text) => { 
            log('WASM-ERR:', text); 
        },
        
        onRuntimeInitialized: function() {
            log('onRuntimeInitialized - 设置 shim 回调');
            // this 指向 Module 实例
            const mod = this;
            globalThis.nethackModule = mod;

            // 确保 nethackGlobal 存在并保留 helpers
            if (!globalThis.nethackGlobal) {
                globalThis.nethackGlobal = {};
            }
            // 重新设置 helpers（以防被覆盖）
            globalThis.nethackGlobal.helpers = nethackGlobal.helpers;
            globalThis.nethackGlobal.constants = nethackGlobal.constants || {};
            globalThis.nethackGlobal.globals = nethackGlobal.globals || {};
            globalThis.nethackGlobal.pointers = nethackGlobal.pointers || {};
            globalThis.nethackGlobal.statusValues = nethackGlobal.statusValues || {};

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
        mod = instance;
        log('WASM 加载完成，启动游戏...');
        $('loading').classList.add('hidden');
        nethackReady = true;
        log('nethackReady = true');
        // 用 ccall 调用 main
        try {
            log('Calling main...');
            mod.ccall('main', 'number', ['number', 'string'], [0, ''], {async: true}).then(() => {
                log('main 函数返回（正常不应返回）');
            }).catch((err) => {
                log('main 函数错误:', err);
            });
            log('游戏已启动');
        } catch (e) {
            log('启动失败:', e);
            addMessage('启动失败: ' + e.message);
        }
    }).catch((e) => {
        log('加载失败:', e);
        addMessage('加载失败: ' + e.message);
        $('loading').classList.add('hidden');
    });
}

// ============ 键盘事件 ============
document.addEventListener('keydown', function(e) {
    if (!nethackReady) return;

    // 检查YN弹窗是否显示
    const ynModal = $('yn-modal');
    if (ynModal && !ynModal.classList.contains('hidden')) {
        let keyCode;
        // 特殊处理 * 键（Shift+8 或数字键盘 *）
        if (e.key === '*') {
            keyCode = '*'.charCodeAt(0);
        } else if (e.key.length === 1) {
            keyCode = e.key.charCodeAt(0);
        } else {
            const keyMap = {
                'Enter': 13,
                'Escape': 27,
                'NumpadMultiply': 42, // 数字键盘 *
            };
            keyCode = keyMap[e.key] || e.keyCode || e.which;
        }
        e.preventDefault();
        e.stopPropagation();

        if (currentYnResolve) {
            // 直接比较字符，不转换大小写（因为 * ? 等符号不分大小写）
            const ch = String.fromCharCode(keyCode);
            const chLower = ch.toLowerCase();
            // 检查：小写字符是否在 validChars 中，或原始字符匹配特殊符号
            const isValid = currentYnValidChars.includes(chLower) ||
                           (ch === '*') ||
                           (ch === '?');
            log('YN key pressed:', ch, 'keyCode:', keyCode, 'valid:', isValid, 'validChars:', currentYnValidChars);
            if (isValid || keyCode === 27) {
                selectYnOption(keyCode);
            }
        }
        return;
    }

    // 检查菜单弹窗是否显示
    const menuModal = $('menu-modal');
    if (menuModal && !menuModal.classList.contains('hidden')) {
        // 菜单显示中，处理菜单选择
        let keyCode;
        if (e.key.length === 1) {
            keyCode = e.key.charCodeAt(0);
        } else {
            const keyMap = {
                'Enter': 13,
                'Escape': 27,
                'Space': 32,
            };
            keyCode = keyMap[e.key] || e.keyCode || e.which;
        }
        e.preventDefault();
        e.stopPropagation();

        // 如果正在等待菜单选择，直接调用菜单选择
        if (currentMenuResolve) {
            selectMenuItem(keyCode);
        }
        return;
    }

    // 不拦截输入框的按键（除非是 Enter）
    if (document.activeElement === $('command-input') && e.key !== 'Enter') {
        return;
    }

    // 阻止默认行为（方向键、空格等）
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab',' '].includes(e.key)) {
        e.preventDefault();
    }

    let keyCode;
    if (e.key.length === 1) {
        keyCode = e.key.charCodeAt(0);
    } else {
        // 特殊键映射
        const keyMap = {
            'Enter': 13,
            'Escape': 27,
            'Backspace': 8,
            'Tab': 9,
            'ArrowUp': 107,  // k
            'ArrowDown': 106, // j
            'ArrowLeft': 104, // h
            'ArrowRight': 108, // l
        };
        keyCode = keyMap[e.key] || e.keyCode || e.which;
    }

    sendKey(keyCode);
});

// 命令输入框
$('command-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submitCommand();
    }
});

// 虚拟键盘
document.querySelectorAll('.vkey').forEach(el => {
    el.addEventListener('click', function() {
        const key = this.dataset.key;
        sendKey(key.charCodeAt(0));
    });
});

// ============ 启动 ============
document.addEventListener('DOMContentLoaded', async function() {
    log('DOM 就绪，初始化...');

    // 动态导入 nethack.js (ES6 模块)
    // 检查是否使用原始 winshim.c
    globalThis._NH_USE_ORIGINAL_SHIM = true;

    try {
        log('导入 nethack.js 模块...');
        const nethackModule = await import('../../targets/wasm/nethack.js');
        globalThis.nethackModuleFactory = nethackModule.default;
        log('nethack.js 模块已加载（原始 shim 模式）');
        initGame();
    } catch (e) {
        log('导入 nethack.js 失败:', e);
        addMessage('加载失败: ' + e.message);
        $('loading').classList.add('hidden');
    }
});

// 全局暴露
globalThis.sendKey = sendKey;
globalThis.nethackShimCallback = nethackShimCallback;
