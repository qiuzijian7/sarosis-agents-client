// @vssaros/dsh-kb — `insights.md`（知识图谱洞察）的**纯生成逻辑**（真源 `maintainKbInsights` 逐字移植 ✓）。
//
// ## 它是什么
// 真源 `KbImportController.maintainKbInsights`（`kbImportController.ts:2221-2281` ✓）+ `detectCommunities`
//（`knowledge/communityDetection.ts` ✓，本模块 `./kbCommunities.js` 是它的逐字移植 ✓）：
//   · 节点 = 每篇笔记的 `title:` frontmatter（剥引号 ✓），没有就用**文件名去 `.md`**，再没有就 `'unknown'` ✓；
//   · 边 = 正文里的 `[[目标]]`，**仅当目标能解析到已索引节点**（取最后一段路径 ✓）且不是自身 ✓；
//   · 把图丢给 Louvain 分社区 ⇒ 输出 `# 知识图谱洞察` ＋ 一行统计 ＋ 每个社区一行标题 ＋ 成员（最多 20 个 ✓）。
//
// ## ⚠ 两个必须照抄的"怪癖"（改了就与 IDE 侧不同形 ✗，而两边都不报错）
//   ① **建边用的是"此刻已收集的节点集"**（真源同处那句 `nodes.has(target)` ✓）⇒ 一条指向
//      **后面才出现**的笔记的链接会被**丢掉** ✗（不是 bug，是顺序语义：先见到的才算已知节点 ✓）。
//      ★ 实测（`p3-65` 的夹具，2026-10-13）这条比看起来更狠 ✗✗：笔记顺序是 甲、乙、丙、丁、戊、己、庚 ⇒
//        **甲 → 乙 也被丢了**（乙还没被收集 ✓）⇒ 最终图里只剩"**后向**链接"（后面的笔记指向前面出现过的 ✓）：
//        夹具里 7 篇、正文共 10 处 `[[…]]`，最后只有 **4 条边**（乙→甲 ×2、丁→丙、庚→甲 ✓）。
//        ⇒ 照抄这个语义（它决定了社区划分 ✓），但**别在文档里把它说成"完整的图"** ✗。
//   ② `title:` 是用**朴素正则**在整个正文里找的（`/^title:\s*(.+)$/m` ✓，**不是** frontmatter 解析器 ✗）⇒
//      正文里某行以 `title:` 开头也会被当成节点名 ✓。两条都照抄 ✓。
//
// ## dsh 侧**不传 chatModel**（这是真源**本来就支持**的一档，不是阉割 ✗）
// 真源里社区还能带"语义摘要 + 主题"（`summarizeCommunities` ⇒ 要模型 ✓）；不给 chatModel 时就退化成
// **纯成员列表** ✓ —— 对账时 IDE 侧也**不传** ⇒ 两边同形 ✓✓。
//
// ## 唯一允许的一处不同：末行出处
// 真源末行写死 `*由 KbImportController 自动维护…*` ✓；dsh 侧写成
// `*由 dsh 侧 vssaros-kb 自动维护（与 IDE 的 KbImportController 同一套规则…）*` ✓ ——
// 因为**确实**是我们在写，署 IDE 的类名是假的 ✗。对账探针（`p3-64`）把这条钉成
// "**只允许这一行不同，其余逐字节相同**" ✓（既保住同形，又不撒谎 ✓）。

import { detectCommunities } from './kbCommunities.js';

/** 每个社区最多列出的成员数（真源硬编码 20 ✓）。 */
export const COMMUNITY_MEMBER_LIMIT = 20;

/** dsh 侧的出处行（真源那行的"等价但如实"版本 ✓ —— 见文件头最后一段 ✓）。 */
export const INSIGHTS_FOOTER = '*由 dsh 侧 vssaros-kb 自动维护（与 IDE 的 KbImportController 同一套规则，基于 Louvain 社区检测算法生成）。*';

/** 真源那行（对账用：IDE 侧产出里应当**只**差这一行 ✓）。 */
export const UPSTREAM_FOOTER = '*由 KbImportController 自动维护，基于 Louvain 社区检测算法生成。*';

/**
 * 取节点名（真源同式 ✓）：`^title:` 行（剥首尾引号 ✓），否则文件名去 `.md`（**大小写敏感** ✓），否则 `'unknown'` ✓。
 * @param {string} rel 相对笔记区的路径
 * @param {string} content 文件全文
 */
export function insightNodeName(rel, content) {
	const titleMatch = String(content ?? '').match(/^title:\s*(.+)$/m);
	const nodeName = titleMatch?.[1]?.trim?.()?.replace(/^["']|["']$/g, '')
		|| String(rel ?? '').split(/[\\/]/).pop()?.replace(/\.md$/, '')
		|| 'unknown';
	return nodeName;
}

/**
 * 收集图谱（节点集 + 边集）。**顺序敏感**：节点按笔记顺序加入、边在遍历时就地判"是否已见" ✓（见文件头怪癖① ✓）。
 * @param {{ rel: string, content: string }[]} notes
 * @returns {{ nodes: string[], edges: { source: string, target: string }[] }}
 */
export function buildInsightGraph(notes) {
	const nodes = new Set();
	const edges = [];
	for (const note of notes) {
		const nodeName = insightNodeName(note.rel, note.content);
		nodes.add(nodeName);
		const matches = String(note.content ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
		for (const match of matches) {
			const target = match[1].split('/').pop() || match[1];
			// 与 `KbLinkGraph` 口径对齐：仅当 target 能解析到已索引节点（md 标题）才建边，
			// 排除非 md 来源链接（如 `[[库/.../xxx.html]]`）造成的伪星形边 ✓（真源注释原话 ✓）
			if (target && target !== nodeName && nodes.has(target)) {
				edges.push({ source: nodeName, target });
			}
		}
	}
	return { nodes: [...nodes], edges };
}

/**
 * 生成 `insights.md` 的内容（真源 `maintainKbInsights` 的渲染段逐字 ✓，只换末行出处 ✓）。
 * @param {{ rel: string, content: string }[]} notes
 * @returns {{ content: string, nodes: number, edges: number, communities: number, modularity: number, members: Map<string, string[]> }}
 */
export function buildInsightsFile(notes) {
	const { nodes, edges } = buildInsightGraph(notes);
	const communityResult = detectCommunities(nodes, edges);
	const communityEntries = [...communityResult.communities.entries()];

	const out = [
		'# 知识图谱洞察', '',
		`> ${notes.length} 篇笔记，${edges.length} 条链接，${communityEntries.length} 个社区。`, '',
	];
	for (const [cid, comNodes] of communityEntries) {
		out.push(`## 社区 ${cid}（${comNodes.length} 节点）`);
		for (const nd of comNodes.slice(0, COMMUNITY_MEMBER_LIMIT)) {
			out.push(`- [[${nd}]]`);
		}
		if (comNodes.length > COMMUNITY_MEMBER_LIMIT) {
			out.push(`- ... 还有 ${comNodes.length - COMMUNITY_MEMBER_LIMIT} 个节点`);
		}
		out.push('');
	}
	out.push('---', '', INSIGHTS_FOOTER);
	return {
		content: out.join('\n'),
		nodes: nodes.length,
		edges: edges.length,
		communities: communityEntries.length,
		modularity: communityResult.modularity,
		members: communityResult.communities,
	};
}
