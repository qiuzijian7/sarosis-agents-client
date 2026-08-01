/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Markdown 格式：YAML frontmatter + Markdown body。
 *
 * 重构为 **VS Code Chat 标准 agent 文件格式**（参考 `PromptHeaderAttributes`），
 * 同一文件同时被 VS Code Chat 的 `PromptFileParser` 和本系统 `parseAgentMd` 读取。
 *
 * 字段分层：
 *   1. VS Code 标准字段（name/description/model/tools/icon/handoffs/agents/hooks/...）
 *      — 被模式选择器识别
 *   2. 扩展字段（id/role/category/source/owner/skills/temperature/...）
 *      — 本系统识别，VS Code Chat 忽略但不报错
 *
 * 使用 VS Code 内置 YAML 解析器（`vs/base/common/yaml.ts`）做解析，
 * 外加轻量序列化器做 frontmatter 输出。零外部依赖。
 */

import type { Agent } from '../../../common/agentStudioTypes.js';
import { parse, type YamlNode } from '../../../../base/common/yaml.js';

/** YAML frontmatter 中的原始数据（解析后未经过滤） */
interface AgentMdRaw {
	// VS Code 标准字段
	name?: string;
	description?: string;
	model?: string | string[];
	providerId?: string;
	tools?: string | string[];
	icon?: string;
	handoffs?: unknown;       // VS Code 用 lowercase `handoffs`
	agents?: string[];
	hooks?: unknown;
	context?: string;
	'user-invocable'?: boolean;
	'disable-model-invocation'?: boolean;
	target?: string;
	// 扩展字段（本系统专用）
	id?: string;
	role?: string;
	category?: string;
	source?: 'builtin' | 'custom';
	owner?: string;
	version?: string;
	storeId?: string;
	skills?: string[];
	enabledToolsets?: string[];
	disabledToolsets?: string[];
	temperature?: number;
	status?: string;
	sortOrder?: number;
	configHtml?: unknown;
	visibility?: unknown;
	confidenceThreshold?: number;
	parallelStrategy?: string;
	sandbox?: string;
	avatar?: string;
	createdAt?: string;
	updatedAt?: string;
	// AgentLoop 循环范式配置（可选）
	paradigm?: string;
	budgetMaxTotal?: number;
	[key: string]: unknown;
}

// ── 零依赖 YAML 解析/序列化（替代 js-yaml）─────────────────────────────────

/** 将 VS Code 内置 YAML AST 节点转为纯 JS 对象 */
function yamlToPlain(node: YamlNode | undefined): unknown {
	if (!node) { return undefined; }
	if (node.type === 'scalar') {
		const v = node.value;
		// 尝试还原布尔/null/数字
		if (v === 'true') { return true; }
		if (v === 'false') { return false; }
		if (v === 'null' || v === '~') { return null; }
		const num = Number(v);
		if (!isNaN(num) && String(num) === v) { return num; }
		return v;
	}
	if (node.type === 'sequence') {
		return node.items.map(yamlToPlain);
	}
	if (node.type === 'map') {
		const obj: Record<string, unknown> = {};
		for (const { key, value } of node.properties) {
			obj[key.value] = yamlToPlain(value);
		}
		return obj;
	}
	return undefined;
}

/** 将 YAML 字符串解析为纯 JS 对象 */
function parseYaml(yamlStr: string): unknown {
	const errors: import('../../../../base/common/yaml.js').YamlParseError[] = [];
	const node = parse(yamlStr, errors);
	return yamlToPlain(node);
}

/** 将纯 JS 对象序列化为 YAML 字符串（简单 key-value 聚集，不支持多层嵌套/锚点） */
function dumpYaml(obj: Record<string, unknown>, baseIndent = ''): string {
	const lines: string[] = [];
	for (const [key, val] of Object.entries(obj)) {
		if (val === undefined || val === null) { continue; }
		if (Array.isArray(val)) {
			if (val.length === 0) { continue; }
			// 字符串数组：每项一行 `- value`
			lines.push(`${baseIndent}${key}:`);
			for (const item of val) {
				lines.push(`${baseIndent}  - ${escapeYamlScalar(String(item))}`);
			}
		} else if (typeof val === 'object') {
			lines.push(`${baseIndent}${key}:`);
			lines.push(dumpYaml(val as Record<string, unknown>, baseIndent + '  '));
		} else if (typeof val === 'boolean') {
			lines.push(`${baseIndent}${key}: ${val}`);
		} else if (typeof val === 'number') {
			lines.push(`${baseIndent}${key}: ${val}`);
		} else {
			lines.push(`${baseIndent}${key}: ${escapeYamlScalar(String(val))}`);
		}
	}
	return lines.join('\n');
}

/** 对 YAML 纯量值做最小引号转义（含冒号、井号、首尾空格时需要引号包裹） */
function escapeYamlScalar(value: string): string {
	if (value.length === 0) { return '""'; }
	const needsQuote = (
		value.includes(':') ||
		value.includes('#') ||
		value.startsWith(' ') ||
		value.endsWith(' ') ||
		value.startsWith('{') ||
		value.startsWith('[') ||
		value.startsWith('"') ||
		value.startsWith('\'') ||
		value.startsWith('@') ||
		value.startsWith('`') ||
		value.includes('\n')
	);
	if (needsQuote) {
		// 双引号包裹，内部引号转义
		return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
	}
	return value;
}

/**
 * 将 Agent 对象序列化为 agent.md 内容（VS Code 标准 frontmatter + Markdown body）。
 * VS Code 标准字段在前，扩展字段在后；空值/假值字段自动省略。
 */
export function buildAgentMd(agent: Agent): string {
	const fm: Record<string, unknown> = {};

	// ═══ VS Code Chat 标准字段（PromptHeaderAttributes）═══
	fm.name = agent.name;
	if (agent.description) { fm.description = agent.description; }
	if (agent.model) { fm.model = agent.model; }
	if (agent.providerId) { fm.providerId = agent.providerId; }
	if (agent.tools && agent.tools.length > 0) { fm.tools = agent.tools; }
	if (agent.icon && agent.icon !== '🤖') { fm.icon = agent.icon; }
	// VS Code 用 lowercase `handoffs`（PromptHeaderAttributes.handOffs = 'handoffs'）
	if (agent.handOffs && agent.handOffs.length > 0) { fm.handoffs = agent.handOffs; }
	if (agent.agents && agent.agents.length > 0) { fm.agents = agent.agents; }
	if (agent.hooks) { fm.hooks = agent.hooks; }

	// ═══ 扩展字段（本系统专用，VS Code Chat 忽略）═══
	fm.id = agent.id;
	if (agent.role && agent.role !== 'assistant') { fm.role = agent.role; }
	if (agent.category && agent.category !== 'General') { fm.category = agent.category; }
	fm.source = agent.source ?? 'custom';
	if (agent.owner) { fm.owner = agent.owner; }
	if (agent.version) { fm.version = agent.version; }
	if (agent.storeId) { fm.storeId = agent.storeId; }
	if (agent.skills && agent.skills.length > 0) { fm.skills = agent.skills; }
	if (agent.enabledToolsets && agent.enabledToolsets.length > 0) { fm.enabledToolsets = agent.enabledToolsets; }
	if (agent.disabledToolsets && agent.disabledToolsets.length > 0) { fm.disabledToolsets = agent.disabledToolsets; }
	if (agent.temperature !== undefined) { fm.temperature = agent.temperature; }
	if (agent.status) { fm.status = agent.status; }
	if (agent.sortOrder !== undefined) { fm.sortOrder = agent.sortOrder; }
	if (agent.avatar) { fm.avatar = agent.avatar; }
	if (agent.confidenceThreshold !== undefined) { fm.confidenceThreshold = agent.confidenceThreshold; }
	if (agent.parallelStrategy) { fm.parallelStrategy = agent.parallelStrategy; }
	if (agent.sandbox) { fm.sandbox = agent.sandbox; }
	if (agent.configHtml) { fm.configHtml = agent.configHtml; }
	if (agent.visibility) { fm.visibility = agent.visibility; }
	if (agent.paradigm) { fm.paradigm = agent.paradigm; }
	if (agent.budgetMaxTotal !== undefined) { fm.budgetMaxTotal = agent.budgetMaxTotal; }
	fm.createdAt = agent.createdAt;
	fm.updatedAt = agent.updatedAt;

	const yamlHeader = dumpYaml(fm);
	const body = agent.systemPrompt?.trim() ?? '';

	return ['---', yamlHeader.trimEnd(), '---', '', body].join('\n');
}

/**
 * 解析 agent.md 内容，返回 Agent 对象 + systemPrompt body。
 * 同时读取 VS Code 标准字段和扩展字段。
 * 失败时返回 null。
 *
 * 放宽 id 要求：若 frontmatter 无 `id` 字段，回退使用 `name` slug 化作为 id
 *（兼容纯 VS Code 格式的 agent.md 文件）。
 */
export function parseAgentMd(content: string): { agent: Partial<Agent>; systemPrompt: string } | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith('---')) { return null; }

	const endIdx = trimmed.indexOf('\n---', 3);
	if (endIdx < 0) { return null; }

	const fmBlock = trimmed.slice(3, endIdx).trim();
	const body = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '').trim();

	let raw: AgentMdRaw;
	try {
		raw = parseYaml(fmBlock) as AgentMdRaw;
	} catch {
		return null;
	}

	if (!raw || typeof raw !== 'object') { return null; }

	// id 回退：优先 id 字段，否则用 name slug 化
	const nameStr = typeof raw.name === 'string' ? raw.name : '';
	const idStr = typeof raw.id === 'string' ? raw.id
		: (nameStr ? nameStr.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').replace(/-+/g, '-') : '');
	if (!idStr) { return null; }

	// tools 支持 string（逗号分隔）或 string[]
	const toolsArr = parseStringOrArray(raw.tools);

	const agent: Partial<Agent> = {
		id: idStr,
		name: nameStr || idStr,
		role: typeof raw.role === 'string' ? raw.role : 'assistant',
		description: typeof raw.description === 'string' ? raw.description : '',
		icon: typeof raw.icon === 'string' ? raw.icon : '🤖',
		model: typeof raw.model === 'string' ? raw.model
			: (Array.isArray(raw.model) && raw.model.length > 0 ? raw.model[0] : 'claude-sonnet-4-20250514'),
		providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined,
		category: typeof raw.category === 'string' ? raw.category : 'General',
		source: (raw.source === 'builtin' || raw.source === 'custom') ? raw.source : 'custom',
		owner: typeof raw.owner === 'string' ? raw.owner : undefined,
		version: typeof raw.version === 'string' ? raw.version : undefined,
		storeId: typeof raw.storeId === 'string' ? raw.storeId : undefined,
		skills: parseStringArray(raw.skills),
		tools: toolsArr,
		enabledToolsets: parseStringArray(raw.enabledToolsets),
		disabledToolsets: parseStringArray(raw.disabledToolsets),
		temperature: typeof raw.temperature === 'number' ? raw.temperature : undefined,
		status: typeof raw.status === 'string' ? raw.status as Agent['status'] : undefined,
		sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : undefined,
		avatar: typeof raw.avatar === 'string' ? raw.avatar : undefined,
		agents: parseStringArray(raw.agents),
		confidenceThreshold: typeof raw.confidenceThreshold === 'number' ? raw.confidenceThreshold : undefined,
		parallelStrategy: (raw.parallelStrategy === 'voting' || raw.parallelStrategy === 'coverage') ? raw.parallelStrategy : undefined,
		sandbox: typeof raw.sandbox === 'string' ? raw.sandbox as Agent['sandbox'] : undefined,
		configHtml: raw.configHtml && typeof raw.configHtml === 'object' ? raw.configHtml as Agent['configHtml'] : undefined,
		paradigm: typeof raw.paradigm === 'string' ? raw.paradigm : undefined,
		budgetMaxTotal: typeof raw.budgetMaxTotal === 'number' ? raw.budgetMaxTotal : undefined,
		// 读取 VS Code 标准 `handoffs` 字段（也兼容旧 `handOffs`）
		handOffs: Array.isArray(raw.handoffs) ? raw.handoffs as Agent['handOffs']
			: (Array.isArray((raw as any).handOffs) ? (raw as any).handOffs as Agent['handOffs'] : undefined),
		hooks: raw.hooks && typeof raw.hooks === 'object' ? raw.hooks as Agent['hooks'] : undefined,
		visibility: raw.visibility && typeof raw.visibility === 'object' ? raw.visibility as Agent['visibility'] : undefined,
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
		updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
	};

	return { agent, systemPrompt: body };
}

/** 将 string | string[] 统一为 string[]（逗号分隔字符串也拆分） */
function parseStringOrArray(v: unknown): string[] | undefined {
	if (!v) { return undefined; }
	if (Array.isArray(v)) {
		return v.filter((s): s is string => typeof s === 'string');
	}
	if (typeof v === 'string') {
		// 逗号分隔（VS Code Chat `tools: read, write` 格式）
		return v.split(',').map(s => s.trim()).filter(Boolean);
	}
	return undefined;
}

/** 严格 string[] 解析（不拆分逗号），返回 undefined 或非空数组 */
function parseStringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) { return undefined; }
	const arr = v.filter((s): s is string => typeof s === 'string');
	return arr.length > 0 ? arr : undefined;
}
