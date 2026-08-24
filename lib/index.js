import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import sharp from 'sharp';
export const name = '@dsh-external/dsh-arb-bucket';
/** dsh-settings 服务由 dsh-base bundle 装配；ctx.loader.entries() 需显式注入 'loader'。 */
export const inject = ['settings', 'loader'];
/** attachment-local 0.1.x 的官方默认值（与代码内 default 保持一致）。 */
export const ATTACHMENT_DEFAULTS = {
    maxImageBytes: 3_670_016, // 3.5 MB
    maxImagePixels: 40_000_000, // 4000 万像素
    maxImageDimension: 2_000, // 单边 2000px
};
/** 三项的安全边界：防止误设导致请求体爆炸（bytes ≤ 256MB）或无意义极小值。 */
const BOUNDS = {
    maxImageBytes: { min: 1024, max: 268_435_456 }, // 1KB .. 256MB
    maxImagePixels: { min: 100_000, max: 400_000_000 }, // 0.1MP .. 400MP
    maxImageDimension: { min: 256, max: 16_384 }, // 256px .. 16384px
};
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
});
const NS = settingsNamespace('dsh-arb-bucket');
const TARGET_ID = 'attachment-local';
const PATCH_TAG = Symbol('dsh-arb-bucket.resize-layer');
/** sharp format → MIME（与 dsh-attachment-local/lib/types/image.js 的 MEDIA_TYPES 一致）。 */
const MEDIA_TYPES = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};
function mediaTypeToFormat(mediaType) {
    for (const [format, mime] of Object.entries(MEDIA_TYPES)) {
        if (mime === mediaType)
            return format;
    }
    return undefined;
}
function isAnimatedFormat(format) {
    return format === 'gif' || format === 'webp';
}
/** 用 sharp 编码一张已处理（可能已缩放）的源图；可选在编码前继续缩小。 */
async function encodeImage(source, inputFormat, format, animated, quality, resize) {
    let pipeline = sharp(Buffer.from(source), {
        failOn: 'error',
        limitInputPixels: false,
        ...(animated ? { animated: true } : {}),
    }).rotate();
    if (resize) {
        const { width, height } = resize;
        pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
    }
    switch (format) {
        case 'jpeg':
            return pipeline.jpeg({ quality: quality ?? 88, mozjpeg: true }).toBuffer();
        case 'webp':
            return pipeline.webp({ quality: quality ?? 88, effort: 4 }).toBuffer();
        case 'png':
            return pipeline.png({ compressionLevel: 9 }).toBuffer();
        case 'gif':
            return pipeline.gif().toBuffer();
        default:
            return Buffer.from(source);
    }
}
/**
 * 字节超限时的“缩小 + 重编码”阶梯：先保尺寸降质量，再逐步缩小尺寸换 webp/jpeg。
 * 始终返回所有尝试中最小的候选；若最终仍超限，也保证尽可能最小（避免返回比原图更大）。
 */
async function fitByteLimit(source, inputFormat, format, animated, byteLimit, width, height) {
    const ladder = [];
    if (format === 'jpeg') {
        for (const quality of [88, 78, 68, 55, 42, 30, 20])
            ladder.push({ format: 'jpeg', quality });
        ladder.push({ format: 'webp', quality: 85 }, { format: 'webp', quality: 70 }, { format: 'webp', quality: 55 });
    }
    else if (format === 'webp') {
        for (const quality of [88, 76, 62, 48, 35, 22])
            ladder.push({ format: 'webp', quality });
        ladder.push({ format: 'jpeg', quality: 80 }, { format: 'jpeg', quality: 60 }, { format: 'jpeg', quality: 40 });
    }
    else if (format === 'png') {
        ladder.push({ format: 'png' });
        for (const quality of [85, 70, 55, 40, 25])
            ladder.push({ format: 'webp', quality });
        ladder.push({ format: 'jpeg', quality: 75 }, { format: 'jpeg', quality: 50 });
    }
    else {
        // gif：先原样 gif，再 webp（可保动画），最后 jpeg。
        ladder.push({ format: 'gif' });
        for (const quality of [80, 65, 50, 35])
            ladder.push({ format: 'webp', quality });
        ladder.push({ format: 'jpeg', quality: 70 }, { format: 'jpeg', quality: 45 });
    }
    const factors = [1, 0.85, 0.7, 0.55, 0.42, 0.3, 0.2, 0.13];
    let smallest;
    for (const factor of factors) {
        const resize = {
            width: Math.max(1, Math.round(width * factor)),
            height: Math.max(1, Math.round(height * factor)),
        };
        for (const attempt of ladder) {
            try {
                const useAnimated = animated && (attempt.format === 'gif' || attempt.format === 'webp');
                const data = await encodeImage(source, inputFormat, attempt.format, useAnimated, attempt.quality, resize);
                if (smallest === undefined || data.byteLength < smallest.data.byteLength) {
                    smallest = { data, format: attempt.format };
                }
                if (data.byteLength <= byteLimit)
                    return { data, format: attempt.format };
            }
            catch {
                // 尝试下一个尺寸/格式/质量组合
            }
        }
    }
    return smallest ?? { data: Buffer.from(source), format };
}
/**
 * ARB 桶核心：把一张输入图调整到限制之内最接近原尺寸的尺寸。
 * - 尺寸约束：maxImageDimension（单边）与 maxImagePixels（总像素）取更小 scale，保持纵横比；
 * - 字节约束：maxImageBytes，必要时缩小 + 重编码；
 * - 不放大（scale 上限 1）；解码失败/不支持格式时原样返回，交给官方校验给出明确 AttachmentError。
 */
export async function fitImage(input, limits) {
    const format = mediaTypeToFormat(input.mediaType);
    if (!format)
        return input;
    const source = Buffer.from(input.data);
    if (source.byteLength === 0)
        return input;
    try {
        const meta = await sharp(source, { failOn: 'error', limitInputPixels: false }).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        if (width <= 0 || height <= 0)
            return input;
        let scale = 1;
        if (limits.maxImageDimension > 0)
            scale = Math.min(scale, limits.maxImageDimension / Math.max(width, height));
        if (limits.maxImagePixels > 0)
            scale = Math.min(scale, Math.sqrt(limits.maxImagePixels / (width * height)));
        if (scale >= 1 && source.byteLength <= limits.maxImageBytes)
            return input;
        if (scale < 0.01)
            scale = 0.01;
        const animated = isAnimatedFormat(format);
        let resizedSource = source;
        let outFormat = format;
        let outWidth = width;
        let outHeight = height;
        if (scale < 1) {
            outWidth = Math.max(1, Math.round(width * scale));
            outHeight = Math.max(1, Math.round(height * scale));
            const pipeline = sharp(source, {
                failOn: 'error',
                limitInputPixels: false,
                ...(animated ? { animated: true } : {}),
            })
                .rotate()
                .resize(outWidth, outHeight, { fit: 'fill', kernel: 'lanczos3' });
            resizedSource = new Uint8Array(await pipeline.toBuffer());
        }
        const encoded = await encodeImage(resizedSource, format, outFormat, animated);
        if (encoded.byteLength > limits.maxImageBytes) {
            const fitted = await fitByteLimit(resizedSource, format, outFormat, animated, limits.maxImageBytes, outWidth, outHeight);
            return {
                data: new Uint8Array(fitted.data),
                mediaType: MEDIA_TYPES[fitted.format] ?? input.mediaType,
                name: input.name,
            };
        }
        return {
            data: new Uint8Array(encoded),
            mediaType: MEDIA_TYPES[outFormat] ?? input.mediaType,
            name: input.name,
        };
    }
    catch {
        // 交给官方 validateImage 处理，给出用户可读的 AttachmentError。
        return input;
    }
}
// ─── loader / 设置桥 ───
/** 在 loader 树里找 dsh-attachment-local 的 entry（dsh-base patch 以 id: attachment-local 装配）。 */
function findAttachmentEntry(ctx) {
    try {
        return ctx.loader.entries().find((e) => e.options?.id === TARGET_ID || e.options?.name === '@deepseek-ai/dsh-attachment-local');
    }
    catch {
        return undefined;
    }
}
/** 从 attachment-local 当前 fiber 取可用的 store 实例。 */
function findAttachmentStore(ctx) {
    try {
        const entry = findAttachmentEntry(ctx);
        const store = entry?.fiber?.ctx?.attachments;
        return store && typeof store.saveImages === 'function' ? store : undefined;
    }
    catch {
        return undefined;
    }
}
/** 幂等地给 store 实例挂载缩放层。fiber 重启后新实例需要重新挂载。 */
function patchStore(ctx, store, getLimits) {
    if (store[PATCH_TAG])
        return;
    const original = store.saveImages.bind(store);
    Object.defineProperty(store, PATCH_TAG, { value: true, configurable: false });
    store.saveImages = async (inputs) => {
        const limits = getLimits();
        const resized = [];
        for (const input of inputs) {
            try {
                resized.push(await fitImage(input, limits));
            }
            catch (error) {
                ctx.logger.warn('[dsh-arb-bucket] image resize failed, keeping original: ' + String(error));
                resized.push(input);
            }
        }
        return original(resized);
    };
    ctx.logger.info('[dsh-arb-bucket] resize layer attached to attachment store');
}
/** 把三项上限合并进 attachment-local 的 entry config（保留其 config 其余键）。 */
async function pushLimits(ctx, limits, scopeTag) {
    const entry = findAttachmentEntry(ctx);
    if (!entry) {
        ctx.logger.warn('[dsh-arb-bucket] loader entry "' + TARGET_ID + '" not found; limits not applied (' + scopeTag + ')');
        return false;
    }
    const merged = { ...(entry.options?.config ?? {}), ...limits };
    await entry.update({ config: merged });
    ctx.logger.info('[dsh-arb-bucket] limits applied (' + scopeTag + '): ' +
        'maxImageBytes=' + limits.maxImageBytes + ' maxImagePixels=' + limits.maxImagePixels + ' maxImageDimension=' + limits.maxImageDimension);
    return true;
}
export function apply(ctx, config) {
    // 设置命名空间注册：存储的非法配置节不能拖垮本插件 fiber（fail-soft，回退组合配置）。
    let scope;
    try {
        scope = ctx.settings.register(NS, Config, { base: config ?? {} });
    }
    catch (error) {
        ctx.logger.warn('[dsh-arb-bucket] settings register failed; falling back to composition config: ' + String(error));
        return;
    }
    const current = () => {
        const s = scope.get();
        return {
            maxImageBytes: s.maxImageBytes ?? ATTACHMENT_DEFAULTS.maxImageBytes,
            maxImagePixels: s.maxImagePixels ?? ATTACHMENT_DEFAULTS.maxImagePixels,
            maxImageDimension: s.maxImageDimension ?? ATTACHMENT_DEFAULTS.maxImageDimension,
        };
    };
    const ensureLayer = () => {
        try {
            const store = findAttachmentStore(ctx);
            if (store)
                patchStore(ctx, store, current);
        }
        catch (error) {
            ctx.logger.warn('[dsh-arb-bucket] ensure resize layer failed: ' + String(error));
        }
    };
    const push = (tag) => pushLimits(ctx, current(), tag)
        .catch((e) => {
        ctx.logger.warn('[dsh-arb-bucket] ' + tag + ' push failed: ' + String(e));
        return false;
    })
        .finally(() => ensureLayer());
    // 启动即推送一次（重启 DSH 后由持久化的设置文档恢复用户自定义值），并尝试挂载缩放层。
    void push('boot');
    // 设置变更 → 热生效（entry.update → cordis diff → fiber 重启 → 新 imageLimits + 重新挂载缩放层）。
    scope.watch(() => {
        void push('watch');
    });
    // 周期心跳：attachment-local fiber 若在启动后期/其它入口重建，store 实例变了也要重新挂载。
    ensureLayer();
    const timer = setInterval(ensureLayer, 3000);
    const appCtx = ctx;
    if (typeof appCtx.on === 'function')
        appCtx.on('dispose', () => clearInterval(timer));
    ctx.logger.info('[dsh-arb-bucket] ready（设置 → 设置菜单 → ARB 桶；大图自动缩放后进入会话缓存）');
}
//# sourceMappingURL=index.js.map