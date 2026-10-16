// @vssaros/dsh-codebase — parser/facts：把 tree-sitter 的树**收成可序列化的事实**（纯函数，不碰 fs / 不碰 worker ✓）。
//
// 为什么先只做"顶层声明"这一档（P0 范围内）：P0 要证的是**运行时通路**（能不能起 worker、能不能喂 wasm、
// 缺 grammar 会不会明确报错 ✓），不是"符号抽取做得多全" ✗。所以这里刻意**只报它真知道的东西** ✓：
//   · 顶层命名节点的 `type` / `name` / 起止行 / 是否 export；
//   · 有没有语法错误（`rootNode.hasError`）——**这是"解析成功"与"解出来一坨错误节点"的分水岭** ✓。
//
// ⚠ 与 IDE 真源的 `AST_TO_NODE_TYPE`（`common/codebaseIndexDefaults.ts:265`）**不做映射** ✗：
//   那要把"语言 AST 类型 → 图谱节点 label"整张表搬过来，属 P2（真解析期）的事 ✓；
//   现在多搬一张表就多一处迟早漂移的地方 ✗（本仓已有同型事故：两份名单各写一份）。
//
// ⚠ 也不做 `.ts → typescript` 这种**扩展名映射** ✗（同一条理由）：P0 的语言由调用方**显式给** ✓，
//   P2 再把 `EXTENSION_TO_WASM_LANG` 搬过来并加一条**跨仓对账**守卫 ✓。

/** 一次解析最多报多少个顶层声明（防某语言把整个文件当一个节点、也防病态输入 ✓）。 */
export const MAX_TOP_LEVEL = 400;

/** 取字段文本（同名 API 在真源 `walkAST` 里也是这么用的 ✓）。 */
function textOfField(node, field) {
	try {
		const found = node?.childForFieldName?.(field);
		return found ? String(found.text ?? '') : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 顶层节点 → 声明。**`export_statement` 必须下钻** ✓：
 * `export class Circle {}` 的顶层类型是 `export_statement`（`tree-sitter-typescript` 下就是如此 ✓），
 * 只报它会让"抽到的东西"跟"人看到的源码"对不上（本仓教训里的"读错位置"同型 ✗）。
 * ⚠ 下钻**只走一层**：`export default class X` / `export function f` / `export const x` 都是一层 ✓；
 *   多包的 `export {…} from '…'` 本来就没有声明子节点 ⇒ 如实保留 `export_statement` 本身（不假装抽到了符号 ✗）。
 */
export function declarationOf(node) {
	if (!node) {
		return undefined;
	}
	if (node.type !== 'export_statement') {
		return node;
	}
	let inner;
	try {
		inner = node.childForFieldName?.('declaration');
	} catch {
		inner = undefined;
	}
	if (!inner) {
		inner = (node.namedChildren ?? []).filter(child => child?.type !== 'comment')[0];
	}
	return inner && inner.type !== 'export_statement' ? inner : node;
}

/**
 * 名字：优先 `name` 字段 ✓；`lexical_declaration`/`variable_declaration` 的 `name` 在**声明子**上，
 * 所以再试一层 ✓（`const a = 1` ⇒ `a`）。都拿不到就**如实返回 undefined** ✓（不编一个 `(无名)` 出来 ✗）。
 */
export function nameOf(node) {
	const direct = textOfField(node, 'name');
	if (direct) {
		return direct;
	}
	for (const child of node?.namedChildren ?? []) {
		const name = textOfField(child, 'name');
		if (name) {
			return name;
		}
	}
	return undefined;
}

/** 节点起止行（**1 基**，与图谱契约的 `startLine`/`endLine` 同口径 ✓）。 */
export function lineRangeOf(node) {
	const start = node?.startPosition?.row;
	const end = node?.endPosition?.row;
	return {
		startLine: Number.isFinite(start) ? start + 1 : undefined,
		endLine: Number.isFinite(end) ? end + 1 : undefined,
	};
}

/** 有界遍历命名节点数（证明"真的走了一遍树"而不是只看了根 ✓；有上限，如实标截断 ✓）。 */
export function countNamedNodes(root, { limit = 20000 } = {}) {
	let count = 0;
	let truncated = false;
	const walk = node => {
		if (!node) {
			return;
		}
		if (count >= limit) {
			truncated = true;
			return;
		}
		count++;
		for (const child of node.namedChildren ?? []) {
			walk(child);
		}
	};
	walk(root);
	return { count, truncated };
}

/**
 * 树 → 事实（**P0 的断言对象** ✓）。返回的都是 JSON 安全的原始值（跨线程 structured clone ✓）。
 * @returns `{ rootType, hasError, namedNodes, namedNodesTruncated, topLevel, topLevelTruncated, sourceBytes }`
 */
export function factsFromTree(tree, { maxTopLevel = MAX_TOP_LEVEL, sourceBytes } = {}) {
	const root = tree?.rootNode;
	if (!root) {
		return undefined;
	}
	const topLevel = [];
	let topLevelTruncated = false;
	for (const child of root.namedChildren ?? []) {
		if (child?.type === 'comment') {
			continue;
		}
		if (topLevel.length >= maxTopLevel) {
			topLevelTruncated = true;
			break;
		}
		const declaration = declarationOf(child);
		const range = lineRangeOf(declaration);
		const name = nameOf(declaration);
		topLevel.push({
			type: declaration.type,
			// 顶层本来就是 `export_statement` 时把它一并报出来（下钻后 `type` 会变成 `class_declaration` ✓）
			topLevelType: child.type,
			exported: child.type === 'export_statement',
			...(name ? { name } : {}),
			...(range.startLine ? { startLine: range.startLine } : {}),
			...(range.endLine ? { endLine: range.endLine } : {}),
		});
	}
	const named = countNamedNodes(root);
	return {
		rootType: String(root.type ?? ''),
		hasError: !!root.hasError,
		namedNodes: named.count,
		namedNodesTruncated: named.truncated,
		topLevel,
		topLevelTruncated,
		...(Number.isFinite(sourceBytes) ? { sourceBytes } : {}),
	};
}
