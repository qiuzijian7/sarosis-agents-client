/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── TelegramPlatform 单测（入站解析 + 卡片→内联键盘转换）──

import assert from 'assert';
import { TelegramPlatform } from '../../browser/bridge/platforms/telegram.js';
import { BridgeCard } from '../../common/bridge/bridgeTypes.js';

function makePlatform(): { p: TelegramPlatform; received: any[] } {
	const p = new TelegramPlatform({ botToken: 'TEST_TOKEN' });
	const received: any[] = [];
	p.start((msg: any) => received.push(msg));
	return { p, received };
}

suite('TelegramPlatform inbound', () => {
	test('parses message update into InboundMessage', () => {
		const { p, received } = makePlatform();
		p.handleUpdate({
			update_id: 100,
			message: {
				message_id: 42,
				chat: { id: 7, type: 'private', username: 'alice_chat' },
				from: { id: 99, username: 'alice', first_name: 'Alice' },
				text: 'hello agent',
			},
		});
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
});

suite('TelegramPlatform card -> inline keyboard', () => {
	test('renders actions as inline_keyboard rows', async () => {
		const { p } = makePlatform();
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
		// 私有转换无法直测，改测公开 sendCard 的产物：用 reply 捕获请求体。
		// 通过拦截 fetch 验证 reply_markup 结构。
		const sent: any[] = [];
		(globalThis as any).fetch = async (url: string, init: any) => {
			sent.push(JSON.parse(init.body));
			return { json: async () => ({ ok: true }) };
		};
		await p.sendCard({ sessionKey: 'telegram:7:99', replyCtx: { chatId: 7, messageId: 1 } }, card);
		assert.strictEqual(sent.length, 1);
		const kb = sent[0].reply_markup.inline_keyboard;
		assert.strictEqual(kb.length, 1);
		assert.strictEqual(kb[0][0].text, 'New');
		assert.strictEqual(kb[0][0].callback_data, 'cmd:/new');
		assert.strictEqual(kb[0][1].text, 'Stop');
		delete (globalThis as any).fetch;
	});
});
