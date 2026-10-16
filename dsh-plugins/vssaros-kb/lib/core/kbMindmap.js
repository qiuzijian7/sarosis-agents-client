// @vssaros/dsh-kb — 思维导图（JSON Canvas）的**确定性那一半**（P4，2026-10-14）。
//
// ## 它复刻的是谁
// 真源 `src/vs/.../views/knowledge/kbMindmapGenerator.ts`（696 行 ✓，逐行读过 ✓）。
// 它有两半：
//   · **LLM 那半**（`_extractGraph` / `_refineGraph` / `suggestMindmapTitle` ✓ —— `chatModel.complete` ✓）
//     ⇒ dsh 侧没有 chatModel ⇒ 走 **subagent**（kb_build 同款 ✓），**提示词由本文件的纯函数产出**
//     （与真源逐字一致 ✓ ⇒ 喂给模型的字不变 ✓），子代理的**回文解析**也用真源同一段清洗逻辑 ✓；
//   · **确定性这半**（本文件 ✓）：merge（Jaccard 去重 ✓）/ relayout（双侧放射 ✓）/ refine 合并 /
//     命名推导 / JSON Canvas 读写 ✓ —— 全部可黄金表（p3-83：真源打包 ＋ 假 fileService ＋ 罐头 chatModel
//     ⇒ 两边落盘的 .canvas **逐字节比** ✓）。
//
// ## 照抄的要点（改了就是分叉 ✗）
//   · 写盘格式 `JSON.stringify(mindmap, null, '\t')`（**tab 缩进** ✓，`writeMindmap:119` ✓）；
//   · `mindmap: true` 标记（编辑器据此强制树状布局 ✓）；
//   · 合并去重 = content 前 60 字符小写空白折叠**相等**（注释说 Jaccard ≥0.7，**实现就是相等** ✓ ——
//     注释与实现不符，照抄实现 ✓）；
//   · relayout：根 = 入度最小 → 出度最大 → 首个 ✓；BFS 建树；孤立节点挂根下 ✓；左右贪心均衡 ✓；
//     常量 NODE_W=280 / NODE_H=80 / LEVEL_GAP=72 / SIB_GAP=24 / MARGIN=80 ✓；
//   · id 冲突时用 `'n' + Math.random().toString(36).slice(2,10)` 重编 ✓（随机 ⇒ 黄金表的夹具**避开冲突** ✓）。
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 真源常量（逐字 ✓）。 */
export const MINDTAP_FILE = 'mindmap.canvas';
export const MAX_CONTENT_LEN = 20000;

function _randomId() {
	return Math.random().toString(36).slice(2, 10);
}

// ─── JSON Canvas 读写（真源 readMindmap / writeMindmap ✓）──────────────────────────

/** 读 .canvas（解析失败 ⇒ **null** ✓ —— 调用方"不覆盖损坏原件"靠这个 ✓）。 */
export async function readMindmap(filePath) {
	try {
		const parsed = JSON.parse(await readFile(filePath, 'utf8'));
		if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
			return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
		}
	} catch { /* 解析失败 ⇒ null（真源同 ✓） */ }
	return null;
}

/** 写 .canvas（**tab 缩进** ✓ —— 逐字节对账就靠这个格式 ✓）。 */
export async function writeMindmap(filePath, mindmap) {
	await writeFile(filePath, JSON.stringify(mindmap, null, '\t'), 'utf8');
}

/** 扫笔记目录的 .canvas（真源 `listMindmaps` ✓：只看**直接子文件** ✓）。 */
export async function listMindmaps(notesDir) {
	const map = new Map();
	try {
		for (const entry of await readdir(notesDir, { withFileTypes: true })) {
			if (!entry.isDirectory() && entry.name.endsWith('.canvas')) { map.set(entry.name, join(notesDir, entry.name)); }
		}
	} catch { /* 目录不存在 ⇒ 空表（真源同 ✓） */ }
	return map;
}

/**
 * 从 {@link listMindmaps} 的结果里挑"该打开哪一张"——**逐字照真源** `_openMindmap`
 * （`knowledgeBaseView.ts:5507-5508` ✓）：
 *   优先 {@link MINDTAP_FILE}（`mindmap.canvas` ✓），否则 **Map 里的第一个**（真源 `values().next().value` ✓
 *   —— 注意是**插入序**、**不排序** ✗；工具里 refine/rename 那一路用的是"排序后第一个" ✓，两者
 *   语义不同 ⇒ 别混用 ✗）。
 * ⚠ 抽成一处的理由：这条规则原先在 `index.js` 里已出现两次（`:3363` 排序版 ＋ `:4246` 插入序版 ✓），
 *   页面路由再来第三次就会三份漂移 ✓。
 * @returns `{ name, path }`；一张都没有 ⇒ `undefined`（调用方不许自己编一个名字 ✗）
 */
export function pickMindmapForOpen(map) {
	if (!map || map.size === 0) { return undefined; }
	const name = map.has(MINDTAP_FILE) ? MINDTAP_FILE : map.keys().next().value;
	const path = map.get(name);
	return path ? { name, path } : undefined;
}

// ─── 确定性合并 / 排版（逐字照真源 ✓）──────────────────────────────────────────────

/** 合并新图进现有图（真源 `_mergeGraph` ✓：内容前 60 字符判重 ✓、id 冲突随机重编 ✓）。 */
export function mergeGraph(existing, extracted) {
	const existingSet = new Set(existing.nodes.map(n => n.id));
	const existingEdges = new Set(existing.edges.map(e => `${e.fromNode}->${e.toNode}`));
	const nodes = [...existing.nodes];
	const edges = [...existing.edges];
	const usedIds = new Set(existingSet);
	function _simpleKey(content) {
		return (content || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
	}
	for (const nn of extracted.nodes) {
		const key = _simpleKey(nn.content || '');
		const dup = nodes.find(en => _simpleKey(en.content || '') === key);
		if (dup) { continue; }
		let id = nn.id;
		while (usedIds.has(id)) { id = 'n' + _randomId(); }
		usedIds.add(id);
		nodes.push({ ...nn, id });
	}
	for (const ne of extracted.edges) {
		const ek = `${ne.fromNode}->${ne.toNode}`;
		if (existingEdges.has(ek) || edges.some(e => e.fromNode === ne.fromNode && e.toNode === ne.toNode)) { continue; }
		let eid = ne.id;
		const allEdgeIds = new Set(edges.map(e => e.id));
		while (allEdgeIds.has(eid)) { eid = 'e' + _randomId(); }
		edges.push({ ...ne, id: eid });
	}
	return { nodes, edges };
}

/** refine 图的合并（真源 `_mergeRefined` ✓：同 id 用 LLM 版、新增节点 id 唯一化、边取并集 ✓）。 */
export function mergeRefined(existing, enriched) {
	const used = new Set();
	const result = [];
	const idRemap = new Map();
	const enrichedById = new Map(enriched.nodes.map(n => [n.id, n]));
	for (const ex of existing.nodes) {
		const en = enrichedById.get(ex.id);
		const node = en ? { ...en } : { ...ex };
		used.add(node.id);
		result.push(node);
	}
	for (const en of enriched.nodes) {
		if (enrichedById.has(en.id) && !existing.nodes.some(x => x.id === en.id)) {
			let id = en.id;
			while (used.has(id)) { id = 'n' + _randomId(); }
			idRemap.set(en.id, id);
			used.add(id);
			result.push({ ...en, id });
		}
	}
	const existingIds = new Set(result.map(n => n.id));
	const edges = [];
	const edgeSeen = new Set();
	for (const e of [...existing.edges, ...enriched.edges]) {
		const f = idRemap.get(e.fromNode) ?? e.fromNode;
		const t = idRemap.get(e.toNode) ?? e.toNode;
		if (!existingIds.has(f) || !existingIds.has(t)) { continue; }
		const key = `${f}->${t}`;
		if (edgeSeen.has(key)) { continue; }
		edgeSeen.add(key);
		let eid = e.id;
		const edgeIds = new Set(edges.map(x => x.id));
		while (edgeIds.has(eid)) { eid = 'e' + _randomId(); }
		edges.push({ ...e, id: eid, fromNode: f, toNode: t });
	}
	return { nodes: result, edges };
}

/** 思维导图布局（真源 `_relayoutMindmap` ✓：中心主题双侧放射 ✓；**就地改坐标** ✓）。 */
export function relayoutMindmap(mindmap) {
	const NODE_W = 280;
	const NODE_H = 80;
	const LEVEL_GAP = 72;
	const SIB_GAP = 24;
	const MARGIN = 80;

	const nodes = mindmap.nodes;
	if (nodes.length === 0) { return; }
	for (const n of nodes) { n.width = NODE_W; n.height = NODE_H; }

	const nodeMap = new Map(nodes.map(n => [n.id, n]));
	const out = new Map();
	const indeg = new Map();
	for (const n of nodes) { out.set(n.id, []); indeg.set(n.id, 0); }
	for (const e of mindmap.edges) {
		if (nodeMap.has(e.fromNode) && nodeMap.has(e.toNode)) {
			out.get(e.fromNode).push(e.toNode);
			indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
		}
	}

	const rootId = [...nodes].map(n => n.id).sort((a, b) => {
		const di = (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0);
		if (di !== 0) { return di; }
		const dout = (out.get(b)?.length ?? 0) - (out.get(a)?.length ?? 0);
		if (dout !== 0) { return dout; }
		return 0;
	})[0];

	const visited = new Set([rootId]);
	const treeChildren = new Map();
	const queue = [rootId];
	while (queue.length) {
		const cur = queue.shift();
		treeChildren.set(cur, []);
		for (const nxt of out.get(cur) ?? []) {
			if (!visited.has(nxt)) {
				visited.add(nxt);
				treeChildren.get(cur).push(nxt);
				queue.push(nxt);
			}
		}
	}
	for (const n of nodes) {
		if (!visited.has(n.id)) {
			visited.add(n.id);
			treeChildren.get(rootId).push(n.id);
		}
	}

	const layoutMap = new Map();
	for (const n of nodes) { layoutMap.set(n.id, { children: treeChildren.get(n.id) ?? [], subH: 0 }); }
	const measure = (id) => {
		const ln = layoutMap.get(id);
		if (ln.children.length === 0) {
			ln.subH = NODE_H;
		} else {
			let sum = 0;
			ln.children.forEach((c, i) => {
				sum += measure(c);
				if (i < ln.children.length - 1) { sum += SIB_GAP; }
			});
			ln.subH = Math.max(sum, NODE_H);
		}
		return ln.subH;
	};
	measure(rootId);

	const place = (id, x, centerY, dir) => {
		const node = nodeMap.get(id);
		node.x = dir === 'R' ? x : x - NODE_W;
		node.y = centerY - NODE_H / 2;
		const ln = layoutMap.get(id);
		let cursor = centerY - ln.subH / 2;
		for (const c of ln.children) {
			const childH = layoutMap.get(c).subH;
			const cCenterY = cursor + childH / 2;
			const childX = dir === 'R' ? node.x + NODE_W + LEVEL_GAP : node.x - LEVEL_GAP - NODE_W;
			place(c, childX, cCenterY, dir);
			cursor += childH + SIB_GAP;
		}
	};

	const rootChildren = layoutMap.get(rootId).children;
	const sorted = [...rootChildren].sort((a, b) => layoutMap.get(b).subH - layoutMap.get(a).subH);
	const leftIds = [];
	const rightIds = [];
	let leftLoad = 0;
	let rightLoad = 0;
	for (const c of sorted) {
		const h = layoutMap.get(c).subH;
		if (leftLoad <= rightLoad) { leftIds.push(c); leftLoad += h + SIB_GAP; }
		else { rightIds.push(c); rightLoad += h + SIB_GAP; }
	}
	const groupHeight = (ids) => {
		let s = 0;
		ids.forEach((id, i) => { s += layoutMap.get(id).subH; if (i < ids.length - 1) { s += SIB_GAP; } });
		return s;
	};

	const root = nodeMap.get(rootId);
	root.x = -NODE_W / 2;
	root.y = -NODE_H / 2;

	let lCursor = -groupHeight(leftIds) / 2;
	for (const id of leftIds) {
		const h = layoutMap.get(id).subH;
		place(id, root.x - LEVEL_GAP - NODE_W, lCursor + h / 2, 'L');
		lCursor += h + SIB_GAP;
	}
	let rCursor = -groupHeight(rightIds) / 2;
	for (const id of rightIds) {
		const h = layoutMap.get(id).subH;
		place(id, root.x + NODE_W + LEVEL_GAP, rCursor + h / 2, 'R');
		rCursor += h + SIB_GAP;
	}

	for (const e of mindmap.edges) {
		const fn = nodeMap.get(e.fromNode);
		const tn = nodeMap.get(e.toNode);
		if (!fn || !tn) { continue; }
		const fc = fn.x + fn.width / 2;
		const tc = tn.x + tn.width / 2;
		if (tc >= fc) { e.fromSide = 'right'; e.toSide = 'left'; }
		else { e.fromSide = 'left'; e.toSide = 'right'; }
		e.fromEnd = 'none';
		e.toEnd = 'arrow';
	}

	let minX = Infinity;
	let minY = Infinity;
	for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); }
	const offX = MARGIN - minX;
	const offY = MARGIN - minY;
	for (const n of nodes) { n.x += offX; n.y += offY; }
}

/** 按内容推导文件名（真源 `deriveMindmapTitle` ✓：根节点标题首行 ⇒ 净化 ⇒ .canvas ✓）。 */
export function deriveMindmapTitle(mindmap) {
	if (mindmap.nodes.length === 0) { return MINDTAP_FILE; }
	const out = new Map();
	const indeg = new Map();
	for (const n of mindmap.nodes) { out.set(n.id, []); indeg.set(n.id, 0); }
	for (const e of mindmap.edges) {
		if (out.has(e.fromNode) && out.has(e.toNode)) {
			out.get(e.fromNode).push(e.toNode);
			indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
		}
	}
	const rootId = [...mindmap.nodes].map(n => n.id)
		.sort((a, b) => (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0) || (out.get(b)?.length ?? 0) - (out.get(a)?.length ?? 0))[0];
	const root = mindmap.nodes.find(n => n.id === rootId) ?? mindmap.nodes[0];
	const firstLine = (root.content || '')
		.split('\n')[0]
		.replace(/^\*\*|\*\*$/g, '')
		.replace(/^#+\s*/, '')
		.trim()
		.slice(0, 50);
	if (firstLine.length >= 2) {
		const s = firstLine.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50);
		return `${s}.canvas`;
	}
	return MINDTAP_FILE;
}

/** 从提取内容推导文件名（真源 `_deriveNameFromContent` ✓：取**第一个**节点 ✓ —— 与上面那条不是一个口径 ✓）。 */
export function deriveNameFromContent(extracted) {
	if (extracted.nodes.length > 0) {
		const firstContent = extracted.nodes[0].content || '';
		const firstLine = firstContent.split('\n')[0]
			.replace(/^\*\*|\*\*$/g, '')
			.replace(/^#+\s*/, '')
			.trim()
			.slice(0, 50);
		if (firstLine.length >= 2) {
			const sanitized = firstLine.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50);
			return `${sanitized}.canvas`;
		}
	}
	return MINDTAP_FILE;
}

/**
 * 给"按内容改名"算一个**不撞车**的目标路径（真源 `knowledgeBaseView.ts:978-984` ✓）：先试原名，
 * 已存在就依次试 `base-2.canvas` / `base-3.canvas`…（后缀是 `-N`，**不是** ` (N)` ✗ —— 真源如此 ✓）。
 *
 * ⚠ 这个函数是 2026-10-14 一次**整包静默失效**的正解：`lib/index.js` 的 `rename` 分支 import 了它，
 * 而本文件当时**没有实现** ⇒ ESM **静态**链接失败 ⇒ `vssaros-kb` **整个模块加载不了**
 * ⇒ `kb_*` 全族工具在 Host 里**一条都注册不上**（用户侧的观感是"知识库工具全没了"，离原因十万八千里 ✗）。
 * 抓到它的是 `dshToolSnapshot` 守卫（报 `does not provide an export named 'uniqueCanvasPath'`）——
 * 它的 `failures` 判据就是为"插件在加载期就炸、清单静默缺一块"这种事写的 ✓。
 * 别把这段逻辑内联回调用侧并删掉导出 ✗：那样同一个错误会退化成"只有真跑到 rename 才炸"（更晚更难查 ✗）。
 *
 * 名字净化**不在这一层**：两条来路（`deriveMindmapTitle` / `titleFromSuggestion`）都已把
 * `[\\/:*?"<>|]` 换成 `_` ✓ ⇒ `name` 里不会有路径分隔符（真源也是在同层之外净化的 ✓）。
 * @returns `notesDir` 下的绝对路径（`.canvas`）
 */
export async function uniqueCanvasPath(notesDir, name) {
	if (!(await _fileExists(join(notesDir, name)))) { return join(notesDir, name); }
	const base = String(name).replace(/\.canvas$/, '');
	for (let i = 2; ; i++) {
		const candidate = join(notesDir, `${base}-${i}.canvas`);
		if (!(await _fileExists(candidate))) { return candidate; }
	}
}

/**
 * `fileService.exists` 的等价物。
 * ⚠ 必须用 `stat` 而不是"`readdir` 拿名字集合再比对"✗：Windows 的文件系统**大小写不敏感**，
 * 后者会把 `Plan.canvas` 当成不撞车 ⇒ 真机改名时直接覆盖别人的文件 ✗（`stat` 跟文件系统同一口径 ✓）。
 */
async function _fileExists(filePath) {
	try { await stat(filePath); return true; } catch { return false; }
}

// ─── LLM 那半的**提示词与回文解析**（逐字照真源 ✓ ⇒ 喂给模型的字不变 ✓）──────────────

/** refine 提示词（真源 `_refineGraph` 的 SYSTEM ＋ user ✓ —— 逐字 ✓）。 */
export function refineGraphPrompt(existing) {
	const system = `You are a knowledge mind-map refiner. You are given an existing mind-map (JSON with "nodes" and "edges").
Improve and complete it:
- KEEP all existing node "id"s unchanged.
- IMPROVE existing node "content" where helpful (better terse description, fix errors).
- ADD new related concepts as new nodes with NEW unique ids (e.g. "m1","m2",...). Do NOT reuse an existing id for a new node.
- ADD new edges to connect new nodes into the hierarchy (fromNode=parent, toNode=child). You may also add missing edges between existing nodes.
- Ensure the central theme remains the FIRST node and the graph is a single connected hierarchy (a tree), not a dense mesh.
- Node shape: {"id","type":"text","x":0,"y":0,"width":280,"height":80,"content":"**Title**\ndescription"} (Markdown allowed; first line is the title). You MAY also add an optional "source": {"file":"<path>","line":<n>} to a node when it clearly corresponds to a specific source artifact.
- Edge shape: {"id","fromNode","toNode","label?":""}.
Output ONLY valid JSON (no markdown fences): {"nodes":[...],"edges":[...]}`;
	const user = `Existing mind-map:\n${JSON.stringify(existing)}\n\nReturn the COMPLETE improved mind-map (all existing nodes with preserved ids + new nodes/edges).`;
	return { system, user };
}

/** 标题建议提示词（真源 `suggestMindmapTitle` ✓ —— 逐字 ✓）。 */
export function suggestTitlePrompt(mindmap) {
	const system = 'Given a mind-map (list of nodes with "content"), output a SHORT topic title (2-6 words, no punctuation, no quotes) that best names the whole map. Output only the title text.';
	const user = JSON.stringify(mindmap.nodes.map(n => ({ id: n.id, content: n.content })));
	return { system, user };
}

/** 标题回文的清洗（真源 `suggestMindmapTitle` 那一串 ✓）：剥引号 → 净化 → 空白转下划线 → 截 50 ⇒ `.canvas`。 */
export function titleFromSuggestion(raw) {
	const t = String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50);
	return t.length >= 2 ? `${t}.canvas` : null;
}

/**
 * 解析 refine 回文（真源 `_refineGraph` 的清洗 ＋ 字段补齐 ✓）：
 * ⚠ 默认尺寸是 **280/80** ✓ —— 与提取路的 **300/100** 不一样（真源两处本就不同 ⇒ 照抄 ✓）。
 */
export function parseRefinedGraph(raw) {
	try {
		const cleaned = String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
		const parsed = JSON.parse(cleaned);
		if (Array.isArray(parsed.nodes)) {
			for (const n of parsed.nodes) {
				n.type = n.type || 'text';
				n.width = n.width || 280;
				n.height = n.height || 80;
			}
			return { nodes: parsed.nodes, edges: parsed.edges || [] };
		}
	} catch { /* 解析失败 ⇒ null（真源同 ✓） */ }
	return null;
}

/** 提取提示词（真源 `_extractGraph` 的 SYSTEM ＋ user ✓ —— 逐字 ✓）。 */
export function extractGraphPrompt(contents) {
	const system = `You are a knowledge graph extractor. Given document content, extract key concepts (nodes) and their relationships (edges).

IMPORTANT RULES:
- Each node MUST have a unique "id" (short alphanumeric like "n1","n2").
- Each node must have "type": "text", "width": 280, "height": 80. Coordinates x/y will be auto-laid out later.
- Node "content" is in Markdown: first line is bold title, rest is terse description (1-2 lines max).
- Node "color" should reflect schema type: "1"=概念(concept)#bf3989, "2"=对比(comparison)#db6d28, "3"=方法(technique)#8957e5, "4"=事实(fact)#2da44e, "5"=问题(problem)#f85149, "0"=default.
- Node "source" (optional): when a node clearly corresponds to a specific source artifact, include "source": {"file": "<workspace-relative or absolute path>", "line": <number>}. Prefer the originating file shown in the "## 文件:" header above each document. Omit "source" entirely if no specific file/line is known.
- Edges connect nodes with "id","fromNode","toNode". Add optional "label" for relationship type.
- Edges should flow from broader/parent concepts to narrower/child concepts (fromNode = parent, toNode = child). Put the central theme as the FIRST node so the layout can treat it as the mind-map root.
- Build a clear hierarchy (a tree), not a fully-connected mesh: each non-root concept should connect to 1-2 broader parents.
- Extract 5-12 nodes. Do NOT repeat existing concepts that match the same content.
- Output ONLY valid JSON, no markdown fences.

Output format:
{"nodes":[...],"edges":[...]}`;
	const contentBlock = contents
		.map(c => `## 文件: ${c.fileName}\n\n${c.content}`)
		.join('\n\n---\n\n')
		.slice(0, MAX_CONTENT_LEN);
	const user = `从以下新导入的知识库内容中提取结构化图谱：

${contentBlock}

请输出 JSON 格式的节点和关系。只包含有意义的新概念，不要重复已存在的通用概念。`;
	return { system, user };
}

/**
 * 解析 LLM 回文里的图谱 JSON（真源 `_extractGraph` 的清洗 ＋ 字段补齐 ✓）：
 * 剥 markdown 围栏 ✓；节点补 type/width/height（**300/100** ✓ —— 注意提取路是 300/100、
 * refine 路是 280/80 ✓，真源两处就不一样 ⇒ 照抄 ✓，别顺手统一 ✗）。
 * 解析不了 ⇒ **null**（调用方跳过，不写盘 ✓）。
 */
export function parseExtractedGraph(raw) {
	try {
		const cleaned = String(raw ?? '')
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/```\s*$/, '')
			.trim();
		const parsed = JSON.parse(cleaned);
		if (Array.isArray(parsed.nodes)) {
			for (const n of parsed.nodes) {
				n.type = n.type || 'text';
				n.width = n.width || 300;
				n.height = n.height || 100;
			}
			return { nodes: parsed.nodes, edges: parsed.edges || [] };
		}
	} catch { /* 解析失败 ⇒ null（真源同 ✓） */ }
	return null;
}

/**
 * 提取 ⇒ 合并 ⇒ 排版 ⇒ 落盘（真源 `generateOrUpdate` 的**确定性尾巴** ✓，LLM 那步在调用侧 ✓）。
 * ⚠ 已有文件**解析失败 ⇒ 改名写入**（`mindmap-broken-<ts>.canvas`，保留损坏原件 ✓，真源 `:154-158` ✓）。
 * @returns `{ path, nodes, edges, renamedBroken }` / `null`（extracted 为空 ✓）
 */
export async function mergeAndSaveMindmap(notesDir, extracted, existingMindmapPath) {
	if (!extracted || (extracted.nodes.length === 0 && extracted.edges.length === 0)) { return null; }
	let existing = null;
	let mindmapPath;
	let renamedBroken = false;
	if (existingMindmapPath) {
		existing = await readMindmap(existingMindmapPath);
		mindmapPath = existingMindmapPath;
		if (existing === null) {
			mindmapPath = join(notesDir, `mindmap-broken-${Date.now()}.canvas`);
			renamedBroken = true;
		}
	} else {
		mindmapPath = join(notesDir, deriveNameFromContent(extracted));
	}
	const base = existing ?? { nodes: [], edges: [] };
	const merged = mergeGraph(base, extracted);
	relayoutMindmap(merged);
	merged.mindmap = true;
	await mkdir(notesDir, { recursive: true });
	await writeMindmap(mindmapPath, merged);
	return { path: mindmapPath, nodes: merged.nodes.length, edges: merged.edges.length, renamedBroken };
}

/** 合并多个 .canvas（真源 `mergeMindmaps` ✓）：基准=第一个 ✓、写回 target、**删掉其余** ✓。 */
export async function mergeMindmapFiles(paths, { targetPath } = {}) {
	if (paths.length < 2) { return null; }
	const graphs = [];
	for (const p of paths) {
		const d = await readMindmap(p);
		if (d && d.nodes.length > 0) { graphs.push(d); }
	}
	if (graphs.length < 2) { return null; }
	let merged = { nodes: [...graphs[0].nodes], edges: [...graphs[0].edges] };
	for (let i = 1; i < graphs.length; i++) { merged = mergeGraph(merged, graphs[i]); }
	relayoutMindmap(merged);
	merged.mindmap = true;
	const target = targetPath ?? paths[0];
	await writeMindmap(target, merged);
	for (const p of paths) {
		if (p !== target) {
			try { await rm(p); } catch { /* 删除失败只警告（真源同 ✓） */ }
		}
	}
	return { path: target, nodes: merged.nodes.length, edges: merged.edges.length };
}
