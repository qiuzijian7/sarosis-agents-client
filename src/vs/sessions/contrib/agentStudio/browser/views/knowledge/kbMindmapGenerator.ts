/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — KB Mindmap Auto-Generator
 *
 *  当新内容导入知识库后，自动提取结构化信息，创建或补充 JSON Canvas 格式的思维导图，
 *  落盘在笔记目录（笔记/mindmap.canvas 或 笔记/<主题>.canvas）。
 *
 *  支持：
 *    - 自动创建：无思维导图时新建
 *    - 自动补充：已有思维导图时合并新节点/边
 *    - 手动创建/重命名：用户可在笔记区手动 .canvas 文件，
 *      下次导入时自动识别并补充
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IChatModel } from '../../knowledge/llm.js';

// ─── JSON Canvas 类型 ──────────────────────────────────────────────────
/** JSON Canvas 节点 */
export interface IKbMindmapNode {
	id: string;
	type: 'text' | 'file' | 'link' | 'group';
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	content?: string;       // 节点内 Markdown 文本
	/**
	 * 源码出处（Ctrl+点击节点跳转到 file:line）。
	 * 由 LLM 在提取时填充：当某节点明确对应某个源文件/行时，
	 * 填写其工作区相对（或绝对）路径与可选行号，使思维导图可溯源回源码。
	 */
	source?: { file: string; line?: number; column?: number };
}

/** JSON Canvas 边 */
export interface IKbMindmapEdge {
	id: string;
	fromNode: string;
	fromSide?: 'top' | 'right' | 'bottom' | 'left';
	toNode: string;
	toSide?: 'top' | 'right' | 'bottom' | 'left';
	fromEnd?: 'none' | 'arrow';
	toEnd?: 'none' | 'arrow';
	label?: string;         // 边的标签
	color?: string;
}

/** JSON Canvas 文件内容 */
export interface IKbMindmap {
	nodes: IKbMindmapNode[];
	edges: IKbMindmapEdge[];
	/**
	 * 标记为思维导图。写入 .canvas 后，画布编辑器打开时会据此
	 * （即使坐标被外部改成网格）强制重排为树状放射布局，保证思维导图视图。
	 */
	mindmap?: boolean;
}

// ─── 常量 ─────────────────────────────────────────────────────────────
const MINDTAP_FILE = 'mindmap.canvas';
const MAX_CONTENT_LEN = 20000;   // 单次传给 LLM 的最大内容长度

// ─── 工具函数 ─────────────────────────────────────────────────────────
function _randomId(): string {
	return Math.random().toString(36).slice(2, 10);
}

// ─── 主类 ─────────────────────────────────────────────────────────────
export class KbMindmapGenerator {
	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	/**
	 * 扫描笔记目录中所有 .canvas 思维导图文件。
	 * 返回文件名 → 文件 URI 的映射。
	 */
	async listMindmaps(notesDir: URI): Promise<Map<string, URI>> {
		const map = new Map<string, URI>();
		try {
			const st = await this.fileService.resolve(notesDir);
			if (!st.children) { return map; }
			for (const c of st.children) {
				if (!c.isDirectory && c.name.endsWith('.canvas')) {
					map.set(c.name, c.resource);
				}
			}
		} catch {
			// 笔记目录不存在
		}
		return map;
	}

	/**
	 * 读取思维导图文件内容。
	 */
	async readMindmap(uri: URI): Promise<IKbMindmap | null> {
		try {
			const raw = await this.fileService.readFile(uri);
			const parsed = JSON.parse(raw.value.toString());
			if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
				return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
			}
		} catch {
			this.logService.warn(`[mindmap] failed to parse ${uri.fsPath}, returning null (no overwrite)`);
		}
		return null;
	}

	/**
	 * 写入思维导图到 .canvas 文件。
	 */
	async writeMindmap(uri: URI, mindmap: IKbMindmap): Promise<void> {
		const json = JSON.stringify(mindmap, null, '\t');
		await this.fileService.writeFile(uri, VSBuffer.fromString(json));
	}

	/**
	 * 根据导入的新内容，生成或更新思维导图。
	 *
	 * @param chatModel - LLM 会话模型（用于分析内容并提取结构化信息）
	 * @param notesDir - 笔记分区目录 URI
	 * @param newContents - 新增文件的内容摘要数组 [{fileName, content}]
	 * @param existingMindmapUri - 已存在的思维导图文件 URI（可选，用于更新）
	 */
	async generateOrUpdate(
		chatModel: IChatModel | null,
		notesDir: URI,
		newContents: { fileName: string; content: string }[],
		existingMindmapUri?: URI,
	): Promise<URI | null> {
		if (!chatModel || newContents.length === 0) { return null; }

		// 1. 使用 LLM 从新内容中提取结构化节点和边
		const extracted = await this._extractGraph(chatModel, newContents);
		if (!extracted || (extracted.nodes.length === 0 && extracted.edges.length === 0)) {
			this.logService.info('[mindmap] no structure extracted, skipping');
			return null;
		}

		// 2. 读取已有思维导图（如存在）并合并。
		//    解析失败返回 null → 不覆盖已有文件，改名写入防止数据丢失。
		let existing: IKbMindmap | null = null;
		let mindmapUri: URI;
		if (existingMindmapUri) {
			existing = await this.readMindmap(existingMindmapUri);
			mindmapUri = existingMindmapUri;
			// 已有文件但解析失败：改名写入，保留损坏原件
			if (existing === null) {
				const ts = Date.now();
				const fallbackName = `mindmap-broken-${ts}.canvas`;
				mindmapUri = URI.joinPath(notesDir, fallbackName);
				this.logService.warn(`[mindmap] existing is corrupt, writing to ${fallbackName}`);
			}
		} else {
			// 无已有导图：从提取的内容推导文件名（与内容匹配）
			const derivedName = KbMindmapGenerator._deriveNameFromContent(extracted);
			mindmapUri = URI.joinPath(notesDir, derivedName);
		}
		const base: IKbMindmap = existing ?? { nodes: [], edges: [] };

		const merged = this._mergeGraph(base, extracted);

		// 3. 重新排列为思维导图树状布局（中心主题放射）
		this._relayoutMindmap(merged);
		merged.mindmap = true;  // 标记为思维导图，编辑器打开时保证树状布局

		// 4. 写入 .canvas 文件
		await this.fileService.createFolder(notesDir);
		await this.writeMindmap(mindmapUri, merged);

		const added = extracted.nodes.length;
		this.logService.info(`[mindmap] saved ${merged.nodes.length} nodes, ${merged.edges.length} edges to ${mindmapUri.fsPath} (added ${added} nodes)`);

		return mindmapUri;
	}

	/**
	 * 合并多个 .canvas 思维导图为一个（思维导图树状布局）。
	 *
	 * - 读取全部（跳过无法解析的文件），以第一个为基准逐个按内容去重合并；
	 * - 重新排布为思维导图（中心主题放射）；
	 * - 写入 targetUri（默认取第一个文件 URI），删除其余源文件；
	 * - 返回最终 URI；不足 2 个有效文件时返回 null。
	 */
	async mergeMindmaps(uris: URI[], opts?: { targetUri?: URI }): Promise<URI | null> {
		if (uris.length < 2) { return null; }
		const graphs: IKbMindmap[] = [];
		for (const u of uris) {
			const d = await this.readMindmap(u);
			if (d && d.nodes.length > 0) { graphs.push(d); }
		}
		if (graphs.length < 2) { return null; }

		// 以第一个为基准，逐个合并（按内容去重 + 边去重）
		let merged: IKbMindmap = { nodes: [...graphs[0].nodes], edges: [...graphs[0].edges] };
		for (let i = 1; i < graphs.length; i++) {
			merged = this._mergeGraph(merged, graphs[i]);
		}

		// 重排为思维导图树状布局（中心主题放射）
		this._relayoutMindmap(merged);
		merged.mindmap = true;  // 标记为思维导图

		const targetUri = opts?.targetUri ?? uris[0];
		await this.writeMindmap(targetUri, merged);

		// 删除其余源文件（保留 targetUri 自身）
		for (const u of uris) {
			if (u.toString() !== targetUri.toString()) {
				try {
					await this.fileService.del(u, { recursive: false });
				} catch (e) {
					this.logService.warn(`[mindmap] merge: del ${u.fsPath} failed: ${e}`);
				}
			}
		}
		this.logService.info(`[mindmap] merged ${graphs.length} canvas files into ${targetUri.fsPath} (${merged.nodes.length} nodes, ${merged.edges.length} edges)`);
		return targetUri;
	}

	/**
	 * 补充/完善思维导图：读取现有导图，让 LLM 在保留现有节点（沿用原 id）的前提下，
	 * 改进现有节点描述并补充缺失的相关概念与边，再重新排布为思维导图。
	 * 返回更新后的文件 URI；文件为空或解析失败时返回 null。
	 */
	async refineMindmap(chatModel: IChatModel, uri: URI): Promise<URI | null> {
		const existing = await this.readMindmap(uri);
		if (!existing || existing.nodes.length === 0) {
			this.logService.info('[mindmap] refine skipped: empty/invalid mindmap');
			return null;
		}
		const enriched = await this._refineGraph(chatModel, existing);
		if (!enriched || enriched.nodes.length === 0) { return null; }

		// 合并：以 LLM 返回的完整图为主（完善现有 + 补充新增），按 id 去重
		const merged = this._mergeRefined(existing, enriched);
		this._relayoutMindmap(merged);
		merged.mindmap = true;  // 标记为思维导图
		await this.writeMindmap(uri, merged);
		this.logService.info(`[mindmap] refined ${uri.fsPath} → ${merged.nodes.length} nodes, ${merged.edges.length} edges`);
		return uri;
	}

	/**
	 * 根据思维导图内容推导一个文件名（确定性，无需 LLM）。
	 * 取中心主题（根节点）标题首行作为文件名，兜底 mindmap.canvas。
	 */
	deriveMindmapTitle(mindmap: IKbMindmap): string {
		if (mindmap.nodes.length === 0) { return MINDTAP_FILE; }
		// 推断根节点（与 _relayoutMindmap 一致：入度最小 → 出度最大）
		const out = new Map<string, string[]>();
		const indeg = new Map<string, number>();
		for (const n of mindmap.nodes) { out.set(n.id, []); indeg.set(n.id, 0); }
		for (const e of mindmap.edges) {
			if (out.has(e.fromNode) && out.has(e.toNode)) {
				out.get(e.fromNode)!.push(e.toNode);
				indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
			}
		}
		const rootId = [...mindmap.nodes]
			.map(n => n.id)
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

	/** 用 LLM 为思维导图建议一个简短主题名（2-6 词）。失败返回 null。 */
	async suggestMindmapTitle(chatModel: IChatModel, mindmap: IKbMindmap): Promise<string | null> {
		try {
			const SYSTEM = `Given a mind-map (list of nodes with "content"), output a SHORT topic title (2-6 words, no punctuation, no quotes) that best names the whole map. Output only the title text.`;
			const user = JSON.stringify(mindmap.nodes.map(n => ({ id: n.id, content: n.content })));
			const raw = await chatModel.complete(SYSTEM, user, 0.2);
			const t = raw.trim().replace(/^["']|["']$/g, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50);
			if (t.length >= 2) { return `${t}.canvas`; }
		} catch (err) {
			this.logService.warn(`[mindmap] title LLM failed: ${err}`);
		}
		return null;
	}

	// ─── 私有方法 ──────────────────────────────────────────────────────

	/**
	 * 从提取的图谱内容推导思维导图文件名。
	 * 取首个有意义的节点标题作为文件名（经 sanitize），兜底为 mindmap.canvas。
	 */
	private static _deriveNameFromContent(extracted: IKbMindmap): string {
		if (extracted.nodes.length > 0) {
			// 取第一个节点的 content 第一行作为标题（去掉 Markdown bold）
			const firstContent = extracted.nodes[0].content || '';
			const firstLine = firstContent.split('\n')[0]
				.replace(/^\*\*|\*\*$/g, '')  // 去掉 **bold**
				.replace(/^#+\s*/, '')       // 去掉 # heading
				.trim()
				.slice(0, 50);
			if (firstLine.length >= 2) {
				const sanitized = firstLine
					.replace(/[\\/:*?"<>|]/g, '_')   // 非法字符
					.replace(/\s+/g, '_')
					.slice(0, 50);
				return `${sanitized}.canvas`;
			}
		}
		return MINDTAP_FILE;
	}

	/**
	 * 用 LLM 从文档内容中提取结构化知识图谱。
	 */
	private async _extractGraph(
		chatModel: IChatModel,
		contents: { fileName: string; content: string }[],
	): Promise<IKbMindmap | null> {
		const SYSTEM = `You are a knowledge graph extractor. Given document content, extract key concepts (nodes) and their relationships (edges).

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

		// 拼接新内容（限制长度）
		const contentBlock = contents
			.map(c => `## 文件: ${c.fileName}\n\n${c.content}`)
			.join('\n\n---\n\n')
			.slice(0, MAX_CONTENT_LEN);

		const userPrompt = `从以下新导入的知识库内容中提取结构化图谱：

${contentBlock}

请输出 JSON 格式的节点和关系。只包含有意义的新概念，不要重复已存在的通用概念。`;

		try {
			const raw = await chatModel.complete(SYSTEM, userPrompt, 0.3);
			// 清理可能包含的 markdown 代码块标记
			const cleaned = raw
				.replace(/^```(?:json)?\s*/i, '')
				.replace(/```\s*$/, '')
				.trim();
			const parsed = JSON.parse(cleaned) as IKbMindmap;
			if (Array.isArray(parsed.nodes)) {
				// 确保每个节点有 width/height 等必需字段
				for (const n of parsed.nodes) {
					n.type = n.type || 'text';
					n.width = n.width || 300;
					n.height = n.height || 100;
				}
				return { nodes: parsed.nodes, edges: parsed.edges || [] };
			}
		} catch (err) {
			this.logService.warn(`[mindmap] LLM extraction failed: ${err}`);
		}
		return null;
	}

	/**
	 * 让 LLM 完善/补充现有思维导图，返回「完整」的 enrichment 图：
	 * 保留现有节点 id、改进现有节点描述、并新增相关节点与边。
	 */
	private async _refineGraph(chatModel: IChatModel, existing: IKbMindmap): Promise<IKbMindmap | null> {
		const SYSTEM = `You are a knowledge mind-map refiner. You are given an existing mind-map (JSON with "nodes" and "edges").
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
		try {
			const raw = await chatModel.complete(SYSTEM, user, 0.4);
			const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned) as IKbMindmap;
			if (Array.isArray(parsed.nodes)) {
				for (const n of parsed.nodes) {
					n.type = n.type || 'text';
					n.width = n.width || 280;
					n.height = n.height || 80;
				}
				return { nodes: parsed.nodes, edges: parsed.edges || [] };
			}
		} catch (err) {
			this.logService.warn(`[mindmap] refine LLM failed: ${err}`);
		}
		return null;
	}

	/**
	 * 将 LLM 返回的 enrichment 图与原文合并：
	 * - 同 id 节点 → 采用 LLM 版本（完善现有内容）；
	 * - LLM 新增节点 → 追加（id 唯一化）；
	 * - 边取并集（按端点去重），丢弃端点不存在的边。
	 */
	private _mergeRefined(existing: IKbMindmap, enriched: IKbMindmap): IKbMindmap {
		const used = new Set<string>();
		const result: IKbMindmapNode[] = [];
		const idRemap = new Map<string, string>();

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
		const edges: IKbMindmapEdge[] = [];
		const edgeSeen = new Set<string>();
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

	/**
	 * 将新提取的图谱合并到现有图谱中。
	 * 去重策略：按 content 的前 60 字符 Jaccard 相似度 ≥ 0.7 判为重复。
	 */
	private _mergeGraph(existing: IKbMindmap, extracted: IKbMindmap): IKbMindmap {
		const existingSet = new Set(existing.nodes.map(n => n.id));
		const existingEdges = new Set(existing.edges.map(e => `${e.fromNode}->${e.toNode}`));

		const nodes = [...existing.nodes];
		const edges = [...existing.edges];
		const usedIds = new Set(existingSet);

		function _simpleKey(content: string): string {
			return (content || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
		}

		for (const nn of extracted.nodes) {
			const key = _simpleKey(nn.content || '');
			const dup = nodes.find(en => _simpleKey(en.content || '') === key);
			if (dup) {
				// 重复节点：跳过（或可更新 content）
				continue;
			}
			// 确保 id 不冲突
			let id = nn.id;
			while (usedIds.has(id)) { id = 'n' + _randomId(); }
			usedIds.add(id);
			nodes.push({ ...nn, id });
		}

		for (const ne of extracted.edges) {
			const ek = `${ne.fromNode}->${ne.toNode}`;
			if (existingEdges.has(ek) || edges.some(e => e.fromNode === ne.fromNode && e.toNode === ne.toNode)) {
				continue;
			}
			let eid = ne.id;
			const allEdgeIds = new Set(edges.map(e => e.id));
			while (allEdgeIds.has(eid)) { eid = 'e' + _randomId(); }
			edges.push({ ...ne, id: eid });
		}

		return { nodes, edges };
	}

	/**
	 * 思维导图布局：以"中心主题"为根构建层次树，左右双侧放射展开。
	 *
	 *  - 自动推断根节点（入度最小、出度最大的节点；或首个节点）。
	 *  - BFS 建树，避免环 / 多父导致的重叠（首个父被采纳，其余边作跨边保留）。
	 *  - 后序计算每个子树的垂直跨度，前序分配坐标，使子树垂直居中于其父节点。
	 *  - 为每条边设置 fromSide / toSide 与箭头，渲染端据此绘制层级连线。
	 */
	private _relayoutMindmap(mindmap: IKbMindmap): void {
		const NODE_W = 280;
		const NODE_H = 80;
		const LEVEL_GAP = 72;   // 层间水平间距
		const SIB_GAP = 24;     // 兄弟节点垂直间距
		const MARGIN = 80;      // 整体留白

		const nodes = mindmap.nodes;
		if (nodes.length === 0) { return; }
		for (const n of nodes) {
			n.width = NODE_W;
			n.height = NODE_H;
		}

		const nodeMap = new Map(nodes.map(n => [n.id, n]));

		// 出边邻接表 + 入度（用于推断根）
		const out = new Map<string, string[]>();
		const indeg = new Map<string, number>();
		for (const n of nodes) {
			out.set(n.id, []);
			indeg.set(n.id, 0);
		}
		for (const e of mindmap.edges) {
			if (nodeMap.has(e.fromNode) && nodeMap.has(e.toNode)) {
				out.get(e.fromNode)!.push(e.toNode);
				indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
			}
		}

		// 推断根：入度最小 → 出度最大 → 首个节点
		const rootId = [...nodes]
			.map(n => n.id)
			.sort((a, b) => {
				const di = (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0);
				if (di !== 0) { return di; }
				const dout = (out.get(b)?.length ?? 0) - (out.get(a)?.length ?? 0);
				if (dout !== 0) { return dout; }
				return 0;
			})[0];

		// BFS 建树（避免重复访问 → 处理环 / 多父）
		const visited = new Set<string>([rootId]);
		const treeChildren = new Map<string, string[]>();
		const queue: string[] = [rootId];
		while (queue.length) {
			const cur = queue.shift()!;
			treeChildren.set(cur, []);
			for (const nxt of out.get(cur) ?? []) {
				if (!visited.has(nxt)) {
					visited.add(nxt);
					treeChildren.get(cur)!.push(nxt);
					queue.push(nxt);
				}
			}
		}
		// 孤立 / 成环未达节点：挂到根下，保证全部可见
		for (const n of nodes) {
			if (!visited.has(n.id)) {
				visited.add(n.id);
				treeChildren.get(rootId)!.push(n.id);
			}
		}

		// 后序计算子树垂直跨度
		const layoutMap = new Map<string, { children: string[]; subH: number }>();
		for (const n of nodes) { layoutMap.set(n.id, { children: treeChildren.get(n.id) ?? [], subH: 0 }); }
		const measure = (id: string): number => {
			const ln = layoutMap.get(id)!;
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

		// 前序布局：root 居中于 (0,0)，子节点按数量平分到左右两侧
		const place = (id: string, x: number, centerY: number, dir: 'L' | 'R'): void => {
			const node = nodeMap.get(id)!;
			node.x = dir === 'R' ? x : x - NODE_W;
			node.y = centerY - NODE_H / 2;
			const ln = layoutMap.get(id)!;
			let cursor = centerY - ln.subH / 2;
			for (const c of ln.children) {
				const childH = layoutMap.get(c)!.subH;
				const cCenterY = cursor + childH / 2;
				const childX = dir === 'R'
					? node.x + NODE_W + LEVEL_GAP
					: node.x - LEVEL_GAP - NODE_W;
				place(c, childX, cCenterY, dir);
				cursor += childH + SIB_GAP;
			}
		};

		const rootChildren = layoutMap.get(rootId)!.children;
		// 按子树高度贪心均衡地分配到左右两侧，使两侧垂直跨度相近
		// （根节点仍居中于其直接子节点之间，这是思维导图的标准形态）
		const sorted = [...rootChildren].sort((a, b) => layoutMap.get(b)!.subH - layoutMap.get(a)!.subH);
		const leftIds: string[] = [];
		const rightIds: string[] = [];
		let leftLoad = 0;
		let rightLoad = 0;
		for (const c of sorted) {
			const h = layoutMap.get(c)!.subH;
			if (leftLoad <= rightLoad) {
				leftIds.push(c);
				leftLoad += h + SIB_GAP;
			} else {
				rightIds.push(c);
				rightLoad += h + SIB_GAP;
			}
		}

		const groupHeight = (ids: string[]): number => {
			let s = 0;
			ids.forEach((id, i) => {
				s += layoutMap.get(id)!.subH;
				if (i < ids.length - 1) { s += SIB_GAP; }
			});
			return s;
		};

		const root = nodeMap.get(rootId)!;
		root.x = -NODE_W / 2;
		root.y = -NODE_H / 2;

		let lCursor = -groupHeight(leftIds) / 2;
		for (const id of leftIds) {
			const h = layoutMap.get(id)!.subH;
			place(id, root.x - LEVEL_GAP - NODE_W, lCursor + h / 2, 'L');
			lCursor += h + SIB_GAP;
		}
		let rCursor = -groupHeight(rightIds) / 2;
		for (const id of rightIds) {
			const h = layoutMap.get(id)!.subH;
			place(id, root.x + NODE_W + LEVEL_GAP, rCursor + h / 2, 'R');
			rCursor += h + SIB_GAP;
		}

		// 为每条边设置连接面与箭头（基于两端相对位置）
		for (const e of mindmap.edges) {
			const fn = nodeMap.get(e.fromNode);
			const tn = nodeMap.get(e.toNode);
			if (!fn || !tn) { continue; }
			const fc = fn.x + fn.width / 2;
			const tc = tn.x + tn.width / 2;
			if (tc >= fc) {
				e.fromSide = 'right';
				e.toSide = 'left';
			} else {
				e.fromSide = 'left';
				e.toSide = 'right';
			}
			e.fromEnd = 'none';
			e.toEnd = 'arrow';
		}

		// 注：根节点已居中于其直接子节点之间（思维导图标准形态）；
		// 深层分支自然伸得更远，整体左右不对称属正常，故无需额外平移。

		// 整体平移到正坐标（保留留白）
		let minX = Infinity;
		let minY = Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
		}
		const offX = MARGIN - minX;
		const offY = MARGIN - minY;
		for (const n of nodes) {
			n.x += offX;
			n.y += offY;
		}
	}
}
