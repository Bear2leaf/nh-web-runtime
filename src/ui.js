/**
 * DOM helpers and UI side-effect functions.
 *
 * All direct DOM manipulation lives here so shim callbacks stay declarative.
 */

import S from './state.js';

// ---- Helpers -----------------------------------------------------------

function $(id) {
    return document.getElementById(id);
}

// ---- Logging -----------------------------------------------------------

export function log(...args) {
    console.log('[NH]', ...args);
}

// ---- Message panel ----------------------------------------------------

export function addMessage(text, attr) {
    const panel = $('message-panel');
    const div = document.createElement('div');
    div.className = 'message';
    if (attr === 1) div.style.fontWeight = 'bold';
    div.textContent = text;
    panel.appendChild(div);
    while (panel.children.length > 200) panel.removeChild(panel.firstChild);
    panel.scrollTop = panel.scrollHeight;
}

export function clearMessages() {
    $('message-panel').innerHTML = '';
}

// ---- Inventory panel ---------------------------------------------------

export function clearInventory() {
    S.inventoryItems = [];
    const list = $('inventory-list');
    if (list) {
        list.innerHTML = '空';
        list.className = 'inventory-empty';
    }
}

export function addInventoryItem(text, attr) {
    const list = $('inventory-list');
    if (!list) return;

    if (S.inventoryItems.length === 0) {
        list.innerHTML = '';
        list.className = '';
    }

    S.inventoryItems.push({ text, attr });

    const div = document.createElement('div');
    div.className = 'inventory-item';
    if (attr === 1) div.style.fontWeight = 'bold';
    div.textContent = text;
    list.appendChild(div);
}

// ---- Menu modal -------------------------------------------------------

export function showMenuModal(title, items) {
    const modal = $('menu-modal');
    const titleEl = $('menu-title');
    const itemsEl = $('menu-items');

    if (!modal || !titleEl || !itemsEl) return;

    titleEl.textContent = title || '选择';
    itemsEl.innerHTML = '';

    items.forEach(item => {
        const div = document.createElement('div');
        const hasKey = (item.ch && item.ch !== ' ') || (item.acc && item.acc !== ' ');
        const keyLabel = (item.ch && item.ch !== ' ') ? item.ch : (item.acc || '');
        if (item.isHeader) {
            div.className = 'menu-header';
            div.textContent = item.text;
        } else if (hasKey) {
            div.className = 'menu-item';
            div.dataset.key = keyLabel;
            div.innerHTML = `<span class="menu-key">${keyLabel}</span><span class="menu-text">${item.text}</span>`;
            div.onclick = () => selectMenuItem(keyLabel);
        } else {
            div.className = 'menu-row';
            div.style.padding = '4px 12px';
            div.style.color = '#aaa';
            div.textContent = item.text;
        }
        itemsEl.appendChild(div);
    });

    modal.classList.remove('hidden');
}

export function hideMenuModal() {
    const modal = $('menu-modal');
    if (modal) modal.classList.add('hidden');
}

export function selectMenuItem(keyOrCode) {
    if (S.currentMenuResolve) {
        const code = typeof keyOrCode === 'string' ? keyOrCode.charCodeAt(0) : keyOrCode;
        S.currentMenuResolve(code);
    }
}

// ---- YN modal --------------------------------------------------------

export function showYnModal(question, validChars, defaultChar) {
    const modal = $('yn-modal');
    const questionEl = $('yn-question');
    const buttonsEl = $('yn-buttons');

    if (!modal || !questionEl || !buttonsEl) return;

    questionEl.textContent = question;
    buttonsEl.innerHTML = '';
    S.currentYnValidChars = validChars;

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

export function hideYnModal() {
    const modal = $('yn-modal');
    if (modal) modal.classList.add('hidden');
}

export function selectYnOption(keyCode) {
    if (S.currentYnResolve) {
        S.currentYnResolve(keyCode);
    }
}

// ---- Status bar fields ------------------------------------------------

export function setStatusField(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}
