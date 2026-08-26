/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// agentChatPanel.workflowChip.ts - 工作流 chip 纯函数层
// ------------------------------------------------------------------------------------------------
//
// 与 webview 的 parseSlashCommands（webview/src/utils/slashCommands.ts）保持语义一致：
//   /workflow <wf-id> [input]  → workflowTrigger = { workflowId, input? }
//
// 此文件为**零依赖纯函数**，供 composer（序列化/反序列化）、send（构造 trigger）复用，
// 也可直接被单元测试 import（无需 DOM / VS Code 运行时）。

/** 工作流触发结构（与 IChatSendOptions.workflowTrigger 对齐）。 */
export interface IWorkflowTriggerShape {
	readonly workflowId: string;
	readonly input?: string;
	readonly variables?: Record<string, string>;
	/** 参考图引用（data URL / http ref），供 ComfyStage/EmojiStage 等媒体节点消费。 */
	readonly images?: string[];
}

/** slash 菜单中展示的工作流条目（来自 IWorkflowStorageService.listWorkflows 的投影）。 */
export interface IWorkflowChipItem {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/** 该工作流需用户填写的模板变量（{{topic}} 等；含 {{input}}，表单层自行决定是否展示）。 */
	readonly variables?: ReadonlyArray<{ name: string; defaultValue: string }>;
}

/**
 * 序列化：工作流 chip → 文本标记。输出必须能被 parseSlashCommands 解析出相同的 workflowId。
 * 格式统一为 `/workflow <id>`（非 bare `/wf-xxx`）。
 */
export function serializeWorkflowMark(id: string): string {
	return `/workflow ${id}`;
}

/** 从文本提取所有 workflow 标记（历史/草稿恢复用）。不匹配 bare `/wf-xxx`。 */
export function parseWorkflowMarks(text: string): string[] {
	const re = /\/workflow\s+(wf-[\w-]+)/g;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.push(m[1]);
	}
	return out;
}

/** slash 菜单过滤：按 id / name 做大小写不敏感的子串匹配。filter 为空时原样返回。 */
export function filterWorkflowItems(
	workflows: ReadonlyArray<IWorkflowChipItem>,
	filter: string,
): ReadonlyArray<IWorkflowChipItem> {
	if (!filter) {
		return workflows;
	}
	const f = filter.toLowerCase();
	return workflows.filter(w =>
		w.id.toLowerCase().includes(f) ||
		w.name.toLowerCase().includes(f),
	);
}

/** 把反斜杠等正则元字符转义（用于构造锚定的 replace 正则）。 */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从「chip 之后的文本 + 可选参数」构造 workflowTrigger。
 * @param workflowId chip 对应的 workflow id；无则返回 undefined。
 * @param textAfterChip chip 之后的自由文本（作为工作流 {{input}}）。
 * @param variables 表单收集的自定义变量（{{topic}} 等）；空对象/undefined 时不输出该字段。
 */
export function buildWorkflowTrigger(
	workflowId: string | undefined,
	textAfterChip: string,
	variables?: Record<string, string>,
	images?: string[],
): IWorkflowTriggerShape | undefined {
	if (!workflowId) {
		return undefined;
	}
	const input = textAfterChip.trim();
	const trigger: IWorkflowTriggerShape = {
		workflowId,
		...(input ? { input } : {}),
		...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
		...(images && images.length > 0 ? { images } : {}),
	};
	return trigger;
}

/** 解析 chip 之后文本为 `--key=value` / `--key`(布尔) 参数与剩余 input。 */
export interface IWorkflowArgParse {
	variables: Record<string, string>;
	input: string;
}

/**
 * 解析 chip 之后的文本：`--key=value` / `--key`（布尔 true）→ variables，其余 → input。
 * 值含空格/引号用 JSON 双引号包裹：`--title="hello world"`；解析时 JSON.parse 还原转义。
 */
export function parseInlineWorkflowArgs(textAfterChip: string): IWorkflowArgParse {
	const variables: Record<string, string> = {};
	let s = textAfterChip ?? '';
	const re = /^\s*--([\w-]+)(?:=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]*))?/;
	while (s) {
		const m = re.exec(s);
		if (!m) { break; }
		const key = m[1];
		let val = m[2];
		if (val === undefined) {
			val = 'true';
		} else if (val.startsWith('"')) {
			try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
		} else if (val.startsWith("'")) {
			val = val.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
		}
		variables[key] = val;
		s = s.slice(m[0].length);
	}
	return { variables, input: s.trim() };
}

/**
 * 序列化变量为 `--k=v --k2=v2`（值含空格/双引号时用 JSON.stringify 编码为双引号串）。
 * 空值序列化为 `--k=`（保留键），保证与 parseInlineWorkflowArgs 可 round-trip。
 */
export function serializeInlineWorkflowArgs(variables: Record<string, string>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(variables ?? {})) {
		const key = k.trim();
		if (!key) { continue; }
		const val = v ?? '';
		if (/[\s"]/.test(val)) {
			parts.push(`--${key}=${JSON.stringify(val)}`);
		} else {
			parts.push(`--${key}=${val}`);
		}
	}
	return parts.join(' ');
}

/** 编码 chip 参数为 JSON（存 chip 的 data-params；空/undefined 返回 ''）。 */
export function encodeWorkflowChipParams(params: Record<string, string> | undefined): string {
	if (!params || Object.keys(params).length === 0) { return ''; }
	return JSON.stringify(params);
}

/** 解码 chip 的 data-params JSON；非法/空返回 undefined（容错）。 */
export function decodeWorkflowChipParams(json: string | undefined): Record<string, string> | undefined {
	if (!json) { return undefined; }
	try {
		const v = JSON.parse(json);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const out: Record<string, string> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				if (typeof val === 'string') { out[k] = val; }
			}
			return Object.keys(out).length > 0 ? out : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从「完整序列化文本 + 已知 workflowId」提取 chip 之后的 input。
 * 序列化文本形如 `/workflow wf-xxx 自由文本`，去掉开头的 `/workflow <id>` 前缀即为 input。
 */
export function extractTextAfterWorkflowMark(text: string, workflowId: string): string {
	if (!workflowId) {
		return text;
	}
	const re = new RegExp(`^/workflow\\s+${escapeRegExp(workflowId)}\\s*`);
	return text.replace(re, '');
}
