/**
 * @dsh-external/dsh-arb-bucket — client 侧：设置菜单 "ARB 桶" 分区。
 *
 * 模式（对齐官方 dsh-prompt-custom）：
 *  - inject ['slots', 'settingsScope'] → settingsScope.bind({ namespace }) →
 *    ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, inject }, Card))。
 *  - 组件内 scope.set(field, value) 写设置 → host scope.watch → entry.update 热生效。
 *
 * 构建约定：产物 lib/client.js 为 ModuleLoader CJS 包裹（见 tsdown.config.ts）。
 * 运行时依赖（react / 快照选择器宿主包）由客户端模块注册表解析，故此处
 * 使用运行时 require 而非静态 import（编译期零外部类型依赖）。
 */
declare const require: (id: string) => any

const react = require('react')

// bindSnapshotSelector 三级回落（对齐 dsh-conversation-tweaks 等社区插件，issue #124）：
//   1) dsh-client-ui-renderer.useSyncExternalStoreWithSelector —— rc.8 内核真实导出时
//   2) dsh-client-web-react.bindSnapshotSelector —— rc.7 官方包（client-compat 注入页面模块表）
//   3) react 原生 useSyncExternalStore 兜底 —— 宿主源快照引用稳定，selector 每渲染求值
let bindSnapshotSelector: (source: any) => (selector: any, isEqual?: any) => any = undefined as any
try {
  const rendererMod: any = require('@deepseek-ai/dsh-client-ui-renderer')
  if (typeof rendererMod.useSyncExternalStoreWithSelector === 'function') {
    const useSESWS = rendererMod.useSyncExternalStoreWithSelector
    bindSnapshotSelector = (source) => {
      const subscribe = (fn: any) => source.subscribe(fn)
      const getSnapshot = () => source.getSnapshot()
      return (selector: any, isEqual: any) => useSESWS(subscribe, getSnapshot, void 0, selector, isEqual)
    }
  }
} catch { /* 模块不在页面表（rc.7 及更早内核）→ 走下一级回落 */ }
if (!bindSnapshotSelector) {
  try {
    const webReactMod: any = require('@deepseek-ai/dsh-client-web-react')
    if (typeof webReactMod.bindSnapshotSelector === 'function') bindSnapshotSelector = webReactMod.bindSnapshotSelector
  } catch { /* compat 未注入（罕见）→ react 原生兜底 */ }
}
if (!bindSnapshotSelector) {
  const { useSyncExternalStore } = react
  bindSnapshotSelector = (source) => {
    const subscribe = (fn: any) => source.subscribe(fn)
    const getSnapshot = () => source.getSnapshot()
    return (selector: any) => selector(useSyncExternalStore(subscribe, getSnapshot))
  }
}

const NS = 'dsh-arb-bucket'
const PLUGIN_ID = '@dsh-external/dsh-arb-bucket'

/** 与 host 侧 ATTACHMENT_DEFAULTS 保持一致。 */
const DEFAULTS = { maxImageBytes: 3670016, maxImagePixels: 40000000, maxImageDimension: 2000 }

const L = {
  nav: 'ARB 桶 · 图片上限',
  title: '图片附件上限',
  desc: '调整会话图片附件的三项运行时上限（保存后立即生效，无需重启）。调大单图字节上限会增加每次请求体积（base64 约 ×4/3），请按需设置。',
  saved: '已保存并生效',
  saving: '保存中…',
  error: '保存失败',
  reset: '恢复默认',
  bytesLabel: '单张图片大小上限',
  bytesUnit: 'MB',
  pixelsLabel: '单张图片像素上限',
  pixelsUnit: '百万像素',
  dimLabel: '单边尺寸上限',
  dimUnit: 'px',
  invalid: '数值超出允许范围',
}

const MB = 1024 * 1024
const MP = 1_000_000

function rowStyle(): any {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
  }
}

function textFieldStyle(): any {
  return {
    width: '110px',
    padding: '6px 10px',
    fontSize: '14px',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
    borderRadius: '8px',
  }
}

/** 数字输入行：UI 展示单位（MB / 百万像素），存储原始值（bytes / pixels）。 */
function NumberRow(props: any): any {
  const { label, unit, value, displayValue, min, max, step, onCommit } = props
  const [text, setText] = react.useState(String(displayValue))
  const [dirty, setDirty] = react.useState(false)
  // 外部值变化（如恢复默认）且本地未编辑时跟随
  react.useEffect(() => {
    if (!dirty) setText(String(displayValue))
  }, [displayValue, dirty])
  const commit = () => {
    setDirty(false)
    const n = Number(text)
    if (!Number.isFinite(n) || n < min || n > max) {
      setText(String(displayValue))
      return
    }
    if (n !== displayValue) onCommit(n)
  }
  return react.createElement(
    'div',
    { style: rowStyle() },
    react.createElement(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      react.createElement('div', { style: { fontSize: '14px', lineHeight: '22px' } }, label),
      react.createElement(
        'div',
        { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, gray)', marginTop: '2px' } },
        '允许范围 ' + min + ' – ' + max + ' ' + unit,
      ),
    ),
    react.createElement('input', {
      type: 'number',
      value: text,
      min,
      max,
      step,
      style: textFieldStyle(),
      onChange: (e: any) => {
        setDirty(true)
        setText(e.target.value)
      },
      onBlur: commit,
      onKeyDown: (e: any) => {
        if (e.key === 'Enter') (e.target as any).blur()
      },
    }),
    react.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, gray)', width: '52px' } }, unit),
  )
}

function ArbBucketCard(props: any): any {
  const { useScope, scope } = props
  const snap = useScope((s: any) => s)
  const [status, setStatus] = react.useState('')
  // SettingsScopeController snapshot 是包装对象 { status, value, ... }，解码值在 snap.value（官方 dsh-prompt-custom 同款）。
  const readyValue = snap && snap.status === 'ready' && snap.value ? snap.value : {}

  const value = {
    maxImageBytes: Number(readyValue.maxImageBytes ?? DEFAULTS.maxImageBytes),
    maxImagePixels: Number(readyValue.maxImagePixels ?? DEFAULTS.maxImagePixels),
    maxImageDimension: Number(readyValue.maxImageDimension ?? DEFAULTS.maxImageDimension),
  }

  const setField = async (field: string, raw: number) => {
    setStatus('saving')
    try {
      await scope.set(field, raw)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
    setTimeout(() => setStatus(''), 2500)
  }

  const resetAll = async () => {
    setStatus('saving')
    try {
      await scope.set('maxImageBytes', DEFAULTS.maxImageBytes)
      await scope.set('maxImagePixels', DEFAULTS.maxImagePixels)
      await scope.set('maxImageDimension', DEFAULTS.maxImageDimension)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
    setTimeout(() => setStatus(''), 2500)
  }

  const statusText = status === 'saving' ? L.saving : status === 'saved' ? L.saved : status === 'error' ? L.error : ''
  const statusColor = status === 'error' ? 'var(--dsw-alias-label-danger, #e5484d)' : 'var(--dsw-alias-label-tertiary, gray)'

  return react.createElement(
    'div',
    { style: { padding: '4px 2px 24px', maxWidth: '640px' } },
    react.createElement('h2', { style: { fontSize: '16px', fontWeight: 500, margin: '8px 0 4px' } }, L.title),
    react.createElement(
      'p',
      { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, gray)', lineHeight: '18px', margin: '0 0 8px' } },
      L.desc,
    ),
    react.createElement(NumberRow, {
      label: L.bytesLabel,
      unit: L.bytesUnit,
      value: value.maxImageBytes,
      displayValue: Math.round((value.maxImageBytes / MB) * 100) / 100,
      min: 0.01,
      max: 256,
      step: 0.5,
      onCommit: (mb: number) => void setField('maxImageBytes', Math.max(1024, Math.round(mb * MB))),
    }),
    react.createElement(NumberRow, {
      label: L.pixelsLabel,
      unit: L.pixelsUnit,
      value: value.maxImagePixels,
      displayValue: Math.round((value.maxImagePixels / MP) * 100) / 100,
      min: 0.1,
      max: 400,
      step: 1,
      onCommit: (mp: number) => void setField('maxImagePixels', Math.max(100_000, Math.round(mp * MP))),
    }),
    react.createElement(NumberRow, {
      label: L.dimLabel,
      unit: L.dimUnit,
      value: value.maxImageDimension,
      displayValue: value.maxImageDimension,
      min: 256,
      max: 16384,
      step: 100,
      onCommit: (px: number) => void setField('maxImageDimension', Math.round(px)),
    }),
    react.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0 0' } },
      react.createElement(
        'button',
        {
          type: 'button',
          onClick: () => void resetAll(),
          style: {
            cursor: 'pointer',
            padding: '6px 14px',
            fontSize: '13px',
            color: 'var(--dsw-alias-label-primary, inherit)',
            background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.15))',
            border: 'none',
            borderRadius: '8px',
          },
        },
        L.reset,
      ),
      statusText
        ? react.createElement('span', { style: { fontSize: '12px', color: statusColor } }, statusText)
        : null,
    ),
  )
}

type ClientContext = {
  slots: { inject(slot: string, factory: () => any, tag?: string): void; register(options: any, component: any): any }
  settingsScope: { bind(spec: { namespace: string }): any }
}

export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind({ namespace: NS })
  const useScope = bindSnapshotSelector(scope)
  const injected = () => ({ useScope, scope })
  ctx.slots.inject(
    'settings.section',
    () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: PLUGIN_ID,
          order: 65,
          label: () => L.nav,
          inject: injected,
        },
        ArbBucketCard,
      ),
    PLUGIN_ID + ': settings section entry',
  )
}