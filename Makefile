# NetHack WASM Runtime — Makefile
#
# Orchestrates the NetHack WASM build: patches winshim.c, builds via
# the submodule's own Makefile, then restores the patched file.
#
# Usage:
#   make            — build nethack.js + nethack.wasm
#   make clean      — clean all build artifacts
#   make serve      — start a local HTTP server on port 8080

# ── Paths ────────────────────────────────────────────────────────────────

ROOT        := $(CURDIR)
NH          := $(ROOT)/NetHack
WASM_DIR    := $(NH)/targets/wasm
WASM_JS     := $(WASM_DIR)/nethack.js
WASM_WASM   := $(WASM_DIR)/nethack.wasm
WINSWIM     := $(NH)/win/shim/winshim.c
PATCH_FILE  := $(ROOT)/patches/winshim.patch

# ── Emscripten ───────────────────────────────────────────────────────────

EMSDK_ENV   := $(HOME)/emsdk/emsdk_env.sh

# ── Targets ──────────────────────────────────────────────────────────────

.PHONY: all clean serve

all: $(WASM_JS)

# ── Build ────────────────────────────────────────────────────────────────

$(WASM_JS): .winshim-patched
	@echo "[BUILD] Compiling WASM..."
	@if [ -f $(EMSDK_ENV) ]; then . $(EMSDK_ENV); fi && \
		$(MAKE) -C $(NH) CROSS_TO_WASM=1 wasm
	@echo "[BUILD] Restoring winshim.c..."
	cd $(NH) && git checkout win/shim/winshim.c
	@rm -f .winshim-patched
	@echo "[BUILD] Done — $(WASM_JS)"

# ── Patch + setup ────────────────────────────────────────────────────────
# Generate the NetHack Makefile then apply our winshim.c patch.
# The .winshim-patched sentinel drives the dependency chain.

.winshim-patched: $(NH)/Makefile $(WINSWIM) $(PATCH_FILE)
	@echo "[PATCH] Applying winshim.c patch..."
	cd $(NH) && git apply $(PATCH_FILE)
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
	@echo "[CLEAN] Restoring winshim.c..."
	cd $(NH) && git checkout win/shim/winshim.c 2>/dev/null || true
	@rm -f .winshim-patched
	@echo "[CLEAN] Removing WASM artifacts..."
	rm -f $(WASM_JS) $(WASM_WASM)
	rm -f $(WASM_DIR)/*.o
	@echo "[CLEAN] Cleaning NetHack build..."
	$(MAKE) -C $(NH) clean 2>/dev/null || true
	rm -f $(NH)/Makefile

# ── Serve ────────────────────────────────────────────────────────────────

serve:
	python3 -m http.server 8080
