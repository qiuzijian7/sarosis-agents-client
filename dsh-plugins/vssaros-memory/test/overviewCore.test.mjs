/*---------------------------------------------------------------------------------------------
 *  overviewCore.test.mjs — 注入预览 + 沉淀统计（★ 2026-11-02，记忆工作台 v2 · P3/P4）
 *
 * ## 注入预览（lib/core/injection.js）
 *  ① 切块：用**真实形状**的快照（引擎包装 + 固定槽位 + 人设分区 + 待审提示）；
 *     固定槽位内容里用户自己写的 `## 小标题` 不是块边界；人设分区内部的块不另开
 *  ② 块区间连续、互不重叠，`text` 与原文切片一致
 *  ③ 前缀比对五种结论（identical / append-only / tail-changed / prefix-broken / unavailable）
 *  ④ ★ 取不到一侧时必须说"比不了"，不能说"稳定"
 *  ⑤ 块状态（same / changed / new）与预算占比
 *
 * ## 沉淀统计（lib/stats.js）
 *  ⑥ 解析容错；⑦ 增量只算正差；⑧ 漏斗口径（候选 = 四条候选流之和）
 *  ⑨ ★ 同步幂等：同一份 distill 连着同步两次只计一次；"紧挨着调用"不会重复计
 *  ⑩ ★ 重启不重复累加、不出负数（distill 归零、lastSeen 归零）
 *  ⑪ ★ 先读盘再累加（读盘慢于累加时不能被旧值覆盖）
 *  ⑫ 损坏文件 / 写不进去都不抛
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	buildInjectionView, commonPrefixLength, comparePrefix, estimateTokens, markBlocks, splitBlocks,
} from '../lib/core/injection.js';
import {
	DISTILL_KEYS, EVENT_KEYS, createStatsStore, deltaOf, emptyTotals, funnelOf, parseStats, statsFileOf,
} from '../lib/stats.js';

// 进程内测试没有 cordis 服务发现 ⇒ 走 `foundationRef.js` 的既定探针后门
globalThis.__VSSAROS_FOUNDATION__ = { dataRootOf: config => String(config?.dataRoot ?? '') };

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};
const checkAsync = async (name, fn) => {
	try { const d = await fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

// ── 真实形状的快照 ─────────────────────────────────────────────────────────
// 引擎：<agentmemory-context> 包装 + `# agentmemory pinned slots` + `## <label>` + 各块；
// 插件追加：人设分区（又一份完整引擎输出）+ 待审提示。
const PENDING = n => `## 待审记忆草稿\n有 ${n} 条自动提取的候选（约定 ${n}）尚未进入长期记忆，需用户在「记忆」页审核并「提升」后才生效。`;
const SNAP = (pending = 3) => [
	'<agentmemory-context project="gr">',
	'# agentmemory pinned slots',
	'',
	'## persona',
	'你是 VsSaros 的工程助手',
	'',
	'## project_context',
	'## 项目背景',
	'本仓是 VsSaros，这里的 `## 项目背景` 是用户自己写的小标题，不是块边界',
	'',
	'## Project Profile',
	'Concepts: memory, gateway',
	'',
	'## Reusable Routines',
	'- 发版: 自检 -> bump -> 安装',
	'</agentmemory-context>',
	'',
	'## 人设记忆（alice）',
	'<agentmemory-context project="alice">',
	'# agentmemory pinned slots',
	'',
	'## persona',
	'alice 的人设',
	'',
	'## Project Profile',
	'Concepts: 人设内部的画像',
	'</agentmemory-context>',
	'',
	PENDING(pending),
].join('\n');

check('① 切块：5 块；用户写在槽位内容里的 `## 小标题` 不是边界；人设分区内部不另开', () => {
	const { blocks, wrapperChars } = splitBlocks(SNAP());
	assert.deepEqual(blocks.map(b => b.id), ['slots', 'profile', 'routines', 'persona', 'pending'],
		`实际：${blocks.map(b => b.id).join(',')}`);
	const slots = blocks.find(b => b.id === 'slots');
	assert.ok(slots.text.includes('## 项目背景') && slots.text.includes('project_context'), '槽位内容（含用户小标题）必须整块在 slots 里');
	const persona = blocks.find(b => b.id === 'persona');
	assert.ok(persona.text.includes('alice 的人设') && persona.text.includes('人设内部的画像'), '人设分区内部的块要并入人设块，不能另算一份画像');
	assert.equal(blocks.filter(b => b.id === 'profile').length, 1, '画像只能有 1 块（人设内部那份不能再算）');
	assert.ok(wrapperChars > 0, '包装标签要计入 wrapperChars');
	return blocks.map(b => `${b.id}:${b.tokens}`).join(' ');
});

check('② 块区间连续、不重叠、text 与原文切片一致；token 口径与引擎同（ceil(字符/3)）', () => {
	const text = SNAP();
	const { blocks, totalChars } = splitBlocks(text);
	assert.equal(totalChars, text.length);
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		assert.ok(b.start <= b.end, `${b.id} 区间反了`);
		assert.equal(b.text, text.slice(b.start, b.end).replace(/\s+$/, ''), `${b.id} 的 text 与原文切片不一致`);
		assert.equal(b.tokens, Math.ceil(b.text.length / 3));
		if (i > 0) { assert.equal(blocks[i - 1].end, b.start, `${blocks[i - 1].id} 与 ${b.id} 之间不连续`); }
	}
	assert.equal(estimateTokens('abcd'), 2);
	assert.equal(estimateTokens(''), 0);
	assert.equal(estimateTokens(undefined), 0);
	return 'ok';
});

check('② 边角：空串 / 只有包装 / 头部有不认识的内容', () => {
	assert.deepEqual(splitBlocks('').blocks, []);
	assert.deepEqual(splitBlocks('<agentmemory-context project="x">\n</agentmemory-context>').blocks, []);
	const odd = splitBlocks('前面有一段不认识的话\n\n## Lessons Learned\n- x').blocks;
	assert.deepEqual(odd.map(b => b.id), ['other', 'lessons'], '不认识的头部要归为"其它"，不能丢');
	assert.deepEqual(splitBlocks(undefined).blocks, []);
});

check('③ 前缀比对：identical / append-only / tail-changed / prefix-broken', () => {
	const frozen = SNAP(3);
	assert.equal(comparePrefix(frozen, frozen).verdict, 'identical');

	// 末尾追加一个新块 ⇒ append-only，且旧前缀 100% 保留
	const appended = `${frozen}\n\n## Lessons Learned\n- (0.60) 构建必须走 pnpm`;
	const a = comparePrefix(frozen, appended);
	assert.equal(a.verdict, 'append-only');
	assert.equal(a.prefixChars, frozen.length);
	assert.ok(a.addedChars > 0 && a.removedChars === 0);

	// 只有待审提示里的计数变了 ⇒ tail-changed，brokenAt = 待审提示（它是最后一块）
	const t = comparePrefix(frozen, SNAP(4));
	assert.equal(t.verdict, 'tail-changed', JSON.stringify(t));
	assert.equal(t.brokenAt, '待审提示');
	assert.ok(t.prefixChars > frozen.length * 0.9, '除最后一块外前缀都应保留');

	// 在中间插入新块 ⇒ prefix-broken，且指出从哪一块起失效
	const inserted = frozen.replace('## Reusable Routines', '## Lessons Learned\n- 新教训\n\n## Reusable Routines');
	const p = comparePrefix(frozen, inserted);
	assert.equal(p.verdict, 'prefix-broken', JSON.stringify(p));
	assert.equal(p.brokenAt, '可复用流程', '应指出差异落在哪一块');
	assert.ok(p.removedChars > 0, '被位移的部分要体现在 removedChars 里');
	return `${a.verdict}/${t.verdict}/${p.verdict}`;
});

check('④ ★ 任何一侧取不到 ⇒ unavailable（不能下"稳定"的结论）', () => {
	assert.equal(comparePrefix(SNAP(), null).verdict, 'unavailable', '当前库没取到');
	assert.equal(comparePrefix('', SNAP()).verdict, 'unavailable', '冻结快照为空');
	assert.equal(comparePrefix(null, null).verdict, 'unavailable');
	assert.equal(comparePrefix(undefined, SNAP()).verdict, 'unavailable');
	// 两侧都为空串不能被当成 identical
	assert.equal(comparePrefix('', '').verdict, 'unavailable');
	assert.equal(commonPrefixLength('abc', 'abd'), 2);
	assert.equal(commonPrefixLength(undefined, 'x'), 0);
});

check('⑤ 块状态 same/changed/new + 预算占比 + 取失败的视图', () => {
	const frozen = SNAP(3);
	const live = frozen.replace('## Reusable Routines', '## Lessons Learned\n- 新教训\n\n## Reusable Routines');
	const view = buildInjectionView({ frozenText: frozen, liveText: live, budgetTokens: 200, charCap: 8000 });
	const state = Object.fromEntries(view.live.blocks.map(b => [b.id, b.state]));
	assert.equal(state.slots, 'same', '前缀之内的块 = 缓存命中');
	assert.equal(state.profile, 'same');
	assert.ok(['changed', 'new'].includes(state.lessons) || state.routines === 'changed', '插入点所在块必须被标出来');
	assert.ok(view.live.blocks.some(b => b.state !== 'same'), '必须有被标成非 same 的块');
	assert.equal(view.budget.estimated, true, 'token 是估算，必须带标记让页面能说出来');
	assert.equal(view.budget.tokens, 200);
	assert.equal(view.frozen.tokens, estimateTokens(frozen));
	assert.equal(view.frozen.pct, Math.round(estimateTokens(frozen) / 200 * 100));
	assert.equal(view.frozen.over, estimateTokens(frozen) > 200);

	// 取失败：live 为 null，带原因，结论 unavailable
	const bad = buildInjectionView({ frozenText: frozen, liveText: null, liveError: '网关 5000ms 未响应', budgetTokens: 1024 });
	assert.equal(bad.live, null);
	assert.equal(bad.liveError, '网关 5000ms 未响应');
	assert.equal(bad.diff.verdict, 'unavailable');
	assert.ok(bad.frozen, '冻结快照这一侧仍要给（只读本地状态，不依赖网关）');

	// 冻结快照为空（网关未配置）：frozen 为 null，不是空块列表
	const empty = buildInjectionView({ frozenText: '', liveText: frozen, budgetTokens: 1024 });
	assert.equal(empty.frozen, null);
	assert.equal(empty.diff.verdict, 'unavailable');

	// 预算未知（0/缺省）⇒ pct 为 null，不能除 0
	assert.equal(buildInjectionView({ frozenText: frozen, liveText: frozen }).frozen.pct, null);
	assert.deepEqual(markBlocks(undefined, 5), []);
	return 'ok';
});

// ═══ 沉淀统计 ═══════════════════════════════════════════════════════════════

check('⑥ parseStats：损坏 / 缺字段 / 负数 / 字符串数字 ⇒ 回落，不抛', () => {
	for (const bad of [null, undefined, '', '{坏', '[]', '"x"', '123']) {
		const p = parseStats(bad);
		assert.equal(p.since, null);
		assert.deepEqual(p.totals, emptyTotals());
	}
	const p = parseStats(JSON.stringify({ since: 1730000000000, totals: { turns: 5, written: -3, autoPromoted: '7', bogus: 9 } }));
	assert.equal(p.totals.turns, 5);
	assert.equal(p.totals.written, 0, '负数要归零');
	assert.equal(p.totals.autoPromoted, 0, '字符串数字不认（来源只可能是我们自己写的数字）');
	assert.equal(p.totals.bogus, undefined, '未知键不得混进来');
	assert.equal(p.since, 1730000000000);
});

check('⑦ deltaOf：只含正差；当前 < 上次（重启后）⇒ 不出负数；非数字忽略', () => {
	assert.deepEqual(deltaOf({ turns: 5, written: 2 }, { turns: 3, written: 2 }), { turns: 2 });
	assert.deepEqual(deltaOf({ turns: 1 }, { turns: 9 }), {}, '当前比上次小不能给负增量');
	assert.deepEqual(deltaOf({ turns: 'x', written: NaN, candidates: -1 }, {}), {});
	assert.deepEqual(deltaOf(undefined, undefined), {});
	assert.deepEqual(deltaOf({ notTracked: 5 }, {}), {}, '未跟踪的键不能混进来');
	assert.ok(DISTILL_KEYS.includes('autoPromoted') && EVENT_KEYS.includes('humanPromoted'));
	assert.ok(!DISTILL_KEYS.some(k => EVENT_KEYS.includes(k)), '两类键不能重叠，否则同一件事会被计两次');
});

check('⑧ funnelOf：候选 = 四条候选流之和；草稿 = written', () => {
	const f = funnelOf({ turns: 100, candidates: 10, summaries: 3, turnSummaries: 5, summaryFacts: 2, written: 14, autoPromoted: 2, humanPromoted: 4, discarded: 6, undone: 1, failed: 1, autoFailed: 2 });
	assert.equal(f.turns, 100);
	assert.equal(f.candidates, 20);
	assert.equal(f.drafts, 14);
	assert.equal(f.auto, 2); assert.equal(f.human, 4); assert.equal(f.discarded, 6);
	assert.equal(f.failed, 3, '失败 = 沉淀失败 + 自动提升失败');
	assert.equal(funnelOf(undefined).candidates, 0);
});

/**
 * 每个用例一个临时目录。
 * ⚠ 删目录前必须先把本用例创建的所有 store 刷盘：防抖定时器随时可能在落盘，
 *   不先刷就删，会撞上 `ENOTEMPTY`（本次踩到：是测试清理竞态，不是被测逻辑错）。
 */
async function withStore(fn, deps = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-stats-'));
	const made = [];
	const make = () => { const s = createStatsStore({ dataRoot: dir }, { flushMs: 0, ...deps }); made.push(s); return s; };
	try { return await fn(dir, make); }
	finally {
		for (const s of made) { await s.flushNow().catch(() => undefined); }
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

await checkAsync('⑨ ★ 同步幂等：同一份 distill 同步两次只计一次；紧挨着调用不重复计', async () => {
	await withStore(async (_dir, make) => {
		const store = make();
		const distill = { turns: 3, written: 2 };
		await store.syncDistill(distill);
		await store.syncDistill(distill);
		assert.deepEqual((await store.snapshot()).totals.turns, 3, '同一份 distill 第二次同步不得再加');
		// 紧挨着调用（不 await）：增量必须同步算好，否则 5 会被算成 3+5
		const p1 = store.syncDistill({ turns: 5, written: 2 });
		const p2 = store.syncDistill({ turns: 5, written: 2 });
		await Promise.all([p1, p2]);
		const t = (await store.snapshot()).totals;
		assert.equal(t.turns, 5, `期望 5，实际 ${t.turns}`);
		assert.equal(t.written, 2);
	});
});

await checkAsync('⑩ ★ 重启：distill 与 lastSeen 同时归零 ⇒ 继续累加、since 保留、无负数', async () => {
	await withStore(async (dir, make) => {
		const run1 = make();
		await run1.syncDistill({ turns: 10, autoPromoted: 1 });
		await run1.flushNow();
		const since1 = (await run1.snapshot()).since;
		assert.ok(since1 > 0);

		// "重启"：新 store（lastSeen 为空）+ 新进程的 distill 从 0 起
		const run2 = make();
		assert.equal((await run2.snapshot()).totals.turns, 10, '重启后要读回上次累计');
		await run2.syncDistill({ turns: 0 });
		await run2.syncDistill({ turns: 4, autoPromoted: 2 });
		const snap = await run2.snapshot();
		assert.equal(snap.totals.turns, 14, '10 + 本次 4');
		assert.equal(snap.totals.autoPromoted, 3);
		assert.equal(snap.since, since1, 'since 必须保留（它标记"自何时起累计"）');
		await run2.flushNow();
		const onDisk = JSON.parse(await readFile(statsFileOf({ dataRoot: dir }), 'utf8'));
		assert.equal(onDisk.totals.turns, 14);
		assert.equal(onDisk.version, 1);
	});
});

await checkAsync('⑪ ★ 先读盘再累加：读盘期间发生的累加不能被旧值覆盖', async () => {
	await withStore(async (dir, make) => {
		await mkdir(path.dirname(statsFileOf({ dataRoot: dir })), { recursive: true });
		await writeFile(statsFileOf({ dataRoot: dir }), JSON.stringify({ version: 1, since: 1730000000000, totals: { turns: 100 } }), 'utf8');
		const store = make(); // 还没读盘
		const pending = store.event('humanPromoted'); // 读盘完成前就累加
		const pending2 = store.syncDistill({ turns: 1 });
		await Promise.all([pending, pending2]);
		const t = (await store.snapshot()).totals;
		assert.equal(t.turns, 101, `期望 100+1，实际 ${t.turns}（累加被旧值覆盖了？）`);
		assert.equal(t.humanPromoted, 1);
	});
});

await checkAsync('⑪ 事件：只认已知键；非正数忽略', async () => {
	await withStore(async (_dir, make) => {
		const store = make();
		await store.event('humanPromoted');
		await store.event('humanPromoted', 2);
		await store.event('turns', 5); // distill 键不能走 event（会和同步重复计）
		await store.event('nope');
		await store.event('discarded', 0);
		await store.event('undone', -3);
		const t = (await store.snapshot()).totals;
		assert.equal(t.humanPromoted, 3);
		assert.equal(t.turns, 0, 'distill 键不得通过 event 累加');
		assert.equal(t.discarded, 0); assert.equal(t.undone, 0);
	});
});

await checkAsync('⑫ 损坏文件 / 写不进去 都不抛，且仍可继续累加', async () => {
	await withStore(async (dir, make) => {
		await mkdir(path.dirname(statsFileOf({ dataRoot: dir })), { recursive: true });
		await writeFile(statsFileOf({ dataRoot: dir }), '{这不是 json', 'utf8');
		const store = make();
		await store.syncDistill({ turns: 2 });
		assert.equal((await store.snapshot()).totals.turns, 2, '损坏文件按空表起步');
		await store.flushNow();
		assert.equal(JSON.parse(await readFile(statsFileOf({ dataRoot: dir }), 'utf8')).totals.turns, 2, '落盘后文件应恢复为合法 JSON');
	});
	// 数据根指向一个"文件"而不是目录 ⇒ mkdir 必失败 ⇒ 不抛、告警只喊一次
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-stats-bad-'));
	try {
		const blocker = path.join(dir, 'blocker');
		await writeFile(blocker, 'x', 'utf8');
		const warns = [];
		const store = createStatsStore({ dataRoot: blocker }, { flushMs: 0, logger: { warn: m => warns.push(m) } });
		await store.syncDistill({ turns: 1 });
		await store.flushNow();
		await store.syncDistill({ turns: 2 });
		await store.flushNow();
		assert.equal((await store.snapshot()).totals.turns, 2, '落盘失败不影响内存累计');
		assert.equal(warns.length, 1, `同类失败只告警一次，实际 ${warns.length}`);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 注入预览/统计测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 注入预览/统计测试通过（${results.length} 项）`);
