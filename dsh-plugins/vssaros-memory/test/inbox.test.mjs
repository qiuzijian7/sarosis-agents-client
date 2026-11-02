/*---------------------------------------------------------------------------------------------
 *  inbox.test.mjs — 记忆工作台 v2 · 收件箱（★ 2026-11-02）
 *
 * ## 本测试钉住
 *  ① 视图模型：三组分类（待审 / 自动提升动态 / 已处理）、待审按 hits 降序
 *  ② 门控透明：每条待审候选都带"为什么没被自动提升"，且人话里说得出还差几次
 *  ③ 请求校验：动作白名单、去重、条数上限、改写文本区间
 *  ④ 草稿存储：mark 的来源标记白名单、回到待审要清标记；edit 不改 digest、只记一次原文
 *  ⑤ 撤销：丢弃→待审（不碰网关）；提升→**先忘长期层再改草稿**，忘失败草稿不能动
 *  ⑥ 批量：逐条独立，一条失败不拖累其它
 *  ⑦ 端到端：自动提升的条目出现在「自动提升动态」，撤销后回到待审且长期层被忘掉
 *  ⑧ 接线守卫：路由存在、要求 JSON、forget 依赖已注入、新模块进 files 白名单
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	INBOX_BATCH_MAX,
	INBOX_EDIT_MAX_CHARS,
	buildInbox,
	hintOfReason,
	parseInboxAction,
	whyNotPromoted,
} from '../lib/core/inbox.js';
import { createDraftStore, draftRowsOf } from '../lib/draft.js';
import { createPromoter } from '../lib/promote.js';

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

const CFG = { mode: 'high-only', minHits: 2 };
const NOW = Date.now(); // ⚠ 夹具时间必须是"现在"：草稿有 30 天 TTL，老时间戳会被压缩逻辑立刻清空

/** 草稿夹具（直接是落盘行的形状）。 */
const row = (over = {}) => ({
	id: 'd1', at: NOW, status: 'draft', matched: '习惯约定', digest: 'dg1',
	text: '以后所有构建都必须走 pnpm，不要用 npm', chars: 24, sessionId: 's1', turn: 1, hits: 1, ...over,
});

/** 临时目录 + 草稿存储 + 提升器（remember / forget 换成探针）。 */
async function harness(over = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'vs-mem-inbox-'));
	const store = createDraftStore({ dataRoot: dir });
	const writes = [];
	const forgets = [];
	const audits = [];
	const promoter = createPromoter({
		draftStore: store,
		remember: async (base, agentId, entry) => { writes.push(entry); return { ok: true }; },
		forget: over.forget ?? (async (base, agentId, memoryId, reason) => { forgets.push({ memoryId, reason }); return true; }),
		auditAppend: async r => { audits.push(r); },
		gatewayBase: 'http://127.0.0.1:3112',
		agentId: 'gr',
	});
	return { dir, store, promoter, writes, forgets, audits, done: () => rm(dir, { recursive: true, force: true }) };
}

check('① 视图模型：三组分类 + 待审按 hits 降序', () => {
	const rows = [
		row({ id: 'p1', digest: 'a', hits: 1, at: NOW - 3000 }),
		row({ id: 'p2', digest: 'b', hits: 3, at: NOW - 5000 }),
		row({ id: 'p3', digest: 'c', hits: 3, at: NOW - 1000 }),
		row({ id: 'a1', digest: 'd', status: 'promoted', promotedBy: 'auto-distill', updatedAt: NOW - 100 }),
		row({ id: 'h1', digest: 'e', status: 'promoted', promotedBy: 'human', updatedAt: NOW - 200 }),
		row({ id: 'h0', digest: 'f', status: 'promoted', updatedAt: NOW - 300 }), // 老数据：没有来源标记 ⇒ 当人工
		row({ id: 'r1', digest: 'g', status: 'rejected', updatedAt: NOW - 400 }),
	];
	const inbox = buildInbox(rows, CFG);
	assert.deepEqual(inbox.pending.map(r => r.id), ['p3', 'p2', 'p1'], 'hits 高的在前；同 hits 时最近的在前');
	assert.deepEqual(inbox.autos.map(r => r.id), ['a1'], '只有 promotedBy=auto-distill 才算自动提升动态');
	assert.deepEqual(inbox.done.map(r => r.id), ['h1', 'h0', 'r1'], '人工/老数据/已丢弃都在「已处理」，最近的在前');
	assert.deepEqual(inbox.counts, { pending: 3, autos: 1, done: 3 });
	return 'ok';
});

check('② 门控透明：每条待审都带原因，人话里说得出还差几次', () => {
	const cases = [
		[row({ hits: 1 }), 'hits<2', /再出现 1 次/],
		[row({ matched: '强调提醒', hits: 5 }), 'weak-kind:强调提醒', /不进自动通道/],
		[row({ matched: 'session-summary', hits: 5 }), 'summary-needs-human', /永远需要人工/],
		[row({ hits: 2 }), 'awaiting-judge', /等下一回合/],
		[row({ text: '太短了', chars: 3, hits: 2 }), 'too-short', /太短/],
		[row({ text: 'password 是 hunter2 请记住它保存好', chars: 24, hits: 2 }), 'sensitive', /凭证/],
	];
	for (const [r, why, hint] of cases) {
		const v = whyNotPromoted(r, CFG);
		assert.equal(v.why, why, `${r.matched}/hits=${r.hits}`);
		assert.match(v.hint, hint);
	}
	assert.equal(whyNotPromoted(row({ hits: 9 }), { mode: 'off', minHits: 2 }).why, 'mode-off');
	// summary-fact 的下限：即使 minHits=1，hits=1 仍然不够
	assert.equal(whyNotPromoted(row({ matched: 'summary-fact', hits: 1 }), { mode: 'high-only', minHits: 1 }).why, 'hits<2');
	// 视图里确实带上了（不是只有函数能算）
	const inbox = buildInbox([row({ hits: 1 })], CFG);
	assert.equal(inbox.pending[0].why, 'hits<2');
	assert.deepEqual(inbox.reasons, { 'hits<2': 1 });
	assert.ok(hintOfReason('奇怪的原因').length > 0, '未知原因也要给出可读文本');
	return 'ok';
});

check('③ 请求校验：白名单 / 去重 / 上限 / 改写区间', () => {
	assert.equal(parseInboxAction({ action: 'drop-table', ids: ['a'] }).ok, false, '不认识的动作');
	assert.equal(parseInboxAction({ action: 'promote', ids: [] }).ok, false, '缺 ids');
	assert.equal(parseInboxAction(null).ok, false, '空体');
	const dup = parseInboxAction({ action: 'promote', ids: ['a', 'a', 'b', 7, ''] });
	assert.deepEqual(dup.ids, ['a', 'b'], '去重且丢弃非字符串');
	const many = Array.from({ length: INBOX_BATCH_MAX + 1 }, (_, i) => `id${i}`);
	assert.equal(parseInboxAction({ action: 'discard', ids: many }).ok, false, `超过 ${INBOX_BATCH_MAX} 条要拒`);
	assert.equal(parseInboxAction({ action: 'edit-promote', ids: ['a', 'b'], text: '一二三四五' }).ok, false, '改写一次只能 1 条');
	assert.equal(parseInboxAction({ action: 'edit-promote', ids: ['a'], text: '短' }).ok, false, '改写文本太短');
	assert.equal(parseInboxAction({ action: 'edit-promote', ids: ['a'], text: 'x'.repeat(INBOX_EDIT_MAX_CHARS + 1) }).ok, false, '改写文本太长');
	assert.equal(parseInboxAction({ action: 'edit-promote', ids: ['a'], text: '  改写后的约定文本  ' }).text, '改写后的约定文本', '首尾空白要去掉');
	return 'ok';
});

await checkAsync('④ 草稿存储：mark 来源标记白名单；edit 不改 digest 且只记一次原文', async () => {
	const h = await harness();
	try {
		await h.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '原始文本一二三四', chars: 8, digest: 'dgx', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
		]));
		// mark 只认 promotedBy / memoryId，其它键不能借 extra 混进草稿行
		const m = await h.store.mark('d1', 'promoted', { promotedBy: 'auto-distill', memoryId: 'draft-abc', evil: 'x', digest: 'HACK' });
		assert.equal(m.ok, true);
		assert.equal(m.row.promotedBy, 'auto-distill');
		assert.equal(m.row.memoryId, 'draft-abc');
		assert.equal(m.row.evil, undefined, '白名单之外的键必须丢弃');
		assert.equal(m.row.digest, 'dgx', 'digest 不得被 extra 覆盖');
		// 回到待审 ⇒ 来源标记必须清掉，否则它会继续被算进「自动提升动态」
		const back = await h.store.mark('d1', 'draft');
		assert.equal(back.row.promotedBy, undefined);
		assert.equal(back.row.memoryId, undefined);

		const e1 = await h.store.edit('d1', '改写后的第一版');
		assert.equal(e1.ok, true);
		assert.equal(e1.row.digest, 'dgx', '★ 改写不得改 digest（否则原句下次会被当成全新候选）');
		assert.equal(e1.row.originalText, '原始文本一二三四');
		assert.equal(e1.row.chars, 7);
		const e2 = await h.store.edit('d1', '改写后的第二版');
		assert.equal(e2.row.originalText, '原始文本一二三四', '再次改写不覆盖最初的原文');
		await h.store.mark('d1', 'rejected');
		assert.equal((await h.store.edit('d1', '已丢弃的不能改')).ok, false, '非待审草稿不能改写');
		assert.equal((await h.store.edit('d1', '   ')).ok, false, '空正文要拒');
	} finally { await h.done(); }
	return 'ok';
});

await checkAsync('⑤ 撤销：丢弃→待审不碰网关；提升→先忘长期层再改草稿', async () => {
	const h = await harness();
	try {
		await h.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '以后用 pnpm 装依赖', chars: 12, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
			{ id: 'd2', at: NOW, text: '约定所有包都要 bump 版本', chars: 14, digest: 'dg2', matched: '项目规范', source: { sessionId: 's', turn: 2 } },
		]));
		// 丢弃 → 撤销
		await h.promoter.discard('d1');
		const r1 = await h.promoter.restore('d1');
		assert.equal(r1.ok, true);
		assert.equal(h.forgets.length, 0, '撤销丢弃不得碰网关');
		assert.equal((await h.store.read()).find(r => r.id === 'd1').status, 'draft');

		// 提升 → 撤销
		const p = await h.promoter.promote('d2');
		assert.equal(p.ok, true);
		const promoted = (await h.store.read()).find(r => r.id === 'd2');
		assert.equal(promoted.memoryId, p.memoryId, '提升时必须记下长期层 id（撤销要靠它）');
		const r2 = await h.promoter.restore('d2');
		assert.equal(r2.ok, true, r2.error);
		assert.equal(h.forgets.length, 1);
		assert.equal(h.forgets[0].memoryId, p.memoryId, '必须忘掉提升时写进去的那一条');
		assert.equal((await h.store.read()).find(r => r.id === 'd2').status, 'draft');

		assert.equal((await h.promoter.restore('d2')).ok, false, '已经是待审的不能再撤销');
		assert.equal((await h.promoter.restore('nope')).ok, false, '不存在的 id 要报错');
	} finally { await h.done(); }

	// ★ 反向断言：长期层没确认忘掉 ⇒ 草稿状态**不得**回到待审（否则再提升会写出重复）
	const bad = await harness({ forget: async () => false });
	try {
		await bad.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '以后用 pnpm 装依赖', chars: 12, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
		]));
		await bad.promoter.promote('d1');
		const r = await bad.promoter.restore('d1');
		assert.equal(r.ok, false, '网关没确认忘掉 ⇒ 撤销必须失败');
		assert.equal((await bad.store.read()).find(x => x.id === 'd1').status, 'promoted', '失败时草稿状态不得改动');
	} finally { await bad.done(); }

	// 没注入 forget（旧探针）⇒ 明确报错而不是假装成功
	const noForget = await harness({ forget: null });
	try {
		const bare = createPromoter({ draftStore: noForget.store, remember: async () => ({ ok: true }), gatewayBase: 'http://x', agentId: 'gr' });
		await noForget.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '以后用 pnpm 装依赖', chars: 12, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
		]));
		await bare.promote('d1');
		const r = await bare.restore('d1');
		assert.equal(r.ok, false);
		assert.match(r.error, /forget/);
	} finally { await noForget.done(); }
	return 'ok';
});

await checkAsync('⑥ 批量：逐条独立，一条失败不拖累其它；改写后提升走同一条 promote', async () => {
	const h = await harness();
	try {
		await h.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '以后用 pnpm 装依赖', chars: 12, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
			{ id: 'd2', at: NOW, text: '约定所有包都要 bump 版本', chars: 14, digest: 'dg2', matched: '项目规范', source: { sessionId: 's', turn: 2 } },
		]));
		const out = await h.promoter.batch('promote', ['d1', 'ghost', 'd2']);
		assert.equal(out.done, 2);
		assert.equal(out.failed, 1);
		assert.equal(out.ok, false, '有失败时整体 ok 为 false');
		assert.deepEqual(out.results.map(r => r.ok), [true, false, true], '失败的是中间那条，前后都成功');
		assert.equal(h.writes.length, 2);

		assert.equal((await h.promoter.batch('rm -rf', ['d1'])).ok, false, '未知动作要失败');
		assert.equal((await h.promoter.batch('promote', [])).ok, false, '空 ids 不算成功');

		// 改写后提升：写进长期层的是**改写后的**文本
		await h.promoter.batch('restore', ['d1']);
		const edited = await h.promoter.batch('edit-promote', ['d1'], { text: '所有构建统一使用 pnpm（禁用 npm）' });
		assert.equal(edited.ok, true, JSON.stringify(edited.results));
		assert.equal(h.writes.at(-1).content, '所有构建统一使用 pnpm（禁用 npm）');
		assert.equal((await h.store.read()).find(r => r.id === 'd1').originalText, '以后用 pnpm 装依赖', '原文要留着');
	} finally { await h.done(); }
	return 'ok';
});

await checkAsync('⑦ 端到端：自动提升 → 出现在动态里 → 撤销 → 回到待审且长期层被忘掉', async () => {
	const h = await harness();
	try {
		await h.store.append(draftRowsOf([
			{ id: 'auto1', at: NOW, text: '以后所有构建都必须走 pnpm，不要用 npm', chars: 24, digest: 'dga', matched: '习惯约定', source: { sessionId: 's', turn: 3 } },
			{ id: 'hum1', at: NOW, text: '约定所有包都要 bump 版本', chars: 14, digest: 'dgh', matched: '项目规范', source: { sessionId: 's', turn: 4 } },
		]));
		await h.promoter.promote('auto1', { policy: 'auto-distill' });
		await h.promoter.promote('hum1');

		let inbox = buildInbox(await h.store.read(), CFG);
		assert.deepEqual(inbox.autos.map(r => r.id), ['auto1'], '自动提升的出现在动态里');
		assert.deepEqual(inbox.done.map(r => r.id), ['hum1'], '人工提升的只在「已处理」');
		assert.equal(inbox.counts.pending, 0);

		const undo = await h.promoter.restore('auto1');
		assert.equal(undo.ok, true, undo.error);
		inbox = buildInbox(await h.store.read(), CFG);
		assert.deepEqual(inbox.autos, [], '撤销后不再算自动提升动态');
		assert.deepEqual(inbox.pending.map(r => r.id), ['auto1'], '回到待审');
		assert.equal(h.forgets.length, 1);
		assert.ok(h.audits.some(a => a.tool === 'memory_undo_promote(page)' && a.outcome === 'ok'), '撤销必须留审计');
	} finally { await h.done(); }
	return 'ok';
});

await checkAsync('⑨ ★ 真 HTTP：批量动作路由的方法 / content-type / 体积 / 白名单 / 落盘', async () => {
	// 纯函数都对 ≠ 路由层对：这里起一个真 http 服务器挂上 `handleInboxAct`，用真请求打。
	const { createServer } = await import('node:http');
	const { handleInboxActForTest } = await import('../lib/index.js');
	const h = await harness();
	const warns = [];
	const server = createServer((req, res) => { void handleInboxActForTest(req, res, { promoter: h.promoter, logger: { warn: m => warns.push(m) } }); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (body, headers = { 'content-type': 'application/json' }) => fetch(base, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
	try {
		await h.store.append(draftRowsOf([
			{ id: 'd1', at: NOW, text: '以后用 pnpm 装依赖', chars: 12, digest: 'dg1', matched: '习惯约定', source: { sessionId: 's', turn: 1 } },
			{ id: 'd2', at: NOW, text: '约定所有包都要 bump 版本', chars: 14, digest: 'dg2', matched: '项目规范', source: { sessionId: 's', turn: 2 } },
		]));

		assert.equal((await fetch(base)).status, 405, 'GET 必须 405（避免被链接预取触发写入）');
		// 跨站表单只能发 urlencoded/multipart/text/plain ⇒ 必须被 415 挡住
		for (const ct of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
			const r = await post('action=promote&ids=d1', { 'content-type': ct });
			assert.equal(r.status, 415, `${ct} 必须被拒`);
		}
		assert.equal((await h.store.read()).filter(r => r.status === 'draft').length, 2, '被拒的请求不得动草稿');

		assert.equal((await post('{坏 json')).status, 400, '坏 JSON');
		assert.equal((await post({ action: 'drop', ids: ['d1'] })).status, 400, '动作不在白名单');
		assert.equal((await post({ action: 'promote', ids: [] })).status, 400, '缺 ids');
		assert.equal((await post(JSON.stringify({ action: 'promote', ids: ['d1'], pad: 'x'.repeat(70 * 1024) }))).status, 413, '体积闸');

		// 合法请求：批量提升 d1 + 不存在的 ghost ⇒ HTTP 200，逐条结果，d1 真落盘
		const ok = await post({ action: 'promote', ids: ['d1', 'ghost'] });
		assert.equal(ok.status, 200);
		const out = await ok.json();
		assert.equal(out.done, 1); assert.equal(out.failed, 1);
		assert.deepEqual(out.results.map(r => r.ok), [true, false]);
		assert.equal((await h.store.read()).find(r => r.id === 'd1').status, 'promoted', '必须真的落盘');
		assert.equal(h.writes.length, 1);
		assert.ok(warns.some(w => /失败 1\/2/.test(w)), '有失败时必须留日志');

		// 撤销走同一路由
		const undo = await (await post({ action: 'restore', ids: ['d1'] })).json();
		assert.equal(undo.done, 1, JSON.stringify(undo));
		assert.equal((await h.store.read()).find(r => r.id === 'd1').status, 'draft');
		assert.equal(h.forgets.length, 1);
	} finally {
		await new Promise(resolve => server.close(resolve));
		await h.done();
	}
	return 'ok';
});

await checkAsync('⑧ ★ 接线守卫：路由 / JSON 要求 / forget 注入 / files 白名单', async () => {
	const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /\$\{PAGE_ROUTE\}api\/inbox`/, '缺 GET api/inbox 路由');
	assert.match(src, /\$\{PAGE_ROUTE\}api\/inbox\/act`/, '缺 POST api/inbox/act 路由');
	assert.match(src, /handleInboxAct\(req, res, \{ promoter/, '批量动作路由必须真交给 handleInboxAct');
	// 写动作必须校验 content-type（跨站表单只能发 urlencoded/multipart/text，发不出 JSON）。
	// 2026-11-02：请求体防线抽成共用的 `readJsonBody`（收件箱 + 归档恢复两条写路由同一套）⇒
	// 守卫分两层钉：① 共用函数里有这些防线；② 每条写路由确实调用它（不能绕开自己读 body）。
	const rb = src.slice(src.indexOf('async function readJsonBody'), src.indexOf('async function readJsonBody') + 2600);
	assert.match(rb, /application\\\/json/, '请求体读取必须要求 application/json');
	assert.match(rb, /req\.method !== 'POST'/, '请求体读取必须只收 POST');
	assert.match(rb, /JSON_BODY_MAX/, '必须有体积闸');
	const fn = src.slice(src.indexOf('async function handleInboxAct'), src.indexOf('async function handleInboxAct') + 1200);
	assert.match(fn, /readJsonBody\(req, res\)/, '批量动作必须经 readJsonBody 读体');
	assert.match(fn, /parseInboxAction\(body\)/, '必须过白名单校验再碰草稿');
	const ar = src.slice(src.indexOf('async function handleArchiveRestore'), src.indexOf('async function handleArchiveRestore') + 1200);
	assert.match(ar, /readJsonBody\(req, res\)/, '归档恢复必须经 readJsonBody 读体');
	assert.match(src, /forget: forgetMemory,/, 'createPromoter 必须注入 forget（否则撤销提升永远报错）');
	const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(pkg.files.includes('lib/core/inbox.js'), 'lib/core/inbox.js 必须进 files 白名单（漏了装好后 import 失败）');
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 收件箱测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 收件箱测试通过（${results.length} 项）`);
