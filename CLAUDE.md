# NetHack Web Runtime

A browser + Node.js runtime for NetHack compiled to WebAssembly (WASM) via Emscripten.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (index.html)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │   UI     │  │   Map    │  │  Input   │  │  Status  │        │
│  │ (ui.js)  │  │(map.js)  │  │(input.js)│  │(status.js)│       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘        │
│       └──────────────┴─────────────┴─────────────┘              │
│                          │                                      │
│                    ┌─────┴─────┐                                │
│                    │  state.js │  (shared mutable state S)      │
│                    └─────┬─────┘                                │
│                          │                                      │
│                    ┌─────┴─────┐                                │
│                    │ shim.js   │  (WASM callbacks → DOM)        │
│                    └─────┬─────┘                                │
│                          │                                      │
│  ┌───────────────────────┴───────────────────────┐              │
│  │          NetHack WASM (nethack.wasm)           │              │
│  │  Emscripten + Asyncify (ccall with async:true) │              │
│  └───────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Node.js (test/node-runner.js)
                              │
  ┌───────────────────────────┴───────────────────────────┐
  │              Node.js Shim (src/shim-node.js)           │
  │  Same WASM callbacks, but writes to plain JS object    │
  │  (shimState) instead of DOM.                           │
  └───────────────────────────────────────────────────────┘
                              │
  ┌───────────────────────────┴───────────────────────────┐
  │              Nav-AI (test/nav-ai.mjs)                    │
  │  Reads map from shimState via NHNodeEnv adapter.       │
  │  Sends keys via queueMicrotask iteration.              │
  └───────────────────────────────────────────────────────┘
```

## File Overview

### Browser Runtime (`src/`)

| File | Purpose | Exports |
|------|---------|---------|
| `state.js` | Shared mutable state object `S` | `S` (default) |
| `shim.js` | WASM callback dispatcher — DOM side | `nethackShimCallback`, `SHIM_FORMATS`, `getPointerValue`, `setPointerValue` |
| `map.js` | Map grid (80×21) and rendering | `MAP_WIDTH`, `MAP_HEIGHT`, `initMap()`, `renderMap()` |
| `status.js` | Status bar field dispatch | `BL` (constants), `updateStatusUI()` |
| `input.js` | Key buffering and `waitForKey()` | `sendKey()`, `waitForKey()`, `clearInputBuffer()`, `submitCommand()` |
| `ui.js` | DOM helpers (messages, modals, inventory) | `log()`, `addMessage()`, `showYnModal()`, `showMenuModal()`, etc. |
| `init.js` | Bootstrap: wires everything, starts WASM | `initGame()` |

### Node.js Shim (`src/shim-node.js`)

| File | Purpose | Exports |
|------|---------|---------|
| `shim-node.js` | WASM callback dispatcher — Node side | `shimState`, `sendKey()`, `waitForKey()`, `nethackShimCallback()`, `setModule()` |

### Test & Nav AI (`test/`)

| File | Purpose |
|------|---------|
| `nav-core.mjs` | Constants, BFS, map scanning, monster detection |
| `nav-strategy.mjs` | State machine handlers (explore/search/fight/door) |
| `nav-ai.mjs` | Main loop — queueMicrotask-driven, orchestrates state machine |
| `nav-browser-env.mjs` | Browser NavEnv adapter (reads DOM) |
| `nav-env-node.js` | Node NavEnv adapter (reads shimState) |
| `node-runner.js` | Node test runner — loads WASM directly, runs nav-ai |
| `e2e.spec.js` | Playwright E2E tests (browser) |
| `helpers.js` | Playwright test helpers |

## Key Design Decisions

### 1. Dual IIFE + ESM Export Pattern
`nav-*.mjs` files use an IIFE to set `globalThis.NHNav` (for browser script injection) AND export via ES modules (for Node.js). This lets the same code run in both environments.

### 2. NavEnv Adapter Pattern
The navigation AI is environment-agnostic. It reads game state through a `NavEnv` interface:
- `NHBrowserEnv` — reads DOM (browser)
- `NHNodeEnv` — reads `shimState` object (Node)

This allows the same AI code to run in Playwright tests and Node.js tests.

### 3. Microtask-Driven Loop (Node)
`nav-ai.mjs` uses `queueMicrotask` for iteration, not `setTimeout`/`setImmediate`. Before each `step()`, it checks `env.isReadyForInput()` to ensure WASM is waiting for input, preventing key buffering.

### 4. Asyncify
WASM is compiled with Emscripten Asyncify. `ccall('main', { async: true })` handles the unwind/rewind cycle. Every shim callback returns a Promise, and `waitForKey()` returns a Promise that resolves when a key is sent.

## Build

```bash
make          # Build WASM (patches winshim.c, builds, restores)
make serve    # Start dev server on :8100
make test     # Run Playwright tests
make test-node # Run Node.js test runner
```

## Development Workflow

### Browser
1. `make serve` — starts server on :8100
2. Open `http://127.0.0.1:8100/index.html`
3. WASM loads → character creation → game starts

### Node.js Test
```bash
node test/node-runner.js
```
Runs the same nav-ai code but bypasses the browser entirely. Execution is sub-second.

### Playwright Test
```bash
npx playwright test
```
Runs browser E2E tests including the nav-ai integration test (walks to next level).

## Important Notes

- **WASM files are in the NetHack submodule** (`NetHack/targets/wasm/`). Run `make` to build them.
- **Node.js shim auto-resolves YN prompts**: "pick/select" → 'y', "Really step" → 'y', "What do you want to eat?" → 'a' (floor food).
- **Node.js shim auto-resolves menus**: skips tutorial items, prefers "start"/"yes"/"play".
- **Level change detection**: `shim_status_update` with `BL_LEVELDESC` triggers map clearing in both browser and Node shims.
- **MAX_TICKS**: Navigation AI stops with reason `'max-ticks'` if it exceeds 50,000 iterations.
