/**
 * 工具清单 prompt section（红队 / REA 共用的「本机工具就绪」段）。
 *
 * 上游 tool-manifest 已把探测与缓存拆开：
 *   · manifestSectionText() 同步只读缓存，适配每次 prompt 组装；
 *   · startManifestRefresh() 非阻塞刷新，只在 apply 时点一次。
 * 所以这里不装定时器、不在 text() 里跑探测，避免 prompt 组装被进程执行拖住。
 *
 * 段位 10120：在宿主的 WEB_SURFACE(10100) 之后、本插件的 ANCHOR(10150) 之前，
 * 既保持「越靠后越新」的 recency，又不会顶掉锚点。
 *
 * 失败策略：section 注册不可用时只跳过本段，绝不阻断 preset 的其它行。
 */
import { manifestSectionText, startManifestRefresh } from './tool-manifest.js'

export const TOOLING_SECTION = 'dsh-purge:tooling'
export const TOOLING_ORDER = 10120

/**
 * cordis 4 里不经 inject 直接读 `ctx.systemPrompt` 会抛
 * `cannot get property "systemPrompt" without inject`（dsh-persona 同样声明）。
 * 声明后 apply 只在系统提示词服务就绪时运行；服务缺席时本行只是等待，不影响其它行。
 */
export const inject = ['systemPrompt']

function configOf(ctx, config) {
  if (config && typeof config === 'object') return config
  try {
    if (ctx && typeof ctx === 'object' && ctx.config && typeof ctx.config === 'object') return ctx.config
  } catch { /* 代理未注入时点属性会抛 */ }
  return {}
}

/** fire-and-forget；上游自己吞异常，这里再兜一层防代理 ctx 抛错。 */
function refreshQuietly() {
  try { startManifestRefresh() } catch { /* 首轮没有缓存就留空段，不影响其它 prompt */ }
}

/**
 * @param ctx - cordis 插件上下文。
 * @param config - `{ enabled?: boolean }`；`enabled === false` 时完全不注册。
 */
export function apply(ctx, config) {
  if (configOf(ctx, config).enabled === false) return

  // 注册前启动一次后台刷新：本轮 text() 仍可能为空，下一轮就有缓存。
  refreshQuietly()

  let prompt
  try { prompt = ctx?.systemPrompt } catch { return }
  if (!prompt || typeof prompt.section !== 'function') return

  let disposer
  try {
    disposer = prompt.section({
      name: TOOLING_SECTION,
      order: TOOLING_ORDER,
      interpolate: false,
      text: () => manifestSectionText(),
    })
  } catch { return }

  if (typeof disposer !== 'function') return
  // systemPrompt.section() 返回的是服务侧 effect disposer；挂到本插件的 ctx.effect
  // 上，preset 热重载 / dispose 时才会撤掉，避免同名段残留。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try { disposer() } catch { /* 已释放或宿主不认 */ }
      })
    }
  } catch { /* 死 ctx：段已注册，清理失败只影响热重载 */ }
}
