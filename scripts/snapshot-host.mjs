#!/usr/bin/env node
/**
 * snapshot-host.mjs —— 更新前给宿主拍快照。
 *
 * 目的：DSH 升级后要能回答三个问题
 *   1. 哪些补丁文件变了（内容 / 哈希 / 是否被搬走）；
 *   2. 哪些补丁从 applied 掉回 pending/degraded（= 上游漂移）；
 *   3. 出问题时能逐字节还原到升级前。
 *
 * 产物：$DSH_HOME/dsh-purge/snapshots/<version>__<ts>/
 *   meta.json      版本、aiBase、时间、patchStatus
 *   manifest.tsv   每个目标文件的 sha256 与大小
 *   files/...      目标文件副本（保持相对路径）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { ALL_PATCHES, targetFiles, patchStatus, findAiBase, findDshHome } from "../lib/core.js";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const aiBase = process.argv[2] || findAiBase();
if (!aiBase) {
  console.error("找不到宿主 aiBase");
  process.exit(1);
}
// 沙箱里 process.env 可能是空的，findDshHome() 会拼出 /Users/.dsh 这种坏路径；
// 这里优先 DSH_HOME，其次 os.homedir()，最后才回落到插件自己的推导。
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
let version = "unknown";
for (const rel of ["../../package.json", "../../../package.json", "../../../../package.json"]) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(aiBase, rel), "utf8"));
    if (p.version) { version = p.version; break; }
  } catch { /* 继续尝试下一个位置 */ }
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(dshHome, "dsh-purge", "snapshots", version + "__" + ts);
fs.mkdirSync(path.join(outDir, "files"), { recursive: true });

const files = targetFiles(aiBase, dshHome);
const rows = [];
const copied = [];
for (const [key, value] of Object.entries(files)) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const fp of list) {
    let buf;
    try { buf = fs.readFileSync(fp); } catch { continue; }
    let rel = path.relative(aiBase, fp);
    // 目标可能落在 aiBase 之外（profile / 用户 preset），不能让 ../ 把副本写到别处。
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      rel = path.join("_external", sha256(fp).slice(0, 8) + "_" + path.basename(fp));
    }
    const dst = path.join(outDir, "files", rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
    } catch (error) {
      console.error("[skip] " + fp + " -> " + error.message);
      continue;
    }
    rows.push([key, rel, buf.length, sha256(buf), fp].join("\t"));
    copied.push(rel);
  }
}
fs.writeFileSync(path.join(outDir, "manifest.tsv"), "key\trel\tsize\tsha256\torig\n" + rows.join("\n") + "\n");

const status = await patchStatus(aiBase);
const counts = {};
for (const v of Object.values(status)) counts[v] = (counts[v] || 0) + 1;
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ version, aiBase, createdAt: new Date().toISOString(), counts, status }, null, 1));

console.log("快照: " + outDir);
console.log("版本: " + version + "  文件: " + copied.length + "  补丁状态: " + JSON.stringify(counts));
