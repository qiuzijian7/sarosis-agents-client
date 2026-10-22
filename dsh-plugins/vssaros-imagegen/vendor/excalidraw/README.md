# 画布引擎 vendor：Excalidraw

画布（工作台）用的第三方引擎是 **Excalidraw 0.18.1（MIT）**。本目录只放**构建脚本 + 钉版本的依赖清单**，
**产物**落在 `../../lib/canvas/`（随插件打包进 profile ⇒ 离线可用 ✓）。

## 为什么要 vendor 而不是 npm 依赖

- dsh 插件是**按 package.json 的 files 白名单**打进 profile 的（`build/prepack-dsh-runtime.mjs`），
  运行时**不联网** ⇒ 画布引擎必须以文件形式随包。
- 版本要**钉死**：Excalidraw 的 API 与产物结构在小版本间会变（我们已踩过 `excalidrawAPI` 从对象改成函数的坑）。

## 重建产物

```bash
cd dsh-plugins/vssaros-imagegen/vendor/excalidraw
node build.mjs          # 缺依赖会自动 npm install；产物落到 ../../lib/canvas/
node build.mjs --check  # CI 口径：只校验产物在位（不在就红）
```

## 三处刻意裁剪（都是为了体积）

| 裁剪 | 省下 | 代价 |
|---|---|---|
| `mermaid-to-excalidraw` 换替身（`stub-mermaid.js`） | **≈2.6MB**（mermaid 1.4 + cytoscape 0.54 + katex 0.27） | 「从 mermaid 源生成画布」不可用（调用时**明确报错**，不静默） |
| locale 代码分割 + 只留 zh-CN / en / ja-JP / zh-TW | **≈1.5MB**（全量 75 个语言包） | 其它语言不可选（Excalidraw 的语言菜单里没有） |
| 字体走 woff2 独立文件 | 不内联 | 多 4 个文件 |

结果：产物 **≈3.4MB**（入口 713KB + 共享块 1.78MB/532KB + CSS 141KB + 字体 79KB + 语言包）。

## ⚠ 这 3.4MB 只能待在**专用视图**里

Excalidraw 产物**不进 dsh 客户端 bundle**。若把它塞进 dsh 的客户端包（每个聊天框都加载），
就是当初 tldraw（4.89MB）的老问题 ⇒ 画布因此做成**我们自己的插件页**（独立 webview，按需加载），
而不是 dsh 右栏里的一个页签。

## 许可

Excalidraw 是 **MIT**（原文见 `LICENSE-excalidraw.txt`，Copyright (c) 2020 Excalidraw）。
本插件自身的代码是 MIT；随包的产物里包含 React 18（MIT，© Meta Platforms, Inc. and affiliates）、
jotai（MIT）、perfect-freehand（MIT）等依赖，均在上游各自的许可下分发。

## 已知 API 坑（照抄会白写）

1. `excalidrawAPI` 必须是**函数**（`excalidrawAPI={(api) => {...}}`），传对象会报
   `excalidrawAPI should be a function!`。
2. `langCode` 是**顶层 prop**，不是 `UIOptions.langCode`（放错位置 ⇒ 界面静默回退英文）。
3. `UIOptions.languages` 要显式给（只给 `langCode` 时语言菜单是空的）。
4. `import '@excalidraw/excalidraw/index.css'` 需要 esbuild 的 `--conditions=production` 才解析得到。
