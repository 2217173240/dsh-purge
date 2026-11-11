---
name: javascript-electron
description: JavaScript/Electron/打包前端逆向：恢复源码、语义级模块分析、功能级追踪、版本对比，看懂 webpack/混淆代码里的功能实现
whenToUse: 目标是 Electron 应用、打包的 Web 前端、浏览器扩展、或任何 minified/bundled JS，要回答"这个功能/接口怎么实现"时
enabled: true
---

# JavaScript / Electron 逆向

## 工作流

### 1. 建分析

```
analyze_javascript_application(入口/资源目录)   # 建 JS 分析视图
```

Electron 应用先解 `app.asar`（Bash: `npx asar extract` 或 artifact 域工具），
主入口通常在 `package.json → main` 字段。

### 2. 恢复可读源码

```
recover_javascript_sources(打包文件)   # sourcemap/结构恢复；webpack 分包也走这里
```

恢复输出到独立目录；混淆没 sourcemap 时恢复的是"结构化但变量名不可读"的版本
——继续靠语义分析而不是硬读。

### 3. 语义级模块分析

```
inspect_analysis_view(视图, node_id)   # 语义模块级结构：imports、依赖、导出
```

回答"功能在哪"：从入口/路由/IPC handler 按模块图走，不要在 minified 文本里 grep 硬找。

### 4. 功能级追踪（核心利器）

```
trace_application_feature(功能描述/入口)   # 从 UI/接口入口追到实现
```

这是 JS 域最省力的路径：直接给"支付按钮怎么算签名"这类问题，
让追踪工具给出经过的模块和函数链。

### 5. 动态补充

```
list_electron_targets()      # 本机运行中的 Electron 目标
list_browser_targets()       # 浏览器目标
capture_web_screenshot()     # 配合观测
reconcile_javascript_runtime()  # 静态视图 ↔ 运行时对照
```

### 6. 版本对比（升级改了什么）

```
compare_application_versions(旧版, 新版)
```

## 常见任务模板

- **接口签名逆向**：trace_application_feature(签名发生的请求) → 定位拼接函数 →
  翻出哈希/编码次序 → 用 Node 复现 → 用抓包样本验证。
- **Electron 主进程逻辑**：asar 解包 → main 入口 → inspect_analysis_view 走
  IPC channel → renderer 侧 handler 对照。
- **前端加密参数**：recover_javascript_sources → 语义分析定位 crypto 模块 →
  trace_application_feature 串参数流 → 复现。

## 证据要求

- 结论带：模块路径 + 关键函数名/位置 + 依赖链；涉及协议/签名的，
  给"输入 → 变换序列 → 输出"的完整描述。
- 汇出用 `export_evidence_bundle`（JS 域专用导出）。
