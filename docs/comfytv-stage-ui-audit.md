# ComfyTV 节点 UI/功能 复刻审计

> 审计对象：用户指定的 20 个 action（对应 13 类 ComfyTV stage 节点）
> 参考真值：`G:\CustomWorkspaces\AIProjects\ComfyTV`（nodes/stages/*.py 后端 schema + src/ Vue 前端）
> 当前实现：`sarosis-agents-client` webview `comfyHost/`
> 维度：①控件/参数 ②特殊编辑器 ③输出/数据流 ④执行语义

---

## 0. 总体结论（差距概览）

| # | Action | Stage 类型 | ComfyTV 富交互编辑器 | VsSaros 现状 | 差距 |
|---|--------|-----------|---------------------|--------------|------|
| 1 | HD | `UpscaleStage` | 无（通用卡片：workflow+scale） | 通用表单（workflow+scale combo） | ✅ 已对齐 |
| 2 | Outpaint | `OutpaintStage` | **方向拖拽手柄 + 棋盘格 padding 画布 + 数字输入** | ✅ 已建 `OutpaintEditor.tsx`（四向拖拽 + feathering + 尺寸预览） | ✅ 已复刻 |
| 3 | Inpaint | `InpaintStage` | 蒙版画笔 + prompt | MaskPainter（已挂载） | ⚠️ 需核对笔刷/矩形/椭圆工具与对齐 |
| 4 | Erase | `EraseStage` | 蒙版画笔（无 prompt） | MaskPainter（已挂载，showPrompt=false） | ⚠️ 需核对 |
| 5 | Cutout | `CutoutStage` | 无（通用：workflow combo） | 通用表单 | ✅ 已对齐 |
| 6 | Crop | `CropStage` | 拖拽裁剪框（x/y/w/h） | CropEditor（已挂载，instant） | ⚠️ 需核对框体交互 |
| 7 | Rotate | `RotateStage` | 角度滑块 -180..180 | instant 节点，angle 滑块 | ✅ 已对齐 |
| 8 | Mirror | `MirrorStage` | flip_horizontal / flip_vertical 开关 | instant 节点，h/v 开关 | ✅ 已对齐 |
| 9 | Color Grade | `ColorGradeStage` | **调色面板（6 效果 + 标量/整型/布尔/曲线 + 重置，grade_state JSON 驱动）** | ✅ 已建 `ColorGradeEditor.tsx`（效果下拉 + 渐变滑杆 + 曲线编辑器 + 重置） | ✅ 已复刻 |
| 10 | Grid Split | `GridSplitStage` | **行列/边框网格编辑器 + 实时预览 + selected_index** | ✅ 已建 `GridSplitEditor.tsx`（预设 + 步进 + 可视化网格 + 选中格高亮） | ✅ 已复刻 |
| 11 | Ken Burns | `KenBurnsStage` | 实际仅是滑块卡片（width/height/fps/duration/start/end zoom·x·y/interp）+ 静态图预览，**无**专门视口拖拽编辑器 | 通用表单已含上述滑块 | ✅ 已覆盖（无需专门编辑器） |
| 12 | Face/Product/Character 3-view, Multi-cam 9-grid, Story Progression, 25-grid Storyboard | `ImageVariationsStage` | workflow 分组预览（multiview/sequence）+ variant_count 滑块可视化 | `registry` 分组下拉 + `ComboPopover` 分组头 + `variant_count` 滑块 + prompt | ✅ 已复刻 |
| 13 | Cinematic Lighting, Project +3s, Project +5s | `ImageEditStage` | 无（通用：workflow + 指令式 prompt） | 通用表单 | ✅ 已对齐 |

**已新建富交互编辑器 3 个**：`OutpaintStage`、`ColorGradeStage`、`GridSplitStage`（见各自 `.tsx` + `nodeCard.tsx` 接线，写回均经 `wf-node-control`）。
**重评估**：`KenBurnsStage` 在 ComfyTV 中无专门视口编辑器（仅滑块卡片），VsSaros 通用表单已等价覆盖，故无需新建。
**需核对保真度的 3 个**（已有编辑器）：`InpaintStage`、`EraseStage`、`CropStage`。
**已对齐 8 个**：`UpscaleStage`、`CutoutStage`、`RotateStage`、`MirrorStage`、`ImageEditStage`、`ImageVariationsStage`（含 workflow 分组下拉 + variant_count 滑块 + prompt）、`KenBurnsStage`（滑块 + interp + 源图预览）。

**Inpaint/Erase/Crop 保真度已提升（2026-08-14）**：
- `MaskPainter.tsx` + `comfyHost/maskPainter.ts`：从 4 工具升级到 6 工具（新增 `fill` 吸管式 flood fill、`label` 编号圆点），新增 `opacity`(不透明度) / `hardness`(硬度) 滑块 → 软笔刷产生**灰度软边蒙版**（对齐 ComfyTV `getEffectiveBrushSize` / `drawCircle` / `compositeStrokeToMain`）；`renderMaskBlob` 白底+destination-out 语义不变，软笔刷下输出灰度半透明蒙版，与 ComfyTV 后端一致。floodFill 移植自 `widgets/painter/floodFill.ts`（alpha 连通区匹配，tolerance=32）。
- `CropEditor.tsx` + `comfyHost/cropEditor.ts`：新增长宽比锁定下拉（自由/1:1/3:4/4:3/16:9/9:16），`enforceAspect` 按手柄对侧角锚定回正比例（对齐 ComfyTV `useImageCrop` 的 `ASPECT_RATIOS` / `applyAspectRatioToNewSelection`）；切换比例即时重约束当前框。
- 三个编辑器均 `node esbuild.config.mjs` 构建 + 同步 `out/`，lint 0 / 构建 exit 0。

---

## 1. UpscaleStage（action: HD）

**ComfyTV ①控件**：`workflow`(Combo, labels_for('upscale'))、`scale`(Combo, ["2x","4x"] def "2x")、`main_prompt`(String multiline, 可选)、`image`(输入)、`custom_params`。
**ComfyTV ②编辑器**：无专用卡片，走通用 `StageCard`（MainPromptInput + StagePresetBar）。
**ComfyTV ③输出**：`COMFYTV_IMAGE`（单图）。**④执行**：generative（run_stage_workflow kind='upscale'）。

**VsSaros 现状**：`kind:'image', workflowKind:'upscale'`，通用表单 = workflow combo（options 来自 `/comfytv/workflows` 动态填充）+ Run。无 prompt widget（`hasPrompt` 视 meta）。输出经 `SnapshotPreview` 缩略图。
**差距**：参数层面已对齐。仅需确认 scale 下拉项（2x/4x）是否在 caps 表单中呈现。→ ✅ 基本复刻完成。

---

## 2. OutpaintStage（action: Outpaint）  ❌ 缺富编辑器

**ComfyTV ①控件**：`workflow`(Combo outpaint)、`pad_left/top/right/bottom`(Int 0–4096, **hidden**, 由前端拖拽驱动)、`feathering`(Int 0–256, hidden)、`main_prompt`(multiline 中文占位)、`image`、`custom_params`。
**ComfyTV ②编辑器**（关键差异）：`OutpaintStageCard.vue` + `useOutpaintCanvas` composable：
- 中央显示源图，四周半透明**棋盘格 padding 区**（dashed 主色边框）。
- 四边各有**圆形拖拽手柄**，拖动实时改 `pad_*`，旁显 `NNNpx` 徽标。
- 下方数字输入框（min0/max4096/step8）+ reset，实时显示输出尺寸 `outDims`。
**ComfyTV ③输出**：`COMFYTV_IMAGE`。**④执行**：generative（run_stage_workflow kind='outpaint'，options 传 pad/feathering）。

**VsSaros 现状**：`kind:'image', workflowKind:'outpaint'`，仅 workflow combo + Run。**pad_*/feathering 完全缺失 UI**（hidden 参数在后端，但前端无拖拽/数字输入驱动）。
**差距**：需新建 `OutpaintEditor`（棋盘格 canvas + 四向拖拽手柄 + 数字输入 + 输出尺寸预览），写回 `pad_left/top/right/bottom` 与 `feathering`。→ ❌ 未复刻。

---

## 3. InpaintStage（action: Inpaint）  ⚠️ 核对保真

**ComfyTV ①控件**：`workflow`(Combo inpaint)、`mask_data`(String hidden, 蒙版 PNG base64)、`main_prompt`(multiline)、`image`、`custom_params`。
**ComfyTV ②编辑器**：`MaskPainter`——画笔/橡皮/矩形/椭圆工具，源图作背景，涂抹生成白底 mask（destination-out 导出）。
**ComfyTV ③输出**：`COMFYTV_IMAGE`。**④执行**：generative（options={'mask_data'}）。

**VsSaros 现状**：`nodeCard.tsx` `isMaskEdit` 命中 inpaint → 挂载 `<MaskPainter>`，`imageRef={upstreamImageRef}`，`showPrompt={false}`（prompt 由卡片上方 inline textarea 负责），写回 `mask_data`/`mask_ops` 经 `commitMaskField`。
**差距**：编辑器已挂载，参数对齐。需核对：工具集是否含 矩形/椭圆（ComfyTV 有）；导出 PNG 对齐（白底 + destination-out）是否与 ComfyTV `commitMaskField` 一致；prompt 是否在上层 textarea 正确桥接。→ ⚠️ 保真核对后即可。

---

## 4. EraseStage（action: Erase）  ⚠️ 核对保真

**ComfyTV ①控件**：`workflow`(Combo erase)、`mask_data`(hidden)、`image`、`custom_params`（**无 main_prompt**，后端用字面填充 prompt）。
**ComfyTV ②编辑器**：同 MaskPainter（无 prompt）。
**ComfyTV ③输出**：`COMFYTV_IMAGE`。**④执行**：generative，main_prompt=''。

**VsSaros 现状**：`isMaskEdit` 命中 erase → MaskPainter `showPrompt={false}`，无 prompt textarea。与 ComfyTV 一致。
**差距**：同 Inpaint 保真核对。→ ⚠️ 保真核对后即可。

---

## 5. CutoutStage（action: Cutout）  ✅ 已对齐

**ComfyTV ①控件**：`workflow`(Combo cutout)、`image`、`custom_params`（分割后端，无 mask/prompt）。**②③**：通用卡片，无富编辑器。**④**：generative。
**VsSaros 现状**：`kind:'image', workflowKind:'cutout'`，通用表单。→ ✅ 已对齐。

---

## 6. CropStage（action: Crop）  ⚠️ 核对保真

**ComfyTV ①控件**：`crop_x/y/w/h`(Int 0–8192, hidden, 由前端驱动)、`image`。**②编辑器**：拖拽裁剪框（x/y/w/h），源图叠加半透明遮罩，拖动手柄实时改 crop_*。
**ComfyTV ③输出**：`COMFYTV_IMAGE`。**④执行**：**instant**（Python execute 直接 return image，前端 useTransformPipeline 计算预览）。

**VsSaros 现状**：instant 节点（isInstantNode）+ `CropEditor` 挂载，`cropRect`/`applyInstantDraw` 在 Canvas 绘制。**✅ 已具备裁剪框 + instant 预览**。
**差距**：核对框体交互（拖拽/缩放手柄、约束在源图内、实时输出尺寸）与 ComfyTV 一致即可。→ ⚠️ 保真核对。

---

## 7. RotateStage（action: Rotate）  ✅ 已对齐

**ComfyTV ①控件**：`angle`(Int -180..180, hidden, 滑块驱动)、`image`。**②**：角度滑块。**③**：`COMFYTV_IMAGE`。**④**：instant。
**VsSaros 现状**：instant（angle 滑块，默认 90）。→ ✅ 已对齐。

---

## 8. MirrorStage（action: Mirror）  ✅ 已对齐

**ComfyTV ①控件**：`flip_horizontal`(Boolean)、`flip_vertical`(Boolean)、`image`。**②**：两个开关。**③**：`COMFYTV_IMAGE`。**④**：instant。
**VsSaros 现状**：instant（horizontal/vertical 开关）。→ ✅ 已对齐。

---

## 9. ColorGradeStage（action: Color Grade）  ❌ 缺富编辑器

**ComfyTV ①控件**：`grade_state`(String hidden, JSON of 选中效果+滑块值, 由 Vue 面板驱动)、`image`。
**ComfyTV ②编辑器**（关键差异）：调色面板（色轮/曲线/滑块），用户调整亮度/对比/饱和度/色温/曲线等，序列化为 `grade_state` JSON 写回隐藏字段。
**ComfyTV ③输出**：`COMFYTV_IMAGE`。**④执行**：instant（Python execute 直接 return image —— 实际调色在浏览器端或轻量后端）。

**VsSaros 现状**：`kind:'image', variant:'transform'`，**未列入 instantNodes**（非 Crop/Rotate/Mirror），走通用 schema 表单或后端 generative —— **无调色轮/曲线面板**，grade_state 不可编辑。
**差距**：需新建 `ColorGradeEditor`（调色控件 + 序列化 grade_state），并建议按 ComfyTV 语义改为 instant 浏览器端调色（Canvas filter / LUT）。→ ❌ 未复刻。

---

## 10. GridSplitStage（action: Grid Split）  ❌ 缺富编辑器

**ComfyTV ①控件**：`rows`(Int 1–10 hidden)、`cols`(Int 1–10 hidden)、`border`(Int 0–4096 hidden)、`outer_border`(Boolean hidden)、`image`、`selected_index`。
**ComfyTV ②编辑器**（关键差异）：网格编辑器（行/列滑块 + 边框宽度 + 外边框开关），实时显示网格划分预览。
**ComfyTV ③输出**：`COMFYTV_IMAGES`(批量) + `COMFYTV_IMAGE`(selected_index 选中)。**④执行**：generative（返回 images JSON，selected_index 选帧）。

**VsSaros 现状**：`kind:'image-batch', variant:'transform'`，通用表单（隐藏参数无 UI），输出经 `SnapshotPreview` 网格 + `BATCH: N`。
**差距**：需新建 `GridSplitEditor`（rows/cols/border/outer 控件 + 网格预览），并正确连接 `selected_index` 选帧逻辑。→ ❌ 未复刻。

---

## 11. KenBurnsStage（action: Ken Burns）  ✅ 已复刻

**ComfyTV ①控件**：`width/height/fps/duration`(hidden int/float)、`start_zoom/end_zoom`(1.0–6.0)、`start_x/y/end_x/y`(0.0–1.0)、`interp`(Combo linear/smooth/ease_in/ease_out)、`image`。
**ComfyTV ②编辑器**：**无专门视口拖拽编辑器**——`KenBurnsStageCard.vue` 仅是「FxSlider 滑块卡片」（width/height/fps/duration/start·end zoom·x·y + interp 芯片 + 顶部静态源图预览）。此前审计误记为 pan/zoom 关键帧编辑器，已更正（复核 ComfyTV 源码 `KenBurnsStageCard.vue` 确认）。
**ComfyTV ③输出**：`COMFYTV_VIDEO`。**④执行**：generative（ken_burns_video，需上游 image）。

**VsSaros 现状**：`kind:'video'`，经 `kenBurnsWidgets` 注册——渲染 width/height/fps/duration/start_zoom/end_zoom/start_x/start_y/end_x/end_y（INT/FLOAT range 滑块，min/max/step 精确对齐 ComfyTV）+ interp（COMBO）+ 顶部「引用」上游源图预览。**已对齐 ① 全部滑块 + ② 静态图预览形态**。
**差距**：已消除（ComfyTV 本身即滑块卡片，无专门编辑器需求）。→ ✅ 已复刻。

---

## 12. ImageVariationsStage（actions: Face/Product/Character 3-view, Multi-cam 9-grid, Story Progression, 25-grid Storyboard）  ⚠️ 缺 workflow 预览

**ComfyTV ①控件**：`workflow`(Combo = labels_for('multiview') + labels_for('sequence'))、`variant_count`(Int 1–25 滑块, 信息性)、`main_prompt`(multiline)、`image`、`selected_index`、`custom_params`。
**ComfyTV ②编辑器**：workflow 选择器带分组/预览（multiview vs sequence），variant_count 可视化。
**ComfyTV ③输出**：`COMFYTV_IMAGES` + `COMFYTV_IMAGE`。**④执行**：generative（kind=multiview|sequence）。

**VsSaros 现状**：`kind:'image-batch', workflowKind:'multiview'`，`registry.imageVariationsWidgets()` 显式合并 `labels_for('multiview') + labels_for('sequence')` 为分组下拉（Multi-view / Sequence 两组），`variant_count`(Int 1–25 滑块) + `prompt`(multiline) 一并注入；`runStageWorkflow` 按选中 label 跨 multiview/sequence 解析真实 kind（对齐 ComfyTV `kind=multiview|sequence` 运行时推断）。
**差距**：已消除。group 头由 `ComboPopover` 渲染，滑块由 `nodeCard` 专属分支渲染。→ ✅ 已复刻。

---

## 13. ImageEditStage（actions: Cinematic Lighting, Project +3s, Project +5s）  ✅ 已对齐

**ComfyTV ①控件**：`workflow`(Combo image-edit)、`main_prompt`(multiline 指令式)、`image`、`custom_params`。**②③**：通用卡片。**④**：generative。
**VsSaros 现状**：`kind:'image', workflowKind:'image-edit'`，通用表单（workflow combo + 指令式 prompt textarea）。→ ✅ 已对齐。
（注：Cinematic Lighting/Project +Ns 是 image-edit 下的不同 workflow label，复用同一 Stage 卡片，符合 ComfyTV 设计。）

---

## 复刻优先级建议（富交互编辑器）

1. **P0（核心缺失，UI 最显眼）**：
   - `OutpaintStage` —— 棋盘格拖拽手柄编辑器
   - `ColorGradeStage` —— 调色轮/曲线面板（并改为 instant 浏览器端调色）
2. **P1（批量/视频，交互性强）**：
   - `GridSplitStage` —— 网格编辑器 + selected_index ✅ 已完成
   - `KenBurnsStage` —— ✅ 已完成（滑块 + interp + 源图预览；经复核 ComfyTV 无专门 pan/zoom 编辑器）
3. **P2（保真核对，已有编辑器）**：
   - `InpaintStage` / `EraseStage` —— MaskPainter 工具集与对齐核对
   - `CropStage` —— CropEditor 框体交互核对
4. **P3（可选增强）**：
   - `ImageVariationsStage` —— workflow 分组预览 ✅ 已完成（2026-08-14）
   - `KenBurnsStage` —— ✅ 已完成（滑块卡片复刻；ComfyTV 本身无专门 pan/zoom 编辑器）

每个编辑器落地模式（与现有 CropEditor/MaskPainter 一致）：在 `nodeCard.tsx` 增加路由（如 `isOutpaint`/`isColorGrade`/`isGridSplit`/`isKenBurns`），按 `meta.title`/`workflowKind` 挂载对应 `*Editor.tsx`，编辑器写回隐藏字段（pad_*/grade_state/rows/cols/...）至 spec 值存储，保持 instant 预览（Crop/Rotate/Mirror/ColorGrade）与 generative 运行（Outpaint/GridSplit/KenBurns）两种语义不变。
