/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbWorkerManager.ts — KB Worker 管理器。
 *
 *  职责：
 *   - 创建/管理 Web Worker 生命周期
 *   - 主线程 ↔ Worker 消息通信（request/response + 超时）
 *   - Worker 不可用时自动 fallback 到主线程同步执行
 *   - 可取消（AbortSignal）
 *
 *  用法（从 KnowledgeBaseViewPane / KbNativeKernel）：
 *   ```
 *   const mgr = new KbWorkerManager(logService);
 *   const { mention, graph } = await mgr.buildMentionAndGraph(docs, signal);
 *   // 或自动 fallback: mgr.buildMentionAndGraph(docs) → Worker 分批 或 主线程
 *   ```
 *--------------------------------------------------------------------------------------------*/

import { createBlobWorker } from '../../shared/workerPoolManager.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../../../base/common/network.js';

// ─── 序列化/反序列化类型（Worker 内用 plain obj，主线程用 URI） ───

export interface IKbWorkerDoc {
	uriStr: string;
	name: string;
	text: string;
	mtime: number;
	size: number;
}

export interface IKbWorkerMentionEntry {
	normName: string;
	mentionedIn: string[];
}

export interface IKbWorkerGraphData {
	nodes: { id: string; name: string; uriStr: string }[];
	links: { source: string; target: string; type: 'wikilink' }[];
}

export interface IKbWorkerBm25Data {
	terms: { term: string; postings: { docIdx: number; freq: number }[]; idf: number }[];
	docCount: number;
	avgDocLen: number;
	docLens: number[];
}

type WorkerRequestType = 'buildAssetsStart' | 'buildAssetsChunk' | 'buildAssetsFinish' | 'buildBm25';

interface WorkerResponse {
	type: string;
	id: string;
	index?: IKbWorkerMentionEntry[];
	mention?: IKbWorkerMentionEntry[];
	graph?: IKbWorkerGraphData;
	index_data?: IKbWorkerBm25Data;
	error?: string;
}

/**
 * Web Worker 管理器，用于将知识库的重计算操作移到独立线程。
 *
 * 特性：
 * - 惰性初始化（首次使用时才创建 Worker）
 * - 15 秒超时（超时后 terminate + fallback）
 * - 初始化失败自动降级到主线程
 */
export class KbWorkerManager {

	private _worker: Worker | null = null;
	private _initPromise: Promise<boolean> | undefined;
	private _fallback: boolean = false;
	private _pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
	private _reqId = 0;
	private _opSeq = 0;


	constructor(
		private readonly _logService: ILogService,
		private readonly _fileService?: IFileService,
	) {}

	/** Worker 是否已就绪（不是 fallback 模式）。 */
	get isWorkerReady(): boolean {
		return this._worker !== null && !this._fallback;
	}

	/** 确保 Worker 已初始化。返回 true 表示 Worker 可用，false 表示需 fallback。 */
	async ensureWorker(): Promise<boolean> {
		if (this._fallback) { return false; }
		if (this._worker) { return true; }
		if (this._initPromise) { return this._initPromise; }

		this._initPromise = this._createWorker();
		return this._initPromise;
	}

	private async _createWorker(): Promise<boolean> {
		try {
			const workerCode = await this._loadWorkerCode();
			const worker = createBlobWorker(workerCode);
			if (!worker) {
				this._logService.info('[KB Worker] Blob Worker creation blocked by CSP, fallback to main thread');
				this._fallback = true;
				return false;
			}

			this._worker = worker;

			this._worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
				const resp = e.data as WorkerResponse;
				const pending = this._pending.get(resp.id);
				if (!pending) { return; }
				clearTimeout(pending.timeout);
				this._pending.delete(resp.id);

				if (resp.error) {
					pending.reject(new Error(resp.error));
				} else {
					pending.resolve(resp);
				}
			};

			this._worker.onerror = (err) => {
				this._logService.warn('[KB Worker] error event:', String(err?.message ?? err));
			};

			this._logService.info('[KB Worker] initialized successfully');
			return true;
		} catch (err: any) {
			this._logService.info('[KB Worker] init failed, fallback to main thread:', err?.message || String(err));
			this._fallback = true;
			this._worker = null;
			return false;
		}
	}

	/** 加载 Worker 脚本内容（通过 IFileService 读取编译产物 kbWorker.js）。 */
	private async _loadWorkerCode(): Promise<string> {
		if (this._fileService) {
			try {
				const workerUri = FileAccess.asFileUri('vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbWorker.js');
				const content = (await this._fileService.readFile(workerUri)).value.toString();
				if (content.length > 0) {
					return content;
				}
			} catch (err: any) {
				this._logService.warn('[KB Worker] readFile kbWorker.js failed:', err?.message || String(err));
			}
		}

		// Fallback: try fetch (useful in dev mode or web)
		try {
			const response = await fetch('./kbWorker.js');
			if (response.ok) {
				return await response.text();
			}
		} catch {
			// Fallthrough
		}

		throw new Error('Worker script not available — ensure kbWorker.ts is compiled to kbWorker.js');
	}

	/** 发送消息到 Worker，带超时和取消支持。 */
	private async _sendRequest<T>(type: WorkerRequestType, data: Record<string, any>, token?: CancellationToken, timeoutMs: number = 15000): Promise<T> {
		const ready = await this.ensureWorker();
		if (!ready || !this._worker) {
			throw new Error('Worker not available');
		}

		return new Promise<T>((resolve, reject) => {
			if (token?.isCancellationRequested) {
				reject(new Error('Cancelled'));
				return;
			}

			const id = `kbw-${++this._reqId}`;
			const timeout = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`Worker request timeout (${Math.round(timeoutMs / 1000)}s)`));
			}, timeoutMs);

			this._pending.set(id, { resolve: (d: any) => resolve(d as T), reject, timeout });

			const cancelListener = token?.onCancellationRequested(() => {
				clearTimeout(timeout);
				this._pending.delete(id);
				reject(new Error('Cancelled'));
			});

			this._worker!.postMessage({ type, id, ...data });

			// 清理 cancel listener（如果请求成功完成）
			if (cancelListener) {
				const origResolve = resolve;
				const origReject = reject;
				// eslint-disable-next-line local/code-no-any-casts -- 用类型安全的方式包装
				const wrappedResolve = ((value: T) => { cancelListener.dispose(); origResolve(value); }) as typeof resolve;
				const wrappedReject = ((err: Error) => { cancelListener.dispose(); origReject(err); }) as typeof reject;
				this._pending.set(id, { resolve: (d: any) => wrappedResolve(d as T), reject: wrappedReject, timeout });
				this._pending.delete(id); // remove the old one
				this._pending.set(id, { resolve: (d: any) => wrappedResolve(d as T), reject: wrappedReject, timeout });
			}
		});
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 在 Worker 中分批构建提及索引 + 图谱（替代一次性 postMessage 全量文档文本，
	 * 避免大库下 structured clone OOM）：
	 *   buildAssetsStart  仅传 {uriStr,name}（无文本，体积极小）→ Worker 构建全局 nameList/节点表
	 *   buildAssetsChunk  分多批传文本，Worker 内部累计提及 + 边（每批仅克隆少量文本）
	 *   buildAssetsFinish 汇总返回 { mention, graph }
	 * 失败自动 fallback 到主线程同步执行。
	 */
	async buildMentionAndGraph(
		docs: { uri: URI; name: string; text: string; mtime: number; size: number }[],
		token?: CancellationToken,
	): Promise<{ mention: IKbWorkerMentionEntry[]; graph: IKbWorkerGraphData }> {
		const workerDocs: IKbWorkerDoc[] = docs.map(d => ({
			uriStr: d.uri.toString(),
			name: d.name,
			text: d.text,
			mtime: d.mtime,
			size: d.size,
		}));

		const CHUNK = 200;
		const opId = `op-${++this._opSeq}`;
		// 提及索引是 O(N×K)（N=文档数，K=文档名数）。对大库（数千文档）这会
		// 在主线程 fallback 时冻结 UI 数十分钟，因此超过阈值时只构建图谱（O(N)），跳过提及。
		const MENTION_LIMIT = 2000;
		const doMention = docs.length <= MENTION_LIMIT;
		// 分批请求放宽超时：单批 200 文档的图谱扫描可能超过默认 15s（尤其在慢盘上）。
		const CHUNK_TIMEOUT = 120_000;

		try {
			// Phase 1: 仅传 {uriStr, name}（无文本，体积极小），Worker 据此构建全局 nameList/节点表
			await this._sendRequest<WorkerResponse>('buildAssetsStart', {
				opId,
				startDocs: workerDocs.map(d => ({ uriStr: d.uriStr, name: d.name })),
				doMention,
			}, token, CHUNK_TIMEOUT);

			// Phase 2: 分批传文本，Worker 内部累计提及 + 边（每批仅克隆少量文本，消除 OOM）
			for (let i = 0; i < workerDocs.length; i += CHUNK) {
				const slice = workerDocs.slice(i, i + CHUNK).map(d => ({
					uriStr: d.uriStr,
					name: d.name,
					text: d.text,
				}));
				await this._sendRequest<WorkerResponse>('buildAssetsChunk', { opId, docs: slice }, token, CHUNK_TIMEOUT);
			}

			// Phase 3: 汇总返回
			const resp = await this._sendRequest<WorkerResponse>('buildAssetsFinish', { opId }, token, CHUNK_TIMEOUT);
			return {
				mention: doMention ? (resp.mention ?? []) : [],
				graph: resp.graph ?? { nodes: [], links: [] },
			};
		} catch (err: any) {
			this._logService.warn('[KB Worker] buildMentionAndGraph failed, fallback to main thread:', err?.message || String(err));
			return {
				mention: doMention ? this._buildMentionIndexSync(docs) : [],
				graph: this._buildGraphSync(docs),
			};
		}
	}

	/**
	 * @deprecated 使用 buildMentionAndGraph(docs).mention。
	 * 便捷解构保留：kbWorkerManager.test.ts 的主线程 fallback 算法用例（提及索引
	 * O(N×K) 正确性）仍通过此入口验证。内部委托 buildMentionAndGraph 的**分批**
	 * 逻辑，不重新引入旧版一次性全量克隆的 OOM 风险（与 kbWorker.ts 里旧函数
	 * 直接 throw「已弃用」不同——那里才是真正的 OOM 源头）。
	 */
	async buildMentionIndex(
		docs: { uri: URI; name: string; text: string; mtime: number; size: number }[],
		token?: CancellationToken,
	): Promise<IKbWorkerMentionEntry[]> {
		return (await this.buildMentionAndGraph(docs, token)).mention;
	}

	/**
	 * @deprecated 使用 buildMentionAndGraph(docs).graph。
	 * 便捷解构保留（理由同 buildMentionIndex）。
	 */
	async buildGraph(
		docs: { uri: URI; name: string; text: string; mtime: number; size: number }[],
		token?: CancellationToken,
	): Promise<IKbWorkerGraphData> {
		return (await this.buildMentionAndGraph(docs, token)).graph;
	}

	/** 销毁 Worker 并清理所有 pending 请求。 */
	dispose(): void {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Worker disposed'));
		}
		this._pending.clear();
		if (this._worker) {
			this._worker.terminate();
			this._worker = null;
		}
		this._initPromise = undefined;
	}

	// ─── 主线程 fallback 实现（与 KbNativeKernel 算法完全一致） ───

	/** 对齐 KbNativeKernel._normalizeName：仅小写+trim。 */
	private _normalizeName(name: string): string {
		return name.toLowerCase().trim();
	}

	/** 对齐 KbNativeKernel._stripForMention：移除 [[...]]、代码块、行内代码。 */
	private _stripForMention(text: string): string {
		return text
			.replace(/\[\[[^\]]+\]\]/g, '')      // 移除整个 wikilink
			.replace(/```[\s\S]*?```/g, '')       // 移除 fenced code blocks
			.replace(/`[^`]+`/g, '');              // 移除 inline code
	}

	private _buildMentionIndexSync(
		docs: { uri: URI; name: string; text: string; mtime: number; size: number }[],
	): IKbWorkerMentionEntry[] {
		const mentionMap = new Map<string, Set<string>>();
		const nameList: { norm: string; raw: string; uriStr: string }[] = [];

		for (const doc of docs) {
			const baseName = doc.name.replace(/\.(md|markdown)$/i, '');
			if (baseName.length < 2) { continue; }
			const normName = this._normalizeName(baseName);
			nameList.push({ norm: normName, raw: baseName, uriStr: doc.uri.toString() });
		}

		for (const doc of docs) {
			const stripped = this._stripForMention(doc.text);
			if (stripped.length < 2) { continue; }
			for (const { norm, raw, uriStr } of nameList) {
				if (stripped.includes(raw) || stripped.includes(norm)) {
					let set = mentionMap.get(norm);
					if (!set) { set = new Set(); mentionMap.set(norm, set); }
					set.add(uriStr);
				}
			}
		}

		const entries: IKbWorkerMentionEntry[] = [];
		for (const [normName, uriSet] of mentionMap) {
			entries.push({ normName, mentionedIn: [...uriSet] });
		}
		return entries;
	}

	private _buildGraphSync(
		docs: { uri: URI; name: string; text: string; mtime: number; size: number }[],
	): IKbWorkerGraphData {
		const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
		const nodes: IKbWorkerGraphData['nodes'] = [];
		const links: IKbWorkerGraphData['links'] = [];
		const seenNames = new Map<string, string>();

		for (const doc of docs) {
			const name = doc.name.replace(/\.(md|markdown)$/i, '');
			if (!name) { continue; }
			const lower = name.toLowerCase();
			if (!seenNames.has(lower)) {
				seenNames.set(lower, doc.uri.toString());
				nodes.push({ id: doc.uri.toString(), name, uriStr: doc.uri.toString() });
			}
		}

		for (const doc of docs) {
			let match: RegExpExecArray | null;
			WIKILINK_RE.lastIndex = 0;
			while ((match = WIKILINK_RE.exec(doc.text)) !== null) {
				const targetName = match[1].trim();
				if (!targetName) { continue; }
				const targetUri = seenNames.get(targetName.toLowerCase());
				if (targetUri && targetUri !== doc.uri.toString()) {
					links.push({ source: doc.uri.toString(), target: targetUri, type: 'wikilink' });
				}
			}
		}

		return { nodes, links };
	}
}
