/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * [CacheDiag] 请求级缓存指纹的回归守卫（2026-09-21，hy4 命中率排查）。
 *
 * 指纹的用途是**让日志能自归因**：下次命中率排查不必再反推，
 * 直接看「sys/tools 哈希变没变 + shared/divergedAt」。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/languageModelsBridgeCacheDiag.test.ts
 */

import * as assert from 'assert';
import { computeCacheFingerprint, sharedPrefixCount } from '../../browser/languageModelsBridge.js';

suite('CacheDiag — computeCacheFingerprint / sharedPrefixCount', () => {

	test('★★★ 同样的输入 ⇒ 同样的指纹（前缀稳定才可被缓存 —— 指纹必须确定）', () => {
		const msgs = [
			{ role: 'system', content: '你是助手' },
			{ role: 'user', content: 'hi' },
		];
		const tools = [{ name: 'file_read', description: '读文件', inputSchema: { type: 'object' } }];
		const a = computeCacheFingerprint(msgs, tools);
		const b = computeCacheFingerprint(msgs, tools);
		assert.deepStrictEqual(a, b, '同输入必须同指纹 ✗');
		assert.notStrictEqual(a.sysHash, 'nosys', '首条是 system 时必须有 sysHash ✗');
		assert.strictEqual(a.msgHashes.length, 2);
	});

	test('★★★ 消息追加 ⇒ 前面指纹不变、shared 全命中（这才是"前缀可复用"的证据）', () => {
		const base = [
			{ role: 'system', content: 'S' },
			{ role: 'user', content: 'U1' },
			{ role: 'assistant', content: 'A1' },
		];
		const grown = [...base, { role: 'user', content: 'U2' }];
		const fp1 = computeCacheFingerprint(base, []);
		const fp2 = computeCacheFingerprint(grown, []);
		assert.strictEqual(fp1.sysHash, fp2.sysHash, '追加不得动 system 指纹 ✗');
		assert.deepStrictEqual(fp2.msgHashes.slice(0, 3), fp1.msgHashes, '追加不得动已有消息的哈希 ✗');
		assert.strictEqual(sharedPrefixCount(fp2.msgHashes, fp1.msgHashes), 3,
			'追加时 shared 必须等于上一次的全长 ✗');
	});

	test('★★★ 早期消息被改写 ⇒ shared 停在改写点（divergedAt 的判读依据）', () => {
		const prev = computeCacheFingerprint([
			{ role: 'system', content: 'S' },
			{ role: 'user', content: 'U1' },
			{ role: 'assistant', content: 'A1' },
			{ role: 'user', content: 'U2' },
		], []);
		// 第 2 条消息（索引 1）内容变了（例如剪枝/压缩改写了历史）
		const curr = computeCacheFingerprint([
			{ role: 'system', content: 'S' },
			{ role: 'user', content: 'U1-REWRITTEN' },
			{ role: 'assistant', content: 'A1' },
			{ role: 'user', content: 'U2' },
		], []);
		assert.strictEqual(sharedPrefixCount(curr.msgHashes, prev.msgHashes), 1,
			'早期改写 ⇒ shared 必须停在改写点（1）✗');
		// system 没变，所以 sysHash 应该一致
		assert.strictEqual(curr.sysHash, prev.sysHash);
	});

	test('★★★ 工具块内容变 ⇒ toolsHash 变（哪怕数量没变）', () => {
		const t1 = [{ name: 'a', description: 'd1', inputSchema: { type: 'object' } }];
		const t2 = [{ name: 'a', description: 'd1-CHANGED', inputSchema: { type: 'object' } }];
		assert.notStrictEqual(
			computeCacheFingerprint([], t1).toolsHash,
			computeCacheFingerprint([], t2).toolsHash,
			'工具描述变了就必须反映在 toolsHash 上 ✗（这正是"工具数没变但内容变了"的盲区）',
		);
		// 数量不变、内容也不变 ⇒ 指纹不变
		assert.strictEqual(
			computeCacheFingerprint([], t1).toolsHash,
			computeCacheFingerprint([], t1).toolsHash,
		);
	});

	test('★ shared 对「无上一次」与「比上一次短」都安全', () => {
		const fp = computeCacheFingerprint([{ role: 'system', content: 'S' }], []);
		assert.strictEqual(sharedPrefixCount(fp.msgHashes, undefined), 0);
		assert.strictEqual(sharedPrefixCount(fp.msgHashes, [...fp.msgHashes, 'x', 'y']), 1,
			'本次比上次短时 shared 不得超过本次长度 ✗');
	});

	test('★ 无 system 消息时 sysHash=nosys（不崩溃）', () => {
		const fp = computeCacheFingerprint([{ role: 'user', content: 'u' }], undefined);
		assert.strictEqual(fp.sysHash, 'nosys');
		assert.strictEqual(fp.msgHashes.length, 1);
	});
});
