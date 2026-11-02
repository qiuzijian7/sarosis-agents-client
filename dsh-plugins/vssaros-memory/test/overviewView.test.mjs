/*---------------------------------------------------------------------------------------------
 *  overviewView.test.mjs — 状态条 / 注入预览 / 漏斗 / 详情页新页签（★ 2026-11-02，工作台 v2 · P3/P4）
 *
 * 真 React SSR 渲染（`react-dom/server`）。SSR 下 `useEffect` 不跑 ⇒ 用 `props.initial` 注入首帧数据。
 * 详情页的纯函数 `renderDetailTab` 直接测；`MemoryDetailPage` 的壳（页签栏）测首帧。
 *
 * ## 钉住
 *  ① 状态条：loading / error / 老网关（缺席项**不画**）/ 新网关（齐全）/ schema 落后 / 网关不可达 / 档位 off
 *  ② ★ 取不到 ≠ 0：老网关下页面上不能出现 "schema v0" / "归档 0 条" 这类假值
 *  ③ 漏斗：6 级 + 待审单列 + 原因汇总 + 失败/撤销只在 >0 时出现
 *  ④ 注入预览：收起（不发请求）/ 各结论文案 / 块状态着色 / 当前库取失败如实说 / 预算占比超限
 *  ⑤ 详情页：「更多」折叠 4 个空页签但数据仍可达；当前在「更多」里时不许收起
 *  ⑥ 归档页签：列表 / 剩余天数 / 空态 / ★ 网关不支持 ≠ 归档为空 / 部分分区失败要提示
 *  ⑦ 审计页签：按来源过滤 + 自动提升凭据
 *  ⑧ 样式：无裸色值、无 @media 规则、窄容器下隐藏次要项
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readFileSyncText = p => readFileSync(p, 'utf8');
const CHUNK = path.join(HERE, '..', 'lib', 'client.memory.js');
const SRC_VIEW = path.join(HERE, '..', 'webapp', 'src', 'detailView.js');

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};
const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };
const has = (html, needle, what) => assert(html.includes(needle), `${what || '输出'} 里找不到 ${JSON.stringify(needle)}`);
const lacks = (html, needle, what) => assert(!html.includes(needle), `${what || '输出'} 里不该出现 ${JSON.stringify(needle)}`);
/** HTML 文本转义后再比（SSR 输出里的 " 是 &quot;、< 是 &lt;）。 */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 整词类名匹配：`mem-over` 不能被 `mem-overview` 误中（本次踩到：子串匹配假红）。 */
const hasClass = (html, cls) => new RegExp(`class="[^"]*(?:^|\\s)${cls}(?:\\s|")`).test(html);

// ── 装载 chunk（假 window / ModuleLoader） ──────────────────────────────────
const src = await readFile(CHUNK, 'utf8');
let loaded = null;
globalThis.window = { __ModuleLoader__: { load(def) { loaded = def; } } };
globalThis.document = globalThis.document ?? { addEventListener() {}, getElementById() { return null; } };
new Function('window', 'document', src)(globalThis.window, globalThis.document);
assert(loaded && typeof loaded.factory === 'function', 'chunk 没有调用 __ModuleLoader__.load({factory})');
const mod = loaded.factory(name => { if (name === 'react') { return React; } throw new Error(`chunk 不该 require ${name}`); });
const Overview = mod.__OverviewSection;
assert(typeof Overview === 'function', 'chunk 必须导出 __OverviewSection 测试钩子');
const draw = el => renderToStaticMarkup(el);
const overview = props => draw(React.createElement(Overview, props));

// 详情页真源（与 chunk 里的生成块同源，守卫保证一致）
const { createDetailView } = await import(pathToFileURL(SRC_VIEW).href);
const { DETAIL_TABS, renderDetailTab, MemoryDetailPage } = createDetailView(React);

// ── 夹具 ────────────────────────────────────────────────────────────────────
const health = (over = {}) => ({
	agent: 'gr',
	gateway: { configured: true, url: 'http://127.0.0.1:3112', state: 'ok', error: '' },
	engine: 'sqlite',
	schema: { version: 1, expected: 1, state: 'current', migratedAt: '2026-11-02T03:08:29.000Z', applied: [] },
	backups: { count: 3, latest: 'x', latestAt: '2026-11-02T03:08:29.101Z' },
	lastSweepAt: Date.now() - 4 * 60_000,
	archive: { total: 12, partitions: 2 },
	partitions: ['gr', 'saros-claw'],
	autoPromote: { mode: 'high-only', minHits: 2 },
	tokenBudget: 1024, charCap: 8000, snapshots: 2, refreshes: 5,
	...over,
});
const funnel = (over = {}) => ({
	since: 1730000000000, turns: 128, candidates: 31, drafts: 24, auto: 2, human: 4, discarded: 3, undone: 0, edited: 1,
	judgeDropped: 0, repeats: 5, failed: 0, pendingNow: 7, reasons: { 'hits<2': 4, 'weak-kind': 2, 'summary-needs-human': 1 }, ...over,
});
const ov = (h = health(), f = funnel()) => ({ ok: true, health: h, funnel: f });

check('① 状态条：loading / error / 新网关齐全', () => {
	has(overview({ part: 'top' }), 'data-memory-health="loading"', 'loading');
	const err = overview({ part: 'top', initial: { error: 'HTTP 500' } });
	has(err, 'data-memory-health="error"', 'error'); has(err, 'HTTP 500', 'error'); has(err, 'role="alert"', 'error');

	const ok = overview({ part: 'top', initial: { data: ov() } });
	has(ok, 'data-memory-health-gateway="ok"', '网关'); has(ok, '网关在线', '网关');
	has(ok, 'data-memory-health-schema="current"', 'schema'); has(ok, 'schema v1', 'schema');
	has(ok, 'data-memory-health-autopromote="high-only"', '档位'); has(ok, '自动提升 high-only', '档位');
	has(ok, 'data-memory-health-archive="12"', '归档'); has(ok, '归档 12 条', '归档');
	has(ok, 'data-memory-health-toggle="closed"', '健康详情开关');
	lacks(ok, 'data-memory-health-card', '健康详情默认收起');
	// 状态条部分不该带预览与漏斗
	lacks(ok, 'data-memory-funnel', 'top 部分'); lacks(ok, 'data-memory-inject', 'top 部分');
	return 'ok';
});

check('② ★ 取不到 ≠ 0：老网关下 schema / 归档 不画，也不出现 v0 / 0 条', () => {
	const old = overview({ part: 'top', initial: { data: ov(health({ schema: null, backups: null, lastSweepAt: null, archive: null })) } });
	has(old, 'data-memory-health-gateway="ok"', '老网关仍是在线');
	lacks(old, 'data-memory-health-schema', '老网关没有 schema ⇒ 不画这一项');
	lacks(old, 'data-memory-health-archive', '老网关没有归档 ⇒ 不画这一项');
	lacks(old, 'schema v0', '不能把"不知道"画成 v0');
	lacks(old, '归档 0 条', '不能把"不知道"画成 0 条');
	// 健康详情里同理：缺席项不出现
	const card = overview({ part: 'top', initial: { data: ov(health({ schema: null, backups: null, lastSweepAt: null, archive: null })) } });
	lacks(card, '迁移备份', '缺席项');
	return 'ok';
});

check('① 状态条：schema 落后 / 网关不可达 / 未配置 / 档位 off 各有醒目标记', () => {
	const behind = overview({ part: 'top', initial: { data: ov(health({ schema: { version: 0, expected: 1, state: 'behind', migratedAt: null, applied: [] } })) } });
	has(behind, 'data-memory-health-schema="behind"', '落后'); has(behind, '落后，迁移未完成', '落后');
	const ahead = overview({ part: 'top', initial: { data: ov(health({ schema: { version: 2, expected: 1, state: 'ahead', migratedAt: null, applied: [] } })) } });
	has(ahead, '库比进程新', '超前');
	const down = overview({ part: 'top', initial: { data: ov(health({ gateway: { configured: true, url: 'http://x', state: 'error', error: 'ECONNREFUSED' }, schema: null, archive: null })) } });
	has(down, 'data-memory-health-gateway="error"', '不可达'); has(down, '网关不可达', '不可达');
	const none = overview({ part: 'top', initial: { data: ov(health({ gateway: { configured: false, url: '', state: 'unconfigured', error: '' }, schema: null, archive: null })) } });
	has(none, 'data-memory-health-gateway="unconfigured"', '未配置'); has(none, '网关未配置', '未配置');
	const off = overview({ part: 'top', initial: { data: ov(health({ autoPromote: { mode: 'off', minHits: 2 } })) } });
	has(off, 'data-memory-health-autopromote="off"', '档位 off'); has(off, '自动提升 off', '档位 off');
	return 'ok';
});

check('③ 漏斗：6 级 + 待审单列 + 原因汇总；失败/撤销只在 >0 时出现', () => {
	const html = overview({ part: 'bottom', initial: { data: ov() } });
	for (const k of ['turns', 'candidates', 'drafts', 'auto', 'human', 'discarded']) { has(html, `data-memory-funnel-row="${k}"`, '漏斗各级'); }
	lacks(html, 'data-memory-funnel-row="wait"', '待审不在累计漏斗里（它是时点值）');
	has(html, 'data-memory-funnel-now="7"', '待审单列'); has(html, '时点值', '要说明待审为什么单列');
	has(html, 'data-memory-funnel-reasons', '原因汇总'); has(html, 'hits&lt;2 × 4', '原因汇总'); has(html, 'weak-kind × 2', '原因汇总');
	lacks(html, '撤销 ', '撤销为 0 时不显示'); lacks(html, '失败 ', '失败为 0 时不显示');
	const noisy = overview({ part: 'bottom', initial: { data: ov(health(), funnel({ undone: 2, failed: 3, reasons: {} })) } });
	has(noisy, '撤销 2 次', '>0 才显示'); has(noisy, '失败 3 次', '>0 才显示');
	lacks(noisy, 'data-memory-funnel-reasons', '没有原因时不画空汇总');
	// 零数据：全 0 也要渲染出来（"没跑过"与"没东西"一样要看得见）
	const zero = overview({ part: 'bottom', initial: { data: ov(health(), funnel({ turns: 0, candidates: 0, drafts: 0, auto: 0, human: 0, discarded: 0, pendingNow: 0, reasons: {} })) } });
	has(zero, 'data-memory-funnel-row="turns"', '全 0 仍渲染');
	has(zero, '自动提升 0', '提示语仍在');
	return 'ok';
});

// ── 注入预览 ────────────────────────────────────────────────────────────────
const blk = (id, name, start, end, state) => ({ id, name, start, end, chars: end - start, tokens: Math.ceil((end - start) / 3), text: `${name}的正文`, state });
const side = (blocks, tokens = 300, pct = 29, over = false) => ({ chars: tokens * 3, tokens, wrapperChars: 40, blocks, pct, over });
const injData = (verdict, over = {}) => ({
	ok: true, budget: { tokens: 1024, charCap: 8000, estimated: true },
	frozen: side([blk('slots', '固定槽位', 0, 600, null), blk('profile', '项目画像', 600, 900, null)]),
	live: side([blk('slots', '固定槽位', 0, 600, 'same'), blk('profile', '项目画像', 600, 900, 'same'), blk('lessons', '教训', 900, 1100, 'new')], 330, 32),
	liveError: '', diff: { verdict, prefixChars: 900, frozenChars: 900, liveChars: 1100, addedChars: 200, removedChars: 0, brokenAt: null, firstDiffAt: 900 },
	frozenAt: Date.now(), frozenOk: true, frozenError: '', liveMeta: {}, ...over,
});

check('④ 注入预览：收起时只有入口；展开后各结论文案齐全', () => {
	const closed = overview({ part: 'bottom', initial: { data: ov() } });
	has(closed, 'data-memory-inject="closed"', '收起'); has(closed, 'data-memory-inject-open', '入口');
	has(closed, '不写任何数据', '要说明无副作用');
	lacks(closed, 'data-memory-inject-verdict', '收起时不该有结论');

	const cases = [
		['identical', '与会话冻结快照一致'],
		['append-only', '前缀稳定'],
		['tail-changed', '只有最后一块变了'],
		['prefix-broken', '缓存会失效'],
		['unavailable', '不下"稳定"的结论'],
	];
	for (const [verdict, text] of cases) {
		const html = overview({ part: 'bottom', initial: { data: ov(), inject: injData(verdict) } });
		has(html, `data-memory-inject-verdict="${verdict}"`, verdict); has(html, esc(text), verdict);
	}
	const stable = overview({ part: 'bottom', initial: { data: ov(), inject: injData('append-only') } });
	has(stable, '前 900 字不变', '要给出不变的字数'); has(stable, '新增 200 字', '要给出新增字数');
	has(stable, 'token（估算，字符/3）', 'token 必须标注是估算');
	return 'ok';
});

check('④ 注入预览：块状态着色 / 预算占比 / 超限标红 / 默认看当前库', () => {
	const html = overview({ part: 'bottom', initial: { data: ov(), inject: injData('append-only') } });
	has(html, 'data-memory-inject-blocks="3"', '当前库 3 块（默认看当前库）');
	has(html, 'data-memory-inject-state="same"', 'same'); has(html, 'data-memory-inject-state="new"', 'new');
	has(html, '新增 / 之后失效', 'new 块的说明');
	has(html, 'data-memory-inject-pct="32"', '占比'); has(html, '/ 预算 1024 token', '预算');
	assert(!hasClass(html, 'mem-over'), '未超限不该标红');
	const over = overview({ part: 'bottom', initial: { data: ov(), inject: injData('identical', { live: side([blk('slots', '固定槽位', 0, 6000, 'same')], 1500, 146, true) }) } });
	assert(hasClass(over, 'mem-over'), '超预算要标红'); has(over, 'data-memory-inject-pct="146"', '占比');
	return 'ok';
});

check('④ ★ 注入预览：当前库取失败如实说；冻结为空时不假装有内容', () => {
	const bad = overview({ part: 'bottom', initial: { data: ov(), inject: injData('unavailable', { live: null, liveError: '网关 5000ms 未响应' }) } });
	has(bad, 'data-memory-inject-live-error', '失败原因'); has(bad, '网关 5000ms 未响应', '失败原因');
	has(bad, 'data-memory-inject-verdict="unavailable"', '结论是无法比对');
	has(bad, 'data-memory-inject-blocks="2"', '当前库没取到时退回显示冻结快照');
	const none = overview({ part: 'bottom', initial: { data: ov(), inject: injData('unavailable', { frozen: null, live: null, liveError: '记忆网关未配置' }) } });
	has(none, '没有可显示的内容', '两边都没有');
	lacks(none, 'data-memory-inject-blocks', '两边都没有时不画块列表');
	return 'ok';
});

// ── 详情页 ──────────────────────────────────────────────────────────────────
check('⑤ 详情页：页签全集 11 个；主栏 7 个含「归档」；「更多」折叠 4 个空页签但仍可达', () => {
	assert(DETAIL_TABS.length === 11, `页签全集应为 11，实际 ${DETAIL_TABS.length}`);
	const primary = DETAIL_TABS.filter(t => t.primary !== false).map(t => t.id);
	assert(primary.join(',') === 'memories,sessions,slots,lessons,archive,consolidation,audit', `主栏：${primary.join(',')}`);
	const more = DETAIL_TABS.filter(t => t.primary === false).map(t => t.id);
	assert(more.join(',') === 'hooks,commits,report,skills', `更多：${more.join(',')}`);
	assert(new Set(DETAIL_TABS.map(t => t.id)).size === DETAIL_TABS.length, '页签 id 必须唯一');

	const html = draw(React.createElement(MemoryDetailPage, { onBack() {} }));
	for (const id of primary) { has(html, `data-memory-detail-tab="${id}"`, '主栏页签'); }
	for (const id of more) { lacks(html, `data-memory-detail-tab="${id}"`, '「更多」默认折叠，这 4 个不该占主栏'); }
	has(html, 'data-memory-detail-more="closed"', '「更多」入口'); has(html, '更多 ▾', '「更多」入口');

	// ★ 当前页签在「更多」里：必须自动展开，且「更多」入口本身高亮；4 个都要出现（选中项不能从栏里消失）
	const inMore = draw(React.createElement(MemoryDetailPage, { onBack() {}, initialTab: 'skills' }));
	has(inMore, 'data-memory-detail-more="open"', '当前在「更多」里 ⇒ 必须展开');
	for (const id of more) { has(inMore, `data-memory-detail-tab="${id}"`, '展开后 4 个都在'); }
	has(inMore, 'aria-selected="true"', '选中项要有 aria-selected');
	// 非法的初始页签回落到默认，不崩
	has(draw(React.createElement(MemoryDetailPage, { onBack() {}, initialTab: 'nope' })), 'data-memory-detail-more="closed"', '非法页签回落');
	return 'ok';
});

check('⑤ ★ 「更多」入口的点击逻辑：当前页签在「更多」里时不许收起（源码守卫，SSR 点不了）', () => {
	const view = readFileSyncText(SRC_VIEW);
	const line = view.split('\n').find(l => l.includes('setMoreOpen(!moreOpen)'));
	assert(line, '找不到「更多」的点击处理');
	assert(/if \(!curInMore\)/.test(line), '「更多」的点击必须先判断 !curInMore（当前页签在其中时不许收起，否则选中项消失）');
});

const arch = (over = {}) => ({
	agentId: 'gr', archive: {
		items: [
			{ id: 'm1', partition: 'gr', content: '本项目使用 pnpm 管理依赖', type: 'fact', archiveReason: 'superseded', archivedAt: '2026-10-30T00:00:00.000Z', daysLeft: 87 },
			{ id: 'm2', partition: 'saros-claw', content: '部署端口是 8011', type: 'fact', archiveReason: 'contradiction', archivedAt: '2026-10-20T00:00:00.000Z', daysLeft: 77 },
			{ id: 'm3', partition: 'gr', content: '没有到期时间的', type: 'fact', archiveReason: 'manual', archivedAt: '', daysLeft: null },
		],
		total: 3, shown: 3, failed: 0, unsupported: false, ttlDays: 90, ...over,
	},
});

check('⑥ 归档页签：列表 / 剩余天数 / 来源分区 / 恢复按钮锚点', () => {
	const html = draw(renderDetailTab('archive', arch(), {}, { restore() {}, busy: false }));
	for (const id of ['m1', 'm2', 'm3']) { has(html, `data-memory-archive-row="${id}"`, '归档行'); has(html, `data-memory-archive-restore="${id}"`, '恢复按钮'); }
	has(html, 'data-memory-archive-left="87"', '剩余天数'); has(html, '剩 87 天', '剩余天数');
	has(html, '无到期时间', 'daysLeft=null 要说明而不是显示 NaN');
	lacks(html, 'NaN', '不能出现 NaN');
	has(html, 'saros-claw', '非当前分区要标出来');
	has(html, '90 天内可恢复', '保留期说明'); has(html, '不会动现在的最新版本', '恢复语义说明');
	lacks(html, 'disabled=""', '有回调且未忙时按钮可点');
	// 没有回调 / 忙碌时按钮必须禁用
	has(draw(renderDetailTab('archive', arch(), {}, { busy: true, restore() {} })), 'disabled=""', '忙碌时禁用');
	has(draw(renderDetailTab('archive', arch(), {}, {})), 'disabled=""', '没有恢复回调时禁用');
	return 'ok';
});

check('⑥ ★ 归档页签：网关不支持 ≠ 归档为空；部分分区失败要提示；截断要说明', () => {
	const empty = draw(renderDetailTab('archive', arch({ items: [], total: 0, shown: 0 }), {}, {}));
	has(empty, '归档是空的（还没有', '真空'); lacks(empty, '不支持归档查询', '真空不能说成不支持');
	const unsupported = draw(renderDetailTab('archive', arch({ items: [], total: 0, shown: 0, unsupported: true }), {}, {}));
	has(unsupported, '当前网关版本不支持归档查询', '老网关'); has(unsupported, '这不代表归档是空的', '老网关');
	// "不支持"页里不能出现"真空"那句话（判据用真空独有的后半句；"这不代表归档是空的"是否定句，不算）
	lacks(unsupported, '归档是空的（还没有', '不支持 ≠ 为空');
	lacks(unsupported, 'data-memory-archive-row', '不支持时不画任何行');
	const partial = draw(renderDetailTab('archive', arch({ failed: 2 }), {}, {}));
	has(partial, 'data-memory-archive-partial="2"', '部分失败'); has(partial, '可能不完整', '部分失败');
	const truncated = draw(renderDetailTab('archive', arch({ total: 500, shown: 3 }), {}, {}));
	has(truncated, '仅显示最近 3 条', '截断要说明');
	// 缺 archive 字段（老接口 / 取数失败）不崩
	has(draw(renderDetailTab('archive', {}, {}, {})), '归档是空的（还没有', '缺字段不崩');
	return 'ok';
});

const ledger = [
	{ action: 'executed', tool: 'memory_promote(auto)', policy: 'auto-distill', policyKey: 'auto-distill/hits=2/习惯约定', timestamp: 1730000000000, content: '以后用 pnpm' },
	{ action: 'executed', tool: 'memory_promote(page)', policy: 'human', timestamp: 1730000001000, content: '记住 dev app 要重启' },
	{ action: 'executed', tool: 'memory_remember', policy: 'ask', timestamp: 1730000002000, content: '模型写的' },
	{ action: 'executed', tool: 'memory_remember', policy: 'off', timestamp: 1730000003000, content: '被策略拒绝的模型写入' },
	{ action: 'distill', timestamp: 1730000004000, content: 'drafted:2' },
];
const auditModel = { auditSummary: { totalAuditEntries: 5 }, auditLog: ledger };

check('⑦ 审计页签：按来源过滤（人工 / 模型 / 自动提升）+ 自动提升凭据 + 计数', () => {
	const all = draw(renderDetailTab('audit', auditModel, { audit: 'all' }, {}));
	for (const f of ['all', 'human', 'model', 'auto-distill']) { has(all, `data-memory-audit-filter="${f}"`, '过滤器'); }
	has(all, '自动提升 (1)', '自动提升计数'); has(all, '人工 (1)', '人工计数');
	has(all, '模型写入 (2)', 'ask + off 都是模型来源');
	has(all, '5 条', '全部 5 条');
	has(all, '凭据：hits=2/习惯约定', '自动提升要带凭据（去掉 auto-distill/ 前缀）');
	has(all, 'data-memory-audit-source="other"', 'distill 这类无 policy 的行归为其它');

	const auto = draw(renderDetailTab('audit', auditModel, { audit: 'auto-distill' }, {}));
	has(auto, '以后用 pnpm', '只剩自动提升那条'); lacks(auto, '记住 dev app 要重启', '人工的被过滤掉'); lacks(auto, '模型写的', '模型的被过滤掉');
	has(auto, '1 / 5 条', '过滤后要显示 过滤数/总数');
	const model = draw(renderDetailTab('audit', auditModel, { audit: 'model' }, {}));
	has(model, '模型写的', 'ask'); has(model, '被策略拒绝的模型写入', 'off 也算模型来源'); lacks(model, '以后用 pnpm', '自动提升不算模型');
	const nothing = draw(renderDetailTab('audit', { auditLog: [ledger[1]] }, { audit: 'auto-distill' }, {}));
	has(nothing, '这一类来源下没有审计条目', '过滤后为空要说明是"这一类"没有，不是整个账本为空');
	const emptyAll = draw(renderDetailTab('audit', { auditLog: [] }, { audit: 'all' }, {}));
	has(emptyAll, '账本里没有审计条目', '真空');
	return 'ok';
});

check('⑧ 样式：无裸色值 / 无 @media 规则 / 窄容器下隐藏次要项', () => {
	const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install'));
	assert(css.length > 200, '找不到 CSS 模板');
	const bad = css.split('\n').filter(l => (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)) && !l.includes('var(--'));
	assert(bad.length === 0, `裸色值：${bad.slice(0, 2).join(' | ')}`);
	assert(!/@media\s*[(a-z]/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '禁用 @media 判宽（规范 §4.3：只用容器查询）');
	assert(/@container \(max-width: 560px\)[\s\S]*\.mem-opt \{ display:none; \}/.test(css), '窄容器下应隐藏次要状态项');
	assert(/@container \(max-width: 560px\)[\s\S]*\.mem-fr \{ grid-template-columns:62px/.test(css), '窄容器下漏斗列宽应收窄');
	for (const sel of ['.mem-health', '.mem-funnel', '.mem-blk.is-new', '.mem-verdict']) { assert(css.includes(sel), `缺少样式 ${sel}`); }
	return 'ok';
});

check('⑧ ★ 窄栏（~300px）布局规则：组头可换行 / 标题与按钮不折行 / 窄容器收起长说明（真机截图反馈：标题被挤成竖排）', () => {
	// 病根：宿主 `.wb-group-hd` 是 flex + nowrap ⇒ 300px 栏里「待你处理」被压成 28px 宽 2 行、
	// 分段按钮各 3 行、说明段落占半屏。只测"类名存在"测不出这个 —— 必须钉住**规则本身**。
	const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install')).replace(/\/\*[\s\S]*?\*\//g, '');
	const rule = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[1] : ''; };
	assert(/flex-wrap\s*:\s*wrap/.test(rule('.wb-mem .wb-group-hd')), '组头必须 flex-wrap:wrap（宿主默认 nowrap 会把标题挤成竖排）');
	assert(/white-space\s*:\s*nowrap/.test(rule('.wb-mem .wb-group-hd > :first-child')), '组头标题必须 nowrap（宁可整块换行也不把字挤断）');
	assert(/white-space\s*:\s*nowrap/.test(rule('.mem-seg-btn')), '分段按钮文字必须 nowrap');
	assert(/max-width\s*:\s*100%/.test(rule('.mem-seg')), '分段控件不得超出容器');
	assert(/display\s*:\s*none/.test(rule('.mem-inbox-desc-sm')), '短摘要默认隐藏（只在窄容器出现）');
	const narrow = /@container \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css);
	assert(narrow, '找不到 560px 容器查询');
	assert(/\.mem-inbox-desc \{ display:none; \}/.test(narrow[1]), '窄容器必须收起长说明');
	assert(/\.mem-inbox-desc-sm \{ display:block; \}/.test(narrow[1]), '窄容器必须显示一句摘要（不能说明全没了）');
	assert(/\.mem-hide-sm \{ display:none; \}/.test(narrow[1]), '窄容器隐藏重复的次要项（档位已在状态条显示）');
});

check('⑧ 收件箱说明有「长 / 短」两份且锚点可探测；档位重复项带 mem-hide-sm', () => {
	const inbox = { ok: true, mode: 'high-only', minHits: 2, counts: { pending: 0, autos: 0, done: 0 }, reasons: {}, pending: [], autos: [], done: [] };
	const html = renderToStaticMarkup(React.createElement(mod.__InboxSection, { initial: { data: inbox } }));
	has(html, 'data-memory-inbox-desc="full"', '长说明'); has(html, 'data-memory-inbox-desc="short"', '短摘要');
	assert(/class="[^"]*\bmem-inbox-desc\b[^"]*"/.test(html) && /class="[^"]*\bmem-inbox-desc-sm\b[^"]*"/.test(html), '两份说明都要带各自的类，CSS 才能分别显隐');
	assert(/class="[^"]*\bmem-count\b[^"]*\bmem-hide-sm\b[^"]*"/.test(html), '头部档位文字必须带 mem-hide-sm（窄栏里与状态条重复）');
	has(html, '高置信条目会自动提升', '完整门槛说明仍在 DOM 里（宽容器显示）');
});

// ── v3 · R1「收件箱优先」（2026-11-02）：分段 / 双栏审核 / 位置标签 / 冻结批量 ─────
const pendingRow = (over = {}) => ({ id: 'd1', kind: '习惯约定', text: '以后所有构建都必须先跑 typecheck 再打产物', hits: 1, why: 'hits<2', hint: '同一句话需要被说过 2 次才会自动提升', eligible: false, sessionId: 'sess-abcdef12', turn: 3, at: Date.now() - 3600e3, lastSeenAt: Date.now() - 3600e3, edited: false, ...over });
const inboxWith = rows => ({ ok: true, mode: 'high-only', minHits: 2, counts: { pending: rows.length, autos: 0, done: 0 }, reasons: { 'hits<2': 1 }, pending: rows, autos: [], done: [] });

check('⑨ ★ R1：OverviewSection 支持 inject / funnel 独立段（分段导航各取各的）', () => {
	const inj = overview({ part: 'inject', initial: { data: ov(), inject: injData('append-only') } });
	has(inj, 'data-memory-inject="ready"', 'inject 段有预览'); lacks(inj, 'data-memory-funnel', 'inject 段不带漏斗'); lacks(inj, 'data-memory-health', 'inject 段不带状态条');
	const fun = overview({ part: 'funnel', initial: { data: ov() } });
	has(fun, 'data-memory-funnel', 'funnel 段有漏斗'); lacks(fun, 'data-memory-inject', 'funnel 段不带预览'); lacks(fun, 'data-memory-health', 'funnel 段不带状态条');
	return 'ok';
});

check('⑨ ★ R1：收件箱双栏证据块 + 位置标签 + 四道门（SSR 直渲）', () => {
	const html = renderToStaticMarkup(React.createElement(mod.__InboxSection, { initial: { data: inboxWith([pendingRow()]), open: 'd1' } }));
	has(html, 'data-memory-inbox-evidence="d1"', '证据块');
	has(html, 'data-memory-inbox-gates', '四道门容器');
	const gates = (html.match(/data-memory-inbox-gate="[a-z]+"/g) || []).map(s => s.match(/="([a-z]+)"/)[1]);
	assert(gates.join(',') === 'hits,kind,summary,judge', '四道门齐全且有序：' + gates.join(','));
	has(html, 'data-memory-inbox-pos="1/1"', '位置标签 1/1');
	has(html, '1 / 1 条', '位置标签文案');
	has(html, 'data-memory-inbox-evidence-close', '收起按钮');
	has(html, '这条为什么没被自动提升', '证据块标题');
	has(html, '同一句话需要被说过 2 次才会自动提升', 'hint 进证据块');
	// 没打开时不画证据块
	lacks(renderToStaticMarkup(React.createElement(mod.__InboxSection, { initial: { data: inboxWith([pendingRow()]) } })), 'data-memory-inbox-evidence', '默认收起');
	return 'ok';
});

check('⑨ ★ R1：gatesOf 纯函数——hits / 强句式 / 摘要 / 判定 各态', () => {
	const G = mod.__InboxGates;
	assert(typeof G === 'function', '导出 __InboxGates');
	const g = (row, mn) => Object.fromEntries(G(row, mn).map(x => [x.key, x.state]));
	assert(g({ hits: 2, kind: '习惯约定', eligible: true, why: '' }, 2).hits === 'ok', 'hits 达标');
	assert(g({ hits: 1, kind: '习惯约定', eligible: true, why: '' }, 2).hits === 'err', 'hits 不达标');
	assert(g({ hits: 9, kind: '强调提醒', eligible: true, why: '' }, 2).kind === 'err', '弱句式');
	assert(g({ hits: 9, kind: 'turn-summary', eligible: true, why: '' }, 2).summary === 'err', '整段摘要');
	assert(g({ hits: 9, kind: '习惯约定', eligible: false, why: 'judge-unavailable' }, 2).judge === 'warn', '判定未配置 = 警示而非红');
	assert(g({ hits: 9, kind: '习惯约定', eligible: true, why: '' }, 2).judge === 'ok', '判定通过');
	return 'ok';
});

check('⑨ ★ R1：批量冻结两段式（第一次点只冻结，确认才提交）——源码守卫', () => {
	const inboxSrc = src.slice(src.indexOf('function InboxSection'), src.indexOf('function OverviewSection'));
	assert(/onClick: \(\) => setFrozen\(\{ action: 'promote', ids: selIds\.slice\(\) \}\)/.test(inboxSrc), '批量提升第一次点只是冻结目标（不是 act）');
	assert(/onClick: \(\) => setFrozen\(\{ action: 'discard', ids: selIds\.slice\(\) \}\)/.test(inboxSrc), '批量丢弃同样只冻结');
	assert(/'data-memory-inbox-confirm': frozen\.action/.test(inboxSrc), '确认按钮带动作锚点');
	assert(/void act\(frozen\.action, frozen\.ids/.test(inboxSrc), '确认才真正发 act');
	assert(/setFrozen\(null\)/.test(inboxSrc), '成功/取消都会清冻结');
	assert(/disabled: busy \|\| !!frozen/.test(inboxSrc), '冻结期间勾选框锁定（目标集合不可变）');
	return 'ok';
});

check('⑨ ★ R1：主页分段导航与密度三档（MemoryPanel 源码守卫）', () => {
	const panel = src.slice(src.indexOf('function MemoryPanel()'), src.indexOf('const STYLE_ID'));
	assert(/'today', '今日'\]/.test(src), '五段齐全（today）');
	assert(/'inject', '注入'\], \['maint', '维护'\], \['guide', '指南'\]/.test(src), '五段齐全（后半）');
	assert(/'data-memory-seg': seg/.test(panel), '根节点带当前段锚点');
	assert(/'data-memory-density': density/.test(panel), '根节点带密度锚点');
	assert(/seg === 'today'/.test(panel) && /part: 'top'/.test(panel) && /part: 'inject'/.test(panel) && /part: 'funnel'/.test(panel), '分段内容映射齐全');
	assert(/'data-memory-density': id/.test(panel), '密度按钮锚点');
	assert(/data-memory-guide/.test(panel), '指南段存在');
	return 'ok';
});

check('⑨ ★ R1 样式：双栏 ≥700px 并排 / 窄容器证据置顶 / 导航可横滑 / 密度变量', () => {
	const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install'));
	assert(/@container \(min-width: 700px\)[\s\S]*\.mem-inbox-cols \{ grid-template-columns:minmax\(0, 1fr\) minmax\(0, 320px\); \}/.test(css), '双栏并排规则');
	assert(/@container \(max-width: 699px\)[\s\S]*\.mem-inbox-evidence \{ order:-1; \}/.test(css), '窄容器证据块置顶');
	assert(/\.mem-nav \{[\s\S]*overflow-x:auto/.test(css), '导航可横滑');
	// ★ 2026-11-02（用户真机「顶部页签被挤压」）：dsh 页面全局样式会压按钮 ⇒
	//   导航选择器必须带 .wb-mem .mem-nav 前缀（0,3,0）且字体/内边距显式声明，免疫宿主通用规则。
	assert(/\.wb-mem \.mem-nav \.mem-nav-btn \{[^}]*padding:6px 18px[^}]*font-size:var\(--wb-f-sm/.test(css), '导航按钮高特异性 + 显式 padding/字号');
	assert(/\.wb-mem \.mem-nav \{[^}]*padding:8px 16px/.test(css), '导航条自身有呼吸间距');
	// ★ 2026-11-02（用户真机「UI 未更新」）：导航第一版是 12px 灰字+下划线，视觉上等于没有
	//   ⇒ 钉住「激活段必须有背景+描边的药丸样式」，防止再退化成幽灵导航。
	const navOn = new RegExp('\\.mem-nav-btn\\.is-on \\{([^}]*)\\}').exec(css);
	assert(navOn, '存在 .mem-nav-btn.is-on 规则');
	assert(/background:var\(--dsw-alias-interactive-bg-hover/.test(navOn[1]), '激活段必须有背景（药丸高亮，不能只是下划线）');
	assert(/border-color:var\(--dsw-alias-border-l2/.test(navOn[1]), '激活段必须有描边');
	assert(!/border-bottom-color:var\(--dsw-alias-brand-primary/.test(css.slice(css.indexOf('.mem-nav {'), css.indexOf('.mem-pos {'))), '导航不得退回「只有下划线」的幽灵样式');
	assert(/\.wb-mem\[data-memory-density="compact"\] \{ --mem-row-y: var\(--wb-s1\); \}/.test(css), '密度变量 compact');
	assert(/\.mem-inbox-row[\s\S]*padding:var\(--mem-row-y/.test(css), '收件箱行接密度变量');
	// ★ 2026-11-02（用户真机「顶部页签被裁剪」，两张截图都有）：
	//   .wb 是 height:100% 的 flex 列 ⇒ 子项默认会被压缩，压缩 + overflow 就把文字裁掉。
	//   钉住：① 直接子项不许压缩 ② 关滚动锚定 ③ 切段把滚动归零。
	assert(/\.wb-mem > \* \{ flex: 0 0 auto; \}/.test(css), '面板直接子项不参与 flex 压缩（否则工具条/导航会被压裁）');
	assert(/\.wb-mem \{[^}]*overflow-anchor:none/.test(css), '关掉滚动锚定（异步数据回填会顶走滚动位置）');
	const panelSrc = src.slice(src.indexOf('function MemoryPanel()'), src.indexOf('const STYLE_ID'));
	assert(/rootRef\.current\.scrollTop = 0/.test(panelSrc), '切段时把面板滚动位置归零');
	assert(/\}, \[seg\]\)/.test(panelSrc), '滚动归零要以 seg 为依赖');
	return 'ok';
});

// ── v3 · P6/P7（2026-11-02）：可信度字形 †/⌊ 全站统一 + 网关人话诊断 + 首屏进度 ─────
check('⑩ ★ P6：注入预览与漏斗带统一可信度字形与脚注', () => {
	const inj = overview({ part: 'bottom', initial: { data: ov(), inject: injData('append-only') } });
	has(inj, '†', '注入 token 带 † 估算字形');
	has(inj, 'data-memory-trust-note', '注入预览有统一脚注');
	has(inj, 'token = 字符/3', '脚注说明估算口径');
	const fun = overview({ part: 'funnel', initial: { data: ov() } });
	has(fun, 'data-memory-funnel-lower', '漏斗累计数带 ⌊ 下限字形');
	has(fun, 'data-memory-trust-note', '漏斗有统一脚注');
	has(fun, '真实值 ≥ 此数', '脚注说明下限语义');
	// 状态条没有估算数字 ⇒ 不该掺可信度脚注
	lacks(overview({ part: 'top', initial: { data: ov() } }), 'data-memory-trust-note', '状态条不需要脚注');
	return 'ok';
});

check('⑩ ★ P6：健康详情里注入预算标 †（源码守卫，卡片默认收起 SSR 点不开）', () => {
	assert(/token（估算 †）· 字符闸/.test(src), '健康详情预算必须标 †');
	return 'ok';
});

check('⑩ ★ P7：网关故障/未配置给人话诊断，健康时不画', () => {
	const down = overview({ part: 'top', initial: { data: ov(health({ gateway: { configured: true, url: 'http://127.0.0.1:3112', state: 'error', error: 'ECONNREFUSED' }, schema: null, archive: null })) } });
	has(down, 'data-memory-health-diag="error"', '诊断块');
	const steps = (down.match(/<li>/g) || []).length;
	assert(steps === 3, '三步诊断，实际 ' + steps);
	has(down, 'curl http://127.0.0.1:3112/health', '第一步：curl 检查');
	has(down, '3111', '端口说明安装版'); has(down, '3112', '端口说明 dev');
	has(down, 'gateway.log', '第三步：看日志');
	const none = overview({ part: 'top', initial: { data: ov(health({ gateway: { configured: false, url: '', state: 'unconfigured', error: '' }, schema: null, archive: null })) } });
	has(none, 'data-memory-health-diag="unconfigured"', '未配置也有诊断');
	has(none, 'VSSAROS_MEMORY_GATEWAY_URL', '未配置给环境变量指引');
	lacks(none, 'curl', '未配置不画 curl（那是故障分支）');
	lacks(overview({ part: 'top', initial: { data: ov() } }), 'data-memory-health-diag', '健康时不画诊断块');
	return 'ok';
});

check('⑩ ★ P7：首屏进度条（纯 CSS，不依赖数据）+ 加载文案提示诊断', () => {
	const css = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install'));
	assert(/\.mem-progress \{/.test(css) && /@keyframes mem-slide/.test(css), '进度条 + 动画');
	assert(/animation:mem-slide/.test(css), '进度条在动');
	assert(/正在读取记忆…（网关不可达时这里会给出三步诊断）/.test(src), '加载态文案提示会有诊断');
	return 'ok';
});

// ── v3 · P2（2026-11-02）：记忆页签的 tier / 类型徽标可点（longterm：tag → search，就地切筛选）──
const memModel = () => ({
	agentId: 'gr', total: 2, truncated: false, itemLimit: 50, partitionsTruncated: false, partitions: ['gr'],
	items: [
		{ tier: 'semantic', type: 'fact', content: '本项目使用 pnpm 管理依赖', partition: 'gr', timestamp: '2026/11/2 10:00' },
		{ tier: 'procedural', type: 'routine', content: '发版：自检→bump→安装→重启', partition: 'gr', timestamp: '2026/11/1 09:00' },
	],
	typeCounts: { fact: 1, routine: 1 },
});

check('⑪ ★ P2：记忆页签的 tier / 类型徽标可点（点 = 就地切到对应筛选）', () => {
	const html = draw(renderDetailTab('memories', memModel(), { layer: 'all', type: '' }, {}));
	has(html, 'data-memory-tier-tag="semantic"', 'tier 徽标可点');
	has(html, 'data-memory-type-tag="fact"', '类型徽标可点');
	assert(/<button[^>]*data-memory-tier-tag="semantic"/.test(html), 'tier 徽标是 <button>（不是 span）');
	assert(/<button[^>]*data-memory-type-tag="fact"/.test(html), '类型徽标是 <button>');
	// 源码守卫：点击接到 actions.setLayer / setType；类型标签转小写（类型过滤是小写精确匹配）
	const v = readFileSyncText(SRC_VIEW);
	assert(/actions && actions\.setLayer/.test(v), 'tier 点击调 actions.setLayer');
	assert(/actions && actions\.setType/.test(v), '类型点击调 actions.setType');
	assert(/setType\(String\(it\.type \|\| ''\)\.toLowerCase\(\)\)/.test(v), '类型标签转小写（匹配类型过滤）');
	assert(/setLayer,\s*setType\s*\}/.test(v), 'MemoryDetailPage 把 setLayer/setType 传进 actions');
	// 非记忆行没有这些锚点（别把可点徽标撒到不该撒的地方）
	lacks(draw(renderDetailTab('lessons', memModel(), {}, {})), 'data-memory-tier-tag', 'lessons 行不放 tier 标签');
	return 'ok';
});

// ── 2026-11-02（用户问「为什么部分页签下的数据是空的」）：页签计数 + 槽位去噪 ──────────
check('⑫ 槽位页：全空折叠成一句说明（点名槽位 + 说明不是丢数据），不再刷 N 行「(空)」', () => {
	const names = ['guidance', 'pending_items', 'persona'];
	const allEmpty = draw(renderDetailTab('slots', { slots: names.map(n => ({ name: n, content: '' })), slotNames: names }, {}, {}));
	has(allEmpty, 'data-memory-slots-empty="all"', '全空标记');
	has(allEmpty, '3 个槽位都还没写入内容', '一句说明');
	has(allEmpty, 'guidance、pending_items、persona', '点名哪些槽位');
	has(allEmpty, '不等于丢数据', '说明不是丢数据');
	lacks(allEmpty, '(空)', '不再逐个刷「(空)」');
	// 有内容才展开；剩下的空槽位一行带过
	const mixed = draw(renderDetailTab('slots', {
		slots: [{ name: 'persona', content: '我偏好简洁回答' }, { name: 'guidance', content: '' }],
		slotNames: ['persona', 'guidance'],
	}, {}, {}));
	has(mixed, '我偏好简洁回答', '有内容的槽位显示正文');
	has(mixed, 'data-memory-slots-rest="1"', '剩余空槽位计数');
	has(mixed, '另有 1 个槽位为空：guidance', '剩余空槽位点名');
	lacks(mixed, 'data-memory-slots-empty', '混合时不再走全空分支');
	return 'ok';
});

check('⑫ 页签计数：只报已知（没取过的页签不显示数字），已知为空的置灰', () => {
	const v = readFileSyncText(SRC_VIEW);
	assert(/function tabCountOf\(tab, m\)/.test(v), '有 tabCountOf 纯函数');
	// 未知 ⇒ null（「取不到 ≠ 0」的口径，不能省）
	assert(/default: return null;/.test(v), '未知页签返回 null');
	assert(/只报已知的/.test(v), '注释写明只报已知');
	assert(/'data-memory-tab-count': known \? String\(n\) : ''/.test(v), '计数锚点只在已知时给值');
	assert(/known \? h\('span', \{ className: 'md2-tab-n' \}/.test(v), '只有已知才画计数徽标');
	assert(/known && n === 0 \? ' is-empty'/.test(v), '已知为空才置灰');
	assert(/setTabCounts\(prev =>/.test(v), '取数后记录计数');
	assert(/tabCountOf\(tab, st\.data\)/.test(v), '记录的是当前页签的计数');
	return 'ok';
});

check('⑫ 样式：计数徽标 + 空页签置灰在**两处** CSS 都有（detail.css 真源 + chunk）', () => {
	const css = readFileSyncText(path.join(HERE, '..', 'webapp', 'src', 'detail.css'));
	const chunkCSS = src.slice(src.indexOf('const CSS = `'), src.indexOf('function install'));
	for (const [name, text] of [['detail.css', css], ['chunk', chunkCSS]]) {
		assert(/\.md2 \.md2-tab\.is-empty \{ opacity:\.55; \}/.test(text), name + ' 缺 .md2-tab.is-empty');
		assert(/\.md2 \.md2-tab-n \{/.test(text), name + ' 缺 .md2-tab-n');
	}
	return 'ok';
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 总览/详情视图测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 总览/详情视图测试通过（${results.length} 项）`);
