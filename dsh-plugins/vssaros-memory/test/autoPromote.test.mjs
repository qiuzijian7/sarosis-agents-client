/*---------------------------------------------------------------------------------------------
 *  autoPromote.test.mjs — 自动提升门控（★ 2026-11-02）
 *
 * ## 背景
 * 沉淀链断在"草稿 → 长期层"这一段：`agent/turn-stopping` 每回合都在产草稿
 * （dev 库实测 17 条），但长期层最后一次写入是 2026-09-25 ⇒ 5 周零写入。
 * 补上自动提升，但必须**极窄**（错的记忆会被喂给之后每一轮）。
 *
 * ## 本测试钉住
 *  ① 档位：缺省 `high-only`；不认识的档位回落 `off`（宁少不多）
 *  ② 五条硬条件逐条否决：摘要类 / 弱句式（强调提醒）/ 判定不可用 / 太短太长 / 疑似凭证
 *  ③ **fail-closed**：判定没结论（`judgeOk !== true`）⇒ 一条都不提（与草稿路径相反）
 *  ④ 重复证据：`hits < 2` 不提；`hits >= 2` 才提
 *  ⑤ 每回合最多 1 条
 *  ⑥ `repeatedDigestsOf` 只挑"已有草稿里出现过"的，未见过的不算重复
 *  ⑦ `draftStore.bump`：只给 `status==='draft'` 的行累加 hits
 *  ⑧ `promote(id, {policy:'auto-distill'})`：审计里 **必须**能区分"人按的"与"自动的"
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	AUTO_PROMOTE_MAX_PER_TURN,
	DEFAULT_AUTO_PROMOTE,
	DEFAULT_AUTO_PROMOTE_MIN_HITS,
	decideAutoPromotion,
	pickAutoPromotions,
	resolveAutoPromote,
} from '../lib/core/promotion.js';
import { extractCandidates, repeatedDigestsOf, repeatedSummaryFactDigestsOf, summaryFactsOf } from '../lib/core/distill.js';
import { createDraftStore, draftRowsOf } from '../lib/draft.js';
import { createPromoter } from '../lib/promote.js';

// ★ 探针后门（`lib/foundationRef.js` 的既定入口）：进程内测试没有 cordis 服务发现
// ⇒ 用最小实现满足 `dataRootOf`，让 `createDraftStore` 能把草稿写进临时目录。
globalThis.__VSSAROS_FOUNDATION__ = {
	dataRootOf: config => String(config?.dataRoot ?? ''),
};

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};
const checkAsync = async (name, fn) => {
	try { const d = await fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

/** 一条可自动提升的候选（五条条件全满足）。 */
const good = (over = {}) => ({
	id: 'draft-1', matched: '习惯约定', text: '以后所有构建都必须走 pnpm，不要用 npm', chars: 24, hits: 2, ...over,
});

check('① 缺省档位是 high-only；不认识的档位回落 off', () => {
	assert.equal(DEFAULT_AUTO_PROMOTE, 'high-only');
	assert.equal(resolveAutoPromote({}).mode, 'high-only');
	assert.equal(resolveAutoPromote({ autoPromote: 'off' }).mode, 'off');
	assert.equal(resolveAutoPromote({ autoPromote: 'all' }).mode, 'off', '不认识的档位必须回落 off（宁少不多）');
	assert.equal(resolveAutoPromote({}).minHits, DEFAULT_AUTO_PROMOTE_MIN_HITS);
	assert.equal(resolveAutoPromote({ autoPromoteMinHits: 3 }).minHits, 3);
	assert.equal(resolveAutoPromote({ autoPromoteMinHits: 0 }).minHits, DEFAULT_AUTO_PROMOTE_MIN_HITS, '非法阈值回落缺省');
	return 'ok';
});

check('② 五条硬条件全部满足才提', () => {
	const ok = decideAutoPromotion(good(), { mode: 'high-only', judgeOk: true });
	assert.equal(ok.promote, true, `应提升，实际 reason=${ok.reason}`);
	return ok.reason;
});

check('②a 档位 off ⇒ 一条都不提', () => {
	assert.equal(decideAutoPromotion(good(), { mode: 'off', judgeOk: true }).promote, false);
	return 'ok';
});

check('②b 摘要类（turn-summary / session-summary）⇒ 必须人工', () => {
	for (const kind of ['turn-summary', 'session-summary']) {
		const r = decideAutoPromotion(good({ matched: kind }), { mode: 'high-only', judgeOk: true });
		assert.equal(r.promote, false);
		assert.equal(r.reason, 'summary-needs-human');
	}
	return 'ok';
});

check('②c 弱句式（强调提醒：注意/务必/必须）⇒ 不进自动通道', () => {
	const r = decideAutoPromotion(good({ matched: '强调提醒' }), { mode: 'high-only', judgeOk: true });
	assert.equal(r.promote, false);
	assert.match(r.reason, /^weak-kind:/);
	return 'ok';
});

check('②d 太短 / 太长 / 疑似凭证 ⇒ 不提', () => {
	assert.equal(decideAutoPromotion(good({ chars: 5 }), { mode: 'high-only', judgeOk: true }).reason, 'too-short');
	assert.equal(decideAutoPromotion(good({ chars: 500 }), { mode: 'high-only', judgeOk: true }).reason, 'too-long');
	assert.equal(decideAutoPromotion(good({ text: '以后 api_key 统一放 .env 里，不要写死' }), { mode: 'high-only', judgeOk: true }).reason, 'sensitive');
	return 'ok';
});

check('③ ★ fail-closed：判定没结论 ⇒ 一条都不提（与草稿路径相反）', () => {
	for (const judgeOk of [undefined, false]) {
		const r = decideAutoPromotion(good(), { mode: 'high-only', judgeOk });
		assert.equal(r.promote, false, '判定不可用时不得提升');
		assert.equal(r.reason, 'judge-unavailable');
	}
	return 'ok';
});

check('④ 重复证据：hits=1 不提，hits=2 才提', () => {
	assert.equal(decideAutoPromotion(good({ hits: 1 }), { mode: 'high-only', judgeOk: true }).promote, false);
	assert.equal(decideAutoPromotion(good({ hits: 1 }), { mode: 'high-only', judgeOk: true }).reason, 'hits<2');
	assert.equal(decideAutoPromotion(good({ hits: 2 }), { mode: 'high-only', judgeOk: true }).promote, true);
	// 阈值可调（激进档：hits=1 也提）
	assert.equal(decideAutoPromotion(good({ hits: 1 }), { mode: 'high-only', judgeOk: true, minHits: 1 }).promote, true);
	return 'ok';
});

check('⑤ 每回合最多 1 条（多余记 turn-quota）', () => {
	const pool = [good({ id: 'a' }), good({ id: 'b' })];
	const { selected, skipped } = pickAutoPromotions(pool, { mode: 'high-only', judgeOk: true });
	assert.equal(AUTO_PROMOTE_MAX_PER_TURN, 1);
	assert.equal(selected.length, 1);
	assert.equal(selected[0].id, 'a', '先到先得（顺序稳定，不随机）');
	assert.equal(skipped.find(s => s.id === 'b').reason, 'turn-quota');
	return 'ok';
});

check('⑥ repeatedDigestsOf：只挑已有草稿里出现过的', () => {
	// ⚠ 一句话可能同时命中多个句式（这里「以后…」+「不要…」）⇒ 断言"至少一条"，不写死条数
	const text = '以后所有构建都必须走 pnpm，不要用 npm';
	const fresh = extractCandidates([text], { sessionId: 's1', turn: 1, now: 1 });
	assert.ok(fresh.length >= 1, `首次应产出候选，实际 ${fresh.length}`);
	const seen = new Set(fresh.map(c => c.digest));
	const repeats = repeatedDigestsOf([text], seen, { maxPerTurn: 3 });
	assert.deepEqual(repeats, fresh.map(c => c.digest), '同一批句子第二次出现应全部算重复命中');
	assert.deepEqual(repeatedDigestsOf([text], new Set()), [], '没有历史草稿 ⇒ 不算重复');
	assert.deepEqual(repeatedDigestsOf(['今天天气不错'], seen), [], '没命中句式 ⇒ 不算重复');
	return 'ok';
});

await checkAsync('⑦ draftStore.bump：只给 draft 行累加 hits', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-bump-'));
	try {
		const store = createDraftStore({ dataRoot: dir });
		const rows = draftRowsOf([
			// ⚠ 时间戳必须"现在"：草稿有 30 天 TTL（`pruneDrafts`），用固定老时间会被追加后的
			//   压缩逻辑**立刻清空** ⇒ 断言会以"文件是空的"这种误导性形态失败（本次踩到）
			{ id: 'd1', at: Date.now(), text: 'a', chars: 1, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
			{ id: 'd2', at: Date.now(), text: 'b', chars: 1, digest: 'dg2', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
		]);
		await store.append(rows);
		await store.mark('d2', 'promoted');

		const bumped = await store.bump(['dg1', 'dg2']);
		assert.equal(bumped, 1, '只有 status=draft 的那行该累加');

		const after = await store.read();
		const byDigest = new Map(after.map(r => [r.digest, r]));
		assert.equal(byDigest.get('dg1').hits, 2, '首次 bump 应从"缺省 1"变成 2');
		assert.equal(byDigest.get('dg2').hits, undefined, '已提升的行不得累加');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return 'ok';
});

await checkAsync('⑧ promote(auto-distill)：审计里能区分"自动"与"人工"', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-promote-'));
	try {
		const store = createDraftStore({ dataRoot: dir });
		await store.append(draftRowsOf([
			{ id: 'draft-auto', at: Date.now(), text: '以后所有构建都必须走 pnpm，不要用 npm', chars: 24, digest: 'dgauto', matched: '习惯约定', source: { sessionId: 's', turn: 3 } },
		]));
		// hits=2（模拟"说过两次"）
		await store.bump(['dgauto']);

		const audits = [];
		const writes = [];
		const promoter = createPromoter({
			draftStore: store,
			remember: async (base, agentId, entry) => { writes.push({ base, agentId, entry }); return { ok: true }; },
			auditAppend: async row => { audits.push(row); },
			gatewayBase: 'http://127.0.0.1:3112',
			agentId: 'gr',
		});

		const result = await promoter.promote('draft-auto', { policy: 'auto-distill' });
		assert.equal(result.ok, true, `提升应成功：${result.error ?? ''}`);
		assert.equal(writes.length, 1, '必须真的发了写请求');
		assert.equal(writes[0].entry.metadata.source, 'draft');

		const executed = audits.find(a => a.action === 'executed');
		assert.ok(executed, '必须有审计');
		assert.equal(executed.policy, 'auto-distill', '★ 必须与 human 区分开');
		assert.equal(executed.tool, 'memory_promote(auto)');
		assert.match(String(executed.policyKey ?? ''), /hits=2/, '证据（hits）必须可查');

		// 落盘状态：promoted
		const rows = await store.read();
		assert.equal(rows.find(r => r.id === 'draft-auto').status, 'promoted');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return 'ok';
});

await checkAsync('⑧b 人按的仍然是 policy=human（没被自动路径改掉）', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-promote-human-'));
	try {
		const store = createDraftStore({ dataRoot: dir });
		await store.append(draftRowsOf([
			{ id: 'draft-manual', at: Date.now(), text: '以后用 pnpm', chars: 8, digest: 'dgman', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
		]));
		const audits = [];
		const promoter = createPromoter({
			draftStore: store,
			remember: async () => ({ ok: true }),
			auditAppend: async row => { audits.push(row); },
			gatewayBase: 'http://127.0.0.1:3112',
			agentId: 'gr',
		});
		await promoter.promote('draft-manual');
		const executed = audits.find(a => a.action === 'executed');
		assert.equal(executed.policy, 'human');
		assert.equal(executed.tool, 'memory_promote(page)');
		const raw = await readFile(path.join(dir, 'memory-drafts', 'drafts.jsonl'), 'utf8');
		assert.ok(raw.includes('"status":"promoted"'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return 'ok';
});

await checkAsync('⑩ summaryFactsOf：从摘要切原子事实句（噪声/短句过滤 + 条数上限）', async () => {
	const ev = {
		type: 'compaction/summary',
		data: { summary: [{ type: 'text', text: '## 本次会话摘要\n我们确定部署端口改成 8080，并且所有构建改用 pnpm。\n这是我第一次看这个仓库，感觉很乱。\n确定修复用了两次重试。\n约定：以后不要再动 config.json。\n上限是 200 条。\n' }] },
	};
	const facts = summaryFactsOf([ev], { sessionId: 's', turn: 2, now: 1 });
	// 只有 ①「确定…改成/改用…」与 ②「约定：…不要再动…」两句同时满足"有信号词 + 长度 ≥12"
	assert.equal(facts.length, 2, `实际切出 ${facts.length} 条`);
	for (const f of facts) {
		assert.equal(f.matched, 'summary-fact');
		assert.ok(f.chars >= 12 && f.chars <= 161, `长度必须受限，实际 ${f.chars}`);
	}
	// 没有信号词的叙述句不得入选
	assert.ok(!facts.some(f => f.text.includes('感觉很乱')), '纯叙述（无信号词）不该进候选');
	// 标题行不得入选
	assert.ok(!facts.some(f => f.text.startsWith('#')), '标题行不该进候选');

	// 上限：5 条合格句 ⇒ 只取 3 条
	const many = {
		type: 'compaction/summary',
		data: { summary: [{ type: 'text', text: '确定默认端口改成 8080 了。约定所有构建改用 pnpm。修复根因是缺少重试。依赖版本必须锁死。接口字段 schema 不要改。' }] },
	};
	assert.equal(summaryFactsOf([many], { sessionId: 's', turn: 3, now: 1 }).length, 3, '超过上限时最多 3 条');
	return `${facts.length} 条`;
});

check('⑪ repeatedSummaryFactDigestsOf：同一事实第二次出现才算重复', () => {
	const ev = { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '我们确定部署端口改成 8080，并且所有构建改用 pnpm。' }] } };
	const first = summaryFactsOf([ev], { sessionId: 's', turn: 1, now: 1 });
	assert.equal(first.length, 1);
	const seen = new Set(first.map(f => f.digest));
	assert.deepEqual(repeatedSummaryFactDigestsOf([ev], seen), first.map(f => f.digest), '第二次出现应算重复');
	assert.deepEqual(repeatedSummaryFactDigestsOf([ev], new Set()), [], '没有历史 ⇒ 不算重复');
	// 已进过草稿的再出现时 `summaryFactsOf` 本身会跳过（seen）⇒ 这里必须靠 repeated 捞回来
	assert.deepEqual(summaryFactsOf([ev], { sessionId: 's', turn: 2, now: 2, seenDigests: seen }), []);
	return 'ok';
});

check('⑫ summary-fact 的重复门槛不允许被 minHits=1 放宽', () => {
	const base = { id: 'fact-1', matched: 'summary-fact', text: '我们确定部署端口改成 8080', chars: 15 };
	assert.equal(decideAutoPromotion({ ...base, hits: 1 }, { mode: 'high-only', judgeOk: true, minHits: 1 }).promote, false,
		'模型转述的事实句至少要被两次摘要印证');
	assert.equal(decideAutoPromotion({ ...base, hits: 2 }, { mode: 'high-only', judgeOk: true, minHits: 1 }).promote, true);
	// 用户原话（习惯约定）在 minHits=1 时仍然可以首次即提（激进档只对"人说的话"生效）
	assert.equal(decideAutoPromotion({ id: 'd1', matched: '习惯约定', text: '以后都用 pnpm 装依赖', chars: 16, hits: 1 }, { mode: 'high-only', judgeOk: true, minHits: 1 }).promote, true);
	return 'ok';
});

await checkAsync('⑨ ★ 接线守卫：`llm` 注入与判定路由都必须覆盖自动提升档位', async () => {
	// 为什么钉这个：`distillJudge` 缺省 **false**，而自动提升需要判定证据（fail-closed）⇒
	// 若只在 `judgeEnabled` 时注入 `llm` / 取 `judgeTarget`，自动提升会**永久静默不生效**
	// （症状＝"一条都没提升"，看起来像"没有高置信候选"，极难归因）。
	const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
	const llmGate = src.match(/if \((judgeEnabled[^\r\n]*)\) \{\s*ctx\.inject\(\['llm'\]/);
	assert.ok(llmGate, '找不到 llm 注入的条件判断（守卫需同步更新）');
	assert.match(llmGate[1], /autoPromoteCfg\.mode/, 'llm 注入条件必须包含自动提升档位');
	const targetLine = src.match(/const judgeTarget = \(([^\n]*)\) \? modelTargetOf/);
	assert.ok(targetLine, '找不到 judgeTarget 的条件（守卫需同步更新）');
	assert.match(targetLine[1], /autoPromoteCfg\.mode/, 'judgeTarget 条件必须包含自动提升档位');
	// 钩子里必须真的调用提升（否则门控是死代码）
	assert.match(src, /promoter\.promote\(row\.id, \{ policy: 'auto-distill' \}\)/, '钩子必须真调 promoter.promote(..., {policy:auto-distill})');
	return 'ok';
});

await checkAsync('⑬ ★ 编排守卫：钩子里的顺序与覆盖面', async () => {
	// 这三个顺序/覆盖都是"看起来对但实际失效"的坑：
	//  ① bump 必须在 append **之后**（否则第一次永远 hits=1，永远不够 2 次）；
	//  ② 重复命中必须**两路都收**（只收显式句式 ⇒ 摘要事实的 hits 恒 1）；
	//  ③ 摘要事实必须进 append 列表（否则候选产出来却没落盘）。
	const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
	const appendAt = src.indexOf('await draftStore.append(');
	const bumpAt = src.indexOf('await draftStore.bump(');
	assert.ok(appendAt > 0 && bumpAt > 0, '找不到 append/bump 调用点（守卫需同步更新）');
	assert.ok(appendAt < bumpAt, 'bump 必须在 append 之后');

	assert.match(src, /repeatedDigestsOf\(texts, seenDigests\)/, '必须收显式句式的重复命中');
	assert.match(src, /repeatedSummaryFactDigestsOf\(events, seenDigests\)/, '必须收摘要事实的重复命中');

	assert.match(src, /draftRowsOf\(\[\.\.\.candidates, \.\.\.summaries, \.\.\.turnCandidates, \.\.\.summaryFacts\]\)/,
		'摘要事实候选必须进 append 列表');
	return 'ok';
});

await checkAsync('⑭ ★ 端到端：同一句约定说两次 ⇒ 草稿 hits=2 ⇒ 自动提升真的写了长期层', async () => {
	// 这条串的是**真实模块**（distill → draftStore → promotion → promoter），
	// 只把 `remember`（网关）与 `auditAppend`（账本）换成探针 ⇒ 证明接口形状真对得上。
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-e2e-'));
	try {
		const store = createDraftStore({ dataRoot: dir });
		const writes = [];
		const audits = [];
		const promoter = createPromoter({
			draftStore: store,
			remember: async (base, agentId, entry) => { writes.push(entry); return { ok: true }; },
			auditAppend: async row => { audits.push(row); },
			gatewayBase: 'http://127.0.0.1:3112',
			agentId: 'gr',
		});
		const text = '以后所有构建都必须走 pnpm，不要用 npm';

		// ── 回合 1：首次出现 ⇒ 只产草稿，不提升
		let seen = await store.seen();
		const first = extractCandidates([text], { sessionId: 's1', turn: 1, seenDigests: seen, now: Date.now() });
		assert.ok(first.length >= 1, '回合 1 应产出草稿');
		await store.append(draftRowsOf(first));
		let repeated = repeatedDigestsOf([text], seen);
		assert.deepEqual(repeated, [], '回合 1 没有历史 ⇒ 不算重复');
		assert.equal(writes.length, 0, '回合 1 不得写长期层');

		// ── 回合 2：同一句再说一次 ⇒ 命中 seen（不再产新草稿）但算重复
		seen = await store.seen();
		const second = extractCandidates([text], { sessionId: 's1', turn: 2, seenDigests: seen, now: Date.now() });
		assert.deepEqual(second, [], '回合 2 不该产生重复草稿');
		repeated = repeatedDigestsOf([text], seen);
		// ⚠ 一句话可能同时命中多个句式 ⇒ 重复命中的条数 ≥1（不写死，避免脆断言）
		assert.ok(repeated.length >= 1, `回合 2 应算重复，实际 ${repeated.length}`);

		const bumped = await store.bump(repeated);
		assert.ok(bumped >= 1);
		const rows = await store.read();
		const pool = repeated.map(d => rows.find(r => r.digest === d)).filter(r => r && r.status === 'draft');
		assert.equal(pool[0].hits, 2, '累计后 hits 应为 2');

		const { selected } = pickAutoPromotions(pool, { mode: 'high-only', judgeOk: true });
		assert.equal(selected.length, 1, '应选中 1 条自动提升');
		const result = await promoter.promote(selected[0].id, { policy: 'auto-distill' });
		assert.equal(result.ok, true, `提升失败：${result.error ?? ''}`);

		assert.equal(writes.length, 1, '★ 长期层必须真的收到一条写入');
		assert.match(writes[0].content, /pnpm/, '写进去的必须是那句约定');
		assert.equal((await store.read()).find(r => r.id === selected[0].id).status, 'promoted');
		assert.equal(audits.find(a => a.action === 'executed').policy, 'auto-distill');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 自动提升门控测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 自动提升门控测试通过（${results.length} 项）`);
