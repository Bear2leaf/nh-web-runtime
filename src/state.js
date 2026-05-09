/**
 * Shared mutable state for the NetHack web runtime.
 *
 * All modules import this single object to read/write global state.
 * Using one object avoids circular-import issues that individual
 * `export let` variables would cause.
 */

const S = {
    // WASM Module instance (set in init.js after factory resolves)
    mod: null,

    // Whether the game is ready to accept input
    nethackReady: false,

    // Input system
    inputResolve: null,      // current Promise resolve for waitForKey
    inputBuffer: [],         // queued key codes

    // Menu / inventory state
    menuItems: [],           // current menu items for add_menu/select_menu
    currentMenuResolve: null, // Promise resolve for select_menu
    currentMenuWinId: null,   // window id of the current menu
    isInventoryMenuFlag: false,
    lastMenuPrompt: '',       // saved by end_menu, used by select_menu

    // Query tracking
    lastQuery: '',            // last yn_function question text

    // Window tracking
    mapWinId: null,           // winid returned by create_nhwindow(NHW_MAP)

    // Level-change detection
    lastLevelDesc: '',        // previous BL_LEVELDESC value

    // Inventory panel
    inventoryItems: [],

    // YN modal state
    currentYnResolve: null,
    currentYnValidChars: '',

    // Debug counters
    callback_call_count: {},
    get_nh_event_count: 0,
    last_log_time: Date.now(),

    // Stuck-input detection
    lastInputBufferLen: 0,
    stuckCounter: 0,

    // Map grid (reassigned by initMap, but S.mapRows always points to current)
    mapRows: [],
    mapColors: [],

    // Cursor position
    cursorX: 0,
    cursorY: 0,
};

export default S;
