# KB Markdown 渲染：Glyph 源码对比分析与优化方案

> 对比对象：
> - Glyph：`G:\CustomWorkspaces\AIProjects\glyph\src`（React 19 + Tauri + react-markdown@10 + unified/remark/rehype）
> - 本项目：`src/vs/sessions/contrib/agentStudio/webview/src/kbMarkdown`（react-markdown@9 + 离线手搓管线）
>
> 结论先行：本项目的 markdown 渲染管线是 Glyph 的**高保真复刻**，核心算法（wikilink、embed、slug、alert、gemoji、math、outline）几乎逐行对齐。差异主要来自「离线零新增依赖」约束，以及少量**功能性缺口与一致性 bug**。本文给出对比矩阵、优化方案，并附测试。

---

## 一、特性对比矩阵

| 特性 | Glyph | 本项目 | 状态 |
|---|---|---|---|
| 管线结构（remark/rehype 分离） | `lib/markdown/pipeline.ts` | `kbMarkdown/pipeline.ts` | ✅ 一致 |
| GFM（表格/任务列表/删除线/自动链接） | remark-gfm | remark-gfm | ✅ 一致 |
| 数学公式 | remark-math + rehype-katex（懒加载） | remark-math + `remarkMathToKatex` + KaTeX.renderToString | ✅ 功能一致；实现不同 |
| GitHub Alerts | remark-github-blockquote-alert | `remarkAlert.ts`（手写） | ✅ 5 种类型全覆盖 |
| Emoji `:shortcode:` | remark-gemoji（全量 ~1800） | `gemoji.ts` + `gemojiData.ts`（全量 **1848** 短码，离线烘焙） | ✅ **已对齐**（见缺口 5） |
| Wikilink `[[note]]`/`\|alias`/`#heading` | `lib/wikilink.ts` | `wikilink.ts` | ✅ 逐行对齐 |
| Wikilink 解析 | `wikilinkResolver.ts`（路径/stem/同目录优先） | `wikilinkResolver.ts`（返回 file:// URI） | ✅ 对齐（含 `.markdown`） |
| Embed `![[note]]` + 循环检测 | `EmbedComponent`（EmbedContext.chain） | `EmbedComponent`（EmbedContext.chain） | ✅ 对齐 |
| **Embed `#heading` 切片** | `extractHeadingSection` | **宿主忽略 heading，返回整篇** | ❌→✅ **已修复**（webview 侧 `headingSection.ts` 切片） |
| 标题锚点 `id` + 悬浮复制/跳转 | rehype-slug + HeadingAnchor | `rehypeSlug` + MarkdownHeading(`#` 跳转) | ✅ 对齐 |
| **TOC slug 一致性** | 统一 github-slugger（渲染文本） | outline 用**原始文本** slug，渲染用**渲染后文本** | ❌→⚠️→✅ **已修复**：TOC 改为渲染后从 DOM 收集真实 `id`（见缺口 3），emoji/行内格式标题不再错位 |
| **跨文档 `[[note#heading]]` 跳转滚动** | wikilink heading → 打开并滚动 | `onOpenWikilink` **丢弃 heading**，只打开不滚动 | ❌→✅ **已修复**（heading 透传 + EditorInput 携带 + 目标 pane 渲染后滚动） |
| Frontmatter | js-yaml FAILSAFE_SCHEMA（完整 YAML） | `frontmatter.ts`（子集解析） | ⚠️→✅ **已增强**：流数组/嵌套映射/类型保留/引号（见缺口 4） |
| 代码高亮 | rehype-highlight（**懒加载**，~30KB） | react-syntax-highlighter（**静态全量**，~587KB） | ⚠️→✅ **已优化**：`PrismLight` 白名单，refractor 输出 587.9KB→117.5KB，总包 2.6MB→2.2MB |
| 代码块复制按钮 | — | `CopyButton` | ✅ 额外优势 |
| CSV 表格 | 无 | `CsvTable`（手写 RFC-4180） | ✅ 额外优势 |
| Mermaid / D2 | 渲染 | 占位提示（依赖未装） | ⚠️ 占位一致 |
| 图片灯箱 | LightboxProvider | `ImageComponent`（自带灯箱） | ✅ 对齐 |
| 原始 HTML | rehype-raw + rehype-sanitize（带 allowlist） | `rehypeRawSafe`（零依赖等效 + allowlist 净化） | ✅ **已对齐** |
| 相对链接根目录钳制 | `resolveWorkspacePath` + `isPathInside` | `relativePath.ts`（等价） | ✅ 对齐 |
| 任务列表勾选回写 | `TaskListItem` → `onTaskToggle(line)` | 静态展示（无回写） | ⚠️→✅ **已修复**：预览勾选回写源 `.md`（见缺口 6） |
| 反链/提及 | 内核提供 | 宿主 `getBacklinks` → webview | ✅ 对齐 |
| URL 安全 | sanitize 拦截 | `safeUrl` urlTransform 拦截 | ✅ 对齐 |

---

## 二、关键缺口详解

### 缺口 1（P0，功能性 BUG）：`![[note#heading]]` 嵌入不切片 —【已修复】
- Glyph：`EmbedComponent` 在拿到目标笔记全文后调用 `extractHeadingSection(content, heading)`，只渲染该标题下的小节。
- 本项目（修复前）：`embedBridge.requestNoteContent(uri, heading)` 把 heading 传给了宿主，但宿主 `kbBlocksEditorPane._serveNoteContent(uriStr, requestId)` **只读取全文并返回**，webview `EmbedComponent` 也未切片 → 嵌入整篇笔记。
- 修复方案：新增 `kbMarkdown/headingSection.ts`（移植 Glyph `extractHeadingSection`，复用本项目 `slugify`），`EmbedComponent` 拿到全文后用 `extractHeadingSection(content, heading)` 切片后再渲染；heading 未命中时回退整篇（不空白）。宿主契约不变（仍是返回全文，webview 切片，避免跨端 slug 重复实现）。
- 影响：嵌套大纲、只嵌入某段等核心 PKM 场景已恢复。

### 缺口 1b（P0，功能性 BUG）：`[[note#heading]]` 跨文档跳转不滚动 —【已修复】
- 修复前：`LinkComponent` 调用 `onOpenWikilink(path, heading)`，但 `KbMarkdownApp.onOpenWikilink` 只接收 `uri`、丢弃 `heading`；宿主 `_openDocByUri` 打开编辑器后也不滚动 → 跳转后停在文档顶部。
- 修复方案：webview `onOpenWikilink(uri, heading)` 透传 heading 到宿主 `kbblocks.openDoc`；宿主 `_openDocByUri` 将 heading 携带到 `KbNoteEditorInput`；`_openDoc` 写入 `__KB_INIT__.heading`；目标 pane 渲染后 `useEffect` 用 `findHeadingId(outline, heading)` 定位并 `scrollIntoView`。

### 缺口 2（P0，性能）：高亮依赖未懒加载 —【已修复】
- 修复前：`CodeBlockComponent.tsx` 静态 `import { Prism } from 'react-syntax-highlighter'` + `oneDark` 样式，把**全部 refractor 语言**打进单文件 webview bundle（打包后 `refractor` 输出 **587.9KB**、总包 **2.6MB**），纯文本笔记也加载近 600KB 高亮定义。
- 修复方案：改用同包内的 `PrismLight`（仅 `refractor/core`）+ 新增 `components/prismLanguages.ts`，**按需 `registerLanguage` 一个策划语言白名单**（~45 种常见语言：js/ts/jsx/tsx、py、go、rust、java、c/cpp/c#、rb、yaml、json、bash、sql、markdown、css/scss/less、docker、graphql 等，并配 `alias` 映射 `js/sh/yml/md/py/...`）。`CodeBlockComponent` 改为从 `./prismLanguages` 导入 `PrismLight + oneDark`；白名单外语言**优雅降级为纯文本**（不崩溃）。
- 实测收益（esbuild metafile，minify 后输出）：
  - `refractor` 输出 **587.9KB → 117.5KB**（−470KB）
  - `react-syntax-highlighter` 输出 29.1KB → 25.5KB
  - webview 总包 **2.6MB → 2.2MB**（−400KB）
- 说明：webview 是单 IIFE（`splitting:false`），无法做真正的代码分割式懒加载；`PrismLight` 白名单是单包约束下的最优解，与 Glyph「仅含常用语言」效果一致。Glyph 的「含代码才加载 ~30KB」需改走 rehype-highlight 管线，属更大重构，本次未做。
- 测试：新增 `prismLanguages` 功能测试（真实 `renderToStaticMarkup`）：白名单语言产出 token 高亮、别名（ts→typescript）解析、未知语言降级不抛错；见 `kbMarkdown.test.ts`。

### 缺口 3（P1，一致性）：TOC 锚点 slug 与渲染标题不一致 —【已修复】
- 修复前：`outline.extractOutline` 对**原始 markdown 标题文本**做 `slugify`（`# :wave: Hello` → `wave-hello`）；`rehypeSlug` 对**渲染后标题文本**做 `slugify`（`👋 Hello` → `hello`）并赋给 DOM 元素 `id`。两者 slug 不同 → 点击 TOC 调用 `getElementById('wave-hello')` 落空。
- 修复方案：新增 `kbMarkdown/domOutline.ts` 的 `collectDomOutline(root)`，在 `.kb-markdown` 容器内 `querySelectorAll('h1..h6')` **直接读取渲染元素的真实 `id` + `textContent`** 构建 TOC。`KbMarkdownApp` 在 preview 渲染后（`requestAnimationFrame`）收集为 `domOutline`，TOC 与 `[[note#heading]]` 跨文档跳转优先用它的真实 `id` 滚动；收集前/源码模式回退到源文本 `outline`。这样 TOC 的 `id` 与浏览器锚点**逐字节一致**，与 Glyph「单一 github-slugger 作用于渲染文本」效果等价。
- 关键点：`rehypeSlug` 已对渲染后文本正确设 `id`，DOM 收集只是复用该 `id`（而非重新 slugify），所以从根上消除错位；`outline.ts` 仍保留为 DOM-free 纯函数供测试/兜底。
- 测试：见 `kbMarkdown.test.ts` 的 `collectDomOutline` 用例（轻量 DOM mock）：跳过无 `id` 标题、读取 `h1` 层级、读取渲染文本、`👋 Hello` 保留 `wave-hello` slug `id`、`` Sub `code` `` 行内 code 文本逐字保留、`null` 安全返回空。

### 缺口 4（P1，功能）：frontmatter 子集解析弱 —【已修复】
- 修复前：`parseYamlSubset` 仅支持顶层 `key: value` 与块列表 `- item`，把嵌套映射当续行吞成字符串，且所有 value 都当字符串（无数字/布尔/null），`tags: [a, b]` 内联流数组整体当成字面串。
- 修复方案：重写 `parseYamlSubset` 为**缩进感知**的迷你 YAML 解析器（零新增依赖），支持：
  - 块序列 `key:\n  - a\n  - b`（顶层或嵌套映射下均可，`findListTarget` 向上查找最近 key 挂载）
  - 内联流序列 `key: [a, b, c]`
  - 嵌套块映射 `parent:\n  child: x` 与内联流映射 `parent: {child: x, other: 2}`（保留为嵌套对象）
  - 标量类型推断：布尔 `true/false`、整数、浮点、`null`/`~`
  - 单/双引号字符串（引号内逗号不误拆，用 `splitTopLevel` 按括号/引号深度切分）
  - 当前 key 的多行续行
- `FrontmatterBlock` 渲染层同步增强：用 `flattenRows` 把嵌套对象**展平为 `parent.child` 多行**（每个标量一行），`formatValue` 正确处理数组/对象/类型/null。
- 说明：仍非完整 YAML（无锚点/多文档/复杂字面量），但覆盖 KB 作者常用的 Obsidian 风格 frontmatter；与 Glyph 的 js-yaml 功能对齐度显著提升。
- 测试：见 `kbMarkdown.test.ts` 的 `parseFrontmatter` 用例：流数组、块列表兼容、嵌套块映射（数字保留）、内联流映射（布尔保留）、布尔/整数/浮点/null 类型、引号内逗号、嵌套块列表、`null` 无围栏返回 null。

### 缺口 5（P2，覆盖）：gemoji 仅精选 380 条 —【已修复】
- 修复前：本项目手搓 `gemoji.ts` 仅精选常用 **380** 条短码；Glyph 经 `remark-gemoji` 用全量 ~1800 条，覆盖率差异（如 `:abacus:`、`:octopus:`、`:1st_place_medal:` 等大量短码在原版不渲染）。
- 修复方案（保持「离线零运行时依赖」，比对 Glyph 的 `remark-gemoji`）：
  - 一次性联网取官方 `wooorm/gemoji` 数据集（`index.json`，1805 emoji / 1848 个 `names` 短码），由 `tmp/gen_gemoji.mjs` 生成 `kbMarkdown/gemojiData.ts`（`Record<string,string>`，已排序）。
  - `gemoji.ts` 改为 `import { GEMOJI } from './gemojiData'`，替换逻辑（`/:([a-z0-9_+-]+):/g` + `findAndReplace`）完全不变；未匹配短码仍保持原样。
  - 数据校验：1848 个短码 **0 冲突**（同名不同 emoji 不存在）、**0 异常字符**（全部匹配替换正则，含 `+1` / `100` 这类特殊短码），与 Glyph 覆盖度一致。
  - 运行时仍零新增 npm 依赖（仅烘焙数据文件，体积约 +30KB）。
- 测试：见 `kbMarkdown.test.ts` 的 `GEMOJI` 用例：短码数 ≥1800、`rocket`/`thumbsup`/`wave`/`+1`/`100` 映射正确、所有短码匹配 `:name:` 正则。

### 缺口 6（P2，UX）：任务列表勾选不回写 —【已修复】
- 修复前：GFM 任务列表渲染为 `<li><input type="checkbox" disabled>`，勾选是纯视觉、无回写；源 `.md` 的 `- [ ]`/`[x]` 永远不变（Glyph 通过 `TaskListItem` → `onTaskToggle(line)` 回写源行，本项目缺失）。
- 修复方案（对齐 Glyph `onTaskToggle(line)`，离线零新增依赖）：
  - 新增 `remarkTaskLines` 插件：遍历 mdast，给每个 `checked` 的 `listItem` 在 `data.hProperties` 上盖 `data-task-line`（相对 `body` 的 1-based 行号）+ `data-task-checked`。
  - `MarkdownContent` 计算 frontmatter 行偏移 `fmLineOffset`，由 `TaskListItem` 把相对行号加成**完整 `.md` 的绝对行号**写到 `<li data-task-line>`；并注册 `input` 组件为 `TaskCheckbox`。
  - `TaskCheckbox` 渲染可控 checkbox（`preventDefault` 阻止浏览器原生切换，避免双重状态），点击时沿 `closest('li')` 取 `data-task-line`，调 `onToggleTask(line)`。
  - `KbMarkdownApp.onToggleTask` 用纯函数 `toggleTaskCheckbox(markdown, line)` 翻转该行 `- [ ]`↔`- [x]`（容错大写 `[X]`、缩进/星号标记），`setMarkdown` + `postMessage('kbblocks.save', {markdown})` 落盘；重渲染以保存后的 markdown 为唯一真相源。
  - 边界隔离：`EmbedComponent` 渲染独立 `MarkdownContent` 时**不传** `onToggleTask`，`TaskCheckbox` 检测到无 `onToggleTask` 即保持 GFM 原生 `disabled` 只读，绝不把勾选误写回当前文档（embed 是别的文件）。
- 测试：见 `kbMarkdown.test.ts` 的 `toggleTaskCheckbox` 用例：行1 `[ ]`→`[x]`、行2 `[x]`→`[ ]`、大写 `[X]`、非任务行返回 `null`、越界返回 `null`、嵌套/星号标记。

---

## 三、优化方案（按优先级）

### P0-1：修复 embed `#heading` 切片
- 新增 `kbMarkdown/headingSection.ts`（移植 Glyph `extractHeadingSection`，与本项目 `slugify` 一致）。
- `EmbedComponent` 拿到全文后用 `extractHeadingSection(content, heading)` 切片后再渲染。
- 宿主 `_serveNoteContent` 类型补充 `heading` 透传（可选，便于日志/调试）。

### P0-2：高亮依赖懒加载 + 瘦身
- 改用 `react-syntax-highlighter/dist/esm/prism-async-light` + `registerLanguage` 注册精选语言子集（js/ts/json/bash/python/md/html/css/xml/yaml…），基础包从 ~587KB 降至 ~30KB，语言按需异步加载。
- KaTeX 已通过 `katex-css` 插件内联 CSS，运行时 `katex.renderToString` 始终需要；可保留，但将 `katex` 的引入与「文档是否含公式」解耦（remark 阶段已标记 math 节点，可在有 math 时才动态 import katex）。

### P1-1：TOC slug 一致性
- 改为渲染后从 DOM 收集标题：`useEffect` 在 `.kb-markdown` 容器内 `querySelectorAll('h1,h2,h3,h4,h5,h6')`，读取真实 `id` + `textContent` 构建 TOC。滚动直接用该 `id`。彻底消除 slug 错位。
- 保留 `outline.ts` 作为纯函数（无 DOM 环境的兜底/测试）。

### P1-2：frontmatter 解析增强
- 支持内联流数组 `tags: [a, b]` 与 `key: value` 行内多值；嵌套映射展平为 `parent.child` 键或保留为字符串。

### P2：gemoji 扩表 / 任务勾选回写 / 原始 HTML 支持
- gemoji：✅ **已修复**（见缺口 5），离线烘焙全量 1848 短码，覆盖度与 Glyph 对齐。
- 任务勾选：✅ **已修复**（见缺口 6），预览勾选回写源 `.md`。
- 原始 HTML：✅ **已放开**（见缺口 7）。零依赖手搓 `rehypeRawSafe` 替代 `rehype-raw` + `rehype-sanitize`：把 react-markdown v9 留下的 `raw` 节点用浏览器 `DOMParser` 解析为 hast，再经严格 allowlist 净化（排除 script/style/iframe/object/embed/form 等；拦截 `javascript:`/`data:`/`vbscript:` URL；`target=_blank` 自动加 `rel=noopener noreferrer`）。因 webview 现有 `@blocksuite/presets@^0.20.0` 在当前 registry 无匹配版本（`npm install` 整体 ETARGET 失败），官方包装不上，故手搓（契合"离线零依赖"哲学）。

---

## 四、风险与取舍说明
- **离线约束**：本项目的「手搓替代」是为满足离线零新增依赖的刻意决策，功能等价但实现更重（体积/维护成本）。联网后可平滑替换为官方包。
- **安全**：原始 HTML 现已放开但经 `rehypeRawSafe` 严格 allowlist 净化（排除 script/style/iframe/object/embed/form 等；`javascript:`/`data:`/`vbscript:` URL 全拦截；`target=_blank` 自动加 `rel=noopener noreferrer`）；`safeUrl`（`urlTransform`）再拦截 a/img 的 javascript:/vbscript:/file:/非图片 data:。KaTeX 输出经可信库 `renderToString`，`throwOnError:false`，可接受。

---

## 五、测试覆盖（见 `webview/test/kbMarkdown.test.ts` + `webview/test/run.mjs`）
纯逻辑模块（无 DOM/React 依赖）用 `esbuild` 打包后由 Node 运行：`node test/run.mjs`。

> 当前已落地 **64 个用例全部通过**，覆盖本次 P0/P1/P2 修复的核心纯函数：
- `rehypeSlug.slugify`：中文/特殊字符/空格与短横折叠
- `headingSection.extractHeadingSection`（**本次新增**）：`#heading` 切片、同级标题截断、未命中返回空、大小写不敏感、代码块内标题忽略
- `outline.extractOutline`：跳过 frontmatter、各级标题、**重复标题 `-N` 后缀与 rehypeSlug 完全一致**
- `outline.findHeadingId`：按文本（大小写不敏感）/slug 命中、首匹配、未命中返回 undefined
- `collectDomOutline`（**本次新增**）：从渲染后 DOM 收集标题，跳过无 `id` 标题、读取 `h1` 层级、读取渲染文本、`👋 Hello` 保留 `wave-hello` slug `id`（与 `rehypeSlug` 一致）、`` Sub `code` `` 行内 code 文本逐字保留、`null` 安全返回空（轻量 DOM mock 验证）
- `parseFrontmatter` / `parseYamlSubset`（**本次增强**）：流数组 `[a,b]`、块列表兼容、嵌套块/流映射（保留对象+数字类型）、布尔/整数/浮点/null 类型推断、引号内逗号不误拆、嵌套块列表、无围栏返回 `null`
- `wikilinkResolver.resolveWikilink`：stem 匹配、路径后缀匹配、同目录优先、多候选稳定回退、`.md` 去扩展名、heading 透传、断链返回 null
- `prismLanguages`（**本次新增**）：`PrismLight` 组件导出、`oneDark` 样式导出；白名单 `typescript` 真实渲染产出 `class="token"` 高亮；别名 `ts→typescript` 解析；未知语言降级为纯文本不抛错（用 `react-dom/server` 真实渲染验证）
- `toggleTaskCheckbox`（**本次新增**）：行1 `[ ]`→`[x]`、行2 `[x]`→`[ ]`、大写 `[X]` 容错、非任务行返回 `null`、越界返回 `null`、嵌套/星号标记
- `GEMOJI`（**本次新增**）：短码数 ≥1800、`rocket`→`🚀`、`thumbsup`→`👍`、`wave`→`👋`、`+1`→`👍`、`100`→`💯`、所有短码匹配 `:name:` 正则

后续可补充（用同一 esbuild 运行器，无需新增依赖）：
- `markdownExtensions`：isImageFile / isMarkdownFile
- `relativePath`：normalizeRelativePath `..` 钳制、isOpenableRelativeHref
- `remarkAlert`：5 种类型识别、marker 剥离
- `remarkWikilink`：wikilink/alias/heading/embed/循环内嵌/代码块内跳过
- `remarkMathToKatex`：math/inlineMath → hProperties
- `frontmatter.parseFrontmatter`：基础键值、列表、空

### 端到端验证建议（手动）
1. 两篇笔记 A.md / B.md：A 中写 `![[B#第三节]]`，确认只嵌入 B 的「第三节」小节。
2. 长笔记含重复标题（如两个 `## 示例`）：点击大纲第二个「示例」，确认滚动到第二个而非第一个。
3. 在笔记 X 写 `[[Y#目标标题]]`，Ctrl+点击，确认跳转到 Y 并自动滚动到「目标标题」。
