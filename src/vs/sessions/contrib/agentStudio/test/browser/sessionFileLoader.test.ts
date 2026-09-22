/*---------------------------------------------------------------------------------------------
 *  SessionFileLoader 专属行为基线（2026-09-22 阶段④-g P1/D-10 ✓）
 *
 *  为什么需要它 ✗✓：`sessionFileLoader.ts`（126 行 ✓）是「快照 + 追加日志重放」的**唯一读口** ✓，
 *  四条口径**每条都对应一类数据事故** ✗✓：
 *   · **快照读不出来不整段丢弃** ✓✓（半写/外部损坏 ⇒ 尽量从追加日志重建 = "崩溃丢整轮"的对策 ✓）；
 *   · **尾行半截是正常情况** ✓（追加途中被 kill ✓）⇒ 只记 warn（不是 error ✗）；
 *   · **压缩阈值计数按实际重放条数与字节恢复** ✓（否则重启后累计归零 ⇒ 压缩永不触发 ✗）；
 *   · **inline scrub 只在这一处做** ✓（此处 messages 是该文件全部内容 ⇒ 回写即精确修正 ✓）。
 *  这里把它当**纯对象**驱动 ✓（IO / 路径学 / sidecar / scrub / 回写全部用假的 ✓）。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；日志 fixture 用**真** `serializeSessionLogAppends` 生成 ✓（协议一致 ✗✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SessionFileLoader } from '../../browser/sessionFileLoader.js';
import { serializeSessionLogAppends, replaySessionLog } from '../../common/sessionHistoryLog.js';
import type { ChatMessage } from '../../common/types.js';

const sessionsDirUri = URI.file('/tmp/fake-sessions');
const snapPath = URI.joinPath(sessionsDirUri, 's1.json').fsPath;
const logPath = URI.joinPath(sessionsDirUri, 's1.log').fsPath;

const msg = (id: string, content = `c-${id}`, role: 'assistant' | 'user' | 'system' = 'assistant'): ChatMessage =>
	({ id, role, content, timestamp: '' } as ChatMessage);

/** 用真序列化器造日志文本（并在需要时追加一段"半截尾行" ✓）。 */
function logText(messages: ChatMessage[], tornTail = false): string {
	const one = serializeSessionLogAppends(messages);
	if (!one) { throw new Error('fixture 无效：消息必须有 id 才能被序列化 ✓'); }
	const base = one.endsWith('\n') ? one : one + '\n';
	return tornTail ? base + '{ "id": "torn", "content": "半截' : base;
}

interface IHarness {
	loader: SessionFileLoader;
	files: Map<string, string>;
	logs: { infos: string[]; warns: string[]; errors: string[] };
	counters: Array<{ key: string; appends: number; bytes: number }>;
	persisted: ChatMessage[][];
	resolvedCount: number;
	scrubResult: { replaced: number; freedBytes: number };
	readShouldThrowFor: Set<string>;
}

function makeHarness(): IHarness {
	const files = new Map<string, string>();
	const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[] };
	const counters: Array<{ key: string; appends: number; bytes: number }> = [];
	const persisted: ChatMessage[][] = [];
	const readShouldThrowFor = new Set<string>();
	const state = { resolvedCount: 0, scrubResult: { replaced: 0, freedBytes: 0 } };
	const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);

	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)),
		readFile: async (uri: any) => {
			const p = pathOf(uri);
			if (readShouldThrowFor.has(p)) { throw new Error('EIO fake'); }
			if (!files.has(p)) { throw new Error('ENOENT ' + p); }
			return { value: { toString: () => files.get(p)! } };
		},
	};
	const log: any = {
		info(...a: unknown[]) { logs.infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { logs.warns.push(a.map(String).join(' ')); },
		error(...a: unknown[]) { logs.errors.push(a.map(String).join(' ')); },
		debug() { }, trace() { },
	};
	const deps: any = {
		logService: log,
		fileService: api,
		paths: {
			resolveAgentPaths: async () => ({ sessionsDirUri }),
			sessionFileUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.json`),
			sessionLogUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.log`),
			cacheKey: (agentId: string, sessionId?: string) => (sessionId ? `${agentId}::${sessionId}` : agentId),
		},
		setHistoryCounters: (key: string, appends: number, bytes: number) => { counters.push({ key, appends, bytes }); },
		resolveSidecarRefs: async () => state.resolvedCount,
		scrubInlineMedia: () => state.scrubResult,
		persistSnapshot: async (_a: string, _s: string | undefined, messages: ChatMessage[]) => { persisted.push(messages); },
	};
	return {
		loader: new SessionFileLoader(deps), files, logs, counters, persisted, readShouldThrowFor,
		get resolvedCount() { return state.resolvedCount; },
		set resolvedCount(v: number) { state.resolvedCount = v; },
		get scrubResult() { return state.scrubResult; },
		set scrubResult(v: { replaced: number; freedBytes: number }) { state.scrubResult = v; },
	};
}

suite('SessionFileLoader — 快照 + 追加日志重放的四条口径 ✓', () => {

	test('★ 无 sessionId / 两个文件都不存在 ⇒ 返回 `[]` 且零读取 ✓', async () => {
		const h = makeHarness();
		assert.deepStrictEqual(await h.loader.loadFromSessionFile('a1', undefined), [], '无 session ⇒ 空 ✓');
		assert.deepStrictEqual(await h.loader.loadFromSessionFile('a1', 's1'), [], '两文件都不存在 ⇒ 空 ✓');
		assert.strictEqual(h.logs.warns.length, 0, '这不是异常 ⇒ 不该告警 ✓');
	});

	test('★★ 只有快照 ⇒ 直接返回快照内容 ✓；快照**不是数组** ⇒ 返回 `[]`（不炸 ✓）', async () => {
		const h = makeHarness();
		const snap = [msg('m0'), msg('m1')];
		h.files.set(snapPath, JSON.stringify(snap));
		assert.deepStrictEqual(await h.loader.loadFromSessionFile('a1', 's1'), snap);

		const h2 = makeHarness();
		h2.files.set(snapPath, JSON.stringify({ not: 'array' }));
		assert.deepStrictEqual(await h2.loader.loadFromSessionFile('a1', 's1'), [],
			'不是数组 ⇒ 空（把对象当数组用会炸上层 ✗✓）');
	});

	test('★★★ 快照**读不出来**（半写/损坏）⇒ **不整段丢弃**，改从追加日志重建 ✓✓（崩溃丢整轮的对策 ✓）', async () => {
		const h = makeHarness();
		h.files.set(snapPath, '{ 半截 JSON');
		const recovered = [msg('m0'), msg('m1')];
		h.files.set(logPath, logText(recovered));

		const out = await h.loader.loadFromSessionFile('a1', 's1');
		assert.deepStrictEqual(out.map(m => m.id), ['m0', 'm1'],
			`★ 快照损坏时必须**从日志重建**（整段丢弃 ⇒ 用户看到"崩溃丢整轮" ✗✓）实际 ${JSON.stringify(out.map(m => m.id))} ✗`);
		assert.ok(h.logs.warns.some(w => w.includes('snapshot unreadable')),
			'必须留下"快照不可读、正从日志重建"的取证 ✓');
	});

	test('★★★ **尾行半截**（追加途中被 kill）⇒ 只记 warn ✓、其余条目照常可用 ✓✓', async () => {
		const h = makeHarness();
		const ok = [msg('m0'), msg('m1')];
		h.files.set(logPath, logText(ok, true));
		const out = await h.loader.loadFromSessionFile('a1', 's1');
		assert.deepStrictEqual(out.map(m => m.id), ['m0', 'm1'], '★ 半截尾行不得影响已完整落盘的条目 ✓');
		const w = h.logs.warns.join(' | ');
		assert.ok(w.includes('unparsable line(s)'), `必须报"尾行不可解析"（实际「${w}」✗）`);
		assert.ok(w.includes('crash-truncated tail'), '必须点名"崩溃截断的尾巴"⇒ 属**正常**而非数据损坏 ✓');
		assert.strictEqual(h.logs.errors.length, 0, '这不是 error（会误导成数据损坏 ✗✓）');
	});

	test('★★★ 按 id **upsert 归并**（幂等 ✓）：日志里的同名 id 必须**覆盖**快照那条，而不是又加一条 ✓✓', async () => {
		const h = makeHarness();
		h.files.set(snapPath, JSON.stringify([msg('dup', 'OLD'), msg('other')]));
		h.files.set(logPath, logText([msg('dup', 'NEW')]));
		const out = await h.loader.loadFromSessionFile('a1', 's1');
		assert.strictEqual(out.length, 2, `不得出现重复 id（实际 ${out.length} 条 ✗✓ —— 重放两次会变重复气泡 ✓）`);
		assert.strictEqual(out.find(m => m.id === 'dup')!.content, 'NEW', '日志条目必须覆盖快照旧值 ✓');
		assert.ok(out.some(m => m.id === 'other'), '其余条目必须保留 ✓');
	});

	test('★★ 压缩阈值计数按**实际重放条数与字节**恢复 ✓（否则重启后累计归零 ⇒ 压缩永不触发 ✗✓）', async () => {
		const h = makeHarness();
		const entries = [msg('m0'), msg('m1')];
		const text = logText(entries);
		h.files.set(logPath, text);
		await h.loader.loadFromSessionFile('a1', 's1');
		const expected = replaySessionLog(text);
		assert.deepStrictEqual(h.counters, [{ key: 'a1::s1', appends: expected.appends, bytes: expected.bytes }],
			`key 必须是 cacheKey ✓、计数必须来自重放 ✓（实际 ${JSON.stringify(h.counters)} ✗）`);
		assert.ok(expected.appends > 0, '前置：重放确实统计到了追加 ✓');
	});

	test('★★ 日志读失败 ⇒ warn 且**快照仍照常返回** ✓✓（局部降级，不牵连另一半 ✓）', async () => {
		const h = makeHarness();
		const snap = [msg('m0')];
		h.files.set(snapPath, JSON.stringify(snap));
		h.files.set(logPath, 'x');
		h.readShouldThrowFor.add(logPath);
		const out = await h.loader.loadFromSessionFile('a1', 's1');
		assert.deepStrictEqual(out, snap, '★ 日志读失败不得吞掉快照（已是权威历史 ✓）');
		assert.ok(h.logs.warns.some(w => w.includes('session log unreadable')), '必须留 warn ✓');
	});

	test('★★★ sidecar 还原 / inline 清理**有改动才回写** ✓✓（无改动 ⇒ 零写盘 ✓）', async () => {
		const h = makeHarness();
		const snap = [msg('m0')];
		h.files.set(snapPath, JSON.stringify(snap));
		await h.loader.loadFromSessionFile('a1', 's1');
		assert.strictEqual(h.persisted.length, 0, '★ 无改动 ⇒ 不得回写（每次装载都回写会放大 IO ✗✓）');

		const h2 = makeHarness();
		h2.files.set(snapPath, JSON.stringify(snap));
		h2.resolvedCount = 2;
		await h2.loader.loadFromSessionFile('a1', 's1');
		assert.strictEqual(h2.persisted.length, 1, '有 sidecar 还原 ⇒ 必须回写让下次装载不必再走 sidecar I/O ✓');

		const h3 = makeHarness();
		h3.files.set(snapPath, JSON.stringify(snap));
		h3.scrubResult = { replaced: 3, freedBytes: 1024 * 1024 };
		await h3.loader.loadFromSessionFile('a1', 's1');
		assert.strictEqual(h3.persisted.length, 1, '有 inline 清理 ⇒ 必须回写 ✓');
		assert.ok(h3.logs.infos.some(l => l.includes('Scrubbed 3 oversized inline data URI')),
			'必须留一条带条数与 MB 的 info（便于事后核对磁盘 ✓）');
	});

	test('★ 回写失败 ⇒ **被吞掉**且装载仍返回历史 ✓（装载是读路径 ⇒ 不得因写失败失败 ✗✓）', async () => {
		const h = makeHarness();
		const snap = [msg('m0')];
		h.files.set(snapPath, JSON.stringify(snap));
		h.resolvedCount = 1;
		(h.loader as any).deps.persistSnapshot = async () => { throw new Error('disk full'); };
		const out = await h.loader.loadFromSessionFile('a1', 's1');
		assert.deepStrictEqual(out, snap, '★ 回写失败不得影响本次装载 ✓');
	});

	test('★ 任何异常都返回 `[]` ✓（宁可空历史，也不让装载失败炸掉上层 ✓）', async () => {
		const h = makeHarness();
		(h.loader as any).deps.paths.resolveAgentPaths = async () => { throw new Error('boom'); };
		assert.deepStrictEqual(await h.loader.loadFromSessionFile('a1', 's1'), []);
	});
});
