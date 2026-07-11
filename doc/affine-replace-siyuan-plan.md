# 用 AFFiNE / BlockSuite 完全替换 SiYuan（可编辑富块 + 数据库 + 画布）

> 状态：Phase 0 探针 **已构建通过**（`media/kbblocks.js`，13.2 MB）。本文档记录**确认决策**、**修正后的事实**、架构与全量重构的阶段性计划。
> 注：**协同（multi-agent / 多面板编辑同一文档）本期不做**，已从范围内移除；当前每个面板持独立本地文档。

## 0. 用户确认的范围（2026-07-09）

| 维度 | 决策 |
|------|------|
| 范围 | **全量重构**：富块 + 数据库 + 画布（**协同不在本期范围**） |
| 存储路线 | 探针阶段再评估（路线 A 全量切 Yjs 快照 / 路线 B 混合兼容 `.md`） |
| 协同范围 | **本期不做**：每个面板编辑独立文档；多 agent 协同留待后续阶段 |

## 1. 修正后的关键事实（与早期判断不同，重要）

1. **许可证不是 MIT，是 MPL-2.0。**
   早期分析称 BlockSuite/AFFiNE 为 MIT，但实际发布的 npm 包 `@blocksuite/presets` / `@blocksuite/blocks` / `@blocksuite/store`（0.19.5）均为 **MPL-2.0**（文件级弱拷贝左）。对闭源 VS Code 扩展而言：作为**未修改的依赖**打包使用是允许的，无需开源整体；但若**修改**了这些 MPL 文件，需公开那些被改文件。生产落地需法务确认 MPL-2.0 合规（相比 AGPLv3 的 SiYuan 应用，MPL 可接受，但非 MIT）。

2. **发布的 `@blocksuite/affine@0.22.4` 不导出编辑器类。**
   `PageEditor` / `EdgelessEditor` / `createEmptyDoc` 在 `@blocksuite/presets`（0.19.5）里；而 published presets 0.19.5 依赖的是**旧的** `@blocksuite/blocks@0.19.5` 家族，与 affine 0.22 是不同版本线、不能混用。因此探针安装**版本对齐、文档匹配**的 0.19.5 家族：
   - `@blocksuite/presets@0.19.5`（编辑器 + `createEmptyDoc`）
   - `@blocksuite/store@0.19.5`（`DocCollection` / `Schema` / `Text` / `Job`）
   - `@blocksuite/blocks@0.19.5`（`AffineSchemas`）
   - 配套 peer：`@blocksuite/global` / `inline` / `block-std` / `affine-model` / `affine-shared` / `affine-block-surface` + `yjs@^13.6` + `lit@^3`
   - 生产集成建议锁定到 `@blocksuite/affine` 0.22.x 的 consolidated 包时，需改用其 `@blocksuite/affine/presets`（或自组装 specs）的对应导出——API 主体（`DocCollection`/`Schema`/`AffineSchemas`/`Text`/`addBlock`/`PageEditor`/`EdgelessEditor`）保持一致。

3. **上游打包 bug（0.19.5）：图标名拼写错误。**
   `@blocksuite/affine-components` 与 `@blocksuite/data-view` 引用了 `CheckBoxCkeckSolidIcon`（typo），但当前解析到的 `@blocksuite/icons` 已修正为 `CheckBoxCheckSolidIcon`。已在 esbuild 中用插件在打包时重写消费方的拼写（见 `esbuild.kbblocks.config.mjs` 的 `fixIconsTypoPlugin`）。升级版本时需重新验证该 bug 是否已修复。

4. **当前 SiYuan 真实耦合（盘点结论，未变）。**
   内核早已被自研 `kbNativeKernel.ts` 替换；真正在用的 SiYuan 资产仅 `lute.min.js` + Protyle 模式 + 仿 SiYuan 数据模型（`kbTypes.ts`）。替换面 = 用 AFFiNE 编辑器替换 `kbNoteEditorPane` 的 Lute 路径，并逐步清理 SiYuan 残留。

## 2. 已交付的探针（可运行）

```
webview/
  esbuild.kbblocks.config.mjs        # 单独打包 media/kbblocks.js (IIFE)
  src/kbBlocks/
    index.tsx                        # BlockSuite 探针 harness（page + edgeless 双视图，本地独立文档）
  media/kbblocks.js                  # 构建产物 13.2 MB (minified)
browser/
  kbBlocksEditorPane.ts             # 宿主侧编辑器（WebviewElement + 内联 kbblocks.js）
```

**探针证明的能力：**
- 可编辑富块：`<page-editor>` 挂载 `DocCollection` 文档（paragraph/list/code/callout…）。
- 画布/白板：`<edgeless-editor>`（brush/shape/connector/mindmap…）。
- **数据库**：`Insert Database` 按钮调用 `doc.addBlock('affine:database', …)`（data-view 渲染）。
- **双视图共享本地文档**：`PageEditor` 与 `EdgelessEditor` 绑定**同一个 Y.Doc**，任一处编辑实时反映到另一处（CRDT 直接证据，非跨面板协同）。

**宿主集成范式（照抄现有基建，已验证可编译通过）：**
- 读 `media/kbblocks.js` 从磁盘**内联**进 webview HTML（`nonce` + `script-src 'nonce-…'`；`style-src 'unsafe-inline'` 覆盖 BlockSuite shadow-DOM 内联样式）。
- `localResourceRoots` 含 media 目录；`allowScripts: true`、`retainContextWhenHidden: true`。
- 宿主先注入 `window.__KB_INIT__ = { docId }`，bundle 据此打开对应本地文档（首开自动播种根块）。
- 复用现有 `bridge/messageClient.ts` 的 `acquireVsCodeApi` / `postMessage`（`kbblocks.ready` 信号就绪）。

## 3. 架构

```
EditorPane(宿主 AMD)
  └─ KbBlocksEditorPane
       └─ WebviewElement（沙箱 DOM + 宽松 CSP）
            └─ 内联 media/kbblocks.js (预打包的 @blocksuite/presets IIFE)
                 ├─ <page-editor>    ┐
                 ├─ <edgeless-editor> ├─ 共享同一本地 Y.Doc（CRDT，仅本面板内双视图同步）
                 └─ affine:database 块
```
每个 `KbBlocksEditorPane` 实例持有**独立**的本地文档；本期无跨面板 / 多 agent 协同（无中继 hub）。

## 4. 包体 / 性能风险（需生产化处理）

| 包 | 体积 | 备注 |
|----|------|------|
| `@shikijs/langs` | 7.7 MB | 代码块语法高亮，按需语言子集可大幅裁剪 |
| `@blocksuite/blocks` | 4.2 MB | 富块 |
| `@blocksuite/data-view` | 1.5 MB | 数据库 |
| `katex` / `pdf-lib` / `html2canvas` / `lottie` | ~2 MB | 公式/导出/快照 |
| **合计** | **13.2 MB** | 当前内联进 HTML；生产须改为**懒加载 + 外部引用**（关闭 service worker 的 `vscode-webview:` 引用），并裁剪 shiki 语言 |

## 5. 全量重构分阶段计划（更新版）

- **Phase 0 — 探针（已完成 ✅）**：本探针。验证 webview 隔离、AMD/ESM、CRDT 双视图（同一本地文档）、包体。
- **Phase 1 — 替换渲染**：用 `KbBlocksEditorPane` 替换 `kbNoteEditorPane` 的 Lute 路径；包成真实 `EditorPane` + `EditorPaneDescriptor` + `IEditorSerializer`（`.bsdoc` 或 KB 输入）；删 `lute.min.js` / `kbLute*.ts` / Protyle 模式。
- **Phase 2 — 富块 + 数据库 + 画布启用**：开启 database / edgeless effects；`KbImportKind`（Obsidian/飞书等）改走 AFFiNE `MarkdownAdapter` / 各平台 adapter；存储路线 A/B 在此拍板（建议 A）。
- **Phase 3 — （可选）多 agent 协同**：本期不做。若后续需要，再引入 Yjs 中继 hub（postMessage 或 WebSocket），复用 `doc.spaceDoc` 作为协同锚点。
- **Phase 4 — 清理**：删 `kbKernelApi.ts` / `kbKernelManager.ts` 等 SiYuan 残留；`kbTypes.ts` 数据模型迁移到 BlockSuite schema；检索/反链/图谱（`kbNativeKernel` 的 BM25）改为对 Yjs 文档文本建索引，双链改用 BlockSuite `reference`/`linked-doc` 块。

## 6. 集成到 workbench 的最小步骤（Phase 1 落地清单）

1. 把 `KbBlocksEditorPane` 包进一个 `EditorPane` 子类（参考 `htmlFileEditorPane.ts` 的 `createEditorControl` / `setInput` / `layout` / `clearInput` / `dispose`）。
2. 注册 `EditorPaneDescriptor` + `IEditorSerializer`，对应 KB 笔记输入 URI scheme。
3. 注册命令（如 `agentStudio.openKbBlockDoc`）以 `mount(container, { docId })` 打开（每面板独立本地文档；本期无跨面板协同）。
4. 运行 `npm run build:kbblocks` 产出 `media/kbblocks.js`，主构建将其拷到 `out/.../webview/media`。

## 7. 主要风险

- **许可证**：MPL-2.0（非 MIT），需法务确认合规与分发方式。
- **版本漂移**：0.19.5 与 affine 0.22 命名空间不同；升级需改导入路径并回归图标/API。
- **包体**：13 MB，须懒加载 + 裁剪 shiki 语言，否则拖慢扩展启动。
- **CSP / 隔离**：BlockSuite 用 custom elements + 内联样式，必须 webview 沙箱 + `style-src 'unsafe-inline'`；已验证。
- **数据库/画布块往返**：路线 B（保留 `.md`）下 db/画布块无法无损往返 Markdown，长期必走路线 A。
- **迁移损耗**：存量 `.md` 笔记经 adapter 批量转换有格式损耗。
- **API 漂移**：BlockSuite 迭代极快，须锁版本并长期跟进。
