/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI **strict 工具模式**的 schema 清洗与可判定性（2026-09-21）。
 *
 * ## 为什么需要这一层
 *
 * 打开 `tools[].function.strict = true` 后，OpenAI 会按 **structured outputs 的子集**校验 schema，
 * 不满足即**整个请求 400**（不是忽略该字段）：
 *  1. 每个 object 节点必须有 `additionalProperties: false`；
 *  2. 每个 object 节点的 `properties` **必须全部列进 `required`**（strict 没有"可选参数"概念）；
 *  3. 一批关键字**不允许出现**：`pattern` / `format` / `minLength` / `maxLength` /
 *     `minimum` / `maximum` / `multipleOf` / `minItems` / `maxItems` / `uniqueItems` /
 *     `minProperties` / `maxProperties` / `dependentRequired` / `dependentSchemas` /
 *     `if`/`then`/`else` / `not`；
 *  4. 部分结构**无法被清洗掉**（改了就改变语义）：`type` 数组（联合类型，如 `['string','null']`）、
 *     `$ref`、`oneOf` / `allOf`、`patternProperties` / `propertyNames`。
 *
 * ## 本仓的现实约束（决定了"清洗"而非"只过滤"）
 *
 * 实测工具 schema 用量：`pattern` **61 处**、`format` 5、`maxItems` 3、`minimum/maximum` 3、`minItems` 1。
 * ⇒ 若只用"可判定"的方式（不兼容就退出 strict），绝大多数工具（凡带路径正则的）都会退出，
 *   strict 等于没开。故对第 3 类关键字采**清洗**（strict 副本里删掉），对第 4 类采**退出**
 *   （该工具单独退回普通模式，不影响同批其它工具）。
 *
 * ## 代价（必须知情）
 *
 * 清洗后，模型**看不到** `pattern`/`format`/数值上下界这类"形状提示"（描述仍在，工具侧校验不变）。
 * 这是 strict 换取"参数结构必合法（无多余键 + 必需齐全）"的代价；两者不可兼得。
 */

import type { IToolDefinition } from '../providers.js';

/**
 * strict 下**不允许出现、但可以被安全删除**的关键字（删掉只损失"形状提示"，不改变语义骨架）。
 *
 * ⚠ 与第 4 类（结构阻断）不同：这些删掉后 schema 仍是**同一份结构的合法子集**。
 */
export const STRICT_DROPPED_KEYWORDS: readonly string[] = [
	'pattern', 'format',
	'minLength', 'maxLength',
	'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
	'minItems', 'maxItems', 'uniqueItems',
	'minProperties', 'maxProperties',
	'dependentRequired', 'dependentSchemas',
	'if', 'then', 'else',
];

/**
 * strict 下**无法通过清洗解决**的结构 -> 该工具退回普通模式（绝不猜测性改写语义）。
 *
 * - `oneOf` / `allOf` / `not`：语义等价改写会改变约束含义（`allOf` 尚可展开，但成本与风险不值得）；
 * - `$ref` / `patternProperties` / `propertyNames`：需要解析引用或改写键空间；
 * - `type` 数组：strict 不允许联合类型（想表达"可空"得用别的手段，本仓 schema 不这么写）。
 */
export const STRICT_STRUCTURAL_BLOCKERS: readonly string[] = [
	'oneOf', 'allOf', 'not', '$ref', 'patternProperties', 'propertyNames',
];

/** 是否为 object 型 schema 节点（strict 的 `additionalProperties`/`required` 规则只作用于它）。 */
function isObjectNode(s: Record<string, unknown>): boolean {
	return s['type'] === 'object' || (s['type'] === undefined && !!s['properties']);
}

/** 就地清洗 + 自洽化一个**已克隆**的节点，并递归其子树。 */
function sanitizeNode(node: unknown): void {
	if (!node || typeof node !== 'object') { return; }
	if (Array.isArray(node)) {
		for (const item of node) { sanitizeNode(item); }
		return;
	}
	const s = node as Record<string, unknown>;

	for (const kw of STRICT_DROPPED_KEYWORDS) {
		if (kw in s) { delete s[kw]; }
	}

	if (isObjectNode(s)) {
		s['additionalProperties'] = false;
		const props = s['properties'];
		if (props && typeof props === 'object' && !Array.isArray(props)) {
			const propKeys = Object.keys(props as Record<string, unknown>);
			// required 必须**覆盖全部属性**：保留原有顺序（读起来仍像"必填在前"），补齐其余
			const existing = Array.isArray(s['required']) ? (s['required'] as unknown[]).filter(k => typeof k === 'string') as string[] : [];
			const missing = propKeys.filter(k => !existing.includes(k));
			s['required'] = [...existing.filter(k => propKeys.includes(k)), ...missing];
		} else if (!Array.isArray(s['required'])) {
			// 无 properties 的 object：strict 允许空 required，但显式写出来更不容易被判违规
			s['required'] = [];
		}
	}

	// 递归子树（properties / items / $defs / definitions / anyOf 等都可能带嵌套 object）
	for (const key of ['properties', 'items', 'anyOf', '$defs', 'definitions', 'contains']) {
		const child = s[key];
		if (child && typeof child === 'object') {
			if (Array.isArray(child)) { for (const c of child) { sanitizeNode(c); } }
			else if (key === 'properties' || key === '$defs' || key === 'definitions') {
				for (const v of Object.values(child as Record<string, unknown>)) { sanitizeNode(v); }
			} else { sanitizeNode(child); }
		}
	}
	// items 也可能是数组形式（tuple）—— 已在上面按 Array 分支覆盖
}

/** 递归查找是否存在**结构阻断**关键字（`type` 数组亦算）。 */
function hasStructuralBlocker(node: unknown): boolean {
	if (!node || typeof node !== 'object') { return false; }
	if (Array.isArray(node)) { return node.some(hasStructuralBlocker); }
	const s = node as Record<string, unknown>;
	for (const kw of STRICT_STRUCTURAL_BLOCKERS) {
		if (kw in s) { return true; }
	}
	if (Array.isArray(s['type'])) { return true; }
	for (const key of ['properties', '$defs', 'definitions']) {
		const child = s[key];
		if (child && typeof child === 'object' && !Array.isArray(child)) {
			for (const v of Object.values(child as Record<string, unknown>)) {
				if (hasStructuralBlocker(v)) { return true; }
			}
		}
	}
	for (const key of ['items', 'anyOf', 'contains']) {
		if (hasStructuralBlocker(s[key])) { return true; }
	}
	return false;
}

/**
 * 单个工具的 strict 决策：能开就返回**清洗后的副本**，不能开就原样退回。
 *
 * 纯函数、不修改入参（清洗在深拷贝上进行）—— 因为同一份 `IToolDefinition.inputSchema`
 * 可能同时被别的路径使用（例如文本兜底的工具描述、prompt 里的工具清单）。
 */
export function prepareToolSchemaForStrict(
	schema: unknown,
): { readonly parameters: Record<string, unknown>; readonly strict: boolean } {
	const original = (schema && typeof schema === 'object' && !Array.isArray(schema))
		? schema as Record<string, unknown>
		: {};
	if (!isStrictApplicable(original)) {
		return { parameters: original, strict: false };
	}
	let cloned: Record<string, unknown>;
	try {
		cloned = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
	} catch {
		// 含循环引用/DOM 句柄等不可序列化内容 -> 退回（绝不能因此让请求构造抛错）
		return { parameters: original, strict: false };
	}
	sanitizeNode(cloned);
	return { parameters: cloned, strict: true };
}

/**
 * 该工具的 schema 是否能进入 strict（**不克隆**，纯判定）。
 *
 * 供调用方在"转换 + 统计日志"两处复用而不必跑两遍清洗（清洗含深拷贝，是有成本的那部分）。
 */
export function isStrictApplicable(schema: unknown): boolean {
	const s = (schema && typeof schema === 'object' && !Array.isArray(schema))
		? schema as Record<string, unknown>
		: {};
	return !hasStructuralBlocker(s);
}

/** 工具面的 strict 统计（供日志：能开几个、为什么退回了几个）。 */
export interface IStrictToolStats {
	readonly strictTools: string[];
	readonly fallbackTools: string[];
}

/** 按 strict 规则转换整批工具，并给出统计。 */
export function applyStrictToTools(tools: readonly IToolDefinition[]): {
	readonly out: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean } }>;
	readonly stats: IStrictToolStats;
} {
	const strictTools: string[] = [];
	const fallbackTools: string[] = [];
	const out = tools.map(t => {
		const { parameters, strict } = prepareToolSchemaForStrict(t.inputSchema);
		if (strict) { strictTools.push(t.name); } else { fallbackTools.push(t.name); }
		return {
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters,
				...(strict ? { strict: true } : {}),
			},
		};
	});
	return { out, stats: { strictTools, fallbackTools } };
}
