/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyRunner — ComfyUI HTTP client + registry (injectable fetch).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	createLocalComfyRunner,
	createRemoteComfyRunner,
	ComfyRunnerRegistry,
	collectRunnerRows,
	type FetchLike,
	type IComfyRunner,
} from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

/** Fake fetch that records requests and returns canned responses. */
function fakeFetch(handler: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>): FetchLike {
	return handler as FetchLike;
}

function jsonResponse(data: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> } {
	return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

suite('comfyRunner', () => {

	suite('testConnection', () => {

		test('ok path returns version', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async (url) => {
				assert.strictEqual(url, 'http://127.0.0.1:8188/system_stats');
				return jsonResponse({ system: { comfyui_version: 'v1.10.5' } });
			}));
			const status = await runner.testConnection();
			assert.deepStrictEqual(status, { ok: true, version: 'v1.10.5' });
		});

		test('http error surfaces as not-ok', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async () => jsonResponse({}, 500)));
			const status = await runner.testConnection();
			assert.strictEqual(status.ok, false);
			assert.match(status.error ?? '', /500/);
		});

		test('network throw is caught', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async () => { throw new Error('ECONNREFUSED'); }));
			const status = await runner.testConnection();
			assert.strictEqual(status.ok, false);
			assert.match(status.error ?? '', /ECONNREFUSED/);
		});
	});

	suite('invoke', () => {

		test('submits /prompt and returns success with outputs', async () => {
			const calls: string[] = [];
			const runner = createLocalComfyRunner(fakeFetch(async (url) => {
				calls.push(url);
				if (url.endsWith('/prompt')) {
					return jsonResponse({ prompt_id: 'p1' });
				}
				// /history/p1 → success on first poll
				return jsonResponse({ p1: { status: { status_str: 'success', completed: true }, outputs: { '3': { images: ['a.png'] } } } });
			}), undefined, 0);
			const result = await runner.invoke({ prompt: { nodes: [] } });
			assert.strictEqual(result.status, 'success');
			assert.strictEqual(result.promptId, 'p1');
			assert.deepStrictEqual(result.outputs['3'], { images: ['a.png'] });
			assert.ok(calls.some(u => u.endsWith('/prompt')));
			assert.ok(calls.some(u => u.endsWith('/history/p1')));
		});

		test('non-ok /prompt throws', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async () => jsonResponse({}, 503)));
			await assert.rejects(() => runner.invoke({ prompt: {} }), /HTTP 503/);
		});

		test('missing prompt_id throws', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async () => jsonResponse({})));
			await assert.rejects(() => runner.invoke({ prompt: {} }), /no prompt_id/);
		});

		test('error status from history', async () => {
			const runner = createLocalComfyRunner(fakeFetch(async (url) => {
				if (url.endsWith('/prompt')) { return jsonResponse({ prompt_id: 'p1' }); }
				return jsonResponse({ p1: { status: { status_str: 'error' } } });
			}), undefined, 0);
			const result = await runner.invoke({ prompt: {} });
			assert.strictEqual(result.status, 'error');
			assert.strictEqual(typeof result.durationMs, 'number');
		});

		test('abort during polling returns canceled', async () => {
			let pollCount = 0;
			const runner = createLocalComfyRunner(fakeFetch(async (url) => {
				if (url.endsWith('/prompt')) { return jsonResponse({ prompt_id: 'p1' }); }
				pollCount++;
				return jsonResponse({}); // not done yet
			}), undefined, 1);
			const ac = new AbortController();
			const promise = runner.invoke({ prompt: {}, signal: ac.signal });
			setTimeout(() => ac.abort(), 5);
			const result = await promise;
			assert.strictEqual(result.status, 'canceled');
		});
	});

	suite('registry', () => {

		test('register/get/list/unregister', () => {
			const reg = new ComfyRunnerRegistry();
			const r1 = createRemoteComfyRunner('rem1', 'http://x:1', fakeFetch(async () => jsonResponse({})));
			reg.register(r1);
			assert.strictEqual(reg.get('rem1'), r1);
			assert.strictEqual(reg.list().length, 1);
			assert.strictEqual(reg.unregister('rem1'), true);
			assert.strictEqual(reg.get('rem1'), undefined);
		});

		test('resolve auto prefers local, falls back to first', () => {
			const reg = new ComfyRunnerRegistry();
			const rem = createRemoteComfyRunner('rem1', 'http://x:1', fakeFetch(async () => jsonResponse({})));
			reg.register(rem);
			// no local registered → first
			assert.strictEqual(reg.resolve('auto'), rem);

			const local = createLocalComfyRunner(fakeFetch(async () => jsonResponse({})));
			reg.register(local);
			assert.strictEqual(reg.resolve('auto'), local);
		});

		test('resolve explicit ids', () => {
			const reg = new ComfyRunnerRegistry();
			const local = createLocalComfyRunner(fakeFetch(async () => jsonResponse({})));
			const rem = createRemoteComfyRunner('rem1', 'http://x:1', fakeFetch(async () => jsonResponse({})));
			reg.register(local);
			reg.register(rem);
			assert.strictEqual(reg.resolve('local'), local);
			assert.strictEqual(reg.resolve('remote:rem1'), rem);
			assert.strictEqual(reg.resolve('nope'), undefined);
		});
	});

	suite('collectRunnerRows', () => {

		test('aggregates statuses for the runner panel', async () => {
			const local: IComfyRunner = {
				id: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8188',
				testConnection: async () => ({ ok: true, version: 'v1.10.5' }),
				invoke: async () => ({ promptId: 'p', outputs: {}, status: 'success' }),
			};
			const remote: IComfyRunner = {
				id: 'remote:cf', kind: 'remote', baseUrl: 'https://cf.example',
				testConnection: async () => ({ ok: false, error: 'HTTP 502' }),
				invoke: async () => ({ promptId: 'p', outputs: {}, status: 'success' }),
			};
			const rows = await collectRunnerRows([local, remote]);
			assert.strictEqual(rows.length, 2);
			assert.strictEqual(rows[0].ok, true);
			assert.strictEqual(rows[0].version, 'v1.10.5');
			assert.strictEqual(rows[1].ok, false);
			assert.strictEqual(rows[1].error, 'HTTP 502');
			assert.strictEqual(rows[1].id, 'remote:cf');
		});

		test('uses injected testFn when provided', async () => {
			const fake: IComfyRunner = {
				id: 'local', kind: 'local', baseUrl: 'x',
				testConnection: async () => ({ ok: true }),
				invoke: async () => ({ promptId: 'p', outputs: {}, status: 'success' }),
			};
			let calls = 0;
			const rows = await collectRunnerRows([fake], async () => { calls++; return { ok: true, version: 'v2' }; });
			assert.strictEqual(calls, 1);
			assert.strictEqual(rows[0].version, 'v2');
		});
	});

	suite('remote runner auth header', () => {

		test('sends bearer token on /prompt', async () => {
			let sentAuth: string | undefined;
			const runner = createRemoteComfyRunner('rem1', 'https://cf.example', fakeFetch(async (url, init) => {
				const opts = init as { headers?: Record<string, string> };
				if (url.endsWith('/prompt')) {
					sentAuth = opts.headers?.['Authorization'];
					return jsonResponse({ prompt_id: 'p1' });
				}
				return jsonResponse({ p1: { status: { status_str: 'success', completed: true }, outputs: {} } });
			}), { token: 'tok123', pollMs: 0 });
			await runner.invoke({ prompt: {} });
			assert.strictEqual(sentAuth, 'Bearer tok123');
		});
	});
});
