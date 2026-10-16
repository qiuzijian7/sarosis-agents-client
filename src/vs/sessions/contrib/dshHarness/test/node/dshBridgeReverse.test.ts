/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 控制桥**反向通道**（Host → IDE，协议 v2）的 IDE 侧分发器测试。
 *
 * 为什么要有这个文件：反向通道能让 Host 驱动 IDE（`@vssaros/dsh-ide` 的 `ide.request`），
 * 而 v1 的老毛病是"`id` 不在 `_pending` 里的消息被静默丢弃"——**静默丢弃**这类故障在真机上
 * 只会表现为 Host 侧超时，极难定位。所以这里用一对**真管道**把协议行为钉死：
 * 负 id 识别、令牌核验、默认拒绝、内建 `ide.echo`、能力名白名单、处理器结果/异常、
 * 以及与客户端自己 pending 调用的 id 空间互不干扰。
 *
 * 不依赖 dsh 运行时（只跑 VsSaros 侧客户端 + 一个假 Host）。
 */

import assert from 'assert';
import * as net from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshBridgeReverseMethod } from '../../common/dshBridgeProtocol.js';
import { DshBridgeClient } from '../../electron-main/dshBridgeClient.js';

const TOKEN = 'probe-token-123';
const HELLO = {
	bridgeVersion: 2,
	pluginVersion: '0.0.0-test',
	node: process.version,
	pid: process.pid,
	host: { port: 1, bind: '127.0.0.1', origin: 'http://127.0.0.1:1', authUrl: 'http://127.0.0.1:1/?token=x' },
};

interface IFakeHost {
	readonly port: number;
	/**
	 * 等客户端连接被 accept。
	 * **必须先 await 再 send**：`net.Server` 的 accept 与客户端 connect 完成是两个事件，
	 * 直接 send 会在 `socket` 还没赋值时被**静默丢弃**（这个坑在测试里真踩过一次）。
	 */
	ready(): Promise<void>;
	/** 发给客户端（模拟 Host 发起反向请求或回响应）。 */
	send(message: unknown): void;
	/** 等一条**来自客户端**的消息（默认忽略心跳）。 */
	next(timeoutMs?: number): Promise<Record<string, unknown>>;
	/** 已收到的全部消息。 */
	readonly received: readonly Record<string, unknown>[];
	close(): Promise<void>;
}

/** 假 Host：在管道上监听，收客户端的行、也能主动发（反向请求）。 */
function startFakeHost(pipePath: string): Promise<IFakeHost> {
	return new Promise((resolve, reject) => {
		let socket: net.Socket | undefined;
		let buf = '';
		let acceptResolve: (() => void) | undefined;
		const accepted = new Promise<void>(resolveAccept => { acceptResolve = resolveAccept; });
		const received: Record<string, unknown>[] = [];
		const waiters: ((message: Record<string, unknown>) => void)[] = [];
		const server = net.createServer(s => {
			socket = s;
			acceptResolve?.();
			s.setEncoding('utf8');
			// 客户端 dispose 后我们再写会触发写错误：测试里忽略（正是"清理"那条用例要观察的行为）
			s.on('error', () => { /* ignore */ });
			s.on('data', (chunk: string) => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) {
						continue;
					}
					const message = JSON.parse(line) as Record<string, unknown>;
					received.push(message);
					waiters.shift()?.(message);
				}
			});
		});
		server.once('error', reject);
		server.listen(pipePath, () => resolve({
			port: (server.address() as net.AddressInfo).port,
			received,
			ready: () => accepted,
			send: message => {
				try {
					socket?.write(`${JSON.stringify(message)}\n`);
				} catch {
					/* 对端已关闭：忽略 */
				}
			},
			next: (timeoutMs = 3000) => new Promise<Record<string, unknown>>((resolveNext, rejectNext) => {
				const timer = setTimeout(() => rejectNext(new Error(`假 Host 等消息超时（${timeoutMs}ms）；已收到 ${received.length} 条`)), timeoutMs);
				waiters.push(message => {
					clearTimeout(timer);
					resolveNext(message);
				});
			}),
			close: () => new Promise<void>(done => {
				socket?.destroy();
				server.close(() => done());
			}),
		}));
	});
}

suite('dshHarness / bridge reverse channel (protocol v2)', () => {

	const tmp = mkdtempSync(join(tmpdir(), 'dsh-bridge-reverse-'));
	let counter = 0;
	const newPipe = () => (process.platform === 'win32'
		? 	`\\\\.\\pipe\\vssaros-bridge-test-${process.pid}-${++counter}`
		: join(tmp, `bridge-${process.pid}-${++counter}.sock`));

	suiteTeardown(() => rmSync(tmp, { recursive: true, force: true }));

	/** 起一对（假 Host + 已注册客户端）；`register=false` 时不注册。 */
	async function pair({ register = true } = {}) {
		const pipe = newPipe();
		const host = await startFakeHost(pipe);
		const client = await DshBridgeClient.connect(pipe, 5000);
		await host.ready();   // 没这一步，未注册的 pair 里 send 会被静默丢弃
		if (register) {
			const pending = client.register({ token: TOKEN, instanceId: 'test-ide' });
			const request = await host.next();
			assert.strictEqual(request.method, 'client.register');
			host.send({ jsonrpc: '2.0', id: request.id, result: HELLO });
			await pending;
		}
		return { host, client, pipe };
	}

	test('反向请求按负数 id 识别：内建 ide.echo 回显（未接任何能力即可验收通道）', async () => {
		const { host, client } = await pair();
		try {
			host.send({ jsonrpc: '2.0', id: -1, method: DshBridgeReverseMethod.IdeEcho, params: { token: TOKEN, at: 42 } });
			const response = await host.next();
			assert.strictEqual(response.id, -1, '响应必须回同一个负数 id');
			const result = response.result as { ok: boolean; echo: Record<string, unknown>; instanceId: string };
			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.echo.at, 42, '回显应原样带回入参');
			assert.strictEqual(result.instanceId, 'test-ide', '回执应带上注册时声明的实例 id');
		} finally {
			client.dispose();
			await host.close();
		}
	});

	test('令牌核验：错令牌 → -32002', async () => {
		const { host, client } = await pair();
		try {
			host.send({ jsonrpc: '2.0', id: -2, method: DshBridgeReverseMethod.IdeEcho, params: { token: 'wrong' } });
			const badToken = await host.next();
			assert.strictEqual((badToken.error as { code: number }).code, -32002, `实际收到：${JSON.stringify(badToken).slice(0, 200)}`);
		} finally {
			client.dispose();
			await host.close();
		}
	});

	test('令牌核验：没 register 过就收到反向请求 → -32001（默认拒绝）', async () => {
		const second = await pair({ register: false });
		try {
			second.host.send({ jsonrpc: '2.0', id: -3, method: DshBridgeReverseMethod.IdeEcho, params: { token: TOKEN } });
			const notRegistered = await second.host.next();
			assert.strictEqual((notRegistered.error as { code: number }).code, -32001, `实际收到：${JSON.stringify(notRegistered).slice(0, 200)}`);
		} finally {
			second.client.dispose();
			await second.host.close();
		}
	});

	test('默认拒绝：没注册处理器时未知方法 → -32601；ide.request 的未知能力也 → -32601', async () => {
		const { host, client } = await pair();
		try {
			host.send({ jsonrpc: '2.0', id: -4, method: 'ide.does-not-exist', params: { token: TOKEN } });
			const unknown = await host.next();
			assert.strictEqual((unknown.error as { code: number }).code, -32601);

			// 能力名必须落在清单那份白名单里（样本用 `teleport`：mindmap / unreal 自 v1.2.12 起已登记）
			host.send({ jsonrpc: '2.0', id: -5, method: DshBridgeReverseMethod.IdeRequest, params: { token: TOKEN, capability: 'teleport' } });
			const badCapability = await host.next();
			assert.strictEqual((badCapability.error as { code: number }).code, -32601);
			assert.match((badCapability.error as { message: string }).message, /未知的 IDE 能力：teleport/);
		} finally {
			client.dispose();
			await host.close();
		}
	});

	test('处理器：合法能力交给处理器（结果回传）；处理器抛错 → -32000 + message', async () => {
		const { host, client } = await pair();
		try {
			const seen: string[] = [];
			client.onDidReceiveReverseRequest(request => seen.push(request.method));
			client.setReverseRequestHandler(request => {
				if (request.method === DshBridgeReverseMethod.IdeRequest) {
					if (request.params.capability === 'showDiff') {
						throw new Error('用户取消了 diff');
					}
					return { capability: request.params.capability, from: 'handler' };
				}
				return { from: 'handler' };
			});

			host.send({ jsonrpc: '2.0', id: -6, method: DshBridgeReverseMethod.IdeRequest, params: { token: TOKEN, capability: 'getSelection' } });
			const ok = await host.next();
			assert.deepStrictEqual(ok.result, { capability: 'getSelection', from: 'handler' });

			host.send({ jsonrpc: '2.0', id: -7, method: DshBridgeReverseMethod.IdeRequest, params: { token: TOKEN, capability: 'showDiff' } });
			const failed = await host.next();
			assert.strictEqual((failed.error as { code: number }).code, -32000);
			assert.match((failed.error as { message: string }).message, /用户取消了 diff/);

			assert.deepStrictEqual(seen, [DshBridgeReverseMethod.IdeRequest, DshBridgeReverseMethod.IdeRequest], '每次反向请求都应触发事件');
		} finally {
			client.dispose();
			await host.close();
		}
	});

	test('id 空间互不干扰：反向请求在途时，客户端自己的调用照常拿到结果', async () => {
		const { host, client } = await pair();
		try {
			// 一个**永不回复**的反向请求：它不能拖住客户端自己的 pending 调用
			host.send({ jsonrpc: '2.0', id: -8, method: 'ide.never-answers', params: { token: TOKEN } });
			const pending = client.call<{ ok: boolean }>('host.ping', {});
			const request = await host.next();
			assert.strictEqual(request.method, 'host.ping');
			assert.ok(typeof request.id === 'number' && (request.id as number) > 0, '客户端自己发起的调用用正数 id');
			host.send({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
			assert.deepStrictEqual(await pending, { ok: true });
		} finally {
			client.dispose();
			await host.close();
		}
	});

	test('清理：dispose 后不再回写（不往已关闭的 socket 写）', async () => {
		const { host, client } = await pair();
		client.dispose();
		host.send({ jsonrpc: '2.0', id: -9, method: DshBridgeReverseMethod.IdeEcho, params: { token: TOKEN } });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(host.received.filter(message => message.id === -9).length, 0, '客户端只收到请求、不应再回任何东西');
		await host.close();
	});
});
