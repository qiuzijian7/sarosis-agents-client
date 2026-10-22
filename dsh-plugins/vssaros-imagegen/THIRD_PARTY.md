# 第三方声明

本插件随包分发的第三方代码：

| 组件 | 版本 | 许可 | 用途 | 原文 |
|---|---|---|---|---|
| Excalidraw | 0.18.1 | MIT | 画布引擎（`lib/canvas/` 的产物） | `vendor/excalidraw/LICENSE-excalidraw.txt` |
| React / React DOM | 18.3.1 | MIT | 画布 UI 运行时（打进 `lib/canvas/entry.js`） | https://github.com/facebook/react/blob/main/LICENSE |
| jotai | 2.11.0 | MIT | Excalidraw 依赖（打进产物） | https://github.com/pmndrs/jotai/blob/main/LICENSE |
| perfect-freehand | 1.2.0 | MIT | Excalidraw 依赖（自由绘制）（打进产物） | https://github.com/steveruizok/perfect-freehand/blob/master/LICENSE |

其余打进 `lib/canvas/entry.js` 的依赖（pako、nanoid、clsx、lodash.debounce、open-color、fractional-indexing、
browser-fs-access、image-blob-reduce 等）均为 MIT / BSD 许可，许可声明随各自上游包分发。

⚠ 画布产物里**不含** mermaid-to-excalidraw（被替身替换，省约 2.6MB）⇒ 该功能不可用，
调用时会明确报错（见 `vendor/excalidraw/stub-mermaid.js`）。

⚠ 画布产物里只保留 zh-CN / en / ja-JP / zh-TW 四种界面语言（省约 1.5MB）。
