# Storyboard Editor 移植设计方案

> 目标：将 ComfyTV 的 Storyboard Editor（分镜画板）完整移植到本项目（sarosis-agents-client 工作流编辑器）。
> 分析基准：`G:\CustomWorkspaces\AIProjects\ComfyTV` 源码。

---

## 1. 架构对比

| 维度 | ComfyTV | 本项目 | 移植影响 |
|---|---|---|---|
| 前端框架 | Vue 3 + Composables | React + Hooks | 需翻译，逻辑可复用 |
| 图层编辑器 | `@jtydhr88/pentrado`（完整图层系统） | 自研 `LayerEditor`（画笔/矩形/圆/文字/橡皮） | **接口不同**，需适配层 |
| 媒体上传 | `uploadBlob`（后端存储） | `ComfyRunnerRegistry`（ComfyUI runner） | 需换实现 |
| animatic 渲染 | 后端 PyAV（MP4） | **无 Python 后端**（renderer 沙箱） | 需替代方案 |
| LLM 分镜生成 | `StoryboardStage`（后端 16 字段中文 prompt） | 已有 `STORYBOARD_BUILTIN_WORKFLOWS`（Qwen3） | 可复用或 Agent 节点替代 |
| PDF/PSD 导出 | 前端 `pdfExport`/`psdExport` | 无 | PDF 可前端实现，PSD 暂缓 |

**核心约束**：本项目 renderer 沙箱无 Node/Python 后端 —— ComfyTV 依赖后端的三个能力（animatic 渲染、文件上传、LLM 分镜）需要前端化或复用现有 runner。

---

## 2. 现状盘点

### 已移植（数据契约层，~60%）

`storyboardEditor.ts` 已实现：
- ✅ `StoryBoardData` 14 字段 + `StoryboardDoc`
- ✅ `generateBoardUid` / `parseBoardState` / `boardStateToJson`
- ✅ `addBoard` / `removeBoard` / `moveBoard` / `patchBoard`
- ✅ `boardDurationMs` / `boardImageUrl`

### 缺失（数据契约层，~40%）

| 函数 | 作用 | 复杂度 |
|---|---|---|
| `totalDurationMs` | 总时长 | 纯函数，1 行 |
| `shotLabels` | Storyboarder 式镜头标签（"1A"/"1B"，newShot 才递增） | 纯函数 |
| `coverImageUrl` | 封面图 | 纯函数 |
| `boardsToImagesJson` | 图片批次 JSON | 纯函数 |
| `duplicateBoardData` | 复制 board（深拷贝 layerState） | 纯函数 |
| `boardsFromImagesJson` | 图片批次 → boards | 纯函数 |
| `suggestedDurationMs` | 阅读速度估算时长（CJK 150ms/字 + 拉丁 300ms/词） | 纯函数 |
| `boardsFromShotsJson` | LLM shots → boards | 纯函数 |
| **`createBoard` 语义差异** | ComfyTV `newShot:false`，本项目 `newShot:true` | ⚠️ 需对齐 |

### UI 层（~15%）

`StoryboardEditor.tsx` 现状：
- ✅ board 列表按钮（切换/新增/左右移/删除）
- ✅ 名称 + 时长 slider + 对白 + notes
- ✅ 嵌入 `LayerEditor`

缺失：
- ❌ 8 字段完整编辑（当前只做 name/duration/dialogue/notes，缺 action/scenePurpose/character/shotSize/imagePrompt/motionPrompt）
- ❌ 播放 / 循环 / 字幕
- ❌ 洋葱皮（prev/next 半透明叠加）
- ❌ 辅助线（center/thirds/grid）
- ❌ 时间线（TimelineStrip）
- ❌ 拖拽重排 board
- ❌ 复制 board
- ❌ 建议时长按钮
- ❌ 翻转图片
- ❌ newShot 切换
- ❌ 默认时长设置
- ❌ 参考图 seedReference
- ❌ 从上游导入（storyboard shots / images）
- ❌ Fountain 文本导入
- ❌ 图片文件导入
- ❌ 导出 animatic / GIF / Zip

### 执行层（~30%）

`storyboardExecutor.ts` 现状：只 re-emit cover image。

缺失：
- ❌ 多输出（ComfyTV 有 image / images / video 三输出，本项目 registry 只声明了 image）
- ❌ images 批次输出
- ❌ animatic video 输出

---

## 3. 移植方案（分阶段）

### P0 — 数据契约补全（零风险，纯函数）

补齐 `storyboardEditor.ts` 的 9 个纯函数 + 修正 `createBoard` 语义。全部无依赖、可直接单测。

```typescript
// 新增导出
export function totalDurationMs(doc: StoryboardDoc): number;
export function shotLabels(doc: StoryboardDoc): string[];      // 1A / 1B / 2A ...
export function coverImageUrl(doc: StoryboardDoc): string;
export function boardsToImagesJson(doc: StoryboardDoc): string;
export function duplicateBoardData(board: StoryBoardData): StoryBoardData;
export function boardsFromImagesJson(raw: string): StoryBoardData[];
export function suggestedDurationMs(board: StoryBoardData): number | null;
export function boardsFromShotsJson(raw: string): StoryBoardData[];
export function createBoard(partial?: Partial<StoryBoardData>): StoryBoardData; // newShot:false 对齐
```

**验收**：新增 `storyboardEditor.test.ts`（~15 条），覆盖 shotLabels 的 newShot 递增、suggestedDurationMs 的 CJK/拉丁混排、boardsFromShotsJson 的 16 字段映射。

### P1 — React Hook 控制器（核心重构）

把 `useStoryboardEditor.ts`（Vue composable）翻译成 React Hook `useStoryboardEditor`：

```
useStoryboardEditor(initialState, width, height, { onCommitted, onAnimatic })
  → { doc, currentUid, playing, loop, captions, onionPrev/Next, guideCenter/Thirds/Grid,
      selectBoard, addBoard, removeBoard, moveBoard, moveBoardTo, duplicateBoard,
      applySuggestedDuration, flipBoard, setBoardField, setBoardDurationS,
      toggleNewShot, setDefaultTimingS, setBoardRefUrl,
      importFromUpstream, importFromUpstreamImages, importFountainText, importImageFiles,
      exportAnimatic, exportGif, exportBoardsZip, play, stopPlayback, commit }
```

关键适配点：
1. Vue `ref/computed` → React `useState/useMemo`
2. `writeWidget/readWidget` → 本项目 `onStateChange`（board_state JSON 字符串）
3. `useLayerEditorStage`（pentrado）→ 本项目 `LayerEditor` 组件接口（`onDocChange` / `onRenderUploaded`）——**需新增一个 `LayerEditorController` 抽象**，统一两边的 flipImage / flushCapture / reload 等操作
4. `uploadBlob` → `ComfyRunnerRegistry` 上传或 data URL
5. `app.api.fetchApi`（animatic）→ 见 P3

**验收**：`useStoryboardEditor` 可脱离 UI 单测（React Testing Library 或纯逻辑抽取）。

### P2 — UI 组件重构（StoryboardEditor.tsx 重写）

按 ComfyTV 的 `StoryboardEditorStageCard.vue` 结构重组：

```
StoryboardEditor
├─ 工具栏（guide center/thirds/grid · flip H/V · onion prev/next · captions · loop · play/stop · fullscreen）
├─ 画布区（LayerEditor + onion overlay + guide SVG overlay + 播放覆盖层）
├─ 右侧面板（Tab: Board 字段编辑 / Layers 图层列表）
└─ 底部 TimelineStrip（时间线 + import/export 按钮）
```

新增 3 个 React 组件：
- `StoryboardToolBar.tsx` — 工具栏按钮组（对应 Vue 的 LayerEditorToolBar trailing 部分）
- `StoryboardBoardPanel.tsx` — 右侧 board 字段编辑（8 字段：dialogue/action/notes/scenePurpose/character/shotSize/imagePrompt/motionPrompt + 时长 + newShot + 建议时长）
- `StoryboardTimelineStrip.tsx` — 底部时间线（board 缩略图横条 + 拖拽重排 + import/export 按钮）

洋葱皮 / 辅助线 / 播放覆盖层作为 `LayerEditor` 的 overlay props 实现（本项目 LayerEditor 需扩展 overlay 插槽能力）。

**验收**：功能对齐 ComfyTV（除 P3 后端依赖项），视觉对齐现有 mockup 风格。

### P3 — 后端依赖适配（分项评估）

| ComfyTV 能力 | 后端依赖 | 本项目方案 | 优先级 |
|---|---|---|---|
| **animatic MP4** | PyAV | 方案 A：前端 canvas 逐帧 + `MediaRecorder` 合成 WebM（可本地导出，不需后端）；方案 B：复用 ComfyUI runner 的视频 stage | 中（先做 GIF） |
| **GIF 导出** | PyAV | 前端 canvas 抽帧 + `gif.js`（纯前端，零后端） | **高** |
| **图片文件导入** | uploadBlob | FileReader → data URL（复用粘贴图片链路） | **高** |
| **LLM 分镜生成** | StoryboardStage | 复用 `STORYBOARD_BUILTIN_WORKFLOWS`（Qwen3）或 Agent 节点 | 中 |
| **PDF 导出** | 前端 jsPDF | `jsPDF` 纯前端 | 低 |
| **PSD 导出** | 前端 ag-psd | 暂缓（复杂，价值低） | 低 |
| **Fountain 导入** | 纯前端 | 移植 `fountain.ts` 解析器 | 中 |
| **Zip 导出** | 纯前端 | 移植 `zipWriter.ts`（STORE 压缩） | 中 |

**执行层多输出**：registry 里 `StoryboardEditorStage` outputs 从 `[image]` 扩为 `[image, images, video]`（对齐 ComfyTV）；`storyboardExecutor` 支持 re-emit 三个快照。

---

## 4. 关键设计决策

### 决策 1：LayerEditor 控制器抽象

pentrado 的 `useLayerEditorStage` 返回 editor 对象（flipImage/flushCapture/reload/documentIsEmpty/addImageFromUrl）。本项目 `LayerEditor` 是受控组件（onDocChange/onRenderUploaded）。**需要一个薄的 `LayerEditorController` 接口**，让 StoryboardEditor 不感知底层实现：

```typescript
interface LayerEditorController {
  flipImage(axis: 'h' | 'v'): void;
  flushCapture(): void;
  reload(): void;
  documentIsEmpty(): boolean;
  addImageFromUrl(url: string, kind: 'reference'): Promise<void>;
}
```

本项目 `LayerEditor` 需补充 flipImage / addImageFromUrl（reference 图层）能力。

### 决策 2：animatic 降级路径

本项目无 PyAV。**优先做 GIF（纯前端 gif.js）**，animatic MP4 用 `MediaRecorder`（WebM 格式，非 MP4）降级——能力保留但格式/编码有差异，需在 UI 明示。

### 决策 3：LLM 分镜生成复用

不移植 StoryboardStage 后端，复用已有 `STORYBOARD_BUILTIN_WORKFLOWS`（Local Qwen3 4B Storyboard）——已有 api_json 打包，POST /prompt 即得 shots JSON。`boardsFromShotsJson` 负责把 shots 映射进画板。

### 决策 4：newShot 语义对齐

ComfyTV `createBoard` 默认 `newShot:false`（延续上一镜头标签），本项目默认 `newShot:true`。**改为 false 对齐**，否则 shotLabels 的 "1A/1B" 语义失效（每个 board 都成新镜头）。

---

## 5. 实施顺序与风险

| 顺序 | 里程碑 | 交付 | 风险 |
|---|---|---|---|
| 1 | P0 数据契约 | 9 纯函数 + 15 单测 | 无（纯函数） |
| 2 | P1 控制器 | `useStoryboardEditor` Hook | LayerEditor 控制器抽象是关键路径 |
| 3 | P2 UI | 4 个 React 组件 + overlay | LayerEditor overlay 能力扩展 |
| 4 | P3 导入导出 | GIF/Zip/Fountain/图片导入 | gif.js 引入（bundle 体积） |
| 5 | P3 执行层 | 多输出 + executor 扩展 | registry 端口变更需检查下游 |

**兼容红线**：board_state JSON 结构不变（ComfyTV 后端可直接消费）；`newShot` 语义变更只影响新建 board 默认值，存量数据 parse 时已有 `newShot` 字段不受影响。

---

## 6. 结论

移植分 **数据契约（P0，零风险）→ 控制器（P1，核心）→ UI（P2，最大工作量）→ 后端适配（P3，分项降级）** 四阶段。数据契约层已 60% 就绪，P0 可立即落地；P1/P2 是主体工程；P3 的 animatic/LLM 用前端降级 + 现有 runner 替代，**不引入 Python 后端依赖**。

建议按 P0 → P1 → P2 → P3 顺序推进，P0 单独一个 PR（纯函数 + 测试，零风险）。
