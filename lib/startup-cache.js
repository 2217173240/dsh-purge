/**
 * 启动期缓存：只缓存「重复的包解析结果」，不缓存任何补丁/宿主状态。
 *
 * 背景（实测）：bundle patch 里的 `dsh-purge-rea-mcp` 用
 * `npx -y rea-agents@6.8.0 mcp` 启动 REA MCP。npm exec 每次启动都要去
 * registry 解析 packument；本机网络一次 ECONNRESET 重试 3 次 + 最后
 * 200 缓存响应共 82.9s，直接把宿主启动拖到 2 分钟。
 *
 * 应对：只在「本机已有可用的 npx 缓存，且配置里确实是这个精确版本」时，
 * 给当前宿主进程设置 `npm_config_prefer_offline=true`。npm 会优先用
 * 本地缓存，缓存缺失时仍会走网络（prefer-offline，不是 offline），
 * 所以不会让首次安装/缓存被清掉时失去能力。
 *
 * 缓存文件：$DSH_HOME/dsh-purge/startup-cache.json
 * 失效条件（任一不符就重新扫描，不信任旧记录）：
 *   · schema（本模块缓存逻辑版本）
 *   · 插件版本（package.json version）
 *   · 宿主根路径（resources/app/dsh/node_modules/@deepseek-ai 或 DSH_HOME）
 *   · 配置来源文件路径 + mtime + size（profile / bundle 的 cordis.patch.yml）
 *   · npx 缓存目录、rea-agents/package.json 的版本 + mtime + size
 *   · node_modules/.bin/rea 的路径 + mtime + size
 *   · 记录超过 30 天（强制重扫一次；重扫仍可用则继续走缓存）
 *
 * 这个缓存不会跳过 apply、写出后校验、patchStatus 或任何漂移检查；
 * 命中时省掉的只是 npm 对 registry 的重复解析。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STARTUP_CACHE_SCHEMA = 1;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REA_SPEC_RE = /rea-agents@(\d[0-9A-Za-z.+-]*)/;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pluginVersionCache;
function pluginVersion() {
  if (pluginVersionCache !== undefined) return pluginVersionCache;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    pluginVersionCache = String(pkg.version || "");
  } catch {
    pluginVersionCache = "";
  }
  return pluginVersionCache;
}

function readJson(fp) {
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function statInfo(fp) {
  try {
    const st = fs.statSync(fp);
    return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size, isFile: st.isFile() };
  } catch {
    return null;
  }
}

function isDir(fp) {
  try {
    return fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left, right) {
  const norm = (value) => {
    const text = path.normalize(String(value || ""));
    return process.platform === "win32" ? text.toLowerCase() : text;
  };
  return Boolean(left) && Boolean(right) && norm(left) === norm(right);
}

/** DSH_HOME：优先环境变量；桌面 portable 安装再退到官方 dsh-home。 */
export function resolveDshHome(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.DSH_HOME || "").trim();
  if (explicit) return path.normalize(explicit);
  const home = os.homedir();
  for (const cand of [
    path.join(home, ".dsh"),
    path.join(home, "Library", "Application Support", "DeepSeek Harness", "dsh-home"),
  ]) {
    if (isDir(cand)) return path.normalize(cand);
  }
  return path.normalize(path.join(home, ".dsh"));
}

/** 宿主根：桌面是 resources/app 里的 @deepseek-ai；Web/CLI 用 DSH_HOME。 */
export function resolveHostRoot(options = {}) {
  const env = options.env || process.env;
  const resourcesPath = options.resourcesPath !== undefined
    ? options.resourcesPath
    : process.resourcesPath;
  if (resourcesPath) {
    for (const rel of [
      ["app", "dsh", "node_modules", "@deepseek-ai"],
      ["app", "node_modules", "@deepseek-ai"],
    ]) {
      const cand = path.join(String(resourcesPath), ...rel);
      if (isDir(cand)) return path.normalize(cand);
    }
  }
  const envBase = String(env.DSH_BASE || "").trim();
  if (envBase) return path.normalize(envBase);
  return resolveDshHome({ env });
}

export function startupCachePath(dshHome) {
  return path.join(dshHome, "dsh-purge", "startup-cache.json");
}

export function readStartupCache(dshHome) {
  const fp = startupCachePath(dshHome);
  const record = readJson(fp);
  return record && typeof record === "object" ? record : null;
}

/** 小文件、非关键：直接写；半截 JSON 下次读失败会自然重扫。 */
export function writeStartupCache(dshHome, record) {
  const fp = startupCachePath(dshHome);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const previous = fs.readFileSync(fp, "utf8");
    if (previous === body) return { ok: true, wrote: false, path: fp };
  } catch { /* 首次写 */ }
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body, "utf8");
    return { ok: true, wrote: true, path: fp };
  } catch (error) {
    return { ok: false, wrote: false, path: fp, error: String(error && error.message ? error.message : error) };
  }
}

/** 可能带 rea MCP 行的配置来源：profile 覆盖层优先，包内 bundle 兜底。 */
function patchSources(dshHome) {
  const out = [];
  const profiles = path.join(dshHome, "profiles");
  let names = [];
  try { names = fs.readdirSync(profiles); } catch { names = []; }
  for (const name of names) {
    const dir = path.join(profiles, name);
    if (!isDir(dir)) continue;
    out.push(path.join(dir, "cordis.patch.yml"));
  }
  const homePatch = path.join(dshHome, "cordis.patch.yml");
  out.push(homePatch);
  out.push(path.join(PLUGIN_ROOT, "cordis.patch.yml"));
  return out;
}

/**
 * 当前配置里的 rea-agents 精确版本 + 来源文件指纹。
 * 只做字符串识别（这一行是固定形态），不引入 YAML 依赖。
 */
export function configuredReaSpec(dshHome = resolveDshHome()) {
  for (const fp of patchSources(dshHome)) {
    const st = statInfo(fp);
    if (!st || !st.isFile) continue;
    let text = "";
    try { text = fs.readFileSync(fp, "utf8"); } catch { continue; }
    const match = REA_SPEC_RE.exec(text);
    if (!match) continue;
    return {
      spec: `rea-agents@${match[1]}`,
      sourcePath: fp,
      sourceMtimeMs: st.mtimeMs,
      sourceSize: st.size,
    };
  }
  return null;
}

export function defaultNpmCache() {
  return path.resolve(
    process.env.npm_config_cache
      || process.env.NPM_CONFIG_CACHE
      || path.join(os.homedir(), ".npm"),
  );
}

function inspectNpxDir(dir, version) {
  if (!dir) return null;
  const packagePath = path.join(dir, "node_modules", "rea-agents", "package.json");
  const pkg = readJson(packagePath);
  if (!pkg || String(pkg.version || "") !== version) return null;
  const packageStat = statInfo(packagePath);
  if (!packageStat || !packageStat.isFile) return null;
  const binName = process.platform === "win32" ? "rea.cmd" : "rea";
  const binPath = path.join(dir, "node_modules", ".bin", binName);
  const binStat = statInfo(binPath);
  if (!binStat || !binStat.isFile) return null;
  return {
    packagePath,
    packageVersion: version,
    packageMtimeMs: packageStat.mtimeMs,
    packageSize: packageStat.size,
    binPath,
    binMtimeMs: binStat.mtimeMs,
    binSize: binStat.size,
  };
}

/** 找本机 npm `_npx` 里已解包好的 rea-agents 精确版本。只读。 */
export function resolveReaNpxCache(spec, options = {}) {
  const text = String(spec || "");
  const at = text.lastIndexOf("@");
  const version = at > 0 ? text.slice(at + 1) : "";
  if (!version) return null;
  const cacheRoot = path.resolve(options.cacheRoot || defaultNpmCache());
  const preferredDir = options.preferredDir ? path.normalize(options.preferredDir) : "";
  const preferredRoot = preferredDir ? path.dirname(preferredDir) : "";
  const preferred = samePath(preferredRoot, path.join(cacheRoot, "_npx"))
    ? inspectNpxDir(preferredDir, version)
    : null;
  if (preferred) return { cacheRoot, dir: preferredDir, ...preferred };

  let entries = [];
  try {
    entries = fs.readdirSync(path.join(cacheRoot, "_npx"), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(cacheRoot, "_npx", entry.name);
    const info = inspectNpxDir(dir, version);
    if (info) return { cacheRoot, dir, ...info };
  }
  return null;
}

function buildRecord({ version, hostRoot, specInfo, npx }) {
  return {
    schema: STARTUP_CACHE_SCHEMA,
    pluginVersion: version,
    hostRoot,
    spec: specInfo.spec,
    specSource: specInfo.sourcePath,
    specSourceMtimeMs: specInfo.sourceMtimeMs,
    specSourceSize: specInfo.sourceSize,
    npx: {
      cacheRoot: npx.cacheRoot,
      dir: npx.dir,
      packagePath: npx.packagePath,
      packageVersion: npx.packageVersion,
      packageMtimeMs: npx.packageMtimeMs,
      packageSize: npx.packageSize,
      binPath: npx.binPath,
      binMtimeMs: npx.binMtimeMs,
      binSize: npx.binSize,
    },
    validatedAt: new Date().toISOString(),
  };
}

/**
 * 校验旧记录。任何一项对不上都返回 ok:false 并给出原因，调用方重新扫描。
 * `options.pluginVersion` / `hostRoot` / `specInfo` 只为测试注入，生产走默认。
 */
export function validateStartupCache(record, options = {}) {
  if (!record || typeof record !== "object") return { ok: false, reason: "missing" };
  if (record.schema !== STARTUP_CACHE_SCHEMA) return { ok: false, reason: "schema" };

  const version = options.pluginVersion !== undefined ? options.pluginVersion : pluginVersion();
  if (!version || record.pluginVersion !== version) return { ok: false, reason: "plugin-version" };

  const dshHome = options.dshHome || resolveDshHome(options);
  const hostRoot = options.hostRoot || resolveHostRoot(options);
  if (!hostRoot || !samePath(record.hostRoot, hostRoot)) return { ok: false, reason: "host-root" };

  const specInfo = options.specInfo || configuredReaSpec(dshHome);
  if (!specInfo) return { ok: false, reason: "no-spec" };
  if (record.spec !== specInfo.spec) return { ok: false, reason: "spec" };
  if (!samePath(record.specSource, specInfo.sourcePath)
    || record.specSourceMtimeMs !== specInfo.sourceMtimeMs
    || record.specSourceSize !== specInfo.sourceSize) {
    return { ok: false, reason: "spec-source" };
  }

  const npx = record.npx;
  if (!npx || typeof npx !== "object") return { ok: false, reason: "no-npx" };
  const cacheRoot = path.resolve(options.cacheRoot || defaultNpmCache());
  if (!samePath(npx.cacheRoot, cacheRoot)) return { ok: false, reason: "cache-root" };
  if (!samePath(path.dirname(String(npx.dir || "")), path.join(cacheRoot, "_npx"))) {
    return { ok: false, reason: "npx-root" };
  }
  const versionFromSpec = specInfo.spec.slice(specInfo.spec.lastIndexOf("@") + 1);
  const current = inspectNpxDir(npx.dir, versionFromSpec);
  if (!current) return { ok: false, reason: "npx-missing" };
  if (!samePath(npx.packagePath, current.packagePath)
    || npx.packageVersion !== current.packageVersion
    || npx.packageMtimeMs !== current.packageMtimeMs
    || npx.packageSize !== current.packageSize
    || !samePath(npx.binPath, current.binPath)
    || npx.binMtimeMs !== current.binMtimeMs
    || npx.binSize !== current.binSize) {
    return { ok: false, reason: "npx-changed" };
  }

  const validatedAt = Date.parse(String(record.validatedAt || ""));
  const maxAgeMs = options.maxAgeMs === undefined ? DEFAULT_MAX_AGE_MS : Number(options.maxAgeMs);
  if (!Number.isFinite(validatedAt)) return { ok: false, reason: "stale" };
  if (maxAgeMs > 0 && Date.now() - validatedAt > maxAgeMs) return { ok: false, reason: "stale" };

  return { ok: true, reason: "valid", record, specInfo };
}

function setPreferOffline(env) {
  // 用户/宿主已经显式配置过就不覆盖（包括显式 false）。
  if (env.npm_config_prefer_offline !== undefined
    || env.NPM_CONFIG_PREFER_OFFLINE !== undefined) return false;
  env.npm_config_prefer_offline = "true";
  return true;
}

/**
 * 启动期唯一入口：命中旧记录就直接用；否则扫描一次并落缓存。
 * 任何异常都按「不设置环境变量」处理，绝不让启动缓存本身挡住宿主。
 */
export function prepareStartupEnv(options = {}) {
  const env = options.env || process.env;
  const dshHome = options.dshHome || resolveDshHome({ env });
  const hostRoot = options.hostRoot || resolveHostRoot({ env, resourcesPath: options.resourcesPath });
  const version = options.pluginVersion !== undefined ? options.pluginVersion : pluginVersion();
  const cachePath = startupCachePath(dshHome);
  const base = { cachePath, dshHome, hostRoot, envSet: false };

  const specInfo = options.specInfo || configuredReaSpec(dshHome);
  if (!specInfo) return { ...base, hit: false, reason: "no-spec" };

  const previous = readStartupCache(dshHome);
  let invalidReason = "";
  if (previous) {
    const checked = validateStartupCache(previous, {
      dshHome,
      hostRoot,
      pluginVersion: version,
      specInfo,
      cacheRoot: options.cacheRoot,
      maxAgeMs: options.maxAgeMs,
    });
    if (checked.ok) {
      return {
        ...base,
        hit: true,
        reason: "valid",
        spec: specInfo.spec,
        record: previous,
        envSet: setPreferOffline(env),
      };
    }
    invalidReason = checked.reason;
  }

  const npx = resolveReaNpxCache(specInfo.spec, {
    cacheRoot: options.cacheRoot,
    preferredDir: previous?.npx?.dir,
  });
  if (!npx) {
    return {
      ...base,
      hit: false,
      reason: invalidReason ? `no-npx:${invalidReason}` : "no-npx",
      spec: specInfo.spec,
    };
  }

  const record = buildRecord({ version, hostRoot, specInfo, npx });
  const written = writeStartupCache(dshHome, record);
  return {
    ...base,
    hit: false,
    refreshed: true,
    reason: invalidReason ? `refreshed:${invalidReason}` : "refreshed",
    spec: specInfo.spec,
    record,
    written,
    envSet: setPreferOffline(env),
  };
}
