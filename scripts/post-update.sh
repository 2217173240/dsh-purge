#!/bin/sh
# post-update.sh —— 升级后一条命令出体检报告
# 用法: scripts/post-update.sh [aiBase]
set -u
AI="${1:-/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai}"
cd "$(dirname "$0")/.." || exit 1
echo "== 更新后体检 =="
node scripts/drift-report.mjs "$AI"
echo
echo "== 补丁状态分布 =="
PURGE_AI="$AI" node -e '
import("./lib/core.js").then(async (m) => {
  const st = await m.patchStatus(process.env.PURGE_AI);
  const c = {}; for (const v of Object.values(st)) c[v] = (c[v] || 0) + 1;
  console.log(JSON.stringify(c));
});'
