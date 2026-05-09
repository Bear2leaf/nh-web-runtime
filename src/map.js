/**
 * Map grid state and rendering.
 *
 * The C side calls shim_print_glyph for each visible cell.
 * We store them in S.mapRows/S.mapColors and render to a <pre> element.
 */

import S from './state.js';

export const MAP_WIDTH = 80;
export const MAP_HEIGHT = 21;

export function initMap() {
    S.mapRows = [];
    S.mapColors = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        S.mapRows[y] = new Array(MAP_WIDTH).fill(' ');
        S.mapColors[y] = new Array(MAP_WIDTH).fill(0);
    }
}

export function renderMap() {
    const mapEl = document.getElementById('game-map');
    if (!mapEl) return;

    let html = '';
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            const ch = S.mapRows[y][x];
            const clr = S.mapColors[y][x];
            let display = ch;
            if (ch === ' ') display = '\u00A0';
            if (clr === 0) {
                html += display;
            } else {
                html += `<span style="color:${getCssColor(clr)}">${display}</span>`;
            }
        }
        html += '\n';
    }
    mapEl.innerHTML = html;
}

export function getCssColor(nhColor) {
    const colors = [
        '#aaa',      // 0  CLR_BLACK
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
