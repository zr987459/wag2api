#!/usr/bin/env bash
# 编译精简版 SpiderMonkey 并打包成与上游 tar.gz 相同的结构（include/ + lib/libjs_static.a + lib/libjsrust.a）。
# 环境变量：
#   SM_SRC        Firefox 源码目录（已检出上游 tag，见 FIREFOX_SHA）
#   ZIG           zig 0.16 可执行文件
#   ICU_LANGS     保留的 ICU 语言（空格分隔），"all" 表示不裁剪；默认读 icu-languages.txt
#   OUT           输出 tar.gz 路径
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${SM_SRC:?}" "${ZIG:?}" "${OUT:?}"
JOBS="${JOBS:-$(nproc)}"
if [ -z "${ICU_LANGS:-}" ]; then
  ICU_LANGS="$(grep -v '^\s*#' "$HERE/icu-languages.txt" | tr '\n' ' ')"
fi
ICU_LANGS="$(echo $ICU_LANGS)"

# ---------- 1. 工具链包装 ----------
ZT=/tmp/zig-toolchain
mkdir -p "$ZT"
cp "$HERE/zig-wrapper.sh" "$ZT/zig-wrapper.sh"; chmod +x "$ZT/zig-wrapper.sh"
ln -sf zig-wrapper.sh "$ZT/cc"; ln -sf zig-wrapper.sh "$ZT/c++"
export ZIG ZIG_TARGET=aarch64-linux-musl
export ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
export CC_aarch64_unknown_linux_musl="$ZT/cc" CXX_aarch64_unknown_linux_musl="$ZT/c++"
export AR_aarch64_unknown_linux_musl=llvm-ar

# ---------- 2. 裁剪 ICU 数据（按 Firefox 自己的 intl/icu_sources_data.py 方式重建 icudt*.dat） ----------
DAT="$(ls "$SM_SRC"/config/external/icu/data/icudt*l.dat)"
echo "原 ICU 数据: $(basename "$DAT") $(stat -c %s "$DAT") 字节"
if [ "$ICU_LANGS" != "all" ]; then
  python3 - "$SM_SRC/intl/icu/data_filter.json" /tmp/icu_filter.json $ICU_LANGS <<'PY'
import json, sys
src, dst, *langs = sys.argv[1:]
f = json.load(open(src))
f["localeFilter"] = {"filterType": "language", "includelist": sorted(set(langs))}
json.dump(f, open(dst, "w"), indent=1)
print("ICU localeFilter:", " ".join(sorted(set(langs))))
PY
  rm -rf /tmp/icu-obj && mkdir -p /tmp/icu-obj
  (
    cd /tmp/icu-obj
    export CC=gcc CXX=g++
    export CPPFLAGS="-DU_NO_DEFAULT_INCLUDE_UTF_HEADERS=1 -DU_HIDE_OBSOLETE_UTF_OLD_H=1 -DUCONFIG_NO_LEGACY_CONVERSION -DUCONFIG_NO_TRANSLITERATION -DUCONFIG_NO_REGULAR_EXPRESSIONS -DUCONFIG_NO_BREAK_ITERATION -DUCONFIG_NO_IDNA -DUCONFIG_NO_MF2 -DUCONFIG_NO_NORMALIZATION=1 -DUCONFIG_NO_COLLATION -DU_CHARSET_IS_UTF8"
    export ICU_DATA_FILTER_FILE=/tmp/icu_filter.json
    sh "$SM_SRC/intl/icu/source/configure" --with-data-packaging=archive --enable-static --disable-shared \
      --disable-extras --disable-icuio --disable-layout --disable-layoutex --disable-tests --disable-samples --disable-strict >/tmp/icu-configure.log 2>&1 \
      || { tail -50 /tmp/icu-configure.log; exit 1; }
    make -j"$JOBS" >/tmp/icu-make.log 2>&1 || { tail -80 /tmp/icu-make.log; exit 1; }
  )
  NEW="/tmp/icu-obj/data/out/$(basename "$DAT")"
  [ -f "$NEW" ] || { echo "没有生成 $(basename "$DAT")"; ls /tmp/icu-obj/data/out; exit 1; }
  cp "$NEW" "$DAT"
  echo "精简 ICU 数据: $(stat -c %s "$DAT") 字节"
fi

# ---------- 3. 编译 SpiderMonkey ----------
cp "$HERE/mozconfig" /tmp/mozconfig-sm
cat >> /tmp/mozconfig-sm <<MC
export CC="$ZT/cc"
export CXX="$ZT/c++"
export HOST_CC=clang
export HOST_CXX=clang++
export AR=llvm-ar
export NM=llvm-nm
export RANLIB=llvm-ranlib
export OBJCOPY=llvm-objcopy
export STRIP=llvm-strip
mk_add_options MOZ_PARALLEL_BUILD=$JOBS
# 新版 rustc 无法把 configure 猜出的 x86_64-pc-linux-gnu 对上 Rust 目标，显式给出
ac_add_options --host=$(uname -m)-unknown-linux-gnu
MC
cd "$SM_SRC"
export MOZCONFIG=/tmp/mozconfig-sm MOZBUILD_STATE_PATH=/tmp/mozbuild MACH_NO_WRITE_TIMES=1
./mach --no-interactive configure
./mach --no-interactive build

# ---------- 4. 打包 ----------
OBJ="$SM_SRC/obj-sm"
JS_A="$(find "$OBJ" -name libjs_static.a -not -path '*/dist/*' | head -1)"
RS_A="$(find "$OBJ" -name libjsrust.a -not -path '*/dist/*' | head -1)"
echo "静态库清单:"; find "$OBJ" -name '*.a' -not -path '*/dist/*' -exec ls -l {} \;
[ -n "$JS_A" ] || { echo "找不到 libjs_static.a"; exit 1; }
PKG=/tmp/sm-pkg; rm -rf "$PKG"; mkdir -p "$PKG/include" "$PKG/lib"
cp -rL "$OBJ/dist/include/." "$PKG/include/"
cp "$JS_A" "$PKG/lib/libjs_static.a"
if [ -n "$RS_A" ]; then
  cp "$RS_A" "$PKG/lib/libjsrust.a"
else
  echo "找不到 libjsrust.a"; exit 1
fi
llvm-strip --strip-debug "$PKG/lib/libjs_static.a" "$PKG/lib/libjsrust.a" || true
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$PKG" include lib
ls -l "$PKG/lib" "$OUT"
