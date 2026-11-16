#!/bin/sh
# sync-installed.sh —— 把仓库里的插件同步到「实际被加载」的那份副本
#
# 背景：桌面端加载的是 $DSH_HOME/profiles/<profile>/node_modules/dsh-purge，
# 而不是开发仓库 .dsh/plugins/dsh-purge。两边不同步时，改了半天代码也不会生效。
# 用法: scripts/sync-installed.sh [profile]
set -eu
PROFILE="${1:-desktop}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/node_modules/dsh-purge"
if [ ! -d "$DST" ]; then
  echo "找不到目标副本: $DST" >&2
  exit 1
fi
rsync -a --delete "$SRC/lib/" "$DST/lib/"
[ -d "$SRC/scripts" ] && rsync -a "$SRC/scripts/" "$DST/scripts/"
[ -d "$SRC/docs" ] && rsync -a "$SRC/docs/" "$DST/docs/"
cp "$SRC/package.json" "$DST/package.json"
echo "已同步: $SRC -> $DST"
node -e "console.log('installed version=' + require('$DST/package.json').version)" 2>/dev/null || true
