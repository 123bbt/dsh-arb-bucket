/**
 * @dsh-external/dsh-arb-bucket — host 侧（ARB 桶）。
 *
 * 职责：
 *  1. 注册持久设置命名空间 "dsh-arb-bucket"（maxImageBytes / maxImagePixels / maxImageDimension），
 *     设置菜单自动渲染三项配置。
 *  2. 把【上传允许上限 UPLOAD_ALLOW（256MB / 400MP / 16384px）】推送到
 *     @deepseek-ai/dsh-attachment-local 的 loader entry（entry.update({config}) →
 *     cordis diff → fiber 重启 → imageLimits = UPLOAD_ALLOW 生效）。这样客户端预检
 *     （dsh-client-ui-conversation/lib/client.js:3853 用 imageLimits.maxImageBytes 拦 file.size）
 *     与服务端 admission 都不再拦截大图。真正的缓存尺寸/字节目标由设置三项（ARB 桶）决定。
 *  3. ARB 桶缩放层：拦截 attachment store 实例上的 saveImages()，对每个输入图片：
 *     - 超过 maxImageDimension（单边）或 maxImagePixels（总像素）时，保持纵横比，
 *       取“限制之内最接近原尺寸”的缩放比例（dimension 与 pixels 双约束取更小 scale）；
 *     - 超过 maxImageBytes 时，用“缩小 + 重编码”阶梯（保格式降质量，再换 webp/jpeg）
 *       直至低于字节上限，并始终返回最小候选；
 *     - 把缩放/重编码后的字节交回原 saveImages → 写入 DSH 会话附件缓存
 *       （C:\Users\huang\.dsh\attachments\v1\objects\<前两位>/<sha256>）。
 *     这样大图可进会话，但缓存/发送的是小图，避免缓存膨胀。
 *
 * 机制依据（DSH 0.1.x 实测）：
 *  - dsh-attachment/admission.saveInput() 把 base64 解码为 { data: Uint8Array, mediaType, name? }；
 *    AttachmentStore.saveImages(inputs) 是服务端唯一批量入库入口（先 batch 校验，再逐张 saveImage）。
 *  - dsh-attachment-local.LocalAttachmentStore：validateImage/saveImage 都读取 this.imageLimits
 *    （构造时 Object.freeze 一次性冻结，改配置必须走 fiber 重启）；saveImageFile() 用缩放后的
 *    数据重新探测 metadata 并计算 sha256，因此替换字节完全兼容，模型读到的 attachment ref
 *    自动指向缩放后的缓存。
 *  - cordis Entry.update({config}) 重启 fiber 会替换 store 实例，因此 pushLimits 后要重新挂载
 *    缩放层；另用周期心跳兜底（启动时序 / 非本插件触发的 fiber 重建）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import sharp from 'sharp'

export const name = '@dsh-external/dsh-arb-bucket'

/** dsh-settings 服务由 dsh-base bundle 装配；ctx.loader.entries() 需显式注入 'loader'。 */
export const inject = ['settings', 'loader']

/** attachment-local 0.1.x 的官方默认值（与代码内 default 保持一致）。 */
export const ATTACHMENT_DEFAULTS = {
  maxImageBytes: 3_670_016, // 3.5 MB
  maxImagePixels: 40_000_000, // 4000 万像素
  maxImageDimension: 2_000, // 单边 2000px
} as const

/** 上传允许上限：写入 attachment-local 的 imageLimits / entry config，让客户端预检与
 *  服务端 admission 不拦截大图（默认 3.5MB~256MB 都放行）；真正的缓存尺寸/字节目标
 *  由设置三项（ARB 桶）决定，saveImages 包装器按设置目标实时缩放。 */
export const UPLOAD_ALLOW = {
  maxImageBytes: 268_435_456, // 256 MB（dsh-attachment-local 的 Config 无上限校验）
  maxImagePixels: 400_000_000, // 400 MP
  maxImageDimension: 16_384, // 16384px
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
  fiber?: { ctx?: AppContext; uid?: number }
}

type AppContext = Context & {
  settings: SettingsService
  loader: { entries(): LoaderEntry[] }
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

const NS = settingsNamespace('dsh-arb-bucket')
const TARGET_ID = 'attachment-local'
const PATCH_TAG = Symbol('dsh-arb-bucket.resize-layer')

// ─── ARB 桶缩放层 ───

interface AttachmentInput {
  data: Uint8Array
  mediaType: string
  name?: string
}

interface AttachmentStoreLike {
  imageLimits?: unknown
  saveImages(inputs: AttachmentInput[]): Promise<unknown[]>
}

/** sharp format → MIME（与 dsh-attachment-local/lib/types/image.js 的 MEDIA_TYPES 一致）。 */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function mediaTypeToFormat(mediaType: string): string | undefined {
  for (const [format, mime] of Object.entries(MEDIA_TYPES)) {
    if (mime === mediaType) return format
  }
  return undefined
}

function isAnimatedFormat(format: string | undefined): boolean {
  return format === 'gif' || format === 'webp'
}

interface ResizeDim {
  width: number
  height: number
}

/** 用 sharp 编码一张已处理（可能已缩放）的源图；可选在编码前继续缩小。 */
async function encodeImage(
  source: Uint8Array,
  inputFormat: string | undefined,
  format: string,
  animated: boolean,
  quality?: number,
  resize?: ResizeDim,
): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(source), {
    failOn: 'error',
    limitInputPixels: false,
    ...(animated ? { animated: true } : {}),
  }).rotate()
  if (resize) {
    const { width, height } = resize
    pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
  }
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality: quality ?? 88, mozjpeg: true }).toBuffer()
    case 'webp':
      return pipeline.webp({ quality: quality ?? 88, effort: 4 }).toBuffer()
    case 'png':
      return pipeline.png({ compressionLevel: 9 }).toBuffer()
    case 'gif':
      return pipeline.gif().toBuffer()
    default:
      return Buffer.from(source)
  }
}

/**
 * 字节超限时的“缩小 + 重编码”阶梯：先保尺寸降质量，再逐步缩小尺寸换 webp/jpeg。
 * 始终返回所有尝试中最小的候选；若最终仍超限，也保证尽可能最小（避免返回比原图更大）。
 */
async function fitByteLimit(
  source: Uint8Array,
  inputFormat: string | undefined,
  format: string,
  animated: boolean,
  byteLimit: number,
  width: number,
  height: number,
): Promise<{ data: Buffer; format: string }> {
  const ladder: Array<{ format: string; quality?: number }> = []
  if (format === 'jpeg') {
    for (const quality of [88, 78, 68, 55, 42, 30, 20]) ladder.push({ format: 'jpeg', quality })
    ladder.push({ format: 'webp', quality: 85 }, { format: 'webp', quality: 70 }, { format: 'webp', quality: 55 })
  } else if (format === 'webp') {
    for (const quality of [88, 76, 62, 48, 35, 22]) ladder.push({ format: 'webp', quality })
    ladder.push({ format: 'jpeg', quality: 80 }, { format: 'jpeg', quality: 60 }, { format: 'jpeg', quality: 40 })
  } else if (format === 'png') {
    ladder.push({ format: 'png' })
    for (const quality of [85, 70, 55, 40, 25]) ladder.push({ format: 'webp', quality })
    ladder.push({ format: 'jpeg', quality: 75 }, { format: 'jpeg', quality: 50 })
  } else {
    // gif：先原样 gif，再 webp（可保动画），最后 jpeg。
    ladder.push({ format: 'gif' })
    for (const quality of [80, 65, 50, 35]) ladder.push({ format: 'webp', quality })
    ladder.push({ format: 'jpeg', quality: 70 }, { format: 'jpeg', quality: 45 })
  }

  const factors = [1, 0.85, 0.7, 0.55, 0.42, 0.3, 0.2, 0.13]
  let smallest: { data: Buffer; format: string } | undefined
  for (const factor of factors) {
    const resize: ResizeDim = {
      width: Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
    }
    for (const attempt of ladder) {
      try {
        const useAnimated = animated && (attempt.format === 'gif' || attempt.format === 'webp')
        const data = await encodeImage(source, inputFormat, attempt.format, useAnimated, attempt.quality, resize)
        if (smallest === undefined || data.byteLength < smallest.data.byteLength) {
          smallest = { data, format: attempt.format }
        }
        if (data.byteLength <= byteLimit) return { data, format: attempt.format }
      } catch {
        // 尝试下一个尺寸/格式/质量组合
      }
    }
  }
  return smallest ?? { data: Buffer.from(source), format }
}

/**
 * ARB 桶核心：把一张输入图调整到限制之内最接近原尺寸的尺寸。
 * - 尺寸约束：maxImageDimension（单边）与 maxImagePixels（总像素）取更小 scale，保持纵横比；
 * - 字节约束：maxImageBytes，必要时缩小 + 重编码；
 * - 不放大（scale 上限 1）；解码失败/不支持格式时原样返回，交给官方校验给出明确 AttachmentError。
 */
export async function fitImage(input: AttachmentInput, limits: LimitsConfig): Promise<AttachmentInput> {
  const format = mediaTypeToFormat(input.mediaType)
  if (!format) return input
  const source = Buffer.from(input.data)
  if (source.byteLength === 0) return input
  try {
    const meta = await sharp(source, { failOn: 'error', limitInputPixels: false }).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width <= 0 || height <= 0) return input

    let scale = 1
    if (limits.maxImageDimension > 0) scale = Math.min(scale, limits.maxImageDimension / Math.max(width, height))
    if (limits.maxImagePixels > 0) scale = Math.min(scale, Math.sqrt(limits.maxImagePixels / (width * height)))
    if (scale >= 1 && source.byteLength <= limits.maxImageBytes) return input

    if (scale < 0.01) scale = 0.01
    const animated = isAnimatedFormat(format)
    let resizedSource: Uint8Array = source
    let outFormat = format
    let outWidth = width
    let outHeight = height

    if (scale < 1) {
      outWidth = Math.max(1, Math.round(width * scale))
      outHeight = Math.max(1, Math.round(height * scale))
      const pipeline = sharp(source, {
        failOn: 'error',
        limitInputPixels: false,
        ...(animated ? { animated: true } : {}),
      })
        .rotate()
        .resize(outWidth, outHeight, { fit: 'fill', kernel: 'lanczos3' })
      resizedSource = new Uint8Array(await pipeline.toBuffer())
    }

    const encoded = await encodeImage(resizedSource, format, outFormat, animated)
    if (encoded.byteLength > limits.maxImageBytes) {
      const fitted = await fitByteLimit(resizedSource, format, outFormat, animated, limits.maxImageBytes, outWidth, outHeight)
      return {
        data: new Uint8Array(fitted.data),
        mediaType: MEDIA_TYPES[fitted.format] ?? input.mediaType,
        name: input.name,
      }
    }
    return {
      data: new Uint8Array(encoded),
      mediaType: MEDIA_TYPES[outFormat] ?? input.mediaType,
      name: input.name,
    }
  } catch {
    // 交给官方 validateImage 处理，给出用户可读的 AttachmentError。
    return input
  }
}

// ─── loader / 设置桥 ───

/** 在 loader 树里找 dsh-attachment-local 的 entry（dsh-base patch 以 id: attachment-local 装配）。 */
function findAttachmentEntry(ctx: AppContext): LoaderEntry | undefined {
  try {
    return ctx.loader.entries().find((e) => e.options?.id === TARGET_ID || e.options?.name === '@deepseek-ai/dsh-attachment-local')
  } catch {
    return undefined
  }
}

/** 从 attachment-local 当前 fiber 取可用的 store 实例。 */
function findAttachmentStore(ctx: AppContext): AttachmentStoreLike | undefined {
  try {
    const entry = findAttachmentEntry(ctx)
    const store = entry?.fiber?.ctx?.attachments as AttachmentStoreLike | undefined
    return store && typeof store.saveImages === 'function' ? store : undefined
  } catch {
    return undefined
  }
}

/** 找到保存 saveImages 方法定义的 AttachmentStore.prototype。 */
function findSaveImagesPrototype(store: AttachmentStoreLike): object | undefined {
  let proto = Object.getPrototypeOf(store)
  while (proto && Object.getPrototypeOf(proto) !== null) {
    if (proto.constructor && proto.constructor.name === 'AttachmentStore') return proto
    proto = Object.getPrototypeOf(proto)
  }
  return proto
}

/** 把当前 store 实例的 imageLimits 放宽到 UPLOAD_ALLOW（客户端投影与服务端 admission 不拦大图）。
 *  真正的缓存缩放目标由设置（getLimits）决定，saveImages 包装器不依赖此字段。
 *  entry.update 重启 fiber 后新实例会从 UPLOAD_ALLOW config 自然获得放宽值，此函数只是兜底。 */
function relaxStoreImageLimits(store: AttachmentStoreLike): void {
  try {
    const current = (store.imageLimits ?? {}) as Record<string, unknown>
    Object.defineProperty(store, 'imageLimits', {
      value: Object.freeze({
        ...current,
        maxImageBytes: UPLOAD_ALLOW.maxImageBytes,
        maxImagePixels: UPLOAD_ALLOW.maxImagePixels,
        maxImageDimension: UPLOAD_ALLOW.maxImageDimension,
      }),
      configurable: true,
      writable: true,
      enumerable: true,
    })
  } catch {
    // 忽略：entry.update 重启 fiber 后新实例自然获得 UPLOAD_ALLOW 值
  }
}

/**
 * 挂载 ARB 桶缩放层。
 *
 * 注意：不能在 store 实例上直接覆盖 saveImages（实测实例字段赋值被忽略，
 * toString 仍为 native code）。正确攻击点是 AttachmentStore 类原型：
 * 覆盖原型上的 saveImages，所有子类实例（含 LocalAttachmentStore）自动继承。
 * 缩放目标由 getLimits()（=设置三项动态读取）决定：字节/像素/单边任一超限就
 * 等比缩到约束内最接近原尺寸再写缓存；已达标图片原样通过（fitImage 内 scale≥1
 * 且 byteLength≤限制时直接返回 input）。
 */
function patchStore(ctx: AppContext, store: AttachmentStoreLike, getLimits: () => LimitsConfig): void {
  const proto = findSaveImagesPrototype(store)
  if (!proto) return
  const original = (proto as { saveImages: unknown }).saveImages as
    | ((inputs: AttachmentInput[]) => Promise<unknown[]>)
    | undefined
  if (typeof original !== 'function') return
  if ((proto as unknown as Record<symbol, boolean>)[PATCH_TAG]) return
  Object.defineProperty(proto, PATCH_TAG, { value: true, configurable: false })
  ;(proto as { saveImages: unknown }).saveImages = function (this: AttachmentStoreLike, inputs: AttachmentInput[]): Promise<unknown[]> {
    // 缩放目标是设置三项（ARB 桶），不是 this.imageLimits（那是 UPLOAD_ALLOW 上传允许值）。
    const limits: LimitsConfig = getLimits()
    const resized: AttachmentInput[] = []
    const loop = async (): Promise<unknown[]> => {
      for (const input of inputs) {
        try {
          resized.push(await fitImage(input, limits))
        } catch (error) {
          ctx.logger.warn('[dsh-arb-bucket] image resize failed, keeping original: ' + String(error))
          resized.push(input)
        }
      }
      return original.call(this, resized)
    }
    return loop()
  }
  ctx.logger.info('[dsh-arb-bucket] resize layer attached to AttachmentStore prototype')
}

/** 把上传允许上限（UPLOAD_ALLOW）合并进 attachment-local 的 entry config（保留其 config 其余键）。 */
async function pushLimits(ctx: AppContext, limits: LimitsConfig, scopeTag: string): Promise<boolean> {
  const entry = findAttachmentEntry(ctx)
  if (!entry) {
    ctx.logger.warn('[dsh-arb-bucket] loader entry "' + TARGET_ID + '" not found; limits not applied (' + scopeTag + ')')
    return false
  }
  const merged = { ...(entry.options?.config ?? {}), ...limits }
  await entry.update({ config: merged })
  ctx.logger.info(
    '[dsh-arb-bucket] upload-allow limits ensured (' + scopeTag + '): ' +
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

  const ensureLayer = (): void => {
    try {
      const store = findAttachmentStore(ctx)
      if (store) {
        patchStore(ctx, store, current)
        relaxStoreImageLimits(store)
      }
    } catch (error) {
      ctx.logger.warn('[dsh-arb-bucket] ensure resize layer failed: ' + String(error))
    }
  }

  const push = (tag: string): Promise<boolean> =>
    pushLimits(ctx, UPLOAD_ALLOW, tag)
      .catch((e) => {
        ctx.logger.warn('[dsh-arb-bucket] ' + tag + ' push failed: ' + String(e))
        return false
      })
      .finally(() => ensureLayer())

  // 启动即推送一次上传允许上限到 attachment-local（fiber 重启后 imageLimits=UPLOAD_ALLOW，客户端不再拦 3.5MB~256MB），并挂载缩放层。
  void push('boot')
  // 设置变更：config 保持 UPLOAD_ALLOW 不变（不重启 fiber），saveImages 包装器实时读取 scope.get() 新缩放目标。
  scope.watch(() => {
    void push('watch')
  })

  // 周期心跳：attachment-local fiber 若在启动后期/其它入口重建，store 实例变了也要重新挂载。
  ensureLayer()
  const timer = setInterval(ensureLayer, 3000)
  const appCtx = ctx as unknown as { on?: (event: string, fn: () => void) => unknown }
  if (typeof appCtx.on === 'function') appCtx.on('dispose', () => clearInterval(timer))

  ctx.logger.info('[dsh-arb-bucket] ready（设置 → 设置菜单 → ARB 桶；大图自动缩放后进入会话缓存）')
}