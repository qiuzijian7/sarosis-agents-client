/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── TelegramPlatform 单测（入站解析 / 出站出口 / 卡片转换 / 装配）──
//
// ★ 2026-09-22 重构（D-14）：
//   ① 新增「出站经主进程出口」契约：实测 api.telegram.org 的 `POST /sendMessage`
//      （Content-Type: application/json）需要 OPTIONS 预检而它不支持 ⇒ renderer 直连必 `Failed to fetch`，
//      症状是「机器人能收消息但永不回话」。用「一旦被调用即抛错的 fetch」把出口钉死。
//   ② 修掉本文件原有的**真实网络空转**：旧 `makePlatform()` 直接 start() 轮询，
//      而当时 401 返回 `[]` ⇒ while 循环无退避地猛拉 api.telegram.org。
//      现在所有用例都先装 fetch stub（挂起型），并在 suiteTeardown 里 stop() + 还原。
//      `delete globalThis.fetch` 的旧写法也一并改掉（那会污染同分片后续测试文件）。

import assert from 'assert';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import type { IRequestService } from '../../../../../platform/request/common/request.js';
import { TelegramPlatform } from '../../browser/bridge/platforms/telegram.js';
import { registerTelegramPlatformIfConfigured } from '../../browser/bridge/platforms/telegram.contribution.js';
import { BridgeCard } from '../../common/bridge/bridgeTypes.js';

const flush = (ms = 10): Promise<void> => new Promise<void>(r => setTimeout(r, ms));

// ─── stub ─────────────────────────────────────────────────────────────────

interface RecordedCall { url: string; init: any }

/** 替换 globalThis.fetch；router 返回对象 → 包成 Response 形状；返回 Error → 抛出。 */
function stubFetch(router: (url: string, init: any) => any): { calls: RecordedCall[]; restore: () => void } {
	const g = globalThis as any;
	const original = g.fetch;
	const calls: RecordedCall[] = [];
	g.fetch = async (url: string, init?: any) => {
		calls.push({ url: String(url), init });
		const body = await router(String(url), init);
		if (body instanceof Error) {
			throw body;
		}
		return {
			ok: true,
			status: 200,
			json: async () => body,
			text: async () => JSON.stringify(body),
		};
	};
	return { calls, restore: () => { g.fetch = original; } };
}

/** 挂起型 fetch：让轮询循环停在「等待长轮询」，永不触网。 */
function stubPendingFetch(): { calls: RecordedCall[]; restore: () => void } {
	return stubFetch(() => new Promise(() => { /* 永不结算，模拟 30s 长轮询挂起 */ }));
}

/** IRequestService 形状的主进程出口 stub。 */
function makeHttpExit(
	handler: (url: string, body: string) => { status?: number; body: string },
): { svc: IRequestService; calls: Array<{ url: string; body: string; headers: Record<string, string>; callSite?: string }> } {
	const calls: Array<{ url: string; body: string; headers: Record<string, string>; callSite?: string }> = [];
	const svc = {
		request: async (options: any) => {
			const data = typeof options.data === 'string' ? options.data : String(options.data ?? '');
			calls.push({ url: options.url, body: data, headers: options.headers ?? {}, callSite: options.callSite });
			const r = handler(options.url, data);
			return {
				res: { statusCode: r.status ?? 200, headers: {} },
				stream: bufferToStream(VSBuffer.fromString(r.body)),
			};
		},
	} as unknown as IRequestService;
	return { svc, calls };
}

/** 「一旦被调用即抛错」的 fetch，用于证明不再回落 renderer。 */
function forbiddenFetch(): { calls: RecordedCall[]; restore: () => void } {
	return stubFetch(() => new Error('[断言失败] 不应走渲染进程 fetch（POST 会被 CORS 预检拦死）'));
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const proc: any = (globalThis as any).process;
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = proc.env[k];
		if (vars[k] === undefined) { delete proc.env[k]; } else { proc.env[k] = vars[k]; }
	}
	try {
		fn();
	} finally {
		for (const k of Object.keys(vars)) {
			if (saved[k] === undefined) { delete proc.env[k]; } else { proc.env[k] = saved[k]; }
		}
	}
}

/** 记录 registerPlatform 的假 IBridgeService。 */
function makeFakeBridge(): { registered: Array<{ id: string; create: () => TelegramPlatform }>; bridge: any } {
	const registered: Array<{ id: string; create: () => TelegramPlatform }> = [];
	return {
		registered,
		bridge: {
			registerPlatform: (def: { id: string; create: () => TelegramPlatform }) => {
				registered.push(def);
				return { dispose() { /* noop */ } };
			},
			start: async () => { /* noop */ },
		},
	};
}

const TEXT_UPDATE = {
	update_id: 100,
	message: {
		message_id: 42,
		chat: { id: 7, type: 'private', username: 'alice_chat' },
		from: { id: 99, username: 'alice', first_name: 'Alice' },
		text: 'hello agent',
	},
};

// ══════════════════════════════════════════════════════════════════════════
// 入站解析
// ══════════════════════════════════════════════════════════════════════════

suite('TelegramPlatform inbound', () => {
	let pending: { restore: () => void } | undefined;
	const created: TelegramPlatform[] = [];

	/** 建平台并 start（轮询被挂起型 fetch 挡在等待态，绝不触网）。 */
	function makePlatform(log?: (m: string) => void): { p: TelegramPlatform; received: any[] } {
		pending?.restore();
		pending = stubPendingFetch();
		const p = new TelegramPlatform({ botToken: 'TEST_TOKEN', log });
		const received: any[] = [];
		p.start((msg: any) => received.push(msg));
		created.push(p);
		return { p, received };
	}

	suiteTeardown(() => {
		for (const p of created) {
			p.stop();
		}
		pending?.restore();
	});

	test('parses message update into InboundMessage', () => {
		const { p, received } = makePlatform();
		p.handleUpdate(TEXT_UPDATE);
		assert.strictEqual(received.length, 1);
		const m = received[0];
		assert.strictEqual(m.sessionKey, 'telegram:7:99');
		assert.strictEqual(m.platform, 'telegram');
		assert.strictEqual(m.userId, '99');
		assert.strictEqual(m.userName, 'alice');
		assert.strictEqual(m.content, 'hello agent');
		assert.deepStrictEqual(m.replyCtx, { chatId: 7, messageId: 42 });
	});

	test('marks callback_query as permission response', () => {
		const { p, received } = makePlatform();
		p.handleUpdate({
			update_id: 200,
			callback_query: {
				id: 'cb1',
				data: 'cmd:/new',
				message: { message_id: 10, chat: { id: 7, username: 'alice_chat' } },
				from: { id: 99, username: 'alice', first_name: 'Alice' },
			},
		});
		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0].content, 'cmd:/new');
		assert.strictEqual(received[0].isPermissionResponse, true);
	});

	test('collects photo attachment placeholder', () => {
		const { p, received } = makePlatform();
		p.handleUpdate({
			update_id: 300,
			message: {
				message_id: 1,
				chat: { id: 7 },
				from: { id: 99 },
				photo: [{ file_id: 'PHOTO1', width: 100, height: 100 }],
				caption: 'a pic',
			},
		});
		assert.ok(received[0].files && received[0].files.length === 1);
		assert.strictEqual(received[0].files[0].mimeType, 'image/jpeg');
	});

	test('附件下载失败 → 保留占位附件（data 为空），不抛错', async () => {
		// getUpdates 挂起（不触网、不产生失败日志），getFile 返回 ok:false
		const f = stubFetch(async (url) => {
			if (url.includes('/getUpdates')) {
				return new Promise(() => { /* 挂起 */ });
			}
			if (url.includes('/getFile')) {
				return { ok: false, description: 'file not found' };
			}
			throw new Error(`unexpected ${url}`);
		});
		const logs: string[] = [];
		try {
			const p = new TelegramPlatform({ botToken: 'T', log: m => logs.push(m) });
			const received: any[] = [];
			p.start(m => received.push(m));
			p.handleUpdate({
				update_id: 301,
				message: { message_id: 2, chat: { id: 7 }, from: { id: 99 }, document: { file_id: 'DOC1' } },
			});
			await flush(20);
			assert.strictEqual(received[0].files.length, 1);
			assert.strictEqual((received[0].files[0].data as Uint8Array).length, 0, '下载失败应保留空字节占位');
			p.stop();
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 入站长轮询：可诊断 / 可中断 / offset 前进
// ══════════════════════════════════════════════════════════════════════════

suite('TelegramPlatform · 长轮询（offset / 失败可诊断 / stop 可中断）', () => {
	test('拉取更新：GET 带 offset+timeout，update 路由后 offset 前进', async () => {
		let served = 0;
		const f = stubFetch(async (url) => {
			served++;
			if (served === 1) {
				return { ok: true, result: [TEXT_UPDATE] };
			}
			await flush(30); // 模拟长轮询挂起，避免空转
			return { ok: true, result: [] };
		});
		try {
			const p = new TelegramPlatform({ botToken: 'T', pollTimeout: 30 });
			const received: any[] = [];
			p.start(m => received.push(m));
			await flush(20);

			assert.strictEqual(received.length, 1);
			assert.ok(f.calls[0].url.includes('/getUpdates?offset=0&timeout=30'), f.calls[0].url);
			assert.ok(f.calls[0].url.includes('allowed_updates='));
			// 消费 update_id=100 → 下一次 offset=101
			await flush(40);
			assert.ok(f.calls.some(c => c.url.includes('offset=101')), 'offset 应前进到 101');
			assert.strictEqual(p.lastError, undefined);
			p.stop();
		} finally {
			f.restore();
		}
	});

	test('轮询失败 → lastError 可读 + 落日志（不再静默）；恢复后清空', async () => {
		let fail = true;
		const f = stubFetch(async () => {
			if (fail) {
				return new Error('network down');
			}
			await flush(30);
			return { ok: true, result: [] };
		});
		const logs: string[] = [];
		try {
			const p = new TelegramPlatform({ botToken: 'T', log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush(20);

			assert.ok(p.lastError?.includes('network down'), `lastError 应可诊断：${p.lastError}`);
			assert.ok(logs.some(l => l.includes('getUpdates 失败')), logs.join(' | '));

			fail = false;
			await flush(2_100); // 越过 2s 退避
			assert.strictEqual(p.lastError, undefined, '恢复后应清空 lastError');
			p.stop();
		} finally {
			f.restore();
		}
	});

	test('ok=false / result 非数组 → 视为失败（不再静默返回空更新）', async () => {
		const f = stubFetch(async () => ({ ok: false, description: 'Unauthorized' }));
		const logs: string[] = [];
		try {
			const p = new TelegramPlatform({ botToken: 'bad', log: m => logs.push(m) });
			p.start(() => { /* noop */ });
			await flush(20);

			assert.ok(p.lastError?.includes('Unauthorized'), `应带 Telegram 的 description：${p.lastError}`);
			assert.ok(logs.length > 0);
			p.stop();
		} finally {
			f.restore();
		}
	});

	test('stop() 停止轮询：不再发起新的 getUpdates', async () => {
		const f = stubFetch(async () => {
			await flush(10);
			return { ok: true, result: [] };
		});
		try {
			const p = new TelegramPlatform({ botToken: 'T' });
			p.start(() => { /* noop */ });
			await flush(25);
			assert.ok(f.calls.length >= 1);
			p.stop();
			const after = f.calls.length;
			await flush(60);
			assert.strictEqual(f.calls.length, after, 'stop() 后不应再轮询');
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 出站：主进程出口（D-14）+ 卡片 → 内联键盘
// ══════════════════════════════════════════════════════════════════════════

suite('TelegramPlatform · 出站经主进程出口（D-14）', () => {
	const card: BridgeCard = {
		header: { title: 'Choose' },
		elements: [
			{ kind: 'markdown', content: 'Pick one:' },
			{
				kind: 'actions',
				buttons: [
					{ text: 'New', value: 'cmd:/new' },
					{ text: 'Stop', value: 'cmd:/stop' },
				],
			},
		],
	};

	test('sendCard/reply 的 POST 全部经出口；renderer fetch 完全不参与', async () => {
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ body: JSON.stringify({ ok: true }) }));
		try {
			const p = new TelegramPlatform({ botToken: 'T', requestService: exit.svc, callSite: 'telegramTest' });
			await p.sendCard({ sessionKey: 'telegram:7:99', replyCtx: { chatId: 7, messageId: 1 } }, card);

			assert.strictEqual(f.calls.length, 0, '不得回落渲染进程 fetch');
			assert.strictEqual(exit.calls.length, 1);
			assert.ok(exit.calls[0].url.endsWith('/sendMessage'));
			assert.strictEqual(exit.calls[0].headers['Content-Type'], 'application/json');
			assert.strictEqual(exit.calls[0].callSite, 'telegramTest');

			const body = JSON.parse(exit.calls[0].body);
			assert.strictEqual(body.chat_id, 7);
			assert.strictEqual(body.reply_to_message_id, 1);
			assert.strictEqual(body.parse_mode, 'Markdown');
			const kb = body.reply_markup.inline_keyboard;
			assert.strictEqual(kb.length, 1);
			assert.strictEqual(kb[0][0].text, 'New');
			assert.strictEqual(kb[0][0].callback_data, 'cmd:/new');
			assert.strictEqual(kb[0][1].text, 'Stop');
		} finally {
			f.restore();
		}
	});

	test('sendWithButtons 的按钮矩阵经出口透传', async () => {
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ body: JSON.stringify({ ok: true }) }));
		try {
			const p = new TelegramPlatform({ botToken: 'T', requestService: exit.svc });
			await p.sendWithButtons({ sessionKey: 's', replyCtx: { chatId: 1, messageId: 2 } }, 'pick', [
				[{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
				[{ text: 'C', value: 'c' }],
			]);
			const kb = JSON.parse(exit.calls[0].body).reply_markup.inline_keyboard;
			assert.strictEqual(kb.length, 2);
			assert.strictEqual(kb[1][0].text, 'C');
		} finally {
			f.restore();
		}
	});

	test('未注入出口 → 回落 renderer fetch（单测/非 Electron 宿主边界）', async () => {
		const f = stubFetch(url => url.endsWith('/sendMessage') ? { ok: true } : new Error('unexpected'));
		try {
			const p = new TelegramPlatform({ botToken: 'T' });
			await p.send({ sessionKey: 's', replyCtx: { chatId: 1, messageId: 2 } }, 'hi');
			assert.strictEqual(f.calls.length, 1);
			assert.strictEqual(f.calls[0].init.method, 'POST');
		} finally {
			f.restore();
		}
	});

	test('ok:false → 抛错带 HTTP 状态与 Telegram description', async () => {
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ status: 400, body: JSON.stringify({ ok: false, description: 'chat not found' }) }));
		try {
			const p = new TelegramPlatform({ botToken: 'T', requestService: exit.svc });
			await assert.rejects(
				() => p.send({ sessionKey: 's', replyCtx: { chatId: 1, messageId: 2 } }, 'x'),
				/HTTP 400 chat not found/,
			);
		} finally {
			f.restore();
		}
	});

	test('非 JSON / 空响应 → 抛错带片段（出口与 fetch 口径一致）', async () => {
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ status: 502, body: '<html>bad gateway</html>' }));
		try {
			const p = new TelegramPlatform({ botToken: 'T', requestService: exit.svc });
			await assert.rejects(
				() => p.send({ sessionKey: 's', replyCtx: { chatId: 1, messageId: 2 } }, 'x'),
				/非 JSON 响应：HTTP 502/,
			);
		} finally {
			f.restore();
		}
	});

	test('缺少 chat_id → 直接抛错，不发起请求', async () => {
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ body: JSON.stringify({ ok: true }) }));
		try {
			const p = new TelegramPlatform({ botToken: 'T', requestService: exit.svc });
			await assert.rejects(() => p.send({ sessionKey: 's' }, 'x'), /缺少 chat_id/);
			assert.strictEqual(exit.calls.length, 0);
		} finally {
			f.restore();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 装配（env 门控 + 出口透传）
// ══════════════════════════════════════════════════════════════════════════

suite('Telegram 平台装配（env 门控）', () => {
	test('未设置 TELEGRAM_BOT_TOKEN → 不注册平台', () => {
		const fb = makeFakeBridge();
		withEnv({ TELEGRAM_BOT_TOKEN: undefined }, () => {
			registerTelegramPlatformIfConfigured(fb.bridge);
		});
		assert.strictEqual(fb.registered.length, 0);
	});

	test('有 token → 注册；装配日志标注出口，且出口被透传到平台', async () => {
		const fb = makeFakeBridge();
		const logs: string[] = [];
		const f = forbiddenFetch();
		const exit = makeHttpExit(() => ({ body: JSON.stringify({ ok: true }) }));
		try {
			withEnv({ TELEGRAM_BOT_TOKEN: 'TOKEN123', TELEGRAM_ALLOW_FROM: '1,2' }, () => {
				registerTelegramPlatformIfConfigured(fb.bridge, m => logs.push(m), exit.svc);
			});
			assert.strictEqual(fb.registered.length, 1);
			assert.strictEqual(fb.registered[0].id, 'telegram');
			assert.ok(logs[0].includes('http=主进程 httpRequest'), logs[0]);
			assert.ok(logs[0].includes('allowFrom=2 项'));

			const platform = fb.registered[0].create();
			assert.strictEqual(platform.allowFrom, '1,2');
			// 平台确实拿到了出口（用一次出站验证，不起轮询）
			await platform.send({ sessionKey: 's', replyCtx: { chatId: 1, messageId: 2 } }, 'hi');
			assert.strictEqual(exit.calls.length, 1);
			assert.strictEqual(f.calls.length, 0);
		} finally {
			f.restore();
		}
	});
});
