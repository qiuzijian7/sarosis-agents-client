/**
 * ARIA 快照（2026-11-07，P1 · 对齐 DS Bot 的 `ariaSnapshot({mode:'ai'})`，第一版 opt-in：`snapshot` + `format: "aria"`）。
 *
 * ## 和默认快照（`[n] role "name"`，`core/snapshot.js`）有什么不同
 *
 * · 角色与名字取自浏览器自己算的**可访问性树**（`Accessibility.getFullAXTree`）：`aria-labelledby`、`<label for>`、
 *   图标按钮的 `title` 这些 DOM 遍历容易算错的名字，这里是浏览器的结论；
 * · 输出**带层级**（landmark / 标题 / 列表 / 表单的嵌套），正文也在树里（`- text: …`），不是只有 2000 字的摘录；
 * · 每页 4 万字符，超出分页（`page: 2` …），不截断丢内容；
 * · 可交互的节点带 `[n]`，**和默认快照同一套引用**：点 / 输入照旧用 `ref: n`。做法是把 n 写回元素的
 *   `data-saros-ref` 属性（`DOM.pushNodesByBackendIdsToFrontend` + `DOM.setAttributeValue`），所以 `click` / `type`
 *   一行都不用改。⚠ 没用 DS Bot 的 `[ref=eN]` 写法：`ref` 参数是整数，换成字符串要改参数类型，所有调用方都得跟着变。
 *
 * 读不到可访问性树（老内核 / 权限）⇒ 抛错，调用方回落到默认快照并如实说明。
 */

import { SAROS_REF_ATTR } from './snapshot.js';

/** 每页字符数（与 DS Bot 的 40k 截断同量级；超出分页而不是截断）。 */
export const ARIA_PAGE_CHARS = 40_000;
/** 最多给多少个可交互节点编号（与默认快照的 `MAX_SNAPSHOT_REFS` 同量级）。 */
export const ARIA_MAX_REFS = 600;

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
	'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'treeitem', 'listbox']);
/** 本身不出一行、只把子节点往上提的角色。 */
const TRANSPARENT = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'ignored', 'GenericContainer', 'Section', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);
/** 整个子树都不出（`<label>` 的文字已经是对应输入框的名字）。 */
const SKIPPED = new Set(['LabelText']);
const STATES = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'focused'];

const valueOf = v => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const quote = s => JSON.stringify(clean(s).slice(0, 200));

/**
 * 把 AX 节点列表渲染成带缩进的树（纯函数，便于单测）。
 * @param {Array<object>} nodes `Accessibility.getFullAXTree` 的 `nodes`
 * @returns {{ lines: string[], refs: Array<{ ref: number, backendDOMNodeId: number }> }}
 */
export function renderAxTree(nodes, maxRefs = ARIA_MAX_REFS) {
	const byId = new Map(nodes.map(node => [node.nodeId, node]));
	const childIds = new Set(nodes.flatMap(node => node.childIds ?? []));
	const roots = nodes.filter(node => !node.parentId && !childIds.has(node.nodeId));
	const lines = [];
	const refs = [];
	const seen = new Set();
	const walk = (node, depth, parentName) => {
		if (!node || seen.has(node.nodeId)) { return; }
		seen.add(node.nodeId);
		const role = String(valueOf(node.role) ?? '');
		const name = clean(valueOf(node.name));
		const children = (node.childIds ?? []).map(id => byId.get(id)).filter(Boolean);
		if (SKIPPED.has(role)) { return; }
		if (node.ignored || (TRANSPARENT.has(role) && !name) || (TRANSPARENT.has(role) && role !== 'generic' && role !== 'none')) {
			for (const child of children) { walk(child, depth, parentName); }
			return;
		}
		if (role === 'StaticText') {
			// 按钮 / 链接的名字已经写在它那一行，重复的文字不再出一行
			if (name && name !== parentName) { lines.push(`${'  '.repeat(depth)}- text: ${quote(name)}`); }
			return;
		}
		let line = `${'  '.repeat(depth)}- ${role || 'node'}${name ? ` ${quote(name)}` : ''}`;
		const value = clean(valueOf(node.value));
		if (value && value !== name) { line += `: ${quote(value)}`; }
		for (const prop of node.properties ?? []) {
			if (!STATES.includes(prop.name)) { continue; }
			const v = valueOf(prop.value);
			if (v === true || v === 'true' || v === 'mixed') { line += ` [${prop.name}${v === 'mixed' ? '=mixed' : ''}]`; }
		}
		const level = (node.properties ?? []).find(prop => prop.name === 'level');
		if (role === 'heading' && level) { line += ` [level=${valueOf(level.value)}]`; }
		if (INTERACTIVE.has(role) && typeof node.backendDOMNodeId === 'number' && refs.length < maxRefs) {
			const ref = refs.length + 1;
			refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId });
			line += ` [${ref}]`;
		}
		lines.push(line);
		for (const child of children) { walk(child, depth + 1, name); }
	};
	for (const root of roots) { walk(root, 0, ''); }
	return { lines, refs };
}

/** 把行切成每页 ≤ `pageChars` 字符的页（一行不拆）。 */
export function paginate(lines, pageChars = ARIA_PAGE_CHARS) {
	const pages = [];
	let current = [];
	let size = 0;
	for (const line of lines) {
		if (size + line.length + 1 > pageChars && current.length) { pages.push(current); current = []; size = 0; }
		current.push(line);
		size += line.length + 1;
	}
	if (current.length || !pages.length) { pages.push(current); }
	return pages;
}

/**
 * 取当前页的 ARIA 快照（会话自己那条 tab；右栏模式下就是右栏那一页）。
 * @param {import('./client.js').BrowserCdpClient} client
 * @param {{ page?: number }} options
 */
export async function ariaSnapshot(client, options = {}) {
	const tree = await client._send('Accessibility.getFullAXTree', {});
	const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
	if (!nodes.length) { throw new Error('可访问性树是空的（页面还没加载完，或内核不支持 Accessibility.getFullAXTree）'); }
	const { lines, refs } = renderAxTree(nodes);
	// 清掉旧引用，再把这次的编号写回元素（click / type 靠它定位）
	const head = await client._evaluate(`(() => { document.querySelectorAll('[${SAROS_REF_ATTR}]').forEach(e => e.removeAttribute('${SAROS_REF_ATTR}'));
		return { url: location.href, title: document.title }; })()`, 10_000);
	let tagged = 0;
	if (refs.length) {
		await client._send('DOM.getDocument', { depth: 0 });
		const pushed = await client._send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: refs.map(r => r.backendDOMNodeId) });
		const nodeIds = Array.isArray(pushed?.nodeIds) ? pushed.nodeIds : [];
		const results = await Promise.allSettled(refs.map((r, i) => nodeIds[i]
			? client._send('DOM.setAttributeValue', { nodeId: nodeIds[i], name: SAROS_REF_ATTR, value: String(r.ref) })
			: Promise.reject(new Error('not in DOM'))));
		tagged = results.filter(result => result.status === 'fulfilled').length;
	}
	const pages = paginate(lines);
	const index = Math.min(Math.max(1, Number.isInteger(options.page) ? options.page : 1), pages.length);
	const footer = pages.length > 1
		? `\n\n（第 ${index}/${pages.length} 页${index < pages.length ? `；下一页：\`op: "snapshot", format: "aria", page: ${index + 1}\`` : ''}。翻页会重取一次快照：页面没变时编号不变，变了就以最新这页为准。）`
		: '';
	return `Page: ${clean(head?.title)}\nURL: ${String(head?.url ?? '')}\nFormat: aria（[n] = ref，click / type 用 \`ref: n\`；${tagged}/${refs.length} 个可交互节点已编号）\n\n`
		+ pages[index - 1].join('\n') + footer;
}
