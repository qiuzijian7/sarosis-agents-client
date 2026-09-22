/*---------------------------------------------------------------------------------------------
 *  InlineMediaCleanup 专属行为基线（2026-09-22 阶段④-g P1/D-7 ✓）
 *
 *  为什么需要它 ✗✓：`inlineMediaCleanup.ts`（321 行 ✓）负责**存量历史**的内联媒体收敛 ✓，
 *  注释里的每一条"不可退化约定"都对应一次**用户可见缺陷** ✓（图片码原样显示 ✓ / 63 条占位糊成三列 ✓ /
 *  「切换会话仍显示图片码」✓ / 旧会话永远不被打开 ⇒ 惰性清理收敛不了 ✓）。其中**宽松匹配**与
 *  **占位宽松判定**是"改一行正则就静默退化"的典型 ✗✓ ⇒ 必须逐条钉死 ✓。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；假件照抄真件判据 ✓（阈值/文案/标记名一律用真常量 ✓）。
 *
 *  ⚠⚠ 实测到的两条**设计行为**（首跑 7 红全是我的预期错 ✗✓，产品行为符合设计 ✓）：
 *   ① **纯媒体消息会被整条清空** ✓ —— 所以"只含一张图的 content"清理后是 `''`（不是占位串 ✓），
 *      而 `replaced` 会算 **2**（替换 +1 ✓、清空 +1 ⇒ 让调用方回写 ✓）。要**观察占位替换**必须让
 *      消息里同时有**正文** ✓（下面的用例都这么做 ✓）。
 *   ② 「已完成 N 个输出」正则**只用于"是否整条清空"的判据** ✓，**不**从返回内容里删除 ✗✓ ——
 *      与正文共存时那行状态文案会**留在**内容里 ✓（与 docblock 一致 ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { InlineMediaCleanup } from '../../browser/inlineMediaCleanup.js';
import type { ChatMessage } from '../../common/types.js';

const root = URI.file('/tmp/fake-history');
const bigUri = (n = 2000) => 'data:image/jpeg;base64,' + 'A'.repeat(n);
const smallUri = 'data:image/gif;base64,' + 'B'.repeat(100);          // ≥64（能被正则命中）但 ≤ 1024 ⇒ 保留 ✓
const PH = '📎 ';
const PH_SUFFIX = '（见上方工作流卡片）';
/** 老版本写进历史的**长文案**占位（占位判定必须宽松才折叠得了 ✓✓）。 */
const oldPlaceholder = '📎 输出 32（图片已由工作流卡片展示，历史记录中不再内联）';

const msg = (content: string, parts?: any[]): ChatMessage =>
	({ id: 'm', role: 'assistant', content, timestamp: '', ...(parts ? { parts } : {}) } as any);

function makeCleanup(infos: string[] = [], warns: string[] = [], traces: string[] = []) {
	const log: any = {
		info(...a: unknown[]) { infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { warns.push(a.map(String).join(' ')); },
		trace(...a: unknown[]) { traces.push(a.map(String).join(' ')); },
		error() { }, debug() { },
	};
	const deps: any = { fileService: null, logService: log, getChatHistoryRoot: () => root };
	const c = new InlineMediaCleanup(deps);
	return { c, deps, infos, warns, traces };
}

suite('InlineMediaCleanup — 存量内联媒体收敛的不可退化约定 ✓', () => {

	test('★★★ **宽松匹配**：`!` 缺失 / `]`与`(`间换行 / `(`与`data:`间空白 / URI 与 `)` 间空白 ⇒ 都必须命中 ✓✓', () => {
		const { c } = makeCleanup();
		// ⚠ 必须带正文 ✓（纯媒体消息会被整条清空 ⇒ 看不到占位 ✓ —— 首跑就是这么假红的 ✓）
		const m = msg(`看看这个：\n[输出 32]\n(  ${bigUri()}  )`);   // 事故现场的真实形状 ✓
		const r = c.scrubOversizedInlineMedia([m]);
		assert.strictEqual(r.replaced, 1,
			`★ 事故现场的松散写法必须被命中（严格正则完全匹配不到 ⇒ 图片码原样给用户看 ✗✓）实际 ${r.replaced} ✗`);
		assert.strictEqual(m.content, `看看这个：\n📎 输出 32${PH_SUFFIX}`,
			`必须替换成一行占位（保留编号 ✓）实际「${m.content.slice(0, 60)}」✗`);
		assert.strictEqual(r.freedBytes, bigUri().length, 'freedBytes 必须是**被移除 URI** 的长度和 ✓');
	});

	test('★★ 阈值：URI ≤ `KEEP_MAX_URI`(1KB) ⇒ **保留** ✓；>1KB 才替换 ✓（原 200KB 阈值曾让 2KB 的 GIF 漏网 ✗✓）', () => {
		const { c } = makeCleanup();
		const keep = msg(`正文\n![x](${smallUri})`);
		assert.strictEqual(c.scrubOversizedInlineMedia([keep]).replaced, 0,
			'小图必须**不替换** ✓（阈值退回 200KB ⇒ 2KB 的 GIF 漏网 = 用户报「切换会话仍显示图片码」✗✓）');
		assert.strictEqual(keep.content, `正文\n![x](${smallUri})`, '小图内容必须逐字不变 ✓');

		const drop = msg(`正文\n![y](${bigUri(2000)})`);
		assert.strictEqual(c.scrubOversizedInlineMedia([drop]).replaced, 1, '超 1KB 必须替换 ✓');
		assert.strictEqual(drop.content, `正文\n📎 y${PH_SUFFIX}`, '替换为占位（保留 alt ✓）');
	});

	test('★ alt 上限 80 字符：超长 alt **不匹配** ⇒ 不误伤普通 Markdown ✓', () => {
		const { c } = makeCleanup();
		const m = msg(`正文\n![${'长'.repeat(100)}](${bigUri()})`);
		assert.strictEqual(c.scrubOversizedInlineMedia([m]).replaced, 0, '超长 alt 必须不匹配 ✓');
		assert.ok(m.content.includes('data:'), '内容必须原样（不得误删 ✓）');
	});

	test('★★★ **折叠不能挂在 `data:` 快速路径之后** ✓✓：无 `data:` 的老占位也必须折叠 ✓', () => {
		const { c } = makeCleanup();
		const m = msg(`前文\n${[oldPlaceholder, oldPlaceholder, oldPlaceholder].join('\n')}\n后文`);
		const r = c.scrubOversizedInlineMedia([m]);
		assert.strictEqual(r.replaced, 1,
			'★ 折叠必须计入 replaced ⇒ 调用方才会**回写落盘** ✓（不计 ⇒ 已清理过的历史永远折叠不了 ✗✓）');
		assert.strictEqual(m.content, `前文\n📎 3 个输出${PH_SUFFIX}\n后文`,
			`★ 连续占位必须折叠成一行计数摘要（实际「${m.content}」✗✓ —— 否则 63 条排成三列糊成一片 ✓）`);
	});

	test('★★ **占位判定必须宽松**：老版本长文案占位也折叠得了 ✓（用户第二次截图的那片糊 ✓）', () => {
		const { c } = makeCleanup();
		const m = msg(`前文\n${[oldPlaceholder, oldPlaceholder].join('\n')}\n后文`);
		c.scrubOversizedInlineMedia([m]);
		assert.strictEqual(m.content, `前文\n📎 2 个输出${PH_SUFFIX}\n后文`,
			`老长文案占位必须折叠（用 endsWith 严格后缀 ⇒ 它们永远折叠不了 ✗✓）实际「${m.content}」✗`);
	});

	test('★★ 单个占位**原样保留**（保留编号，信息不丢 ✓）；非占位行不得被吞 ✓', () => {
		const { c } = makeCleanup();
		const m = msg(`📎 输出 32${PH_SUFFIX}\n这段是正文`);
		const r = c.scrubOversizedInlineMedia([m]);
		assert.strictEqual(r.replaced, 0, '单个占位 + 正文 ⇒ 无需改动 ✓');
		assert.strictEqual(m.content, `📎 输出 32${PH_SUFFIX}\n这段是正文`, '必须逐字不变 ✓');
	});

	test('★★★ 整条清空判据：只剩「占位 + 已完成 N 个输出」⇒ 清空 ✓✓（让纯媒体汇报消息彻底消失 ✓）', () => {
		const { c } = makeCleanup();
		const m = msg(`已完成 42 个输出\n📎 输出 1${PH_SUFFIX}\n📎 输出 2${PH_SUFFIX}`);
		const r = c.scrubOversizedInlineMedia([m]);
		assert.strictEqual(m.content, '',
			`★ 纯媒体汇报必须整条清空（实际「${m.content.slice(0, 40)}」✗✓ —— getHistory 会丢空消息 ⇒ 历史干净 ✓）`);
		assert.ok(r.replaced > 0, '清空也算「有改动」⇒ 必须触发回写 ✓（否则磁盘上那条永远在 ✗）');

		// ⚠ 实测：有正文时**不得**清空 ✓，但「已完成 N 个输出」正则**只用于清空判据** ✓
		//   ⇒ 那行状态文案会**留在**内容里 ✓（与 docblock 一致 ✓ —— 不是"顺手删除" ✗）
		const keep = msg(`已完成 42 个输出\n📎 输出 1${PH_SUFFIX}\n用户其实想看的正文`);
		c.scrubOversizedInlineMedia([keep]);
		assert.ok(keep.content.includes('用户其实想看的正文'), '有正文时必须保留正文 ✓');
		assert.ok(keep.content.includes('已完成 42 个输出'),
			`实测：状态文案与正文共存时**保留** ✓（正则只服务"是否整条清空"的判据 ✓）实际「${keep.content}」✗`);
	});

	test('★★ `parts[].text` 也必须清 ✓（渲染真相源在 parts 上 ✓ —— 只清 content 会让刷新后图片码复现 ✗✓）', () => {
		const { c } = makeCleanup();
		const m = msg('普通 content', [{ kind: 'text', text: `![x](${bigUri()})` }, { kind: 'tool', tool: {} }]);
		const r = c.scrubOversizedInlineMedia([m]);
		// ⚠ 实测 2 ✓：替换 +1 ✓、该 part 变成纯媒体 ⇒ **清空 +1** ✓（同一份逻辑 ✓）
		assert.strictEqual(r.replaced, 2, `必须统计到 parts 里的替换与清空（实际 ${r.replaced} ✗）`);
		assert.strictEqual((m as any).parts[0].text, '', 'parts 文本必须被清 ✓（纯媒体 ⇒ 清空 ✓）');
		assert.strictEqual((m as any).parts[1].kind, 'tool', '非文本段不得被动 ✓');
	});

	test('★ 无相关内容的普通消息**逐字不变** ✓（快速路径 ⇒ 零成本 ✓）', () => {
		const { c } = makeCleanup();
		const m = msg('就是一条普通回复，没有任何媒体 ✓');
		const before = JSON.stringify(m);
		const r = c.scrubOversizedInlineMedia([m]);
		assert.deepStrictEqual(r, { replaced: 0, freedBytes: 0 });
		assert.strictEqual(JSON.stringify(m), before, '必须逐字不变 ✓');
	});
});

/* ───────────────────────── 批量清理 ✓ ───────────────────────── */

interface IBulkFs {
	api: any;
	files: Map<string, string>;
	reads: string[];
	writes: string[];
	markerWritten: boolean;
}

function makeBulkFs(opts: {
	rootExists?: boolean;
	markerExists?: boolean;
	files: Array<{ agent: string; name: string; size: number; mtime: number; content: string }>;
}): IBulkFs {
	const rootExists = opts.rootExists !== false;
	const files = new Map<string, string>();
	const reads: string[] = [];
	const writes: string[] = [];
	const state = { markerWritten: !!opts.markerExists };
	const sessionsDirOf = (agent: string) => URI.joinPath(URI.joinPath(root, agent), 'sessions');
	const fileUriOf = (agent: string, name: string) => URI.joinPath(sessionsDirOf(agent), name);
	for (const f of opts.files) { files.set(fileUriOf(f.agent, f.name).fsPath, f.content); }
	const agents = [...new Set(opts.files.map(f => f.agent))];

	const api: any = {
		exists: async (uri: any) => {
			const p = uri.fsPath;
			if (p === root.fsPath) { return rootExists; }
			if (p === URI.joinPath(root, InlineMediaCleanup.MARKER).fsPath) { return state.markerWritten; }
			if (p === URI.joinPath(root, 'a1').fsPath) { return agents.includes('a1'); }
			if (p === sessionsDirOf('a1').fsPath) { return agents.includes('a1'); }
			return files.has(p);
		},
		resolve: async (uri: any) => {
			const p = uri.fsPath;
			if (p === root.fsPath) {
				return { children: agents.map(a => ({ resource: URI.joinPath(root, a), isDirectory: true, name: a })) };
			}
			return {
				children: opts.files.filter(f => sessionsDirOf(f.agent).fsPath === p).map(f => ({
					resource: fileUriOf(f.agent, f.name), isDirectory: false, name: f.name,
					size: f.size, mtime: f.mtime,
				})),
			};
		},
		readFile: async (uri: any) => { reads.push(uri.fsPath); return { value: { toString: () => files.get(uri.fsPath)! } }; },
		writeFile: async (uri: any, buf: any) => {
			writes.push(uri.fsPath);
			if (uri.fsPath === URI.joinPath(root, InlineMediaCleanup.MARKER).fsPath) { state.markerWritten = true; return; }
			files.set(uri.fsPath, buf.toString());
		},
	};
	return {
		api, files, reads, writes,
		get markerWritten() { return state.markerWritten; },
	};
}

const BIG = InlineMediaCleanup.MIN_FILE_BYTES + 1;
const OLD = Date.now() - InlineMediaCleanup.SKIP_RECENT_MS - 60_000;

function payloadWithBigImage(): string {
	// ⚠ 带正文 ✓（纯媒体消息会被清空 ⇒ 写入的 content 变成 "" ✓，这在本用例里是被**断言**的行为 ✓）
	return JSON.stringify([msg(`正文\n![out](${bigUri()})`)]);
}

suite('InlineMediaCleanup — 批量清理（一次性/延迟/幂等 ✓）', () => {

	test('★★★ 幂等：已写过标记 ⇒ **直接返回**（不读文件、不重写标记 ✓✓）', async () => {
		const fs = makeBulkFs({ markerExists: true, files: [{ agent: 'a1', name: 's.json', size: BIG, mtime: OLD, content: payloadWithBigImage() }] });
		const { c, deps, traces } = makeCleanup();
		deps.fileService = fs.api;
		await c.runBulkCleanup();
		assert.strictEqual(fs.reads.length, 0, '★ 标记存在时必须**零读取** ✓（否则每次启动都白扫全库 ✗✓）');
		assert.strictEqual(fs.writes.length, 0, '也不得重写标记 ✓');
		assert.strictEqual(traces.length, 0, '不得产生"nothing to scrub"日志（提前返回 ✓）');
	});

	test('★★ 三层成本控制：小文件**不读** ✓、最近修改的**跳过** ✓（防与活跃会话打架 ✗✓）', async () => {
		const fs = makeBulkFs({
			files: [
				{ agent: 'a1', name: 'small.json', size: InlineMediaCleanup.MIN_FILE_BYTES - 1, mtime: OLD, content: payloadWithBigImage() },
				{ agent: 'a1', name: 'recent.json', size: BIG, mtime: Date.now(), content: payloadWithBigImage() },
			],
		});
		const { c, deps } = makeCleanup();
		deps.fileService = fs.api;
		await c.runBulkCleanup();
		assert.strictEqual(fs.reads.length, 0,
			'小文件靠 stat.size 预筛 ✓、最近修改的靠 mtime 跳过 ✓ ⇒ 都应**零读取**（实际读了 ' + fs.reads.length + ' ✗）');
		assert.strictEqual(fs.markerWritten, true, '★ 无清理也必须写标记 ⇒ 避免每次启动重扫 ✓');
	});

	test('★★★ 大且旧的脏文件 ⇒ 读 → 清 → **回写**（pretty JSON ✓）并报数 ✓✓', async () => {
		const fs = makeBulkFs({ files: [{ agent: 'a1', name: 's1.json', size: BIG, mtime: OLD, content: payloadWithBigImage() }] });
		const { c, deps, infos } = makeCleanup();
		deps.fileService = fs.api;
		await c.runBulkCleanup();

		const target = URI.joinPath(URI.joinPath(URI.joinPath(root, 'a1'), 'sessions'), 's1.json').fsPath;
		assert.ok(fs.writes.includes(target), `必须回写被清理的文件（实际写了 ${JSON.stringify(fs.writes)} ✗）`);
		const written = fs.files.get(target)!;
		assert.ok(!written.includes('data:'), '★ 回写内容**不得**再含内联 base64（含 ⇒ 等于没清 ✓✗）');
		assert.ok(written.includes('📎 out'), '回写内容必须含占位（保留编号与 alt ✓）');
		assert.ok(written.includes('\n  '), '回写必须用 `JSON.stringify(..., null, 2)`（保持可读 ✓）');
		assert.ok(infos.some(l => l.includes('Bulk inline-media cleanup: scrubbed 1')),
			`必须留统计日志（实际 ${JSON.stringify(infos)} ✗ —— 前缀保持 [AgentChatService] 供排查手册 grep ✓）`);
		assert.strictEqual(fs.markerWritten, true, '跑完必须写标记 ✓');
	});

	test('★★ 大且旧但**干净**的文件 ⇒ 不得回写（避免无谓全量重写 ✗✓）', async () => {
		const fs = makeBulkFs({
			files: [{ agent: 'a1', name: 'clean.json', size: BIG, mtime: OLD, content: JSON.stringify([msg('干净的巨型 payload（无 data URI）')]) }],
		});
		const { c, deps, traces } = makeCleanup();
		deps.fileService = fs.api;
		await c.runBulkCleanup();
		assert.strictEqual(fs.writes.filter(w => w.endsWith('.json')).length, 0, '无改动 ⇒ 不得回写 ✓');
		assert.ok(traces.some(l => l.includes('nothing to scrub')), '应留一条 trace（便于确认确实跑过 ✓）');
	});

	test('★ 单文件失败（坏 JSON）不影响其余 ✓、root 不存在 ⇒ 直接返回且**不写标记** ✓', async () => {
		const fs = makeBulkFs({
			files: [
				{ agent: 'a1', name: 'bad.json', size: BIG, mtime: OLD, content: '{ 这不是合法 JSON' },
				{ agent: 'a1', name: 'good.json', size: BIG, mtime: OLD, content: payloadWithBigImage() },
			],
		});
		const { c, deps, warns } = makeCleanup();
		deps.fileService = fs.api;
		await c.runBulkCleanup();
		assert.ok(fs.writes.some(w => w.endsWith('good.json')), '坏文件之后的文件必须继续处理 ✓（单文件失败不拖累其余 ✓）');
		assert.strictEqual(warns.length, 0, '单文件失败被吞掉 ⇒ 不应升级为全局 warn ✓');

		const fs2 = makeBulkFs({ rootExists: false, files: [] });
		const h2 = makeCleanup();
		h2.deps.fileService = fs2.api;
		await h2.c.runBulkCleanup();
		assert.strictEqual(fs2.markerWritten, false, 'root 不存在 ⇒ 不得写标记（否则首启就锁死清理 ✓）');
	});

	test('★★ 调度：`scheduleBulkCleanup` **幂等** ✓ 且**延迟**执行 ✓（避开首屏 I/O 高峰 ✓）', async () => {
		const realSetTimeout = globalThis.setTimeout;
		const timers: Array<{ cb: () => void; delay: number }> = [];
		(globalThis as any).setTimeout = ((cb: () => void, delay: number) => { timers.push({ cb, delay }); return 0 as any; }) as any;
		try {
			const fs = makeBulkFs({ files: [] });
			const { c, deps } = makeCleanup();
			deps.fileService = fs.api;
			c.scheduleBulkCleanup();
			c.scheduleBulkCleanup();
			c.scheduleBulkCleanup();
			assert.strictEqual(timers.length, 1,
				`★ 并发调用只允许调度一次（实际 ${timers.length} ✗✓ —— ensureHistoryLoaded 可能被并发调用 ✓）`);
			assert.strictEqual(timers[0].delay, InlineMediaCleanup.DELAY_MS, '必须延迟执行 ✓');
			timers[0].cb();
			await new Promise<void>(r => realSetTimeout(r, 0));
			assert.strictEqual(fs.markerWritten, true, '定时器到点必须真的跑清理 ✓');
		} finally {
			(globalThis as any).setTimeout = realSetTimeout;
		}
	});
});
