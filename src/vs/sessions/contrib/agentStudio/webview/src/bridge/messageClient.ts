/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - postMessage RPC Client
 *
 *  Provides a typed, Promise-based wrapper around VS Code's postMessage API.
 *  Handles request/response matching, timeouts, and batching.
 *--------------------------------------------------------------------------------------------*/

// Mirror of RequestType from the host messageProtocol (kept in sync manually)
export type RequestType =
	| 'workspace.list'
	| 'workspace.get'
	| 'workspace.create'
	| 'workspace.createWithWorktree'
	| 'workspace.assignWorktree'
	| 'workspace.resetWorktree'
	| 'workspace.removeWorktree'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
	| 'chat.append'              // v6: webview commits a synthesized message (e.g. wf_run_* with subAgents) to host
	| 'chat.clear'
	| 'chat.cancel'
	| 'delegation.list'
	| 'delegation.get'
	| 'delegation.create'
	| 'delegation.update'
	| 'delegation.delete'
	| 'delegation.autoPlan'
	| 'taskBoard.list'
	| 'taskBoard.create'
	| 'taskBoard.update'
	| 'taskBoard.delete'
	| 'taskBoard.archive'
	| 'taskBoard.openOverview'
	| 'board.list'
	| 'board.create'
	| 'board.rename'
	| 'board.delete'
	| 'attachment.add'
	| 'attachment.remove'
	| 'attachment.read'
	| 'session.list'
	| 'session.get'
	| 'session.create'
	| 'session.delete'
	| 'providers.list'
	| 'providers.select'
	| 'providers.getSelection'
	| 'providers.getSelectionForAgent'
	| 'providers.openSettings'
	| 'imagegen.generate'
	| 'videogen.generate'
	| 'modelgen.generate'
	| 'textgen.generate'
	| 'audiogen.generate'
	| 'net.fetchAsDataUrl'
	| 'reversePrompt.generate'
	| 'comfy.fetch'
	| 'comfy.launch'
	| 'comfy.restart'
	| 'comfy.getLaunchPaths'
	| 'comfy.setLaunchPaths'
	| 'comfy.checkDeps'
	| 'comfy.downloadModel'
	| 'comfy.getDownloadProgress'
	| 'media.import'
	| 'media.list'
	| 'media.get'
	| 'media.getFilePath'
	| 'media.getAsDataUrl'
	| 'media.getUrl'
	| 'media.remove'
	| 'media.restore'
	| 'media.setFavorite'
	| 'media.setBoard'
	| 'media.stats'
	| 'media.purgeDeleted'
	| 'media.cleanOrphaned'
	| 'media.enforceQuota'
	| 'media.getRootDir'
	| 'media.setRootDir'
	| 'workspaceSession.list'
	| 'workspaceSession.get'
	| 'workspaceSession.create'
	| 'workspaceSession.delete'
	| 'workspaceSession.archive'
	| 'workspaceSession.switch'
	| 'workspaceSession.switchRoot'
	| 'workspaceSession.updateStatus'
	| 'agentSession.list'
	| 'agentSession.create'
	| 'agentSession.rename'
	| 'agentSession.delete'
	| 'agentSession.getActive'
	| 'agentSession.fork'
	| 'orchestration.plan'
	| 'orchestration.approve'
	| 'orchestration.reject'
	| 'orchestration.getPlan'
	| 'orchestration.listPlans'
	| 'orchestration.taskAction'
	| 'triage.specify'
	| 'triage.decompose'
	| 'diagnostics.run'
	| 'diagnostics.list'
	| 'diagnostics.dismiss'
	| 'swarm.create'
	| 'swarm.status'
	| 'swarm.list'
	| 'swarm.blackboard'
	| 'swarm.cancel'
	| 'confightml.event'
	| 'confightml.getHtml'
	| 'confightml.writeHtml'
	| 'confightml.chatSend'
	| 'confightml.notify'
	| 'confightml.previewToFile'
	| 'confightml.htmlGenerate'
	| 'confightml.chatSendStream'
	| 'confightml.chatCancelStream'
	| 'files.open'
	| 'files.openHtmlPreview'
	| 'files.openUntitledText'
	| 'files.applyCode'
	| 'chat.jumpToCheckpoint'
	| 'chat.openCheckpointDiff'
	| 'chat.listCheckpoints'
	| 'chat.revertAllCheckpoints'
	| 'chat.keepAllCheckpoints'
	| 'chat.openAllCheckpointsDiff'
	| 'chat.toolApprove'
	| 'worktree.list'
	| 'agent.worktree.switch'
	| 'memory.listL0'
	| 'memory.listL1'
	| 'memory.deleteL0'
	| 'memory.deleteL1'
	| 'skills.list'
	| 'tools.list'
	| 'chat.activeSessionChanged'
	| 'workflow.save'
	| 'workflow.execute'
	| 'workflow.pause'
	| 'workflow.resume'
	| 'workflow.cancel'
	| 'workflow.breakpoint.set'
	| 'workflow.breakpoint.clear'
	| 'workflow.breakpoint.get'
	| 'workflow.list'
	| 'workflow.reorder'
	| 'workflow.open'
	| 'workflow.submitVariables'
	| 'workflow.canvasOpsResult'
	| 'workflow.snapshotResult'
	| 'workflow.runAgentNode'
	| 'workflow.stageRunResult'
	| 'workflow.stageRunProgress'
	| 'workflow.stageDirectRunResult'
	| 'workflow.stageDirectRunProgress'

	| 'workflow.publishState'
	| 'workflow.publish'
	| 'workflow.versionHistory'
	| 'workflow.deleteWorkflow'
	| 'workflow.upgrade'
	| 'workflow.files.list'
	| 'workflow.files.read'
	| 'workflow.files.write'
	| 'workflow.files.delete'
	| 'workflow.files.dir'
	| 'vox.run'
	| 'vox.getProgress'
	| 'vox.cancel'
	| 'vox.checkDeps'
	| 'agents.list'
	| 'agents.presets'
	| 'agents.create'
	| 'agents.update'
	| 'agents.delete'
	| 'agents.export'
	| 'agents.import'
	| 'agents.selected'
	| 'agents.getLastSelected'
	| 'agents.openSettings'
	| 'orchestration.approveWithoutExecute'
	| 'orchestration.approveTask'
	| 'orchestration.rejectTask'
	| 'orchestration.commentTask'
	| 'orchestration.blockTask'
	| 'orchestration.unblockTask'
	| 'orchestration.updatePlan'
	| 'orchestration.updateTask'
	| 'orchestration.decomposeTask'
	| 'workspace.getActive'
	| 'workspace.setActive'
	| 'workflow.executeScript';

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT = 30_000; // 30s timeout for requests
let requestIdCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

// Acquire VS Code API (available in webview context).
//
// IMPORTANT: the bundle may execute more than once within the same webview
// document (VM31/VM32/VM33 duplicate executions were observed when multiple
// Agent Studio webviews share a pinned renderer/origin). `acquireVsCodeApi()`
// must only be called ONCE per document — a second call throws
// "An instance of the VS Code API has already been acquired". We:
//   1. cache the instance on `window` (cheap re-use path)
//   2. wrap in try/catch as a last-resort guard in case the same bundle is
//      re-evaluated before the window cache is written
declare global {
	interface Window {
		__AS_VSCODE_API__?: ReturnType<typeof acquireVsCodeApi>;
	}
}

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>;

function safeAcquire(): VsCodeApi {
	// Node/SSR/unit-test environments have no window (and no acquireVsCodeApi);
	// return a stub so importing this module never throws at load time.
	if (typeof window === 'undefined') { return makeStub(); }
	if (window.__AS_VSCODE_API__) { return window.__AS_VSCODE_API__; }
	try {
		const api = acquireVsCodeApi();
		window.__AS_VSCODE_API__ = api;
		return api;
	} catch {
		// Second call within the same document — fall back to a minimal stub so
		// the rest of the bundle can still boot (calls become no-ops).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (window.__AS_VSCODE_API__ ?? makeStub()) as VsCodeApi;
	}
}

function makeStub(): VsCodeApi {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const noop = (): any => undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const stub = {
		postMessage: noop,
		getState: () => ({}),
		setState: noop,
	} as unknown as VsCodeApi;
	return stub;
}

const vscode: VsCodeApi = safeAcquire();

/**
 * Send a request to the Host and wait for a response.
 *
 * Pass `timeout = 0` to disable the timeout entirely (useful for long-running
 * streamed operations such as `chat.send`, where the actual user-visible result
 * arrives via `chat.stream.*` events; cancellation should be done explicitly
 * via a paired cancel request like `chat.cancel`).
 */
export function sendRequest<TPayload = unknown, TResponse = unknown>(
	type: RequestType,
	payload: TPayload,
	timeout: number = DEFAULT_TIMEOUT,
): Promise<TResponse> {
	return new Promise<TResponse>((resolve, reject) => {
		const id = `req_${++requestIdCounter}_${Date.now()}`;

		const timer: ReturnType<typeof setTimeout> | undefined = timeout > 0
			? setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`Request ${type} timed out after ${timeout}ms`));
			}, timeout)
			: undefined;

		pendingRequests.set(id, {
			resolve: resolve as (data: unknown) => void,
			reject,
			timer,
		});

		vscode.postMessage({
			id,
			direction: 'toHost',
			type,
			payload,
		});
	});
}

// ─── ComfyUI 直连（方案A）CORS 状态机 ───────────────────────────────────────
// 背景（本机 ComfyUI server.py 0.19.x 实测）：中间件互斥——
//  - 未开 `--enable-cors-header` → create_origin_only_middleware()：
//      `Sec-Fetch-Site: cross-site` → 403（webview 请求必带此头，且 Origin 是
//      forbidden header 无法自定义）→ 直连必挂，必须走主进程代理。
//  - 开启 `--enable-cors-header`（无值=*，见 comfy/cli_args.py）→
//      create_cors_middleware()：回 `Access-Control-Allow-Origin: *` → 直连可通。
//
// 策略：按 origin 维护 CORS 状态机 `unknown | direct | proxied`。
//  - unknown：后台探测一次（GET /system_stats, mode:cors），不阻塞首个请求。
//  - direct：直连全局 fetch（真 Response：blob/arrayBuffer/stream，无 4MB cap）。
//  - proxied：经 sendRequest('comfy.fetch') 主进程代理。
//  - direct 态请求抛 TypeError（服务重启关闭 CORS）→ 自动降级 proxied 并重探。
//  - proxied 态定时（默认 60s）重探 → 用户开启 CORS 后自动升级 direct。

export type ComfyCorsMode = 'unknown' | 'direct' | 'proxied';

const corsModeCache = new Map<string, ComfyCorsMode>();
const probeInFlight = new Set<string>();
const reprobeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const modeListeners = new Map<string, Set<(mode: ComfyCorsMode) => void>>();

/** origin → 当前 CORS 模式（未探测过返回 'unknown'）。 */
export function getComfyCorsMode(origin: string): ComfyCorsMode {
	return corsModeCache.get(origin) ?? 'unknown';
}

/** 订阅某 origin 的 CORS 模式变化，返回取消订阅函数（供 UI 徽标/引导实时刷新）。 */
export function subscribeComfyCors(origin: string, cb: (mode: ComfyCorsMode) => void): () => void {
	let set = modeListeners.get(origin);
	if (!set) { set = new Set(); modeListeners.set(origin, set); }
	set.add(cb);
	return () => set?.delete(cb);
}

function notifyComfyCorsMode(origin: string, mode: ComfyCorsMode): void {
	for (const cb of modeListeners.get(origin) ?? []) { cb(mode); }
}

const LOCALHOST_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i;

/** `url` 是否与 `origin` 同源（解析失败一律 false，不误伤 data:/blob:）。纯函数。 */
export function urlHasOrigin(url: string, origin: string): boolean {
	if (!origin) { return false; }
	try { return new URL(url).origin === origin; } catch { return false; }
}

/**
 * 解析 `data:` URL 为 `{ bytes, contentType }`。纯函数。
 *
 * 支持 `;base64` 与百分号编码两种载荷形式。
 */
export function parseDataUrl(url: string): { bytes: Uint8Array; contentType: string } {
	const comma = url.indexOf(',');
	if (comma < 0) { throw new TypeError('Invalid data: URL'); }
	const meta = url.slice(5, comma); // 去掉前缀 `data:`
	const payload = url.slice(comma + 1);
	const isB64 = /;base64$/i.test(meta);
	const contentType = (isB64 ? meta.replace(/;base64$/i, '') : meta) || 'text/plain';
	if (isB64) {
		const bin = atob(payload);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
		return { bytes: out, contentType };
	}
	return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), contentType };
}

/**
 * 把 `data:` URL 直接变成一个可用的 Response —— **不经过网络**。
 *
 * ★ 这是 `TypeError: Failed to fetch` 的真凶所在：AgentStudio webview 的 CSP
 *   `connect-src` 白名单只有 `http(s)://127.0.0.1|localhost` 与 `ws(s):`，
 *   **不含 `data:`**。而节点快照（ImageStage 的输出）常以 `data:image/png;base64,…`
 *   形式存在，于是 instant transform（Rotate/Mirror/Crop）里的
 *   `fetch(src)` 被 CSP 拦截 → 抛 TypeError → 变换永远失败 →
 *   snapshotStore 无输出 → 卡片 OUTPUT / ACTIONS 区块不渲染。
 *   （`img-src` 里有 `data:`，所以预览 <img> 正常显示 —— 这正是
 *   「图看得见、变换必失败」的原因。）
 *   data: 载荷本来就在内存里，本地解码即可，完全没有走网络的必要。
 */
function dataUrlToResponse(url: string): Response {
	const { bytes, contentType } = parseDataUrl(url);
	const blob = new Blob([bytes as unknown as BlobPart], { type: contentType });
	return {
		ok: true,
		status: 200,
		blob: async () => blob,
		arrayBuffer: async () => bytes.buffer as ArrayBuffer,
		text: async () => new TextDecoder().decode(bytes),
		json: async () => JSON.parse(new TextDecoder().decode(bytes)),
	} as Response;
}

/**
 * 探测某 origin 的 ComfyUI 是否允许 webview 直连（即是否开了 --enable-cors-header）。
 * GET /system_stats + mode:cors：resolve 且 ok → 允许；抛 TypeError（CORS 拦截）
 * 或非 ok → 不允许。纯探测，无副作用，可安全在任何环境调用。
 */
export async function probeDirectCors(origin: string, timeoutMs = 2000): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${origin.replace(/\/+$/, '')}/system_stats`, {
			method: 'GET',
			mode: 'cors',
			cache: 'no-store',
			headers: { Accept: 'application/json' },
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function ensureComfyCorsMode(origin: string): Promise<ComfyCorsMode> {
	const cached = corsModeCache.get(origin);
	if (cached && cached !== 'unknown') { return cached; }
	if (probeInFlight.has(origin)) { return cached ?? 'proxied'; }
	probeInFlight.add(origin);
	const ok = await probeDirectCors(origin);
	probeInFlight.delete(origin);
	const mode: ComfyCorsMode = ok ? 'direct' : 'proxied';
	corsModeCache.set(origin, mode);
	notifyComfyCorsMode(origin, mode);
	return mode;
}

function markComfyProxied(origin: string): void {
	corsModeCache.set(origin, 'proxied');
	notifyComfyCorsMode(origin, 'proxied');
}

function scheduleReprobe(origin: string, intervalMs: number): void {
	if (reprobeTimers.has(origin)) { return; }
	const timer = setTimeout(() => {
		reprobeTimers.delete(origin);
		if (corsModeCache.get(origin) !== 'proxied') { return; }
		void probeDirectCors(origin).then(ok => {
			if (ok) {
				corsModeCache.set(origin, 'direct');
				notifyComfyCorsMode(origin, 'direct');
			} else {
				scheduleReprobe(origin, intervalMs);
			}
		});
	}, intervalMs);
	reprobeTimers.set(origin, timer);
}

/** 强制重新探测某 origin（供 Runner 面板"重新探测"按钮），并返回最新模式。 */
export async function reprobeComfyCors(origin: string): Promise<ComfyCorsMode> {
	probeInFlight.delete(origin);
	const ok = await probeDirectCors(origin);
	const mode: ComfyCorsMode = ok ? 'direct' : 'proxied';
	corsModeCache.set(origin, mode);
	notifyComfyCorsMode(origin, mode);
	return mode;
}

/** base64 → Uint8Array（webview 无 Buffer，用 atob 逐字节还原）。纯函数。 */
function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
	return out;
}

/**
 * 经主进程代理的二进制取数（`comfy.fetch` + `binary:true` → base64）。
 * 供 `proxiedComfyFetch` 返回对象的 `blob()` / `arrayBuffer()` 惰性调用。
 */
async function proxiedComfyBinary(url: string, init?: RequestInit): Promise<{ bytes: Uint8Array; contentType: string }> {
	const r = await sendRequest('comfy.fetch', {
		url,
		method: init?.method as string | undefined,
		headers: init?.headers as Record<string, string> | undefined,
		body: typeof init?.body === 'string' ? init.body : undefined,
		binary: true,
	}, 120_000) as { ok: boolean; status: number; base64?: string; contentType?: string; error?: string };
	if (r.error) { throw new Error(r.error); }
	return {
		bytes: r.base64 ? base64ToBytes(r.base64) : new Uint8Array(0),
		contentType: r.contentType ?? 'application/octet-stream',
	};
}

async function proxiedComfyFetch(url: string, init?: RequestInit): Promise<Response> {
	// ★ Honor AbortSignal（2026-08-26）：sendRequest 本身忽略 signal，这里用
	//   Promise.race 让 signal 触发时立即 reject —— 既避免「生成卡死」，又让
	//   取消按钮（controller.abort）在代理模式下也能立即中止底层请求。
	const fetchPromise = sendRequest('comfy.fetch', {
		url,
		method: init?.method as string | undefined,
		headers: init?.headers as Record<string, string> | undefined,
		body: typeof init?.body === 'string' ? init.body : undefined,
	}, 120_000) as Promise<{ ok: boolean; status: number; json?: unknown; text?: string; error?: string }>;
	const signalPromise = new Promise<never>((_, reject) => {
		if (init?.signal) {
			if (init.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
			init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}
	});
	const r = await Promise.race([fetchPromise, signalPromise]);
	if (r.error) { throw new Error(r.error); }
	return {
		ok: r.ok,
		status: r.status,
		json: async () => r.json,
		text: async () => r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''),
		// ★ blob()/arrayBuffer() 必须存在且返回**真二进制**。
		//   此前的伪 Response 只有 json/text，`instantExecutor` 的
		//   `(await fetchImpl(src)).blob()` 直接抛 TypeError，导致 proxied 模式下
		//   Rotate/Mirror/Crop 的变换 100% 失败 → snapshotStore 永远没有输出 →
		//   卡片的 OUTPUT / ACTIONS 区块（gate 在 ownSnapshots.length>0）永不出现。
		//   文本路径拿不到字节（主进程 text() 会 UTF-8 破坏 PNG），所以这里独立
		//   发一次 `binary:true` 请求换 base64 再还原。
		blob: async () => {
			const bin = await proxiedComfyBinary(url, init);
			return new Blob([bin.bytes as unknown as BlobPart], { type: bin.contentType });
		},
		arrayBuffer: async () => {
			const bin = await proxiedComfyBinary(url, init);
			return bin.bytes.buffer as ArrayBuffer;
		},
	} as Response;
}

/**
 * 方案A fetch 工厂：对 `http(s)://127.0.0.1|localhost` 做 直连优先/代理兜底 路由。
 *
 * @param baseUrl 目标 ComfyUI 地址（决定探测的 origin）。仅 localhost 走本路由，
 *                其余 URL（data:/blob:/https 资源）原生 fetch（智能降级）。
 * @param opts.reprobeIntervalMs proxied 态定时重探间隔（默认 60000ms）。
 */
export function createComfyFetch(baseUrl: string, opts?: { reprobeIntervalMs?: number }): typeof fetch {
	const intervalMs = opts?.reprobeIntervalMs ?? 60_000;
	let origin = '';
	try { origin = new URL(baseUrl).origin; } catch { origin = ''; }
	if (origin) {
		// 后台探测（不阻塞首个请求）：determine direct/proxied 后按需启动重探。
		void ensureComfyCorsMode(origin).then(mode => {
			if (mode === 'proxied') { scheduleReprobe(origin, intervalMs); }
		});
	}
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as URL).toString();
		// ★ data: 一律本地解码，绝不走 fetch —— webview CSP 的 connect-src
		//   不含 data:，`fetch('data:image/png;base64,…')` 会被直接拦截并抛
		//   `TypeError: Failed to fetch`（详见 dataUrlToResponse 注释）。
		if (/^data:/i.test(url)) { return dataUrlToResponse(url); }
		// ★ FormData（/upload/image 的 multipart 上传）无法经 IPC 结构化克隆，
		//   代理层只透传字符串 body → 走代理必然丢包体。这类请求一律直连：
		//   失败时由调用方兜底（instantExecutor 会退回 data: URL），
		//   总好过“代理成功但服务端收到空 multipart”的静默错误。
		if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
			return fetch(url, init);
		}
		// ★ 路由判据 = 「这个 URL 属于我们要访问的 ComfyUI 吗」，
		//   而**不是**「它是不是 localhost」。
		//   旧实现只认 127.0.0.1/localhost，ComfyUI 跑在 LAN IP / 域名 / 远程
		//   runner 时，`/view?filename=…` 直接落到下面的裸 `fetch()` →
		//   webview 的 `Origin: vscode-webview://…` 被 ComfyUI 403 →
		//   `TypeError: Failed to fetch`（且该分支**未 try/catch**，无法降级）。
		//   现在同源于配置的 runner origin 时一律走状态机（direct 优先、
		//   代理兜底），localhost 仍作为保底判据保留。
		const sameAsRunner = !!origin && urlHasOrigin(url, origin);
		if (!sameAsRunner && !LOCALHOST_URL_RE.test(url)) { return fetch(url, init); }
		if (!origin) { return proxiedComfyFetch(url, init); }
		const mode = corsModeCache.get(origin) ?? await ensureComfyCorsMode(origin);
		if (mode === 'direct') {
			try {
				return await fetch(url, init);
			} catch (err) {
				// TypeError（CORS 被关闭/网络抖动）→ 降级代理重试一次，并启动定时重探。
				markComfyProxied(origin);
				scheduleReprobe(origin, intervalMs);
				return proxiedComfyFetch(url, init);
			}
		}
		return proxiedComfyFetch(url, init);
	}) as typeof fetch;
}

/**
 * 兼容封装：旧调用点显式不传参（即默认 ComfyUI 在 127.0.0.1:8188）。
 *
 * 注意：transform pipeline（Rotate/Mirror/Crop 等 instant stage）必须传
 * 真实的 runner.baseUrl —— 若用户配置的是 8189 / remote / LAN IP，硬编码
 * 8188 会让 fetch 走代理到错的端口 → TypeError: Failed to fetch → 变换
 * 永远不进 snapshotStore → 卡片 OUTPUT 区块看不到处理后的图。新调用点请传
 * `getActiveRunnerRegistry().resolve(pref)?.baseUrl`。
 */
export function createProxiedFetch(baseUrl?: string): typeof fetch {
	return createComfyFetch(baseUrl ?? 'http://127.0.0.1:8188');
}

/**
 * Handle incoming messages from the Host.
 * Call this once during initialization.
 */
export function initMessageClient(onEvent: (type: string, data: unknown) => void): void {
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || !message.direction) {
			return;
		}

		if (message.direction === 'toWebview') {
			// Check if this is a response to a pending request
			if (message.id && message.type?.endsWith('.response')) {
				const pending = pendingRequests.get(message.id);
				if (pending) {
					pendingRequests.delete(message.id);
					if (pending.timer) {
						clearTimeout(pending.timer);
					}

					if (message.error) {
						pending.reject(new Error(message.error.message || 'Unknown error'));
					} else {
						pending.resolve(message.data);
					}
					return;
				}
			}

			// Otherwise it's an event (unsolicited push from Host)
			// Log stream-related events for debugging

			onEvent(message.type, message.data);
		}
	});
}

/**
 * Post a fire-and-forget message (no response expected).
 */
export function postMessage(type: string, payload: unknown): void {
	vscode.postMessage({
		direction: 'toHost',
		type,
		payload,
	});
}

/**
 * Save/restore webview state (survives hide/show cycles).
 */
export function getState<T>(): T | undefined {
	return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
	vscode.setState(state);
}

// ════════════════════════════════════════════════════════════════════════
// ESM → IIFE interop workaround (esbuild 0.24 + format:'iife')
// ════════════════════════════════════════════════════════════════════════
// esbuild's auto-generated factory only copies the FIRST ~5 `export function`s
// (in file-scope order) onto CJS `module.exports`. The remaining 6 named
// exports are hung only on the ESM namespace `Object` that esbuild creates
// but does NOT wire ESM consumers to use — both `import { X } from '...'`
// and `import * as B from '...'` resolve to the CJS exports object, so
// `X.createComfyFetch` is undefined → runtime `(0, X.createComfyFetch) is
// not a function`.
//
// Fix: side-effect-copy every named export onto `globalThis.__vssarosBridge`
// so consumers can pull them from there. Use the comma operator +
// `void (0)` trick to defeat esbuild's dead-code elimination of the
// `typeof X !== 'undefined'` check.
//
// Consumers in nodeExecutor.ts / stageWorkflowExecutor.ts / nodeCard.tsx /
// comfyRunner.ts fall back to `(globalThis as any).__vssarosBridge.X` when
// the standard import returns undefined.
// ════════════════════════════════════════════════════════════════════════
(globalThis as unknown as { __vssarosBridge?: Record<string, unknown> }).__vssarosBridge ??= {
	createComfyFetch,
	createProxiedFetch,
	getComfyCorsMode,
	probeDirectCors,
	reprobeComfyCors,
	subscribeComfyCors,
	pickFolderDialog,
};

/**
 * 弹出 vscode 文件夹选择对话框（仅 webview 环境可用）。
 * Node/SSR/单测环境（无 vscode API）返回 undefined，不抛错。
 *
 * 用途：媒体库 rootDir、ComfyUI 主目录等需要用户选目录但**不允许手敲绝对路径**
 * 的场景——避免拼写错误、路径越权、跨盘符等手输风险。
 */
export async function pickFolderDialog(opts: { title?: string; openLabel?: string } = {}): Promise<string | undefined> {
	const api = vscode as unknown as {
		window?: { showOpenDialog(o: unknown): PromiseLike<Array<{ fsPath: string }> | undefined> };
	};
	const show = api.window?.showOpenDialog;
	if (!show) { return undefined; }
	try {
		const result = await show({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: opts.openLabel ?? '选择此目录',
			title: opts.title,
		});
		return result?.[0]?.fsPath;
	} catch {
		return undefined;
	}
}
