/**
 * 工具就绪清单（数据层）
 *
 * 红队模式原先有两个盲区：
 *   1. envAdaptStatus 找到 ≥2 个工具就报 ready，模型以为「工具齐全」；
 *   2. preflight 只查路径存在，不做可执行性冒烟。
 *
 * 这里产出一份结构化、带版本冒烟、可缓存的清单：
 *   · 路径解析完全复用 platform-config（loadPlatformConfig / resolveAllTools）；
 *   · 对已找到的工具跑一次 `--version` / `-version` / `-h` / `--help` 冒烟；
 *   · 结果落 `$DSH_HOME/dsh-purge/tool-manifest.json`，按 (path, mtimeMs, size)
 *     缓存 10 分钟，缓存命中不重复执行；
 *   · 所有入口 fail-open：失败返回空结构/空串，不向调用方抛异常。
 *
 * 本模块只读本机文件系统并执行已解析到的工具，不联网、不写插件安装目录。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  CORE_TOOL_IDS,
  detectKali,
  envAdaptStatus,
  isWinLike,
  loadPlatformConfig,
  resolveAllTools,
  resolveTool,
} from './platform-config.js'

/** 清单结构版本；字段语义变化时递增。 */
export const MANIFEST_SCHEMA = 1

/**
 * 核心工具集合与 platform-config 共用同一份定义。
 * 这里用 re-export（而不是 `const = CORE_TOOL_IDS`）：即使将来 platform-config
 * 反向 import 本模块，模块初始化阶段也不会读到尚未初始化的绑定。
 */
export { CORE_TOOL_IDS }

/**
 * tool id → 展示分类。分类只影响 prompt section 的分行，不影响就绪判定。
 * frps 是隧道服务端（通常跑在 VPS，不是操作机），归 optional。
 */
export const TOOL_TIERS = Object.freeze({
  nmap: 'scan',
  nuclei: 'scan',
  masscan: 'scan',
  httpx: 'web',
  ffuf: 'web',
  subfinder: 'recon',
  dnsx: 'recon',
  ksubdomain: 'recon',
  fscan: 'intranet',
  gogo: 'intranet',
  suo5: 'tunnel',
  frpc: 'tunnel',
  chisel: 'tunnel',
  impacket: 'cred',
  frps: 'optional',
})

const TIER_ORDER = ['scan', 'web', 'recon', 'intranet', 'tunnel', 'cred', 'optional']
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 2500
const PROBE_FLAGS = ['--version', '-version', '-h', '--help']
const MAX_SECTION_CHARS = 1200
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const SECTION_FOOTER = '缺失工具不要假设命令存在；需要刷新时调用 redteam_preflight。'
const MAX_VERSION_LINE = 80

function errText(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message || error.code || error)
}

function normOptions(options) {
  return options && typeof options === 'object' ? options : {}
}

function resolveDshHome(options = {}) {
  const env = options.env || process.env
  const explicit = String(options.dshHome || env.DSH_HOME || '').trim()
  if (explicit) return explicit
  return join(homedir(), '.dsh')
}

function redteamRootOf(options = {}) {
  if (options.root) return options.root
  return join(resolveDshHome(options), 'redteam')
}

function ttlOf(options = {}) {
  const n = Number(options.ttlMs)
  if (Number.isFinite(n) && n >= 0) return n
  return DEFAULT_TTL_MS
}

function nowMs(options = {}) {
  const n = Number(options.now)
  return Number.isFinite(n) ? n : Date.now()
}

function probeTimeoutOf(options = {}) {
  const n = Number(options.probeTimeoutMs !== undefined ? options.probeTimeoutMs : options.timeoutMs)
  if (Number.isFinite(n) && n > 0) return n
  return DEFAULT_PROBE_TIMEOUT_MS
}

function samePath(left, right) {
  const norm = (value) => {
    const text = String(value || '')
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return Boolean(left) && Boolean(right) && norm(left) === norm(right)
}

/** 清单落盘路径：`$DSH_HOME/dsh-purge/tool-manifest.json`。 */
export function manifestPath(options = {}) {
  try {
    options = normOptions(options)
    return join(resolveDshHome(options), 'dsh-purge', 'tool-manifest.json')
  } catch {
    /* options 里有异常值时也不让只读调用方炸掉。 */
    return join(homedir(), '.dsh', 'dsh-purge', 'tool-manifest.json')
  }
}

/**
 * 同步读缓存。缺失 / 损坏 / schema 不符 / 超过 TTL → null。
 * 不做任何修复或写入，适合 prompt 组装这种高频只读路径。
 */
export function readToolManifest(options = {}) {
  try {
    options = normOptions(options)
    const file = manifestPath(options)
    /* 只接受普通文件，且限制体积：损坏/被替换成 FIFO、设备或超大文件时
       prompt 组装不应被拖死。 */
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null
    const raw = readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    if (Number(data.schema) !== MANIFEST_SCHEMA) return null
    if (!Array.isArray(data.items)) return null
    const generated = Date.parse(String(data.generatedAt || ''))
    if (!Number.isFinite(generated)) return null
    if (nowMs(options) - generated > ttlOf(options)) return null
    return data
  } catch {
    return null
  }
}

/**
 * 原子写（tmp + fsync + rename）。失败返回 {ok:false,error}，不抛。
 */
export function writeToolManifest(manifest, options = {}) {
  options = normOptions(options)
  const file = manifestPath(options)
  try {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, path: file, error: 'manifest must be an object' }
    }
    const body = JSON.stringify(manifest, null, 2)
    if (typeof body !== 'string') {
      return { ok: false, path: file, error: 'manifest is not JSON-serializable' }
    }
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, body + '\n')
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, path: file, error: errText(error) }
  }
}

function statKey(file) {
  try {
    const st = statSync(file)
    if (!st.isFile()) return null
    return { path: file, mtimeMs: Math.trunc(st.mtimeMs), size: st.size }
  } catch {
    return null
  }
}

function cleanOutput(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function firstLine(text) {
  for (const line of cleanOutput(text).split('\n')) {
    const value = line.trim()
    if (!value) continue
    return value.length > MAX_VERSION_LINE ? value.slice(0, MAX_VERSION_LINE - 1) + '…' : value
  }
  return ''
}

function hardProbeFailure(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (code === 'ETIMEDOUT' || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') return true
  if (error.killed === true) return true
  return false
}

/**
 * 有些「能启动但跑不起来」的二进制会把错误打到 stderr 并非零退出
 * （动态库缺失、权限不足、解释器不存在）。这类输出不能当成版本冒烟通过。
 */
function looksLikeBrokenRun(text) {
  return /(command not found|no such file or directory|not recognized as an internal or external command|error while loading shared libraries|cannot execute binary|permission denied)/i.test(String(text || ''))
}

/** 跑一个 flag；输出统一收 stdout+stderr，超时/无法执行由调用方判失败。 */
function runFlag(file, flag, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (error, stdout, stderr) => {
      if (settled) return
      settled = true
      resolve({
        error: error || null,
        output: cleanOutput(String(stdout || '') + String(stderr || '')),
        ms: Math.max(0, Date.now() - started),
      })
    }
    try {
      execFile(file, [flag], {
        timeout: probeTimeoutOf(options),
        windowsHide: true,
        maxBuffer: 64 * 1024,
        killSignal: 'SIGKILL',
        env: options.env || process.env,
        cwd: options.cwd || undefined,
      }, done)
    } catch (error) {
      done(error, '', '')
    }
  })
}

async function probeFlags(file, options = {}) {
  let totalMs = 0
  let lastError = null
  for (const flag of PROBE_FLAGS) {
    const result = await runFlag(file, flag, options)
    totalMs += result.ms
    if (hardProbeFailure(result.error)) {
      return {
        versionOk: false,
        version: '',
        error: errText(result.error),
        ms: totalMs,
      }
    }
    if (!result.error && result.output && !looksLikeBrokenRun(result.output)) {
      return {
        versionOk: true,
        version: firstLine(result.output),
        error: null,
        ms: totalMs,
      }
    }
    if (result.output) lastError = firstLine(result.output)
    else if (result.error) lastError = result.error
  }
  return {
    versionOk: false,
    version: '',
    error: lastError ? errText(lastError) : 'no version/help output',
    ms: totalMs,
  }
}

/**
 * 冒烟单个工具。`options.path` 可直接给路径；否则按 platform-config 的解析顺序找。
 * 永不抛，返回值固定为 {versionOk, version, error, ms}。
 */
export async function probeTool(id, options = {}) {
  options = normOptions(options)
  let file = typeof options.path === 'string' ? options.path : ''
  if (!file) {
    try {
      const resolved = resolveTool(id, {
        root: redteamRootOf(options),
        config: options.config,
        env: options.env || process.env,
      })
      file = resolved.path || ''
    } catch (error) {
      return { versionOk: false, version: '', error: errText(error), ms: 0 }
    }
  }
  if (!file) {
    return { versionOk: false, version: '', error: 'not found', ms: 0 }
  }
  try {
    return await probeFlags(file, options)
  } catch (error) {
    return { versionOk: false, version: '', error: errText(error), ms: 0 }
  }
}

async function mapLimit(list, limit, fn) {
  const queue = list.slice()
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

function emptySummary() {
  return {
    total: 0,
    found: 0,
    probed: 0,
    versionOk: 0,
    missing: 0,
    coreTotal: CORE_TOOL_IDS.length,
    coreFound: 0,
    coreMissing: CORE_TOOL_IDS.slice(),
    ready: false,
    degraded: false,
  }
}

/**
 * 构建清单。永不抛；异常时返回 schema 正确的空清单（带 error 字段）。
 */
export async function buildToolManifest(options = {}) {
  options = normOptions(options)
  const generatedAt = new Date(nowMs(options)).toISOString()
  try {
    const root = redteamRootOf(options)
    const env = options.env || process.env
    const cfg = options.config || loadPlatformConfig(root)
    const resolved = resolveAllTools({ root, config: cfg, env })
    const kaliInfo = detectKali()
    const status = envAdaptStatus(root, { config: cfg, tools: resolved, kali: kaliInfo })

    const previous = readToolManifest(options)
    const previousCache = previous && previous.cache && typeof previous.cache === 'object'
      ? previous.cache
      : {}

    const items = resolved.map((tool) => ({
      id: tool.id,
      label: tool.label || tool.id,
      tier: TOOL_TIERS[tool.id] || 'optional',
      path: tool.path || null,
      source: tool.source || (tool.path ? 'path' : 'missing'),
      versionOk: null,
      version: '',
      /* 已配置但路径不存在时，把解析器的 note 带出来，方便 preflight 说明原因。 */
      error: tool.path ? null : (tool.note || null),
    }))

    const foundItems = items.filter((item) => item.path)
    const nextCache = {}
    await mapLimit(foundItems, 4, async (item) => {
      const key = statKey(item.path)
      const cached = key && previousCache[item.id] ? previousCache[item.id] : null
      const cachedAt = cached ? Date.parse(String(cached.at || '')) : NaN
      if (key
        && cached
        && samePath(cached.path, key.path)
        && Number(cached.mtimeMs) === key.mtimeMs
        && Number(cached.size) === key.size
        && Number.isFinite(cachedAt)
        && nowMs(options) - cachedAt <= ttlOf(options)) {
        item.versionOk = cached.versionOk === true
        item.version = typeof cached.version === 'string' ? cached.version : ''
        item.error = cached.error == null ? null : String(cached.error)
        nextCache[item.id] = cached
        return
      }
      const probed = await probeTool(item.id, Object.assign({}, options, {
        path: item.path,
        config: cfg,
        env,
      }))
      item.versionOk = probed.versionOk === true
      item.version = typeof probed.version === 'string' ? probed.version : ''
      item.error = probed.error == null ? null : String(probed.error)
      if (key) {
        nextCache[item.id] = {
          path: key.path,
          mtimeMs: key.mtimeMs,
          size: key.size,
          versionOk: item.versionOk,
          version: item.version,
          error: item.error,
          ms: Number(probed.ms) || 0,
          at: new Date(nowMs(options)).toISOString(),
        }
      }
    })

    const foundIds = new Set(items.filter((item) => item.path).map((item) => item.id))
    const coreMissing = CORE_TOOL_IDS.filter((id) => !foundIds.has(id))
    const summary = {
      total: items.length,
      found: foundIds.size,
      /* probed 指「拿到冒烟结论的工具数」（含缓存命中）；missing 的 versionOk 为 null，不计入。 */
      probed: items.filter((item) => item.versionOk !== null).length,
      versionOk: items.filter((item) => item.versionOk === true).length,
      missing: items.length - foundIds.size,
      coreTotal: CORE_TOOL_IDS.length,
      coreFound: CORE_TOOL_IDS.length - coreMissing.length,
      coreMissing,
      ready: status.ready === true,
      degraded: status.degraded === true,
    }

    return {
      schema: MANIFEST_SCHEMA,
      generatedAt,
      platform: {
        windows: !!isWinLike(cfg),
        kali: !!kaliInfo.kali,
        kaliSource: kaliInfo.source || null,
      },
      items,
      summary,
      ready: summary.ready,
      reason: status.reason || 'need-config',
      /* 冒烟缓存：readToolManifest 通过 TTL 控制整份清单的新鲜度，这里按
         (path, mtimeMs, size) + 单项 at 复用，工具没变就不重复执行。 */
      cache: nextCache,
    }
  } catch (error) {
    return {
      schema: MANIFEST_SCHEMA,
      generatedAt,
      platform: {
        windows: osPlatform() === 'win32',
        kali: false,
        kaliSource: null,
      },
      items: [],
      summary: emptySummary(),
      ready: false,
      reason: 'need-config',
      error: errText(error),
    }
  }
}

function tierLine(tier, group) {
  const parts = group.map((item) => {
    const mark = item.versionOk === true ? '✓' : '✗'
    const version = item.versionOk === true && item.version
      ? ' ' + String(item.version).replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_LINE)
      : ''
    return mark + ' ' + item.id + version
  })
  return tier + '  ' + parts.join(' · ')
}

/**
 * 给 prompt section 的紧凑文本（同步、只读缓存）。
 * 无缓存 → 空串；有缓存 → 首行 manifest 时间 + 按 tier 分行 + 固定尾注，≤1200 字符。
 */
export function manifestSectionText(options = {}) {
  try {
    options = normOptions(options)
    const manifest = readToolManifest(options)
    if (!manifest) return ''
    const items = Array.isArray(manifest.items) ? manifest.items : []
    const header = '[TOOLING MANIFEST — 本机实测 ' + String(manifest.generatedAt || '').slice(0, 64) + ']'
    const coreSet = new Set(CORE_TOOL_IDS)
    const byId = new Map(items.map((item) => [item.id, item]))
    /* core 行按 CORE_TOOL_IDS 的固定顺序，避免受 catalog 排序影响。 */
    const coreItems = CORE_TOOL_IDS.map((id) => byId.get(id)).filter(Boolean)
    const lines = []
    if (coreItems.length > 0) lines.push(tierLine('core', coreItems))
    for (const tier of TIER_ORDER) {
      const group = items.filter((item) => {
        if (coreSet.has(item.id)) return false
        const itemTier = item.tier || 'optional'
        if (tier === 'optional') return itemTier === 'optional' || !TIER_ORDER.includes(itemTier)
        return itemTier === tier
      })
      if (group.length > 0) lines.push(tierLine(tier, group))
    }

    const max = Math.max(
      header.length + SECTION_FOOTER.length + 2,
      Math.min(MAX_SECTION_CHARS, Number(options.maxChars) || MAX_SECTION_CHARS),
    )
    /* 给 header / footer 及其换行留位置，正文超长时最后一行用省略号收尾。 */
    const budget = max - header.length - SECTION_FOOTER.length - 2
    let body = ''
    for (const line of lines) {
      const separator = body ? 1 : 0
      if (body.length + separator + line.length <= budget) {
        body += (body ? '\n' : '') + line
        continue
      }
      const remain = budget - body.length - separator
      if (remain > 1) body += (body ? '\n' : '') + line.slice(0, remain - 1) + '…'
      break
    }
    return body ? header + '\n' + body + '\n' + SECTION_FOOTER : header + '\n' + SECTION_FOOTER
  } catch {
    return ''
  }
}

let refreshing = false

/**
 * 非阻塞刷新：缓存有效直接返回；否则起一个后台构建并写缓存，返回 null。
 * 绝不 throw，也不等待后台任务。
 */
export function startManifestRefresh(options = {}) {
  try {
    options = normOptions(options)
    const cached = readToolManifest(options)
    if (cached) return cached
    if (refreshing) return null
    refreshing = true
    const snapshot = Object.assign({}, options)
    void Promise.resolve()
      .then(() => buildToolManifest(snapshot))
      .then((manifest) => {
        writeToolManifest(manifest, snapshot)
        return manifest
      })
      .catch(() => null)
      .finally(() => { refreshing = false })
    return null
  } catch {
    return null
  }
}
