# Vendored from pi-monorepo（MIT License）

**上游**：https://github.com/earendil-works/pi
**来源版本**：本地 checkout `G:\CustomWorkspaces\AIProjects\pi`（09-16，**领先于** npm `@earendil-works/pi-agent-core@0.85.1` —— npm 根缺 `SystemMessage`/`ToolStateChanges`/`TranscriptContext` 等 ⇒ 以 checkout 为准）。
**Vendor 日期**：2026-09-19。

## 文件清单

| 本目录文件 | 说明 |
|---|---|
| `piAgentLoop.bundle.ts` | **esbuild 从 checkout 源码打包**的自洽 bundle（含 `agentLoop`/`agentLoopContinue`/事件流工厂 + typebox 校验）。**不要手改**；升级 pi 时重跑 `build-pi-bundle.mjs` 重新生成。 |
| `build-pi-bundle.mjs` | 打包脚本（`node build-pi-bundle.mjs [piCheckoutDir]`）。瘦身入口只引轻量 loop 实际用到的 pi-ai utils（`event-stream`/`transcript`/`validation`），**避免把 api/providers 层打进来**。 |
| `piLoop.ts` | 对 bundle 的**类型化包装**（bundle 是 `@ts-nocheck` 的 esbuild 产物 ⇒ 本文件是唯一类型边界，收口到 `../piCoreTypes.js`）。 |

## 为什么是这个形态（三次排障后的结论，勿再走弯路）

1. **npm 直引不可行**：桌面 renderer 不能裸引 npm 包（本仓 `out/` 产物 **0 条**裸 npm 导入 ⇒ 运行时 ESM loader 无法解析 bare specifier）；且 `pi-agent-core` 的**根入口会连带 harness**（`harness/session`=fs、`harness/tools`=child_process），其 `exports` 映射**没有** `./agent-loop` 子路径。
2. **npm 类型与 checkout 漂移**：npm 0.85.1 缺 checkout 新增的若干类型 ⇒ 类型不能从 npm 引（会编译期错位）。
3. **手抄源码易转写错误** ⇒ 最终选择 **esbuild 从源码出 bundle**（忠实、自洽、Node-free），类型层（`../piCoreTypes.ts`）手工对齐 checkout（只约束我方适配层内部，不污染内核）。

**验收**：`test/browser/piCoreAdapters.test.ts` 4/4 绿（含 vendored 内核端到端：文本 + 工具调用 + 工具后自动续跑）。

## 许可（MIT）

```
MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
