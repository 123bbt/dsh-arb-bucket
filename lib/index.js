import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
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
/** 在 loader 树里找 dsh-attachment-local 的 entry（dsh-base patch 以 id: attachment-local 装配）。 */
function findAttachmentEntry(ctx) {
    try {
        return ctx.loader.entries().find((e) => e.options?.id === TARGET_ID || e.options?.name === '@deepseek-ai/dsh-attachment-local');
    }
    catch {
        return undefined;
    }
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
    // 启动即推送一次（重启 DSH 后由持久化的设置文档恢复用户自定义值）。
    void pushLimits(ctx, current(), 'boot').catch((e) => ctx.logger.warn('[dsh-arb-bucket] boot push failed: ' + String(e)));
    // 设置变更 → 热生效（entry.update → cordis diff → fiber 重启 → 新 imageLimits）。
    scope.watch(() => {
        void pushLimits(ctx, current(), 'watch').catch((e) => ctx.logger.warn('[dsh-arb-bucket] watch push failed: ' + String(e)));
    });
    ctx.logger.info('[dsh-arb-bucket] ready（设置 → 设置菜单 → ARB 桶）');
}
//# sourceMappingURL=index.js.map