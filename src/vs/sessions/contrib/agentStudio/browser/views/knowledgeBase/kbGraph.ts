/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  KbLinkGraph — Markdown [[双链]] 解析与反链映射（对齐 SiYuan 的反链面板）。
 *
 *  支持语法：[[笔记名]] / [[笔记名|别名]] / [[笔记名#标题]]
 *  目标按文件名（去扩展名）匹配；不存在的目标在反链面板中标记为「未找到」。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { KbSection } from './kbTypes.js';
import { IGraphNode, IGraphLink } from './kbGraphView.js';

const MD_EXTS = new Set(['md', 'markdown']);
/** 图谱节点覆盖的文档类型：markdown 双链 + 导入产生的 HTML 副本（作为孤立节点展示）。 */
const GRAPH_NODE_EXTS = new Set(['md', 'markdown', 'html', 'htm']);
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
/** 系统维护文件（导航/洞察/审计/报告）不进图谱，避免污染关系图。 */
const SYS_FILES = new Set(['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md']);

interface ILinkDocMeta {
	uri: URI;
	name: string;
	section: KbSection;
	mtime: number;
}

export interface IOutgoingLink {
	/** 展示文本（别名优先，否则目标名） */
	label: string;
	/** 归一化目标名（去扩展名、小写） */
	targetName: string;
	/** 若库内存在该笔记，给出 URI 可直接跳转 */
	targetUri?: URI;
}

export interface IBacklink {
	uri: URI;
	name: string;
	/** 命中 [[双链]] 的上下文片段 */
	snippet: string;
}

export interface IKbGraphRoot {
	uri: URI;
	section: KbSection;
}

export class KbLinkGraph {

	private _docs: ILinkDocMeta[] = [];
	private _nameToDoc = new Map<string, ILinkDocMeta>(); // 归一化文件名 -> doc
	private _outgoing = new Map<string, string[]>();      // docId -> 原始链接串列表
	private _byTarget = new Map<string, Set<string>>();    // 归一化目标 -> 源 docId 集合
	private _textCache = new Map<string, string>();        // docId -> 正文

	constructor(private readonly fileService: IFileService) { }

	async build(roots: IKbGraphRoot[]): Promise<void> {
		this._reset();
		for (const root of roots) {
			await this.walk(root.uri, root.section);
		}
	}

	/**
	 * Build from in-memory docs (no disk I/O). Used when an FTS index cache has
	 * already loaded every file's text — the graph can be derived without
	 * re-reading anything.
	 */
	buildFromDocs(docs: { uri: URI; name: string; section: KbSection; mtime: number; text: string }[]): void {
		this._reset();
		for (const d of docs) {
			// 与 walk 一致排除系统维护文件（index/overview/insights/log…），否则它们在
			// 库 + 笔记两个分区各出现一次，以同名标签显示成「重复节点」污染关系图。
			if (SYS_FILES.has(d.name)) { continue; }
			const ext = d.name.split('.').pop()?.toLowerCase();
			if (!ext || !GRAPH_NODE_EXTS.has(ext)) { continue; }
			this._indexDoc({ uri: d.uri, name: d.name, section: d.section, mtime: d.mtime }, d.text);
		}
	}

	/**
	 * Inject pre-built graph data from Worker (no parsing needed, just register links).
	 * Used when the heavy wikilink parsing is done off the main thread.
	 */
	injectFromWorker(
		nodes: { uri: URI; name: string }[],
		links: { sourceUriStr: string; targetUriStr: string }[],
	): void {
		this._reset();

		// Register nodes
		for (const n of nodes) {
			const meta: ILinkDocMeta = { uri: n.uri, name: n.name, section: 'notes', mtime: Date.now() };
			this._docs.push(meta);
			this._nameToDoc.set(this.normalizeTarget(n.name), meta);
		}

		// Register links
		const outgoingMap = new Map<string, string[]>();
		for (const l of links) {
			// Build outgoing list per source
			let targets = outgoingMap.get(l.sourceUriStr);
			if (!targets) { targets = []; outgoingMap.set(l.sourceUriStr, targets); }
			targets.push(l.targetUriStr);

			// Build by-target reverse index
			const targetKey = this.normalizeTarget(l.targetUriStr);
			let set = this._byTarget.get(targetKey);
			if (!set) { set = new Set(); this._byTarget.set(targetKey, set); }
			set.add(l.sourceUriStr);
		}

		// Flush outgoing map
		for (const [source, targets] of outgoingMap) {
			this._outgoing.set(source, targets);
		}
	}

	private _reset(): void {
		this._docs = [];
		this._nameToDoc.clear();
		this._outgoing.clear();
		this._byTarget.clear();
		this._textCache.clear();
	}

	private _indexDoc(meta: ILinkDocMeta, text: string): void {
		this._docs.push(meta);
		this._nameToDoc.set(this.normalizeTarget(meta.name), meta);
		// 同时按 frontmatter `title` 注册：LLM 构建的笔记用 [[Title]] 互引（title 常含空格或
		// 后缀，与文件名规范化后不一致，如 文件名 UE5-GC机制总览.md vs title "UE5 GC 机制总览"），
		// 只按文件名索引会导致双链全部解析失败 → 关系图谱零连线。
		const title = KbLinkGraph._extractTitle(text);
		if (title) { this._nameToDoc.set(this.normalizeTarget(title), meta); }
		this._textCache.set(meta.uri.toString(), text);
		// 仅 markdown 解析 [[双链]]；HTML 等导入副本作为孤立节点展示，无出链。
		const ext = meta.name.split('.').pop()?.toLowerCase();
		if (!ext || !MD_EXTS.has(ext)) { return; }
		const targets: string[] = [];
		let m: RegExpExecArray | null;
		const re = new RegExp(WIKILINK_RE);
		while ((m = re.exec(text))) { targets.push(m[1]); }
		this._outgoing.set(meta.uri.toString(), targets);
		for (const t of targets) {
			const key = this.normalizeTarget(t);
			let set = this._byTarget.get(key);
			if (!set) { set = new Set(); this._byTarget.set(key, set); }
			set.add(meta.uri.toString());
		}
	}

	/** 某文档的向外链接（指向其他笔记）。 */
	outgoingLinks(docId: string): IOutgoingLink[] {
		const raw = this._outgoing.get(docId) ?? [];
		return raw.map(r => {
			const targetName = this.normalizeTarget(r);
			const meta = this._nameToDoc.get(targetName);
			const parts = r.split(/[|#]/);
			const label = (parts[1] ?? parts[0]).trim() || parts[0].trim();
			return { label, targetName, targetUri: meta?.uri };
		});
	}

	/** 指向某文档的反链（其他笔记引用了它）。 */
	backlinks(docId: string): IBacklink[] {
		const doc = this._docs.find(d => d.uri.toString() === docId);
		if (!doc) { return []; }
		const key = this.normalizeTarget(doc.name);
		const sources = this._byTarget.get(key);
		if (!sources) { return []; }
		const baseName = doc.name.replace(/\.(md|markdown|html|htm)$/i, '');
		const out: IBacklink[] = [];
		for (const sid of sources) {
			if (sid === docId) { continue; }
			const meta = this._docs.find(d => d.uri.toString() === sid);
			if (!meta) { continue; }
			const text = this._textCache.get(sid) ?? '';
			out.push({ uri: meta.uri, name: meta.name, snippet: this.snippetFor(text, baseName) });
		}
		// 按修改时间倒序
		out.sort((a, b) => (this._docs.find(d => d.uri.toString() === b.uri.toString())?.mtime ?? 0) - (this._docs.find(d => d.uri.toString() === a.uri.toString())?.mtime ?? 0));
		return out;
	}

	/**
	 * 导出力导向图数据（对齐 KbGraphView 的 IGraphNode / IGraphLink）。
	 * 供「关系图谱」EditorPane 在中间栏绘制。仅在 build() 完成后有效。
	 */
	getGraphData(): { nodes: IGraphNode[]; links: IGraphLink[] } {
		const nodes: IGraphNode[] = this._docs.map(d => {
			const refs = this._outgoing.get(d.uri.toString())?.length ?? 0;
			// bug 修复：defs 是被引用数（inbound 反链数），不是出链数（outbound）。
			// 对齐 IGraphNode 语义「节点大小 = log2(Defs)」与 SiYuan Defs（被引用）。
			const defs = this._byTarget.get(this.normalizeTarget(d.name))?.size ?? 0;
			return {
				id: d.uri.toString(),
				label: d.name.replace(/\.(md|markdown|html|htm)$/i, ''),
				type: 'doc',
				refs,
				defs,
			};
		});
		const nodeIds = new Set(nodes.map(n => n.id));
		const links: IGraphLink[] = [];
		for (const d of this._docs) {
			const targets = this._outgoing.get(d.uri.toString()) ?? [];
			for (const t of targets) {
				const meta = this._nameToDoc.get(this.normalizeTarget(t));
				if (meta && nodeIds.has(meta.uri.toString())) {
					links.push({ source: d.uri.toString(), target: meta.uri.toString(), type: 'wikilink' });
				}
			}
		}
		return { nodes, links };
	}

	private async walk(uri: URI, section: KbSection): Promise<void> {
		let stat;
		try { stat = await this.fileService.resolve(uri); } catch { return; }
		if (!stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this.walk(c.resource, section);
			} else {
				// bug B：系统维护文件不进图谱，避免污染关系图
				if (SYS_FILES.has(c.name)) { continue; }
				const ext = c.resource.path.split('.').pop()?.toLowerCase();
				if (!ext || !GRAPH_NODE_EXTS.has(ext)) { continue; }
				const meta: ILinkDocMeta = { uri: c.resource, name: c.name, section, mtime: c.mtime ?? 0 };
				try {
					const content = await this.fileService.readFile(c.resource);
					this._indexDoc(meta, content.value.toString());
				} catch {
					// 忽略单个文件读取失败
				}
			}
		}
	}

	private normalizeTarget(raw: string): string {
		const name = raw.split(/[|#]/)[0].trim();
		// bug C：连字符/空格归一（[[Note Name]] ↔ note-name.md），对齐 llm_wiki resolveTarget 与 _buildInsights normKey
		return name.replace(/\.(md|markdown)$/i, '').toLowerCase().replace(/\s+/g, '-');
	}

	/** 从 Markdown 文档的 YAML frontmatter 提取 `title` 字段（无则返回 undefined）。 */
	private static _extractTitle(text: string): string | undefined {
		if (!text.startsWith('---')) { return undefined; }
		// frontmatter 块：首个 --- 到下一个独立 --- 行之间
		const end = text.search(/\r?\n---\s*\r?\n/);
		if (end < 0) { return undefined; }
		const fm = text.slice(0, end);
		const m = fm.match(/^title:\s*(.+?)\s*$/m);
		if (!m) { return undefined; }
		// 去掉可选引号
		return m[1].replace(/^["']|["']$/g, '').trim();
	}

	private snippetFor(text: string, name: string): string {
		const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`\\[\\[[^\\]]*${safe}[^\\]]*\\]\\]`, 'i');
		const m = text.match(re);
		if (m) {
			const i = m.index ?? 0;
			const s = Math.max(0, i - 40);
			const e = Math.min(text.length, i + m[0].length + 40);
			return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() + (e < text.length ? '…' : '');
		}
		return text.slice(0, 100).replace(/\s+/g, ' ').trim();
	}
}
