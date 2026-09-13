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

/**
 * ★ 共享变量发布字段（2026-09-11）：节点输出可额外以**语义名**发布到本次运行的共享内存，
 * 下游任意节点用 `{{shared.<key>}}` 引用 —— **下游无需知道是哪个节点产出的**（多 Agent
 * 协同按语义引用的基础）。键名规则见 `browser/utils/templateUtils.ts::parseSharedPublishKeys`
 * （仅 `[\w-]` / 点分，逗号分隔多个；不合法的键会被丢弃，否则写进去也永远替换不出来）。
 *
 * 只登记在弹窗表单（`VSSAROS_FIELDS`），**不**加到 `spec.widgets`（卡片控件）—— 与
 * AskUser 多问题重构同一先例：卡片控件 + 弹窗字段 = 两套不同步的编辑入口。
 */
const PUBLISHES_FIELD: EditorField = {
	key: 'publishes',
	label: '发布为共享变量 (可选)',
	kind: 'text',
	defaultValue: '',
	placeholder: '逗号分隔的语义名，如 verdict, plan；下游用 {{shared.verdict}} 引用（键名仅限字母数字-_，不支持中文）',
};

const VSSAROS_FIELDS: Record<string, EditorField[]> = {
	'Saros.Prompt': [
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '提示词模板。可用占位符：{{input}}（上游）、{{args.x}}（Start 参数）、{{变量名}}（下方 variables 定义的局部变量）、{{节点名}}（上游节点）' },
		{ key: 'variables', label: '变量 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '局部变量：{"角色":"翻译助手","目标语言":"中文"}。值可为模板（支持 {{input}}/{{args.x}}），在提示词里用 {{变量名}} 引用' },
		PUBLISHES_FIELD,
	],
	'Saros.Agent': [
		{ key: 'agentId', label: 'Agent', kind: 'agent', defaultValue: '', placeholder: '选择 Agent' },
		{ key: 'providerId', label: 'Provider', kind: 'agentProvider', defaultValue: '', placeholder: 'LLM Provider（聊天模型）' },
		{ key: 'modelId', label: 'Model', kind: 'agentModel', defaultValue: '', placeholder: 'LLM 模型' },
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '发给 Agent 的任务模板，{{input}} = 上游输出' },
		PUBLISHES_FIELD,
	],
	'Saros.Task': [
		{ key: 'prompt', label: '任务描述', kind: 'textarea', defaultValue: '', placeholder: '原子子任务描述，{{input}} = 上游输出' },
		{ key: 'agentId', label: 'Agent', kind: 'agent', defaultValue: '', placeholder: '留空 = 默认 saros-claw' },
		PUBLISHES_FIELD,
	],
	'Saros.Skill': [
		{ key: 'skillName', label: 'Skill', kind: 'skill', defaultValue: '', placeholder: '选择 Skill' },
		{ key: 'task', label: '任务说明 (可选)', kind: 'text', defaultValue: '', placeholder: '告诉子代理要用这个技能完成什么（{{input}} = 上游输出）' },
		{ key: 'skillArgs', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '技能参数，{{input}} = 上游输出' },
		PUBLISHES_FIELD,
	],
	'Saros.Tool': [
		{ key: 'toolName', label: 'Tool', kind: 'tool', defaultValue: '', placeholder: '选择工具' },
		{ key: 'toolParams', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}' },
		PUBLISHES_FIELD,
	],
	'Saros.IfElse': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '对上游 JSON 取点路径，例如 value 或 a.b.c；也支持 {{input.value}} 写法。留空 = 对上游整体做真值判定。true/false 两个输出端口' },
	],
	'Saros.Switch': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '对上游 JSON 取点路径，例如 value 或 a.b.c；也支持 {{input.value}} 写法。留空 = 对上游整体取值' },
		{ key: 'cases', label: '匹配值 (cases)', kind: 'textarea', defaultValue: '[]', placeholder: 'JSON 数组 ["a","b"] 或逗号分隔 a,b。前 4 项依次对应 case-1..4 端口，未命中走 default 端口' },
	],
	// ★ 多问题重构（2026-09-11，用户需求「自由编辑参数个数/类型/增删」+「多问题」）：
	//   表单唯一入口 = `questions` 数组，每个问题自带模式（选项按钮 / 参数表单）、
	//   选项或参数列表、必填/多选/自由输入开关。
	//   旧的单问题字段（questionText / options / params / multiSelect / allowCustom /
	//   customLabel）**不再出现在表单里** —— 打开弹窗时由 sarosDataToValues 自动
	//   迁移为 questions[0]（见下方 Saros.AskUser 特例），保存后数据即升级；
	//   执行器侧 questions 优先、旧字段回落，双向兼容。
	'Saros.AskUser': [
		{ key: 'questions', label: '问题列表', kind: 'textarea', defaultValue: '[]', placeholder: '每个问题独立配置：回答方式（选项按钮 / 参数表单）、选项或参数、必填与多选开关' },
	],
	'Saros.ProviderPicker': [
		{ key: 'providerId', label: 'Provider', kind: 'provider', defaultValue: '' },
		{ key: 'modelId', label: 'Model', kind: 'providerModel', defaultValue: '' },
	],
	// 2026-09-09：Start 的「输入参数 (JSON)」表单随卡片 args UI 一并移除。
	// 数据通道保留：properties.args 仍由运行前参数面板 / collectStartArgs 消费。
	// End 输出契约：description 纯记录用途（执行器仍透传上游快照）。
	'Saros.End': [
		{ key: 'description', label: '输出说明 (可选)', kind: 'text', defaultValue: '', placeholder: '描述这个工作流的最终输出（记录用途，不影响执行）' },
	],
	// P1-4：动态工作流脚本作为 DAG 节点（复用 executeWorkflowScript，与「workflow 工具」同一引擎）。
	'Saros.Script': [
		{ key: 'script', label: '脚本', kind: 'textarea', defaultValue: '', placeholder: 'Dynamic Workflow 脚本（stage()/agent() 等 DSL）。在 DAG 里内联执行，输出作为本节点结果。' },
		{ key: 'name', label: '名称', kind: 'text', defaultValue: 'script', placeholder: '脚本名（meta.name），用于日志与投影标识' },
		{ key: 'args', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}', placeholder: '可选：传给脚本的 args，例如 {"topic":"cyberpunk"}' },
	],
};

/** JSON-typed field keys whose value is stored as a structured object/array. */
const SAROS_JSON_KEYS = new Set(['variables', 'skillArgs', 'toolParams', 'options', 'params', 'questions']);

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
	if (type === 'Saros.AskUser') {
		out.questions = safeJsonStringify(migrateAskUserQuestions(data));
	}
	return out;
}

/** AskUser 单个问题的规范化形态（与执行器读取侧契约一致）。 */
export interface AskUserQuestion {
	key: string;
	text: string;
	mode: 'options' | 'params';
	required?: boolean;
	options?: Array<{ label: string; description?: string }>;
	params?: Array<{ key: string; label?: string; type?: string }>;
	multiSelect?: boolean;
	allowCustom?: boolean;
	customLabel?: string;
}

/**
 * 旧单问题字段 → `questions[]` 迁移（2026-09-11 多问题重构）。
 *
 * 规则：`data.questions` 非空直接用（已是新格式）；否则若旧字段
 * （questionText / options / params）有内容，合成一个 question —— 让存量节点
 * 打开弹窗即见完整配置，用户保存后数据自然升级。两者都空 → 返回一个默认
 * 选项模式的空问题（保证 UI 至少有一张可编辑卡片）。
 * 纯函数，供编辑器与测试复用。
 */
export function migrateAskUserQuestions(data: Record<string, unknown> | undefined): AskUserQuestion[] {
	const raw = data?.questions;
	if (Array.isArray(raw) && raw.length > 0) { return raw as AskUserQuestion[]; }
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed) && parsed.length > 0) { return parsed as AskUserQuestion[]; }
		} catch { /* 非法 JSON → 走旧字段迁移 */ }
	}
	const parseArr = <T>(v: unknown): T[] => {
		if (Array.isArray(v)) { return v as T[]; }
		if (typeof v === 'string' && v.trim()) {
			try { const p = JSON.parse(v) as unknown; return Array.isArray(p) ? p as T[] : []; } catch { return []; }
		}
		return [];
	};
	const legacyOptions = parseArr<{ label: string; description?: string }>(data?.options);
	const legacyParams = parseArr<{ key: string; label?: string; type?: string }>(data?.params);
	const legacyText = typeof data?.questionText === 'string' ? data.questionText : '';
	if (legacyOptions.length > 0 || legacyParams.length > 0 || legacyText.trim()) {
		return [{
			key: 'q1',
			text: legacyText,
			// params 非空且 options 为空 → 参数模式（与执行器的隐式优先级一致）
			mode: legacyParams.length > 0 && legacyOptions.length === 0 ? 'params' : 'options',
			required: false,
			options: legacyOptions,
			params: legacyParams,
			multiSelect: !!data?.multiSelect,
			allowCustom: !!data?.allowCustom,
			customLabel: typeof data?.customLabel === 'string' ? data.customLabel : '',
		}];
	}
	return [{ key: 'q1', text: 'Select an option', mode: 'options', required: false, options: [{ label: 'Option 1' }, { label: 'Option 2' }], params: [], multiSelect: false, allowCustom: false, customLabel: '' }];
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
