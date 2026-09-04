/*---------------------------------------------------------------------------------------------
 *  nodeEditorForm — derive an editable form for a Comfy node from its NodeSpec.
 *
 *  Used by the node editor popup ("click a node → type a prompt → generate").
 *
 *  Field derivation rules (pure, unit-testable):
 *   - schema (ComfyTV): a `prompt` textarea is always offered; extra fields are
 *     derived from the stage kind (image → seed/width/height, video → seed/fps,
 *     audio → seed, …). ComfyTV inputs are dynamic upstream ports, so the form
 *     only exposes text/param inputs.
 *   - native (ComfyUI): widgets from the spec (text / number / combo).
 *   - react (Saros): no Comfy form (rendered by its own card).
 *
 *  `values` are flat Record<string, unknown>; textarea/number/select all map to
 *  strings/numbers by the popup when submitted.
 *--------------------------------------------------------------------------------------------*/

import { type NodeSpec } from './registry.js';

export type EditorFieldKind = 'textarea' | 'text' | 'number' | 'select' | 'agent' | 'skill' | 'tool' | 'provider' | 'providerModel' | 'agentProvider' | 'agentModel' | 'image';

export interface EditorField {
	key: string;
	label: string;
	kind: EditorFieldKind;
	defaultValue: unknown;
	/** select options (combo widgets) — plain string, or { label, value } pair. */
	options?: Array<string | { label: string; value: string; group?: string }>;
	placeholder?: string;
}

/** Field sets per ComfyTV stage kind (besides the always-present prompt). */
const STAGE_KIND_FIELDS: Record<string, Omit<EditorField, 'key'>[]> = {
	image: [
		{ label: 'Seed', kind: 'number', defaultValue: -1, placeholder: '-1 = random' },
		{ label: 'Width', kind: 'number', defaultValue: 512, placeholder: '512' },
		{ label: 'Height', kind: 'number', defaultValue: 512, placeholder: '512' },
	],
	'image-batch': [
		{ label: 'Seed', kind: 'number', defaultValue: -1, placeholder: '-1 = random' },
		{ label: 'Width', kind: 'number', defaultValue: 512, placeholder: '512' },
		{ label: 'Height', kind: 'number', defaultValue: 512, placeholder: '512' },
		{ label: 'Batch Size', kind: 'number', defaultValue: 4, placeholder: '4' },
	],
	video: [
		{ label: 'Seed', kind: 'number', defaultValue: -1, placeholder: '-1 = random' },
		{ label: 'FPS', kind: 'number', defaultValue: 24, placeholder: '24' },
		{ label: 'Frames', kind: 'number', defaultValue: 48, placeholder: '48' },
	],
	audio: [
		{ label: 'Seed', kind: 'number', defaultValue: -1, placeholder: '-1 = random' },
		{ label: 'Duration (s)', kind: 'number', defaultValue: 10, placeholder: '10' },
	],
	text: [
		{ label: 'Temperature', kind: 'number', defaultValue: 0.8, placeholder: '0.8' },
		{ label: 'Max Tokens', kind: 'number', defaultValue: 256, placeholder: '256' },
	],
	'text-batch': [
		{ label: 'Temperature', kind: 'number', defaultValue: 0.8, placeholder: '0.8' },
		{ label: 'Count', kind: 'number', defaultValue: 4, placeholder: '4' },
	],
};

// ── Saros (react) node parameter forms ─────────────────────────────────────
// These are the orchestration nodes (prompt/agent/skill/tool/ifElse/switch/
// askUser). Each has a flat parameter set persisted in `node.data`. The form
// uses JSON textareas for structured fields (variables/skillArgs/toolParams/
// branches/options) so a workflow can be round-tripped without data loss.

const VSSAROS_FIELDS: Record<string, EditorField[]> = {
	'Saros.Prompt': [
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '提示词模板。可用占位符：{{input}}（上游）、{{args.x}}（Start 参数）、{{变量名}}（下方 variables 定义的局部变量）、{{节点名}}（上游节点）' },
		{ key: 'variables', label: '变量 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '局部变量：{"角色":"翻译助手","目标语言":"中文"}。值可为模板（支持 {{input}}/{{args.x}}），在提示词里用 {{变量名}} 引用' },
	],
	'Saros.Agent': [
		{ key: 'agentId', label: 'Agent', kind: 'agent', defaultValue: '', placeholder: '选择 Agent' },
		{ key: 'providerId', label: 'Provider', kind: 'agentProvider', defaultValue: '', placeholder: 'LLM Provider（聊天模型）' },
		{ key: 'modelId', label: 'Model', kind: 'agentModel', defaultValue: '', placeholder: 'LLM 模型' },
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '发给 Agent 的任务模板，{{input}} = 上游输出' },
	],
	'Saros.Task': [
		{ key: 'prompt', label: '任务描述', kind: 'textarea', defaultValue: '', placeholder: '原子子任务描述，{{input}} = 上游输出' },
		{ key: 'agentId', label: 'Agent', kind: 'agent', defaultValue: '', placeholder: '留空 = 默认 saros-claw' },
	],
	'Saros.Skill': [
		{ key: 'skillName', label: 'Skill', kind: 'skill', defaultValue: '', placeholder: '选择 Skill' },
		{ key: 'task', label: '任务说明 (可选)', kind: 'text', defaultValue: '', placeholder: '告诉子代理要用这个技能完成什么（{{input}} = 上游输出）' },
		{ key: 'skillArgs', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '技能参数，{{input}} = 上游输出' },
	],
	'Saros.Tool': [
		{ key: 'toolName', label: 'Tool', kind: 'tool', defaultValue: '', placeholder: '选择工具' },
		{ key: 'toolParams', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}' },
	],
	'Saros.IfElse': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '对上游 JSON 取点路径，例如 value 或 a.b.c；也支持 {{input.value}} 写法。留空 = 对上游整体做真值判定。true/false 两个输出端口' },
	],
	'Saros.Switch': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '对上游 JSON 取点路径，例如 value 或 a.b.c；也支持 {{input.value}} 写法。留空 = 对上游整体取值' },
		{ key: 'cases', label: '匹配值 (cases)', kind: 'textarea', defaultValue: '[]', placeholder: 'JSON 数组 ["a","b"] 或逗号分隔 a,b。前 4 项依次对应 case-1..4 端口，未命中走 default 端口' },
	],
	'Saros.AskUser': [
		{ key: 'questionText', label: '问题文本', kind: 'text', defaultValue: 'Select an option' },
		{ key: 'options', label: '选项 (JSON)', kind: 'textarea', defaultValue: '[{"label":"Option 1"},{"label":"Option 2"}]' },
		{ key: 'multiSelect', label: '多选', kind: 'select', defaultValue: 'no', options: ['yes', 'no'] },
	],
	'Saros.ProviderPicker': [
		{ key: 'providerId', label: 'Provider', kind: 'provider', defaultValue: '' },
		{ key: 'modelId', label: 'Model', kind: 'providerModel', defaultValue: '' },
	],
	// W1/P1: Start 工作流输入契约——args 定义全图可引用的 {{args.key}} 参数。
	// 保持字符串存储（不加入 SAROS_JSON_KEYS）：registry 的 args widget 与
	// 本表单双入口都写字符串，collectStartArgs 统一 JSON.parse。
	'Saros.Start': [
		{ key: 'args', label: '输入参数 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '工作流输入契约，图内用 {{args.key}} 引用。例如 {"topic":"cyberpunk","count":4}' },
	],
	// End 输出契约：description 纯记录用途（执行器仍透传上游快照）。
	'Saros.End': [
		{ key: 'description', label: '输出说明 (可选)', kind: 'text', defaultValue: '', placeholder: '描述这个工作流的最终输出（记录用途，不影响执行）' },
	],
};

/** JSON-typed field keys whose value is stored as a structured object/array. */
const SAROS_JSON_KEYS = new Set(['variables', 'skillArgs', 'toolParams', 'options']);

/** P1: whether a field key is a JSON 对象/数组字段（表单用 KV 结构化编辑器渲染）。 */
export function isSarosJsonField(key: string): boolean {
	return SAROS_JSON_KEYS.has(key);
}

/** Editor fields for a Saros (react) node type. */
export function buildSarosEditorFields(type: string): EditorField[] {
	return VSSAROS_FIELDS[type] ?? [];
}

/** Convert persisted `node.data` → flat editor values (JSON fields stringified). */
export function sarosDataToValues(type: string, data: Record<string, unknown> | undefined): Record<string, unknown> {
	const fields = VSSAROS_FIELDS[type] ?? [];
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		// Agent 用 agentConfig 子对象；ProviderPicker 等节点平铺存 providerId/modelId。
		if ((f.key === 'providerId' || f.key === 'modelId') && type === 'Saros.Agent') {
			const cfg = (data?.agentConfig as { providerId?: string; modelId?: string } | undefined) ?? {};
			out[f.key] = cfg[f.key as 'providerId' | 'modelId'] ?? '';
		} else if (SAROS_JSON_KEYS.has(f.key)) {
			const raw = data?.[f.key];
			out[f.key] = raw === undefined ? f.defaultValue : safeJsonStringify(raw);
		} else if (f.key === 'multiSelect') {
			out[f.key] = data?.multiSelect ? 'yes' : 'no';
		} else {
			out[f.key] = data?.[f.key] ?? f.defaultValue;
		}
	}
	return out;
}

/** Convert flat editor values → persisted `node.data` (JSON fields parsed). */
export function sarosValuesToData(type: string, values: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of VSSAROS_FIELDS[type] ?? []) {
		// Agent 用 agentConfig 子对象；ProviderPicker 等节点平铺存 providerId/modelId。
		if ((f.key === 'providerId' || f.key === 'modelId') && type === 'Saros.Agent') {
			const cfg = (out.agentConfig as { providerId?: string; modelId?: string } | undefined) ?? {};
			cfg[f.key as 'providerId' | 'modelId'] = String(values[f.key] ?? '');
			out.agentConfig = cfg;
		} else if (SAROS_JSON_KEYS.has(f.key)) {
			const v = values[f.key];
			out[f.key] = typeof v === 'string' ? tryParseJson(v, v) : v;
		} else if (f.key === 'multiSelect') {
			out[f.key] = values[f.key] === 'yes';
		} else {
			out[f.key] = values[f.key] ?? '';
		}
	}
	return out;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function tryParseJson(text: string, fallback: unknown): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

/**
 * Derive editor fields for a node spec. `excludePrompt` lets callers suppress
 * the built-in prompt field (e.g. a stage that takes no text input).
 */
export function buildEditorFields(spec: NodeSpec | undefined, excludePrompt = false): EditorField[] {
	if (!spec) { return []; }
	const fields: EditorField[] = [];

	if (spec.kind === 'react') {
		// Saros orchestration nodes → per-type parameter form.
		return buildSarosEditorFields(spec.type);
	}

	if (spec.kind === 'native') {
		// ComfyUI native node → render its widgets.
		for (const w of spec.widgets ?? []) {
			if (w.type === 'COMBO') {
				fields.push({
					key: w.name, label: w.name, kind: 'select',
					defaultValue: w.default ?? w.options?.[0] ?? '',
					options: w.options,
				});
			} else if (w.type === 'INT' || w.type === 'FLOAT') {
				fields.push({ key: w.name, label: w.name, kind: 'number', defaultValue: w.default ?? 0 });
			} else {
				fields.push({ key: w.name, label: w.name, kind: 'text', defaultValue: w.default ?? '' });
			}
		}
		return fields;
	}

	if (spec.kind === 'schema') {
		// ★ Vox 口播视频导演：参数来自 registry widgets（含大量 COMBO 下拉），
		//   直接渲染 widgets（不走 STAGE_KIND_FIELDS 预设，因其无 options 表达）。
		if (spec.comfyTV?.stageKind === 'vox-director') {
			for (const w of spec.widgets ?? []) {
				if (w.type === 'COMBO') {
					fields.push({ key: w.name, label: w.name, kind: 'select', defaultValue: w.default ?? w.options?.[0] ?? '', options: w.options });
				} else if (w.type === 'INT' || w.type === 'FLOAT') {
					fields.push({ key: w.name, label: w.name, kind: 'number', defaultValue: w.default ?? 0 });
				} else if (w.name === 'topic' || w.name === 'music') {
					fields.push({ key: w.name, label: w.name, kind: 'textarea', defaultValue: w.default ?? '' });
				} else {
					fields.push({ key: w.name, label: w.name, kind: 'text', defaultValue: w.default ?? '' });
				}
			}
			return fields;
		}
		// ComfyTV stage → prompt textarea + params.
		// 完全不依赖 /comfytv/caps：表单字段走静态内置 STAGE_KIND_FIELDS（按 stageKind 预设）。
		if (!excludePrompt) {
			fields.push({
				key: 'prompt', label: '提示词 (Prompt)', kind: 'textarea', defaultValue: '',
				placeholder: '输入提示词，例如：a cat astronaut on the moon, 4k, detailed',
			});
		}
		// Provider 后端 schema 节点（Saros.ModelImageGen）——仿 Image Stage 但
		// 参数面板用 provider/model 联动下拉（provider → 该 provider 的文生图
		// 模型），其余数字参数来自 widgets。
		if (spec.backendKind === 'provider') {
			for (const w of spec.widgets ?? []) {
				if (w.name === 'prompt') { continue; } // 已在上方
				// 视频 / 3D / 音频生成节点的 provider/model 由弹窗专用双下拉渲染
				// （NodeEditorPopup 的 isVideoGenNode / isM3dGenNode / isAudioGenNode
				// 分支），此处跳过避免重复。
				if (w.name === 'videoProvider' || w.name === 'videoModel') { continue; }
				if (w.name === 'm3dProvider' || w.name === 'm3dModel') { continue; }
				if (w.name === 'audioProvider' || w.name === 'audioModel') { continue; }
				if (w.type === 'COMBO') {
					if (w.name === 'provider') {
						fields.push({ key: 'provider', label: 'Provider', kind: 'provider', defaultValue: w.default ?? '' });
					} else if (w.name === 'model') {
						fields.push({ key: 'model', label: 'Model', kind: 'providerModel', defaultValue: w.default ?? '' });
					} else {
						fields.push({ key: w.name, label: w.name, kind: 'select', defaultValue: w.default ?? '', options: w.options });
					}
				} else if (w.type === 'INT' || w.type === 'FLOAT') {
					fields.push({ key: w.name, label: w.name, kind: 'number', defaultValue: w.default ?? 0 });
				}
			}
			return fields;
		}
		const stageKind = spec.comfyTV?.stageKind ?? 'image';
		for (const f of STAGE_KIND_FIELDS[stageKind] ?? STAGE_KIND_FIELDS.image) {
			fields.push({ key: f.label.toLowerCase().replace(/\s+/g, '_'), ...f });
		}
		return fields;
	}

	return fields;
}

/**
 * Coerce a raw editor value into the type a ComfyUI input expects.
 * Pure: number fields → Number (clamped for seeds), others → string.
 */
export function coerceEditorValue(value: unknown, field: EditorField): unknown {
	if (field.kind === 'number') {
		const n = Number(value);
		if (!Number.isFinite(n)) { return field.defaultValue; }
		if (field.label.toLowerCase().includes('seed') && n < 0) { return -1; }
		return n;
	}
	return String(value ?? '');
}
