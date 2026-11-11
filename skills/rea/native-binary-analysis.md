---
name: native-binary-analysis
description: 原生二进制静态分析（PE/ELF/Mach-O）：布局分诊 → 概览 → 逐函数反编译 → 调用链 → 字节级证据，还原算法与功能实现
whenToUse: 目标是原生可执行文件/动态库/驱动，要回答"这段功能怎么实现/算法是什么/校验在哪"时
enabled: true
---

# 原生二进制静态分析

## 工作流

### 1. 分诊（必做第一步）

```
inspect_binary_layout(样本)   # 格式、架构、节区、熵分布（识别加壳）、导入导出
```

高熵 + 节区名异常（UPX0/UPX1、.themida 等）→ 先走 `unpacking-recovery` 技能脱壳，
再回来做静态。正常布局 → 继续。

### 2. 开会话 + 概览

```
open_binary(样本)      # 后续所有分析基于同一 session
binary_overview()      # 入口、符号表有无、字符串、导入函数——先建立全局图景
```

概览阶段重点找**锚点**：
- 有符号：直接按函数名定位目标；
- 无符号：靠**字符串交叉引用**（错误提示、日志、URL、注册码格式）和
  **导入函数**（crypto/网络/注册表相关 API）圈出可疑函数。

### 3. 逐函数精读

```
analyze_function(目标函数)     # 反编译；长函数用 next_offset 翻页
```

啃函数的顺序：先入口 → 校验/授权类 → 数据处理类 → 网络协议类。
每个函数记录：地址、签名、关键分支条件、调用的外部 API。

### 4. 串调用链

```
build_call_path(起点)          # 谁调用它 / 它调用谁，双向
```

回答"这个功能怎么实现"时，把 **UI 触发点 → 中间层 → 核心算法** 的路径完整串出来。

### 5. 字节级证据（收尾必做）

```
read_bytes(地址)               # 关键判断的字节
address_to_file_offset(地址)   # 虚拟地址 → 文件偏移，写报告用
```

补丁/复现类结论必须给到 `文件偏移 + 原始字节`，这是可被第三方验证的最小证据。

## 常见任务模板

- **找注册校验**：字符串 "invalid license" 交叉引用 → 校验函数 → analyze_function →
  memcmp/异或/查表特征 → read_bytes 记录比较点 → 报告给到偏移。
- **还原算法**：入口 → 数据流入函数 → 逐层 analyze_function + build_call_path →
  用 Python 等实现等价逻辑 → 用样本内已知输入输出对验证。
- **定位网络协议**：导入表 send/recv/WSA → 交叉引用 → 加解密函数（导入 CryptXXX
  或自带轮函数特征）→ observe_native_calls 动态确认（切 dynamic-observation 技能）。

## 证据要求

- 每个结论：`函数地址 + 反编译片段（关键行）+ 调用路径`；
- 补丁类结论另加：`文件偏移 + 原始字节 + 修改后字节`；
- 最后 `get_evidence_bundle` 汇出，`close_binary` 收尾。
