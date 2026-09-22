/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 渠道 HTTP 出口：主进程适配器（D-12 / CORS 修复的回归测试）──────────────
//
// 背景（2026-09-22 两次实测）：
//   ① 直接在 renderer 用 fetch 调飞书 OpenAPI → CORS 预检被拦（origin
//      `vscode-file://vscode-app`，飞书不返回 Access-Control-Allow-Origin）
//      ⇒ `feishu.ts ... net::ERR_FAILED`。
//   ② 改用 DI 注入的 `IRequestService` 后**仍然被拦** —— 桌面端注册的是
//      `NativeRequestService`，其 `request()` 就是 `requestImpl.ts` 的 `fetch`，
//      仍在 renderer 网络栈里（栈证据：`requestImpl.ts:33 → net::ERR_FAILED`）。
//
// 正解：主进程出口 —— `VSSAROS_LLM_CHANNEL` 的 `httpRequest`
// （`electron-main/llmMainChannel.ts` → `node/llmBridgeNode.ts#httpRequest`）。
// 本文件锁定 `browser/mainProcessRequestService.ts` 这层适配器 + 与 FeishuPlatform 的接线。
//
// ★ 纯 node 运行（分片 worker 不装 DOM stub）：只 stub `IMainProcessService`，不碰 document。

import assert from 'assert';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import type { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import type { IRequestService } from '../../../../../platform/request/common/request.js';
import { createMainProcessRequestService } from '../../browser/mainProcessRequestService.js';
import { FeishuPlatform } from '../../browser/bridge/platforms/feishu.js';
import { VSSAROS_LLM_CHANNEL } from '../../common/llmBridge.js';

const flush = (ms = 10): Promise<void> => new Promise<void>(r => setTimeout(r, ms));

/** 飞书长连接换地址端点（官方 `const.py#GEN_ENDPOINT_URI`，与 feishu.ts 内部一致）。 */
const WS_ENDPOINT_PATH = '/callback/ws/endpoint';
const TOKEN_PATH = '/auth/v3/tenant_access_token/internal';

// ─── stub：IMainProcessService + channel ────────────────────────────────────

interface RecordedCall {
	channel: string;
	command: string;
	params: any;
	token?: unknown;
}

/**
 * 造一个只实现 `getChannel` 的 `IMainProcessService`。
 * @param reply   channel.call 的应答（默认返回 HTTP 200 + `{"code":0}`）
 * @param opts.throwOnGetChannel 模拟通道未注册/连接不可用
 * @param opts.noChannel 模拟 getChannel 返回 undefined
 */
function makeMainProcess(
	reply: (params: any) => any = () => ({ ok: true, status: 200, statusText: 'OK', body: '{"code":0}' }),
	opts: { throwOnGetChannel?: boolean; noChannel?: boolean } = {},
): { svc: IMainProcessService; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const svc = {
		getChannel(channelName: string) {
			if (opts.throwOnGetChannel) {
				throw new Error(`Channel not available: ${channelName}`);
			}
			if (opts.noChannel) {
				return undefined;
			}
			return {
				call: async (command: string, params: any, token?: unknown) => {
					calls.push({ channel: channelName, command, params, token });
					const body = reply(params);
					if (body instanceof Error) {
						throw body;
					}
					return body;
				},
				listen: () => { throw new Error('unused'); },
			};
		},
	} as unknown as IMainProcessService;
	return { svc, calls };
}

/** 读回适配器包出的 body 文本（与 core 的 requestImpl / RequestChannelClient 同形）。 */
async function readText(ctx: IRequestContext): Promise<string> {
	return (await streamToBuffer(ctx.stream)).toString();
}

function requestOptions(overrides: Partial<IRequestOptions> = {}): IRequestOptions {
	return { url: 'https://open.feishu.cn/open-apis/x', type: 'POST', callSite: 'test', ...overrides };
}

// ══════════════════════════════════════════════════════════════════════════
// 1) 适配器契约：IRequestService 形状 → channel httpRequest
// ══════════════════════════════════════════════════════════════════════════

suite('渠道 HTTP 出口 · 主进程适配器', () => {
	test('主进程服务缺失 / 通道不可用 → 返回 undefined（调用方回退，装配不炸）', () => {
		assert.strictEqual(createMainProcessRequestService(undefined), undefined);
		assert.strictEqual(createMainProcessRequestService(makeMainProcess(undefined, { throwOnGetChannel: true }).svc), undefined);
		assert.strictEqual(createMainProcessRequestService(makeMainProcess(undefined, { noChannel: true }).svc), undefined);
	});

	test('有通道 → 返回对象，走 VSSAROS_LLM_CHANNEL', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc);
		assert.ok(svc, '应返回适配器');
		await (svc as IRequestService).request(requestOptions(), CancellationToken.None);
		assert.strictEqual(mp.calls.length, 1);
		assert.strictEqual(mp.calls[0].channel, VSSAROS_LLM_CHANNEL);
		assert.strictEqual(mp.calls[0].command, 'httpRequest');
	});

	test('请求参数完整透传：url / method / headers / body / 默认超时', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;
		await svc.request(requestOptions({
			url: `${'https://open.feishu.cn/open-apis'}${TOKEN_PATH}`,
			type: 'POST',
			headers: { 'Content-Type': 'application/json' },
			data: '{"app_id":"cli_x"}',
		}), CancellationToken.None);

		const p = mp.calls[0].params;
		assert.strictEqual(p.url, `https://open.feishu.cn/open-apis${TOKEN_PATH}`);
		assert.strictEqual(p.method, 'POST');
		assert.strictEqual(p.headers['Content-Type'], 'application/json');
		assert.strictEqual(p.body, '{"app_id":"cli_x"}', 'POST body 必须转发（否则飞书收不到 app_id/app_secret）');
		assert.strictEqual(p.timeoutMs, 15_000, '未指定 timeout 时用 15s 默认值');
	});

	test('显式 timeout 覆盖默认值；method 缺省为 GET', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;
		await svc.request(requestOptions({ type: undefined, timeout: 3_000 }), CancellationToken.None);
		assert.strictEqual(mp.calls[0].params.method, 'GET');
		assert.strictEqual(mp.calls[0].params.timeoutMs, 3_000);
	});

	test('响应映射：statusCode + body 文本回流（形状与 core 实现一致）', async () => {
		const mp = makeMainProcess((params) => ({
			ok: true,
			status: params.url.includes('/ok') ? 200 : 502,
			statusText: 'x',
			body: '{"code":0,"tenant_access_token":"t"}',
		}));
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;

		const ok = await svc.request(requestOptions({ url: 'https://x/ok' }), CancellationToken.None);
		assert.strictEqual(ok.res.statusCode, 200);
		assert.strictEqual(await readText(ok), '{"code":0,"tenant_access_token":"t"}');

		// 非 2xx 原样透出（由调用方按飞书返回码判定），适配器不吞成异常
		const bad = await svc.request(requestOptions({ url: 'https://x/bad' }), CancellationToken.None);
		assert.strictEqual(bad.res.statusCode, 502);
	});

	test('body 缺失（如 GET）不塞进参数；网络层异常向上抛', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;
		await svc.request(requestOptions({ data: undefined }), CancellationToken.None);
		assert.strictEqual(mp.calls[0].params.body, undefined);

		const mp2 = makeMainProcess(() => new Error('fetch failed'));
		const svc2 = createMainProcessRequestService(mp2.svc) as IRequestService;
		await assert.rejects(() => svc2.request(requestOptions(), CancellationToken.None), /fetch failed/);
	});

	test('请求头净化：content-length/host 等由网络栈管理的头不透传，数组头合并', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;
		await svc.request(requestOptions({
			headers: {
				'Authorization': 'Bearer t',
				'Content-Type': 'application/json',
				'content-length': '99',
				'Host': 'evil.example',
				'X-Multi': ['a', 'b'],
			},
		}), CancellationToken.None);

		const h = mp.calls[0].params.headers;
		assert.strictEqual(h['Authorization'], 'Bearer t');
		assert.strictEqual(h['Content-Type'], 'application/json');
		assert.strictEqual(h['content-length'], undefined, 'content-length 必须被剔除');
		assert.strictEqual(h['Host'], undefined, 'host 必须被剔除');
		assert.strictEqual(h['X-Multi'], 'a, b', '数组头应合并为逗号分隔');
	});

	test('取消令牌透传给 channel（遵守 core 的 call 约定）', async () => {
		const mp = makeMainProcess();
		const svc = createMainProcessRequestService(mp.svc) as IRequestService;
		// CancellationToken 在运行时是 interface + namespace（无构造函数），这里造一个实现。
		const token: CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() { /* noop */ } }),
		};
		await svc.request(requestOptions(), token);
		assert.strictEqual(mp.calls[0].token, token);
	});

	test('代理/鉴权/证书类能力返回空值（本通道不提供，渠道代码未使用）', async () => {
		const svc = createMainProcessRequestService(makeMainProcess().svc) as IRequestService;
		assert.strictEqual(await svc.resolveProxy('https://x'), undefined);
		assert.strictEqual(await svc.lookupAuthorization({ isProxy: false, scheme: 'basic', host: 'h', port: 0, realm: '', attempt: 1 }), undefined);
		assert.strictEqual(await svc.lookupKerberosAuthorization('https://x'), undefined);
		assert.deepStrictEqual(await svc.loadCertificates(), []);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 2) 接线：FeishuPlatform 经适配器发请求（不再落回 renderer fetch）
// ══════════════════════════════════════════════════════════════════════════

suite('渠道 HTTP 出口 · FeishuPlatform 接线', () => {
	test('出站 REST 经主进程：token + send 两次 call，渲染进程 fetch 不参与', async () => {
		const originalFetch = (globalThis as any).fetch;
		let fetchCalls = 0;
		(globalThis as any).fetch = async () => { fetchCalls++; throw new Error('[断言失败] 不应走渲染进程 fetch'); };

		const mp = makeMainProcess((params) => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			body: params.url.includes(TOKEN_PATH)
				? '{"code":0,"tenant_access_token":"tok-1","expire":7200}'
				: '{"code":0}',
		}));
		try {
			const platform = new FeishuPlatform({
				appId: 'cli_x',
				appSecret: 'sec_x',
				requestService: createMainProcessRequestService(mp.svc),
			});
			await platform.send({ sessionKey: 's', replyCtx: { chatId: 'oc_1' } }, 'hi');

			assert.strictEqual(fetchCalls, 0, '不得回落到渲染进程 fetch');
			assert.strictEqual(mp.calls.length, 2, 'tenant_access_token + im/v1/messages');
			assert.ok(mp.calls[0].params.url.includes(TOKEN_PATH));
			assert.ok(mp.calls[1].params.url.includes('/im/v1/messages'));
			assert.strictEqual(mp.calls[1].params.headers.Authorization, 'Bearer tok-1');
			assert.strictEqual(
				JSON.parse(mp.calls[1].params.body).content,
				JSON.stringify({ text: 'hi' }),
				'出站消息体必须经主进程发出',
			);
		} finally {
			(globalThis as any).fetch = originalFetch;
		}
	});

	test('长连接订阅经主进程（本次故障的实际调用点），返回的 wss 地址用于建连', async () => {
		const originalFetch = (globalThis as any).fetch;
		const originalWs = (globalThis as any).WebSocket;
		let fetchCalls = 0;
		(globalThis as any).fetch = async () => { fetchCalls++; throw new Error('[断言失败] 不应走渲染进程 fetch'); };

		class FakeWebSocket {
			static readonly instances: FakeWebSocket[] = [];
			onmessage: ((ev: any) => void) | undefined;
			onerror: (() => void) | undefined;
			onclose: (() => void) | undefined;
			closed = false;
			constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
			close(): void { this.closed = true; }
			send(): void { /* noop */ }
		}
		(globalThis as any).WebSocket = FakeWebSocket;

		const mp = makeMainProcess(() => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			body: '{"code":0,"msg":"success","data":{"URL":"wss://open.feishu.cn/ws?device_id=d&service_id=1","ClientConfig":{"PingInterval":120}}}',
		}));
		try {
			const platform = new FeishuPlatform({
				appId: 'cli_x',
				appSecret: 'sec_x',
				useWs: true,
				requestService: createMainProcessRequestService(mp.svc),
			});
			platform.start(() => { /* noop */ });
			await flush();

			assert.strictEqual(fetchCalls, 0, '换地址请求不得走渲染进程 fetch（CORS 拦截点）');
			assert.strictEqual(mp.calls.length, 1);
			// 完整 URL：域名根 + 官方路径（不是 /open-apis 下）
			assert.strictEqual(mp.calls[0].params.url, `https://open.feishu.cn${WS_ENDPOINT_PATH}`);
			assert.strictEqual(mp.calls[0].params.method, 'POST');
			assert.strictEqual(JSON.parse(mp.calls[0].params.body).AppID, 'cli_x', 'AppID/AppSecret 必须随 POST body 送达（官方 PascalCase）');
			assert.strictEqual(FakeWebSocket.instances.length, 1, '拿到 wss 地址后建连');
			assert.strictEqual(FakeWebSocket.instances[0].url, 'wss://open.feishu.cn/ws?device_id=d&service_id=1');
			assert.strictEqual(platform.lastError, undefined);
		} finally {
			(globalThis as any).fetch = originalFetch;
			(globalThis as any).WebSocket = originalWs;
		}
	});

	test('主进程通道不可用 → 适配器返回 undefined，平台回落 fetch（非 Electron 宿主的明确边界）', async () => {
		let fetchCalls = 0;
		const originalFetch = (globalThis as any).fetch;
		(globalThis as any).fetch = async (url: string) => {
			fetchCalls++;
			// token 接口必须回带 tenant_access_token，否则 _ensureToken 直接抛错
			const text = String(url).includes(TOKEN_PATH)
				? '{"code":0,"tenant_access_token":"tok","expire":7200}'
				: '{"code":0}';
			return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
		};
		try {
			const svc = createMainProcessRequestService(makeMainProcess(undefined, { throwOnGetChannel: true }).svc);
			assert.strictEqual(svc, undefined);
			const platform = new FeishuPlatform({ appId: 'a', appSecret: 'b' });
			await platform.reply({ sessionKey: 's', replyCtx: { messageId: 'm1' } }, 'x');
			assert.strictEqual(fetchCalls, 2, 'token + reply 走 renderer fetch');
		} finally {
			(globalThis as any).fetch = originalFetch;
		}
	});
});
