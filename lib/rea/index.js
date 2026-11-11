/**
 * dsh-purge 逆向台自举（host 半侧）
 *
 * 分析能力来自 REA MCP（bundle patch 的 dsh-purge-rea-mcp 行注册 mcp__rea__* 工具）。
 * 本文件只做三件事：
 *   1. 把 `presets/rea` 落到 `$DSH_HOME/.agent-presets/rea/`（内容不同才覆盖，不删用户文件）
 *   2. 随包技能落到 `$DSH_HOME/rea/skills`，setup.sh 落到 `$DSH_HOME/rea/`
 *   3. 软取 agentPresets registry，把「逆向模式」注册进模式下拉
 *
 * 与 redteam 自举的差异：没有 store/tools/ui 分包（P2 演进项），逻辑显著更薄。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from '../redteam/preset-composition.js'

/** Cordis 插件名。 */
export const name = 'dsh-purge-rea'

/** 不硬依赖 agentPresets，就绪后软取并声明（与 redteam 同款）。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
export const REA_PRESET_ID = 'rea'

/** 插件根目录（lib/rea → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presetDir: join(root, 'presets', 'rea'),
    skills: join(root, 'skills', 'rea'),
    setupScript: join(root, 'scripts', 'rea-setup.sh'),
  }
}

/** 环境数据目录。 */
export function reaDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'rea')
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 一致）。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/** 复制单个文件：内容相同跳过（避免每次启动写盘），不同覆盖。 */
function syncFileIfChanged(src, dest, mode) {
  let wanted
  try {
    wanted = readFileSync(src)
  } catch {
    return 'missing'
  }
  try {
    if (existsSync(dest)) {
      let current = null
      try { current = readFileSync(dest) } catch { /* 视为不同 */ }
      if (current !== null && current.equals(wanted)) {
        if (mode) { try { chmodSync(dest, mode) } catch { /* 忽略 */ } }
        return 'kept'
      }
    }
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, wanted, { mode: mode || 0o644 })
    return 'installed'
  } catch {
    return 'error'
  }
}

/** 递归同步目录：只增改不删除；返回 { synced, actions }。 */
function syncTree(srcDir, destDir) {
  const actions = []
  let synced = 0
  const walk = (src, dest) => {
    let entries
    try { entries = readdirSync(src, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '.git') continue
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      if (entry.isDirectory()) {
        walk(s, d)
        continue
      }
      if (!entry.isFile()) continue
      const action = syncFileIfChanged(s, d)
      actions.push(action)
      if (action === 'installed') synced += 1
    }
  }
  walk(srcDir, destDir)
  return { synced, actions }
}

/**
 * 落地预设 + 技能 + setup 脚本。
 * 语义：包内文件不存在 → 装；内容不同 → 覆盖（自愈 npm 升级 / 官方更新改坏）；
 *       相同 → 不动。用户在目录里自己加的文件不会被删。
 */
export function installReaAssets(log = () => {}) {
  const paths = packagePaths()
  const presetTarget = join(userPresetRoot(), REA_PRESET_ID)
  const skillsTarget = join(reaDataDir(), 'skills')
  let preset = 0
  let skills = 0
  try {
    const r = syncTree(paths.presetDir, presetTarget)
    preset = r.synced
  } catch (error) {
    log(`preset sync failed: ${error?.message || String(error)}`)
  }
  try {
    const r = syncTree(paths.skills, skillsTarget)
    skills = r.synced
  } catch (error) {
    log(`skills sync failed: ${error?.message || String(error)}`)
  }
  let setup = 'missing'
  try {
    setup = syncFileIfChanged(paths.setupScript, join(reaDataDir(), 'setup.sh'), 0o755)
  } catch { /* ignore */ }
  if (preset + skills > 0) log(`assets landed: preset=${preset} skills=${skills}`)
  return { preset, skills, setup, presetDir: presetTarget, skillsDir: skillsTarget }
}

export function apply(ctx) {
  const log = (msg) => ctx.logger?.info?.('rea-mode: ' + msg)
  const warn = (msg) => ctx.logger?.warn?.('rea-mode: ' + msg)
  let result
  try {
    result = installReaAssets(log)
  } catch (error) {
    warn(`assets failed: ${error?.message || String(error)}`)
    result = { preset: 0, skills: 0, setup: 'missing', presetDir: join(userPresetRoot(), REA_PRESET_ID), skillsDir: join(reaDataDir(), 'skills') }
  }

  /* Web 0.1.7+ 模式下拉只认 agent-preset registry.register()（与 redteam 同款）。 */
  const statusFile = join(reaDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(reaDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', presetDir: result.presetDir, skillsDir: result.skillsDir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch { /* ignore */ }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), REA_PRESET_ID)
    const readyDir = existsSync(join(fromDisk, 'agent.cordis.yml'))
      ? fromDisk
      : packagePaths().presetDir
    return readPresetDefinition(REA_PRESET_ID, readyDir)
  }
  const registerOnce = (registry) => {
    let definition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      warn(`read preset failed: ${error?.message || String(error)}`)
      return
    }
    Promise.resolve()
      .then(async () => {
        await undeclare()
        const release = await registry.register(definition)
        /* 注册完成时 cleanup 已跑过（closed=true）则当场撤掉，避免泄漏在宿主里。 */
        if (closed) {
          try { await release() } catch { /* 已随宿主卸载 */ }
          writeStatus({ ok: false, phase: 'closed-during-register' })
          return
        }
        releaseDeclared = release
        let broken = null
        try {
          const row = (await registry.list()).find((p) => p.id === REA_PRESET_ID)
          broken = row?.broken || null
        } catch { /* ignore */ }
        writeStatus({
          ok: !broken,
          phase: broken ? 'registered-broken' : 'registered',
          id: definition.id,
          name: definition.name,
          broken,
        })
        if (broken) warn(`declared but broken: ${broken}`)
        else log(`declared for mode dropdown: ${definition.name || REA_PRESET_ID}`)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        warn(`register failed: ${error?.message || String(error)}`)
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 3000)
      try { timer.unref?.() } catch { /* ignore */ }
      /* 45s 放弃（宿主没有 agentPresets 平面时不无限轮询）。 */
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
    }
  }, 'dsh-purge-rea: declare agent preset')

  ctx.provide('reaMode', Object.freeze({
    paths: packagePaths(),
    assets: result,
    dataDir: reaDataDir(),
  }))
  ctx.logger?.info?.(
    'rea-mode: 就绪（数据目录 $DSH_HOME/rea；预设 %s；技能目录 %s；MCP 工具 mcp__rea__*）',
    result.presetDir, result.skillsDir,
  )
}

export default { name, inject, apply }
