/**
 * anchor-match.js —— 补丁锚点的分层匹配（不依赖具体 DSH 版本）
 *
 * 背景：上游每次发版都可能改写构造（throw new Error → throw new SandboxEscalationError）、
 * 重排注释、压缩打包。整段精确字符串一旦对不上，补丁就永久失效，而状态页只会说 drifted。
 *
 * 这里提供从强到弱的四级锚点，任何一级命中都能落地：
 *   exact      原文逐字节包含            最安全
 *   normalized 忽略空白/换行差异           只改格式时立即命中
 *   relaxed    空白不敏感的"转义正则"      标识符不变、排版变了也能命中
 *   window     记号序列 + 非贪婪窗口        中间插了几行也能命中（严格阈值 + 唯一性要求）
 *
 * 安全性约定：window 级只在唯一命中且覆盖率 >= 0.95 时自动应用，否则交给上层报 degraded，
 * 因为真正的语义改动（构造被包装、函数被改名）不该被自动"猜"着改。
 */

const WS = /\s/;

/**
 * 取下标所在行、行首到第一个非空白字符的缩进量（空格/制表符都算 1）。
 *
 * 为什么需要它：normalized / relaxed / window 三层都忽略空白，于是「顶层 2 空格缩进」
 * 的锚点会命中 YAML 里 12 空格缩进的嵌套块；替换体按锚点自己的缩进写回去，就把
 * 嵌套结构压平 → 文件语法直接坏掉（0.2.2-rc.3 上 preset tool-web 的实战事故）。
 */
export function indentAt(text, index) {
  const src = String(text);
  const lineStart = src.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  let i = lineStart;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return i - lineStart;
}

/** 锚点首行的缩进量。锚点一般以非空白字符开头（返回 0）。 */
export function leadingIndentOf(needle) {
  const s = String(needle).replace(/^\n+/, "");
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

/** 归一化文本，并保留"归一化下标 -> 原文下标"的映射，用于把命中位置还原成原文区间。 */
export function normalizeWithMap(text) {
  const map = [];
  let out = "";
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (WS.test(ch)) {
      if (!inWs) { out += " "; map.push(i); inWs = true; }
      continue;
    }
    inWs = false;
    out += ch;
    map.push(i);
  }
  map.push(text.length);
  return { norm: out, map };
}

export function normalizeText(text) {
  return normalizeWithMap(String(text)).norm;
}

/** 空白归一化匹配：返回 { start, end }（原文区间，指向第一个非空白字符到最后一个之后）。 */
export function matchNormalized(hay, needle) {
  const a = normalizeWithMap(hay);
  const b = normalizeText(needle);
  if (!b) return null;
  const idx = a.norm.indexOf(b);
  if (idx < 0) return null;
  const start = a.map[idx];
  const end = a.map[idx + b.length];
  return { start, end: end === undefined ? hay.length : end };
}

/**
 * 把字面量锚点转成"空白不敏感"正则：
 *  - 每一段连续空白 → \s+
 *  - 其余字符逐个转义
 * 只放宽空白，不放宽标识符，避免误改到语义不同的位置。
 */
export function relaxedRegExp(needle) {
  const src = String(needle).trim();
  if (!src) return null;
  const parts = [];
  const chunks = src.split(/\s+/);
  for (let i = 0; i < chunks.length; i++) {
    if (i) parts.push("\\s+");
    parts.push(chunks[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return new RegExp(parts.join(""), "m");
}

/** 记号化：标识符 / 数字 / 单字符符号。用于窗口级匹配。 */
export function tokenize(text) {
  return String(text).match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g) || [];
}

function lcsRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const n = a.length, m = b.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[m] / Math.max(n, m);
}

/**
 * 记号窗口匹配：以锚点的首/尾记号定位候选窗口，再用 LCS 覆盖率确认。
 * 命中唯一且覆盖率达标才返回，否则 null（宁可不改，也不猜）。
 */
export function matchTokenWindow(hay, needle, options = {}) {
  const minRatio = options.minRatio ?? 0.95;
  const wantTokens = tokenize(needle);
  if (wantTokens.length < 6) return null;
  const hayTokens = tokenize(hay);
  const first = wantTokens[0];
  const last = wantTokens[wantTokens.length - 1];
  const wantIndent = options.wantIndent;
  const indentAware = options.indentAware !== false;
  /* 全大写标识符（常量名）必须原样出现：window 层的 LCS 会把「改名」当成 0.99 相似，
     实测事故 —— AGENT_INSTRUCTIONS_INTRO 的锚点把同名常量替换成了 WORKSPACE_CONTEXT_INTRO，
     声明被改名而引用处没改，模块加载即 ReferenceError，整条插件 never started。 */
  const distinctive = [...new Set(wantTokens.filter((t) => /^[A-Z][A-Z0-9_]{3,}$/.test(t)))];
  const starts = [];
  for (let i = 0; i < hayTokens.length; i++) if (hayTokens[i] === first) starts.push(i);
  if (!starts.length) return null;
  const span = Math.max(wantTokens.length * 3, wantTokens.length + 40);
  const hits = [];
  for (const s of starts) {
    for (let e = s + Math.floor(wantTokens.length / 2); e < Math.min(hayTokens.length, s + span); e++) {
      if (hayTokens[e] !== last) continue;
      const windowTokens = hayTokens.slice(s, e + 1);
      const ratio = lcsRatio(wantTokens, windowTokens);
      if (ratio >= minRatio) {
        if (distinctive.length > 0) {
          const present = new Set(windowTokens);
          if (!distinctive.every((t) => present.has(t))) continue;
        }
        // 缩进必须与锚点首行一致：嵌套块里的同形结构不算命中（宁可漏改，不能改坏）。
        const at = indexOfToken(hay, s);
        if (indentAware && wantIndent !== undefined && at >= 0 && indentAt(hay, at) !== wantIndent) continue;
        hits.push({ s, e, ratio });
      }
      if (hits.length > 3) return null; // 多处命中 -> 不敢自动改
    }
  }
  if (hits.length !== 1) return null;
  const { s, e, ratio } = hits[0];
  const start = indexOfToken(hay, s);
  const end = endOfToken(hay, e);
  if (start < 0 || end < 0) return null;
  return { start, end, ratio };
}

/** 第 n 个记号在原文里的起始下标。 */
export function indexOfToken(text, n) {
  const re = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (i === n) return m.index;
    i++;
  }
  return -1;
}

/** 第 n 个记号在原文里的结束下标（含）。 */
export function endOfToken(text, n) {
  const re = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (i === n) return m.index + m[0].length;
    i++;
  }
  return -1;
}

/**
 * 分层查找。返回 { tier, start, end, ratio } 或 null。
 * tier: "exact" | "normalized" | "relaxed" | "window"
 */
export function findWithTiers(hay, needle, options = {}) {
  const text = String(hay);
  const pat = String(needle);
  if (!pat) return null;
  const i = text.indexOf(pat);
  if (i >= 0) return { tier: "exact", start: i, end: i + pat.length, ratio: 1 };
  /* 模糊层一律要求行首缩进与锚点首行一致，否则嵌套块会被按外层缩进重写。 */
  const indentAware = options.indentAware !== false;
  const wantIndent = leadingIndentOf(pat);
  const indentOk = (idx) => !indentAware || idx < 0 || indentAt(text, idx) === wantIndent;
  const n = matchNormalized(text, pat);
  if (n && indentOk(n.start)) return { tier: "normalized", start: n.start, end: n.end, ratio: 1 };
  const re = relaxedRegExp(pat);
  if (re) {
    const all = [...text.matchAll(new RegExp(re.source, "gm"))].filter((m) => indentOk(m.index));
    if (all.length === 1) {
      const m = all[0];
      return { tier: "relaxed", start: m.index, end: m.index + m[0].length, ratio: 1 };
    }
  }
  if (options.allowWindow !== false) {
    const w = matchTokenWindow(text, pat, { ...options, indentAware, wantIndent });
    if (w) return { tier: "window", start: w.start, end: w.end, ratio: w.ratio };
  }
  return null;
}
