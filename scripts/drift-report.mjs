#!/usr/bin/env node
/**
 * drift-report.mjs —— 升级后体检：哪些补丁掉了、为什么掉、该怎么救。
 *
 * 用法：
 *   node scripts/drift-report.mjs [aiBase] [--snapshot <dir>]
 *
 * 输出：
 *   1. 宿主版本与文件变化（对比升级前快照：新增/改动/丢失）
 *   2. 每条非 applied 补丁：状态、命中层级、失败原因分类、修复建议
 *   3. 末尾一条 "本次升级需要做什么" 的结论
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { ALL_PATCHES, targetFiles, filePatchOutcome, findAiBase } from "../lib/core.js";
import { findWithTiers, tokenize } from "../lib/anchor-match.js";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const args = process.argv.slice(2);
const snapFlag = args.indexOf("--snapshot");
let snapshotDir = snapFlag >= 0 ? args[snapFlag + 1] : null;
const aiBase = args[0] && !args[0].startsWith("--") ? args[0] : findAiBase();
if (!aiBase) { console.error("找不到宿主 aiBase"); process.exit(1); }

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const snapRoot = path.join(dshHome, "dsh-purge", "snapshots");
if (!snapshotDir) {
  // 优先选"同一个 aiBase"的最新快照：机器上常同时存在开发树与应用两份宿主，
  // 拿错快照会把整棵树都算成"改动"，报告就没有意义了。
  try {
    const dirs = fs.readdirSync(snapRoot).map((d) => path.join(snapRoot, d));
    const withMeta = dirs.map((d) => {
      try { return { dir: d, meta: JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8")), mtime: fs.statSync(d).mtimeMs }; }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const sameBase = withMeta.find((x) => String(x.meta.aiBase || "").toLowerCase() === String(aiBase).toLowerCase());
    snapshotDir = (sameBase || withMeta[0] || {}).dir || null;
  } catch { /* 没有快照也能跑 */ }
}

const currentVersion = (() => {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try { const p = JSON.parse(fs.readFileSync(path.join(aiBase, rel), "utf8")); if (p.version) return p.version; } catch { /* next */ }
  }
  return "unknown";
})();

let snapshotVersion = "none";
const fileDelta = { changed: [], missing: [], unchanged: 0 };
if (snapshotDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(snapshotDir, "meta.json"), "utf8"));
    snapshotVersion = meta.version || "unknown";
    const rows = fs.readFileSync(path.join(snapshotDir, "manifest.tsv"), "utf8").split("\n").slice(1).filter(Boolean);
    for (const row of rows) {
      const [key, rel, , hash, orig] = row.split("\t");
      // 外部目标（profile/preset/main.js）在快照里是哈希命名的副本，用 orig 还原真实路径。
      const fp = orig && orig !== "-" ? orig : path.join(aiBase, rel);
      let buf = null;
      try { buf = fs.readFileSync(fp); } catch { fileDelta.missing.push(key + ":" + rel); continue; }
      if (sha256(buf) === hash) fileDelta.unchanged += 1;
      else fileDelta.changed.push(key + ":" + rel);
    }
  } catch (error) {
    console.error("[warn] 快照读取失败: " + error.message);
  }
}

const files = targetFiles(aiBase, dshHome);
const rows = [];
const causeOf = (text, patch) => {
  const reps = (patch.replacements || []).filter((r) => r && r.pattern);
  if (!reps.length) return { cause: "无锚点（撤销型）", action: "无需处理" };
  // 1) 先看正则锚点（含结构级 rescue）：能命中就说明只是还没 apply。
  for (const rep of reps) {
    if (!(rep.pattern instanceof RegExp)) continue;
    if (new RegExp(rep.pattern.source, "m").test(text)) return { cause: "正则/结构锚点仍可命中", action: "重跑 apply 即可落地" };
  }
  // 2) 再看字符串锚点（含分层降级匹配）。
  for (const rep of reps) {
    if (rep.pattern instanceof RegExp) continue;
    const needle = String(rep.pattern);
    const hit = findWithTiers(text, needle, { minRatio: 0.95 });
    if (hit) return { cause: "分层锚点可命中：tier=" + hit.tier + " ratio=" + hit.ratio.toFixed(3), action: "重跑 apply（分层锚点会接住）" };
    const toks = [...new Set(tokenize(needle).filter((t) => t.length > 4))];
    const present = toks.filter((t) => text.includes(t));
    if (present.length === 0) return { cause: "整段被改名/搬走（0/" + toks.length + " 记号）", action: "新增目标键或结构级 rescue" };
    if (present.length < toks.length) return { cause: "部分记号消失（" + present.length + "/" + toks.length + "）", action: "按消失记号定位新实现，补 rescue" };
  }
  return { cause: "记号齐全但结构变了", action: "补结构级 rescue（锚签名/单行）" };
};

for (const patch of ALL_PATCHES) {
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  const targets = [];
  for (const key of keys) {
    const value = files[key];
    for (const fp of (Array.isArray(value) ? value : value ? [value] : [])) targets.push(fp);
  }
  const uniq = [...new Set(targets)].filter((fp) => { try { return fs.statSync(fp).isFile(); } catch { return false; } });
  if (!uniq.length) { rows.push({ id: patch.id, name: patch.name, state: "missing", cause: "目标文件不存在", action: "该 surface 无此组件" }); continue; }
  const states = [];
  let text = "", fp = "";
  for (const f of uniq) {
    let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (!t) continue;
    if (!text) { text = t; fp = f; }
    states.push({ f, s: filePatchOutcome(t, patch, f) });
  }
  if (states.some((x) => x.s === "applied")) continue;
  const first = states[0] || { f: uniq[0], s: "missing" };
  const t = (() => { try { return fs.readFileSync(first.f, "utf8"); } catch { return ""; } })();
  const { cause, action } = causeOf(t, patch);
  rows.push({ id: patch.id, name: patch.name, state: first.s, cause, action, file: path.relative(aiBase, first.f) });
}

console.log("宿主版本: " + currentVersion + "   快照版本: " + snapshotVersion);
if (snapshotDir) {
  console.log("文件对比: 改动 " + fileDelta.changed.length + " · 丢失 " + fileDelta.missing.length + " · 未变 " + fileDelta.unchanged);
  if (fileDelta.changed.length) console.log("  改动: " + fileDelta.changed.slice(0, 12).join(", "));
  if (fileDelta.missing.length) console.log("  丢失: " + fileDelta.missing.slice(0, 12).join(", "));
}
console.log("");
console.log("非 applied 的补丁（" + rows.length + " 条）:");
for (const r of rows) {
  console.log("  #" + r.id + " " + r.name + "  [" + r.state + "]");
  console.log("      原因: " + r.cause);
  console.log("      建议: " + r.action + (r.file ? "   (" + r.file + ")" : ""));
}
const needRescue = rows.filter((r) => /rescue|收编|结构/.test(r.action)).length;
const needKey = rows.filter((r) => /目标键|搬家/.test(r.action)).length;
console.log("");
console.log("结论: 需补 rescue " + needRescue + " 条 · 需补目标键 " + needKey + " 条 · 其余可直接重跑 apply");
