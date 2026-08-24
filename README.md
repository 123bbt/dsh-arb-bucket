# @dsh-external/dsh-arb-bucket

以ARB桶为灵感的插件，旨在于GUI提供图片尺寸墙的修改接口，并且使输入图片自适应尺寸墙。

ARB 桶（ARB bucket）：在 DSH 设置菜单里直接调节「图片缓存尺寸约束」三项配置。设置菜单的三项数值是**缓存缩放目标**，不是上传拦截线；底层会把上传允许上限 UPLOAD_ALLOW（256 MB / 400 MP / 16384 px）推送给官方 `@deepseek-ai/dsh-attachment-local`，让大图不被客户端预检与服务端 admission 拦截（不覆盖任何官方包文件）。

核心行为：**输入图片会自动缩放到尺寸约束之内最接近的缩放尺寸再进入会话缓存**。超过 `maxImageDimension`（单边）或 `maxImagePixels`（总像素）的图片会被等比缩放到约束内最大尺寸；超过 `maxImageBytes` 的图片会逐级降质量/换格式，必要时再缩小，最终写入的缓存是缩放/重编码后的小图（content-addressed sha256，ref 指向小图）。这样既能输入超过 3.5 MB 的大图，又不让会话缓存/请求体膨胀。

| 配置项 | 含义 | 默认值 | 可调范围 |
| --- | --- | --- | --- |
| `maxImageBytes` | 缓存字节目标 | 3.5 MB = 3_670_016 bytes | 1 KB … 256 MB |
| `maxImagePixels` | 缓存总像素目标 | 40_000_000 px（40 MP） | 100_000 … 400_000_000 |
| `maxImageDimension` | 缓存单边尺寸目标 | 2_000 px | 256 … 16_384 px |

## 安装

```bash
dsh plugin --profile web add git+https://github.com/123bbt/dsh-arb-bucket
```

## 使用

启用后打开 **设置 → ARB 桶 · 图片上限**，三项输入框保存即热生效：saveImages 包装器实时读取设置值，把超限图片等比缩放/重编码成目标尺寸与字节后写入附件缓存；`attachment-local` 的 `imageLimits` 固定为上传允许上限 UPLOAD_ALLOW（256 MB / 400 MP / 16384 px），因此客户端预检不会拦 3.5 MB~256 MB 的原始上传。

**客户端需先刷新页面或重开会话**，`imageLimits` 投影更新后即可上传大图。

## 副作用与边界

- 上传端 `imageLimits.maxImageBytes` 现为 UPLOAD_ALLOW = 256 MB，`dsh-client-ui-conversation` 字节预检放行 3.5 MB~256 MB 的图片。
- 设置三项是缓存缩放/重编码目标：超限图自动等比缩放到约束内最接近原尺寸（不放大，scale 上限 1）；总字节超限则降质量/换格式，必要时再缩小，始终产出尽可能接近设置目标的小图。
- 三项都只影响缓存；想放多大就调多大，修改即时生效（无需重启）。重启 DSH 也不丢设置：值存于 `dsh-arb-bucket` 命名空间，启动时自动把 UPLOAD_ALLOW 推给 attachment-local 并挂载缩放层。
- DSH 仍有与本插件无关的额外限制：`maxImagesPerMessage = 20`、`maxMessageImageBytes = 104_857_600`。

## 开发

```bash
# 构建宿主端（自动链接 DSH app node_modules 里的 @deepseek-ai/* 依赖）
& "C:\Program Files\Git\bin\bash.exe" ./scripts/build.sh

# 构建客户端（tsdown）
npm run build:client
```

产物提交在 `lib/`（git 安装无需本地构建）。宿主端声明 `sharp` 运行时依赖（与官方 `dsh-attachment-local` 同一版本 ^0.35.3），peerDependencies 为 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`。

## 兼容性

客户端快照选择器采用三级回落：

1. `@deepseek-ai/dsh-client-ui-renderer`（rc.8+）的 `useSyncExternalStoreWithSelector`
2. `@deepseek-ai/dsh-client-web-react.bindSnapshotSelector`（rc.7 官方包）
3. React 原生 `useSyncExternalStore` 兜底

因此即使当前内核的客户端模块表不提供 `dsh-client-web-react`（报 `require(...) missed the module table`），设置菜单入口仍可正常注册、展示与保存。