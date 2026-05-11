/**
 * NHNodeEnv — Node.js environment adapter for nav-ai.
 *
 * Implements the NavEnv interface by reading from shimState (the Node shim's
 * plain state object) instead of the browser DOM.
 */

export class NHNodeEnv {
    constructor(shimState, sendKeyFn) {
        this._s = shimState;
        this._sendKey = sendKeyFn;
    }

    getDlvl() {
        return this._s.dlvl || '1';
    }

    getHp() {
        return parseInt(this._s.hp) || 999;
    }

    getMaxHp() {
        return parseInt(this._s.maxHp) || 999;
    }

    getHunger() {
        return this._s.hunger || '';
    }

    isYnVisible() {
        return this._s.ynVisible;
    }

    getYnText() {
        return this._s.ynText || '';
    }

    isMenuVisible() {
        return this._s.menuVisible;
    }

    getMenuText() {
        return this._s.menuText || '';
    }

    getMap() {
        if (!this._s.mapRows || this._s.mapRows.length === 0) {
            return [];
        }
        return this._s.mapRows.map(row => row.slice());
    }

    getRecentMessages(n) {
        const msgs = this._s.messages || [];
        return msgs.slice(-n);
    }

    sendKey(code) {
        this._sendKey(code);
    }

    clickYnButton() {
        // Auto-resolve with default character
        return this._s.ynDefaultChar;
    }

    isGameDone() {
        return !!this._s.done;
    }

    isReadyForInput() {
        return this._s.inputResolve !== null || this._s.ynResolve !== null;
    }
}
