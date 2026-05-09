#!/bin/bash
# NetHack WASM Build Script
# Usage: ./build.sh [clean]

set -e  # Exit on error

echo "=========================================="
echo "NetHack WASM Build Script"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get script directory and find NetHack root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# NetHack is a sibling directory (submodule)
NETHACK_ROOT="$(cd "$SCRIPT_DIR/NetHack" && pwd)"
log_info "NetHack root: $NETHACK_ROOT"

cd "$NETHACK_ROOT"

# Clean build if requested
if [ "$1" == "clean" ]; then
    log_info "Cleaning build files..."
    make clean 2>/dev/null || true
    rm -f Makefile
    rm -f targets/wasm/*.o 2>/dev/null || true
    rm -f targets/wasm/nethack.js 2>/dev/null || true
    rm -f targets/wasm/nethack.wasm 2>/dev/null || true
    log_info "Clean completed"
fi

# Step 1: Generate Makefile
echo ""
log_info "Step 1: Generating Makefile..."
if [ -f "sys/unix/setup.sh" ]; then
    (cd sys/unix && sh setup.sh hints/macOS.500)
    log_info "Makefile generated successfully"
else
    log_error "setup.sh not found!"
    exit 1
fi

# Step 2: Check for Emscripten
echo ""
log_info "Step 2: Checking Emscripten..."
if ! command -v emcc &> /dev/null; then
    if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
        log_info "Loading Emscripten environment..."
        source "$HOME/emsdk/emsdk_env.sh"
    else
        log_error "emcc not found! Please install Emscripten or set up emsdk"
        log_error "Visit: https://emscripten.org/docs/getting_started/downloads.html"
        exit 1
    fi
fi

# Verify emcc is available
if ! command -v emcc &> /dev/null; then
    log_error "emcc still not available after loading emsdk"
    exit 1
fi

EMCC_VERSION=$(emcc --version | head -1)
log_info "Emscripten: $EMCC_VERSION"

# Step 3: Apply winshim.c patch
echo ""
log_info "Step 3: Applying winshim.c patches..."
python3 "$SCRIPT_DIR/patch_winshim.py"
if [ $? -ne 0 ]; then
    log_error "Failed to apply winshim.c patches"
    exit 1
fi

# Step 4: Build
echo ""
log_info "Step 4: Building NetHack WASM..."
log_info "This may take a few minutes..."
echo ""

# Source emsdk and build
if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    source "$HOME/emsdk/emsdk_env.sh"
fi

log_info "Building with parallel jobs..."
make -j CROSS_TO_WASM=1 all 2>&1 | tee /tmp/build.log

# Step 5: Restore winshim.c to original state
log_info "Step 5: Restoring winshim.c to original state..."
# Always restore from git to ensure clean state
if git checkout win/shim/winshim.c 2>/dev/null; then
    log_info "winshim.c restored from git"
    # Also remove any backup file if exists
    rm -f win/shim/winshim.c.bak
else
    log_warn "Could not restore winshim.c from git"
fi

# Check if build succeeded
if [ -f "targets/wasm/nethack.js" ] && [ -f "targets/wasm/nethack.wasm" ]; then
    echo ""
    log_info "=========================================="
    log_info "Build completed successfully!"
    log_info "=========================================="
    echo ""
    ls -lh targets/wasm/nethack.js targets/wasm/nethack.wasm
    echo ""
    log_info "Files generated:"
    JS_SIZE=$(wc -c < targets/wasm/nethack.js | awk '{print $1/1024/1024}')
    WASM_SIZE=$(wc -c < targets/wasm/nethack.wasm | awk '{print $1/1024/1024}')
    log_info "  - targets/wasm/nethack.js (${JS_SIZE} MB)"
    log_info "  - targets/wasm/nethack.wasm (${WASM_SIZE} MB)"
    echo ""
    log_info "To run: Open index.html in a web server"
    log_info "  python3 -m http.server 8000"
else
    log_error "Build failed! Check /tmp/build.log for details"
    exit 1
fi
