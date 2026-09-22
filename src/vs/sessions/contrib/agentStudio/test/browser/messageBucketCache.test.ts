/*---------------------------------------------------------------------------------------------
 *  MessageBucketCache 专属行为基线（2026-09-22 阶段④-g P1/D-1 ✓）
 *
 *  为什么需要它 ✗✓：`messageBucketCache.ts`（533 行 ✓）持有**三条内存防线**（LRU 整桶淘汰 ✓ /
 *  淘汰前两段收敛 ✓ / 活跃桶压缩 ✓）与 **2026-07-13 内存爆掉**事故的修复 ✓，但原本只经
 *  「服务级端到端基线」间接覆盖 ✗ ⇒ 改动淘汰判据/保护名单可能**静默不红** ✗✓。
 *  这里把它当**纯对象**驱动 ✓（`logService` / `paths` / `deps` 全部用假的 ✓）⇒ 零 DOM、零文件 IO ✓。
 *
 *  ⚠ 断言全部**先读实现再写** ✓（上一轮 `streamAccumulator` 首跑 4 红全是猜的 ✗ ⇒ 已立规矩 ✓）。
 *  两条**实测**语义（容易猜错 ✗）：
 *    · `compactMessagesForEviction` 返回的是**被截断的工具结果条数** ✓，**不是**节省字节数 ✗；
 *    · 压缩后会按 `system → head → middle → tail` **重排** ✓（system 一律提前 ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { ChatMessage } from '../../common/types.js';
import { MessageBucketCache } from '../../browser/messageBucketCache.js';

const log = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any;

/**
 * 假 paths：只实现本类用到的 `cacheKey` ✓。
 * ⚠ 必须与 `AgentChatPaths.cacheKey` **逐字同规则** ✗✓（实测真规则 = `sessionId ? \`${agentId}::${sessionId}\` : agentId` ✓）。
 *   我首跑写成 `::(noSession)` 后缀 ✗ ⇒ noSession 桶也含 `::` ⇒ 被当成**会话桶**去计数并成了淘汰候选 ✗
 *   ⇒ 一次性假红两条 ✓（本文件因此加注：**假件必须照抄真件的判据** ✗✓，否则测的是假件不是产品 ✓）。
 */
const paths = { cacheKey: (agentId: string, sessionId?: string) => (sessionId ? `${agentId}::${sessionId}` : agentId) } as any;

function makeCache(opts: { open?: string[]; externalize?: () => Promise<number> } = {}) {
	const openKeys = new Set(opts.open ?? []);
	const calls = { externalize: [] as Array<{ agentId: string; sessionId: string }>, persisted: [] as string[] };
	const deps: any = {
		isOpen: (key: string) => openKeys.has(key),
		hasActiveStreams: () => false,
		persist: async (agentId: string, sessionId: string) => { calls.persisted.push(`${agentId}::${sessionId}`); },
		externalize: async (agentId: string, sessionId: string) => {
			calls.externalize.push({ agentId, sessionId });
			return opts.externalize ? await opts.externalize() : 0;
		},
	};
	const cache = new MessageBucketCache(log, paths, deps);
	return { cache, openKeys, calls };
}

const msg = (id: string, role: 'user' | 'assistant' | 'system', extra: any = {}): ChatMessage =>
	({ id, role, content: `c-${id}`, timestamp: '', ...extra } as ChatMessage);

/** 造一条带超长工具结果的 assistant 消息（中段压缩的靶子 ✓）。 */
const withLongToolResult = (id: string, len: number, toolId = `t-${id}`): ChatMessage =>
	msg(id, 'assistant', {
		toolCalls: [{ id: toolId, name: 'grep', arguments: '{}', result: 'x'.repeat(len), status: 'done' }],
	});

suite('MessageBucketCache — 三条内存防线契约（不依赖服务 ✓）', () => {

	test('★ `countSessionBuckets` 只数**会话桶**（key 含 `::` ✓）；noSession 系统桶不计入 ✓', () => {
		const { cache } = makeCache();
		cache.cache.set(paths.cacheKey('a1'), []);                 // noSession 桶 ⇒ 不算 ✗
		cache.cache.set(paths.cacheKey('a1', 's1'), []);
		cache.cache.set(paths.cacheKey('a2', 's2'), []);
		assert.strictEqual(cache.countSessionBuckets(), 2,
			'只数会话桶 ✓（noSession 桶无上限 ⇒ 计入会让上限逻辑误判 ✗✓）');
	});

	test('★ `touchBucket` 记录访问时间 ✓；`isBucketOpen` 委托宿主判据 ✓', () => {
		const { cache, openKeys } = makeCache({ open: ['a1::s1'] });
		const before = Date.now();
		cache.touchBucket('a1::s1');
		const t = cache.access.get('a1::s1');
		assert.ok(typeof t === 'number' && t >= before, '必须写入访问时间戳（LRU 依据 ✓）');
		assert.strictEqual(cache.isBucketOpen('a1::s1'), true, '打开的桶必须被识别（永不淘汰 ✓）');
		assert.strictEqual(cache.isBucketOpen('a1::s2'), false);
		openKeys.add('a1::s2');
		assert.strictEqual(cache.isBucketOpen('a1::s2'), true, '判据必须是**实时委托**（不能缓存旧状态 ✗✓）');
	});

	test('★★ `scoreBucketForEviction` 保留分：近期访问更高 ✓、消息更多更高 ✓、量纲符合公式 ✓', () => {
		const { cache } = makeCache();
		const now = Date.now();
		const fresh = cache.scoreBucketForEviction(now, 1);
		const stale = cache.scoreBucketForEviction(now - 10 * 86400_000, 1);
		assert.ok(fresh > stale, `刚访问过的桶保留分必须更高（fresh ${fresh} vs stale ${stale} ✗✓）`);
		const busy = cache.scoreBucketForEviction(now, 100);
		assert.ok(busy > fresh, '消息更多的桶保留分必须更高（activity 分量 ✓）');
		// 公式钉死 ✓（recency=1/(1+days*0.5) ⇒ ≈1；activity=log2(1+1)/10=0.1）⇒ 0.6*1 + 0.4*0.1 = 0.64 ✓
		assert.ok(Math.abs(fresh - 0.64) < 0.01,
			`保留分必须符合 0.6*recency + 0.4*activity（1 条消息、刚访问 ⇒ ≈0.64，实际 ${fresh} ✗）`);
	});

	test('★★★ `evictLruBucket` **只动会话桶**：noSession 桶与**打开的桶**永不淘汰 ✓✓', async () => {
		const openKey = paths.cacheKey('a2', 's2');
		const { cache, calls } = makeCache({ open: [openKey] });
		cache.cache.set(paths.cacheKey('sys'), [msg('m0', 'system')]);      // noSession ⇒ 保护 ✓
		cache.cache.set(openKey, [msg('m1', 'user')]);                       // 打开中 ⇒ 保护 ✓
		const victimKey = paths.cacheKey('a3', 's3');
		cache.cache.set(victimKey, [msg('m2', 'user')]);                     // 唯一候选 ⇒ 必被淘汰 ✓
		cache.touchBucket(paths.cacheKey('sys'));
		cache.touchBucket(openKey);
		cache.touchBucket(victimKey);

		await cache.evictLruBucket();
		assert.strictEqual(cache.cache.has(victimKey), false, '唯一的会话候选必须被淘汰 ✓');
		assert.strictEqual(cache.cache.has(paths.cacheKey('sys')), true, '★ noSession 系统桶**永不淘汰** ✗✓');
		assert.strictEqual(cache.cache.has(openKey), true, '★ 打开的桶（流式中）**永不淘汰** ✗✓（否则流中途丢历史 ✗）');
		assert.deepStrictEqual(calls.externalize, [{ agentId: 'a3', sessionId: 's3' }],
			'淘汰前必须按 key 切出 agentId/sessionId 做 P1 外置 ✓（切错 ⇒ 全文落到别的会话 ✗✓）');
		assert.strictEqual(cache.access.has(victimKey), false, '淘汰必须同时清掉 `access` 记录 ✓（否则残留会让上限判断虚高 ✗✓）');
		// ★ 实测：P1/P2 **都没改动到东西**（externalize 返回 0 ✓、消息数 < 20 无需压缩 ✓）⇒ `dirty=false`
		//   ⇒ **不得落盘** ✗✓（否则每次淘汰都全量重写会话文件 ⇒ 正是 2026-09-11 卡死事故的形态 ✗）。
		assert.strictEqual(calls.persisted.length, 0,
			`无改动时**不得**触发落盘（实际 ${calls.persisted.length} 次 ✗✓ —— 淘汰不该顺带全量重写 ✗）`);
	});

	test('★★★ `evictLruBucket` 只在**确有改动**（P1 外置或 P2 压缩）时才落盘 ✓✓', async () => {
		const { cache, calls } = makeCache({ externalize: async () => 1 });   // 模拟 P1 外置了 1 处 ✓
		const victimKey = paths.cacheKey('a4', 's4');
		cache.cache.set(victimKey, [msg('m', 'user')]);
		cache.touchBucket(victimKey);
		await cache.evictLruBucket();
		assert.deepStrictEqual(calls.persisted, ['a4::s4'],
			`P1 改动了内容 ⇒ 必须落盘让**磁盘同时收敛** ✓（实际 ${JSON.stringify(calls.persisted)} ✗）`);
		assert.strictEqual(cache.cache.has(victimKey), false, '落盘后仍必须从内存淘汰 ✓');
	});

	test('★★ `evictIfNeeded` 把会话桶收敛到上限 ✓（`MAX_CACHED_SESSION_BUCKETS` = 15 ✓）', async () => {
		const { cache } = makeCache();
		for (let i = 0; i < 18; i++) {
			const k = paths.cacheKey('a', `s${i}`);
			cache.cache.set(k, [msg(`m${i}`, 'user')]);
			cache.touchBucket(k);
		}
		await cache.evictIfNeeded();
		assert.strictEqual(cache.countSessionBuckets(), 15,
			`必须收敛到上限（实际 ${cache.countSessionBuckets()} ✗ —— 超限即 2026-07-13 式内存无界增长 ✗✓）`);
	});

	test('★★★ `compactMessagesForEviction`：中段超长工具结果截到 280 ✓、头尾**逐字保护** ✓、返回**截断条数** ✓', () => {
		const { cache } = makeCache();
		// 1 system + 3 保护头 + 6 中段 + 15 保护尾 = 25 条 ✓（≥ COMPACT_MIN_MESSAGES=20 ✓）
		const head0 = withLongToolResult('h0', 900);
		const midWithLong = withLongToolResult('mid1', 900);
		const tailLast = withLongToolResult('t14', 900);
		const messages: ChatMessage[] = [
			msg('sys', 'system'),
			head0, msg('h1', 'user'), msg('h2', 'user'),
			midWithLong, msg('mid2', 'user'), msg('mid3', 'user'), msg('mid4', 'user'), msg('mid5', 'user'), msg('mid6', 'user'),
			...Array.from({ length: 14 }, (_, i) => msg(`t${i}`, 'user')),
			tailLast,
		];
		const truncated = cache.compactMessagesForEviction(messages);

		assert.strictEqual(truncated, 1,
			`必须返回**被截断的工具结果条数** ✓（实际 ${truncated} ✗ —— 不是字节数 ✗，宿主日志按它报数 ✓）`);
		const b = messages.find(m => m.id === 'mid1') as any;
		assert.strictEqual(b.toolCalls[0].result.length, MessageBucketCache.COMPACT_RESULT_TRUNCATE,
			'中段工具结果必须被截到 280 ✓（本地确定性、不调 LLM ✓）');
		const h = messages.find(m => m.id === 'h0') as any;
		assert.strictEqual(h.toolCalls[0].result.length, 900, '★ 保护头**逐字不动** ✗✓（动了会丢早期关键上下文 ✓）');
		const t = messages.find(m => m.id === 't14') as any;
		assert.strictEqual(t.toolCalls[0].result.length, 900, '★ 保护尾**逐字不动** ✗✓（动了模型就丢了最近结果 ✓）');
		assert.strictEqual(messages[0].role, 'system', '★ 重建后 **system 必须排在最前** ✓');
		assert.deepStrictEqual(
			messages.filter(m => m.role !== 'system').map(m => m.id),
			['h0', 'h1', 'h2', 'mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6',
				...Array.from({ length: 14 }, (_, i) => `t${i}`), 't14'],
			'重建后必须保持 system → head → middle → tail 的**原相对顺序** ✓（乱序 ⇒ 因果链错乱 ✗✓）');
	});

	test('★ `compactMessagesForEviction` 对**短会话**与「头尾已覆盖全部」都返回 0 且**不动** ✓', () => {
		const { cache } = makeCache();
		const short = Array.from({ length: 19 }, (_, i) => withLongToolResult(`s${i}`, 900));
		assert.strictEqual(cache.compactMessagesForEviction(short), 0,
			'不足 20 条必须原样保留 ✓（短会话压缩只有副作用 ✗✓）');
		assert.strictEqual((short[0].toolCalls![0] as any).result.length, 900, '且不得改动内容 ✓');

		// ⚠ 首跑算错过 ✓：20 条**全对话**时 `slice(3, 20-15=5)` **仍有中段** ✗ ⇒ 返回 2 不是 0 ✓。
		//   要命中「头尾已覆盖全部」分支，必须让**对话条数 ≤ 3+15=18** ✓（总条数仍 ≥ 20 ✓）。
		//   这里用 2 system + 18 conversation = 20 ✓，并把 system 放**开头** ⇒ 重建后顺序不变 ✓。
		const covered: ChatMessage[] = [
			msg('cs0', 'system'), msg('cs1', 'system'),
			...Array.from({ length: 18 }, (_, i) => withLongToolResult(`c${i}`, 900)),
		];
		const before = JSON.stringify(covered);
		assert.strictEqual(cache.compactMessagesForEviction(covered), 0,
			'18 条对话 = 头 3 + 尾 15 已覆盖全部 ⇒ 无中段可压 ⇒ 必须返回 0 ✓');
		assert.strictEqual(JSON.stringify(covered), before,
			'且不得重排、不得截断（无中段时重建等于原序 ✓ —— 多动一次就是白改用户历史 ✗✓）');
	});

	test('★ `stopMemWatch` 幂等且安全 ✓（宿主 dispose 时会调用 ✓）', () => {
		const { cache } = makeCache();
		assert.doesNotThrow(() => { cache.stopMemWatch(); cache.stopMemWatch(); },
			'未启动/重复停止都必须安全（宿主销毁路径不能抛 ✗✓）');
		assert.strictEqual((cache as any)._memWatchTimer, null, '停止后定时器必须为 null ✓');
	});

	// ─── dropBucket：压缩后释放内存副本的安全接口（2026-09-22 ✓）───────────────────
	// ⚠ 背景：现成的 `evictLruBucket` 在 dirty 时会 `persist`（**整会话文件重写** ✗）—— 那是
	//   2026-09-11「每次追加都全量重写 ⇒ 卡死 2.5 分钟」事故的形态 ✗✓。所以"丢内存桶"必须是
	//   **独立的、零 IO 的**动作 ✓，下面第一条就是钉这件事 ✓✓。

	test('★★★ `dropBucket` 只丢内存桶 ✓ **不落盘、不外置、不重写文件** ✓✓（9-11 事故形态的护栏 ✓）', () => {
		const { cache, calls } = makeCache();
		const key = paths.cacheKey('a1', 's1');
		cache.cache.set(key, [msg('m', 'user')]);
		cache.touchBucket(key);
		assert.strictEqual(cache.dropBucket('a1', 's1'), true, '键存在 ⇒ 必须返回 true ✓');
		assert.strictEqual(cache.cache.has(key), false, '桶必须被移除 ✓（内存释放 ✓）');
		assert.strictEqual(cache.access.has(key), false, '`access` 记录也必须清 ✓（残留会让上限判断虚高 ✗✓）');
		// ★ 安全核心：绝不能"顺手落盘" ✗ —— dropBucket 的全部副作用只有两次 Map.delete ✓
		assert.strictEqual(calls.persisted.length, 0,
			'**不得**触发任何 persist ✓✓（一旦落盘就是整会话重写 ⇒ 9-11 卡死形态 ✗）');
		assert.strictEqual(calls.externalize.length, 0, '**不得**触发 P1 外置 ✓（那是淘汰路径的事 ✓）');
		assert.strictEqual(cache.dropBucket('a1', 's2'), false, '不存在的桶 ⇒ 返回 false 且安全 ✓');
	});

	test('★★ 丢桶必须同时退出 `countSessionBuckets` 计数 ✓（否则 LRU 上限被虚高带偏 ✗✓）', () => {
		const { cache } = makeCache();
		cache.cache.set(paths.cacheKey('a1', 's1'), []);
		cache.cache.set(paths.cacheKey('a2', 's2'), []);
		assert.strictEqual(cache.countSessionBuckets(), 2);
		cache.dropBucket('a1', 's1');
		assert.strictEqual(cache.countSessionBuckets(), 1, '丢桶必须同时退出计数 ✓');
	});

	test('★ `dropBucket` 支持 noSession 桶（省略 sessionId ⇒ 键 = agentId ✓）', () => {
		const { cache } = makeCache();
		const key = paths.cacheKey('a1');
		cache.cache.set(key, []);
		assert.strictEqual(cache.dropBucket('a1'), true);
		assert.strictEqual(cache.cache.has(key), false);
	});
});
