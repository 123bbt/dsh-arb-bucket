# @dsh-external/dsh-arb-bucket

以ARB桶为灵感的插件，旨在于GUI提供图片尺寸墙的修改接口，并且使输入图片自适应尺寸墙。

ARB 桶（ARB bucket）：在 DSH 设置菜单里直接调节「图片附件上限」三项配置，并把新上限热生效到
官方 `@deepseek-ai/dsh-attachment-local` 插件（不修改任何官方包文件）。

核心行为：**输入图片会自动适配到尺寸约束之下最接近的缩放尺寸再进入会话缓存**。
超过 `maxImageDimension`（单边）或 `maxImagePixels`（总像素）的图片会被等比缩放到约束内
最大尺寸；超过 `maxImageBytes` 的图片会逐级降质量/换格式，必要时再缩小，
最终写入附件缓存的是缩放/重编码后的小图（content-addressed sha256，ref 指向小图）。

| 配置项 | 含义 | 默认值 | 可调范围 |
| --- | --- | --- | --- |
| `maxImageBytes` | 单张图片字节上限 | 3.5 MB = 3_670_016 bytes | 1 KB … 256 MB |
| `maxImagePixels` | 单张图片解码总像素上限 | 40_000_000 px（40 MP） | 100_000 … 400_000_000 |
| `maxImageDimension` | 单边尺寸上限 | 2_000 px | 256 … 16_384 px |

## 安装

```bash
dsh plugin --profile web add git+https://github.com/123bbt/dsh-arb-bucket
```

启用后打开 **设置 → ARB 桶 · 图片上限**，三个输入框保存即热生效：
底层会把值合并进 loader entry `attachment-local` 的 `config`，触发 cordis fiber 热重启，
`ctx.attachments.imageLimits` 单一配置源随之更新，UI 预检与附件存储校验全链路生效。

## 副作用与边界

- 客户端上传前仍会按 `imageLimits.maxImageBytes` 做字节预检（`dsh-client-ui-conversation`）。想放行更大的原始上传，先把 `maxImageBytes` 调到足够大；ARB 桶随后在服务端把超尺寸/超字节的图缩放、重编码成小缓存。
- `maxImagePixels` / `maxImageDimension` 现在由 ARB 桶自动适配：超限图不会报错，而是等比缩放到约束内最接近的尺寸再入库（`IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE` 仍作为解码失败/无法处理时的兜底）。
- `maxImageBytes` 作为缓存字节目标：超过上限时先保尺寸降质量/换格式，仍超则逐步缩小，尽量产出不超过字节上限且尺寸损失最小的图片。
- DSH 仍有额外限制不在本插件范围内：`maxImagesPerMessage = 20`、`maxMessageImageBytes = 104_857_600`。
- 调大后重启 DSH 不会丢设置：值保存在 `dsh-arb-bucket` 设置命名空间，启动时自动推送一次。

## 开发

```bash
# 构建宿主端（自动链接 DSH app node_modules 里的 @deepseek-ai/* 依赖）
& "C:\Program Files\Git\bin\bash.exe" ./scripts/build.sh

# 构建客户端（tsdown）
npm run build:client
```

产物提交在 `lib/`（git 安装无需本地构建）。宿主端声明了 `sharp` 运行时依赖（与官方 `dsh-attachment-local` 同一版本 ^0.35.3），peerDependencies 仍为 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`。
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`。

## 兼容性

客户端快照选择器采用三级回落：

1. `@deepseek-ai/dsh-client-ui-renderer`（rc.8+）的 `useSyncExternalStoreWithSelector`
2. `@deepseek-ai/dsh-client-web-react.bindSnapshotSelector`（rc.7 官方包）
3. React 原生 `useSyncExternalStore` 兜底

因此即使当前内核的客户端模块表不提供 `dsh-client-web-react`（报
`require(...) missed the module table`），设置菜单入口仍可正常注册、展示与保存。
