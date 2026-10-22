/**
 * 页面「关系图谱」的图数据（dsh 侧）。
 *
 * 为什么**不直接复用** `core/kbInsights.js` 的 `buildInsightGraph()`：
 *   · 那个函数用 **标题**（`insightNodeName`）当节点 id —— 标题会重名、含空格，
 *     而且**反查不到文件** ⇒ 页面双击节点没法 `openFile` 打开笔记 ✗；
 *   · 它的匹配口径是"只在已加入 nodes 集合里的才建边"（依赖遍历顺序，先出现才认），
 *     对页面来说会漏掉"被后出现的笔记引用"的边。
 * ⇒ 本模块用 **vault 相对路径（rel）当节点 id**（唯一、可直接拼绝对路径），
 *   并先建全量索引再解析，顺序无关。
 *
 * ⚠ 与 `buildInsightGraph` 的关系：两者都读 `[[双链]]`，但**用途不同**
 *   （insights.md 的社区统计 vs 页面可视化）⇒ 不是双真源：**边的事实源都是笔记正文**，
 *   只是"节点标识"不同。若将来要统一，应该让 `insightNodeName` 也带 rel。
 *
 * 纯函数（无 IO）⇒ 可单测；IO 由调用方（`organize.js` 的 `readNotesForGraph`）负责。
 */
import { insightNodeName } from './kbInsights.js';

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** 去掉开头 YAML frontmatter（避免把 metadata 里的 `[[...]]` 误算成边）。 */
function stripFrontmatter(text) {
	const s = String(text ?? '');
	if (!s.startsWith('---')) { return s; }
	const end = s.indexOf('\n---', 3);
	if (end < 0) { return s; }
	const after = s.indexOf('\n', end + 4);
	return after < 0 ? '' : s.slice(after + 1);
}

/**
 * 把 `[[目标|别名#锚点]]` 里的目标归一成"可比较的键"：
 * 去锚点 → 去别名 → 反斜杠转正 → 取路径最后一段 → 去 `.md` → 小写。
 *
 * ⚠ 与 `kbGraph.ts`（IDE 侧）的 `normalizeTarget` 口径保持一致：路径形 / file:// 形链接
 * 都按"文件名"归一（那些历史链接是 LLM 生成的，见 IDE 侧 `kbGraph.ts:315-327` 的注释）。
 */
export function normalizeLinkTarget(raw) {
	let t = String(raw ?? '');
	t = t.split('#')[0];
	t = t.split('|')[0];
	t = t.trim().replace(/\\/g, '/');
	// file:// URI 形（`file:///e%3A/.../UI%E4%BC%98%E5%8C%96%E7%AF%87.md`）⇒ 解码后取最后一段
	if (/^file:\/\//i.test(t)) {
		try { t = decodeURIComponent(t.replace(/^file:\/\//i, '')); } catch { /* 保留原文 */ }
	}
	const last = t.split('/').pop();
	t = (last ?? t).replace(/\.(md|markdown)$/i, '');
	return t.trim().toLowerCase();
}

/**
 * 由笔记列表构建图数据。
 *
 * @param {{ rel: string, content: string }[]} notes vault 相对路径 + 正文
 * @returns {{
 *   nodes: { id: string, label: string, group: string, degree: number }[],
 *   edges: { source: string, target: string }[],
 *   stats: { notes: number, edges: number, dangling: number, orphans: number, duplicateTitles: number },
 * }}
 */
export function buildGraphData(notes) {
	const list = Array.isArray(notes) ? notes : [];

	// ── ① 全量索引：标题 / 文件名 → rel（**先建完再解析**，与遍历顺序无关 ✓）
	const byKey = new Map();
	const docs = [];
	let duplicateTitles = 0;
	for (const note of list) {
		const rel = String(note?.rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
		if (!rel || rel.endsWith('/')) { continue; }
		const content = String(note?.content ?? '');
		const label = insightNodeName(rel, content);
		const stem = (rel.split('/').pop() ?? '').replace(/\.(md|markdown)$/i, '');
		docs.push({ rel, label, content });

		for (const key of [label, stem]) {
			const k = normalizeLinkTarget(key);
			if (!k) { continue; }
			if (byKey.has(k)) {
				// 同键指向不同文件：保留先出现的，并计数（页面可以据此提示"有重名笔记"）
				if (byKey.get(k) !== rel) { duplicateTitles++; }
				continue;
			}
			byKey.set(k, rel);
		}
	}

	// ── ② 逐篇解析 [[双链]]
	const nodes = [];
	const edges = [];
	const seen = new Set();
	let dangling = 0;
	for (const doc of docs) {
		// group = 相对路径的**前两级目录**（顶层文件归 '(根)'）；页面按它着色/过滤。
		// ⚠ 实测教训：只取**一级**目录时，像 `01_学习/...` 这种"一个总目录装所有笔记"的库
		//   会退化成"74 个节点全同色" ⇒ 分组着色等于没有 ✗。取两级后是 `01_学习/UE5`、
		//   `01_学习/工程实践` 这类真正的主题簇 ✓。
		const parts = doc.rel.split('/');
		const group = parts.length >= 3
			? `${parts[0]}/${parts[1]}`
			: (parts.length === 2 ? parts[0] : '(根)');
		nodes.push({ id: doc.rel, label: doc.label, group, degree: 0 });

		const body = stripFrontmatter(doc.content);
		for (const match of body.matchAll(WIKILINK_RE)) {
			const key = normalizeLinkTarget(match[1]);
			if (!key) { continue; }
			const targetRel = byKey.get(key);
			if (!targetRel) { dangling++; continue; }     // 指向未索引文件（或 html 等）⇒ 不建边，计数
			if (targetRel === doc.rel) { continue; }        // 自引用不入图
			const sig = `${doc.rel}\u0000${targetRel}`;
			if (seen.has(sig)) { continue; }                // 同一对多次引用只留一条
			seen.add(sig);
			edges.push({ source: doc.rel, target: targetRel });
		}
	}

	// ── ③ 度数（**无向**：in + out）—— 页面用它决定节点大小、也用于"孤点"开关
	const degree = new Map();
	for (const edge of edges) {
		degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
		degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
	}
	for (const node of nodes) { node.degree = degree.get(node.id) ?? 0; }

	return {
		nodes,
		edges,
		stats: {
			notes: nodes.length,
			edges: edges.length,
			dangling,
			orphans: nodes.reduce((n, node) => n + (node.degree === 0 ? 1 : 0), 0),
			duplicateTitles,
		},
	};
}
