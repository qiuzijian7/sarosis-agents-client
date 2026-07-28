/*---------------------------------------------------------------------------------------------
 *  shared/workerPoolManager.ts — 统一 Worker 工厂（KB + CodebaseGraph 共用）。
 *
 *  解决的问题：
 *  - Electron CSP 要求 `new Worker(url)` 的 url 必须通过 TrustedScriptURL 传入
 *  - 之前 KB 和 CodebaseGraph 各自处理 trusted types（重复、CSP 错误反复出现）
 *  - 本模块在加载时一次性创建 `agentStudioWorker` 策略（CSP directive 已注册），所有模块共用
 *
 *  对齐：src/vs/platform/webWorker/browser/webWorkerServiceImpl.ts 的 createBlobWorker 模式
 *--------------------------------------------------------------------------------------------*/

// ─── 懒初始化 trusted types 策略（兼容 Node.js + Electron 双环境）───────

/** 自有 trusted-types 策略名（workbench.html CSP directive 已加 agentStudioWorker）。 */
const AGENT_STUDIO_WORKER_POLICY = 'agentStudioWorker';

let _workerTtPolicy: any = undefined;
let _workerTtPolicyTried = false;

function _getWorkerTtPolicy(): any {
	if (_workerTtPolicyTried) { return _workerTtPolicy; }
	_workerTtPolicyTried = true;
	try {
		const tt = (typeof window !== 'undefined' && (window as any).trustedTypes)
			|| (typeof globalThis !== 'undefined' && (globalThis as any).trustedTypes);
		if (!tt) { return undefined; }

		// 用自己的策略名（workbench CSP 已添加 agentStudioWorker）。
		// 不再与 VS Code bootstrap 的 defaultWorkerFactory 抢占，避免 getPolicy
		// 跨上下文不可见 + createPolicy 无 allow-duplicates 的 CSP 冲突。
		try {
			_workerTtPolicy = tt.createPolicy(AGENT_STUDIO_WORKER_POLICY, {
				createScriptURL: (value: string) => value,
			});
		} catch {
			// createPolicy 失败（Node.js 测试无 CSP / DevTools 无 trusted types）
			// → 尝试 getPolicy 兜底（万一某些环境先进来就创建好了）
			try {
				if (typeof tt.getPolicy === 'function') {
					_workerTtPolicy = tt.getPolicy(AGENT_STUDIO_WORKER_POLICY) || undefined;
				}
			} catch { /* ignore */ }
		}
	} catch {
		_workerTtPolicy = undefined;
	}
	return _workerTtPolicy;
}

// ─── 公开 API ──────────────────────────────────────────────────

/**
 * 将原始 Blob URL 通过 trusted types 策略包装为 TrustedScriptURL。
 * 用于已有 Blob URL 的场景（如 CodebaseGraph 需要先构建 Worker 代码再创建 Blob）。
 *
 * @returns 包装后的 URL（字符串），若 CSP 下失败则返回原始 URL（调用方继续 try/catch）
 */
export function wrapWorkerUrl(rawBlobUrl: string): string {
	try {
		const policy = _getWorkerTtPolicy();
		return policy ? (policy.createScriptURL(rawBlobUrl) as unknown as string) : rawBlobUrl;
	} catch {
		return rawBlobUrl;
	}
}

/**
 * 安全创建 Blob Worker（自动过 Electron CSP TrustedScriptURL 检查）。
 *
 * 用法：
 *   const code = `self.onmessage = (e) => { ... }`;
 *   const worker = createBlobWorker(code);
 *   worker.postMessage({ type: 'init', data });
 */
export function createBlobWorker(code: string, options?: WorkerOptions): Worker | null {
	try {
		const blob = new Blob([code], { type: 'application/javascript' });
		const rawUrl = URL.createObjectURL(blob);

		// 用 defaultWorkerFactory 策略包装 URL（CSP 放行）
		const policy = _getWorkerTtPolicy();
		const trustedUrl = policy
			? (policy.createScriptURL(rawUrl) as unknown as string)
			: rawUrl;

		const worker = new Worker(trustedUrl, options);
		URL.revokeObjectURL(rawUrl);
		return worker;
	} catch {
		return null;
	}
}

/**
 * 创建 Worker 池（最多 `maxWorkers` 个）。
 *
 * @param code      - Worker 脚本代码
 * @param maxWorkers - 最大 Worker 数（默认 `navigator.hardwareConcurrency - 1`，最少 1）
 * @param onInit    - 每个 Worker 初始化回调（返回 true 表示就绪；超时 15s 后自动 reject）
 * @returns 成功创建的 Worker 列表（空数组表示全部失败）
 */
export function createWorkerPool(
	code: string,
	maxWorkers?: number,
	onInit?: (worker: Worker, index: number) => Promise<boolean>,
): Worker[] {
	const count = maxWorkers ?? Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1));
	const workers: Worker[] = [];
	for (let i = 0; i < count; i++) {
		const w = createBlobWorker(code);
		if (!w) { continue; }
		workers.push(w);
	}
	return workers;
}

/**
 * 异步版：每个 Worker 初始化完成后才返回（适合需要 init-done 握手的场景，如 CodebaseGraph）。
 */
export async function createWorkerPoolAsync(
	code: string,
	maxWorkers?: number,
	onInit?: (worker: Worker, index: number) => Promise<boolean>,
): Promise<Worker[]> {
	const count = maxWorkers ?? Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1));
	const initPromises: Promise<Worker | null>[] = [];
	for (let i = 0; i < count; i++) {
		initPromises.push(
			new Promise<Worker | null>((resolve) => {
				const w = createBlobWorker(code);
				if (!w) { resolve(null); return; }
				if (!onInit) { resolve(w); return; }
				const timeout = setTimeout(() => { w.terminate(); resolve(null); }, 15000);
				onInit(w, i).then((ok) => {
					clearTimeout(timeout);
					resolve(ok ? w : null);
				}).catch(() => {
					clearTimeout(timeout);
					w.terminate();
					resolve(null);
				});
			})
		);
	}
	const results = await Promise.all(initPromises);
	return results.filter((w): w is Worker => w !== null);
}
