/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * tree-sitter 解析 Worker 池（2026-09-09 从 `codebaseGraphService.ts` 拆出，P1-5 第三步）。
 *
 * 职责：Worker 池的**创建 / 自愈 / 解析调度**（不含 Worker 代码的生成——由调用方注入
 * `buildWorkerCode`，见文件末尾 TODO）。
 *
 * ★ 关键设计（改动前务必读）：
 * - tree-sitter.js 与各语言 wasm **经 fileService 读取**（`FileAccess.asFileUri` → `file://`），
 *   而非 `importAMDNodeModule`（`vscode-file://` 网络 GET）——**打包版后者不可加载**
 *   （ERR_FILE_NOT_FOUND，2026-08-29 事故）。Worker 代码由 Blob URL 创建并经
 *   `wrapWorkerUrl` 包装为 CSP TrustedScriptURL。
 * - **不得**改为「独立 worker 文件 + 模块加载」：打包版会退化到不可用的加载路径。
 * - WASM buffer 每次 init 前 `slice()` 出独立副本 transfer，原件可反复用于崩溃重建。
 * - Worker 崩溃（独立堆，WASM OOM 等）→ 摘除 + 异步重建替补；在途 parse 由 15s 超时兜底。
 */

import { FileAccess } from '../../../../base/common/network.js';
import { getModuleLocation } from '../../../../workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { wrapWorkerUrl } from './shared/workerPoolManager.js';
import { EXTENSION_TO_WASM_LANG, FileCoverageStatus } from '../common/codebaseIndexDefaults.js';

/**
 * 解析结果。nodes/edges 用 `any[]`——service 侧的 `GraphNode` 与 store 的 `GraphNode`
 * 是**两个不同声明**（同名不同源），此处不做类型耦合，避免循环依赖与类型不兼容。
 */
export interface IWorkerParseResult {
	nodes: any[];
	edges: any[];
	status: FileCoverageStatus;
	reason?: string;
}

export class CodebaseGraphParserPool {

	private _parserWorkers: Worker[] = [];
	private _workerInitPromise: Promise<boolean> | undefined;
	private _workerUrl: string | undefined;
	private _workerTsWasm: Uint8Array | undefined;
	private _workerLangWasms: Record<string, Uint8Array> | undefined;

	constructor(
		private readonly _buildWorkerCode: (tsJsContent: string) => string,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) { }

	/** 已就绪的 Worker 列表（空 = 不可用，调用方应 fallback 主线程）。 */
	get workers(): readonly Worker[] {
		return this._parserWorkers;
	}

	/** 初始化池（幂等：并发调用共享同一个 init promise）。失败返回 false。 */
	async ensure(): Promise<boolean> {
		if (this._workerInitPromise) { return this._workerInitPromise; }
		this._workerInitPromise = this._initPool();
		return this._workerInitPromise;
	}

	/**
	 * 取一个 Worker 做轮询分发。池为空返回 undefined（调用方 fallback）。
	 * @param id 请求 id（同时用作 worker 下标与消息 id）
	 */
	pick(id: number): Worker | undefined {
		if (this._parserWorkers.length === 0) { return undefined; }
		return this._parserWorkers[id % this._parserWorkers.length];
	}

	/** 提交一次解析（15s 超时兜底）。 */
	parse(worker: Worker, id: number, source: string, langName: string, filePath: string): Promise<IWorkerParseResult> {
		return new Promise((resolve) => {
			let resolved = false;
			const handler = (e: MessageEvent) => {
				if (e.data.type === 'parse-result' && e.data.id === id) {
					if (resolved) { return; }
					resolved = true;
					clearTimeout(timeout);
					worker.removeEventListener('message', handler);
					const nodes: any[] = e.data.nodes || [];
					const edges: any[] = e.data.edges || [];
					const err: string | undefined = e.data.error;
					// 解析出错但有部分节点 → partial；全空 → parse_error；正常 → indexed
					const status: FileCoverageStatus = err
						? (nodes.length > 0 ? 'partial' : 'parse_error')
						: 'indexed';
					resolve({ nodes, edges, status, reason: err });
				}
			};
			worker.addEventListener('message', handler);

			// 15 秒超时：某些文件（如生成的代码、超长行）可能导致 tree-sitter 挂起
			const timeout = setTimeout(() => {
				if (resolved) { return; }
				resolved = true;
				worker.removeEventListener('message', handler);
				this._logService.warn('[CodebaseGraph]', `⏱ Worker parse timeout (15s), skipping: ${filePath}`);
				resolve({ nodes: [], edges: [], status: 'timeout', reason: 'worker parse timeout 15s' }); // 跳过该文件，继续处理下一个
			}, 15000);

			worker.postMessage({ type: 'parse', id, source, langName, filePath });
		});
	}

	dispose(): void {
		for (const w of this._parserWorkers) { w.terminate(); }
		this._parserWorkers = [];
		this._workerInitPromise = undefined;
		// 清理自愈参数（dispose 后若再崩溃不应重建）
		this._workerUrl = undefined;
		this._workerTsWasm = undefined;
		this._workerLangWasms = undefined;
	}

	// ─── 内部实现 ─────────────────────────────────────────────────────────

	private async _initPool(): Promise<boolean> {
		try {
			// 1. 读取 tree-sitter.js (AMD 模块)
			const wasmDir = getModuleLocation(this._environmentService);
			const tsJsUri = FileAccess.asFileUri(`${wasmDir}/tree-sitter.js`);
			const tsJsContent = (await this._fileService.readFile(tsJsUri)).value.toString();

			// 2. 读取 tree-sitter.wasm (运行时 WASM)
			const tsWasmUri = FileAccess.asFileUri(`${wasmDir}/tree-sitter.wasm`);
			const tsWasmBytes = new Uint8Array((await this._fileService.readFile(tsWasmUri)).value.buffer);

			// 3. 读取各语言的 WASM 文件
			const langWasms: Record<string, Uint8Array> = {};
			const langs = [...new Set(Object.values(EXTENSION_TO_WASM_LANG))];
			for (const lang of langs) {
				try {
					const uri = FileAccess.asFileUri(`${wasmDir}/tree-sitter-${lang}.wasm`);
					langWasms[lang] = new Uint8Array((await this._fileService.readFile(uri)).value.buffer);
				} catch { /* skip unavailable */ }
			}
			this._logService.info('[CodebaseGraph]', `Worker pool: loaded tree-sitter.js (${tsJsContent.length}B), runtime WASM (${tsWasmBytes.length}B), ${Object.keys(langWasms).length} langs`);

			// 4. 构建 Worker 代码 (AMD shim + tree-sitter.js + 解析逻辑)
			const workerCode = this._buildWorkerCode(tsJsContent);
			const blob = new Blob([workerCode], { type: 'application/javascript' });
			const rawUrl = URL.createObjectURL(blob);
			const workerUrl = wrapWorkerUrl(rawUrl);  // CSP TrustedScriptURL 包装

			// 保存重建参数（Worker 崩溃自愈用）。WASM 原始 buffer 未被 transfer——
			// 每次 init 前都 slice() 出独立副本转移，原件可反复用于重建。
			this._workerUrl = workerUrl;
			this._workerTsWasm = tsWasmBytes;
			this._workerLangWasms = langWasms;

			// 5. 创建 Worker 池
			const poolSize = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
			const initPromises: Promise<Worker | null>[] = [];
			for (let i = 0; i < poolSize; i++) {
				initPromises.push(this._createAndInitWorker(workerUrl, tsWasmBytes, langWasms));
			}
			const workers = await Promise.all(initPromises);
			this._parserWorkers = workers.filter((w): w is Worker => w !== null);

			if (this._parserWorkers.length === 0) {
				this._logService.warn('[CodebaseGraph]', 'Worker pool: all workers failed to init, fallback to main thread');
				return false;
			}
			for (const w of this._parserWorkers) { this._attachWorkerSelfHealing(w); }
			this._logService.info('[CodebaseGraph]', `Worker pool ready: ${this._parserWorkers.length}/${poolSize} workers`);
			return true;
		} catch (err: any) {
			const _msg = err?.message || String(err);
			// 「资源读不到」几乎一定是**打包问题**（模块没进安装包），不是偶发运行时错误 ——
			// 必须给出可操作提示，否则只剩一句通用 warn，用户无从知道是安装包缺 tree-sitter 资源。
			// 2026-09-15 实测：已发布包 `resources/app/node_modules/@vscode/` 缺 tree-sitter-wasm
			// ⇒ 本 catch 命中 ⇒ 18 万节点索引回退 renderer 主线程解析（UI 冻结）。
			const _missing = /Unable to resolve nonexistent file|ENOENT|Cannot find module/i.test(_msg);
			this._logService.warn('[CodebaseGraph]', `Worker pool init failed: ${_msg}, fallback to main thread`
				+ (_missing ? '（★ 资源缺失——多为安装包未包含 @vscode/tree-sitter-wasm；见 build/saros/strip-before-pack.mjs 的关键构件校验）' : ''));
			return false;
		}
	}

	private _createAndInitWorker(url: string, tsWasmBytes: Uint8Array, langWasms: Record<string, Uint8Array>): Promise<Worker | null> {
		return new Promise((resolve) => {
			let worker: Worker;
			try {
				worker = new Worker(url);
			} catch (err: any) {
				this._logService.warn('[CodebaseGraph]', `Worker creation failed: ${err?.message || err}`);
				resolve(null);
				return;
			}
			const timeout = setTimeout(() => { worker.terminate(); this._logService.warn('[CodebaseGraph]', 'Worker init timeout (15s) — worker script may have failed during evaluation'); resolve(null); }, 15000);
			// init 阶段的脚本级错误（如模块求值抛错）经 error 事件暴露，必须记录否则只能盲猜失败原因
			const errHandler = (e: ErrorEvent) => {
				this._logService.warn('[CodebaseGraph]', `Worker init script error: ${e.message || 'unknown'} @ ${e.filename || '?'}:${e.lineno || '?'}`);
			};
			worker.addEventListener('error', errHandler);
			const initHandler = (e: MessageEvent) => {
				const data = e.data;
				if (data.type === 'init-done') {
					clearTimeout(timeout);
					worker.removeEventListener('message', initHandler);
					worker.removeEventListener('error', errHandler);
					resolve(worker);
				} else if (data.type === 'init-error') {
					clearTimeout(timeout);
					worker.removeEventListener('error', errHandler);
					this._logService.warn('[CodebaseGraph]', `Worker init-error: ${data.error || 'unknown'}`);
					worker.terminate();
					resolve(null);
				} else if (data.type === 'log') {
					this._logService.warn('[CodebaseGraph]', `Worker: ${data.message}`);
				}
			};
			worker.addEventListener('message', initHandler);
			// 复制并 transfer WASM buffers (每个 worker 需要独立副本)
			const tsWasmCopy = tsWasmBytes.slice().buffer;
			const langWasmsCopy: Record<string, ArrayBuffer> = {};
			const transferList: ArrayBuffer[] = [tsWasmCopy];
			for (const [k, v] of Object.entries(langWasms)) {
				const copy = v.slice().buffer;
				langWasmsCopy[k] = copy;
				transferList.push(copy);
			}
			worker.postMessage({ type: 'init', tsWasm: tsWasmCopy, langWasms: langWasmsCopy }, transferList);
		});
	}

	/**
	 * Worker 崩溃自愈：browser Worker 有独立堆，WASM OOM/语法崩溃只会杀死自身。
	 * 监听 error 事件 → 从池中摘除并异步重建替补（对齐 C 版 index_supervisor 语义）。
	 * 在途 parse 由其 15s 超时兜底（该文件跳过，下轮索引重试，类似 C 的毒文件 quarantine）。
	 */
	private _attachWorkerSelfHealing(worker: Worker): void {
		worker.addEventListener('error', (e: ErrorEvent) => {
			this._logService.warn('[CodebaseGraph]', `Worker crashed (${e.message ?? 'unknown'}), respawning replacement…`);
			const idx = this._parserWorkers.indexOf(worker);
			if (idx >= 0) { this._parserWorkers.splice(idx, 1); }
			try { worker.terminate(); } catch { /* ignore */ }
			if (!this._workerUrl || !this._workerTsWasm || !this._workerLangWasms) { return; }
			this._createAndInitWorker(this._workerUrl, this._workerTsWasm, this._workerLangWasms).then(replacement => {
				if (replacement) {
					this._attachWorkerSelfHealing(replacement);
					this._parserWorkers.push(replacement);
					this._logService.info('[CodebaseGraph]', `Worker pool healed: ${this._parserWorkers.length} worker(s)`);
				} else {
					this._logService.warn('[CodebaseGraph]', `Worker respawn failed, pool now ${this._parserWorkers.length} worker(s)`);
				}
			});
		});
	}
}

// TODO(P1-5 收尾)：`_buildWorkerCode`（353 行字符串内嵌 JS）仍留在 codebaseGraphService，
// 以构造参数注入本池。后续应把它连同 AST_TO_NODE_TYPE 一起迁到独立 `codebaseGraphWorkerCode.ts`，
// 并补一次 `new Function(code)` 语法自检（避免字符串内语法错误只能运行时发现）。
