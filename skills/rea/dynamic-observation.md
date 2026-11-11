---
name: dynamic-observation
description: 动态观测与运行时取证：原生调用观测、crash 分析、浏览器/Electron 目标接管、流量与抓包佐证——用运行时事实补静态盲区
whenToUse: 静态分析看不出行为、需要确认真实调用序列/参数、样本带 crash 转储、或目标是运行中的浏览器/Electron 应用时
enabled: true
---

# 动态观测与运行时取证

## 何时切动态

- 反编译看得出结构但**猜不到行为**（分支太多/数据驱动）；
- 需要**真实参数**（加密函数的入参出参、协议字段值）；
- 加壳/混淆到静态性价比极低；
- 有 crash 转储/ANR 日志要归因。

## 工具链

### 1. 原生调用观测

```
observe_native_calls(目标, duration_ms, max_events)   # 观测窗口内的调用序列
```

用法纪律：先静态圈定关心的函数/模块，把观测窗口对准它们——
无差别全量观测会被事件淹没。输出是 evidence 引用，直接引用进报告。

### 2. Crash 归因

```
inspect_recorded_crash(转储/日志, include_debugger_context=true)
```

崩溃样本分析的第一步永远是这个——它会给出崩溃点、寄存器/栈、
加载镜像（`inspect_native_load_image` 核对模块版本），再决定回静态看哪段。

### 3. 浏览器 / Electron 目标

```
list_browser_targets()       # 可接管的浏览器实例
list_electron_targets()      # 运行中的 Electron 应用
capture_web_screenshot()     # 状态快照
reconcile_javascript_runtime()   # 静态分析视图 ↔ 运行时对象对照
```

配合代理抓包（mitmproxy 桥在 REA bridge 目录）可拿"行为 ↔ 流量"双证据。

### 4. 流量佐证

pcap/captures 域（检索 `mcp__rea__` 的 pcap/capture 工具）解析已有抓包，
把协议结论和字节流对上；需要新抓包时让用户在授权范围内操作。

## 安全与授权边界（硬约束）

- 动态观测只针对**本机进程**或**用户书面授权的目标**；
- 不在观测窗口里执行样本的破坏性分支——先静态排除（文件写入/网络外传/自删除特征），
  或在一次性快照虚拟机里做；
- attach 生产环境进程前必须经用户确认。

## 证据要求

- 观测结论带：观测点 + 时间窗口 + 事件序列（evidence 引用）；
- crash 结论带：崩溃地址 + 栈 + 归因到的函数；
- 协议结论带：静态结构 + 动态真实报文样本各一份，两者对得上才算实锤。
