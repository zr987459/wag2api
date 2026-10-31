#!/usr/bin/env bash
# 让 Firefox 构建系统把 zig 当作 clang 用（与上游一样是 clang 21 + libc++ + musl）。
# 用法：把本脚本软链为 cc / c++，并设置 ZIG（zig 可执行文件）与 ZIG_TARGET（默认 aarch64-linux-musl）。
# - 去掉 Firefox 自动加的 --target=aarch64-unknown-linux-musl / -fuse-ld=*，改用 zig 的 -target
# - configure 用 "-Wl,--version" 探测链接器种类，zig 不直接回显，这里按 lld 回答
mode=cc
case "$(basename "$0")" in *++*) mode=c++ ;; esac
args=()
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    --target=*|-fuse-ld=*) continue ;;
    -target|--target) skip=1; continue ;;
    -Wl,--version) echo "LLD 21.1.0 (compatible with GNU linkers)"; exit 0 ;;
  esac
  args+=("$a")
done
exec "${ZIG:?ZIG not set}" "$mode" -target "${ZIG_TARGET:-aarch64-linux-musl}" "${args[@]}"
