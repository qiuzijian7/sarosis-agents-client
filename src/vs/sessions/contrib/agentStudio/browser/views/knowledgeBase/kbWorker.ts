/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbWorker.ts — KB 内核 Worker（独立线程，脱离渲染主线程）。
 *
 *  设计目标：
 *   - 将知识库的重计算（BM25 索引、提及索引、图谱构建）移到 Web Worker
 *   - 主线程只负责文件 I/O + UI 渲染，Worker 负责纯 CPU 计算
 *   - 渐进迁移：先从提及索引开始，再逐步迁移 BM25/图谱
 *   - 兼容无 Worker 环境（fallback 到主线程）
 *
 *  消息协议：
 *   主 → Worker:  { type: 'buildMentionIndex', docs: Doc[], id: string }
 *   Worker → 主: { type: 'mentionIndexDone', id: string, index: MentionEntry[] }
 *   主 → Worker:  { type: 'buildGraph', docs: Doc[], id: string }
 *   Worker → 主: { type: 'graphDone', id: string, graph: GraphData }
 *   主 → Worker:  { type: 'buildBm25', chunks: TextChunk[], id: string }
 *   Worker → 主: { type: 'bm25Done', id: string, index: Bm25Data }
 *--------------------------------------------------------------------------------------------*/

// ─── 类型定义（Worker 内自包含，不依赖外部 TS 编译） ───────────────────

interface DocEntry {
	uriStr: string;
	name: string;
	text: string;
	/** mtime 的毫秒时间戳（用于 BM25/FTS） */
	mtime: number;
	size: number;
}

interface MentionEntry {
	normName: string;
	mentionedIn: string[];  // uriStr[]
}

interface WikiLink {
	sourceUri: string;
	targetName: string;
}

interface GraphEdge {
	source: string;
	target: string;
	type: 'wikilink';
}

interface GraphData {
	nodes: { id: string; name: string; uriStr: string }[];
	links: GraphEdge[];
}

interface Bm25TermEntry {
	term: string;
	postings: { docIdx: number; freq: number }[];
	idf: number;
}

interface Bm25Data {
	terms: Bm25TermEntry[];
	docCount: number;
	avgDocLen: number;
	docLens: number[];
}

// ─── Worker 消息处理 ────────────────────────────────────────────────

interface WorkerMessage {
	type: string;
	id: string;
	opId?: string;
	docs?: DocEntry[];
	startDocs?: { uriStr: string; name: string }[];
	chunks?: { docIdx: number; text: string }[];
	doMention?: boolean;
}

	// ─── 分批构建状态（按 opId 隔离，支持并发/交错） ───
	interface MentionBuildState {
		nameList: { norm: string; raw: string; uriStr: string }[];
		map: Map<string, Set<string>>;
	}
	interface GraphBuildState {
		nodeMap: Map<string, { id: string; name: string; uriStr: string }>;
		links: GraphEdge[];
	}
	const _mentionBuilds = new Map<string, MentionBuildState>();
	const _graphBuilds = new Map<string, GraphBuildState>();

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
	const msg = e.data;
	try {
		switch (msg.type) {
		case 'buildAssetsStart': {
			const opId = msg.opId!;
			const startDocs = msg.startDocs || [];
			// 大库（doMention=false）跳过提及匹配：nameList 置空，后续 chunk 只构建图谱（O(N)）。
			const doMention = msg.doMention !== false;
			const nameList: { norm: string; raw: string; uriStr: string }[] = [];
			const nodeMap = new Map<string, { id: string; name: string; uriStr: string }>();
			for (const d of startDocs) {
				const gname = d.name.replace(/\.(md|markdown)$/i, '');
				if (gname) {
					const lower = gname.toLowerCase();
					if (!nodeMap.has(lower)) {
						nodeMap.set(lower, { id: d.uriStr, name: gname, uriStr: d.uriStr });
					}
				}
				if (doMention) {
					const baseName = d.name.replace(/\.(md|markdown)$/i, '');
					if (baseName.length >= 2) {
						nameList.push({ norm: _normalizeName(baseName), raw: baseName, uriStr: d.uriStr });
					}
				}
			}
			_mentionBuilds.set(opId, { nameList, map: new Map() });
			_graphBuilds.set(opId, { nodeMap, links: [] });
			self.postMessage({ type: 'buildAssetsStartDone', id: msg.id });
				break;
			}
			case 'buildAssetsChunk': {
				const opId = msg.opId!;
				const mb = _mentionBuilds.get(opId);
				const gb = _graphBuilds.get(opId);
				const docs = msg.docs || [];
				if (mb) {
					for (const doc of docs) {
						const stripped = _stripForMention(doc.text);
						if (stripped.length < 2) { continue; }
						for (const { norm, raw, uriStr } of mb.nameList) {
							if (stripped.includes(raw) || stripped.includes(norm)) {
								let set = mb.map.get(norm);
								if (!set) { set = new Set(); mb.map.set(norm, set); }
								set.add(uriStr);
							}
						}
					}
				}
				if (gb) {
					for (const doc of docs) {
						let match: RegExpExecArray | null;
						WIKILINK_RE.lastIndex = 0;
						while ((match = WIKILINK_RE.exec(doc.text)) !== null) {
							const targetName = match[1].trim();
							if (!targetName) { continue; }
							const target = gb.nodeMap.get(targetName.toLowerCase());
							if (target && target.uriStr !== doc.uriStr) {
								gb.links.push({ source: doc.uriStr, target: target.uriStr, type: 'wikilink' });
							}
						}
					}
				}
				self.postMessage({ type: 'buildAssetsChunkDone', id: msg.id });
				break;
			}
			case 'buildAssetsFinish': {
				const opId = msg.opId!;
				const mb = _mentionBuilds.get(opId);
				const gb = _graphBuilds.get(opId);
				const mention: MentionEntry[] = [];
				if (mb) {
					for (const [normName, uriSet] of mb.map) {
						mention.push({ normName, mentionedIn: [...uriSet] });
					}
				}
				const graph: GraphData = { nodes: [], links: [] };
				if (gb) {
					graph.nodes = [...gb.nodeMap.values()];
					graph.links = gb.links;
				}
				_mentionBuilds.delete(opId);
				_graphBuilds.delete(opId);
				self.postMessage({ type: 'buildAssetsFinishDone', id: msg.id, mention, graph });
				break;
			}
			case 'buildBm25': {
				const result = buildBm25Index(msg.chunks!);
				self.postMessage({ type: 'bm25Done', id: msg.id, index: result });
				break;
			}
			default:
				self.postMessage({ type: 'error', id: msg.id || '', error: `Unknown message type: ${msg.type}` });
		}
	} catch (err: any) {
		self.postMessage({ type: 'error', id: msg.id || '', error: err?.message || String(err) });
	}
};

// ─── 提及索引构建（O(N×K)，原 KbNativeKernel._buildMentionIndexCore） ───

/** 对齐 KbNativeKernel._normalizeName：仅小写+trim。 */
function _normalizeName(name: string): string {
	return name.toLowerCase().trim();
}

/** 对齐 KbNativeKernel._stripForMention：移除 [[...]]、代码块、行内代码。 */
function _stripForMention(text: string): string {
	return text
		.replace(/\[\[[^\]]+\]\]/g, '')      // 移除整个 wikilink
		.replace(/```[\s\S]*?```/g, '')       // 移除 fenced code blocks
		.replace(/`[^`]+`/g, '');              // 移除 inline code
}

function buildMentionIndex(docs: DocEntry[]): MentionEntry[] {
	// 已被 self.onmessage 中的分批 buildAssets* 逻辑取代（避免一次性克隆全量文本 OOM）。
	throw new Error('buildMentionIndex 已弃用，请使用 buildAssetsStart/Chunk/Finish');
}

// ─── 图谱构建（提取 wikilinks） ────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;

function buildGraph(docs: DocEntry[]): GraphData {
	// 已被 self.onmessage 中的分批 buildAssets* 逻辑取代（避免一次性克隆全量文本 OOM）。
	throw new Error('buildGraph 已弃用，请使用 buildAssetsStart/Chunk/Finish');
}

// ─── BM25 索引构建 ──────────────────────────────────────────────────

/** CJK 二元切分 + 空白分词 */
function _tokenize(text: string): string[] {
	const tokens: string[] = [];
	// 简单分词：按空白切分，CJK 字符二元切分
	const parts = text.split(/[\s]+/);
	for (const part of parts) {
		if (!part) { continue; }
		if (/[\u4e00-\u9fff]/.test(part)) {
			// CJK: bigram
			for (let i = 0; i < part.length - 1; i++) {
				tokens.push(part.substring(i, i + 2));
			}
		} else {
			tokens.push(part.toLowerCase());
		}
	}
	return tokens;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildBm25Index(chunks: { docIdx: number; text: string }[]): Bm25Data {
	// Collect per-doc term frequencies
	const docTermFreqs = new Map<number, Map<string, number>>();
	const docs = new Set<number>();

	for (const ch of chunks) {
		docs.add(ch.docIdx);
		const tokens = _tokenize(ch.text);
		let tf = docTermFreqs.get(ch.docIdx);
		if (!tf) { tf = new Map(); docTermFreqs.set(ch.docIdx, tf); }
		for (const t of tokens) {
			const cnt = tf.get(t) || 0;
			if (cnt < 65535) { tf.set(t, cnt + 1); } // overflow guard
		}
	}

	const maxDocIdx = Math.max(...docs, 0);
	const docLens: number[] = new Array(maxDocIdx + 1).fill(0);
	const totalLen = chunks.reduce((sum, ch) => sum + (ch.docIdx <= maxDocIdx ? 1 : 0), 0);
	const docCount = docs.size;

	// Build doc lengths
	for (const [docIdx, tf] of docTermFreqs) {
		let len = 0;
		for (const cnt of tf.values()) { len += cnt; }
		docLens[docIdx] = len;
	}
	const avgDocLen = docCount > 0 ? totalLen / docCount : 1;

	// Build inverted index
	const termPostings = new Map<string, Map<number, number>>();
	for (const [docIdx, tf] of docTermFreqs) {
		for (const [term, freq] of tf) {
			let postings = termPostings.get(term);
			if (!postings) { postings = new Map(); termPostings.set(term, postings); }
			postings.set(docIdx, freq);
		}
	}

	// Convert to serializable format
	const terms: Bm25TermEntry[] = [];
	for (const [term, postings] of termPostings) {
		const df = postings.size;
		const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
		const postingList: { docIdx: number; freq: number }[] = [];
		for (const [docIdx, freq] of postings) {
			postingList.push({ docIdx, freq });
		}
		terms.push({ term, postings: postingList, idf });
	}

	return { terms, docCount, avgDocLen, docLens };
}
