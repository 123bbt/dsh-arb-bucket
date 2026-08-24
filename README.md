# @dsh-external/dsh-arb-bucket

以ARB桶为灵感的插件，旨在于GUI提供图片尺寸墙的修改接口，并且使输入图片自适应尺寸墙
ARB 桶（ARB bucket）：在 DSH 设置菜单里直接调节「图片附件上限」三项配置，并把新上限热生效到
官方 `@deepseek-ai/dsh-attachment-local` 插件（不修改任何官方包文件）。

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

- 调大 `maxImageBytes` 会让 base64 请求体膨胀约 ×4/3，多图并发容易撞上游 413；请按实际网络/服务端承载量调整。
- `maxImagePixels` 与 `maxImageDimension` 由 `dsh-attachment-local` 在解码阶段独立拦截（`IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE`）。
- DSH 仍有额外限制不在本插件范围内：`maxImagesPerMessage = 20`、`maxMessageImageBytes = 104_857_600`。
- 调大后重启 DSH 不会丢设置：值保存在 `dsh-arb-bucket` 设置命名空间，启动时自动推送一次。

## 开发

```bash
# 构建宿主端（自动链接 DSH app node_modules 里的 @deepseek-ai/* 依赖）
& "C:\Program Files\Git\bin\bash.exe" ./scripts/build.sh

# 构建客户端（tsdown）
npm run build:client
```

产物提交在 `lib/`（git 安装无需本地构建）。插件仅声明 peerDependencies：
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`。
