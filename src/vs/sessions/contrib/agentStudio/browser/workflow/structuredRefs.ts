/*---------------------------------------------------------------------------------------------
 *  AskUser 结构化引用（$ref）——解析与静态校验（无依赖纯函数，2026-09-10 阶段 2）
 *
 *  背景：binding 支持 `{ "$ref": { "node": "<id>", "path": "params.x" } }` 后，
 *  引用写错（节点 id 拼错、对非契约节点写 path）在执行期只是逐条 warn —— 用户
 *  要等到跑到那个节点才发现。本模块提供**静态校验**：给定节点集合即可在
 *  执行前（乃至建图期）一次性列出所有问题。
 *--------------------------------------------------------------------------------------------*/

/** 结构化引用形状（binding 值为对象且含 $ref.node 时成立）。 */
export interface StructuredRef {
	readonly node: string;
	readonly path?: string;
}

export interface StructuredRefProblem {
	readonly nodeId: string;
	readonly bindingKey: string;
	readonly severity: 'error' | 'warning';
	readonly message: string;
}

/** 校验输入的节点最小形状（避免依赖画布节点完整类型）。 */
export interface RefValidationNode {
	readonly id: string;
	readonly type?: string;
	readonly data?: Record<string, unknown>;
}

/** 从 binding 值中识别结构化引用；非结构化返回 undefined。 */
export function parseStructuredRef(binding: unknown): StructuredRef | undefined {
	if (!binding || typeof binding !== 'object' || Array.isArray(binding)) { return undefined; }
	const ref = (binding as { $ref?: unknown }).$ref;
	if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { return undefined; }
	const node = (ref as { node?: unknown }).node;
	if (typeof node !== 'string' || !node) { return undefined; }
	const path = (ref as { path?: unknown }).path;
	return typeof path === 'string' ? { node, path } : { node };
}

/**
 * 契约数据源节点：输出为结构化 JSON 契约（AskUser 的 labels/params/assets）。
 * 画布持久化的是全名（`Saros.AskUser`），引擎枚举是 `askUser` —— 归一后比较。
 */
function isContractSource(type: string | undefined): boolean {
	const short = (type ?? '').split('.').pop()?.toLowerCase() ?? '';
	return short === 'askuser';
}

/**
 * 静态校验所有节点的结构化引用。返回问题列表（空数组 = 无问题）。
 *
 * 规则：
 *  1. $ref 节点 id 不存在            → error（必然悬空，执行期取不到值）
 *  2. 对非契约节点写非空 path         → warning（该节点输出是纯文本，path 被忽略）
 *  3. $ref 缺少 node 字段             → error（无法解析，静默回落模板易被误认为生效）
 */
export function validateStructuredRefs(nodes: readonly RefValidationNode[]): StructuredRefProblem[] {
	const problems: StructuredRefProblem[] = [];
	const byId = new Map<string, RefValidationNode>();
	for (const n of nodes) { byId.set(n.id, n); }

	for (const n of nodes) {
		const bindings = (n.data?.['bindings'] ?? {}) as Record<string, unknown>;
		for (const [key, binding] of Object.entries(bindings)) {
			// 形如 { $ref: ... } 但缺 node → 规则 3
			if (binding && typeof binding === 'object' && !Array.isArray(binding)
				&& (binding as { $ref?: unknown }).$ref !== undefined) {
				const ref = parseStructuredRef(binding);
				if (!ref) {
					problems.push({ nodeId: n.id, bindingKey: key, severity: 'error', message: '$ref 缺少 node 字段（无法解析，将静默回落模板/default）' });
					continue;
				}
				const target = byId.get(ref.node);
				if (!target) {
					problems.push({ nodeId: n.id, bindingKey: key, severity: 'error', message: `引用的节点 ${ref.node} 不存在（悬空引用）` });
					continue;
				}
				if (ref.path && !isContractSource(target.type)) {
					problems.push({ nodeId: n.id, bindingKey: key, severity: 'warning', message: `节点 ${ref.node}（${target.type ?? '?'}）输出非结构化契约，path '${ref.path}' 将被忽略` });
				}
			}
		}
	}
	return problems;
}
