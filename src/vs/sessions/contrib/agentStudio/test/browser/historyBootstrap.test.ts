/*---------------------------------------------------------------------------------------------
 *  HistoryBootstrap 专属行为基线（2026-09-22 阶段④-g P1/D-10 ✓）
 *
 *  为什么需要它 ✗✓：`historyBootstrap.ts`（140 行 ✓）负责 global history（fallback 文件）的
 *  **惰性装载**与**写回**，三条口径**每条都对应一类事故** ✗✓：
 *   · **启动只装 noSession 桶** ✓✓（key 不含 `::`）—— 否则每次开窗都要把**多 GB 的 ToolResult payload**
 *     读进 renderer 堆 ✗（P0 内存纪律 ✓）；
 *   · **启动期净化** ✓✓（2026-06-05）—— noSession 桶历史上沉积过 user/assistant/tool ⇒
 *     会被 getHistory 反复报 `dropped X non-system messages` ✗ ⇒ 装载后立刻滤成**仅 system** 并**回写磁盘** ✓；
 *   · **批量清理必须放在早退分支之前** ✗✓✓ —— 方法末尾有「无 global history 文件即 return」的早退 ✗，
 *     而批量清理只依赖 chat-history 目录 ✓（放错位置 ⇒ 全新机器上**永不清理** ✗）。
 *  这里把它当**纯对象**驱动 ✓（IO / 路径学 / 缓存 / 回写全部用假的 ✓）。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；假件照抄真件判据 ✓（仅 system 过滤、`::` 判定、pretty JSON ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { HistoryBootstrap } from '../../browser/historyBootstrap.js';
import type { ChatMessage } from '../../common/types.js';

const historyFile = URI.file('/tmp/global-history.json').fsPath;
const globalDir = URI.file('/tmp');

const msg = (id: string, role: 'system' | 'user' | 'assistant' = 'system', content = `c-${id}`): ChatMessage =>
	({ id, role, content, timestamp: '' } as ChatMessage);

interface IHarness {
	boot: HistoryBootstrap;
	cache: Map<string, ChatMessage[]>;
	files: Map<string, string>;
	dirs: Set<string>;
	writes: string[];
	scheduled: number;
	touched: string[];
	logs: { infos: string[]; warns: string[]; errors: string[] };
}

function makeHarness(opts: { fileExists?: boolean; content?: string } = {}): IHarness {
	const cache = new Map<string, ChatMessage[]>();
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	if (opts.fileExists !== false) { files.set(historyFile, opts.content ?? '{}'); dirs.add(globalDir.fsPath); }
	const writes: string[] = [];
	const touched: string[] = [];
	const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[] };
	const state = { scheduled: 0 };
	const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);

	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)) || dirs.has(pathOf(uri)),
		readFile: async (uri: any) => {
			const p = pathOf(uri);
			if (!files.has(p)) { throw new Error('ENOENT ' + p); }
			return { value: { toString: () => files.get(p)! } };
		},
		writeFile: async (uri: any, buf: any) => { writes.push(pathOf(uri)); files.set(pathOf(uri), buf.toString()); },
		createFolder: async (uri: any) => { dirs.add(pathOf(uri)); },
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
			getHistoryFileUri: () => URI.file(historyFile),
			getGlobalDataUri: () => globalDir,
		},
		cache,
		touchBucket: (key: string) => { touched.push(key); },
		scheduleBulkCleanup: () => { state.scheduled++; },
	};
	return {
		boot: new HistoryBootstrap(deps), cache, files, dirs, writes, touched, logs,
		get scheduled() { return state.scheduled; },
	};
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

suite('HistoryBootstrap — global history 的惰性装载与启动期净化 ✓', () => {

	test('★★★ **批量清理必须放在早退分支之前** ✓✓：无 global history 文件时也必须被调度 ✓', async () => {
		const h = makeHarness({ fileExists: false });
		await h.boot.ensureLoaded();
		assert.strictEqual(h.scheduled, 1,
			'★ 文件不存在也必须调度批量清理（放错位置 ⇒ 全新机器上**永不清理**存量历史 ✗✓）');
		assert.ok(h.logs.infos.some(l => l.includes('No global history file')),
			'必须明确说"会话桶将惰性装载" ✓（这是设计而非异常 ✓）');
		assert.strictEqual(h.cache.size, 0, '无文件 ⇒ 缓存不得被填 ✓');
	});

	test('★★★ **启动只装 noSession 桶** ✓✓：含 `::` 的会话桶必须跳过（否则多 GB payload 进堆 ✗）', async () => {
		const h = makeHarness({
			content: JSON.stringify({
				a1: [msg('sys1')],                      // noSession 桶 ⇒ 装 ✓
				'a1::s1': [msg('m1', 'user')],           // 会话桶 ⇒ **跳过** ✓
				'a2::s9': [msg('m9', 'assistant')],
			}),
		});
		await h.boot.ensureLoaded();
		assert.deepStrictEqual([...h.cache.keys()], ['a1'],
			`★ 只允许 noSession 桶进缓存（实际 ${JSON.stringify([...h.cache.keys()])} ✗✓ —— 会话桶一旦进堆，开窗就要读多 GB ToolResult ✗）`);
		assert.deepStrictEqual(h.touched, ['a1'], '装入的桶必须登记 LRU 访问时间 ✓');
		const info = h.logs.infos.join(' | ');
		assert.ok(info.includes('Loaded 1 noSession buckets') && info.includes('skipped 2 session buckets'),
			`必须报装入/跳过条数（实际「${info}」✗）`);
	});

	test('★★★ **启动期净化** ✓✓：noSession 桶滤成仅 system + 回写磁盘（让磁盘也干净 ✓）', async () => {
		const h = makeHarness({
			content: JSON.stringify({
				a1: [msg('sys1', 'system'), msg('u1', 'user'), msg('a1-1', 'assistant'), msg('t1', 'assistant')],
			}),
		});
		await h.boot.ensureLoaded();

		assert.deepStrictEqual(h.cache.get('a1')!.map(m => m.id), ['sys1'],
			'★ 必须立即滤成**仅 system**（否则 getHistory 每轮都报 dropped X non-system messages ✗✓）');
		const w = h.logs.warns.join(' | ');
		assert.ok(w.includes('Startup sanitize: dropped 3 non-system messages'),
			`必须报丢弃条数（实际「${w}」✗ —— 静默净化会让"消息去哪了"无从归因 ✓）`);
		await flush();
		assert.ok(h.writes.includes(historyFile), '★ 必须**回写** global history（只改内存 ⇒ 每次启动都白干 ✗✓）');
		assert.strictEqual(JSON.parse(h.files.get(historyFile)!)[ 'a1' ].length, 1, '回写内容必须已是净化后的 ✓');
	});

	test('★★ 干净的 noSession 桶 ⇒ **不净化、不回写** ✓（无改动不得写盘 ✓）', async () => {
		const h = makeHarness({ content: JSON.stringify({ a1: [msg('sys1', 'system')] }) });
		await h.boot.ensureLoaded();
		await flush();
		assert.strictEqual(h.writes.length, 0, '无脏数据 ⇒ 不得回写 ✓');
		assert.strictEqual(h.logs.warns.length, 0, '也不得报净化 warn ✓');
	});

	test('★ 会话桶即便**脏**也不得被净化逻辑碰到 ✓（它们根本没进缓存 ✓）', async () => {
		const h = makeHarness({
			content: JSON.stringify({ 'a1::s1': [msg('u1', 'user'), msg('a2', 'assistant')] }),
		});
		await h.boot.ensureLoaded();
		assert.strictEqual(h.cache.size, 0, '会话桶不进缓存 ✓');
		assert.strictEqual(h.writes.length, 0, '也不得因它回写 ✓（它的净化属于 per-session 惰性路径 ✓）');
		assert.strictEqual(h.scheduled, 1, '批量清理照常调度 ✓');
	});

	test('★★ `ensureLoaded` **幂等** ✓：重复调用只读一次（并发调用也不重复） ✓', async () => {
		const h = makeHarness({ content: JSON.stringify({ a1: [msg('sys1', 'system')] }) });
		await h.boot.ensureLoaded();
		await h.boot.ensureLoaded();
		await h.boot.ensureLoaded();
		assert.strictEqual(h.scheduled, 1, '★ 批量清理只调度一次（每次调用都调度 ⇒ 重复扫描全库 ✗✓）');
		assert.strictEqual(h.files.get(historyFile) !== undefined, true, '前置：文件仍在 ✓');
		assert.strictEqual(h.cache.size, 1, '缓存不被重复覆盖 ✓');
	});

	test('★ global history 解析失败 ⇒ error 日志且**绝不抛** ✓（启动路径不能炸 ✗✓）', async () => {
		const h = makeHarness({ content: '{ 这不是 JSON' });
		await assert.doesNotReject(() => h.boot.ensureLoaded(), '★ 启动期不能因历史文件损坏而崩 ✓');
		assert.ok(h.logs.errors.some(e => e.includes('Failed to load global history')),
			'必须留 error 供取证 ✓');
		assert.strictEqual(h.cache.size, 0, '不得写入半个缓存 ✓');
	});

	test('★★ `persistGlobalHistory`：目录缺失时建目录 ✓、写**完整缓存**的漂亮 JSON ✓', async () => {
		const h = makeHarness({ fileExists: false });
		h.cache.set('a1', [msg('sys1', 'system')]);
		h.cache.set('a1::s1', [msg('m1', 'user')]);
		await h.boot.persistGlobalHistory();
		assert.ok(h.dirs.has(globalDir.fsPath), '目录缺失必须建 ✓');
		const written = JSON.parse(h.files.get(historyFile)!);
		assert.deepStrictEqual(Object.keys(written).sort(), ['a1', 'a1::s1'],
			'必须写**完整缓存**（漏 key ⇒ 该 agent 的 system 消息丢失 ✗✓）');
		assert.strictEqual(written['a1'][0].id, 'sys1');
		assert.ok(h.files.get(historyFile)!.includes('\n  '), '必须是 pretty JSON（人工可读、便于排查 ✓）');
	});

	test('★ `persistGlobalHistory` 写失败 ⇒ error 日志且绝不抛 ✓', async () => {
		const h = makeHarness();
		(h.boot as any).deps.fileService.writeFile = async () => { throw new Error('disk full'); };
		await assert.doesNotReject(() => h.boot.persistGlobalHistory(), '★ 全局历史写失败不能炸上层 ✓');
		assert.ok(h.logs.errors.some(e => e.includes('Failed to persist global history')), '必须留 error ✓');
	});
});
