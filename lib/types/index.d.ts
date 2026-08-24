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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "@dsh-external/dsh-arb-bucket";
/** dsh-settings 服务由 dsh-base bundle 装配；ctx.loader.entries() 需显式注入 'loader'。 */
export declare const inject: string[];
/** attachment-local 0.1.x 的官方默认值（与代码内 default 保持一致）。 */
export declare const ATTACHMENT_DEFAULTS: {
    readonly maxImageBytes: 3670016;
    readonly maxImagePixels: 40000000;
    readonly maxImageDimension: 2000;
};
/** 上传允许上限：写入 attachment-local 的 imageLimits / entry config，让客户端预检与
 *  服务端 admission 不拦截大图（默认 3.5MB~256MB 都放行）；真正的缓存尺寸/字节目标
 *  由设置三项（ARB 桶）决定，saveImages 包装器按设置目标实时缩放。 */
export declare const UPLOAD_ALLOW: {
    readonly maxImageBytes: 268435456;
    readonly maxImagePixels: 400000000;
    readonly maxImageDimension: 16384;
};
export interface LimitsConfig {
    maxImageBytes: number;
    maxImagePixels: number;
    maxImageDimension: number;
}
export declare const Config: any;
interface SettingsScope {
    get(): LimitsConfig;
    watch(fn: () => void): void;
}
interface SettingsService {
    register(ns: string, schema: unknown, opts?: {
        base?: unknown;
    }): SettingsScope;
}
interface LoaderEntry {
    options?: {
        id?: string;
        name?: string;
        config?: Record<string, unknown>;
    };
    update(options: Record<string, unknown>): Promise<void>;
    fiber?: {
        ctx?: AppContext;
        uid?: number;
    };
}
type AppContext = Context & {
    settings: SettingsService;
    loader: {
        entries(): LoaderEntry[];
    };
    logger: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
};
interface AttachmentInput {
    data: Uint8Array;
    mediaType: string;
    name?: string;
}
/**
 * ARB 桶核心：把一张输入图调整到限制之内最接近原尺寸的尺寸。
 * - 尺寸约束：maxImageDimension（单边）与 maxImagePixels（总像素）取更小 scale，保持纵横比；
 * - 字节约束：maxImageBytes，必要时缩小 + 重编码；
 * - 不放大（scale 上限 1）；解码失败/不支持格式时原样返回，交给官方校验给出明确 AttachmentError。
 */
export declare function fitImage(input: AttachmentInput, limits: LimitsConfig): Promise<AttachmentInput>;
export declare function apply(ctx: AppContext, config: LimitsConfig): void;
export {};
