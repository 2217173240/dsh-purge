---
name: rea-environment
description: REA 环境预检与故障排查：provider 状态检查、MCP 连不上/npx 拉不起/工具缺席时的诊断路径，setup 脚本用法
whenToUse: mcp__rea__ 工具全部不可用、调用报 provider_unavailable、npx 超时/离线、或开工前想确认本机分析引擎配置时
enabled: true
---

# REA 环境预检与故障排查

## 快速自检

```bash
bash $DSH_HOME/rea/setup.sh          # provider 状态 + 安装指引（只读检查为主）
```

## 症状 → 诊断路径

### 1. `mcp__rea__*` 工具一个都不出现

- MCP server 没起来。检查宿主是否装了 dsh-purge ≥ 1.2.0（bundle patch 里有
  `dsh-purge-rea-mcp` 行）并已重启宿主；
- 手动验证 server 能否拉起：`npx -y rea-agents@6.8.0 mcp`（应阻塞等待 stdio，
  不报错即为正常）；首次运行需要网络拉包，离线环境先在有网机器
  `npm pack rea-agents` 传过来装；
- 中国大陆网络下 npx 直连 registry 可能超时：给 npm 配镜像
  (`npm config set registry https://registry.npmmirror.com`) 后重试。

### 2. 工具在，但调用报 `provider_unavailable`

该能力依赖本机分析引擎（Ghidra/IDA/Hopper/JADX/Cutter 等）：
- 照常做不依赖该引擎的部分（布局/字符串/字节级/compare 的结构层）；
- 一次性告诉用户缺哪个引擎、怎么装（setup.sh 有指引）；
- 引擎装好后从 provider 检查重新开始，不要重做已完成的分析。

### 3. Ghidra 类引擎首次调用很慢

首次要建索引/载入 headless，属正常；REA 对 Ghidra 有 first-query deadline
与恢复机制——超时后按工具返回的恢复提示重试即可，不要并发轰炸。

### 4. 工具目录里找不到要的工具

170+ 工具是热/冷分页的：用目录检索工具按关键词搜（名字与描述模糊匹配），
一页最多 20 个 schema。检索词用领域词（`android`、`decompile`、`capture`、
`firmware`），不要整句查询。

## 升级与版本

- 查当前版本：`npx rea-agents@6.8.0 --version`；
- 版本钉住原则：MCP 行、技能手册、setup 检查三者同版本（当前 **6.8.0**）；
  升级 REA 时三者一起动，避免"工具在但 schema 变了"的错位。
