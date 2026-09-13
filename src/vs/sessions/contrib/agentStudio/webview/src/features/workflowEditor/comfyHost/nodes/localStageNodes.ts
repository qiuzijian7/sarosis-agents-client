/**
 * localStageNodes — 本地（浏览器内）stage 的声明式收编（2026-09-09 批次 5）。
 *
 * 把 runNodeOrStage 分发链里最后一批硬编码分支（instant/relight/poster/
 * layerEditor/storyboardEditor/material/scene3d/picker/loader 共 15 个 type）
 * 迁入 nodeDefinition 查表。执行器仍在各自 *Executor.ts（单一职责不变），
 * 本文件只做「type → run」的声明式绑定——新增本地 stage 照此一行注册。
 *
 * 注意：fx（builder+chain）与原生 LoadImage 的 bridging 分支暂留硬编码链
 * （fx 需合并上游 values + extractOutputs 变体；LoadImage 有 provider 快照
 * 上传桥接），后续批次再收编。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runInstantNode } from '../instantExecutor.js';
import { runRelightNode } from '../relightExecutor.js';
import { runPosterNode } from '../posterExecutor.js';
import { runLayerEditorNode } from '../layerExecutor.js';
import { runStoryboardEditorNode } from '../storyboardExecutor.js';
import { runMaterialNode } from '../materialExecutor.js';
import { runScene3DNode } from '../scene3dExecutor.js';
import { runPickerNode, runLoaderNode } from '../workflowRunShared.js';

// ── instant（浏览器本地：裁剪 / 旋转 / 镜像）──
for (const type of ['ComfyTV.CropStage', 'ComfyTV.RotateStage', 'ComfyTV.MirrorStage']) {
	defineNodeRuntime({ type, run: input => runInstantNode(input) });
}

// ── 本地编辑器类 stage ──
defineNodeRuntime({ type: 'ComfyTV.RelightStage', run: input => runRelightNode(input) });
defineNodeRuntime({ type: 'ComfyTV.PosterStage', run: input => runPosterNode(input) });
defineNodeRuntime({ type: 'ComfyTV.LayerEditorStage', run: input => runLayerEditorNode(input) });
defineNodeRuntime({ type: 'ComfyTV.StoryboardEditorStage', run: input => runStoryboardEditorNode(input) });
defineNodeRuntime({ type: 'ComfyTV.MaterialStage', run: input => runMaterialNode(input) });
defineNodeRuntime({ type: 'ComfyTV.Scene3DStage', run: input => runScene3DNode(input) });

// ── no-Run picker（选择一张上游候选快照 → 本地产出）──
for (const type of ['ComfyTV.ImagePickerStage', 'ComfyTV.VideoPickerStage', 'ComfyTV.AudioPickerStage']) {
	defineNodeRuntime({ type, run: input => runPickerNode(input) });
}

// ── no-Run loader（节点弹窗里选定的快照 → 本地产出）──
for (const type of ['ComfyTV.ImageLoaderStage', 'ComfyTV.VideoLoaderStage', 'ComfyTV.AudioLoaderStage', 'ComfyTV.TextLoaderStage']) {
	defineNodeRuntime({ type, run: input => runLoaderNode(input) });
}
