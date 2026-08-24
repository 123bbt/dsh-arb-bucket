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
export declare function apply(ctx: AppContext, config: LimitsConfig): void;
export {};
