---
name: firmware-analysis
description: 固件逆向：镜像识别与解包（binwalk/unblob）、文件系统提取、敏感配置与密钥审计、指定模块的二进制分析
whenToUse: 目标是路由器/IoT/嵌入式设备固件镜像（.bin/.img/.trx 等），要提取文件系统、找默认凭据/硬编码密钥、或分析其中某个程序时
enabled: true
---

# 固件逆向

## 工作流

### 1. 镜像分诊

```
inspect_artifact(镜像) / inspect_binary_layout(镜像)
```

看魔数、头结构（TRX/U-Boot/OpenWrt squashfs 等）、有无加密/签名。
**加密固件先判断能否拿到解密途径**（配套工具/云端下发逻辑），拿不到就止步并明说。

### 2. 解包

- binwalk 签名扫描 + 提取（Bash：`binwalk -e`，或 REA firmware 域检索工具）；
- 复杂/嵌套镜像用 unblob；
- 解包产物固定放 `extracted/`，保留镜像原件不动。

### 3. 文件系统审计（价值密度最高的一步）

按优先级过：
- **配置与凭据**：`etc/passwd`、`etc/shadow`、默认账号、硬编码密码；
- **密钥材料**：SSH/API/证书私钥、对称密钥常量；
- **服务面**：init 脚本起的网络服务（telnet/ssh/web/udp 监听）→ 后续攻击面的底图；
- **调试接口**：串口 shell、隐藏 web 路由、厂商后门账号特征。

### 4. 指定模块二进制分析

文件系统里的目标程序（httpd、升级守护、协议处理）→ `open_binary`
（架构多为 MIPS/ARM，注意端序）→ 切 **native-binary-analysis** 技能啃。

### 5. 版本对比（两个固件版本）

切 **version-diff** 技能：compare_artifacts → 解包两侧 → 文件级 diff →
变更程序函数级对比。

## 证据要求

- 解包结论：镜像头证据 + 提取出的文件系统结构摘要；
- 凭据/密钥发现：文件路径 + 内容（密钥类给指纹/前几位，不整段复述）；
- 二进制结论：按 native 技能标准（函数地址 + 片段 + 偏移）。

## 边界

只分析用户有权持有的固件；提取出的凭据用于用户自己的设备安全评估，
不用于接入他人设备。
