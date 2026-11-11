---
name: android-app
description: Android 逆向：APK 分诊、类/方法检索、引用追踪、 Frida 动态 hook，还原安卓应用的功能与协议实现
whenToUse: 目标是 APK/AAB/DEX，要回答"功能怎么实现/协议怎么加密/校验在哪"时
enabled: true
---

# Android 应用逆向

## 工作流

### 1. APK 分诊（必做第一步）

```
inspect_android_package(APK 路径)   # 包名/组件/权限/签名/DEX 结构/是否加固
```

加固特征（DEX 头异常、壳 loader 类如 com.stub.*、classes.dex 极小）→
先走动态 dump（frida 脱壳）恢复原始 DEX，再回静态。

### 2. 类检索（代替全局翻代码）

```
search_android_classes(关键词)   # 按类名/字符串定位目标类
```

定位锚点优先级：**功能关键词字符串 → 网络库域名/URL → 加密库导入 →
JNI native 库名**。

### 3. 方法级精读

```
inspect_android_class(类)      # 字段/方法清单
inspect_android_method(方法)   # smali/反编译级细节；重载多时先 overload_index
```

### 4. 引用追踪

```
trace_android_references(方法/字段)   # 谁调用它、它引用谁
```

回答"这个值从哪来"的标准路径：UI/接口入口 → 参数组装 → 加密方法 → 输出。

### 5. 动态确认（静态拿不准时）

- Frida hook：`mcp__rea__` 检索 android/frida 域工具（trace/hook 系列）；
  常用于：确认加密方法的真实入参出参、绕过证书锁定、dump 加固 DEX。
- 原则：**静态定位到函数，动态只验证参数和时序**——不要一上来就盲 hook。

### 6. Native 层（JNI）

Java 层 `native` 方法 → `open_binary`(lib/*.so) → 按函数名（JNI 导出）或
RegisterNatives 注册表定位 → 切 native-binary-analysis 技能啃。

## 常见任务模板

- **协议加密逆向**：OkHttp/Retrofit 拦截器（search_android_classes: Interceptor）→
  加密方法 inspect → trace 组装链 → Frida hook 验证入参 → 复现算法。
- **签名校验**：signature / PackageManager 引用追踪 → 校验方法 → 定位比较点。
- **小程序/混合应用**：assets 里的 JS 包 → 切 javascript-electron 技能。

## 证据要求

- 结论带：类名#方法名 + smali/反编译关键行 + 调用链；
- 动态结论带：hook 点 + 真实入参出参样本；
- 涉及 native 的给 so 文件名 + 导出函数地址。
