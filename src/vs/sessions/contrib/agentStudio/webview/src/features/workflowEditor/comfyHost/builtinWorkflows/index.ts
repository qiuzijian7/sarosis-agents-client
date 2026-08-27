/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 ComfyTV workflow 模板库（完全不依赖 ComfyTV 后端 API）。
 *
 * 所有 stage（ImageStage/VideoStage/AudioStage/...）的 workflow api_json 已静态打包，
 * 出图时直接读这里的模板 POST /prompt，无需 ComfyTV 扩展的 /comfytv/* 端点。
 *
 * 数据来源：本机 ComfyTV 的 workflow api_json（见 scripts/export-builtin-workflows.py），
 * 运行时零成本；**切勿手写 api_json**（连线引用必须是字符串 ["4",0] 非 [4,0]）。
 */

import type { StageWorkflowConfig, StageWorkflowListResponse } from '../stageWorkflowExecutor.js';
import { AUDIO_BUILTIN_WORKFLOWS } from './audioWorkflows.js';
import { CUTOUT_BUILTIN_WORKFLOWS } from './cutoutWorkflows.js';
import { EMOJI_BUILTIN_WORKFLOWS, EMOJI_DYN_BUILTIN_WORKFLOWS } from './emojiWorkflows.js';
import { ERASE_BUILTIN_WORKFLOWS } from './eraseWorkflows.js';
import { IMAGE_BUILTIN_WORKFLOWS } from './imageWorkflows.js';
import { IMAGE_EDIT_BUILTIN_WORKFLOWS } from './imageEditWorkflows.js';
import { INPAINT_BUILTIN_WORKFLOWS } from './inpaintWorkflows.js';
import { MATERIAL_ESTIMATE_BUILTIN_WORKFLOWS } from './materialEstimateWorkflows.js';
import { MULTIANGLE_BUILTIN_WORKFLOWS } from './multiangleWorkflows.js';
import { MULTIVIEW_BUILTIN_WORKFLOWS } from './multiviewWorkflows.js';
import { OUTPAINT_BUILTIN_WORKFLOWS } from './outpaintWorkflows.js';
import { PANORAMA_BUILTIN_WORKFLOWS } from './panoramaWorkflows.js';
import { SEQUENCE_BUILTIN_WORKFLOWS } from './sequenceWorkflows.js';
import { SHOT_IMAGES_BUILTIN_WORKFLOWS } from './shotImagesWorkflows.js';
import { SPLIT_PART_BUILTIN_WORKFLOWS } from './splitPartWorkflows.js';
import { STORYBOARD_BUILTIN_WORKFLOWS } from './storyboardWorkflows.js';
import { TEXT_BUILTIN_WORKFLOWS } from './textWorkflows.js';
import { UPSCALE_BUILTIN_WORKFLOWS } from './upscaleWorkflows.js';
import { VIDEO_BUILTIN_WORKFLOWS } from './videoWorkflows.js';
import { VOX_BUILTIN_WORKFLOWS } from './voxWorkflows.js';

/**
 * 模板注册表：kind → label → config。
 * 数据由 scripts/export-builtin-workflows.py 从本机 ComfyTV DB 导出（AUTO-GENERATED）。
 */
const BUILTIN_WORKFLOWS: Record<string, Record<string, StageWorkflowConfig>> = {
	"audio": AUDIO_BUILTIN_WORKFLOWS,
	"cutout": CUTOUT_BUILTIN_WORKFLOWS,
	"emoji": EMOJI_BUILTIN_WORKFLOWS,
	"emoji-dyn": EMOJI_DYN_BUILTIN_WORKFLOWS,
	"erase": ERASE_BUILTIN_WORKFLOWS,
	"image": IMAGE_BUILTIN_WORKFLOWS,
	"image-edit": IMAGE_EDIT_BUILTIN_WORKFLOWS,
	"inpaint": INPAINT_BUILTIN_WORKFLOWS,
	"material-estimate": MATERIAL_ESTIMATE_BUILTIN_WORKFLOWS,
	"multiangle": MULTIANGLE_BUILTIN_WORKFLOWS,
	"multiview": MULTIVIEW_BUILTIN_WORKFLOWS,
	"outpaint": OUTPAINT_BUILTIN_WORKFLOWS,
	"panorama": PANORAMA_BUILTIN_WORKFLOWS,
	"sequence": SEQUENCE_BUILTIN_WORKFLOWS,
	"shot-images": SHOT_IMAGES_BUILTIN_WORKFLOWS,
	"split-part": SPLIT_PART_BUILTIN_WORKFLOWS,
	"storyboard": STORYBOARD_BUILTIN_WORKFLOWS,
	"text": TEXT_BUILTIN_WORKFLOWS,
	"upscale": UPSCALE_BUILTIN_WORKFLOWS,
	"video": VIDEO_BUILTIN_WORKFLOWS,
	"vox-script": { "Local Qwen3 4B Script": VOX_BUILTIN_WORKFLOWS["Local Qwen3 4B Script"] },
	"vox-image": { "Local Flux Dev Keyframe": VOX_BUILTIN_WORKFLOWS["Local Flux Dev Keyframe"] },
	"vox-video": { "Local LTX 2.3 FLF2V": VOX_BUILTIN_WORKFLOWS["Local LTX 2.3 FLF2V"] },
};

/** 列出某 kind 的内置 workflow（结构对齐 StageWorkflowListResponse）。 */
export function listBuiltinWorkflows(kind: string): StageWorkflowListResponse | undefined {
	const byKind = BUILTIN_WORKFLOWS[kind];
	if (!byKind) { return undefined; }
	const labels = Object.keys(byKind);
	if (labels.length === 0) { return undefined; }
	return {
		kinds: [kind],
		workflows: labels.map((label, i) => ({ kind, label, default: i === 0 })),
	};
}

/** 取某 kind/label 的内置 workflow 配置；无则返回 undefined。 */
export function getBuiltinWorkflowConfig(kind: string, label: string): StageWorkflowConfig | undefined {
	return BUILTIN_WORKFLOWS[kind]?.[label];
}

/** 列出所有内置 workflow 的 kind（供 workflow 下拉选项初始化）。 */
export function listBuiltinKinds(): string[] {
	return Object.keys(BUILTIN_WORKFLOWS);
}

/** 取某 kind 的所有内置 workflow label（供 workflow 下拉选项初始化）。 */
export function listBuiltinLabels(kind: string): string[] {
	return Object.keys(BUILTIN_WORKFLOWS[kind] ?? {});
}
