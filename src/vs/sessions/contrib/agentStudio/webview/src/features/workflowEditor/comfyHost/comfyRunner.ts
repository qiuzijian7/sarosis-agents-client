/*---------------------------------------------------------------------------------------------
 *  comfyRunner — ComfyUI runner client + registry (injectable fetch, unit-testable).
 *
 *  Mirrors ComfyTV's RunnerRegistry:
 *   - LocalComfyRunner : talks to a ComfyUI instance over HTTP
 *       - testConnection  → GET /system_stats
 *       - invoke          → POST /prompt (api.json) → poll GET /history/{id} or /ws
 *   - RemoteComfyRunner : same contract, different base URL (+ optional token)
 *   - registry stores runners by id and resolves the active one.
 *
 *  All network access goes through an injected `fetchLike` so tests run without
 *  a real server.
 *--------------------------------------------------------------------------------------------*/

// 见 nodeExecutor.ts 同款注释。
const _bridge = (globalThis as { __vssarosBridge?: { getComfyCorsMode: typeof import('../../../bridge/messageClient')['getComfyCorsMode'] } }).__vssarosBridge
	?? (() => { throw new Error('vssarosBridge not initialised'); })();
const { getComfyCorsMode } = _bridge;
import type { ComfyCorsMode } from '../../../bridge/messageClient';

export type ComfyCapability = 'image' | 'video' | 'audio' | 'text' | 'any';

/** Extract a short, actionable hint from a ComfyUI validation error body.
 *  ComfyUI 4xx responses embed rich per-field details inside
 *  `extra_info[node_errors][*].errors[].details` (Python tuple) and the
 *  full `ckpt_name` / `model_name` / `clip_name` candidate list lives a
 *  level higher under `extra_info[].choices`. The headlined hint makes the
 *  most useful piece (which field was rejected + the first few alternatives)
 *  visible at the top of the error banner, sparing users from scrolling
 *  through a multi-KB JSON dump.
 *  Returns '' if no actionable detail is found. */
export function parseComfyErrorHint(body: string): string {
	if (!body) { return ''; }
	let parsed: Record<string, unknown> | undefined;
	try { parsed = JSON.parse(body); } catch { return ''; }
	if (!parsed || typeof parsed !== 'object') { return ''; }
	// ComfyUI's two known shapes:
	//   { "error": "...", "node_errors": { "<id>": { "errors": [{ "type": "...", "details": "..." }] } }, "extra_info": { "...": ["a", "b"] } }
	//   { "node_errors": { "<id>": [ { "type": "...", "details": "..." } ] } }
	const nodeErrors = parsed['node_errors'];
	if (typeof nodeErrors !== 'object' || nodeErrors === null) { return ''; }
	const extraInfo = parsed['extra_info'];
	// First rejection: collect per-field messages.
	const rejections: string[] = [];
	const seen = new Set<string>();
	const MAX = 6;
	for (const [, raw] of Object.entries(nodeErrors as Record<string, unknown>)) {
		const entries = Array.isArray(raw) ? raw : (typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['errors']))
			? (raw as Record<string, unknown>)['errors'] as unknown[]
			: [];
		for (const entry of entries as Array<Record<string, unknown>>) {
			const type = typeof entry?.['type'] === 'string' ? entry['type'] as string : '';
			const details = typeof entry?.['details'] === 'string' ? entry['details'] as string : '';
			if (!type && !details) { continue; }
			const key = `${type}|${details}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			rejections.push(type === 'value_not_in_list'
				? `字段 ${details} 不在 ComfyUI 服务器可选值列表里`
				: type === 'required_input_missing'
					? `缺少必需输入：${details}`
					: type || details);
			if (rejections.length >= MAX) { break; }
		}
		if (rejections.length >= MAX) { break; }
	}
	if (!rejections.length) { return ''; }
	// For value_not_in_list, surface the first few alternatives from extra_info
	// so users can immediately see what's available. ComfyUI's `choices` lives
	// on the *node's own* details object, not on a sibling key, so we look for
	// the first field that maps to a string[] under extra_info and that
	// matches any rejected details substring. As a pragmatic fallback we
	// also surface any extra_info value that looks like a model file list.
	let choicesHint = '';
	if (extraInfo && typeof extraInfo === 'object') {
		const ei = extraInfo as Record<string, unknown>;
		for (const [k, v] of Object.entries(ei)) {
			if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) {
				const list = v as string[];
				const sample = list.slice(0, 5).join(', ');
				const more = list.length > 5 ? ` 等 ${list.length} 项` : '';
				choicesHint = `；可用：${sample}${more}`;
				break;
			}
		}
	}
	return `${rejections.join('；')}${choicesHint}`;
}

/**
 * 从 ComfyUI /history/{prompt_id} 的 error entry 中提取可读的执行错误详情。
 *
 * ComfyUI 执行失败时，/history 返回的 entry 结构大致为：
 *   { status: { status_str: 'error', completed: false },
 *     outputs: { ... },
 *     (可能含) status_messages: [...] }
 * 本函数尝试从多种已知字段提取人类可读的错误信息。
 */
export function extractComfyExecutionError(
	entry: { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, unknown>; [key: string]: unknown },
): string {
	if (!entry) return '';
	// 1) ComfyUI 原生异常消息（常见于自定义节点报错）
	const messages = (entry as Record<string, unknown>)['status_messages'];
	if (Array.isArray(messages) && messages.length > 0) {
		const last = String(messages[messages.length - 1]).trim();
		if (last && last !== 'undefined') return last.slice(0, 500);
	}
	// 2) outputs 里节点级异常（部分版本把错误嵌入 outputs）
	if (entry.outputs && typeof entry.outputs === 'object') {
		for (const [, val] of Object.entries(entry.outputs)) {
			if (val && typeof val === 'object' && !Array.isArray(val)) {
				const obj = val as Record<string, unknown>;
				const err = obj['error'] ?? obj['err'] ?? obj['exception'] ?? obj['message'];
				if (typeof err === 'string' && err.trim()) return err.trim().slice(0, 500);
			}
		}
	}
	// 3) 透传整个 entry 的关键子集（脱敏后用于日志）
	try {
		const subset = JSON.stringify({
			status_str: entry.status?.status_str,
			completed: entry.status?.completed,
			keys: Object.keys(entry).filter(k => k !== 'outputs'),
		});
		if (subset !== '{}') return `[exec-error] ${subset}`;
	} catch { /* ignore */ }
	return '';
}

export interface ComfyRunnerStatus {
	ok: boolean;
	version?: string;
	devices?: string[];
	error?: string;
}

export interface ComfyRunProgress {
	promptId: string;
	value: number; // 0..100
	/** 状态文本（如「AI 抠图模型下载中 12/176MB」），透传到节点卡片进度条 caption。 */
	message?: string;
}

export interface ComfyRunResult {
	promptId: string;
	/** parsed outputs keyed by node id (from /history) */
	outputs: Record<string, unknown>;
	status: 'success' | 'error' | 'canceled';
	error?: string;
	durationMs?: number;
}

export interface ComfyRunOptions {
	/** api.json prompt */
	prompt: unknown;
	onProgress?: (p: ComfyRunProgress) => void;
	signal?: AbortSignal;
	/** 合并到 `/prompt` body 顶层（ComfyTV/前端扩展使用，如 extra_pnginfo）。 */
	extraData?: Record<string, unknown>;
}

export interface ComfyApiResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export interface IComfyRunner {
	readonly id: string;
	readonly kind: 'local' | 'remote';
	readonly baseUrl: string;
	testConnection(): Promise<ComfyRunnerStatus>;
	invoke(options: ComfyRunOptions): Promise<ComfyRunResult>;
	/**
	 * ComfyUI 原生 HTTP 端点（如 /upload/image、/object_info 等）。
	 * 本项目不依赖 ComfyTV 后端 API（/comfytv/* 已移除）；此通道仅用于
	 * ComfyUI 标准 REST 端点。Optional：runner 不可用时调用方需降级。
	 */
	fetchApi?(path: string, init?: { method?: string; body?: string | FormData; signal?: AbortSignal }): Promise<ComfyApiResponse>;
}

export interface FetchLike {
	(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

const DEFAULT_POLL_MS = 800;

/** Base HTTP runner shared by local + remote. */
class HttpComfyRunner implements IComfyRunner {
	constructor(
		public readonly id: string,
		public readonly kind: 'local' | 'remote',
		public readonly baseUrl: string,
		private readonly fetchImpl: FetchLike,
		private readonly pollMs: number = DEFAULT_POLL_MS,
		private readonly token?: string,
		private readonly clientId: string = '',
	) {
		// 客户端标识：ComfyUI 用于把 /ws 消息与我们的 /prompt 关联到同一个 client。
		// crypto.randomUUID 在 webview 中可用；不可用时降级 time+rand。
		try { this.clientId = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
		catch { this.clientId = `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.token) { h['Authorization'] = `Bearer ${this.token}`; }
		return h;
	}

	async testConnection(): Promise<ComfyRunnerStatus> {
		try {
			const res = await this.fetchImpl(`${this.baseUrl}/system_stats`, { method: 'GET' });
			if (!res.ok) { return { ok: false, error: `HTTP ${res.status}` }; }
			const body = (await res.json()) as { system?: { comfyui_version?: string } };
			return { ok: true, version: body.system?.comfyui_version };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** ComfyTV extension endpoints over the same fetch/headers as invoke(). */
	async fetchApi(path: string, init?: { method?: string; body?: string | FormData; signal?: AbortSignal }): Promise<ComfyApiResponse> {
		const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
		const headers = this.headers();
		// ★ FormData 上传（/upload/image 等）不能手动设置 Content-Type：浏览器需
		//   自动生成 `multipart/form-data; boundary=...`。若保留 `application/json`，
		//   浏览器会把 FormData 当 JSON 发送（body 损坏/为空），ComfyUI 解析失败
		//   → HTTP 400。仅对非 FormData body 保留 JSON Content-Type。
		if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
			delete headers['Content-Type'];
		}
		return this.fetchImpl(url, {
			method: init?.method ?? 'GET',
			headers,
			body: init?.body,
			signal: init?.signal,
		});
	}

	async invoke(options: ComfyRunOptions): Promise<ComfyRunResult> {
		const started = Date.now();
		// ComfyUI /prompt 期望的结构是 `{ "prompt": { "<nodeId>": {...} }, "client_id": "<uuid>" }`。
		// 之前直接 POST 了 api_json 整体 → ComfyUI 看到 prompt 字段是 undefined → "No prompt provided"。
		// options.prompt 已经是 api_json（nodeId → node 对象），须包装一层。
		const payload = {
			prompt: options.prompt,
			client_id: this.clientId,
			...(options.extraData ?? {}),
		};
		const res = await this.fetchImpl(`${this.baseUrl}/prompt`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(payload),
			signal: options.signal,
		});
		if (!res.ok) {
			// 4xx/5xx 把后端返回的 body 一并附在错误上，让 UI 能直接看到 ComfyUI 的具体拒绝原因
			// （如 "Prompt has no outputs"、"invalid prompt: xxx"），否则只能看到 status。
			let detail = '';
			try {
				detail = await res.text();
			} catch { /* 忽略 body 读取失败 */ }
			// Surface "value not in list" / required-input-missing as a short
			// headline at the top — users otherwise have to dig through a
			// multi-KB JSON blob to find which field the server rejected and
			// which values it accepts.
			const hint = parseComfyErrorHint(detail);
			const hintPart = hint ? `\n💡 ${hint}` : '';
			const snippet = detail ? `\n${detail.slice(0, 1024)}` : '';
			throw new Error(`ComfyUI /prompt failed: HTTP ${res.status}${hintPart}${snippet}`);
		}
		const body = (await res.json()) as { prompt_id?: string; error?: unknown };
		if (!body.prompt_id) {
			throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(body)}`);
		}
		const promptId = body.prompt_id;

		// 实时进度：优先接入 ComfyUI WebSocket（KSampler 每步推送 progress 事件），
		// 让进度条随采样步骤真正移动；WebSocket 不可用（webview CSP / 代理 / 快速出图）
		// 时退化为轮询次数平滑递增兜底。两者都经 report() 单调递增上报，互不回退。
		let result: ComfyRunResult;
		let lastReported = -1;
		const report = (value: number): void => {
			const v = Math.max(0, Math.min(99, Math.round(value)));
			if (v <= lastReported) { return; }
			lastReported = v;
			options.onProgress?.({ promptId, value: v });
		};
		// 立即给一点反馈，避免快速出图时进度条一直停在 0%
		report(8);

		// 接入 ComfyUI /ws 实时进度（最佳实践；失败则静默退化到轮询）
		const wsDispose = this.attachProgressSocket(promptId, report);

		let pollCount = 0;
		try {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				if (options.signal?.aborted) {
					return { promptId, outputs: {}, status: 'canceled', durationMs: Date.now() - started };
				}
				await new Promise(r => setTimeout(r, this.pollMs));
				const hist = await this.fetchImpl(`${this.baseUrl}/history/${promptId}`, { method: 'GET' });
				if (!hist.ok) { continue; }
				const data = (await hist.json()) as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, unknown> }>;
				const entry = data[promptId];
				pollCount++;
				if (!entry) { continue; }
				const st = entry.status?.status_str;
				// eslint-disable-next-line no-console
				console.warn(`[comfyRunner.invoke] poll #${pollCount} st=${st} completed=${entry.status?.completed}`);
				if (st === 'success' || entry.status?.completed) {
					report(90);
					result = { promptId, outputs: entry.outputs ?? {}, status: 'success', durationMs: Date.now() - started };
					break;
				}
				if (st === 'error') {
					// ★ 提取 ComfyUI 实际报错详情（节点级异常 / 执行异常消息），
					//   替代原来的通用 "ComfyUI execution error"，便于定位根因
					//   （如：MiniMax H3 自定义节点未装 / 模型缺失 / API key 过期）。
					const detail = extractComfyExecutionError(entry);
					result = { promptId, outputs: {}, status: 'error', error: detail || 'ComfyUI execution error', durationMs: Date.now() - started };
					break;
				}
				// 排队/运行中：用轮询次数做平滑递增（WebSocket 不可用时的兜底动画）
				report(Math.min(85, 12 + pollCount * 3));
			}
		} finally {
			wsDispose();
		}
		// eslint-disable-next-line no-console
		console.warn(`[comfyRunner.invoke] done polls=${pollCount}`);
		return result;
	}

	/**
	 * 尝试接入 ComfyUI `/ws` 实时进度（ComfyUI/ComfyTV 的进度正源是 WebSocket 的
	 * `progress` 事件，而非 /history 轮询）。webview 环境若不允许 WebSocket
	 * （CSP / 代理 / 无网络）会静默失败，调用方自动退化到轮询进度，不影响正确性。
	 * 返回 dispose 句柄，调用方在出图完成后关闭连接。
	 */
	private attachProgressSocket(promptId: string, report: (v: number) => void): () => void {
		if (typeof WebSocket === 'undefined') { return () => {}; }
		let ws: WebSocket | undefined;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${encodeURIComponent(this.clientId)}`;
		try {
			ws = new WebSocket(wsUrl);
		} catch {
			return () => {};
		}
		const dispose = (): void => {
			if (settled) { return; }
			settled = true;
			if (timer) { clearTimeout(timer); timer = undefined; }
			try { ws?.close(); } catch { /* ignore */ }
		};
		// 连接超时（3s）即放弃 WS，完全依赖轮询进度
		timer = setTimeout(dispose, 3000);
		ws.onopen = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
		ws.onerror = () => { dispose(); };
		ws.onclose = () => { dispose(); };
		ws.onmessage = (ev: MessageEvent) => {
			try {
				const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
				if (msg?.type !== 'progress' || !msg.data) { return; }
				const { value, max, prompt_id: mid } = msg.data as { value?: number; max?: number; prompt_id?: string };
				if (typeof value !== 'number' || typeof max !== 'number' || max <= 0) { return; }
				if (mid && mid !== promptId) { return; }
				report((value / max) * 100);
			} catch { /* ignore malformed ws frame */ }
		};
		return dispose;
	}
}

export function createLocalComfyRunner(fetchImpl: FetchLike, baseUrl = 'http://127.0.0.1:8188', pollMs?: number): IComfyRunner {
	return new HttpComfyRunner('local', 'local', baseUrl, fetchImpl, pollMs);
}

export function createRemoteComfyRunner(id: string, baseUrl: string, fetchImpl?: FetchLike, opts?: { token?: string; pollMs?: number }): IComfyRunner {
	// Same receiver-safe wrapping as createDefaultLocalRunner (see above).
	const impl: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));
	return new HttpComfyRunner(id, 'remote', baseUrl, impl, opts?.pollMs, opts?.token);
}

/** Simple registry of runners by id. */
export class ComfyRunnerRegistry {
	private runners = new Map<string, IComfyRunner>();

	register(runner: IComfyRunner): void {
		this.runners.set(runner.id, runner);
	}
	unregister(id: string): boolean {
		return this.runners.delete(id);
	}
	get(id: string): IComfyRunner | undefined {
		return this.runners.get(id);
	}
	list(): IComfyRunner[] {
		return [...this.runners.values()];
	}
	/** Resolve a runner preference ('auto' | 'local' | 'remote:<id>') against the registry. */
	resolve(preference: string | undefined): IComfyRunner | undefined {
		if (!preference || preference === 'auto') {
			return this.runners.get('local') ?? this.runners.values().next().value;
		}
		if (preference === 'local') { return this.runners.get('local'); }
		if (preference.startsWith('remote:')) {
			return this.runners.get(preference.slice('remote:'.length));
		}
		return this.runners.get(preference);
	}
}

/** Build a default local runner using the global fetch (browser webview). */
export function createDefaultLocalRunner(fetchImpl?: FetchLike): IComfyRunner {
	// Wrap window.fetch in an arrow function: bare `fetch` must be invoked with
	// its Window receiver, otherwise calls like this.fetchImpl(...) throw
	// "Failed to execute 'fetch' on 'Window': Illegal invocation".
	const impl: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));
	return createLocalComfyRunner(impl);
}

/** Pure helper: aggregate status rows for the Runner panel. */
export interface RunnerRow {
	id: string;
	kind: 'local' | 'remote';
	baseUrl: string;
	ok: boolean;
	version?: string;
	error?: string;
	/** 方案A：CORS 模式（direct=webview 直连 / proxied=主进程代理 / unknown=未探测）。 */
	mode?: ComfyCorsMode;
}

function runnerOrigin(baseUrl: string): string {
	try { return new URL(baseUrl).origin; } catch { return baseUrl; }
}

export async function collectRunnerRows(
	runners: IComfyRunner[],
	testFn: (r: IComfyRunner) => Promise<ComfyRunnerStatus> = r => r.testConnection(),
): Promise<RunnerRow[]> {
	const rows: RunnerRow[] = [];
	for (const r of runners) {
		const st = await testFn(r);
		rows.push({
			id: r.id,
			kind: r.kind,
			baseUrl: r.baseUrl,
			ok: st.ok,
			version: st.version,
			error: st.error,
			mode: getComfyCorsMode(runnerOrigin(r.baseUrl)),
		});
	}
	return rows;
}
