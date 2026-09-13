/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流文件导入 —— **纯函数层**（解析 / 校验 / id 冲突消解）。
 *
 * 背景（2026-09-11 审计缺口）：工作流此前只有「商城下载」一条获取渠道，
 * 全库不存在 `workflow.import` 之类的 RPC，编辑器里的「⤵ 导入」只把
 * **ComfyUI 画布 JSON** 导进当前画布（不是新建工作流）。用户拿到一个
 * 工作流 JSON 文件（同事导出、聊天传输、备份恢复）时无处可导。
 *
 * 本模块只做「文本 → 可落盘的数据」的纯变换，不碰文件系统与 DI：
 *  - 解析失败 / 结构非法 → 抛 Error（调用方 try/catch 出用户可读提示）
 *  - 字段类型不对（如 nodes 不是数组）→ 忽略该字段并记 warning（宽容导入，
 *    避免一个坏字段导致整份文件不可用）
 *  - id 冲突 → 生成 `-imported-N` 后缀（**绝不覆盖**用户已有工作流）
 *
 * 与 `WorkflowInstaller.install` 的关系：那条链路从 tar 包导入（商城），
 * 本模块从**单文件**导入（本地）。两者共用 `IWorkflowStorageService.createWorkflow`
 * 的 `slug` 语义（`wf-{slug}`）。
 */

/** 解析后的导入载荷（可直接喂给 workflowStorage.importWorkflowJson）。 */
export interface IWorkflowImportPayload {
	name: string;
	description: string;
	presetId?: string;
	agentId?: string;
	steps: unknown[];
	nodes?: unknown[];
	connections?: unknown[];
	/**
	 * v5a: workflow-level breakpoints（节点 id 列表）。
	 *
	 * 2026-09-11 补：此前导出侧带上了本字段、导入侧却不识别 → 「导出 → 导入」
	 * **静默丢掉断点**（round-trip 不闭环）。凡导出白名单里的字段，这里必须有
	 * 对应识别项 —— 两处漂移由 round-trip 测试抓。
	 */
	breakpoints?: string[];
	version?: string;
	category?: string;
	/** 作者（发布元信息，2026-09-11 补：同上，原先导出带上却在此丢失）。 */
	author?: string;
	/** 可见性（发布元信息，2026-09-11 补）。 */
	visibility?: 'public' | 'private';
	tags?: string[];
	useGuide?: string;
	/** 源文件里声明的 id（用于尽量沿用，冲突时再消解）。 */
	sourceId?: string;
}

export interface IWorkflowImportParseResult {
	payload: IWorkflowImportPayload;
	/** 非致命问题（字段类型不符、无节点等）——调用方应展示给用户。 */
	warnings: string[];
}

/**
 * 归一化 slug：与 `workflowStorageService.createWorkflow` 的 slug 处理**同规则**
 * （`[^a-z0-9-] → -`，折叠连字符，去首尾）。两处必须一致，否则算出的冲突判定
 * 与实际落盘 id 对不上（`resolveImportSlug` 会用 `wf-{slug}` 比 id）。
 */
export function sanitizeWorkflowSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * 解析工作流 JSON 文本。失败抛 Error（消息面向用户，可直接展示）。
 * 宽容策略：单个字段类型不对 → 忽略该字段 + warning，不整体失败。
 */
export function parseWorkflowImportFile(text: string): IWorkflowImportParseResult {
	if (!text || !text.trim()) {
		throw new Error('文件为空');
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('不是有效的工作流文件（顶层应为 JSON 对象）');
	}
	const obj = raw as Record<string, unknown>;

	// 结构识别：至少命中一个「工作流特征字段」，避免把任意 JSON 当工作流导入。
	const hasShape = typeof obj.name === 'string'
		|| typeof obj.id === 'string'
		|| Array.isArray(obj.nodes)
		|| Array.isArray(obj.steps)
		|| Array.isArray(obj.connections);
	if (!hasShape) {
		throw new Error('不是有效的工作流文件（缺少 name / id / nodes / steps / connections 字段）');
	}

	const warnings: string[] = [];
	const asArray = (v: unknown, label: string): unknown[] | undefined => {
		if (v === undefined || v === null) { return undefined; }
		if (Array.isArray(v)) { return v; }
		warnings.push(`${label} 字段不是数组，已忽略`);
		return undefined;
	};

	const nodes = asArray(obj.nodes, 'nodes');
	const connections = asArray(obj.connections, 'connections');
	const steps = asArray(obj.steps, 'steps') ?? [];
	if (!nodes || nodes.length === 0) {
		warnings.push('文件中没有节点数据（nodes 为空），导入后画布为空白');
	}
	if (!connections || connections.length === 0) {
		warnings.push('文件中没有连线数据（connections 为空）');
	}

	const name = typeof obj.name === 'string' && obj.name.trim()
		? obj.name.trim()
		: typeof obj.id === 'string' && obj.id.trim()
			? obj.id.trim()
			: '导入的工作流';
	if (typeof obj.name !== 'string' || !obj.name.trim()) {
		warnings.push(`文件未提供有效名称，已使用「${name}」`);
	}

	const payload: IWorkflowImportPayload = {
		name,
		description: typeof obj.description === 'string' ? obj.description : '',
		...(typeof obj.presetId === 'string' && obj.presetId ? { presetId: obj.presetId } : {}),
		...(typeof obj.agentId === 'string' && obj.agentId ? { agentId: obj.agentId } : {}),
		steps,
		...(nodes ? { nodes } : {}),
		...(connections ? { connections } : {}),
		...(Array.isArray(obj.breakpoints)
			? { breakpoints: obj.breakpoints.filter((b): b is string => typeof b === 'string') }
			: {}),
		...(typeof obj.version === 'string' && obj.version ? { version: obj.version } : {}),
		...(typeof obj.category === 'string' && obj.category ? { category: obj.category } : {}),
		...(typeof obj.author === 'string' && obj.author ? { author: obj.author } : {}),
		...(obj.visibility === 'public' || obj.visibility === 'private' ? { visibility: obj.visibility } : {}),
		...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t): t is string => typeof t === 'string') } : {}),
		...(typeof obj.useGuide === 'string' && obj.useGuide ? { useGuide: obj.useGuide } : {}),
		...(typeof obj.id === 'string' && obj.id.trim() ? { sourceId: obj.id.trim() } : {}),
	};
	return { payload, warnings };
}

/**
 * 解析导入时应使用的工作流 **slug**（`createWorkflow` 会加 `wf-` 前缀）。
 *
 * 优先级：源 id（去 `wf-` 前缀）> 名称。若算出的 id（`wf-{slug}`）与本地已有
 * 工作流冲突 → 依次尝试 `{slug}-imported-2`、`-3`…（**不覆盖**用户数据）。
 *
 * 为什么沿用源 id 而不是每次新建随机 id：重复导入同一份文件应得到**可预期**
 * 的 id（便于用户识别是同一工作流的副本），且与商城安装路径（`install` 传 slug）
 * 语义一致。
 */
export function resolveImportSlug(
	sourceId: string | undefined,
	name: string,
	existingIds: ReadonlySet<string>,
): string {
	const fromId = sourceId ? sourceId.replace(/^wf-/i, '') : '';
	const base = sanitizeWorkflowSlug(fromId) || sanitizeWorkflowSlug(name) || 'workflow';
	let candidate = base;
	let n = 2;
	// 上限只是防御性护栏（正常不会触发）；超限时返回带时间戳的兜底 slug。
	while (existingIds.has(`wf-${candidate}`)) {
		if (n > 999) { return `${base}-imported-${Date.now()}`; }
		candidate = `${base}-imported-${n}`;
		n++;
	}
	return candidate;
}
