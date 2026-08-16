/*---------------------------------------------------------------------------------------------
 *  Unit tests for 方案A（webview 直连优先/代理兜底）：
 *   - messageClient: probeDirectCors / reprobeComfyCors / getComfyCorsMode / subscribeComfyCors / createComfyFetch
 *   - comfyRunner: collectRunnerRows 携带 RunnerRow.mode
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	createComfyFetch,
	probeDirectCors,
	reprobeComfyCors,
	getComfyCorsMode,
	subscribeComfyCors,
	type ComfyCorsMode,
} from '../../webview/src/bridge/messageClient.js';
import {
	createLocalComfyRunner,
	collectRunnerRows,
	type FetchLike,
} from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

type GlobalWithFetch = typeof globalThis & { fetch: unknown };

function stubGlobalFetch(impl: (input: string, init?: RequestInit) => Promise<unknown>): () => void {
	const g = globalThis as GlobalWithFetch;
	const orig = g.fetch;
	g.fetch = impl;
	return () => { g.fetch = orig; };
}

/** 最小 Response 形状（不依赖 DOM lib 的 Response 类型）。 */
function fakeResponse(data: unknown, status = 200): unknown {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {},
		json: async () => data,
		text: async () => JSON.stringify(data),
		blob: async () => new Blob(),
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

const LOCAL = 'http://127.0.0.1:8188';

suite('comfyCors（方案A 直连/代理路由）', () => {

	suite('probeDirectCors', () => {

		test('resolve ok → true', async () => {
			const restore = stubGlobalFetch(async (url) => {
				assert.ok(url.startsWith(`${LOCAL}/system_stats`));
				return fakeResponse({});
			});
			try { assert.strictEqual(await probeDirectCors(LOCAL), true); }
			finally { restore(); }
		});

		test('CORS TypeError → false', async () => {
			const restore = stubGlobalFetch(async () => { throw new TypeError('Failed to fetch'); });
			try { assert.strictEqual(await probeDirectCors(LOCAL), false); }
			finally { restore(); }
		});

		test('non-ok status → false', async () => {
			const restore = stubGlobalFetch(async () => fakeResponse({}, 500));
			try { assert.strictEqual(await probeDirectCors(LOCAL), false); }
			finally { restore(); }
		});
	});

	suite('状态机 reprobeComfyCors / getComfyCorsMode', () => {

		test('proxied → direct 迁移', async () => {
			let mode: 'ok' | 'throw' = 'throw';
			const restore = stubGlobalFetch(async () => {
				if (mode === 'throw') { throw new TypeError('Failed to fetch'); }
				return fakeResponse({});
			});
			try {
				assert.strictEqual(getComfyCorsMode(LOCAL), 'unknown');
				assert.strictEqual(await reprobeComfyCors(LOCAL), 'proxied');
				assert.strictEqual(getComfyCorsMode(LOCAL), 'proxied');
				mode = 'ok';
				assert.strictEqual(await reprobeComfyCors(LOCAL), 'direct');
				assert.strictEqual(getComfyCorsMode(LOCAL), 'direct');
			} finally { restore(); }
		});

		test('subscribeComfyCors 在模式变化时回调，退订后停止', async () => {
			const restore = stubGlobalFetch(async () => { throw new TypeError('Failed to fetch'); });
			try {
				const seen: ComfyCorsMode[] = [];
				const unsub = subscribeComfyCors(LOCAL, m => seen.push(m));
				await reprobeComfyCors(LOCAL);
				assert.deepStrictEqual(seen, ['proxied']);
				unsub();
				await reprobeComfyCors(LOCAL);
				assert.deepStrictEqual(seen, ['proxied']);
			} finally { restore(); }
		});
	});

	suite('createComfyFetch 路由', () => {

		test('direct 态走直连（保留 blob 能力，非代理 stub）', async () => {
			const calls: string[] = [];
			const restore = stubGlobalFetch(async (url) => {
				calls.push(url);
				return fakeResponse({ ok: true });
			});
			try {
				await reprobeComfyCors(LOCAL); // direct
				calls.length = 0; // 清除探测自身的 /system_stats 调用
				const f = createComfyFetch(LOCAL);
				const res = await f(`${LOCAL}/system_stats`);
				assert.strictEqual((res as { ok: boolean }).ok, true);
				assert.deepStrictEqual(calls, [`${LOCAL}/system_stats`]);
				// 直连返回真 Response → blob 可用（代理 stub 只有 json/text）
				assert.strictEqual(typeof (res as { blob?: unknown }).blob, 'function');
			} finally { restore(); }
		});

		test('非 localhost URL 一律原生 fetch（不经 CORS 路由）', async () => {
			const calls: string[] = [];
			const restore = stubGlobalFetch(async (url) => {
				calls.push(url);
				return fakeResponse({});
			});
			try {
				const f = createComfyFetch(LOCAL);
				await f('https://example.com/data.json');
				await f('data:text/plain,hello');
				assert.deepStrictEqual(calls, ['https://example.com/data.json', 'data:text/plain,hello']);
			} finally { restore(); }
		});

		test('创建时后台探测（CORS 可用 → 自动标记 direct）', async () => {
			const probeUrl = 'http://127.0.0.1:9191'; // 独立 origin，避免前序用例缓存污染
			const restore = stubGlobalFetch(async (url) => {
				assert.ok(url.startsWith(`${probeUrl}/system_stats`));
				return fakeResponse({});
			});
			try {
				createComfyFetch(probeUrl);
				for (let i = 0; i < 100; i++) {
					if (getComfyCorsMode(probeUrl) !== 'unknown') { break; }
					await new Promise(r => setTimeout(r, 10));
				}
				assert.strictEqual(getComfyCorsMode(probeUrl), 'direct');
			} finally { restore(); }
		});
	});

	suite('comfyRunner 集成（RunnerRow.mode）', () => {

		test('collectRunnerRows 填充当前 CORS 模式', async () => {
			const restore = stubGlobalFetch(async () => { throw new TypeError('Failed to fetch'); });
			try {
				await reprobeComfyCors(LOCAL); // proxied
				const runner = createLocalComfyRunner((async (url: string) => ({
					ok: true,
					status: 200,
					json: async () => ({ system: { comfyui_version: 'v1.0.0' } }),
					text: async () => '{}',
				})) as unknown as FetchLike);
				const rows = await collectRunnerRows([runner]);
				assert.strictEqual(rows[0].mode, 'proxied');
				assert.strictEqual(rows[0].ok, true);
			} finally { restore(); }
		});
	});
});
