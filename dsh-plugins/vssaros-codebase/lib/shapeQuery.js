// @vssaros/dsh-codebase — **形状查询**：把页面上最常见的几种"看图提问"映射到既有的 core helper。
//
// ## 它是什么 / 不是什么（写在这里，免得后来者以为这是 Cypher ✗）
//
// 原「Codebase Memory」面板的 Query Console 是一个 **Cypher** 输入框；dsh 侧**没有**图查询语言 ✗
// （2026-10-13 决定：不引入解析器/执行器 —— 那约等于一个新子系统 ✗）。能做且**诚实**的事是：
// 把用户真正在问的那几种**问题形状**（找同类型的、找某个文件里的、看一个符号的依赖、看最热的）
// 用一个**极小的语法**表达出来 ⇒ 转发到既有 helper（`topNodes` / `dependenciesOf` / `searchNodes` ✓）。
//
// 因此本模块的两条纪律：
//   ① **只认列在 `SHAPE_HELP` 里的写法**；其它输入一律 `ok:false` 并**列出支持的写法** ✓
//      （"看着像支持整门语言、其实只跑通一条"是最坏的形态 ✗✗）；
//   ② 纯函数（不读盘、不依赖 ctx ✓）⇒ 可直接单测与探针断言 ✓。
//
// 语法（`kind:arg`，大小写不敏感；可选尾随 `#N` 指定条数，N ≤ 50）：
//   type:class           该节点类型里**被依赖最多**的节点（入度降序）
//   file:src/vs/editor   路径片段命中的文件里的节点（入度降序）
//   deps:localize        一个符号的出入依赖（按名字取最相关的那一个节点 ✓）
//   hot:20 / out:20      入度 / 出度最高的前 N 个节点

import { dependenciesOf, impactOf, searchNodes, topNodes } from './core/codebase.js';

/**
 * 支持的写法（页面把这张表原样显示出来 —— 支持什么、不支持什么，一眼可见 ✓）。
 *
 * ⚠ 每条**必须**带 `example` ✓，且它必须**真的能跑** ✓（有探针逐条 `parseShapeQuery` 验 ✓）——
 *   2026-10-14 踩到的真事故：页面的快捷 chip 原先是从 `usage` 里**切字符串**拼链接的
 *   （`usage.split(' ')[0]` ✗）⇒ 我把 `hot:20` 改写成 `hot:<N> 或 out:<N>` 之后，那个 chip 就变成
 *   跳到 `?shape=hot:<N>` ⇒ **点了必报错** ✓✗（"文档字符串改了、UI 上的例子就坏了" 这类静默退化 ✓）。
 *   现在 chip 用 `example` ✓、`usage` 只负责给人读 ✓ —— 两件事**不许再混用** ✗。
 *
 * ⚠ `example` 必须是**具体、真能跑出东西**的写法 ⇒ **不许含占位符**（`<` / `>` ✗）：反向突变实测
 *   `type:<label>` 这种是**能通过解析**的 ✓ ⇒ 它会变成"点了不报错、却**静默返回 0 条**"的坏例子 ✗✗
 *   （比直接报错更坏 ✓）；探针有两条判据守它（能解析 + 无占位符）✓。
 */
export const SHAPE_HELP = [
	{ usage: 'type:<label>', example: 'type:class', desc: '该节点类型里被依赖最多的节点（入度降序）' },
	{ usage: 'file:<路径片段>', example: 'file:src/vs/editor', desc: '路径片段命中的文件里的节点（入度降序）' },
	{ usage: 'deps:<符号名>', example: 'deps:localize', desc: '一个符号的出入依赖（按名字取最相关的那个节点）' },
	{ usage: 'file-deps:<文件名>', example: 'file-deps:referencesTree.ts', desc: '一个文件里**全部符号**的出入依赖（路径片段必须先**唯一命中**该文件；命中多个就列候选，不猜 ✗）' },
	{ usage: 'impact:<符号名>#<跳数>', example: 'impact:localize#2', desc: '改这个符号会波及谁（沿 CALLS **反向**找调用者；#N = 跳数 ≤ 5，缺省 2）' },
	{ usage: 'hot:<N> / out:<N>', example: 'hot:20', desc: '入度 / 出度最高的前 N 个节点（N ≤ 50 ✓，省略 N ⇒ 20 ✓；也可用尾随 `#N`，两者都写时以 `#N` 为准 ✓）' },
];

/** 条数上限：页面上的一个区块，给再多也读不完 ⇒ 与服务端一起钉住 ✓。 */
export const SHAPE_MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * 解析一条形状查询（**纯函数**）。
 * @returns `{ ok: true, shape: { kind, arg, limit } }` 或 `{ ok: false, error, hint }`
 */
export function parseShapeQuery(text) {
	const raw = String(text ?? '').trim();
	if (!raw) {
		return { ok: false, error: '空查询', hint: '写法：type:class / file:<路径片段> / deps:<符号名> / hot:20（#N 指定条数）' };
	}
	// 条数：尾随 `#N`（也接受 `#N` 在中间的空格分隔写法，如 `hot 20`）
	let body = raw;
	let limit = DEFAULT_LIMIT;
	/** `#N` 是否**显式给过**（`impact:` 那档要区分"缺省 2 跳"与"用户写了 2" ✓）。 */
	let explicit = false;
	const hash = /#(\d{1,3})\s*$/.exec(body);
	if (hash) {
		limit = Math.min(SHAPE_MAX_LIMIT, Math.max(1, Number(hash[1])));
		body = body.slice(0, hash.index).trim();
		explicit = true;
	} else {
		const spaced = /^([a-zA-Z]+)\s+(\d{1,3})$/.exec(body);
		if (spaced) {
			body = spaced[1];
			limit = Math.min(SHAPE_MAX_LIMIT, Math.max(1, Number(spaced[2])));
			explicit = true;
		}
	}
	const colon = body.indexOf(':');
	const kind = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
	const arg = (colon >= 0 ? body.slice(colon + 1) : '').trim();
	const unsupported = () => ({
		ok: false,
		error: `${kind} 不是支持的写法`,
		hint: `支持：${SHAPE_HELP.map(entry => entry.usage.split(' ')[0]).join(' / ')}（可用 #N 指定条数，最多 ${SHAPE_MAX_LIMIT}）—— 这是**子集**，不是 Cypher ✗`,
	});
	switch (kind) {
		case 'type':
			return arg ? { ok: true, shape: { kind: 'type', arg, limit } } : unsupported();
		case 'file':
			return arg ? { ok: true, shape: { kind: 'file', arg, limit } } : unsupported();
		case 'deps':
			return arg ? { ok: true, shape: { kind: 'deps', arg, limit: Math.min(limit, 12) } } : unsupported();
		case 'file-deps':
			return arg ? { ok: true, shape: { kind: 'file-deps', arg, limit: Math.min(limit, 12) } } : unsupported();
		case 'impact':
			// ⚠ 这一档的 `#N` 是**跳数**（不是条数 ✓）：缺省 2、上限 5 —— 沿 CALLS 反向遍历的代价随跳数涨 ✓
			return arg
				? { ok: true, shape: { kind: 'impact', arg, depth: explicit ? Math.min(5, limit) : 2, limit: DEFAULT_LIMIT } }
				: unsupported();
		// ★ 2026-10-13（P10 对账时抓到，**既存 bug** ✗）：`SHAPE_HELP` 一直写着 `hot:20`，
		//   而这里**把数值丢掉了** ✗ ⇒ 写 `hot:5` 会拿默认 20 条 —— "**文档说 5、实际给 20**" ✓
		//   （`hot:20` 之所以看起来没问题，只是**碰巧**撞上默认值 20 ✓✓）⇒ 典型的静默给错答案。
		//   现在：`:N` **就是条数**（≤ SHAPE_MAX_LIMIT ✓）；尾随 `#N` 仍可覆盖（显式优先 ✓）。
		case 'hot':
		case 'out': {
			const asked = Math.floor(Number(arg));
			const byNumber = Number.isFinite(asked) && asked > 0 ? Math.min(SHAPE_MAX_LIMIT, asked) : undefined;
			// ⚠ 三种输入要分开对待（**别一刀切** ✗）：
			//   · 裸 `hot` / `out`（没给数字）⇒ 缺省 20 ✓ —— 它以前就能用，收紧会**破坏既有输入** ✗（页面 `?shape=hot` ✓）；
			//   · `hot:<正整数>` ⇒ **就是条数** ✓；
			//   · `hot:abc`（给了参数但不是数字）⇒ **拒** ✗ —— 这时"想要什么"只有用户知道，
			//     悄悄按 20 办就是又一次"看着给了参数、其实被忽略" ✗✗（上面那个既存 bug 正是这一类 ✓）。
			if (arg !== '' && byNumber === undefined) {
				return unsupported();
			}
			return { ok: true, shape: { kind, arg: kind === 'hot' ? 'inDegree' : 'outDegree', limit: explicit ? limit : (byNumber ?? limit) } };
		}
		default:
			return unsupported();
	}
}

/** 节点行的机器锚点（探针按它取数 ✓ —— 与页面 `nodeRow` 同口径：`data-node-id` ✓）。 */
const idOf = node => (node?.id === undefined || node?.id === null ? undefined : String(node.id));

/**
 * 跑一条**已解析**的形状查询（**纯函数**：只读 graph ✓）。
 * @returns `{ title, rows, note? }` 或 `{ error }`
 */
export function runShapeQuery(graph, shape, { nodeLimit = 40 } = {}) {
	if (!graph || !Array.isArray(graph.nodes)) {
		return { error: '全量图没加载 ⇒ 形状查询跑不了（先加载全量图 ✓）' };
	}
	// ⚠ `depth` 只有 `impact:` 那档有 ⇒ 必须一起解构（漏了就是渲染时才炸的 ReferenceError ✗ —— 2026-10-13 实测踩到）
	const { kind, arg, limit, depth } = shape;
	if (kind === 'type') {
		const rows = topNodes(graph, { by: 'inDegree', label: arg, limit });
		return {
			title: `type:${arg} ⇒ 该类型里被依赖最多的 ${rows.length} 个`,
			rows,
			note: rows.length ? undefined : `图里没有 label=${arg} 的节点（用 hot: 或 file: 换个问法试试 ✓）`,
		};
	}
	if (kind === 'file') {
		// 手工过滤（`searchNodes` 的空 query 语义没有保证 ⇒ 不赌它 ✗），再按入度降序取前 N ✓
		const needle = arg.replace(/\\/g, '/').toLowerCase();
		const hit = graph.nodes
			.filter(node => String(node?.filePath ?? '').replace(/\\/g, '/').toLowerCase().includes(needle))
			.sort((a, b) => (Number(b?.inDegree) || 0) - (Number(a?.inDegree) || 0));
		return {
			title: `file:${arg} ⇒ 路径命中的 ${hit.length} 个节点（按入度降序，显示前 ${Math.min(limit, hit.length)}）`,
			rows: hit.slice(0, limit),
			note: hit.length > limit ? '命中很多 ⇒ 用更长的路径片段收窄 ✓' : undefined,
		};
	}
	if (kind === 'deps') {
		const found = searchNodes(graph, { query: arg, limit: 1 })[0];
		if (!found) {
			return { error: `图里没有名字像 ${arg} 的节点（先 hot: 或 type: 看看图里有什么 ✓）` };
		}
		const deps = dependenciesOf(graph, { nodeId: found.id, limit: Math.min(limit, 12) });
		if (deps?.error) {
			return { error: String(deps.error) };
		}
		return {
			title: `deps:${arg} ⇒ ${found.name ?? '(无名)'}（${found.label ?? '?'}）的出入依赖`,
			rows: [found],
			deps,
			note: `按名字取的是最相关的一个节点（id=${idOf(found) ?? '?'}）—— 要精确到某一个节点，用页面上的「节点 #id 的依赖」（?node=<id> ✓）`,
		};
	}
	if (kind === 'file-deps') {
		// ⚠ `dependenciesOf` 的 `filePath` 是**精确匹配**（不是片段 ✗）⇒ 先把片段解析成唯一路径；
		//   **命中多个就列候选、绝不猜**（猜错等于把别的文件的依赖当事实说出去 ✗ —— 与 `codebase_snippet` 同款纪律 ✓）
		const pathOf = node => String(node?.filePath ?? '').replace(/\\/g, '/');
		const needle = arg.replace(/\\/g, '/').toLowerCase();
		const files = [...new Set(graph.nodes.map(pathOf).filter(Boolean).filter(path => path.toLowerCase().includes(needle)))].sort();
		if (!files.length) {
			return { error: `图里没有路径包含 ${arg} 的文件（换个更短的片段，或用 file: 看看有哪些文件 ✓）` };
		}
		if (files.length > 1) {
			return {
				title: `file-deps:${arg} ⇒ 命中 ${files.length} 个文件（**不猜** ⇒ 用更长的片段收窄 ✓）`,
				rows: files.slice(0, nodeLimit).map(path => ({ name: path, label: 'file', filePath: path })),
				note: `这是**候选列表**（前 ${Math.min(files.length, nodeLimit)} 个）：直接拿其中一个完整路径再问一次 ✓（点一行也能在编辑器打开 ✓）。`,
			};
		}
		const deps = dependenciesOf(graph, { filePath: files[0], limit });
		if (deps?.error) {
			return { error: String(deps.error) };
		}
		return {
			title: `file-deps:${files[0]} ⇒ 该文件里 ${deps.targets.length} 个符号的出入依赖`,
			rows: [],
			deps,
			note: '出边 = 它们用了什么；入边 = 谁用了它们（只算**两端都在图里**的边 ✓，指不到的计入 dangling ✓）。',
		};
	}
	if (kind === 'impact') {
		const found = searchNodes(graph, { query: arg, limit: 1 })[0];
		if (!found) {
			return { error: `图里没有名字像 ${arg} 的节点（先 hot: 或 type: 看看图里有什么 ✓）` };
		}
		// `impactOf` 的 `reached` 里是 `{ id, depth, viaSeed }`（**不是节点本身** ✗）⇒ 自己映射回节点 ✓
		const impacted = impactOf(graph, [found.id], { depth });
		const byId = new Map(graph.nodes.map(node => [node.id, node]));
		const rows = (impacted.reached ?? [])
			.map(entry => byId.get(entry.id) ?? { id: entry.id, name: `#${entry.id}`, label: '(只在上游结果里)' })
			.slice(0, nodeLimit);
		return {
			title: `impact:${arg}#${depth} ⇒ 改「${found.name ?? '(无名)'}」会波及 ${impacted.total ?? rows.length} 个符号（沿 CALLS 反向找调用者 ✓）`,
			rows,
			note: `${impacted.truncated ? '⚠ 结果被截断（图很大）⇒ 调小跳数 ✓ ' : ''}方向说死：**往上找调用者**（"我改了它，谁会被波及" ✓）—— 不是"它依赖谁"（那是 <code>deps:</code> ✓）。`,
		};
	}
	const rows = topNodes(graph, { by: arg, limit });
	return {
		title: `${kind}:${limit} ⇒ ${kind === 'hot' ? '入度' : '出度'}最高的 ${rows.length} 个节点`,
		rows: rows.slice(0, nodeLimit),
	};
}
