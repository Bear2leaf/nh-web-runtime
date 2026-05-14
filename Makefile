# NetHack WASM Runtime — Makefile
#
# Orchestrates the NetHack WASM build: applies patches, builds via
# the submodule's own Makefile, then restores all patched files so
# the NetHack submodule remains clean after every build.
#
# Usage:
#   make            — build nethack.js + nethack.wasm
#   make clean      — clean all build artifacts
#   make test       — run Playwright e2e tests
#   make serve      — start a local HTTP server on port 8080

# ── Paths ────────────────────────────────────────────────────────────────

ROOT        := $(CURDIR)
NH          := $(ROOT)/NetHack
WASM_DIR    := $(NH)/targets/wasm
WASM_JS     := $(WASM_DIR)/nethack.js
WASM_WASM   := $(WASM_DIR)/nethack.wasm
PATCH_FILES := $(ROOT)/patches/winshim.patch $(ROOT)/patches/nethack-restart.patch
# All files touched by the patches — must be restored after build
PATCHED_FILES := win/shim/winshim.c include/extern.h sys/libnh/libnhmain.c \
    sys/unix/hints/include/cross-pre2.500 src/allmain.c src/end.c src/invent.c

# ── Emscripten ───────────────────────────────────────────────────────────

EMSDK_ENV   := $(HOME)/emsdk/emsdk_env.sh

# ── Targets ──────────────────────────────────────────────────────────────

.PHONY: all clean serve test test-node

all: $(WASM_JS)

# ── Build ────────────────────────────────────────────────────────────────

$(WASM_JS): .patches-applied
	@echo "[BUILD] Compiling WASM..."
	@if [ -f $(EMSDK_ENV) ]; then . $(EMSDK_ENV); fi && \
		$(MAKE) -C $(NH) CROSS_TO_WASM=1 wasm
	@echo "[BUILD] Restoring patched files..."
	cd $(NH) && git checkout $(PATCHED_FILES)
	@rm -f .patches-applied
	@echo "[BUILD] Done — $(WASM_JS)"

# ── Patch + setup ────────────────────────────────────────────────────────
# Generate the NetHack Makefile then apply all patches.
# The .patches-applied sentinel drives the dependency chain.

.patches-applied: $(NH)/Makefile $(PATCH_FILES)
	@echo "[PATCH] Applying NetHack patches..."
	@for p in $(PATCH_FILES); do \
		echo "  $$p"; \
		cd $(NH) && git apply $$p || exit 1; \
	done
	@echo "[SETUP] Regenerating NetHack Makefiles after patch..."
	cd $(NH)/sys/unix && sh setup.sh hints/macOS.500
	@touch $@

# ── NetHack Makefile generation ──────────────────────────────────────────

$(NH)/Makefile: $(NH)/lib/lua-5.4.8/src/lua.h
	@echo "[SETUP] Generating NetHack Makefiles..."
	cd $(NH)/sys/unix && sh setup.sh hints/macOS.500

# ── Lua source (required by NetHack) ─────────────────────────────────────

$(NH)/lib/lua-5.4.8/src/lua.h:
	@echo "[LUA] Fetching Lua source..."
	$(MAKE) -C $(NH) fetch-lua

# ── Clean ────────────────────────────────────────────────────────────────

clean:
	@echo "[CLEAN] Restoring patched files..."
	cd $(NH) && git checkout $(PATCHED_FILES) 2>/dev/null || true
	@rm -f .patches-applied
	@echo "[CLEAN] Removing WASM artifacts..."
	rm -f $(WASM_JS) $(WASM_WASM)
	rm -f $(WASM_DIR)/*.o
	@echo "[CLEAN] Cleaning NetHack build..."
	$(MAKE) -C $(NH) clean 2>/dev/null || true
	rm -f $(NH)/Makefile

# ── Serve ────────────────────────────────────────────────────────────────

serve:
	python3 -m http.server 8080

# ── Test ─────────────────────────────────────────────────────────────────

TEST_PORT := 8100
TEST_PID  := $(ROOT)/.test-server.pid

test:
	@echo "[TEST] Starting HTTP server on port $(TEST_PORT)..."
	python3 -m http.server $(TEST_PORT) & echo $$! > $(TEST_PID)
	@sleep 1
	@echo "[TEST] Running Playwright tests..."
	npx playwright test test/ --reporter=line; RET=$$?; \
		kill $$(cat $(TEST_PID)) 2>/dev/null; rm -f $(TEST_PID); \
		exit $$RET

# Node.js test runner (runs nav-ai directly in Node, no browser)
test-node:
	@echo "[NODE-TEST] Running Node.js test runner..."
	@node test/node-runner.js
