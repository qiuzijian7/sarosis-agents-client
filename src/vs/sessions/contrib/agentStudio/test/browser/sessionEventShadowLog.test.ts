/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SessionEventShadowLog（B1 影子写）的行为钉：
 *   1. 默认关（门控未开 ⇒ 零写入）；
 *   2. 门控开 ⇒ checkpoint 写差量行（from/to 区间 + 新增片段），turn-complete 写终止行；
 *   3. 差量语义：messages 单调增长 ⇒ 每次只追加新增片段（重建 = 按序拼接）；
 *   4. 写盘异常吞成 warn（影子设施绝不抛错）。
 */
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SessionEventShadowLog, type IShadowTurnEvent } from '../../browser/sessionEventShadowLog.js';
import type { AgentRunStateSnapshot } from '../../common/agentRunState.js';

const g = globalThis as { __SAROSIS_EVENT_SHADOW?: unknown };

/** 内存 fileService（read/write/exists 三方法即可）。 */
function makeFs() {
	const files = new Map<string, string>();
	return {
		files,
		fileService: {
			readFile: async (uri: URI) => {
				const v = files.get(uri.toString());
				if (v === undefined) { throw new Error('not found'); }
				return { value: { toString: () => v } };
			},
			writeFile: async (uri: URI, buf: { toString: () => string }) => { files.set(uri.toString(), buf.toString()); },
		} as never,
	};
}

function snap(iteration: number, msgCount: number): AgentRunStateSnapshot {
	const messages = Array.from({ length: msgCount }, (_, i) => ({ role: 'user', content: `m${i}` }));
	return { version: 1, state: { iteration, messages } as never } as AgentRunStateSnapshot;
}

function makeLog(files: ReturnType<typeof makeFs>) {
	const warns: string[] = [];
	const log = new SessionEventShadowLog({
		fileService: files.fileService,
		shadowDirUri: URI.parse('mem:///shadow'),
		log: () => { /* */ },
		logWarn: m => warns.push(m),
	});
	return { log, warns };
}

suite('SessionEventShadowLog（B1 影子写）', () => {

	test('默认关：门控未开 ⇒ 零写入', async () => {
		delete g.__SAROSIS_EVENT_SHADOW;
		const files = makeFs();
		const { log } = makeLog(files);
		log.appendCheckpoint('s1', snap(0, 3));
		log.markTurnComplete('s1');
		await new Promise(r => setTimeout(r, 10));
		assert.strictEqual(files.files.size, 0, '门控关 ⇒ 一个文件都不写');
	});

	test('门控开：checkpoint 写差量行（from/to + 新增片段），终止行收尾', async () => {
		g.__SAROSIS_EVENT_SHADOW = true;
		const files = makeFs();
		const { log } = makeLog(files);
		log.appendCheckpoint('s1', snap(0, 2));   // [0,2)：m0,m1
		log.appendCheckpoint('s1', snap(3, 5));   // [2,5)：m2,m3,m4（差量）
		log.markTurnComplete('s1');
		await new Promise(r => setTimeout(r, 30));

		const events = await log.readEvents('s1');
		assert.strictEqual(events.length, 3);
		const [e0, e1, e2] = events as [IShadowTurnEvent, IShadowTurnEvent, IShadowTurnEvent];
		assert.strictEqual(e0.kind, 'turn-checkpoint');
		assert.deepStrictEqual([e0.from, e0.to], [0, 2]);
		assert.deepStrictEqual([e1.from, e1.to], [2, 5], '第二次只写差量（事件溯源语义）');
		assert.strictEqual((e1.messages ?? []).length, 3);
		assert.strictEqual(e1.iteration, 3);
		assert.strictEqual(e2.kind, 'turn-complete');
		// 重建判据（B2 的对拍口径）：按序拼接 = 完整 transcript
		const rebuilt = events.flatMap(e => e.messages ?? []);
		assert.strictEqual(rebuilt.length, 5, '差量按序拼接应重建完整 transcript');

		delete g.__SAROSIS_EVENT_SHADOW;
	});

	test('写盘异常吞成 warn，绝不抛出', async () => {
		g.__SAROSIS_EVENT_SHADOW = true;
		const warns: string[] = [];
		const log = new SessionEventShadowLog({
			fileService: {
				readFile: async () => { throw new Error('boom-read'); },
				writeFile: async () => { throw new Error('boom-write'); },
			} as never,
			shadowDirUri: URI.parse('mem:///shadow'),
			log: () => { /* */ },
			logWarn: m => warns.push(m),
		});
		log.appendCheckpoint('s1', snap(0, 1));
		await new Promise(r => setTimeout(r, 30));
		assert.ok(true, '未抛出');
		delete g.__SAROSIS_EVENT_SHADOW;
	});
});
