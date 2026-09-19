/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 图谱制品解码 Worker（2026-09-18）—— 把 `loadMerge` 中**唯一不可切片**的那段搬出主线程。
 *
 * ── 背景（用户日志 `vscode-app-1789719701320.log`）────────────────────────
 * `[WsSwitchDiag]` 看门狗在 `graph: 写入内存 store（graph.db.zst）` / `graph: 重建 BM25（graph.db.zst）`
 * 等阶段反复量到 **343~1018ms 的交互排队**（「期间用户点一下就要等这么久」）。逐段核对后：
 *   · 解析 JSON / 写入内存 store / 重建 BM25 —— **都已按 8ms 时间预算切片让出** ✓
 *   · `解压制品`（`_readJsonText`：读盘 + gzip inflate + `new TextDecoder().decode(40MB)`）
 *     —— **整段跑、单次巨块** ✗
 * ⇒ 唯一确定该搬走的就是这一段。实测 8MB 制品 `解压制品=506ms`（节点 18 万 / 边 52.6 万，
 *   明文 40MB 量级），其中 `TextDecoder` 对整段明文的解码是大头。
 *
 * ── 设计（为什么长这样）────────────────────────────────────────────────
 * 1. **只搬「字节 → 文本」**：`CodebaseGraphStore` 的写入、路径迁移、校验、BM25 都必须留在
 *    主线程（它们要访问单例 store）。Worker 只做机械劳动 ⇒ 边界清晰、语义零变化 ✓
 * 2. **不 transfer 原 buffer**：`IFileService` 返回的 `VSBuffer` 可能只是更大 buffer 的一段视图，
 *    transfer 会把别人的 ArrayBuffer detach 掉 ✗ ⇒ 显式 `slice()` 出独立副本再 transfer ✓
 * 3. **三级降级，产出完全等价**（这是「纯优化」的底气）：
 *    L1 Worker 可用 → 用 Worker；L2 创建失败（CSP/Blob/构造抛错）→ 静默回退主线程；
 *    L3 运行超时（30s）/ 崩溃 / 解码报错 → 回退主线程 + 本会话不再重试。
 * 4. **Worker 代码是字符串模板**（照抄 `codebaseGraphParserPool` 已验证的路径：Blob + CSP 包装），
 *    **不引入任何模块/wasm 依赖** ⇒ 天然规避安装版「缺 @vscode/tree-sitter-wasm」那类打包缺陷 ✓
 * 5. 开关：`localStorage['saros:graphDecodeWorker'] = '0'` 可强制关闭（真机 A/B 对照用）。
 *
 * ⚠⚠ Worker 侧实现与 `graphArtifactDecode.ts` 的 `inflateArtifactBytes` / `decodeArtifactBytes`
 *    是**同一套步骤的两份实现**（Worker 里不能 import 模块）。改任一侧必须同步另一侧。
 */

import { createBlobWorker } from './shared/workerPoolManager.js';
import type { GraphArtifactMode, IArtifactInflateResult } from './graphArtifactDecode.js';

/** 强制关闭开关（真机 A/B 对照）：置 '0' ⇒ 完全不走 Worker。 */
const STORAGE_KEY_DISABLED = 'saros:graphDecodeWorker';

/** 单次解码超时（大图 inflate 可能较慢；超过即放弃等待、回退主线程）。 */
const DECODE_TIMEOUT_MS = 30_000;

/** 迷你日志口（与 `MemoryProxyLogger` 同思路；缺省回退 console）。 */
export interface IDecodeWorkerLogger {
	info?(msg: string): void;
	warn?(msg: string): void;
}

interface IWorkerReply {
	/** inflate 后的**字节**（以 transferable ArrayBuffer 回传，零拷贝）。 */
	bytes?: ArrayBuffer;
	/** Worker 侧 inflate 耗时。 */
	msInflate?: number;
	error?: string;
}

/**
 * Worker 脚本源码（纯 JS，无 import）。
 *
 * 与 `graphArtifactDecode.ts` 的对应关系：
 *   `inflateArtifactBytes` ←→ 下面 inflate 段；`decodeArtifactBytes` ←→ 下面 decode 段。
 */
export function buildGraphArtifactDecodeWorkerCode(): string {
	return `
'use strict';
// 图谱制品解码 Worker（由 graphArtifactDecodeWorker.ts 生成；改动需与 graphArtifactDecode.ts 同步）
self.onmessage = function (e) {
	var d = e.data || {};
	if (d.type !== 'decode') { return; }
	var bytes = d.bytes;
	var mode = d.mode;
	void (async function () {
		var t0 = performance.now();
		var msInflate = 0;
		try {
			var raw = bytes;
			if (mode === 'gzip-legacy') { raw = bytes.slice(12); }
			if (mode !== 'plain') {
				if (typeof DecompressionStream === 'undefined') {
					throw new Error('DecompressionStream unavailable in worker');
				}
				var ds = new DecompressionStream('gzip');
				var writer = ds.writable.getWriter();
				writer.write(raw);
				writer.close();
				var reader = ds.readable.getReader();
				var chunks = [];
				var total = 0;
				for (;;) {
					var r = await reader.read();
					if (r.done) { break; }
					chunks.push(r.value);
					total += r.value.length;
				}
				var out = new Uint8Array(total);
				var off = 0;
				for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
				raw = out;
			}
			msInflate = performance.now() - t0;
			// ★ Phase 1b（2026-09-18）：**只回传 inflated bytes**，不再回传字符串 ——
			//   字符串经 structured clone 回主线程时，**反序列化发生在主线程且是单块**
			//   （真机实测：Worker 内只花 232ms、整段却 720ms ⇒ 残余 ≈406ms 全在这里）✗
			//   改回传 transferable ArrayBuffer ⇒ **零拷贝**；文本解码由主线程**分块**做（8ms 预算）✓
			var out = raw;
			if (!(out instanceof Uint8Array)) { out = new Uint8Array(out); }
			var buf = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength)
				? out.buffer
				: out.slice().buffer;	// 视图不是整块时先规整（否则 transfer 会带走多余字节）
			self.postMessage({
				type: 'decode-result', id: d.id, ok: true,
				bytes: buf, msInflate: Math.round(msInflate),
			}, [buf]);
		} catch (err) {
			self.postMessage({
				type: 'decode-result', id: d.id, ok: false,
				error: (err && err.message) ? err.message : String(err),
			});
		}
	})();
};
`;
}

/**
 * 制品解码 Worker 的持有者（每 renderer 一个实例即可 —— 图谱加载是单飞的）。
 *
 * 生命周期：懒创建；`decode()` 返回 `null` = **请调用方走主线程回退**（L2/L3 的统一出口）。
 */
export class GraphArtifactDecodeWorker {

	private _worker: Worker | null = null;
	/** L2/L3 之后置位：本会话不再尝试 Worker（避免每次加载都白等一次创建/超时）。 */
	private _broken = false;
	/** 回退日志只打一次（`_broken` 之后每次加载都会走回退，刷屏无意义）。 */
	private _fallbackLogged = false;
	/** 本次会话是否**成功用过** Worker（诊断：区分「一直没用上」与「用了但没提速」）。 */
	private _usedWorkerOnce = false;
	private _nextId = 1;
	private readonly _pending = new Map<number, (reply: IWorkerReply) => void>();

	constructor(private readonly _log: IDecodeWorkerLogger) { }

	/** 本会话是否成功用过 Worker（供调用方把路径写进阶段耗时日志）。 */
	get usedWorkerOnce(): boolean { return this._usedWorkerOnce; }

	/** 是否允许使用 Worker（默认允许；`localStorage['saros:graphDecodeWorker']='0'` 关闭）。 */
	private get _enabled(): boolean {
		try {
			return localStorage.getItem(STORAGE_KEY_DISABLED) !== '0';
		} catch {
			return true;
		}
	}

	/**
	 * 用 Worker **只做 inflate**（Phase 1b：回传 transferable bytes，文本解码由主线程分块做）。
	 *
	 * **失败一律返回 `null`**（调用方回退主线程，产出等价 —— 这是"纯优化"的底气）。
	 */
	async inflate(bytes: Uint8Array, mode: GraphArtifactMode): Promise<IArtifactInflateResult | null> {
		if (this._broken || !this._enabled) { return null; }
		if (!this._worker) {
			const worker = createBlobWorker(buildGraphArtifactDecodeWorkerCode());
			if (!worker) {
				this._break(`createBlobWorker returned null (CSP / Blob / Worker unavailable)`);
				return null;
			}
			worker.addEventListener('message', (e: MessageEvent) => this._onMessage(e));
			worker.addEventListener('error', (e: ErrorEvent) => {
				this._break(`worker error: ${e.message || 'unknown'} @ ${e.filename || '?'}:${e.lineno || '?'}`);
			});
			this._worker = worker;
		}

		const id = this._nextId++;
		// 复制出独立副本再 transfer：原 bytes 可能是 VSBuffer 的视图，transfer 会 detach 别人的
		// ArrayBuffer ✗（8~25MB 复制约 10~30ms，远小于它换来的主线程让出）。
		const copy = bytes.slice();
		const reply = await new Promise<IWorkerReply>(resolve => {
			this._pending.set(id, resolve);
			setTimeout(() => {
				if (this._pending.delete(id)) {
					resolve({ error: `worker decode timeout ${DECODE_TIMEOUT_MS}ms` });
				}
			}, DECODE_TIMEOUT_MS);
			try {
				this._worker?.postMessage({ type: 'decode', id, bytes: copy, mode }, [copy.buffer]);
			} catch (err) {
				this._pending.delete(id);
				resolve({ error: `postMessage failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		});

		if (reply.error !== undefined) {
			// ⚠ 解码报错（如制品损坏）不应判定 Worker 坏 —— 主线程同样会失败。但此刻已无法区分
			//   「Worker 坏」与「数据坏」，且回退主线程会**再报一次同样的错**（调用方 catch 会记日志），
			//   故这里只在超时/崩溃时标记坏。
			if (/timeout|error:|postMessage failed/.test(reply.error)) { this._break(reply.error); }
			return null;
		}
		this._usedWorkerOnce = true;
		return {
			bytes: new Uint8Array(reply.bytes ?? new ArrayBuffer(0)),
			msInflate: reply.msInflate ?? 0,
		};
	}

	dispose(): void {
		for (const resolve of this._pending.values()) { resolve({ error: 'disposed' }); }
		this._pending.clear();
		try { this._worker?.terminate(); } catch { /* ignore */ }
		this._worker = null;
	}

	// ─── 内部 ────────────────────────────────────────────────────────────

	private _onMessage(e: MessageEvent): void {
		const d = e.data;
		if (!d || d.type !== 'decode-result') { return; }
		const resolve = this._pending.get(d.id);
		if (!resolve) { return; }
		this._pending.delete(d.id);
		if (d.ok === true) {
			resolve({ bytes: d.bytes, msInflate: d.msInflate });
		} else {
			resolve({ error: typeof d.error === 'string' ? d.error : 'worker decode failed' });
		}
	}

	/** 标记 Worker 不可用（本会话不再尝试）并记一次 warn。 */
	private _break(reason: string): void {
		this._broken = true;
		try { this._worker?.terminate(); } catch { /* ignore */ }
		this._worker = null;
		if (!this._fallbackLogged) {
			this._fallbackLogged = true;
			this._log.warn?.(`[GraphPersistence] artifact decode worker unavailable — falling back to main thread for this session: ${reason}`);
		}
	}
}
