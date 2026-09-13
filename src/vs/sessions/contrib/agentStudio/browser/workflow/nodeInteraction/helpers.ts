/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点交互声明的**纯函数工具** —— 节点无关的「机制面」。
 *
 * 全部为纯函数（无 IO、无 DOM、无 VS Code 依赖），可直接单测；
 * 卡片侧与执行侧共用同一份语义，避免「初始值构造」与「提交值合并」两边漂移。
 *
 * 拆分由来与兼容说明见 `./types.ts` 头注释。
 */
import type { INodeInteractionField, INodeInteractionSchema } from './types.js';

/** 单个字段的默认值（用于卡片初始态与「未配置」时的兜底）。 */
export function defaultFieldValue(field: INodeInteractionField): unknown {
	switch (field.kind) {
		case 'number': return field.default;
		case 'boolean': return field.default ?? false;
		case 'select': return field.default ?? (field.options[0]?.value ?? '');
		case 'text':
		case 'textarea': return field.default ?? '';
		case 'grid-size': return { rows: field.defaultRows ?? 3, cols: field.defaultCols ?? 3 };
		case 'list': return [];
		// 参考图像：空数组 = 未钉任何资产（执行侧会回退上游连线图像）。
		case 'image-ref': return [];
	}
}

/**
 * 归一「资产引用」容器：存储可能是 **JSON 字符串**（node.properties 写回形态）
 * 或**数组**（本模块提交后的形态）。此处只保证容器是数组，**条目校验**由执行侧
 * `parseAssetRefs()` 负责（那份规则同时服务 UI / 覆盖注入 / workflow 注入，不重复实现）。
 */
function toAssetRefArray(raw: unknown): ReadonlyArray<Record<string, unknown>> {
	if (Array.isArray(raw)) { return raw as Array<Record<string, unknown>>; }
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
		} catch { return []; }
	}
	return [];
}

/**
 * 从节点现有 values 中抽取某个字段的当前值（卡片用它做初始态）。
 * `grid-size` 会从 `rowsKey/colsKey` 两个字段组装；`list` 取数组（原样，元素对象）。
 */
export function currentFieldValue(field: INodeInteractionField, values: Record<string, unknown>): unknown {
	switch (field.kind) {
		case 'grid-size': {
			const rowsKey = field.rowsKey ?? 'rows';
			const colsKey = field.colsKey ?? 'cols';
			const rows = Number(values[rowsKey]);
			const cols = Number(values[colsKey]);
			return {
				rows: Number.isFinite(rows) && rows > 0 ? rows : (field.defaultRows ?? 3),
				cols: Number.isFinite(cols) && cols > 0 ? cols : (field.defaultCols ?? 3),
			};
		}
		case 'list': {
			const raw = values[field.key];
			return Array.isArray(raw) ? raw : [];
		}
		// 参考图像：节点未钉资产时返回空数组（执行侧会用上游图像补默认值）。
		case 'image-ref': {
			return toAssetRefArray(values[field.key]);
		}
		case 'number': {
			const n = Number(values[field.key]);
			return Number.isFinite(n) ? n : defaultFieldValue(field);
		}
		case 'boolean':
			return typeof values[field.key] === 'boolean' ? values[field.key] : defaultFieldValue(field);
		default: {
			const v = values[field.key];
			return typeof v === 'string' && v ? v : defaultFieldValue(field);
		}
	}
}

/** 构造卡片初始值（schema 全字段）。 */
export function buildInteractionInitialValues(
	schema: INodeInteractionSchema,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of schema.fields) {
		out[f.key] = currentFieldValue(f, values);
	}
	return out;
}

/**
 * 把用户在卡片中提交的值合并进节点 values（**纯函数**）。
 *
 * 规则：
 *   - `grid-size` 展开成 `rowsKey/colsKey` 两个数字字段；
 *   - `list` 原样写入（数组）；
 *   - 其余按 key 写入；
 *   - `undefined`/`null` 跳过（不覆盖原值）；
 *   - 提交值**覆盖** data 顶层配置（用户当场选择优先）。
 */
export function applyInteractionValues(
	schema: INodeInteractionSchema,
	base: Record<string, unknown>,
	submitted: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const f of schema.fields) {
		const v = submitted[f.key];
		if (v === undefined || v === null) { continue; }
		if (f.kind === 'grid-size') {
			const rowsKey = f.rowsKey ?? 'rows';
			const colsKey = f.colsKey ?? 'cols';
			const g = v as { rows?: unknown; cols?: unknown };
			const rows = Number(g?.rows);
			const cols = Number(g?.cols);
			if (Number.isFinite(rows) && rows > 0) { out[rowsKey] = Math.round(rows); }
			if (Number.isFinite(cols) && cols > 0) { out[colsKey] = Math.round(cols); }
			continue;
		}
		out[f.key] = v;
	}
	return out;
}

/**
 * 参考图像字段（`kind:'image-ref'`）的**默认值**（2026-09-11 用户需求）。
 *
 * 规则：节点**未钉住资产**（该字段初值为空数组）且存在上游图像 → 用第一张作默认参考图
 * —— 于是「有默认值（上游节点的输入值）就默认显示」。已钉住则**不覆盖**（用户/画布的
 * 显式选择优先）。
 *
 * 纯函数：执行侧在 fire `node_interaction` 前调用，返回值并入 initialValues；
 * 卡片另从 `initialValues.__assetCandidates` 取候选列表渲染「选择图像」。
 */
export function buildImageRefDefaults(
	schema: INodeInteractionSchema,
	initialValues: Record<string, unknown>,
	upstreamImageRefs: ReadonlyArray<string>,
): Record<string, unknown> {
	const first = upstreamImageRefs.find(r => typeof r === 'string' && r.length > 0);
	if (!first) { return {}; }
	const out: Record<string, unknown> = {};
	for (const f of schema.fields) {
		if (f.kind !== 'image-ref') { continue; }
		const cur = initialValues[f.key];
		if (!Array.isArray(cur) || cur.length === 0) {
			out[f.key] = [{ ref: first, slot: f.slot ?? 0 }];
		}
	}
	return out;
}

/** 参考图像候选（卡片「选择图像」网格里的一格）。 */
export interface IImageRefCandidate { ref: string; label?: string; }

/**
 * 收集参考图像字段的候选（2026-09-11 用户报障「表情包的参考图像无法进行选择」后扩展）。
 *
 * 由来：候选**原本只取「直接上游」节点**的图像快照 —— 但表情包这类节点的上游只有 `start`
 * （不产图）→ 候选为空 → 卡片按「无候选不渲染按钮」直接**连按钮都不给** → 用户
 * **完全无法指定参考图** ✗（报障截图：只有一张只读预览图，点它毫无反应）。
 *
 * 现分两组返回，**刻意不合并**：
 *  · `upstream`：直接上游节点的图像 → **只用于默认值**（「不选也能用上游图」语义不变）；
 *  · `all`：上游 + **本工作流其它节点**已产出的图像（上游在前）→ 用于「选择图像」网格。
 *    若把 `all` 也用于默认值，会把无关节点的图**自动钉成**参考图 ✗。
 *
 * 纯函数（无 IO / DOM），`nodeStates` 传 `Map<nodeId, { snapshot }>` 即可单测。
 */
export function collectImageRefCandidates(
	connections: ReadonlyArray<{ from?: string; to?: string }> | undefined,
	nodeStates: ReadonlyMap<string, { snapshot?: ReadonlyArray<{ kind?: string; ref?: string }> }> | undefined,
	nodeId: string,
	nameOf?: (nodeId: string) => string | undefined,
): { upstream: IImageRefCandidate[]; all: IImageRefCandidate[] } {
	const upstreamIds = new Set(
		(connections ?? []).filter(c => c?.to === nodeId && typeof c?.from === 'string').map(c => c.from as string),
	);
	const seen = new Set<string>();
	const upstream: IImageRefCandidate[] = [];
	const all: IImageRefCandidate[] = [];
	const collect = (into: IImageRefCandidate[], snapshot: ReadonlyArray<{ kind?: string; ref?: string }> | undefined, label?: string): void => {
		for (const m of snapshot ?? []) {
			if (m?.kind !== 'image' || !m.ref || seen.has(m.ref)) { continue; }
			seen.add(m.ref);
			into.push(label ? { ref: m.ref, label } : { ref: m.ref });
		}
	};
	for (const sid of upstreamIds) {
		collect(upstream, nodeStates?.get(sid)?.snapshot, '上游图像');
	}
	all.push(...upstream);
	for (const [sid, st] of nodeStates ?? new Map<string, { snapshot?: ReadonlyArray<{ kind?: string; ref?: string }> }>()) {
		if (sid === nodeId || upstreamIds.has(sid)) { continue; }
		collect(all, st?.snapshot, nameOf?.(sid));
	}
	return { upstream, all };
}

/**
 * 把列表字段按网格尺寸补齐/截断（用户改 m×n 后，提示词列表长度跟随）。
 * 纯函数，供卡片在行/列变化时即时调整输入行数。
 */
export function resizeListToGrid(
	items: ReadonlyArray<Record<string, unknown>>,
	grid: { rows?: unknown; cols?: unknown },
	itemTemplate: () => Record<string, unknown>,
): Array<Record<string, unknown>> {
	const rows = Math.max(1, Math.round(Number(grid?.rows) || 1));
	const cols = Math.max(1, Math.round(Number(grid?.cols) || 1));
	const want = Math.min(64, rows * cols);
	const out = items.slice(0, want).map(i => ({ ...i }));
	while (out.length < want) { out.push(itemTemplate()); }
	return out;
}
