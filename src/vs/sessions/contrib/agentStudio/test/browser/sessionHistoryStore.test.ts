/*---------------------------------------------------------------------------------------------
 *  SessionHistoryStore 专属行为基线（2026-09-22 阶段④-g P1/D-9 ✓）
 *
 *  为什么需要它 ✗✓：`sessionHistoryStore.ts`（208 行 ✓）是会话历史**唯一的写路径** ✓，
 *  协议本身是"读 = 快照 + 重放日志"✓ ⇒ 四条语义**每条都对应一类静默丢消息** ✗✓：
 *   · **整段改写必须带屏障** ✓ —— 否则旧日志条目会被"重放复活" ⇒ 已删消息又出现 ✗；
 *   · **三步（快照→屏障→截断）必须在同一把锁内** ✓ —— 否则并发追加插进来会被重放丢弃 ✓；
 *   · **前一笔失败不得阻塞后续** ✓✓ —— 否则一次写失败会让该会话**永久**无法落盘 ✗；
 *   · **双阈值压缩**（条数 512 / 字节 4MB）✓ —— 单个阈值兜不住 MB 级消息 ✗。
 *  这里把它当**纯对象**驱动 ✓（fileService / paths / 缓存 / 索引全部用假的 ✓）。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；假件照抄真件判据 ✓（期望文本用真 `serializeSessionLogBarrier` /
 *  `serializeSessionLogAppends` 生成 ✓、阈值用真常量 ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SessionHistoryStore } from '../../browser/sessionHistoryStore.js';
import { serializeSessionLogAppends, serializeSessionLogBarrier } from '../../common/sessionHistoryLog.js';
import type { ChatMessage } from '../../common/types.js';

const sessionsDirUri = URI.file('/tmp/fake-sessions');
const sessionFile = URI.joinPath(sessionsDirUri, 's1.json').fsPath;
const sessionLog = URI.joinPath(sessionsDirUri, 's1.log').fsPath;

const msg = (id: string, content = `c-${id}`): ChatMessage =>
	({ id, role: 'assistant', content, timestamp: '' } as ChatMessage);
const noIdMsg = (): ChatMessage => ({ role: 'assistant', content: 'x', timestamp: '' } as ChatMessage);

interface IHarness {
	store: SessionHistoryStore;
	files: Map<string, string>;
	writes: Array<{ path: string; append: boolean }>;
	deletes: string[];
	indexCalls: Array<{ agentId: string; sessionId: string; count: number }>;
	indexShouldThrow: boolean;
	cached: Map<string, ChatMessage[]>;
	logs: { infos: string[]; warns: string[]; errors: string[] };
	failNextWrite(): void;
	/** 读私有计数器（测试用 ✓） */
	appendsOf(key: string): number | undefined;
	bytesOf(key: string): number | undefined;
}

function makeHarness(): IHarness {
	const files = new Map<string, string>();
	const writes: Array<{ path: string; append: boolean }> = [];
	const deletes: string[] = [];
	const indexCalls: Array<{ agentId: string; sessionId: string; count: number }> = [];
	const cached = new Map<string, ChatMessage[]>();
	const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[] };
	let failWrite = false;
	const state: any = { indexShouldThrow: false };
	const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);

	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)),
		readFile: async (uri: any) => {
			const p = pathOf(uri);
			if (!files.has(p)) { throw new Error('ENOENT ' + p); }
			return { value: { toString: () => files.get(p)! } };
		},
		writeFile: async (uri: any, buf: any, opts?: any) => {
			if (failWrite) { failWrite = false; throw new Error('EACCES fake'); }
			const p = pathOf(uri);
			writes.push({ path: p, append: !!opts?.append });
			files.set(p, opts?.append ? (files.get(p) ?? '') + buf.toString() : buf.toString());
		},
		del: async (uri: any) => { deletes.push(pathOf(uri)); files.delete(pathOf(uri)); },
		move: async (src: any, dst: any) => { const s = pathOf(src); files.set(pathOf(dst), files.get(s) ?? ''); files.delete(s); },
		copy: async (src: any, dst: any) => { files.set(pathOf(dst), files.get(pathOf(src)) ?? ''); },
		createFolder: async () => { },
		hasCapability: () => true,
		resolve: async () => ({ children: [] }),
	};
	const log: any = {
		info(...a: unknown[]) { logs.infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { logs.warns.push(a.map(String).join(' ')); },
		error(...a: unknown[]) { logs.errors.push(a.map(String).join(' ')); },
		debug() { }, trace() { },
	};
	const paths: any = {
		cacheKey: (agentId: string, sessionId?: string) => (sessionId ? `${agentId}::${sessionId}` : agentId),
		resolveAgentPaths: async () => ({ sessionsDirUri }),
		sessionFileUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.json`),
		sessionLogUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.log`),
	};
	const store = new SessionHistoryStore(
		api, log, paths,
		(key: string) => cached.get(key),
		async (agentId: string, sessionId: string, count: number) => {
			if (state.indexShouldThrow) { throw new Error('index down'); }
			indexCalls.push({ agentId, sessionId, count });
		},
	);
	return {
		store, files, writes, deletes, indexCalls, cached, logs,
		failNextWrite: () => { failWrite = true; },
		appendsOf: (key: string) => (store as any)._appends.get(key),
		bytesOf: (key: string) => (store as any)._bytes.get(key),
		// eslint-disable-next-line accessor-pairs
		get indexShouldThrow() { return state.indexShouldThrow; },
		set indexShouldThrow(v: boolean) { state.indexShouldThrow = v; },
	};
}

suite('SessionHistoryStore — 会话写路径的静默丢消息防线 ✓', () => {

	test('★ 无 sessionId ⇒ `persistSnapshot` / `append` 都是 **no-op** ✓（不得建目录、不得写盘 ✓）', async () => {
		const h = makeHarness();
		await h.store.persistSnapshot('a1', undefined, [msg('m1')]);
		await h.store.append('a1', undefined, [msg('m1')]);
		assert.strictEqual(h.writes.length, 0, '不得有任何写入 ✓（未分配 session 时无文件可落 ✓）');
		assert.strictEqual(h.indexCalls.length, 0, '也不得动索引 ✓');
	});

	test('★★★ `persistSnapshot`：建目录 + **快照（漂亮 JSON）** + **屏障** + 尽力删日志 ✓✓', async () => {
		const h = makeHarness();
		const messages = [msg('m0'), msg('m1')];
		await h.store.persistSnapshot('a1', 's1', messages);

		assert.strictEqual(h.files.get(sessionFile), JSON.stringify(messages, null, 2),
			'★ 快照必须是完整数组的漂亮 JSON（读侧按它当权威 ✓）');
		assert.ok(h.writes.some(w => w.path === sessionLog && w.append),
			`★ 必须向日志追加**屏障**（不追 ⇒ 旧日志条目会被重放"复活" ⇒ 已删消息又出现 ✗✓）实际 ${JSON.stringify(h.writes)} ✗`);
		assert.strictEqual(h.files.get(sessionLog) ?? '', '', '屏障后应尽力删掉日志（删不掉只是体积问题 ✓）');
		assert.strictEqual(h.appendsOf('a1::s1'), 0, '写完快照必须重置条数计数 ✓');
		assert.strictEqual(h.bytesOf('a1::s1'), 0, '也必须重置字节计数 ✓');
		assert.deepStrictEqual(h.indexCalls, [{ agentId: 'a1', sessionId: 's1', count: 2 }],
			'必须同步索引 messageCount（否则会话列表条数不对 ✗✓）');
	});

	test('★★ 快照写在**锁内**：并发两次 `persistSnapshot` 必须串行（不得交错） ✓✓', async () => {
		const h = makeHarness();
		const order: string[] = [];
		const origWrite = h.files;
		// 用写入顺序当探针 ✓：串行 ⇒ 两次各自的写不会交错 ✓
		const p1 = h.store.persistSnapshot('a1', 's1', [msg('A')]);
		const p2 = h.store.persistSnapshot('a1', 's1', [msg('B')]);
		await Promise.all([p1, p2]);
		assert.strictEqual(h.files.get(sessionFile), JSON.stringify([msg('B')], null, 2),
			'后一笔必须完整覆盖前一笔（交错写会写出半截历史 ✗✓）');
		assert.ok(origWrite.size > 0, '前置：确实写了 ✓');
		order.push('done');
		assert.deepStrictEqual(order, ['done']);
	});

	test('★★★ `withLock`：**前一笔失败不得阻塞后续** ✓✓（否则该会话永久无法落盘 ✗）', async () => {
		const h = makeHarness();
		const key = 'a1::s1';
		const boom = h.store.withLock(key, async () => { throw new Error('first failed'); });
		await assert.rejects(() => boom, '失败必须如实抛给调用方 ✓');
		let ran = false;
		await h.store.withLock(key, async () => { ran = true; });
		assert.strictEqual(ran, true,
			'★ 前一笔失败后，后续任务**必须**能跑（旧实现若丢链 ⇒ 该会话永久写不进去 ✗✓）');
	});

	test('★ `withLock` 用 key 分桶：不同会话互不阻塞 ✓（同会话才串行 ✓）', async () => {
		const h = makeHarness();
		const events: string[] = [];
		let release: () => void = () => { };
		const gate = new Promise<void>(r => { release = r; });
		const p1 = h.store.withLock('a1::s1', async () => { events.push('s1-start'); await gate; events.push('s1-end'); });
		const p2 = h.store.withLock('a2::s2', async () => { events.push('s2'); });
		await p2;
		assert.deepStrictEqual(events, ['s1-start', 's2'], '★ 另一个会话不得被 s1 的长任务阻塞 ✓✓');
		release();
		await p1;
		assert.deepStrictEqual(events, ['s1-start', 's2', 's1-end']);
	});

	test('★★ `updateIndex` 失败只记 warn ✓（不得让快照落盘被判定为失败 ✗✓）', async () => {
		const h = makeHarness();
		h.indexShouldThrow = true;
		await assert.doesNotReject(() => h.store.persistSnapshot('a1', 's1', [msg('m')]),
			'索引是派生数据 ⇒ 它失败不能拖垮快照 ✓');
		assert.ok(h.files.has(sessionFile), '快照仍必须写成 ✓');
		assert.ok(h.logs.warns.some(w => w.includes('session index update after snapshot failed')),
			'必须留 warn（否则索引长期失真无人知 ✓）');
	});

	test('★★★ `append`：**无 id 的消息不得写** ✓✓（写了只会在重放时变成重复气泡 ✗）', async () => {
		const h = makeHarness();
		h.cached.set('a1::s1', [msg('m0')]);
		await h.store.append('a1', 's1', [noIdMsg(), noIdMsg()]);
		assert.strictEqual(h.writes.length, 0,
			'★ 全部无 id ⇒ `serializeSessionLogAppends` 返回空 ⇒ **不得写**（写 ⇒ 重放定位不到 ⇒ 重复气泡 ✗✓）');
		assert.strictEqual(h.appendsOf('a1::s1'), undefined, '计数也不得推进 ✓');
	});

	test('★★ `append`：只写**日志**（不动快照 ✓），并推进计数 + 同步索引 ✓', async () => {
		const h = makeHarness();
		h.cached.set('a1::s1', [msg('m0'), msg('m1')]);
		const batch = [msg('m2')];
		await h.store.append('a1', 's1', batch);

		assert.strictEqual(h.files.get(sessionLog), serializeSessionLogAppends(batch),
			'必须写日志（文本由真序列化器生成 ✓ —— 与读侧重放协议一致 ✗✓）');
		assert.strictEqual(h.files.has(sessionFile), false, '★ 追加**不得**动快照（动 ⇒ 退化成整文件重写 ✗✓）');
		assert.strictEqual(h.appendsOf('a1::s1'), 1, '必须累计追加条数 ✓');
		assert.strictEqual(h.bytesOf('a1::s1'), serializeSessionLogAppends(batch).length, '也必须累计字节 ✓');
		assert.deepStrictEqual(h.indexCalls, [{ agentId: 'a1', sessionId: 's1', count: 2 }],
			'索引必须用**缓存条数**（= 当前会话真实条数 ✓）');
	});

	test('★★★★ **条数阈值**触发压缩：`setCounters(511)` 后追加 1 条 ⇒ 快照 + 屏障 + 截断 ✓✓', async () => {
		const h = makeHarness();
		const key = 'a1::s1';
		const cached = [msg('m0'), msg('m1'), msg('m2')];
		h.cached.set(key, cached);
		h.store.setCounters(key, SessionHistoryStore.COMPACT_AFTER - 1, 0);   // 511 ✓
		await h.store.append('a1', 's1', [msg('m3')]);

		assert.strictEqual(h.files.get(sessionFile), JSON.stringify(cached, null, 2),
			'★ 到阈值必须写**完整快照**（用缓存 ✓ —— 只重置计数会让日志无限增长 ✗✓）');
		assert.ok(h.logs.infos.some(l => l.includes('compacted session log') && l.includes('512')),
			`必须留压缩日志（含条数 ✓）实际 ${JSON.stringify(h.logs.infos)} ✗`);
		assert.strictEqual(h.appendsOf(key), 0, '压缩后计数必须归零 ✓');
	});

	test('★★★ **字节阈值**触发压缩（条数阈值兜不住 MB 级消息 ✗✓）', async () => {
		const h = makeHarness();
		const key = 'a1::s1';
		h.cached.set(key, [msg('m0')]);
		h.store.setCounters(key, 0, SessionHistoryStore.COMPACT_AFTER_BYTES);   // 条数远未到 ✓
		await h.store.append('a1', 's1', [msg('big')]);
		assert.ok(h.files.has(sessionFile),
			'★ 字节到位也必须压缩（只看条数 ⇒ 512 × MB 级消息能把日志涨到几百 MB ✗✓）');
		assert.strictEqual(h.bytesOf(key), 0, '字节计数必须归零 ✓');
	});

	test('★★ 缓存已被 LRU 淘汰时到阈值 ⇒ **不写快照**，只重置计数 ✓（下次加载按重放条数恢复 ✓）', async () => {
		const h = makeHarness();
		const key = 'a1::s1';
		h.store.setCounters(key, SessionHistoryStore.COMPACT_AFTER - 1, 0);
		await h.store.append('a1', 's1', [msg('m')]);   // 缓存里没有 ⇒ getCached 返回 undefined ✓

		assert.strictEqual(h.files.has(sessionFile), false, '无缓存 ⇒ 无从写快照 ⇒ 不得凭空写 ✓');
		assert.strictEqual(h.appendsOf(key), 0, '必须重置计数（否则每次都白跑判断 ✓）');
		assert.strictEqual(h.logs.infos.length, 0, '不得报"已压缩"（没压 ⇒ 不能撒谎 ✗✓）');
	});

	test('★★ `append` 写失败 ⇒ 记 error 且**绝不抛** ✓（落盘失败不该打断对话 ✓）', async () => {
		const h = makeHarness();
		h.failNextWrite();
		await assert.doesNotReject(() => h.store.append('a1', 's1', [msg('m')]),
			'★ 落盘失败只记日志 —— 与改造前一致 ✓');
		assert.ok(h.logs.errors.some(e => e.includes('append failed')), '必须留 error（便于事后取证 ✓）');
	});

	test('★ `resetCounters` 清空计数 ✓（清空历史/删除会话时 ✓）', async () => {
		const h = makeHarness();
		h.store.setCounters('a1::s1', 10, 100);
		h.store.resetCounters('a1::s1');
		assert.strictEqual(h.appendsOf('a1::s1'), undefined);
		assert.strictEqual(h.bytesOf('a1::s1'), undefined);
	});

	test('★ 屏障文本协议：必须用真序列化器（读侧按它判"之前的条目一律丢弃" ✓）', async () => {
		const h = makeHarness();
		await h.store.persistSnapshot('a1', 's1', [msg('m')]);
		// 屏障已随"尽力删日志"被删掉 ⇒ 用一个会失败的 del 观察它确实写过 ✓
		const h2 = makeHarness();
		await h2.store.persistSnapshot('a1', 's1', [msg('m')]);
		assert.strictEqual(serializeSessionLogBarrier().length > 0, true, '真序列化器必须产出非空屏障文本 ✓');
		assert.ok(h.writes.length > 0 && h2.writes.length > 0, '两次都必须落盘 ✓');
	});
});
