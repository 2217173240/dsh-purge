# 版本更新手册（升级前后各三步）

> 目标：DSH 每次升级都变成一次"体检 + 自动重锚"的机会，而不是一次静默失效。

## 升级前（已完成，rc3 之前）

```bash
cd ~/.dsh/plugins/dsh-purge
node scripts/snapshot-host.mjs "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai"
```

产物在 `~/.dsh/dsh-purge/snapshots/<版本>__<时间戳>/`：

| 文件 | 内容 |
|---|---|
| `meta.json` | 版本、aiBase、时间、每条补丁的状态 |
| `manifest.tsv` | 每个目标文件的大小 + sha256 + 真实路径 |
| `files/...` | 目标文件逐字节副本（可回滚） |

## 升级后（rc3 装完、重启 dsh 之后）

```bash
cd ~/.dsh/plugins/dsh-purge
node scripts/drift-report.mjs "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai"
```

输出分三段：

1. **版本与文件对比** —— 宿主版本 vs 快照版本、改动/丢失/未变的文件数；
   例：`改动 12 · 丢失 3 · 未变 49`。
2. **非 applied 的补丁** —— 逐条给 `状态 / 原因 / 建议`，原因分类：
   | 原因 | 含义 | 建议 |
   |---|---|---|
   | 正则/结构锚点仍可命中 | 分层锚点已覆盖，只是没跑 apply | 重跑 apply |
   | 分层锚点可命中 tier=… | normalized/relaxed/window 能接住 | 重跑 apply |
   | 部分记号消失 (k/n) | 上游改了实现细节 | 按消失记号补 rescue |
   | 整段被改名/搬走 (0/n) | 代码换了文件或整体重写 | 新增目标键或结构级 rescue |
   | 目标文件不存在 | 该 surface 没这个组件 | 不用管 |
3. **结论行** —— `需补 rescue N 条 · 需补目标键 M 条 · 其余可直接重跑 apply`。

## 然后点「应用」

- 成功 → 重启生效，回 1 再跑一次 drift-report，期望 `非 applied` 只剩 missing/skipped。
- 报 `清洗没有完成` / `没有写进全部宿主` → 把 drift-report 的整段输出贴出来，
  里面有具体 patch id 与原因，直接对着补 rescue / 目标键。

## 回滚

1. 插件自带：`purge_revert`（回滚到备份原件，保留 `prompt-inject.md`）。
2. 快照兜底：`~/.dsh/dsh-purge/snapshots/<版本>__<时间戳>/files/` 是逐字节副本，
   拷回对应路径即可还原。

## 判定"这次升级是好事"的标准

| 指标 | 期望 |
|---|---|
| drift-report 结论行 | `需补 rescue 0 条 · 需补目标键 0 条` |
| 非 applied | 只剩 missing（surface 无该组件）与 skipped |
| 应用后 | 一次成功，无需补丁 |
