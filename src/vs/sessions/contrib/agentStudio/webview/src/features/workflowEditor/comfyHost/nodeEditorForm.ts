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
 *   - react (Sarosis): no Comfy form (rendered by its own card).
 *
 *  `values` are flat Record<string, unknown>; textarea/number/select all map to
 *  strings/numbers by the popup when submitted.
 *--------------------------------------------------------------------------------------------*/

import { getStageOptions, type NodeSpec } from './registry.js';

export type EditorFieldKind = 'textarea' | 'text' | 'number' | 'select' | 'agent' | 'skill';

export interface EditorField {
	key: string;
	label: string;
	kind: EditorFieldKind;
	defaultValue: unknown;
	/** select options (combo widgets) */
	options?: string[];
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

// ── Sarosis (react) node parameter forms ─────────────────────────────────────
// These are the orchestration nodes (prompt/agent/skill/tool/ifElse/switch/
// askUser). Each has a flat parameter set persisted in `node.data`. The form
// uses JSON textareas for structured fields (variables/skillArgs/toolParams/
// branches/options) so a workflow can be round-tripped without data loss.

const SAROSIS_FIELDS: Record<string, EditorField[]> = {
	'Sarosis.Prompt': [
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '提示词模板，支持 {{input}} 等变量替换' },
		{ key: 'variables', label: '变量 (JSON)', kind: 'textarea', defaultValue: '{}' },
	],
	'Sarosis.Agent': [
		{ key: 'agentId', label: 'Agent', kind: 'agent', defaultValue: '', placeholder: '选择 Agent' },
		{ key: 'providerId', label: 'Provider ID', kind: 'text', defaultValue: '' },
		{ key: 'modelId', label: 'Model ID', kind: 'text', defaultValue: '' },
		{ key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '', placeholder: '发给 Agent 的任务模板，{{input}} = 上游输出' },
	],
	'Sarosis.Skill': [
		{ key: 'skillName', label: 'Skill', kind: 'skill', defaultValue: '', placeholder: '选择 Skill' },
		{ key: 'skillArgs', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}' },
	],
	'Sarosis.Tool': [
		{ key: 'toolName', label: 'Tool 名称', kind: 'text', defaultValue: '' },
		{ key: 'toolParams', label: '参数 (JSON)', kind: 'textarea', defaultValue: '{}' },
	],
	'Sarosis.IfElse': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '例如 {{input.value}}' },
		{ key: 'branches', label: '分支 (JSON)', kind: 'textarea', defaultValue: '[{"label":"True","condition":""},{"label":"False","condition":""}]' },
	],
	'Sarosis.Switch': [
		{ key: 'evaluationTarget', label: '评估目标', kind: 'text', defaultValue: '', placeholder: '例如 {{input.value}}' },
		{ key: 'branches', label: '分支 (JSON)', kind: 'textarea', defaultValue: '[{"label":"Case 1","condition":""},{"label":"Default","condition":""}]' },
	],
	'Sarosis.AskUser': [
		{ key: 'questionText', label: '问题文本', kind: 'text', defaultValue: 'Select an option' },
		{ key: 'options', label: '选项 (JSON)', kind: 'textarea', defaultValue: '[{"label":"Option 1"},{"label":"Option 2"}]' },
		{ key: 'multiSelect', label: '多选', kind: 'select', defaultValue: 'no', options: ['yes', 'no'] },
	],
};

/** JSON-typed field keys whose value is stored as a structured object/array. */
const SAROSIS_JSON_KEYS = new Set(['variables', 'skillArgs', 'toolParams', 'branches', 'options']);

/** Editor fields for a Sarosis (react) node type. */
export function buildSarosisEditorFields(type: string): EditorField[] {
	return SAROSIS_FIELDS[type] ?? [];
}

/** Convert persisted `node.data` → flat editor values (JSON fields stringified). */
export function sarosisDataToValues(type: string, data: Record<string, unknown> | undefined): Record<string, unknown> {
	const fields = SAROSIS_FIELDS[type] ?? [];
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		if (f.key === 'providerId' || f.key === 'modelId') {
			const cfg = (data?.agentConfig as { providerId?: string; modelId?: string } | undefined) ?? {};
			out[f.key] = cfg[f.key as 'providerId' | 'modelId'] ?? '';
		} else if (SAROSIS_JSON_KEYS.has(f.key)) {
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
export function sarosisValuesToData(type: string, values: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of SAROSIS_FIELDS[type] ?? []) {
		if (f.key === 'providerId' || f.key === 'modelId') {
			const cfg = (out.agentConfig as { providerId?: string; modelId?: string } | undefined) ?? {};
			cfg[f.key as 'providerId' | 'modelId'] = String(values[f.key] ?? '');
			out.agentConfig = cfg;
		} else if (SAROSIS_JSON_KEYS.has(f.key)) {
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
		// Sarosis orchestration nodes → per-type parameter form.
		return buildSarosisEditorFields(spec.type);
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
		// ComfyTV stage → prompt textarea + params.
		// P3: prefer the live schema fields from /comfytv/caps (option_keys),
		// falling back to the kind-based presets until a runner is connected.
		if (!excludePrompt) {
			fields.push({
				key: 'prompt', label: '提示词 (Prompt)', kind: 'textarea', defaultValue: '',
				placeholder: '输入提示词，例如：a cat astronaut on the moon, 4k, detailed',
			});
		}
		const stageKind = spec.comfyTV?.stageKind ?? 'image';
		const capsFields = getStageOptions(stageKind);
		if (capsFields && capsFields.length > 0) {
			for (const o of capsFields) {
				fields.push({ key: o.key, label: o.label, kind: o.kind, defaultValue: o.defaultValue ?? '', options: o.options });
			}
		} else {
			for (const f of STAGE_KIND_FIELDS[stageKind] ?? STAGE_KIND_FIELDS.image) {
				fields.push({ key: f.label.toLowerCase().replace(/\s+/g, '_'), ...f });
			}
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
