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

export type ComfyCapability = 'image' | 'video' | 'audio' | 'text' | 'any';

export interface ComfyRunnerStatus {
	ok: boolean;
	version?: string;
	devices?: string[];
	error?: string;
}

export interface ComfyRunProgress {
	promptId: string;
	value: number; // 0..100
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
	 * ComfyTV extension endpoints (e.g. /comfytv/workflows/config).
	 * Optional: absent on a plain ComfyUI runner — callers must degrade.
	 */
	fetchApi?(path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<ComfyApiResponse>;
}

export interface FetchLike {
	(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
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
	) { }

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
	async fetchApi(path: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<ComfyApiResponse> {
		const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
		return this.fetchImpl(url, {
			method: init?.method ?? 'GET',
			headers: this.headers(),
			body: init?.body,
			signal: init?.signal,
		});
	}

	async invoke(options: ComfyRunOptions): Promise<ComfyRunResult> {
		const started = Date.now();
		const res = await this.fetchImpl(`${this.baseUrl}/prompt`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(options.prompt),
			signal: options.signal,
		});
		if (!res.ok) {
			throw new Error(`ComfyUI /prompt failed: HTTP ${res.status}`);
		}
		const body = (await res.json()) as { prompt_id?: string; error?: unknown };
		if (!body.prompt_id) {
			throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(body)}`);
		}
		const promptId = body.prompt_id;

		// Poll /history/{id} until the prompt leaves the queue.
		// A real implementation would also subscribe to /ws; polling keeps the
		// runner framework-agnostic and testable.
		let result: ComfyRunResult;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			if (options.signal?.aborted) {
				return { promptId, outputs: {}, status: 'canceled', durationMs: Date.now() - started };
			}
			await new Promise(r => setTimeout(r, this.pollMs));
			const hist = await this.fetchImpl(`${this.baseUrl}/history/${promptId}`, { method: 'GET' });
			if (!hist.ok) { continue; }
			const data = (await hist.json()) as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: Record<string, unknown> }>;
			const entry = data[promptId];
			if (!entry) { continue; }
			const st = entry.status?.status_str;
			if (st === 'success' || entry.status?.completed) {
				result = { promptId, outputs: entry.outputs ?? {}, status: 'success', durationMs: Date.now() - started };
				break;
			}
			if (st === 'error') {
				result = { promptId, outputs: {}, status: 'error', error: 'ComfyUI execution error', durationMs: Date.now() - started };
				break;
			}
			// status_str can be undefined while queued/running — report progress heuristically
			options.onProgress?.({ promptId, value: 50 });
		}
		return result;
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
		});
	}
	return rows;
}
