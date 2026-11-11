---
name: unpacking-recovery
description: 脱壳与格式恢复：识别加壳/加固/打包（UPX/VMProtect/.NET/PyInstaller/electron asar 等），选对恢复路径，拿到可静态分析的原始层
whenToUse: inspect_binary_layout 显示高熵/异常节区/壳特征，或样本是自解压/打包格式，静态分析啃不动时
enabled: true
---

# 脱壳与格式恢复

## 原则：先识别，后动手

**不要见壳就跑通用脱壳机。** 先用 `inspect_binary_layout` + `inspect_artifact`
确认壳/打包器类型，按下表选路径；识别不清时优先动态观测（入口断在 OEP 附近）
而不是盲目 dump。

## 按类型选路径

| 特征 | 类型 | 路径 |
|---|---|---|
| 节区 UPX0/UPX1，低复杂度 | UPX | 直接 `upx -d`（Bash）；失败再手动 |
| 高熵 + 反调试 + 虚拟化 | VMP/Themida 级 | 静态放弃，转 dynamic-observation：observe_native_calls 观测原始层行为，记录 OEP 附近调用 |
| .NET 元数据 | managed | `inspect_managed_artifact`（managed 域工具），反编译走 managed 引擎 |
| PyInstaller 归档 | 打包脚本 | artifact 域提取归档 → recover 源（JS/Python 域工具） |
| Electron app.asar | JS 应用 | 切 javascript-electron 技能（asar 提取 + recover_javascript_sources） |
| Android 加固（DEX 头异常/壳 dex） | APK 加固 | 切 android-app 技能；脱壳优先动态（frida dump dex） |
| 固件 squashfs/cramfs | 打包镜像 | 切 firmware-analysis 技能（binwalk/unblob 解包） |

## 通用脱壳纪律

1. **脱壳前后都留哈希**（sha256），报告里对照——证明"脱出来的就是样本里的原始层"。
2. dump 出的原始层**重新 open_binary 走一遍 binary_overview**，确认符号/节区恢复正常，
   再继续静态分析。
3. 脱壳产物放工作区独立目录（`unpacked/`），与原样本分开，不要覆盖原件。
4. 加壳样本常带反调试/反虚拟机：静态看到 `IsDebuggerPresent`、`rdtsc`、
   时间差校验等特征要记录——它们既是要绕的点，也是"作者有对抗意识"的证据。

## 证据要求

- 壳类型判定：布局证据（节区名/熵值/特征字符串）；
- 脱壳结果：前后 sha256 + 脱出层 binary_overview 关键差异；
- 走动态路径时：观测到的 OEP 区域调用序列（evidence 引用）。
