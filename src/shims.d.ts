/**
 * 宿主包类型垫片（app 内置包的 .d.ts 布局对 tsc 不可解析）。
 * 仅用于本插件编译；运行时由 DSH 宿主 node_modules 提供真实实现。
 */
declare module '@deepseek-ai/cordis' {
  export interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(value: string): string
}
declare module 'sharp' {
  const sharp: any
  export default sharp
}
