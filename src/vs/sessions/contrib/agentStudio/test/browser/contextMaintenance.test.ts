/*---------------------------------------------------------------------------------------------
 *  ContextMaintenance 专属行为基线（2026-09-22 阶段④-g P1/D-8 ✓）
 *
 *  为什么需要它 ✗✓：`contextMaintenance.ts`（309 行 ✓）是「模型视野」的运维面 ✓，三条语义**都对应事故** ✓：
 *   · **失忆取证三分** ✗✓ —— `priorMessages` 为 0 时旧日志只有一行 `priorMsgs=0` ⇒ 排查只能猜 ✓；
 *     三种成因（真空 ✓ / 被过滤裁光 ✓ / **session key 不匹配** ✗✗）必须分开 ✓；
 *   · **手动压缩走同一条管线** ✓ —— `force=true` 只跳触发门槛 ✓，守卫（要点/饥饿/窗口收缩）**照常生效**，
 *     **摘要不合格就不落盘** ✓（不合格产物不落地 ✓）；
 *   · **推迟压缩的竞态防护** ✗✓ —— 摘要跑数秒，期间新消息落盘会让插入点失效 ⇒ 必须**在会话写锁内重读并校验尾部** ✓，
 *     变了就**放弃**（摘要丢弃无妨 ✓ 下轮重判 ✓）。
 *  这里把它当**纯对象**驱动 ✓（IO / driver / 路径学 / 两条历史读写全部用假的 ✓）。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；假件照抄真件判据 ✓（`cacheKey` 用真规则 ✓、边界标记用真常量 ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ContextMaintenance } from '../../browser/contextMaintenance.js';
import { COMPACTION_METADATA_TYPE } from '../../common/historyCompaction.js';
import type { ChatMessage } from '../../common/types.js';

const sessionsDirUri = URI.file('/tmp/fake-sessions');

const msg = (id: string, content = `c-${id}`, extra: any = {}): ChatMessage =>
	({ id, role: 'assistant', content, timestamp: '', ...extra } as ChatMessage);
const boundaryMsg = (id: string): ChatMessage =>
	msg(id, '摘要', { metadata: { type: COMPACTION_METADATA_TYPE } });

interface IHarness {
	c: ContextMaintenance;
	logs: { infos: string[]; warns: string[]; traces: string[] };
	persisted: ChatMessage[][];
	/** 记录 setCachedMessages 的 key 与内容 ✓ */
	cached: Array<{ key: string; count: number }>;
	lockKeys: string[];
	snapshots: ChatMessage[][];
	driverCalls: any[];
	/** 装载器返回什么 ⇒ `setRaw(messages)` ✓（推迟压缩用两次读 ⇒ 可 `setRaw` 两次模拟竞态 ✓） */
	setRaw(messages: ChatMessage[]): void;
	/** 让后续装载返回新的数组（模拟"摘要期间落了新消息" ✓） */
	setReplay(messages: ChatMessage[]): void;
	driverResult: any;
	fileExists: Set<string>;
	fileText: Map<string, string>;
}

function makeHarness(): IHarness {
	const logs = { infos: [] as string[], warns: [] as string[], traces: [] as string[] };
	const persisted: ChatMessage[][] = [];
	const cached: Array<{ key: string; count: number }> = [];
	const lockKeys: string[] = [];
	const snapshots: ChatMessage[][] = [];
	const driverCalls: any[] = [];
	let raw: ChatMessage[] = [];
	let replay: ChatMessage[] | null = null;
	const fileExists = new Set<string>();
	const fileText = new Map<string, string>();
	const state: any = { driverResult: { didCompact: false, skipReason: 'below-threshold' } };

	const log: any = {
		info(...a: unknown[]) { logs.infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { logs.warns.push(a.map(String).join(' ')); },
		trace(...a: unknown[]) { logs.traces.push(a.map(String).join(' ')); },
		error() { }, debug() { },
	};
	const deps: any = {
		logService: log,
		fileService: {
			exists: async (uri: any) => fileExists.has(uri.fsPath),
			readFile: async (uri: any) => ({ value: { toString: () => fileText.get(uri.fsPath) ?? '' } }),
		},
		paths: {
			resolveAgentPaths: async () => ({ sessionsDirUri }),
			sessionFileUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.json`),
			sessionLogUri: (_dir: URI, sessionId: string) => URI.joinPath(sessionsDirUri, `${sessionId}.log`),
			// ⚠ 照抄真规则 ✓：`sessionId ? \`a::s\` : a` ✓
			cacheKey: (agentId: string, sessionId?: string) => (sessionId ? `${agentId}::${sessionId}` : agentId),
		},
		// ⚠ 2026-09-22：上游把 `compactMessagesForSession` 从 driver 迁走 ⇒ 本模块改为**回调注入** ✓
		//   （见 `IContextMaintenanceDeps.compactMessages` 注释 ✓）。测试两处都提供 ✓：
		//   `compactMessages` 是**真正被调用**的那个 ✓，`driverService` 仅为兼容保留 ✓。
		compactMessages: async (args: any) => { driverCalls.push(args); return state.driverResult; },
		driverService: {
			compactMessagesForSession: async (args: any) => { driverCalls.push(args); return state.driverResult; },
		},
		loadFromSessionFile: async () => {
			if (replay) { const r = replay; replay = null; return r; }
			return raw;
		},
		persistToSessionFile: async (_a: string, _s: string | undefined, messages: ChatMessage[]) => { persisted.push(messages); },
		setCachedMessages: (key: string, messages: ChatMessage[]) => { cached.push({ key, count: messages.length }); },
		buildCompactionBoundaryMessage: (_a: string, _s: string | undefined, pending: any) =>
			boundaryMsg(`b_${pending.originalCount}_${pending.compressedCount}`),
		withSessionLogLock: async (key: string, fn: () => Promise<any>) => { lockKeys.push(key); return fn(); },
		writeSessionSnapshotLocked: async (_a: string, _s: string, _dir: URI, messages: readonly ChatMessage[]) => {
			snapshots.push([...messages]);
		},
	};
	const c = new ContextMaintenance(deps);
	return {
		c, logs, persisted, cached, lockKeys, snapshots, driverCalls,
		setRaw(m: ChatMessage[]) { raw = m; },
		setReplay(m: ChatMessage[]) { replay = m; },
		get driverResult() { return state.driverResult; },
		set driverResult(v: any) { state.driverResult = v; },
		fileExists, fileText,
	};
}

const sendOpts = { agentSessionId: 's1' } as any;
/** 造 n 条可压缩历史（不含边界 ✓）。 */
const history = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i}`));

suite('ContextMaintenance — 失忆取证（三种成因必须分开 ✓）', () => {

	test('★★★ sessionId 缺失 ⇒ 明确提示"这是新会话/未分配 session 路径" ✓（不得含糊 ✓）', async () => {
		const h = makeHarness();
		await h.c.diagnoseEmptyPriorMessages('a1', undefined, 0);
		assert.strictEqual(h.logs.warns.length, 1);
		assert.ok(h.logs.warns[0].includes('sessionId 缺失'), `必须点明 sessionId 缺失（实际「${h.logs.warns[0]}」✗）`);
		assert.ok(h.logs.warns[0].includes('agentId=a1'), '必须带 agentId（排查要对号 ✓）');
	});

	test('★★★ 桶空但**盘上有内容** ⇒ 必须点出"疑似 session key 不匹配" ✗✗（模型失忆最可能的形态 ✓）', async () => {
		const h = makeHarness();
		h.fileExists.add(URI.joinPath(sessionsDirUri, 's1.json').fsPath);
		h.fileText.set(URI.joinPath(sessionsDirUri, 's1.json').fsPath, JSON.stringify(history(7)));
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		const w = h.logs.warns.join(' | ');
		assert.ok(w.includes('session key 不匹配'), `必须点名 key 不匹配（实际「${w}」✗✓ —— 否则排查只能猜 ✓）`);
		assert.ok(w.includes('snapshot=7'), '必须报盘上快照条数（越具体越好查 ✓）');
		assert.ok(w.includes('a1::s1'), '必须报本次用的 key ✓');
	});

	test('★★ 历史有 N 条却组装出 0 条 ⇒ 必须点出"被过滤/裁剪" ✓（并提示查压缩边界 ✓）', async () => {
		const h = makeHarness();
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 12);
		const w = h.logs.warns.join(' | ');
		assert.ok(w.includes('过滤/裁剪'), `必须点出被过滤/裁剪（实际「${w}」✗）`);
		assert.ok(w.includes('compaction'), '必须指引排查压缩边界消息 ✓');
		assert.ok(w.includes('12'), '必须报历史条数 ✓');
	});

	test('★ 真空（桶空 + 盘上无文件）⇒ 只记 **info** ✓（这是正常情形 ⇒ 不得报警 ≠ ✗✓）', async () => {
		const h = makeHarness();
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		assert.strictEqual(h.logs.warns.length, 0, '真空不得 warn（会淹没真问题 ✗✓）');
		assert.strictEqual(h.logs.infos.length, 1);
		assert.ok(h.logs.infos[0].includes('确实还没有历史'), '必须明确说"正常" ✓');
		assert.ok(!h.logs.infos[0].includes('不匹配'), '且不得误报 key 不匹配 ✓');
	});

	test('★★★ 日志只有**屏障行**（会话引导写入的结构标记）⇒ 不得误报 key 不匹配 ✗✓（2026-09-22 真机假警报）', async () => {
		// 真机现场（bridge/feishu 首条消息）：snapshot=0 条 + logLines=1 行 —— 那 1 行是
		// 屏障 `{"op":"base"}`，不是消息内容 ✗。旧判据 `logLines > 0` 把它当成"盘上有内容"
		// ⇒ 对**全新的桥接会话**报"疑似 session key 不匹配" ✗✗（假警报淹没真问题 ✗）。
		const h = makeHarness();
		const logPath = URI.joinPath(sessionsDirUri, 's1.log').fsPath;
		h.fileExists.add(logPath);
		h.fileText.set(logPath, JSON.stringify({ op: 'base', ts: 1 }) + '\n');   // 仅屏障一行
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		assert.strictEqual(h.logs.warns.length, 0,
			`屏障行不算"盘上有内容" ⇒ 不得报 key 不匹配（实际 warns=${JSON.stringify(h.logs.warns)} ✗✓）`);
		assert.ok(h.logs.infos.some(l => l.includes('确实还没有历史')), '应按"真空"记 info ✓');

		// 对照组：屏障 + **真消息** ⇒ 仍必须报 key 不匹配 ✓（精确化不得把真问题也放过 ✗✗）
		const h2 = makeHarness();
		h2.fileExists.add(logPath);
		h2.fileText.set(logPath,
			JSON.stringify({ op: 'base', ts: 1 }) + '\n' +
			JSON.stringify({ op: 'append', messages: [{ id: 'm1', role: 'user', content: 'hi' }] }) + '\n');
		await h2.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		assert.ok(h2.logs.warns.some(w => w.includes('session key 不匹配')),
			'盘上确有消息内容 ⇒ 仍必须报 key 不匹配 ✓（精确化只排除屏障行 ✓）');
	});

	test('★★★ 日志里那 1 行是**本轮自己的 user 消息**（fire-and-forget 竞态）⇒ 不得误报 key 不匹配 ✗✓（2026-09-22 第二轮真机）', async () => {
		// 真机现场（sess_… 首条消息）：sendMessage 里 appendMessage 不 await ⇒ 磁盘探针
		// 可能跑在"本条消息已写进 jsonl"之后 ⇒ logLines=1 其实是**它自己** ✗✗。
		// 旧判据把它当成"盘上有别人的内容" ⇒ 对全新会话报"疑似 key 不匹配"（假警报 ✗）。
		const h = makeHarness();
		const logPath = URI.joinPath(sessionsDirUri, 's1.log').fsPath;
		h.fileExists.add(logPath);
		// 真实序列化形态（serializeSessionLogAppends）：{"op":"a","msg":{…}} ✓
		h.fileText.set(logPath,
			JSON.stringify({ op: 'base', ts: 1 }) + '\n' +
			JSON.stringify({ op: 'a', msg: { id: 'm1', role: 'user', content: 'hi' } }) + '\n');
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 0, 'hi');
		assert.strictEqual(h.logs.warns.length, 0,
			`本轮自己的消息必须被排除 ⇒ 不得报 key 不匹配（实际 warns=${JSON.stringify(h.logs.warns)} ✗✓）`);
		assert.ok(h.logs.infos.some(l => l.includes('确实还没有历史')), '应按"真空"记 info ✓');

		// 对照组①：内容**不同**的 user 消息 ⇒ 是别人的内容 ⇒ 仍报 key 不匹配 ✓
		const h2 = makeHarness();
		h2.fileExists.add(logPath);
		h2.fileText.set(logPath,
			JSON.stringify({ op: 'a', msg: { id: 'm1', role: 'user', content: 'hi' } }) + '\n');
		await h2.c.diagnoseEmptyPriorMessages('a1', 's1', 0, '完全不同的消息');
		assert.ok(h2.logs.warns.some(w => w.includes('session key 不匹配')),
			'内容不同 ⇒ 不得排除 ⇒ 仍必须报 key 不匹配 ✓');

		// 对照组②：同内容但 **assistant** 角色 ⇒ 不排除（user 消息针只打 user ✓）仍报 ✓
		const h3 = makeHarness();
		h3.fileExists.add(logPath);
		h3.fileText.set(logPath,
			JSON.stringify({ op: 'a', msg: { id: 'm1', role: 'assistant', content: 'hi' } }) + '\n');
		await h3.c.diagnoseEmptyPriorMessages('a1', 's1', 0, 'hi');
		assert.ok(h3.logs.warns.some(w => w.includes('session key 不匹配')),
			'assistant 的同内容消息不是本轮 user 消息 ⇒ 仍必须报 key 不匹配 ✓');

		// 对照组③：不传 currentMessage（旧调用形态）⇒ 不排除 ⇒ 仍报 ✓（行为不悄悄变 ✗✓）
		const h4 = makeHarness();
		h4.fileExists.add(logPath);
		h4.fileText.set(logPath,
			JSON.stringify({ op: 'a', msg: { id: 'm1', role: 'user', content: 'hi' } }) + '\n');
		await h4.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		assert.ok(h4.logs.warns.some(w => w.includes('session key 不匹配')),
			'未传 currentMessage ⇒ 保持旧判据（仍报）✓');
	});

	test('★ 取证本身失败 ⇒ 降级为 warn 且**绝不抛** ✓（不能影响发送主路径 ✓）', async () => {
		const h = makeHarness();
		(h.c as any).deps.paths.resolveAgentPaths = async () => { throw new Error('boom'); };
		await assert.doesNotReject(() => h.c.diagnoseEmptyPriorMessages('a1', 's1', 0), '取证失败绝不影响发送 ✓');
		assert.ok(h.logs.warns.some(w => w.includes('取证失败')), '必须留下一次可见的降级提示 ✓');
	});

	test('★ 快照文件"存在但不是数组" ⇒ 记 **-2** ✓；"解析就抛" ⇒ 记 **-3** ✓（都与"0 条"区分 ✓✓）', async () => {
		const h = makeHarness();
		const p = URI.joinPath(sessionsDirUri, 's1.json').fsPath;
		h.fileExists.add(p);
		h.fileText.set(p, '{}');                       // 合法 JSON 但**不是数组** ⇒ -2 ✓
		await h.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		const all = [...h.logs.infos, ...h.logs.warns].join(' | ');
		assert.ok(all.includes('snapshot=-2'),
			`"不是数组"必须记 -2（实际「${all}」✗✓ —— 与"空"区分才能定位 ✓）`);

		const h2 = makeHarness();
		h2.fileExists.add(p);
		h2.fileText.set(p, '{ 这不是 JSON');           // 解析抛 ⇒ -3 ✓
		await h2.c.diagnoseEmptyPriorMessages('a1', 's1', 0);
		const all2 = [...h2.logs.infos, ...h2.logs.warns].join(' | ');
		assert.ok(all2.includes('snapshot=-3'),
			`解析抛异常必须记 -3（实际「${all2}」✗✓ —— 三个哨兵值各自可区分 ✓）`);
	});
});

suite('ContextMaintenance — 手动压缩（/compact 与 /compact-reset ✓）', () => {

	test('★★ 无会话上下文 ⇒ 提示且**不落盘** ✓；空历史 ⇒ 提示且**不落盘** ✓', async () => {
		const h = makeHarness();
		const r1 = await h.c.handleCompactSlashCommand('a1', 'compact', '', {} as any);
		assert.ok(r1.content.includes('需要在已存在的会话中使用'), '必须解释清楚为什么不能压 ✓');
		assert.strictEqual(h.persisted.length, 0, '不得落盘（无 session 无从落 ✓）');

		const h2 = makeHarness();
		h2.setRaw([]);
		const r2 = await h2.c.handleCompactSlashCommand('a1', 'compact', '', sendOpts);
		assert.ok(r2.content.includes('还没有历史消息'), '空历史必须明确回复 ✓');
		assert.strictEqual(h2.persisted.length, 0, '不得落盘 ✓');
	});

	test('★★ `compact-reset` 无边界 ⇒ 提示无需重置且**不落盘** ✓；有边界 ⇒ 删边界后**落盘 + 回填桶** ✓✓', async () => {
		const h = makeHarness();
		h.setRaw([msg('m0'), msg('m1')]);
		const r0 = await h.c.handleCompactSlashCommand('a1', 'compact-reset', '', sendOpts);
		assert.ok(r0.content.includes('没有压缩边界'), '无边界的会话必须明确"无需重置" ✓');
		assert.strictEqual(h.persisted.length, 0, '无改动 ⇒ 不得落盘 ✓（避免无谓全量重写 ✗✓）');

		const h2 = makeHarness();
		const raw = [msg('m0'), boundaryMsg('b1'), msg('m1'), boundaryMsg('b2')];
		h2.setRaw(raw);
		const r = await h2.c.handleCompactSlashCommand('a1', 'compact-reset', '', sendOpts);
		assert.strictEqual(h2.persisted.length, 1, '必须落盘 ✓（命令回复作为操作记录留在 transcript ✓）');
		const written = h2.persisted[0];
		assert.deepStrictEqual(written.map(m => m.id).slice(0, 2), ['m0', 'm1'],
			'必须按原序保留非边界消息 ✓（边界之外的相对顺序不得变 ✓）');
		assert.strictEqual(written.length, 3, '= 2 条保留 + 1 条命令回复 ✓');
		assert.strictEqual(written[2].role, 'assistant', '最后一条必须是命令回复 ✓');
		assert.strictEqual(written.filter(m => m.metadata?.type === COMPACTION_METADATA_TYPE).length, 0,
			'★ 落盘内容里**不得再有**边界消息 ✓（下一条消息起模型重新看到完整历史 ✓）');
		assert.ok(r.content.includes('已移除 2 条压缩边界'), `回复必须报移除条数（实际「${r.content.slice(0, 50)}」✗）`);
		assert.ok(r.content.includes('重新看到完整历史'),
			'必须让用户理解"下一条起恢复完整视野" ✓（否则会以为数据被删 ✓）');
		assert.deepStrictEqual(h2.cached, [{ key: 'a1::s1', count: written.length }],
			'★ 必须回填内存桶（命令改写了历史 ⇒ 内存权威必须同步 ✗✓）');
	});

	test('★★ `compact`：可见消息 < 4 ⇒ 直接提示"没什么可压缩的" ✓ 且**不调 driver** ✓', async () => {
		const h = makeHarness();
		h.setRaw(history(3));
		const r = await h.c.handleCompactSlashCommand('a1', 'compact', '', sendOpts);
		assert.ok(r.content.includes('没什么可压缩的'), '必须明确回复原因 ✓');
		assert.strictEqual(h.driverCalls.length, 0, '★ 不足门槛时**不得**调用压缩管线 ✓');
		assert.strictEqual(h.persisted.length, 0, '不得落盘 ✓');
	});

	test('★★★ 摘要不合格（didCompact=false）⇒ 明确回复 skipReason 且**不落盘** ✓✓（不合格产物不落地 ✓）', async () => {
		const h = makeHarness();
		h.setRaw(history(30));
		h.driverResult = { didCompact: false, skipReason: '要点守卫：摘要丢掉了关键约束' };
		const r = await h.c.handleCompactSlashCommand('a1', 'compact', '', sendOpts);
		assert.ok(r.content.includes('要点守卫：摘要丢掉了关键约束'), '必须把守卫原因原样告知用户 ✓');
		assert.ok(r.content.includes('不会落盘'), '必须说明"不合格不落盘"这一保护 ✓');
		assert.strictEqual(h.persisted.length, 0, '★ 不得落盘 ✓（落盘 ⇒ 上下文被坏摘要裁没 ✗✓）');
		assert.strictEqual(h.cached.length, 0, '也不得回填桶 ✓');
	});

	test('★★★ `compact` 成功：边界插在「倒数 tailCount 条之前」✓✓、focus 透传 ✓、回复报数 ✓', async () => {
		const h = makeHarness();
		const raw = history(30);
		h.setRaw(raw);
		h.driverResult = { didCompact: true, originalCount: 26, compressedCount: 1, tokensSaved: 1234, summary: '摘要正文', summaryChars: 42, tailCount: 6 };
		const r = await h.c.handleCompactSlashCommand('a1', 'compact', '只保留接口约定', sendOpts);

		assert.strictEqual(h.driverCalls.length, 1);
		assert.strictEqual(h.driverCalls[0].agentId, 'a1');
		assert.strictEqual(h.driverCalls[0].focus, '只保留接口约定', 'focus 必须透传给压缩管线 ✓');
		assert.strictEqual(h.driverCalls[0].messages.length, 30, '输入应是"当前模型视野"（无边界 ⇒ 全量 ✓）');

		const written = h.persisted[0];
		const boundaryIdx = written.findIndex(m => m.metadata?.type === COMPACTION_METADATA_TYPE);
		assert.strictEqual(boundaryIdx, 30 - 6,
			`★ 边界必须插在原始历史倒数 6 条**之前**（实际下标 ${boundaryIdx} ✗✓ —— 插错 ⇒ 回放时 boundary+tail 不是模型视野 ✓）`);
		assert.strictEqual(written.length, 32,
			'= 原 30 条 + 1 条边界 + 1 条命令回复 ✓（实测口径 ✓）');
		assert.ok(written[written.length - 1].content.includes('已手动压缩本会话'),
			'最后一条必须是命令回复（操作记录留在 transcript ✓）');
		assert.ok(r.content.includes('1234'), '回复必须报预计节省 tokens ✓');
		assert.ok(r.content.includes('压缩重点：只保留接口约定'), '有 focus 时必须回显（让用户确认 ✓）');
		assert.ok(r.content.includes('/compact-reset'), '必须告知撤销入口 ✓');
	});

	test('★★ `compact` 的 focus 过长必须**截断 200** ✓（避免回复本身撑爆 transcript ✓）；空 focus ⇒ 传 undefined ✓', async () => {
		const h = makeHarness();
		h.setRaw(history(10));
		h.driverResult = { didCompact: true, originalCount: 6, compressedCount: 1, tokensSaved: 10, summary: 's', summaryChars: 1, tailCount: 4 };
		const long = '重点'.repeat(200);
		await h.c.handleCompactSlashCommand('a1', 'compact', long, sendOpts);
		assert.strictEqual(h.driverCalls[0].focus, long, 'driver 侧应收到**完整** focus（截断只发生在用户可见回复 ✓）');
		const r = h.persisted[0][h.persisted[0].length - 1];
		assert.ok(r.content.includes('重点'.repeat(100)), '回复应含截断后的 focus ✓');

		const h2 = makeHarness();
		h2.setRaw(history(10));
		h2.driverResult = { didCompact: false, skipReason: 'no-need' };   // 只在"无 focus"分支上验证 ⇒ 不必触发落盘 ✓
		const r2 = await h2.c.handleCompactSlashCommand('a1', 'compact', '', sendOpts);
		assert.strictEqual(h2.driverCalls[0].focus, undefined,
			'空 focus 必须传 undefined（传空串会让压缩器以为是"指定了重点" ✗✓）');
		assert.ok(!r2.content.includes('压缩重点'), '无 focus 时回复里不得出现该段 ✓');
	});
});

suite('ContextMaintenance — 推迟压缩（竞态防护 ✓✓）', () => {

	const okResult = { didCompact: true, originalCount: 20, compressedCount: 1, tokensSaved: 500, summary: 's', summaryChars: 3, tailCount: 5 };

	test('★ 无 sessionId / 历史不足 4 条 ⇒ 直接返回且**不调 driver** ✓', async () => {
		const h = makeHarness();
		await h.c.runDeferredCompaction('a1', undefined);
		h.setRaw(history(3));
		await h.c.runDeferredCompaction('a1', 's1');
		assert.strictEqual(h.driverCalls.length, 0, '不该为明显不成立的输入付出摘要成本 ✓');
		assert.strictEqual(h.lockKeys.length, 0, '也不该碰写锁 ✓');
	});

	test('★★ 正常路径：**进写锁** → 重读 → 尾部未变 ⇒ 落盘 + 回填桶 ✓✓', async () => {
		const h = makeHarness();
		h.setRaw(history(20));
		h.driverResult = okResult;
		await h.c.runDeferredCompaction('a1', 's1');

		assert.deepStrictEqual(h.lockKeys, ['a1::s1'], '★ 落盘必须在**会话写锁内**（与追加串行化 ✓）');
		assert.strictEqual(h.snapshots.length, 1, '必须写快照 ✓');
		const written = h.snapshots[0];
		const idx = written.findIndex(m => m.metadata?.type === COMPACTION_METADATA_TYPE);
		assert.strictEqual(idx, 20 - 5, `边界必须插在倒数 tailCount 条之前（实际 ${idx} ✗）`);
		assert.deepStrictEqual(h.cached, [{ key: 'a1::s1', count: written.length }], '必须回填内存桶 ✓');
		assert.ok(h.logs.infos.some(l => l.includes('boundary written')), '必须留可查日志 ✓');
	});

	test('★★★ **竞态**：摘要期间尾部变了 ⇒ **放弃落盘** ✓✓（摘要丢弃无妨 ⇒ 下轮重判 ✓）', async () => {
		const h = makeHarness();
		const raw = history(20);
		h.setRaw(raw);
		h.driverResult = okResult;
		// 摘要期间落了新消息 ⇒ 锁内重读拿到更长的历史 ✓
		h.setReplay([...raw, msg('new1')]);
		await h.c.runDeferredCompaction('a1', 's1');

		assert.strictEqual(h.snapshots.length, 0, '★ 尾部变了**绝不能**落盘（插入点已失效 ⇒ 会插错位置 ✗✓）');
		assert.strictEqual(h.cached.length, 0, '也不得回填桶 ✓');
		assert.ok(h.logs.warns.some(w => w.includes('raced') && w.includes('tail changed')),
			`必须留下 raced 证据（实际 ${JSON.stringify(h.logs.warns)} ✗ —— 静默放弃会让排查无从下手 ✓）`);
		assert.ok(h.logs.infos.some(l => l.includes('skipped (raced)')), '最终结论也要记一笔 ✓');
	});

	test('★★ 尾部条数相同但**末条 id 变了**（改写）⇒ 同样必须放弃 ✓（只看长度会漏 ✓）', async () => {
		const h = makeHarness();
		const raw = history(20);
		h.setRaw(raw);
		h.driverResult = okResult;
		h.setReplay([...raw.slice(0, 19), msg('m19-rewritten')]);
		await h.c.runDeferredCompaction('a1', 's1');
		assert.strictEqual(h.snapshots.length, 0, '★ 长度相同也必须校验末条 id ✓（只比长度会漏掉改写 ✓）');
	});

	test('★★ driver 判定无需压缩 ⇒ 记 info 且**不碰写锁** ✓；异常 ⇒ 降级 warn 且**绝不抛** ✓', async () => {
		const h = makeHarness();
		h.setRaw(history(20));
		h.driverResult = { didCompact: false, skipReason: 'below-threshold' };
		await h.c.runDeferredCompaction('a1', 's1');
		assert.strictEqual(h.lockKeys.length, 0, '无需压缩 ⇒ 不得进写锁 ✓');
		assert.ok(h.logs.infos.some(l => l.includes('skipped')), '必须留一行可查结论 ✓');

		const h2 = makeHarness();
		h2.setRaw(history(20));
		(h2.c as any).deps.compactMessages = async () => { throw new Error('driver down'); };
		await assert.doesNotReject(() => h2.c.runDeferredCompaction('a1', 's1'),
			'★ 推迟压缩是 fire-and-forget ⇒ **绝不能**把异常抛回收尾路径 ✓');
		assert.ok(h2.logs.warns.some(w => w.includes('deferred compaction failed') && w.includes('自愈')),
			'必须留下"下轮 preflight 重判，自愈"的提示 ✓');
	});

	test('★ 边界消息构造用的是**本次压缩结果** ✓（originalCount/compressedCount 透传 ✓）', async () => {
		const h = makeHarness();
		h.setRaw(history(20));
		h.driverResult = { ...okResult, originalCount: 15, compressedCount: 2 };
		await h.c.runDeferredCompaction('a1', 's1');
		const b = h.snapshots[0].find(m => m.metadata?.type === COMPACTION_METADATA_TYPE)!;
		assert.strictEqual(b.id, 'b_15_2', `边界必须用本次结果构造（实际 id=${b.id} ✗✓）`);
	});
});
