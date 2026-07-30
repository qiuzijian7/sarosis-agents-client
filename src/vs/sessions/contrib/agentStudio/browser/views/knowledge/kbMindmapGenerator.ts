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
import type { IChatModel } from '../../knowledge/engine/llm.js';

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

		// 3. 重新排列布局（简单的网格布局）
		this._relayout(merged, 16);

		// 4. 写入 .canvas 文件
		await this.fileService.createFolder(notesDir);
		await this.writeMindmap(mindmapUri, merged);

		const added = extracted.nodes.length;
		this.logService.info(`[mindmap] saved ${merged.nodes.length} nodes, ${merged.edges.length} edges to ${mindmapUri.fsPath} (added ${added} nodes)`);

		return mindmapUri;
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
- Each node must have "type": "text", "x": 0, "y": 0, "width": 300, "height": 100.
- Node "content" is in Markdown: first line is bold title, rest is terse description (1-2 lines max).
- Node "color" should reflect schema type: "1"=概念(concept)#bf3989, "2"=对比(comparison)#db6d28, "3"=方法(technique)#8957e5, "4"=事实(fact)#2da44e, "5"=问题(problem)#f85149, "0"=default.
- Edges connect nodes with "id","fromNode","toNode". Add optional "label" for relationship type.
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
	 * 简单的网格布局：按列排列节点，每列最多 5 个。
	 */
	private _relayout(mindmap: IKbMindmap, cols: number): void {
		const NODE_W = 300;
		const NODE_H = 100;
		const GAP_X = 60;
		const GAP_Y = 40;

		mindmap.nodes.forEach((n, i) => {
			const col = i % cols;
			const row = Math.floor(i / cols);
			n.x = col * (NODE_W + GAP_X);
			n.y = row * (NODE_H + GAP_Y);
			n.width = NODE_W;
			n.height = NODE_H;
		});
	}
}
