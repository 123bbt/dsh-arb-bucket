/**
 * @dsh-external/dsh-arb-bucket — host 侧（hybrid：设置命名空间 + attachment-local 配置桥）。
 *
 * 职责：
 *  1. 注册持久设置命名空间 "dsh-arb-bucket"（三项图片上限），设置菜单自动渲染。
 *  2. apply 时 + 每次设置变更时，把值推送到 @deepseek-ai/dsh-attachment-local 的
 *     loader entry（entry.update({ config })）→ cordis 检测 config diff → 重启其
 *     fiber → 新 imageLimits 生效（host 校验 + UI 预检投影共用同一份，全链路一致）。
 *
 * 机制依据（DSH 0.1.x 实测）：
 *  - dsh-attachment-local 在 apply 时一次性冻结 imageLimits（Object.freeze），
 *    改配置必须经 fiber 重启，entry.update() 正是官方路径。
 *  - 官方默认值：maxImageBytes=3670016(3.5MB) / maxImagePixels=4e7 / maxImageDimension=2e3。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = '@dsh-external/dsh-arb-bucket'

/** dsh-settings 服务由 dsh-base bundle 装配（conversation-tweaks 同款依赖声明）。 */
export const inject = ['settings']

/** attachment-local 0.1.x 的官方默认值（与代码内 default 保持一致）。 */
export const ATTACHMENT_DEFAULTS = {
  maxImageBytes: 3_670_016, // 3.5 MB
  maxImagePixels: 40_000_000, // 4000 万像素
  maxImageDimension: 2_000, // 单边 2000px
} as const

/** 三项的安全边界：防止误设导致请求体爆炸（bytes ≤ 256MB）或无意义极小值。 */
const BOUNDS = {
  maxImageBytes: { min: 1024, max: 268_435_456 }, // 1KB .. 256MB
  maxImagePixels: { min: 100_000, max: 400_000_000 }, // 0.1MP .. 400MP
  maxImageDimension: { min: 256, max: 16_384 }, // 256px .. 16384px
} as const

export interface LimitsConfig {
  maxImageBytes: number
  maxImagePixels: number
  maxImageDimension: number
}

export const Config = z.object({
  maxImageBytes: z
    .number()
    .step(1)
    .min(BOUNDS.maxImageBytes.min)
    .max(BOUNDS.maxImageBytes.max)
    .default(ATTACHMENT_DEFAULTS.maxImageBytes)
    .description('单张图片字节上限（bytes）'),
  maxImagePixels: z
    .number()
    .step(1)
    .min(BOUNDS.maxImagePixels.min)
    .max(BOUNDS.maxImagePixels.max)
    .default(ATTACHMENT_DEFAULTS.maxImagePixels)
    .description('单张图片总像素上限（pixels）'),
  maxImageDimension: z
    .number()
    .step(1)
    .min(BOUNDS.maxImageDimension.min)
    .max(BOUNDS.maxImageDimension.max)
    .default(ATTACHMENT_DEFAULTS.maxImageDimension)
    .description('单边尺寸上限（px）'),
})

// ─── 结构化类型（避免编译期依赖宿主内部包） ───

interface SettingsScope {
  get(): LimitsConfig
  watch(fn: () => void): void
}

interface SettingsService {
  register(ns: string, schema: unknown, opts?: { base?: unknown }): SettingsScope
}

interface LoaderEntry {
  options?: { id?: string; name?: string; config?: Record<string, unknown> }
  update(options: Record<string, unknown>): Promise<void>
}

type AppContext = Context & {
  settings: SettingsService
  loader: { entries(): LoaderEntry[] }
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

const NS = settingsNamespace('dsh-arb-bucket')
const TARGET_ID = 'attachment-local'

/** 在 loader 树里找 dsh-attachment-local 的 entry（dsh-base patch 以 id: attachment-local 装配）。 */
function findAttachmentEntry(ctx: AppContext): LoaderEntry | undefined {
  try {
    return ctx.loader.entries().find((e) => e.options?.id === TARGET_ID || e.options?.name === '@deepseek-ai/dsh-attachment-local')
  } catch {
    return undefined
  }
}

/** 把三项上限合并进 attachment-local 的 entry config（保留其 config 其余键）。 */
async function pushLimits(ctx: AppContext, limits: LimitsConfig, scopeTag: string): Promise<boolean> {
  const entry = findAttachmentEntry(ctx)
  if (!entry) {
    ctx.logger.warn('[dsh-arb-bucket] loader entry "' + TARGET_ID + '" not found; limits not applied (' + scopeTag + ')')
    return false
  }
  const merged = { ...(entry.options?.config ?? {}), ...limits }
  await entry.update({ config: merged })
  ctx.logger.info(
    '[dsh-arb-bucket] limits applied (' + scopeTag + '): ' +
      'maxImageBytes=' + limits.maxImageBytes + ' maxImagePixels=' + limits.maxImagePixels + ' maxImageDimension=' + limits.maxImageDimension,
  )
  return true
}

export function apply(ctx: AppContext, config: LimitsConfig): void {
  // 设置命名空间注册：存储的非法配置节不能拖垮本插件 fiber（fail-soft，回退组合配置）。
  let scope: SettingsScope
  try {
    scope = ctx.settings.register(NS, Config, { base: config ?? {} })
  } catch (error) {
    ctx.logger.warn('[dsh-arb-bucket] settings register failed; falling back to composition config: ' + String(error))
    return
  }

  const current = (): LimitsConfig => {
    const s = scope.get()
    return {
      maxImageBytes: s.maxImageBytes ?? ATTACHMENT_DEFAULTS.maxImageBytes,
      maxImagePixels: s.maxImagePixels ?? ATTACHMENT_DEFAULTS.maxImagePixels,
      maxImageDimension: s.maxImageDimension ?? ATTACHMENT_DEFAULTS.maxImageDimension,
    }
  }

  // 启动即推送一次（重启 DSH 后由持久化的设置文档恢复用户自定义值）。
  void pushLimits(ctx, current(), 'boot').catch((e) => ctx.logger.warn('[dsh-arb-bucket] boot push failed: ' + String(e)))

  // 设置变更 → 热生效（entry.update → cordis diff → fiber 重启 → 新 imageLimits）。
  scope.watch(() => {
    void pushLimits(ctx, current(), 'watch').catch((e) => ctx.logger.warn('[dsh-arb-bucket] watch push failed: ' + String(e)))
  })

  ctx.logger.info('[dsh-arb-bucket] ready（设置 → 设置菜单 → ARB 桶）')
}