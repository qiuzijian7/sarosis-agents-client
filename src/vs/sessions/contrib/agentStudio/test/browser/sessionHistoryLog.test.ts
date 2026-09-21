/*---------------------------------------------------------------------------------------------
 *  会话历史**追加日志**（P0-1，2026-09-21）回归测试。
 *
 *  背景（对标 pi 的 `session-backends` / durable 记录-游标模型后立项 ✓）：
 *  本仓会话历史此前是**整文件覆盖写** —— `appendMessage` / `appendMessagesBatch` /
 *  `updateMessage` 每次调用都 `JSON.stringify(整个会话)` 再写盘 ✓。后果有两类：
 *    ① 成本 ∝ 消息数（62 轮 turn = 62 次全量序列化，见 agentChatBatchPersist.test.ts ✓）；
 *    ② **崩溃丢整轮** —— 原子写只保证「旧内容 or 新内容」，两轮之间被 kill ⇒
 *       磁盘上还是上一轮 ⇒ 本轮内容全丢 ✗（用户实测：「LLM 输出途中 app 被关，
 *       重启后内容消失」✓）。
 *
 *  修法：`sessions/{id}.jsonl` 追加日志（一行一条 ✓）+ `{id}.json` 定期快照 ✓，
 *  读 = 快照 + 重放（按 id 归并 ⇒ 幂等 ✓），屏障（`op:'base'`）负责让「写快照 →
 *  截断日志」在任意崩溃点都正确 ✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/sessionHistoryLog.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';


import { AgentChatService } from '../../browser/agentChatService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	replaySessionLog,
	serializeSessionLogAppends,
	serializeSessionLogBarrier,
	upsertMessageById,
} from '../../common/sessionHistoryLog.js';

import type { ChatMessage } from '../../common/types.js';

// ─── 纯语义（不依赖文件系统）─────────────────────────────────────────────────

function m(id: string, content: string, sessionId = 'sess-1'): ChatMessage {
	return {
		id, role: 'assistant', content, agentSessionId: sessionId,
		timestamp: new Date().toISOString(),
	} as ChatMessage;
}

suite('会话追加日志：纯语义（P0-1）', () => {

	test('序列化 → 重放：顺序与内容一致', () => {
		const text = serializeSessionLogAppends([m('a', '1'), m('b', '2'), m('c', '3')]);
		const r = replaySessionLog(text);
		assert.deepStrictEqual(r.messages.map(x => x.id), ['a', 'b', 'c']);
		assert.strictEqual(r.appends, 3);
		assert.strictEqual(r.tornLines, 0);
	});

	test('★ 同 id 覆盖：**原位置不动** + 最后一条胜出（重放幂等的前提）', () => {
		// b 先写入两条（模拟流式期间同一 assistant 消息被反复更新 ✓），
		// 之后再写一条 c ⇒ b 不应被挪到末尾，否则重放顺序与真实发生顺序不符 ✗
		const text =
			serializeSessionLogAppends([m('a', '1')]) +
			serializeSessionLogAppends([m('b', 'v1')]) +
			serializeSessionLogAppends([m('b', 'v2')]) +
			serializeSessionLogAppends([m('c', '3')]);
		const r = replaySessionLog(text);
		assert.deepStrictEqual(r.messages.map(x => x.id), ['a', 'b', 'c'], 'b 必须保持原位置 ✓');
		assert.strictEqual(r.messages[1].content, 'v2', '同 id 以最后一条为准 ✓');
	});

	test('★★ 幂等：同一份日志重放两次，结果完全相同', () => {
		const text = serializeSessionLogAppends([m('a', '1'), m('b', '2'), m('a', '1b')]);
		const first = replaySessionLog(text).messages;
		const second = replaySessionLog(text).messages;
		assert.deepStrictEqual(second, first, '重放必须幂等 —— 这是「日志未截断就重放」安全的前提 ✓');
		// 再叠加一次（等价于「重放结果又碰到同一批条目」）
		const merged = [...first];
		for (const x of replaySessionLog(text).messages) { upsertMessageById(merged, x); }
		assert.strictEqual(merged.length, first.length, '重复应用不得产生重复消息 ✓');
	});

	test('★★ 屏障：屏障**之前**的条目一律丢弃', () => {
		const text =
			serializeSessionLogAppends([m('old', '旧')]) +
			serializeSessionLogBarrier() +
			serializeSessionLogAppends([m('new', '新')]);
		const r = replaySessionLog(text);
		assert.deepStrictEqual(r.messages.map(x => x.id), ['new'], '屏障保护「写快照后崩溃」不重放旧条目 ✓');
		assert.strictEqual(r.barrierSeen, true);
		assert.strictEqual(r.appends, 1, '压缩计数从屏障后重新开始 ✓');
	});

	test('★ 崩溃截断：只丢**那一行**，其余照常生效', () => {
		const full = serializeSessionLogAppends([m('a', '1'), m('b', '2')]);
		const torn = full + '{"op":"a","msg":{"id":"c","cont';   // 追加途中被 kill ✓
		const r = replaySessionLog(torn);
		assert.deepStrictEqual(r.messages.map(x => x.id), ['a', 'b'], '前两条必须保住 ✓');
		assert.strictEqual(r.tornLines, 1);
	});

	test('无 id 的消息不写入日志（写了只会在重放时变成重复气泡 ✗）', () => {
		const text = serializeSessionLogAppends([{ content: 'x' } as ChatMessage, m('ok', 'y')]);
		assert.strictEqual(text.split('\n').filter(Boolean).length, 1);
	});

	test('★ 重放须报告**字节数**（压缩的第二阈值 —— 条数阈值兜不住 MB 级工具结果 ✗）', () => {
		const big = m('big', 'y'.repeat(5000));
		const text = serializeSessionLogAppends([m('a', 'x'), big]);
		const r = replaySessionLog(text);
		assert.ok(r.bytes >= 5000, `字节数应包含大消息（实际 ${r.bytes} ✗）`);
		// 屏障后重新计数 ✓
		const afterBarrier = serializeSessionLogBarrier() + serializeSessionLogAppends([m('c', 'z')]);
		assert.ok(replaySessionLog(afterBarrier).bytes < r.bytes, '屏障必须重置字节计数 ✓');
	});
});

// ─── 与 AgentChatService 的集成（内存文件系统，含 append 能力）───────────────

const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);

interface IFakeFs {
	files: Map<string, string>;
	writes: { path: string; append: boolean }[];
	api: any;
	/** 捕获日志（供「失忆取证」用例断言 ✓）。 */
	logs: { warns: string[]; infos: string[] };
}

/** 内存 FS：**声明** FileAppend / FileAtomicWrite 能力 ⇒ 走真实追加路径 ✓。 */
function makeFakeFs(): IFakeFs {
	const files = new Map<string, string>();
	const writes: { path: string; append: boolean }[] = [];
	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)),
		createFolder: async () => { },
		readFile: async (uri: any) => {
			const p = pathOf(uri);
			if (!files.has(p)) { throw new Error(`ENOENT ${p}`); }
			return { value: VSBuffer.fromString(files.get(p)!) };
		},
		writeFile: async (uri: any, buf: any, opts?: any) => {
			const p = pathOf(uri);
			writes.push({ path: p, append: !!opts?.append });
			files.set(p, opts?.append ? (files.get(p) ?? '') + buf.toString() : buf.toString());
		},
		del: async (uri: any) => { files.delete(pathOf(uri)); },
		copy: async (src: any, dst: any) => {
			const s = pathOf(src);
			if (files.has(s)) { files.set(pathOf(dst), files.get(s)!); }
		},
		resolve: async () => ({ children: [] }),
		hasCapability: () => true,
	};
	return { files, writes, api, logs: { warns: [], infos: [] } };
}

function makeService(fs: IFakeFs): AgentChatService {
	// ★ 捕获 warn/info：`_diagnoseEmptyPriorMessages`（失忆取证）只靠日志表达结论 ✗ ⇒
	//   不捕获就没法断言它是否**正确区分**了三种成因 ✓。
	const log: any = {
		info(...a: unknown[]) { fs.logs.infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { fs.logs.warns.push(a.map(String).join(' ')); },
		debug() { }, trace() { }, error() { },
	};
	const environmentService: any = { userRoamingDataHome: URI.file('/tmp/vssaros') };
	return new AgentChatService(
		log, {} as any, fs.api, environmentService,
		{ getValue: () => undefined } as any,
		{ getActiveWorkspaceId: () => undefined, getWorkspace: async () => undefined } as any,
		{ onWillShutdown: () => ({ dispose() { } }) } as any,
	);
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));
const logPathOf = (fs: IFakeFs): string | undefined =>
	[...fs.files.keys()].find(p => p.endsWith('sess-1.jsonl'));
const snapshotPathOf = (fs: IFakeFs): string | undefined =>
	[...fs.files.keys()].find(p => p.endsWith('sess-1.json'));

suite('AgentChatService：会话历史改追加（P0-1）', () => {

	test('★★★ appendMessage 只追加日志，**不再重写会话快照**', async () => {
		const fs = makeFakeFs();
		const svc = makeService(fs);
		for (let i = 0; i < 5; i++) {
			await svc.appendMessage('agent-1', m(`m${i}`, `内容${i}`));
		}
		await settle();

		const snapshotWrites = fs.writes.filter(w => w.path.endsWith('sess-1.json'));
		const logWrites = fs.writes.filter(w => w.path.endsWith('sess-1.jsonl'));
		assert.strictEqual(snapshotWrites.length, 0,
			`追加路径不得整会话重写（实际 ${snapshotWrites.length} 次 ✗）—— 这正是改造前的成本来源 ✓`);
		assert.strictEqual(logWrites.length, 5, '每条消息一次追加写 ✓');
		assert.ok(logWrites.every(w => w.append), '必须是**追加**写（append: true ✓），不是覆盖 ✗');
		assert.ok(logPathOf(fs), '日志文件应存在 ✓');
	});

	test('★★★ 新实例重载（快照不存在、只有日志）⇒ 消息仍在（= 崩溃后重启）', async () => {
		const fs = makeFakeFs();
		const svc1 = makeService(fs);
		await svc1.appendMessage('agent-1', m('a', '第一条'));
		await svc1.appendMessage('agent-1', m('b', '第二条'));
		await settle();
		assert.strictEqual(snapshotPathOf(fs), undefined, '此阶段不应有快照（只有日志 ✓）');

		// 模拟「进程重启」：全新实例，共享同一份磁盘内容 ✓
		const svc2 = makeService(fs);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		assert.deepStrictEqual(history.map(x => x.id), ['a', 'b'],
			'日志重放必须把消息找回来（改造前这里会返回空 ✗✓）');
		assert.deepStrictEqual(history.map(x => x.content), ['第一条', '第二条']);
	});

	test('★★ updateMessage 后重载 ⇒ 拿到**更新后**的内容', async () => {
		const fs = makeFakeFs();
		const svc1 = makeService(fs);
		await svc1.appendMessage('agent-1', m('a', '原始'));
		await settle();
		await svc1.updateMessage('agent-1', 'sess-1', 'a', { content: '更新后' } as any);
		await settle();

		const svc2 = makeService(fs);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		assert.strictEqual(history.length, 1, '同 id 覆盖 ⇒ 不得变成两条 ✓');
		assert.strictEqual(history[0].content, '更新后');
	});

	test('★★★ replaceHistory 后重载 ⇒ 被替换掉的旧日志条目**不复活**（屏障 ✓）', async () => {
		const fs = makeFakeFs();
		const svc1 = makeService(fs);
		await svc1.appendMessage('agent-1', m('old1', '旧一'));
		await svc1.appendMessage('agent-1', m('old2', '旧二'));
		await settle();

		// 整段改写（工作流压缩写回走的就是这条 ✓）
		await svc1.replaceHistory('agent-1', 'sess-1', [m('kept', '保留')]);

		const svc2 = makeService(fs);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		assert.deepStrictEqual(history.map(x => x.id), ['kept'],
			'旧日志不得把已替换的内容重放回来（无屏障时这里会多出 old1/old2 ✗✓）');
	});

	test('★★ clearHistory 后重载 ⇒ 空（快照与日志成对清理 ✓）', async () => {
		const fs = makeFakeFs();
		const svc1 = makeService(fs);
		await svc1.appendMessage('agent-1', m('a', 'x'));
		await settle();
		await svc1.clearHistory('agent-1', 'sess-1');

		const svc2 = makeService(fs);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		assert.deepStrictEqual(history, [], '清空必须同时清掉日志（否则重放复活 ✗✓）');
	});

	test('★ 日志尾行被截断（崩溃残留）⇒ 其余消息照常加载', async () => {
		const fs = makeFakeFs();
		const svc1 = makeService(fs);
		await svc1.appendMessage('agent-1', m('a', '第一条'));
		await svc1.appendMessage('agent-1', m('b', '第二条'));
		await settle();

		// 模拟追加途中被 kill：末行只写了一半 ✓
		const lp = logPathOf(fs)!;
		fs.files.set(lp, fs.files.get(lp)! + '{"op":"a","msg":{"id":"c","conte');

		const svc2 = makeService(fs);
		const history = await svc2.getHistory('agent-1', 'sess-1');
		assert.deepStrictEqual(history.map(x => x.id), ['a', 'b'], '半行只影响它自己，不得整段失败 ✗');
	});

	test('★ appendMessagesBatch 追加的是**本批新消息**（与会话长度无关 ✓）', async () => {
		const fs = makeFakeFs();
		const svc = makeService(fs);
		await svc.appendMessagesBatch('agent-1', Array.from({ length: 30 }, (_, i) => m(`m${i}`, `x${i}`)));
		await settle();
		const logText = fs.files.get(logPathOf(fs)!)!;
		assert.strictEqual(logText.split('\n').filter(Boolean).length, 30, '30 条 ⇒ 30 行追加 ✓');
		assert.strictEqual(fs.writes.filter(w => w.path.endsWith('sess-1.json')).length, 0,
			'批量追加同样不得整会话重写 ✓');

		// 再来一批：写盘量仍与批次大小成正比，与已有 30 条无关 ✓
		const before = fs.writes.length;
		await svc.appendMessagesBatch('agent-1', [m('n1', 'y')]);
		await settle();
		assert.ok(fs.writes.length - before <= 3,
			`第二批 1 条应只产生极少写入（实际 ${fs.writes.length - before} 次 ✗）`);
	});

	test('★★★ 压缩边界必须原文保留「用户最近指令」（摘要失真时的 fail-safe ✗✓）', async () => {
		// 真机证据（sess_ms5kriv8_0j6atj ✓）：边界摘要把 `## Active Task` / `## Goal` 都写成「无」✗，
		// 用户接着说「执行」⇒ 模型答「没有待执行的任务指令」✓ —— 因为边界**取代了**全部早期历史 ✗。
		const fs = makeFakeFs();
		const svc = makeService(fs);
		const userMsg = (id: string, content: string): ChatMessage =>
			({ id, role: 'user', content, agentSessionId: 'sess-1', timestamp: '' } as ChatMessage);
		await svc.appendMessage('agent-1', userMsg('u1', '请把 test-qiuzijian 这个 agent 的存储路径找出来'));
		await svc.appendMessage('agent-1', userMsg('u2', '执行'));
		await settle();

		const boundary = (svc as any)._buildCompactionBoundaryMessage(
			'agent-1', 'sess-1',
			{ originalCount: 11, compressedCount: 10, tokensSaved: 50, summary: '## Active Task（当前任务）\n无' },
			'执行',
		);
		assert.ok(boundary.content.includes('请把 test-qiuzijian 这个 agent 的存储路径找出来'),
			'★ 必须在边界里**原文保留**用户最近指令（否则摘要一失真就彻底失忆 ✗✓）');
		assert.ok(!/\n1\. 执行/.test(boundary.content),
			'不得把"当前这条"消息也塞进去（driver 会追加它 ⇒ 重复 ✗）');
		assert.strictEqual((boundary.metadata as any).type, 'compaction', '边界标记必须保留 ✓');
	});

	test('★★★ 压缩**无收益**（tokensSaved ≤ 0）时不得插边界（否则只有"销毁上下文"一个效果 ✗✓）', () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts'),
			'utf8',
		);
		const guards = src.split('pendingCompaction && pendingCompaction.tokensSaved > 0').length - 1;
		assert.strictEqual(guards, 2,
			`两条边界落盘路径（批量 / 回退）都必须有收益 guard（实际 ${guards} ✗）—— 真机 tokensSaved=-73 ✗ 正是被它拦下的场景 ✓`);
		assert.ok(src.includes('跳过压缩边界'), '跳过时必须留下可查日志 ✓');
		assert.ok(src.includes('用户最近的指令（原文保留'),
			'边界内容必须带"原文兜底"段（见上一个用例 ✓）');
	});

	test('★★★ 「模型失忆」取证：priorMessages 为 0 时必须**区分三种成因**（否则只能猜 ✗）', async () => {
		// 用户实测：「切换模型后 LLM 对上下文一无所知」✓ —— `priorMessages` 是模型能看到的
		// 全部历史 ✗；为 0 时它只剩当前 user 消息 ✓，而旧日志只有一行 `priorMsgs=0` ✗。
		const diag = (svc: AgentChatService, sid: string | undefined, historyLen: number) =>
			(svc as any)._diagnoseEmptyPriorMessages('agent-1', sid, historyLen);

		// ① 真空 ⇒ 正常 ✓（只 info，不告警 ✗）
		{
			const fs = makeFakeFs();
			const svc = makeService(fs);
			await diag(svc, 'sess-1', 0);
			assert.deepStrictEqual(fs.logs.warns, [], '真空不该告警 ✓');
			assert.ok(fs.logs.infos.some(l => l.includes('确实还没有历史')), '真空应留下对照日志 ✓');
		}

		// ② 历史有值、组装后为 0 ⇒ **被过滤/裁剪** ✗（压缩边界是主因 ✓）
		{
			const fs = makeFakeFs();
			const svc = makeService(fs);
			await diag(svc, 'sess-1', 42);
			assert.ok(fs.logs.warns.some(l => l.includes('过滤/裁剪') && l.includes('42')),
				`必须报"被过滤/裁剪"并带上原始条数 ✗：${JSON.stringify(fs.logs.warns)}`);
		}

		// ③ 桶空但**盘上有内容** ⇒ **key 不匹配** ✗✗（最严重：UI 有对话、模型失忆 ✓）
		{
			const fs = makeFakeFs();
			const svc = makeService(fs);
			// 先经服务真实写一份日志 ⇒ 模拟"历史挂在盘上、但本次 sessionId 取不到桶" ✓
			await svc.appendMessage('agent-1', m('a', '历史在这里'));
			await settle();
			const logPath = logPathOf(fs)!;
			assert.ok(logPath, '前置：日志文件应已写入 ✓');
			await diag(svc, 'sess-1', 0);
			assert.ok(fs.logs.warns.some(l => l.includes('key 不匹配')),
				`盘上有内容却取到空桶 ⇒ 必须报 key 不匹配 ✗：${JSON.stringify(fs.logs.warns)}`);
		}

		// ④ sessionId 缺失 ⇒ 单独一条（新会话/未分配路径 ✓）
		{
			const fs = makeFakeFs();
			const svc = makeService(fs);
			await diag(svc, undefined, 0);
			assert.ok(fs.logs.warns.some(l => l.includes('sessionId 缺失')),
				`sessionId 缺失必须单独报出 ✗：${JSON.stringify(fs.logs.warns)}`);
		}
	});

	test('★★★ P1-5 游标读：只拿增量；压缩/改写后跟随方**必须**收到 reset（否则静默停住 ✗✓）', async () => {
		const fs = makeFakeFs();
		const writer = makeService(fs);
		await writer.appendMessage('agent-1', m('a', '一'));
		await writer.appendMessage('agent-1', m('b', '二'));
		await settle();

		// 另一个实例 = 另一个窗口/进程（**不共享内存** ✓，只读磁盘 ✓）
		const follower = makeService(fs);
		const first = await follower.readSessionEvents('agent-1', 'sess-1');
		assert.deepStrictEqual(first.events.map(e => e.msg?.id), ['a', 'b']);
		assert.strictEqual(first.cursor.seq, 2);

		// 原实例继续写 ⇒ 跟随方**只**拿到新增那条 ✓
		await writer.appendMessage('agent-1', m('c', '三'));
		await settle();
		const inc = await follower.readSessionEvents('agent-1', 'sess-1', first.cursor);
		assert.deepStrictEqual(inc.events.map(e => e.msg?.id), ['c'], '只增量，不重复投递 ✓');
		assert.ok(inc.cursor.seq > first.cursor.seq, '游标必须前进 ✓');

		// 整段改写（工作流压缩写回的同款路径 ✓）：快照 + 屏障 + **删除日志** ✗
		// ⇒ 跟随方下次读到的日志"行号从头开始"（甚至文件不存在 ✓）
		// ⇒ **必须**发 reset，否则它会拿着旧游标永远读不到新内容 ✗✓
		await writer.replaceHistory('agent-1', 'sess-1', [m('kept', '保留')]);
		const after = await follower.readSessionEvents('agent-1', 'sess-1', inc.cursor);
		assert.ok(after.events.some(e => e.kind === 'reset'),
			`压缩/改写后必须能被跟随方察觉（实际收到：${JSON.stringify(after.events.map(e => e.kind))} ✗）`);
		// reset 之后的正确动作 = 重新 getHistory（快照是权威 ✓）
		const reloaded = await follower.getHistory('agent-1', 'sess-1');
		assert.deepStrictEqual(reloaded.map(x => x.id), ['kept'], '重载快照应拿到改写后的内容 ✓');
	});

	test('★★ 压缩必须**双阈值**（条数 + 字节）—— 条数阈值兜不住 MB 级消息 ✗', () => {
		// 源码结构断言：两个阈值常量都必须被真正引用（只声明不引用 = 假护栏 ✗）
		const src = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts'),
			'utf8',
		);
		assert.ok(src.includes('SESSION_LOG_COMPACT_AFTER_BYTES'),
			'必须有字节阈值常量 ✓');
		assert.ok(/pending\s*>=\s*AgentChatService\.SESSION_LOG_COMPACT_AFTER\b/.test(src),
			'条数阈值必须参与判定 ✓');
		assert.ok(/pendingBytes\s*>=\s*AgentChatService\.SESSION_LOG_COMPACT_AFTER_BYTES\b/.test(src),
			'字节阈值必须参与判定（只声明不引用 = 假护栏 ✗）');
	});
});
