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
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

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
		this._docs = [];
		this._nameToDoc.clear();
		this._outgoing.clear();
		this._byTarget.clear();
		this._textCache.clear();
		for (const root of roots) {
			await this.walk(root.uri, root.section);
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
		const baseName = doc.name.replace(/\.(md|markdown)$/i, '');
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
			return {
				id: d.uri.toString(),
				label: d.name.replace(/\.(md|markdown)$/i, ''),
				type: 'doc',
				refs,
				defs: refs,
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
				const ext = c.resource.path.split('.').pop()?.toLowerCase();
				if (!ext || !MD_EXTS.has(ext)) { continue; }
				const meta: ILinkDocMeta = { uri: c.resource, name: c.name, section, mtime: c.mtime ?? 0 };
				this._docs.push(meta);
				this._nameToDoc.set(this.normalizeTarget(c.name), meta);
				try {
					const content = await this.fileService.readFile(c.resource);
					const text = content.value.toString();
					this._textCache.set(c.resource.toString(), text);
					const targets: string[] = [];
					let m: RegExpExecArray | null;
					const re = new RegExp(WIKILINK_RE);
					while ((m = re.exec(text))) { targets.push(m[1]); }
					this._outgoing.set(c.resource.toString(), targets);
					for (const t of targets) {
						const key = this.normalizeTarget(t);
						let set = this._byTarget.get(key);
						if (!set) { set = new Set(); this._byTarget.set(key, set); }
						set.add(c.resource.toString());
					}
				} catch {
					// 忽略单个文件读取失败
				}
			}
		}
	}

	private normalizeTarget(raw: string): string {
		const name = raw.split(/[|#]/)[0].trim();
		return name.replace(/\.(md|markdown)$/i, '').toLowerCase();
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
