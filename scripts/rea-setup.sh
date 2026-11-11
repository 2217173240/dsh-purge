#!/usr/bin/env bash
# rea-setup.sh —— 逆向台（REA）环境预检与指引
#
# 原则（与 REA 官方一致）：本脚本以「只读检查 + 打印指引」为主，不擅自安装
# 任何分析引擎（Ghidra/IDA/JADX/Frida/binwalk 等由用户自行决定装不装）；
# 唯一例外是可选的 --fetch：预拉 rea-agents npm 包到本地缓存（离线环境备用）。
#
# 用法：bash setup.sh [--fetch]
set -u

REA_VERSION="6.8.0"
GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; DIM='\033[2m'; OFF='\033[0m'

ok()   { printf "  ${GREEN}✓${OFF} %s\n" "$1"; }
miss() { printf "  ${YELLOW}✗${OFF} %s\n" "$1"; }
info() { printf "  ${DIM}%s${OFF}\n" "$1"; }

echo "════════════════════════════════════════════"
echo " 逆向台（REA）环境预检  rea-agents@${REA_VERSION}"
echo "════════════════════════════════════════════"

# ── 1. Node / npx ────────────────────────────────────────────────────────────
echo "【1/4】运行时"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null; then
    ok "node $(node -v)"
  else
    miss "node $(node -v)（< 18，REA 需要 ≥ 18）"
  fi
else
  miss "node 不在 PATH"
fi
if command -v npx >/dev/null 2>&1; then ok "npx 可用（MCP server 由 npx 拉起）"; else miss "npx 不在 PATH（MCP server 起不来）"; fi

# npm registry 连通性（只探测，不改配置）
if command -v npm >/dev/null 2>&1; then
  REG="$(npm config get registry 2>/dev/null || echo 'https://registry.npmjs.org')"
  if curl -s -m 6 -o /dev/null "${REG}rea-agents" 2>/dev/null; then
    ok "registry 可达：${REG}"
  else
    miss "registry 不可达：${REG}（大陆网络可配镜像：npm config set registry https://registry.npmmirror.com）"
  fi
fi

# ── 2. 分析引擎（provider，全部可选；缺了对应能力报 provider_unavailable）────
echo "【2/4】分析引擎（全部可选，缺哪个就少哪类深分析）"
check_bin() {
  # $1=命令 $2=用途 $3=安装提示
  if command -v "$1" >/dev/null 2>&1; then ok "$1（$2）"; else
    miss "$1 未安装（$2）"; info "  → $3"
  fi
}
check_bin java      "Ghidra 前置"          "Ghidra 需要 JDK 17+：brew install --cask temurin@17"
if command -v ghidraRun >/dev/null 2>&1 || [ -d "${GHIDRA_INSTALL_DIR:-/nonexistent}" ] || ls /Applications/ghidra* >/dev/null 2>&1 || ls ~/ghidra* >/dev/null 2>&1; then
  ok "Ghidra（原生反编译引擎）"
else
  miss "Ghidra 未检出（原生反编译深分析）"
  info "  → https://ghidra-sre.org 下载解压，export GHIDRA_INSTALL_DIR=<目录>"
fi
check_bin jadx      "Android 反编译"       "brew install jadx 或 https://github.com/skylot/jadx/releases"
check_bin frida     "动态 hook / 加固脱壳"  "pip3 install frida-tools（目标设备另装 frida-server）"
check_bin binwalk   "固件解包"             "brew install binwalk（或 pip3 install unblob）"
check_bin r2        "rizin/radare2 快速分析" "brew install radare2"
check_bin python3   "脚本复现"             "brew install python"

# ── 3. MCP server 自检 ───────────────────────────────────────────────────────
echo "【3/4】MCP server 拉起自检（10s 超时，只验能否启动）"
if command -v npx >/dev/null 2>&1; then
  if timeout 10 npx -y "rea-agents@${REA_VERSION}" --version >/dev/null 2>&1; then
    ok "rea-agents@${REA_VERSION} 可拉起（$(timeout 10 npx -y rea-agents@${REA_VERSION} --version 2>/dev/null | head -1)）"
  else
    miss "npx 拉起失败/超时（首次需联网下载；确认 registry 可达后重试）"
  fi
else
  info "跳过（无 npx）"
fi

# ── 4. 安装位置（插件自举写入的东西）────────────────────────────────────────
echo "【4/4】落盘位置"
DSH_HOME_RESOLVED="${DSH_HOME:-$HOME/.dsh}"
for p in \
  "${DSH_HOME_RESOLVED}/.agent-presets/rea/agent.cordis.yml" \
  "${DSH_HOME_RESOLVED}/rea/skills" \
  "${DSH_HOME_RESOLVED}/rea/setup.sh"; do
  if [ -e "$p" ]; then ok "$p"; else info "$p（宿主启动 dsh-purge ≥ 1.2.0 后自动生成）"; fi
done

# ── 可选：预拉包（离线备用）─────────────────────────────────────────────────
if [ "${1:-}" = "--fetch" ]; then
  echo ""
  echo "预拉 rea-agents@${REA_VERSION} 到 npm 缓存…"
  npm cache add "rea-agents@${REA_VERSION}" 2>/dev/null && ok "已入缓存（离线时 npx 仍可从缓存解析）" || miss "缓存失败（检查网络/registry）"
fi

echo ""
echo "完成。引擎全缺也不影响：布局/字符串/字节级/JS 域分析不依赖它们。"
echo "装好引擎后无需重做任何分析——从 provider 报错的那一步继续即可。"
