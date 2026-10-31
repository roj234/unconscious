#!/usr/bin/env bash
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-D:/app/llvm-mingw/bin}"
NODE_EXE="${NODE_EXE:-D:/app/node/node.exe}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT/build"
# prebuilds live at the repository root
PREBUILD_DIR="$ROOT/prebuilds"
# Node headers ship with this repository (include/node)
NODE_HEADERS="${NODE_HEADERS:-$ROOT/include/node}"

PLATFORM_DIR="win32-x64"
OUT_DIR="$PREBUILD_DIR/$PLATFORM_DIR"

GEN_DEF="$TOOLCHAIN/gendef"
DLLTOOL="$TOOLCHAIN/llvm-dlltool"
CLANG="$TOOLCHAIN/clang"

mkdir -p "$BUILD_DIR" "$OUT_DIR"

if [ ! -f "$BUILD_DIR/node.a" ]; then
    (cd "$BUILD_DIR" && "$GEN_DEF" "$NODE_EXE")
    "$DLLTOOL" -m i386:x86-64 -d "$BUILD_DIR/node.def" -l "$BUILD_DIR/node.a" -D "node.exe"
fi

"$CLANG" \
    -DNAPI_VERSION=8 \
    -I"$NODE_HEADERS" \
    -O2 -Wall -Wextra \
    -shared -Wl,-s,--no-insert-timestamp -s \
    "$ROOT/src/win-impl.c" \
    -o "$OUT_DIR/sadbox.node" \
    "$BUILD_DIR/node.a" \
    -lbcrypt -lole32 -ladvapi32 -lkernel32

(cd "$OUT_DIR" && node -e "const s = require('./sadbox.node'); console.log('SbieSvc v', s.getVersion())")

echo
echo "Build complete: $OUT_DIR/sadbox.node"
