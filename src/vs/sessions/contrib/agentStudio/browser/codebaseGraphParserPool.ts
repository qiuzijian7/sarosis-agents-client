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

	/**
	 * ★★★ 2026-09-18（用户报「C++ 项目检索不到内容」）：**读取失败的语言名**（如 `['cpp']`）。
	 *
	 * 旧实现在读 `tree-sitter-<lang>.wasm` 失败时用「catch 空吞 + 一句 skip-unavailable 注释」**静默吞掉**，
	 * 只报一句不带语言名的 `N langs` ⇒ 缺 cpp grammar 时：所有 `.cpp/.h` 解析不出任何符号、
	 * `failed=0`、日志一片绿、图谱为空 ✗✗（用户只能猜）。
	 * 现在：逐语言记名 + 响亮告警，并暴露给上层（`CodebaseGraphService` 的「0 个符号」告警会直接点名）。
	 */
	private _missingLanguages: string[] = [];
	/** 读取**成功**的语言名（诊断用：与 `missingLanguages` 一起给出完整画面）。 */
	private _loadedLanguages: string[] = [];

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

	/** 读取失败的 grammar 语言名（空 = 全部成功）。见 `_missingLanguages`。 */
	get missingLanguages(): readonly string[] {
		return this._missingLanguages;
	}

	/** 读取成功的 grammar 语言名。见 `_missingLanguages`。 */
	get loadedLanguages(): readonly string[] {
		return this._loadedLanguages;
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
			// ★★★ 2026-09-18（用户报「C++ 项目 535 个文件全部 0 节点」）：**不许静默吞掉读取失败**。
			// 旧实现是 `catch { /* skip unavailable */ }` + 一句**不带语言名**的 `N langs` —— 于是缺 cpp
			// grammar 时全部 `.cpp/.h` 解析不出符号、`failed=0`、日志一片绿 ✗✗（用户只能看到「尚无数据」）。
			const langWasms: Record<string, Uint8Array> = {};
			const langFailures: string[] = [];
			this._missingLanguages = [];
			this._loadedLanguages = [];
			const langs = [...new Set(Object.values(EXTENSION_TO_WASM_LANG))];
			for (const lang of langs) {
				try {
					const uri = FileAccess.asFileUri(`${wasmDir}/tree-sitter-${lang}.wasm`);
					langWasms[lang] = new Uint8Array((await this._fileService.readFile(uri)).value.buffer);
				} catch (err: any) {
					langFailures.push(`${lang}(${err?.message || err})`);
				}
			}
			this._loadedLanguages = Object.keys(langWasms);
			this._missingLanguages = langFailures.map(f => f.substring(0, f.indexOf('(')));
			this._logService.info('[CodebaseGraph]', `Worker pool: loaded tree-sitter.js (${tsJsContent.length}B), runtime WASM (${tsWasmBytes.length}B), ${this._loadedLanguages.length}/${langs.length} langs (${this._loadedLanguages.join(', ') || 'none'})`);
			if (langFailures.length > 0) {
				// 响亮告警：逐条点名 + 指向打包校验（这条日志就是「检索不到内容」的直接答案）
				this._logService.warn('[CodebaseGraph]', `Worker pool: ${langFailures.length}/${langs.length} 个语言的 tree-sitter wasm **读取失败** ⇒ 这些语言的**所有**源文件都将解析不出符号（「检索不到内容 / 0 节点」的根因，属构建/打包缺陷）：${langFailures.join(', ')}` +
					'（★ 多为安装包未包含 @vscode/tree-sitter-wasm 的对应语言文件；见 build/saros/strip-before-pack.mjs 的关键构件校验）');
			}

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
			// ★★★ 2026-09-19（P0-4 性能）：并行度**不再硬顶 4**。
			//
			// 旧实现 `Math.min(4, Math.max(1, hc - 1))`：在 8/16 核工作站上把解析阶段**人为限速到 4 路**
			// （CBM 用全核，见其 `system_info.c:300`）⇒ 解析是**每文件独立**的纯计算任务，吞吐近似随核数线性，
			// 这个 4 就是纯粹的浪费 ✗。现改为「用满 (核数 - 1)」，只保留一个**防内存峰值**的上限：
			// 每个 worker 都独持 tree-sitter runtime + 语言 wasm 副本（随语言数增长），32/64 核机器上无上限会打爆内存 ✗。
			// 上限取 16：覆盖常见工作站（8/12/16 核）而不失控；`-1` 留给主线程（解析期间的 UI 与收尾工作）。
			// ⚠ 若要支持用户调参：把 16 换成配置项读取即可（本类当前**只注入 ILogService**，为它改构造签名不值得 ✗）。
			const hc = navigator.hardwareConcurrency || 4;
			const poolSize = Math.max(1, Math.min(16, hc - 1));
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
			// 日志带上 hc 与上限：回答「为什么这批机器是 N 路」——旧日志只报数字，事后无法判断是限速还是核数少 ✗
			this._logService.info('[CodebaseGraph]', `Worker pool ready: ${this._parserWorkers.length}/${poolSize} workers（hc=${hc}，上限=16）`);
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
