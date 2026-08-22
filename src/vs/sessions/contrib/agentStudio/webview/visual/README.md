# 工作流节点 UI 可视化测试方案

验证 AgentStudio 工作流编辑器中**每个节点卡片的 UI 是否正确**。
当前覆盖 **195 个注册节点 × 4 个运行状态 = 780 个场景**，全自动派生。

## 为什么需要独立 harness

| 已有测试 | 覆盖 | 盲区 |
|---|---|---|
| `test/browser/workflowComfyNodeStyle.test.ts` | canvas 绘制数值（mock ctx） | 看不见真实渲染 |
| `webview/e2e/run.mjs` | store↔graph 数据模型、clip-path 几何 | 无 DOM、无像素 |
| `test/smoke/.../workflowVisual.test.ts` | 暗色主题启动 | **无法穿透 webview iframe** |

突破口：**节点卡片是纯 React DOM**（`nodeCard.tsx`，91 处 inline style + 仅依赖 8 个
VS Code CSS 变量），注入 `__vssarosBridge` mock 后即可在普通浏览器独立渲染。

## 三层结构

```
L1  Gallery Harness（人工可视化）   visual/harness.tsx → 浏览器打开即看全部节点
L2  Playwright 契约 + 截图基线      visual/visual.spec.mjs → 12 条断言 + 像素 diff
L3  几何/层级数值断言（已有）        e2e/entry.mjs（坐标映射 / clip-path / z-index）
```

## 命令

```bash
cd src/vs/sessions/contrib/agentStudio/webview

npm run visual            # 构建 + 起服务 → 浏览器看画廊
npm run visual:dom        # 仅 DOM 断言（快，~40s，无需基线）
npm run visual:test       # DOM 断言 + 截图 diff
npm run visual:baseline   # 重新生成基线（UI 有意变更后执行）

# 单节点诊断（定位白屏最快手段：DOM 树 + innerText + console/pageerror）
node visual/visual.spec.mjs --dump=ComfyTV.MaterialStage:success
node visual/visual.spec.mjs --only=ComfyTV.ImageStage      # 只跑一个节点
```

## L1：Gallery Harness

把 `getAllSpecs()` 里**每个节点**用 `getNodeCardMeta()` 生成 meta，渲染成卡片网格。

- **零后端**：假图是内联 SVG data URL；`installNetworkGuard()` 拦截一切真实请求
- **状态矩阵**：`idle / running / success / error`
- **上游注入**：预填 `MediaSnapshotStore` 3 张确定性假图 → picker pool、
  内嵌编辑器背景图、OUTPUT 区都有内容
- **URL 参数**：`?only=<type>` / `?state=<s>` / `?upstream=0`

## L2：契约断言（12 条）

**★ 核心设计：期望值一律从 `meta` 和 `stageCardRegistry` 派生，绝不从 `spec` 派生。**
`spec.widgets` 是注册表原始声明，而卡片实际渲染的是 `meta.controls`（已过滤
hidden fields / 专用编辑器接管的字段）。用 `spec` 做期望值会产生数百条误报
（实测首版 620 条 `no-controls` 全为误报）。

| # | 规则 | 捕捉的 bug 类别 | 历史案例 |
|---|---|---|---|
| R1 | 卡片高度 ∈ [24, 2000]px | 塌陷 / 无限增高 | ★ 本轮抓到 MaterialStage 白屏 |
| R2 | 无子元素横向溢出宿主 | 宽度写死 | 第 81 轮 `VIEW_W=360`；2026-08-20 EmojiStage stepper 双列横排溢出 22~33px |
| R3 | 图片 `naturalWidth > 0` | 图裂 | 第 73 轮 localResourceRoots |
| R4 | `meta.controls` 每项都在 DOM 中<br>（豁免 `stageHiddenFields`） | 参数漏渲染 | 第 82 轮 Upscale 缺 scale |
| R5 | `hasPrompt` ⇒ textarea 存在<br>（多 textarea 仅对 editorKind=none 判 FAIL——专用编辑器多输入区是有意设计） | prompt 漏渲染 | 第 84/85 轮 |
| R6 | textarea ≤ 1（同上豁免） | 专用编辑器与通用 prompt 双渲染 | 第 87 轮 |
| R7 | `error` 态 ⇒ 显示 errorMsg | 错误静默 | — |
| R8 | `success` 态 ⇒ 有 OUTPUT 区<br>（豁免 `flags.hideOutput`） | 输出区不显示 | 第 69 轮 runState 门控 |
| R9 | picker pool 计数 == 注入的上游图数 | 去重/累积语义 | 第 76/79 轮 |
| R10 | `actions` ⇒ 渲染成可点按钮 | actions 门控回归 | 第 80 轮 |
| R11 | 无「有子元素但高度 0」的容器 | 塌陷征兆 | — |
| R12 | 宿主宽度 == 280px | 溢出断言基准被 CSS 改坏 | — |
| R13 | 编排节点（Saros.*）的 agentId/providerId/<br>modelId/skillName/toolName COMBO 显示值非 "—" | 下拉框回归为空 | ★ 2026-08-20 用户报告的 bug 类别 |
| R14 | DOM 卡**不得**渲染端口胶囊（`.wf-comfy-ports` 计数 = 0）<br>—— 端口由 LiteGraph canvas 独占渲染 | canvas 端口 + DOM 胶囊双显 | ★ 2026-08-20 用户删 PortBar 后反转（双显 = 重复 UI） |
| R15 | ComfyTV 完全复刻 token 契约：<br>a) 参考卡保真（truth ↔ spec 同步）<br>b) 本项目卡（`.wf-comfy-card` 内层面板）背景 #1e1e1e /<br>字号 12px / padding 8px / gap 8px | 样式漂移离 ComfyTV 真源 | ★ 2026-08-20 用户要求完全复刻 |
| R16 | ComfyTV 节点 success 态必须有参考卡：iframe 真实源码快照（优先）或手绘 token 卡（降级） | 「绘制 ComfyTV 源码 UI + 同页对比」链路断裂 | ★ 2026-08-20 用户要求 |

**R13 的渲染前提 —— harness store seeding**：编排节点的动态 COMBO 选项来自
`useAgentStore` / `usePicklistStore` / `useProviderStore` 三个全局 store（不喂数据
时控件永远显示 "—"，截图基线固定为"空下拉"，测不出 resolveControlOptions 的双语义
路由）。`harness.tsx` 里的 `DEMO_AGENTS/SKILLS/TOOLS/PROVIDERS` 与
`ORCH_PROP_SEEDS`（属性种子值 = 选项 value = id）**必须成对维护**：新增一个要从
store 取选项的字段，两边都要登记，否则 R13 直接 FAIL（这就是设计意图——断链即刻暴露）。

**WebGL 环境豁免**：Multiangle/Relight/Material 等 Three.js 编辑器节点在无 GPU/被
策略禁用（iOA）的环境会 context 创建失败 → 塌陷。runner 启动时先探测 WebGL，
不可用则**整体跳过**这些场景（报告里 note），避免把环境性失败误报成 UI 回归
（2026-08-20 实测 swiftshader 被禁后 12 条假 FAIL）。

**ComfyTV 参考卡比对体系（2026-08-20，R15）**：用户要求节点 UI「根据 ComfyTV 源码
绘制、与本项目节点 UI 比对、完全复刻」。落地为三层：

1. `comfyTvTruth.ts` —— **样式真源**。token（色板/字号/布局）逐字提取自 ComfyTV
   源码（`src/tailwind.css` @theme + `src/components/stages/StageCard.vue` cardClass），
   每项注明出处。是 R15 断言与参考卡的唯一依据。
2. `comfyTvReference.tsx` —— **参考卡渲染器**。用真源 token 直出 ComfyTV 标准卡
   骨架（MainPrompt → preset bar → params → run-btn → progress → OUTPUT，对齐
   StageCard 模板顺序）。harness 在每个 success 态场景**并排渲染**参考卡（左）
   与本项目卡（右），同一份种子数据 —— 唯一变量是样式，肉眼比对
   「只有样式差异」。基线 PNG 自带双卡对比。
3. `visual.spec.mjs` **R15 双向断言**：a) 参考卡保真（computed style 与 spec 内联
   CTV 字面量一致 —— 守护 truth↔spec 同步，参考失真 = 比对基准失真）；b) 本项目
   卡 token 对齐（背景/字号/padding/gap 与真源一致，漂移即 FAIL 并给出实际 vs
   期望的可执行复刻清单）。

复刻落地记录（2026-08-20 首轮）：nodeCard 内层面板 `linear-gradient(38,38,46→24,24,28)`
→ `#1e1e1e`；根字号 11→12px（text-xs）；SectionLabel 9→10px（text-2xs）；
padding `4px 4px 6px`→`8px`（p-2）；gap 3→8px（gap-2）。

### ★ 真实源码快照（iframe）——「绘制 ComfyTV 源码节点 UI」的正解（2026-08-20）

手绘 token 卡（`comfyTvReference.tsx`）是「按 token 复刻的近似」，用户进一步要求
**真正渲染 ComfyTV 源码的节点 UI**。落地为**真实 StageCard 渲染 → HTML 快照 → iframe 同页对比**：

**ComfyTV 侧**（`G:\CustomWorkspaces\AIProjects\ComfyTV`，独立仓库）：
1. `src/components/stages/__tests__/stageCardRender.test.ts` —— 用 vitest +
   `renderWithPlugins`（已 mock `@/lib/comfyApp` 的 app + pinia + i18n）渲染**真实
   `StageCard.vue`**（含 MainPromptInput / CustomParamsSection / StagePresetBar /
   ValuePreview / run-btn / progress / OUTPUT 全部真实子组件），导出
   `container.innerHTML` 到 `src/components/stages/__snapshots__/nodeUI/<name>.html`
   （9 个节点形态：4 loader + 3 generator + 1 transform + 1 picker）。
   运行：`npx vitest run src/components/stages/__tests__/stageCardRender.test.ts`
2. `npx @tailwindcss/cli@4.3.2 -i src/tailwind.css -o .../nodeUI/comfytv-node-ui.css`
   —— 生成 ctv 前缀 tailwind CSS（108KB），让快照 HTML 有视觉。

**本项目侧**（visual）：
3. `visual.spec.mjs` —— Node 侧读 ComfyTV 快照（HTML + CSS），`addInitScript` 注入
   `window.__comfytvSnapshots`；`COMFTV_SNAPSHOT_MAP` 把本项目 nodeType 映射到快照名
   （transform/generator 大类共用一个骨架快照）。
4. `harness.tsx` —— 参考卡优先渲染 iframe srcdoc（真实快照 + ctv CSS），缺失降级
   手绘卡。R16 断言 success 态必有参考卡。

**关键事实**：① ComfyTV 依赖未装（node_modules 缺失），需 `npm ci --legacy-peer-deps`
（zod v4/v3 peer 冲突）；② 静态 `import StageCard` 在 vitest 收集时**挂起**（vue
plugin transform 卡住），必须**动态 `await import`** 绕过；③ run-btn 显示规则
（StageCard.vue 真源）`v-if="variant !== 'loader' && variant !== 'transform' && !isPicker"`
—— 只有 generator（非 picker）显示 run 按钮；④ loader 无 run-btn 是正确行为（选文件
而非运行），断言须按变体区分；⑤ `COMFTV_DIR` 环境变量可覆盖 ComfyTV 路径（默认
`G:\CustomWorkspaces\AIProjects\ComfyTV`）。

**极简卡片豁免**：`metaControls==0 && metaActions==0 && !hasPrompt && !isPicker`
的节点（`Bridge*` 等纯路由节点）天生只有一条标题栏，R1/R7/R8 对其豁免。

### 截图基线

`visual/baseline/<nodeType>__<state>.png`，**逐节点独立文件** → 改一个节点只有一张图 diff。

两个必须解决的稳定性陷阱（首版都栽了，实测像素差 98%）：

1. **PNG 不能逐字节比较** —— IDAT 是 zlib 压缩流，改 1 个像素会让整个流重排。
   `visual.spec.mjs` 内置零依赖 PNG 解码器（`node:zlib` + 手写 unfilter，
   支持 8-bit colorType 2/6 非交错 = Playwright 截图格式），解码到 RGBA 后
   逐像素比，通道容差 8/255 抵消抗锯齿抖动。
2. **必须冻结动画** —— running 态进度条 / transition / 光标闪烁。
   `index.html` 的 `body[data-vt-freeze="1"]` 规则用 `!important` 强制
   `animation-duration:0 / transition:none / caret-color:transparent`
   （`!important` 是必须的，因为 nodeCard 用 inline style 写 transition）。

**第三个陷阱：必须等布局收敛**（第二轮才暴露）。
卡片高度有多个**异步**来源：React effect → `markFormHeightDirty` → rAF 读
`scrollHeight`、`ResizeObserver`（TransformEditor / OutpaintEditor 的自适应宽度）、
Three.js 首帧。单节点手动跑时早已收敛，但**批量跑 780 场景连续 goto** 会截到中间态
—— 实测卡片高度比稳定值小 17~25px，症状是「刚生成的基线立刻重跑就全量 diff」
（680/780）。修法：`harness.tsx` 的 `waitForStableLayout()` 轮询所有卡片高度签名，
**连续 3 帧不变**才置 `data-vt-ready`；另加 `document.fonts.ready`（首个全新
browser context 的 fallback 字体行高与最终字体不同）。诊断值写入 `data-vt-settle`，
`timeout@N` 会在报告里以提示暴露，不静默。

容差：普通节点 0.5%，WebGL 节点（Multiangle/Relight/Material/Scene3D）2%。

**基线体积**：全量 780 张 ≈ 10.3 MB。若不希望入库这么多，建议只提交核心节点
（ImageStage / VideoStage / picker / 各专用编辑器）的基线，其余本地按需生成。

## 运行成果（2026-08-15）

**780 场景 → 780 全部通过。** 方案共抓出并修复 **6 个真 bug**。

### 第一轮：3 个白屏级 bug

| Bug | 症状 | 根因 | 修复 |
|---|---|---|---|
| MaterialStage 等 6 个节点整张卡片空白 | 高度仅 10~26px，innerText 为空 | `showRun` 只认 `kind==='schema'`，而这些节点注册为 `kind:'native'` → 控件/编辑器/prompt 三块全被跳过 | 新增 `LOCAL_EDITOR_NODE_TYPES` 白名单 |
| `ReferenceError: runners is not defined` | MaterialEditor 崩溃 | 第 87 轮引用了作用域里不存在的 `runners`/`preference` | 改走 `getActiveRunnerRegistry()`（与 MaskPainter 同款） |
| `Cannot access 'uploadRender' before initialization` | MaterialEditor 白屏 | `scheduleUpload` 的依赖数组引用了后面才 `const` 声明的 `uploadRender` → TDZ | 交换声明顺序 |

> 三者叠加导致「第 86/87 轮做的 Relight 3D 灯光球 + Material PBR 材质球从未真正显示过」，
> 而当时的记录只写了"待用户重启验证"。修复后 MaterialStage 从 26px → **827px**。

### 第二轮：3 个布局/可见性 bug

| Bug | 症状 | 根因 | 修复 |
|---|---|---|---|
| `MultiangleStage` 横向溢出 **171px** | H/V/Z 下拉冲出卡片 | `CameraControlPanel` 照搬 ComfyTV 的**单行 7 项 flex**（3 下拉+3 数值+1 按钮）需 ~605px，而本项目卡片固定 280px；且 `<select>` 作为 flex item 的 `min-width:auto` = min-content（最长 option "front-right quarter" ≈117px）**无法收缩** | 改竖排：每控件一行 grid `[14px, minmax(0,1fr), 42px]`，`select` 显式 `minWidth:0 + width:100%`，重置按钮独占一行右对齐 |
| `OutpaintStage` 横向溢出 | 图 + 左右 handle 共 336px | `IMG_DISPLAY_W = 300` 写死 | 图列改 `minmax(0, 1fr)` 吃剩余宽度（CSS 决定布局），`ResizeObserver` 只回读实际宽度供 `scale` 用 —— 打破「scale ← 图宽 ← handle 宽 ← scale」循环依赖 |
| 三个 Picker 的 `error` 态无任何提示 | 用户只看到 picker 毫无反应 | `RunProgress`/`ErrorBanner` 被包在 `{showRun && …}` 里，而 picker 的 `showRun=false`。但 `runPickerNode` 确实会返回「选择器没有上游候选」「媒体库资产不可用」等错误 | 抽出 `runFeedback` 片段，`showRun` 真/假两条路径共用（对现有节点零视觉变化） |

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架：8 个 VS Code CSS 变量 + 动画冻结规则 + 280px 卡片宿主 |
| `mocks.ts` | `__vssarosBridge` mock、确定性假图、网络守卫 |
| `fixtures.ts` | 场景枚举（registry 派生），`buildScenarios` 纯函数 |
| `harness.tsx` | 渲染入口；`waitForImages` / `waitForStableLayout`；把 meta + stageCardRegistry 的期望值写成 `data-vt-*` |
| `build.mjs` | esbuild 构建 + 静态服务（`--serve` / `--watch`） |
| `visual.spec.mjs` | 12 条断言 + 截图基线 + PNG 解码器 + `--dump` 诊断 |
| `baseline/` | 截图基线（提交入库） |
| `dist/`, `actual/`, `diff/`, `report.md` | 运行产物（已 gitignore） |

## 关键约束

- **mock 必须先于 `nodeCard` 导入**：`nodeCard.tsx` 顶层解构 `__vssarosBridge`，
  模块求值即抛错 → `harness.tsx` 用 `await import()` 动态导入。
- **假图必须确定性**：内联 SVG（固定尺寸/颜色），否则截图基线永远 diff。
- **卡片宿主必须是 280px**：与画布上真实节点宽度一致，否则「宽度写死」类 bug 测不出来。
- **新增带内嵌编辑器的 `kind:'native'` 节点**：必须登记进 `nodeCard.tsx` 的
  `LOCAL_EDITOR_NODE_TYPES`，否则整张卡片空白（R1 会拦住）。
- **新增专用编辑器接管的字段**：登记进 `stageCardRegistry.STAGE_HIDDEN_FIELDS`，
  R4 会自动豁免；不登记则报 `control-missing`。
- **移植 ComfyTV UI 时注意宽度前提**：ComfyUI 节点可拖宽，本项目节点卡片固定 280px。
  照搬单行横排布局必定溢出（Multiangle 案例）。优先竖排 / grid `minmax(0,1fr)`。
- **`<select>` / `<input>` 放进 flex 或 grid 必须显式 `minWidth: 0`**：
  默认 `min-width:auto` 等于 min-content（最长 option / 输入内容宽度），不可收缩。
