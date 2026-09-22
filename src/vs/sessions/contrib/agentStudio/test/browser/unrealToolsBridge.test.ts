/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * unreal_* 工具 HTTP 传输层的回归守卫（2026-09-22，打包版 CORS 事故）。
 *
 * 事故：打包版（vssaros.exe）里 renderer 页面 origin 是 `vscode-file://vscode-app`，
 * 直连 `http://127.0.0.1:8765/bridge/*` 被 Chromium 按 CORS 拦截（bridge 不回
 * `Access-Control-Allow-Origin`）⇒ 所有 unreal_* 工具在打包版全部失败。
 *
 * 修法：`callBridge` 优先走主进程 IPC `vscode:webFetch`（Chromium net.fetch，无 CORS），
 * 仅在没有 IPC 的环境（纯 web / 测试）回退 renderer fetch。本文件钉住这条分流与失败文案。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/unrealToolsBridge.test.ts
 */

import * as assert from 'assert';
import { registerUnrealTools } from '../../browser/providers/tool/unrealTools.js';
import type { IToolDefinition, IToolResultContent } from '../../common/providers.js';

type Handler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<IToolResultContent[]>;

function registerHandlers(): Map<string, Handler> {
	const map = new Map<string, Handler>();
	registerUnrealTools({
		register: (d: { definition: IToolDefinition; handler: Handler }) => { map.set(d.definition.name, d.handler); },
		logService: { info: () => { }, warn: () => { }, error: () => { } } as never,
	});
	return map;
}

const textOf = (r: IToolResultContent[]) =>
	r.map(c => (c as { type: string; text?: string }).text ?? '').join('\n');

/** 装/卸全局 `vscode.ipcRenderer` 与 `fetch` mock（Node 环境下两者默认都没有/真实存在）。 */
function withGlobals<T>(
	vscodeInvoke: undefined | ((ch: string, payload: unknown) => Promise<unknown>),
	fetchImpl: undefined | ((url: string, init: unknown) => Promise<unknown>),
	fn: () => Promise<T>,
): Promise<T> {
	const g = globalThis as Record<string, unknown>;
	const hadVscode = 'vscode' in g;
	const prevVscode = g['vscode'];
	const prevFetch = g['fetch'];
	if (vscodeInvoke) { g['vscode'] = { ipcRenderer: { invoke: vscodeInvoke } }; } else { delete g['vscode']; }
	if (fetchImpl) { g['fetch'] = fetchImpl; } else { delete g['fetch']; }
	return fn().finally(() => {
		if (hadVscode) { g['vscode'] = prevVscode; } else { delete g['vscode']; }
		if (prevFetch) { g['fetch'] = prevFetch; } else { delete g['fetch']; }
	});
}

suite('unrealTools — bridge 传输层（打包版 CORS 事故回归）', () => {

	test('★★★ 有 IPC ⇒ 走主进程 vscode:webFetch（无 CORS），且请求形态正确', async () => {
		const handlers = registerHandlers();
		const calls: Array<{ ch: string; payload: { url: string; method?: string; headers?: Record<string, string>; body?: string } }> = [];
		await withGlobals(
			async (ch, payload) => {
				calls.push({ ch, payload: payload as never });
				return { ok: true, status: 200, statusText: 'OK', body: JSON.stringify({ status: 'ok', project: 'MyProject' }) };
			},
			undefined,
			async () => {
				const out = await handlers.get('unreal_health')!({});
				const text = textOf(out);
				assert.ok(text.includes('ok') && text.includes('MyProject'), `应返回 bridge 的 JSON 内容，实际：${text.slice(0, 120)}`);
			},
		);
		assert.strictEqual(calls.length, 1, '必须且只调一次 IPC ✗');
		assert.strictEqual(calls[0].ch, 'vscode:webFetch');
		assert.strictEqual(calls[0].payload.url, 'http://127.0.0.1:8765/bridge/health', '默认 bridge 基址 + health 端点 ✗');
		assert.strictEqual(calls[0].payload.method, 'GET', 'health 无 body ⇒ GET ✗');
		assert.strictEqual(calls[0].payload.headers?.['Accept'], 'application/json');
	});

	test('★★★ 400 必须回传「实际发送的参数」+ 纠偏提示（真机：/bridge/find_asset 400）', async () => {
		const handlers = registerHandlers();
		const calls: Array<{ payload: { body?: string } }> = [];
		await withGlobals(
			async (_ch, payload) => {
				calls.push({ payload: payload as never });
				return { ok: false, status: 400, statusText: 'Bad Request', body: '{"error":"no filter supplied"}' };
			},
			undefined,
			async () => {
				const out = await handlers.get('unreal_find_asset')!({ path: '/Game/BP' });
				const text = textOf(out);
				// bridge 原文仍要透出（既有行为 ✓）
				assert.ok(text.includes('no filter supplied'), `bridge 原文应透出，实际：${text.slice(0, 200)}`);
				assert.ok(text.includes('HTTP 400'), '应保留状态码 ✗');
				// ★ 本次新增：把发送的 body 回传（模型据此发现"参数被丢弃"）
				assert.ok(text.includes('/Game/BP'), `应回传实际发送的参数，实际：${text.slice(0, 300)}`);
			},
		);
		assert.strictEqual(calls.length, 1, '应只打一次 bridge ✗');
	});

	test('★★★ 同义键归一方向 = search_term → name_contains（桥端原生名），此前写反 ✗', async () => {
		// ⚠ 本用例此前断言「name_contains 归一到 search_term」——与桥端真实 API 相反 ✗✗：
		// 真机（日志 1790077760068）模型连发两次干净的 `search_term` ⇒ 桥端全部 400
		// 「provide at least one of `name…`」⇒ 桥端只认 name/name_contains/path；
		// 模型读到 400 详情后改用 name_contains（方向自证 ✓）。故归一目标是 name_contains ✓。
		const handlers = registerHandlers();
		const bodies: string[] = [];
		await withGlobals(
			async (_ch, payload) => {
				bodies.push(String((payload as { body?: string }).body ?? ''));
				return { ok: true, status: 200, statusText: 'OK', body: '"[]"' };
			},
			undefined,
			async () => {
				await handlers.get('unreal_find_asset')!({ search_term: 'V1' });
			},
		);
		const sent = JSON.parse(bodies[0] ?? '{}');
		assert.strictEqual(sent.name_contains, 'V1', `search_term 必须映射为桥端认识的 name_contains，实际：${bodies[0]}`);
	});

	test('★★★ POST 工具（unreal_exec）⇒ IPC 带 method=POST + JSON body', async () => {
		const handlers = registerHandlers();
		const calls: Array<{ payload: { method?: string; body?: string } }> = [];
		await withGlobals(
			async (_ch, payload) => { calls.push({ payload: payload as never }); return { ok: true, status: 200, statusText: 'OK', body: '"done"' }; },
			undefined,
			async () => { await handlers.get('unreal_exec')!({ code: 'print(1)', timeout_seconds: 5 }); },
		);
		assert.strictEqual(calls[0].payload.method, 'POST');
		const body = JSON.parse(calls[0].payload.body!);
		assert.strictEqual(body.code, 'print(1)');
		assert.strictEqual(body.timeout_seconds, 5);
	});

	test('★★★ HTTP 错误状态 ⇒ 转成可读失败文案（不抛异常炸掉整轮）', async () => {
		const handlers = registerHandlers();
		let text = '';
		await withGlobals(
			async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', body: '{"error":"boom"}' }),
			undefined,
			async () => { text = textOf(await handlers.get('unreal_health')!({})); },
		);
		assert.ok(text.includes('failed') && text.includes('HTTP 500'), `应含 HTTP 500 失败文案，实际：${text.slice(0, 120)}`);
		assert.ok(text.includes('boom'), 'bridge 的错误体应透出 ✗');
	});

	test('★★ 无 IPC 环境 ⇒ 回退 renderer fetch（纯 web / 测试兜底）', async () => {
		const handlers = registerHandlers();
		let fetchedUrl = '';
		let text = '';
		await withGlobals(
			undefined,
			async (url) => {
				fetchedUrl = url;
				return { status: 200, ok: true, text: async () => '{"status":"ok"}' };
			},
			async () => { text = textOf(await handlers.get('unreal_health')!({})); },
		);
		assert.strictEqual(fetchedUrl, 'http://127.0.0.1:8765/bridge/health', '回退路径应打到同一 URL ✗');
		assert.ok(text.includes('ok'));
	});

	test('★★★ bridge 不可达 ⇒ 给出「开插件/对端口」引导文案（而不是裸 CORS/网络错）', async () => {
		const handlers = registerHandlers();
		let text = '';
		await withGlobals(
			undefined,
			async () => { throw new TypeError('Failed to fetch'); },
			async () => { text = textOf(await handlers.get('unreal_health')!({})); },
		);
		assert.ok(text.includes('cannot reach the Unreal bridge'), `应是不可达文案，实际：${text.slice(0, 120)}`);
		assert.ok(text.includes('BunnySeekAgent'), '必须引导用户开插件 ✗');
	});

	test('★★★ search_term 别名 ⇒ 映射为桥端原生 name_contains（真机：只发 search_term 全部 400）', async () => {
		// 真机（日志 1790077760068）：模型连发两次 `search_term` ⇒ 桥端 400
		// "provide at least one of …"（桥端不认识 search_term ✗）；第三次模型改用
		// `name_contains` 又撞上流式哨兵漏键名。修法：schema 补 name_contains，
		// 且 search_term 在转发时映射为 name_contains ✓。
		const handlers = registerHandlers();
		const calls: Array<{ payload: { body?: string } }> = [];
		await withGlobals(
			async (_ch, payload) => {
				calls.push({ payload: payload as never });
				return { ok: true, status: 200, statusText: 'OK', body: '{"assets":[]}' };
			},
			undefined,
			async () => {
				await handlers.get('unreal_find_asset')!({ search_term: 'Cube', max_results: 5 });
			},
		);
		assert.strictEqual(calls.length, 1);
		const body = JSON.parse(calls[0].payload.body ?? '{}');
		assert.strictEqual(body.name_contains, 'Cube', 'search_term 必须映射为桥端认识的 name_contains ✗✓');
		assert.strictEqual(body.max_results, 5, '其余参数原样透传 ✓');
	});

	test('★★ name_contains（桥端原生）⇒ 原样透传（不被别名逻辑覆盖 ✓）', async () => {
		const handlers = registerHandlers();
		const calls: Array<{ payload: { body?: string } }> = [];
		await withGlobals(
			async (_ch, payload) => {
				calls.push({ payload: payload as never });
				return { ok: true, status: 200, statusText: 'OK', body: '{"assets":[]}' };
			},
			undefined,
			async () => {
				await handlers.get('unreal_find_asset')!({ name_contains: 'Plane', search_term: 'SHOULD_NOT_WIN' });
			},
		);
		const body = JSON.parse(calls[0].payload.body ?? '{}');
		assert.strictEqual(body.name_contains, 'Plane', '显式 name_contains 优先（别名不得覆盖 ✓）');
	});
});
