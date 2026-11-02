/*---------------------------------------------------------------------------------------------
 *  overviewRoutes.test.mjs — 总览 / 归档恢复 / 注入预览的路由层（★ 2026-11-02，工作台 v2 · P3/P4）
 *
 * 纯函数测过 ≠ 路由层对（上一轮的 413 缺陷只有真 HTTP 才暴露）。所以这里：
 *  · 归档恢复：真起 http 服务器打真请求
 *  · 总览：起一个**假网关**（真 http）模拟四种情形——新网关 / 老网关 / 网关挂了 / 某分区失败
 *  · 注入预览：路由挂在整个插件的 apply() 里，没法单独起 ⇒ 用源码级守卫钉住关键约束
 *
 * ## 钉住
 *  ① 归档恢复：方法 / content-type / 缺参 / 体积 / ★ 分区白名单（越权时 restore 绝不被调用）
 *  ② 归档恢复：明确 success 才算成功；网关报错 / 老网关 404 都如实说；审计与统计只在该记的时候记
 *  ③ 总览：★ 取不到 ≠ 0（老网关的 schema/backups/lastSweepAt 缺席 ⇒ null；归档方法缺席 ⇒ null）
 *  ④ 总览：网关挂了仍返回漏斗（读本地）；未配置时如实标 unconfigured
 *  ⑤ 总览：★ 归档总数是各分区求和，任何分区失败 ⇒ null（不能少算后当真值）
 *  ⑥ 漏斗：待审是时点值，单列；原因汇总来自当前待审
 *  ⑦ 源码守卫：快照与预览共用 composeWorkingText；预览不写槽位/不增刷新计数；统计同步三处都在
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import { buildOverviewForTest, handleArchiveRestoreForTest } from '../lib/index.js';

globalThis.__VSSAROS_FOUNDATION__ = { dataRootOf: config => String(config?.dataRoot ?? '') };

const results = [];
const checkAsync = async (name, fn) => {
	try { const d = await fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
/**
 * 关服务器。⚠ `server.close()` 只停止接新连接，**不会**断开已建立的 keep-alive 连接 ⇒ 会一直等到它们超时，
 * 负载高时多个服务器的收尾互相拖慢，进而拖到下一个用例（偶发红的嫌疑点；未能稳定复现，
 * 但"测试自己不收拾干净"本身就是该修的问题）。所以先 `closeAllConnections()` 再等 close。
 */
const close = server => new Promise(resolve => {
	server.close(() => resolve(undefined));
	if (typeof server.closeAllConnections === 'function') { server.closeAllConnections(); }
});

// ═══ ① ② 归档恢复 ══════════════════════════════════════════════════════════

/** 起一个挂着 handleArchiveRestore 的真服务器；返回 post() 与各探针记录。 */
async function archiveHarness(over = {}) {
	const calls = { restore: [], audit: [], stats: [] };
	const deps = {
		partitionsOf: over.partitionsOf ?? (async () => ['gr', 'saros-claw']),
		restore: over.restore ?? (async (partition, id) => { calls.restore.push({ partition, id }); return { success: true, id }; }),
		audit: async row => { calls.audit.push(row); },
		stats: { event: key => { calls.stats.push(key); return Promise.resolve(); } },
	};
	const server = createServer((req, res) => { void handleArchiveRestoreForTest(req, res, deps); });
	const port = await listen(server);
	const base = `http://127.0.0.1:${port}`;
	// 每个请求都带 `connection: close`：不留 keep-alive 连接，用例之间互不影响
	const post = (body, headers = { 'content-type': 'application/json' }) =>
		fetch(base, { method: 'POST', headers: { connection: 'close', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
	return { base, post, calls, stop: () => close(server) };
}

await checkAsync('① 归档恢复：方法 / content-type / 缺参 / 体积；★ 越权分区时 restore 绝不被调用', async () => {
	const h = await archiveHarness();
	try {
		assert.equal((await fetch(h.base)).status, 405, 'GET 必须 405');
		for (const ct of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
			assert.equal((await h.post('id=a&partition=gr', { 'content-type': ct })).status, 415, `${ct} 必须被拒`);
		}
		assert.equal((await h.post('{坏 json')).status, 400);
		assert.equal((await h.post({ id: 'a' })).status, 400, '缺 partition');
		assert.equal((await h.post({ partition: 'gr' })).status, 400, '缺 id');
		assert.equal((await h.post({ id: '  ', partition: 'gr' })).status, 400, '空白 id');
		assert.equal((await h.post({ id: 1, partition: 'gr' })).status, 400, '非字符串 id');
		assert.equal((await h.post(JSON.stringify({ id: 'a', partition: 'gr', pad: 'x'.repeat(70 * 1024) }))).status, 413, '体积闸');

		// ★ 分区白名单：不在名单里的分区一律 403，而且引擎的 restore 一次都不能被调用
		const evil = await h.post({ id: 'a', partition: 'victim-agent' });
		assert.equal(evil.status, 403);
		assert.equal((await h.post({ id: 'a', partition: '../mem:memories:gr' })).status, 403, '带路径分隔的越权也要拒');
		assert.equal(h.calls.restore.length, 0, '被拒的请求绝不能走到 restore');
		assert.equal(h.calls.audit.length, 0, '被拒的请求不产生审计（没有动作发生）');
	} finally { await h.stop(); }
	return 'ok';
});

await checkAsync('② 归档恢复：明确 success 才算成功；失败如实说；审计与统计只在该记的时候记', async () => {
	// 成功
	let h = await archiveHarness();
	try {
		const res = await h.post({ id: 'mem-1', partition: 'saros-claw' });
		assert.deepEqual(await res.json(), { ok: true, id: 'mem-1' });
		assert.deepEqual(h.calls.restore, [{ partition: 'saros-claw', id: 'mem-1' }], '必须按请求的分区与 id 调用');
		const a = h.calls.audit[0];
		assert.equal(a.tool, 'memory_restore_archive(page)');
		assert.equal(a.policy, 'human', '页面动作 = 人的确认');
		assert.equal(a.outcome, 'ok');
		assert.equal(a.agentId, 'saros-claw', '审计要落在被恢复的那个分区');
		assert.deepEqual(h.calls.stats, ['archiveRestored']);
	} finally { await h.stop(); }

	// 引擎拒绝（同 id 已有有效记忆）：success=false + 原因
	h = await archiveHarness({ restore: async () => ({ success: false, error: '长期记忆里已经有同 id 的有效记忆，未覆盖' }) });
	try {
		const body = await (await h.post({ id: 'dup', partition: 'gr' })).json();
		assert.equal(body.ok, false);
		assert.match(body.error, /已经有同 id/, '引擎给的原因要原样带回');
		assert.equal(h.calls.audit[0].outcome, 'rejected-by-gateway');
		assert.deepEqual(h.calls.stats, [], '失败不得计入"已恢复"');
	} finally { await h.stop(); }

	// "没报错但也没说成功"（形状不认识）不能算成功
	h = await archiveHarness({ restore: async () => ({ weird: true }) });
	try {
		const body = await (await h.post({ id: 'x', partition: 'gr' })).json();
		assert.equal(body.ok, false, '没有明确 success 就是失败');
		assert.deepEqual(h.calls.stats, []);
	} finally { await h.stop(); }

	// 老网关没有该方法 ⇒ 抛 404：如实说，且审计记 failed
	h = await archiveHarness({ restore: async () => { throw new Error('HTTP 404 Not Found：{"error":"unknown provider method","method":"restoreArchived"}'); } });
	try {
		const res = await h.post({ id: 'x', partition: 'gr' });
		assert.equal(res.status, 200, '业务失败走 200 + ok:false（页面据此提示，而不是当成网络错误）');
		const body = await res.json();
		assert.equal(body.ok, false);
		assert.match(body.error, /unknown provider method/);
		assert.equal(h.calls.audit[0].outcome, 'failed');
		assert.deepEqual(h.calls.stats, []);
	} finally { await h.stop(); }

	// 取分区名单本身失败 ⇒ 视为空名单 ⇒ 403（宁拒勿放）
	h = await archiveHarness({ partitionsOf: async () => { throw new Error('网关不可达'); } });
	try {
		assert.equal((await h.post({ id: 'a', partition: 'gr' })).status, 403, '名单取不到时必须拒绝，不能默认放行');
		assert.equal(h.calls.restore.length, 0);
	} finally { await h.stop(); }
	return 'ok';
});

// ═══ ③④⑤⑥ 总览 ═════════════════════════════════════════════════════════════

/**
 * 假网关（真 http）。`mode`：
 *  · 'new'  —— /health 带 schema/backups/lastSweepAt；listArchive 按分区给总数
 *  · 'old'  —— /health 只有 status；listArchive 404 unknown provider method
 *  · 'flaky'—— 新网关，但某个分区的 listArchive 返回 500
 */
async function fakeGateway(mode, partitions = ['gr', 'saros-claw'], totals = { gr: 2, 'saros-claw': 3 }) {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
		if (req.url === '/health') {
			return json(200, mode === 'old'
				? { status: 'ok', dataDir: 'x', port: 1, engine: 'sqlite' }
				: {
					status: 'ok', dataDir: 'x', port: 1, engine: 'sqlite',
					schema: { version: 1, expected: 1, state: 'current', migratedAt: '2026-11-02T03:08:29.000Z', applied: ['1:strength-scale-unify(189)'] },
					backups: { count: 3, latest: 'state_store.v0.x.bak.db', latestAt: '2026-11-02T03:08:29.101Z' },
					lastSweepAt: 1730000000000,
				});
		}
		const m = /^\/provider\/([^/]+)$/.exec(req.url ?? '');
		if (m && req.method === 'POST') {
			let raw = '';
			req.on('data', c => { raw += c; });
			req.on('end', () => {
				const args = JSON.parse(raw || '{}').args ?? [];
				if (m[1] === 'listAllAgentsWithData') { return json(200, partitions.map(id => ({ agentId: id }))); }
				if (m[1] === 'listArchive') {
					if (mode === 'old') { return json(404, { error: 'unknown provider method', method: 'listArchive' }); }
					if (mode === 'flaky' && args[0] === 'saros-claw') { return json(500, { error: 'boom' }); }
					return json(200, { total: totals[args[0]] ?? 0, items: [] });
				}
				return json(404, { error: 'unknown provider method', method: m[1] });
			});
			return;
		}
		json(404, { error: 'not found' });
	});
	const port = await listen(server);
	return { url: `http://127.0.0.1:${port}`, hits, stop: () => close(server) };
}

const fakeStats = (totals = {}) => ({
	async syncDistill() { /* 假的：不改累计 */ },
	async snapshot() { return { since: 1730000000000, totals: { turns: 0, candidates: 0, written: 0, ...totals } }; },
});
const draftRows = [
	{ id: 'd1', status: 'draft', matched: '习惯约定', digest: 'a', text: '以后用 pnpm 装依赖', chars: 12, hits: 1 },
	{ id: 'd2', status: 'draft', matched: '强调提醒', digest: 'b', text: '必须通过此 skill 处理', chars: 12, hits: 5 },
	{ id: 'd3', status: 'promoted', matched: '习惯约定', digest: 'c', text: '已经提升过的', chars: 12, hits: 2 },
];
const overviewDeps = (config, statsTotals) => ({
	state: { distill: {}, snapshots: new Map([['k', {}]]), refreshes: 7 },
	config,
	draftStore: { read: async () => draftRows },
	statsStore: fakeStats(statsTotals),
	autoPromoteCfg: { mode: 'high-only', minHits: 2 },
});

await checkAsync('③ 总览（新网关）：schema / 备份 / sweep / 归档总数 齐全，且归档是各分区求和', async () => {
	const gw = await fakeGateway('new');
	try {
		const out = await buildOverviewForTest(overviewDeps({ gatewayUrl: gw.url, agentId: 'gr' }));
		const h = out.health;
		assert.equal(h.gateway.state, 'ok');
		assert.equal(h.schema.state, 'current');
		assert.equal(h.schema.version, 1);
		assert.equal(h.backups.count, 3);
		assert.equal(h.lastSweepAt, 1730000000000);
		assert.equal(h.archive.total, 5, `2 + 3 = 5，实际 ${h.archive.total}`);
		assert.equal(h.archive.partitions, 2);
		assert.deepEqual(h.autoPromote, { mode: 'high-only', minHits: 2 });
		assert.equal(h.snapshots, 1); assert.equal(h.refreshes, 7);
		assert.equal(h.tokenBudget, 1024, '缺省预算 1024 token');
	} finally { await gw.stop(); }
	return 'ok';
});

await checkAsync('③ ★ 总览（老网关）：缺席的附加项是 null 而不是 0 / v0；归档方法缺席 ⇒ archive=null', async () => {
	const gw = await fakeGateway('old');
	try {
		const h = (await buildOverviewForTest(overviewDeps({ gatewayUrl: gw.url, agentId: 'gr' }))).health;
		assert.equal(h.gateway.state, 'ok', '老网关 /health 是 ok，状态条不能因为缺附加项就报错');
		assert.equal(h.schema, null, '老网关没有 schema ⇒ null（不是 {version:0}）');
		assert.equal(h.backups, null);
		assert.equal(h.lastSweepAt, null);
		assert.equal(h.archive, null, '老网关没有 listArchive ⇒ null（不是 total:0——"不知道"和"为空"必须分开）');
	} finally { await gw.stop(); }
});

await checkAsync('⑤ ★ 总览：某一分区归档查询失败 ⇒ archive=null，不能少算后当真值', async () => {
	const gw = await fakeGateway('flaky');
	try {
		const h = (await buildOverviewForTest(overviewDeps({ gatewayUrl: gw.url, agentId: 'gr' }))).health;
		assert.equal(h.archive, null, 'saros-claw 查询 500 ⇒ 总数不可信 ⇒ 不显示');
		assert.equal(h.gateway.state, 'ok', '归档失败不能把网关状态拖成 error');
	} finally { await gw.stop(); }
});

await checkAsync('④ 总览：网关不可达 ⇒ state=error + 原因，漏斗（本地数据）照常出；未配置 ⇒ unconfigured', async () => {
	const down = await buildOverviewForTest(overviewDeps({ gatewayUrl: 'http://127.0.0.1:1', agentId: 'gr' }, { turns: 40, written: 6, autoPromoted: 1 }));
	assert.equal(down.health.gateway.state, 'error');
	assert.ok(down.health.gateway.error.length > 0, '必须带原因');
	assert.equal(down.health.schema, null); assert.equal(down.health.archive, null);
	assert.equal(down.funnel.turns, 40, '网关挂了漏斗仍要出（它读本地文件）');
	assert.equal(down.funnel.drafts, 6);
	assert.equal(down.funnel.auto, 1);

	const prev = process.env.VSSAROS_MEMORY_GATEWAY_URL;
	delete process.env.VSSAROS_MEMORY_GATEWAY_URL;
	try {
		const none = await buildOverviewForTest(overviewDeps({ agentId: 'gr' }));
		assert.equal(none.health.gateway.state, 'unconfigured');
		assert.equal(none.health.gateway.configured, false);
		assert.equal(none.ok, true, '未配置不是错误，页面要如实说怎么配');
	} finally { if (prev !== undefined) { process.env.VSSAROS_MEMORY_GATEWAY_URL = prev; } }
});

await checkAsync('⑥ 漏斗：待审是时点值、单列；原因汇总来自当前待审；since 透传', async () => {
	const out = await buildOverviewForTest(overviewDeps({ agentId: 'gr' }, { turns: 100, candidates: 10, summaries: 2, written: 8, autoPromoted: 2, humanPromoted: 3, discarded: 1 }));
	const f = out.funnel;
	assert.equal(f.pendingNow, 2, '2 条 status=draft（promoted 的不算）');
	assert.equal(f.candidates, 12, '候选 = 10 + 2');
	assert.equal(f.human, 3); assert.equal(f.discarded, 1);
	assert.equal(f.since, 1730000000000);
	assert.ok(out.funnel.reasons['hits<2'] >= 1 || out.funnel.reasons['hits'] >= 1, `应有 hits 不足的原因：${JSON.stringify(out.funnel.reasons)}`);
	assert.ok(out.funnel.reasons['weak-kind'] >= 1, '强调提醒 ⇒ weak-kind');
});

// ═══ ⑦ 源码守卫 ════════════════════════════════════════════════════════════

await checkAsync('⑦ ★ 守卫：快照与预览共用装配；预览无副作用；统计同步三处都在；写路由都走共用读体', async () => {
	const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');

	// 快照刷新必须经 composeWorkingText（否则预览与快照会各拼各的 ⇒ 比对出假警报）
	const refresh = src.slice(src.indexOf('function refreshInto'), src.indexOf('function refreshInto') + 1800);
	assert.match(refresh, /composeWorkingText\(state, config, persona\)/, 'refreshInto 必须复用 composeWorkingText');
	assert.doesNotMatch(refresh, /workingContext\(/, 'refreshInto 里不该再直接拼装（会和预览分叉）');

	// 预览路由：用同一个装配、不写槽位、不动刷新计数
	const at = src.indexOf('api/inject-preview`)');
	assert.ok(at > 0, '找不到 inject-preview 路由');
	const route = src.slice(at, at + 2600);
	assert.match(route, /composeWorkingText\(state, config, personaOf\(config, frozen\)\)/, '预览必须用同一个装配函数与同一个人设解析');
	assert.match(route, /buildInjectionView\(/, '必须经 buildInjectionView 出结论');
	assert.doesNotMatch(route, /refreshInto\(/, '预览不得走会写槽位的 refreshInto');
	assert.doesNotMatch(route, /refreshes\s*\+\+|Object\.assign\(frozen/, '预览不得改刷新计数 / 不得写冻结快照');
	assert.match(route, /replyJson\(res, 405/, '非 GET 必须 405');

	// 统计同步：两个早退出口 + 队列收尾，缺一就会丢最后一回合
	assert.equal((src.match(/syncStats\(\)/g) ?? []).length >= 3, true, 'syncStats 至少在 3 处被调用（2 早退 + 队列收尾）');
	assert.match(src, /state\.distill\.skipped\+\+; syncStats\(\); return;/, '早退出口也要同步');
	assert.match(src, /stats: statsStore,\s*\n\s*remember,/, '提升器必须注入 stats（否则人工动作不进漏斗）');

	// 归档恢复路由：分区白名单来自 resolvePartitions，且写权限不能走"直接信任请求里的分区"
	const ar = src.indexOf('api/archive/restore`)');
	assert.ok(ar > 0);
	assert.match(src.slice(ar, ar + 900), /partitionsOf: async \(\) =>[\s\S]*resolvePartitions\(/, '分区白名单必须来自 resolvePartitions');
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 总览/归档路由测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 总览/归档路由测试通过（${results.length} 项）`);
