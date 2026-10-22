/*---------------------------------------------------------------------------------------------
 *  @vssaros/dsh-sessions 的**数据路径**检查（没有 Host 也能跑）。
 *
 *  运行（仓库根）：
 *      node dsh-plugins/vssaros-sessions/test/run-sessions-plugin-check.mjs
 *
 *  验什么：
 *   ① `lib/store.js` 的 DSH_HOME 三级链 + 投影缓存目录 + 坏文件只丢自己；
 *   ② `lib/core/sessionList.js` 的解析 / 分组 / 配额 / 状态 / 人格（与 VsSaros 侧同一张黄金表）；
 *   ③ `lib/pageShell.js` 的 `renderShell` 真能被调用（参数名写错会在这里炸，而不是在真机上）。
 *
 *  ⚠ 本文件**不进包**（`package.json` 的 `files` 不含 test/）；它是"改判据时先红"的那道网。
 *  验收纪律：断言**必须能证伪** —— 本文件里"运行中不占配额"那条最初的期望值算错了（夹具里空闲只有 4 条、
 *  本来就没到 5），守卫当场把它抓住 ⇒ 说明这道网不是空跑。
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../lib');
// 重构 1.3（2026-10-16）之后 `store.js` / `pageShell.js` 都是**委托**（经 lib/foundationRef.js 取
// cordis 服务）⇒ 直接在进程里 import 而不先绑定，调用 store 的任意函数都会抛「service 未绑定」，
// 整片检查连带失效（本文件就是这么静默烂掉的 ⇒ 顺手补上）。这里走 foundationRef 的**探针后门**
// `globalThis.__VSSAROS_FOUNDATION__`（生产 Host 里没人设置它，这条路只在进程内检查/探针存在 ✓）。
const { createFoundationService } = await import(pathToFileURL(path.join(ROOT, '../../vssaros-foundation/lib/index.js')).href);
globalThis.__VSSAROS_FOUNDATION__ = createFoundationService();

const { readSessionCaches, projCacheDirOf, dshHomeOf } = await import(new URL('file:///' + path.join(ROOT, 'store.js').replace(/\\/g, '/')).href);
const core = await import(new URL('file:///' + path.join(ROOT, 'core/sessionList.js').replace(/\\/g, '/')).href);
const shell = await import(new URL('file:///' + path.join(ROOT, 'pageShell.js').replace(/\\/g, '/')).href);

const fail = [];
const check = (label, fn) => { try { fn(); console.log(`  ✔ ${label}`); } catch (e) { fail.push(label); console.log(`  ✗ ${label}：${e.message}`); } };
/** 异步版（动态 import 这类必须 await：写进 check() 里会变成"没人等的 promise" ⇒ 失败被吞 ✗）。 */
const checkAsync = async (label, fn) => { try { await fn(); console.log(`  ✔ ${label}`); } catch (e) { fail.push(label); console.log(`  ✗ ${label}：${e.message}`); } };

// ── 造一份投影缓存（v7 形状：identity.cwd + rows[unit].val）────────────────────
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-sessions-'));
const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(cacheDir, { recursive: true });
const write = (id, { cwd, title, preset, turn, questions, persona, retry }) => {
	const rows = {};
	if (title !== undefined) { rows.title = { val: title }; }
	if (preset !== undefined) { rows.agentPreset = { val: preset }; }
	if (turn !== undefined) { rows.turnBoundary = { val: { running: turn, lastTurn: turn ? undefined : 3 } }; }
	if (questions !== undefined) { rows.userQuestions = { val: questions }; }
	if (retry !== undefined) { rows.llmRetry = { val: { retry } }; }
	if (persona !== undefined) { rows['vssaros-persona'] = { val: persona }; }
	fs.writeFileSync(path.join(cacheDir, `${id}.json`), JSON.stringify({
		version: 7,
		record: { identity: { cwd, createdAt: 1_700_000_000_000 }, rows },
	}));
};

const A = 'g:/SarosWorkspace/sarosis-agents-client';
const B = 'g:/SarosWorkspace/Saros-agents-pocket';
write('s1', { cwd: A, title: '会话工作台重构', preset: 'vssaros-saros', persona: { personaId: 'reviewer', name: '架构评审', atSeq: 7 } });
write('s2', { cwd: A, title: '人格热切换通路', preset: 'vssaros-saros', questions: 2 });
write('s3', { cwd: A, title: '正在跑的会话', preset: 'vssaros-coder', turn: true });
write('s4', { cwd: A, title: '空闲 4', preset: 'vssaros-coder' });
write('s5', { cwd: A, title: '空闲 5', preset: 'vssaros-coder' });
write('s6', { cwd: A, title: '空闲 6', preset: 'vssaros-coder' });
write('s7', { cwd: A, title: '空闲 7', preset: 'vssaros-coder' });
write('s8', { cwd: B, title: '另一个工作区', preset: 'vssaros-perf' });
write('s9', { title: '没有 cwd 的会话' });
fs.writeFileSync(path.join(cacheDir, 'broken.json'), '{ not json');
fs.writeFileSync(path.join(cacheDir, 'oldver.json'), JSON.stringify({ version: 3, record: {} }));

console.log('── A. store：DSH_HOME 链与缓存读取 ──');
check('config.dshHome 优先', () => assert.equal(dshHomeOf({ dshHome }), dshHome));
check('缓存目录拼接正确', () => assert.equal(projCacheDirOf({ dshHome }), cacheDir));
const scan = await readSessionCaches({ dshHome }, { limit: 100 });
check('坏 JSON 与旧版本各自只丢自己', () => {
	assert.equal(scan.sessions.length, 9, `期望 9 条，实际 ${scan.sessions.length}`);
	assert.equal(scan.errors.length, 2, `期望 2 个错误，实际 ${scan.errors.length}`);
});
check('字段按投影读出（title / preset / cwd / 人格）', () => {
	const s1 = scan.sessions.find(s => s.id === 's1');
	assert.equal(s1.title, '会话工作台重构');
	assert.equal(s1.preset, 'vssaros-saros');
	assert.equal(s1.cwd, A);
	assert.equal(s1.personaId, 'reviewer');
	assert.equal(s1.personaName, '架构评审');
});
check('personaId === null ⇒ 不算切换过（不渲染标记）', () => {
	const s4 = scan.sessions.find(s => s.id === 's4');
	assert.equal(core.personaLabelOf(s4), '');
});

/**
 * 喂给"分组"用例的行：与页面 `collect()` **同口径**（createdAt 降序、同值按 id 兜底）。
 * ⚠ 2026-10-19：`readSessionCaches` 改成按 **mtime 倒序**截断（修「新建会话后找不到之前的会话」），
 *   `scan.sessions` 的顺序从此是"最近写入优先"，不再等于夹具的 s1..s9 ⇒ 分组用例必须先归一化。
 *   否则断言的是"磁盘读取顺序"——那本来就**没有契约**（页面自己会重排），本轮就因此红了两条 ✓。
 */
const rowsForGrouping = scan.sessions.slice().sort((a, b) => {
	const left = typeof a.createdAt === 'number' ? a.createdAt : -1;
	const right = typeof b.createdAt === 'number' ? b.createdAt : -1;
	return (right - left) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
});

console.log('── A2. 截断必须按"最近写入"取（文件名是会话 id，字典序 ≠ 最近）──');
/*
 * 2026-10-19 用户报障「新建会话后找不到之前的会话 item」：真实目录里有 1684 个缓存文件，
 * 而 `readSessionCaches` 只取 300 条 —— 从前是按**文件名**排序后截断，文件名=会话 id，
 * 于是留下的是"字母序最前的 300 条"（页面里全是 session-0044…/session-005f…），
 * 刚新建的会话、以及任何 id 排在后面的会话**永远进不来** ⇒ 用户以为历史丢了 ✗。
 * 契约：截断按 **mtime 倒序**（最近有活动的优先）。
 */
{
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-sessions-recent-'));
	const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
	fs.mkdirSync(dir, { recursive: true });
	// 文件名 a..f 的字典序与"最近"**相反**：a 最旧、f 最新（这样两种实现的结果不同，测试才有判别力）
	['a', 'b', 'c', 'd', 'e', 'f'].forEach((id, i) => {
		const file = path.join(dir, `${id}.json`);
		fs.writeFileSync(file, JSON.stringify({
			version: 7,
			record: { identity: { cwd: A, createdAt: 1_700_000_000_000 + i }, rows: { title: { val: `会话 ${id}` } } },
		}));
		const t = new Date(Date.UTC(2026, 9, 1, 0, 0, i));   // 每条 mtime 差 1 秒
		fs.utimesSync(file, t, t);
	});
	const recent = await readSessionCaches({ dshHome: home }, { limit: 3 });
	check('limit 截断取**最近写入**的 3 条（不是字典序最前的 a/b/c）', () => {
		assert.deepEqual(recent.sessions.map(s => s.id), ['f', 'e', 'd'],
			`实际拿到 ${JSON.stringify(recent.sessions.map(s => s.id))} —— 按文件名排序会得到 a/b/c ✗`);
		assert.equal(recent.truncated, true);
		assert.equal(recent.remaining, 3);
	});
	fs.rmSync(home, { recursive: true, force: true });
}

console.log('── B. 状态归约（awaiting 优先于 running）──');
check('turnBoundary.running → running', () => assert.equal(core.statusOf(scan.sessions.find(s => s.id === 's3')), 'running'));
check('userQuestions=2 → awaiting', () => assert.equal(core.statusOf(scan.sessions.find(s => s.id === 's2')), 'awaiting'));
check('都没有 → idle', () => assert.equal(core.statusOf(scan.sessions.find(s => s.id === 's4')), 'idle'));
check('awaiting 同时有 running 信号时仍是 awaiting', () =>
	assert.equal(core.statusOf({ turnRunning: true, pendingQuestions: 1 }), 'awaiting'));
check('未知不伪装：缺席的单元不会变成 0', () => {
	const s9 = scan.sessions.find(s => s.id === 's9');
	assert.equal(s9.pendingQuestions, undefined);
	assert.equal(s9.turnRunning, undefined);
});

console.log('── C. 分组与配额（与 VsSaros 侧同一张黄金表）──');
const groups = core.buildSessionGroups(rowsForGrouping);
check('按 cwd 分组，未分组恒在最后', () => {
	assert.equal(groups.length, 3);
	assert.deepEqual(groups.map(g => g.key), [A, B, core.UNGROUPED_GROUP_KEY]);
	assert.equal(groups[0].title, 'sarosis-agents-client');
	assert.equal(groups[2].ungrouped, true);
});
const gA = groups[0];
check('组内 7 条：2 条 active（1 running + 1 awaiting）+ 5 条空闲', () => {
	assert.equal(gA.sessions.length, 7);
	assert.equal(gA.sessions.filter(core.isActiveSession).length, 2);
});
const win = core.computeGroupWindow(gA.sessions, 0, core.isActiveSession);
check('默认只显示 5 条空闲 + 2 条 active = 7（本组恰好全显示）', () => {
	assert.equal(win.visible.length, 7);
	assert.equal(win.hiddenIdle, 0);
	assert.equal(win.canExpand, false);
});
check('运行中的行不占配额（插到末尾也仍然可见）', () => {
	// 夹具必须"空闲条数 > 配额"，否则看不出配额有没有被运行中的那条吃掉（本条断言第一版就写错了，
	// 期望值算成了 1 —— 因为那组空闲只有 4 条，本来就没到 5 ⇒ 守卫把错误期望抓住了 ✓）。
	const idle = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, cwd: A }));
	const runner = { id: 'runner', cwd: A, turnRunning: true };
	const w = core.computeGroupWindow([...idle, runner], 0, core.isActiveSession);
	assert.equal(w.visible.length, 6, '期望 5 条空闲 + 1 条运行中');
	assert.equal(w.hiddenIdle, 2, '空闲配额仍是 5（运行中的那条不算进去）');
	assert.ok(w.visible.includes(runner), '运行中的行必须可见（哪怕排在最后）');
});
check('展开 → 收起（14 条空闲的两步）', () => {
	const many = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, cwd: A }));
	const first = core.computeGroupWindow(many, 0, core.isActiveSession);
	assert.deepEqual([first.visible.length, first.hiddenIdle, first.canExpand], [5, 9, true]);
	const second = core.computeGroupWindow(many, core.nextExtraShown(0), core.isActiveSession);
	assert.deepEqual([second.visible.length, second.hiddenIdle, second.canExpand], [10, 4, true]);
	const third = core.computeGroupWindow(many, core.nextExtraShown(10), core.isActiveSession);
	assert.deepEqual([third.visible.length, third.hiddenIdle, third.canExpand, third.canCollapse], [14, 0, false, true]);
});
check('unlimited（搜索命中）⇒ 不截断', () => {
	assert.equal(core.computeGroupWindow(Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` })), 0, core.isActiveSession, { unlimited: true }).visible.length, 30);
});
check('容错：NaN / 负数 extra 不会让整组消失', () => {
	assert.equal(core.computeGroupWindow(Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` })), Number.NaN, core.isActiveSession).visible.length, 5);
	assert.equal(core.computeGroupWindow(Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` })), -3, core.isActiveSession).visible.length, 5);
});
check('路径末段同时认反斜杠（Windows cwd）', () => {
	assert.equal(core.workspaceTitleOf('g:\\SarosWorkspace\\sarosis-agents-client'), 'sarosis-agents-client');
});

console.log('── C1b. 空白会话不许吃掉可见配额（用户 2026-10-19 报「还是看不到那条历史会话」）──');
/*
 * 实测现场：1691 个投影缓存里 **1681 个是空白会话**（blank=true，每开一个聊天页签就产生一个）。
 * 组内可见配额只有 5 条、按时间取 ⇒ 5 个槽全是「（未命名会话）」，真正有内容的会话
 * （写入时间第 6 名）被挤到「展开其余」后面 ⇒ 用户以为历史丢了 ✗。
 * 契约：组内**有内容的在前**，空白整组排后；配额因此优先装下真正有内容的会话。
 */
{
	const rows = [
		...Array.from({ length: 6 }, (_, i) => ({ id: `blank${i}`, cwd: A, createdAt: 6000 - i, blank: true })),
		...(Array.from({ length: 3 }, (_, i) => ({ id: `real${i}`, cwd: A, createdAt: 3000 - i, blank: false }))),
	];
	const groups = core.buildSessionGroups(rows, { by: 'workspace' });
	const ordered = groups[0].sessions.map(s => s.id);
	check('组内顺序：有内容的会话全排在空白会话之前（稳定：同类里仍是时间倒序）', () => {
		assert.deepEqual(ordered.slice(0, 3), ['real0', 'real1', 'real2']);
		assert.deepEqual(ordered.slice(3), ['blank0', 'blank1', 'blank2', 'blank3', 'blank4', 'blank5']);
	});
	check('★ 5 条配额先给有内容的会话（从前 6 个空白把它们全挤掉）', () => {
		const w = core.computeGroupWindow(groups[0].sessions, 0, core.isActiveSession);
		assert.deepEqual(w.visible.map(s => s.id), ['real0', 'real1', 'real2', 'blank0', 'blank1']);
		assert.equal(w.hiddenIdle, 4);
		assert.equal(w.canExpand, true);
	});
	check('blank 未标记（undefined）按"有内容"处理 —— 不能把老数据全判成空白', () => {
		const g = core.buildSessionGroups([{ id: 'u1', cwd: A, createdAt: 1 }, { id: 'b1', cwd: A, createdAt: 2, blank: true }], { by: 'workspace' });
		assert.deepEqual(g[0].sessions.map(s => s.id), ['u1', 'b1']);
	});
}

console.log('── C2. 按 Bot 分组（2026-10-12 用户要求：两种分组方式）──');
const botGroups = core.buildSessionGroups(rowsForGrouping, { by: 'bot' });
check('两种分组方式都在：按 preset 分组，组名就是 preset id，未归属 Bot 恒在最后', () => {
	// 夹具里 preset 三种：vssaros-saros / vssaros-coder / vssaros-perf，另有 s9 没有 preset。
	// ⚠ 夹具的 createdAt 全相同 ⇒ `right - left === 0`，稳定排序保持**首次出现顺序**（不是 key 字典序 ——
	// 第一版断言就是这么写错的：以为会走 localeCompare 兜底，实际兜底只在"两边都没有时间"时才生效）。
	assert.deepEqual(botGroups.map(g => g.title), ['vssaros-saros', 'vssaros-coder', 'vssaros-perf', '未归属 Bot']);
	assert.equal(botGroups[botGroups.length - 1].ungrouped, true);
});
check('组序按"该组最新会话的 createdAt"降序（时间不同时才看得出来）', () => {
	const rows = [
		{ id: 'a', preset: 'bot-old', createdAt: 100 },
		{ id: 'b', preset: 'bot-new', createdAt: 300 },
		{ id: 'c', preset: 'bot-old', createdAt: 200 },
	];
	assert.deepEqual(core.buildSessionGroups(rows, { by: 'bot' }).map(g => g.key), ['bot-new', 'bot-old']);
	// 都没有时间 ⇒ 退回 key 字典序（保证确定性，不抖）
	assert.deepEqual(core.buildSessionGroups([{ id: 'x', preset: 'bbb' }, { id: 'y', preset: 'aaa' }], { by: 'bot' }).map(g => g.key), ['aaa', 'bbb']);
});
check('换分组方式不丢会话（总数守恒）', () => {
	assert.equal(botGroups.reduce((n, g) => n + g.sessions.length, 0), scan.sessions.length);
});
check('按 Bot 分组时分组头副文本为空（组名就是 preset，不重复显示）', () => {
	assert.deepEqual(botGroups.filter(g => !g.ungrouped).map(g => g.path), ['', '', '']);
});
check('normalizeGroupBy：不认识 / 缺失的值回默认工作区（坏参数不抛错、不空页）', () => {
	assert.equal(core.normalizeGroupBy('bot'), 'bot');
	assert.equal(core.normalizeGroupBy(' BOT '), 'bot');
	assert.equal(core.normalizeGroupBy('workspace'), 'workspace');
	assert.equal(core.normalizeGroupBy('nonsense'), 'workspace');
	assert.equal(core.normalizeGroupBy(undefined), 'workspace');
});
check('groupKeyOf：按 Bot 取 preset、按工作区取 cwd（未知一律未归属）', () => {
	assert.equal(core.groupKeyOf({ preset: 'x' }, 'bot'), 'x');
	assert.equal(core.groupKeyOf({ cwd: 'y' }, 'bot'), core.UNGROUPED_GROUP_KEY);
	assert.equal(core.groupKeyOf({ cwd: 'y' }, 'workspace'), 'y');
});
check('花名册映射（presetNamesOf）：只收有 id + 非空 name 的项，坏形状一律空表', () => {
	const map = core.presetNamesOf([
		{ id: 'vssaros-standard', name: '标准助手' },
		{ id: 'vssaros-broken', name: '坏了' },
		{ id: 'vssaros-noname' },
		{ id: 'vssaros-empty', name: '   ' },
		{ name: '没有 id' },
	]);
	assert.deepEqual([...map.entries()], [['vssaros-standard', '标准助手'], ['vssaros-broken', '坏了']]);
	// 形状容错：`{presets:[...]}` 也认（页面侧 API 是那个形状）；非数组 / null 一律空表（不抛错）
	assert.equal(core.presetNamesOf({ presets: [{ id: 'a', name: 'n' }] }).get('a'), 'n');
	assert.equal(core.presetNamesOf(null).size, 0);
});
check('applyPresetNames：按 Bot 时组名换成显示名、**副文本留 preset id**；查不到保持 id、不动工作区分组', () => {
	const names = new Map([['vssaros-saros', '标准助手']]);
	const groups = core.buildSessionGroups(rowsForGrouping, { by: 'bot' });
	const named = core.applyPresetNames(groups, 'bot', names);
	assert.equal(named[0].title, '标准助手');
	assert.equal(named[0].path, 'vssaros-saros', '真身（preset id）不藏');
	assert.deepEqual(named.slice(1).map(g => g.title), groups.slice(1).map(g => g.title), '查不到的组保持原样');
	assert.equal(core.applyPresetNames(groups, 'workspace', names)[0].title, groups[0].title, '工作区分组不受影响');
	assert.equal(core.applyPresetNames(groups, 'bot', new Map())[0].title, groups[0].title, '空花名册 ⇒ 原样（回落 id）');
});

console.log('── C3. 多根工作区（主根 + 关联根 = 同一组；组头只留主根）──');
const ROOT_A = 'g:/SarosWorkspace/sarosis-agents-client';
const ROOT_B = 'g:/SarosWorkspace/Saros-agents-pocket';
const multi = core.buildSessionGroups([
	{ id: 'm1', cwd: ROOT_A, createdAt: 3 },
	{ id: 'm2', cwd: ROOT_B, createdAt: 2 },
	{ id: 'm3', cwd: 'g:/elsewhere/other', createdAt: 1 },
], { workspaceRoots: [ROOT_A, ROOT_B] });
check('主根与关联根下的会话归到同一组（从前只按 cwd ⇒ 一个工作区被拆成好几块）', () => {
	assert.equal(multi.length, 2, `期望 2 组（工作区 + 其它 cwd），实际 ${multi.length}`);
	assert.deepEqual(multi[0].sessions.map(s => s.id), ['m1', 'm2']);
});
check('组头副文本只放主根（用户报「鼠标滑过后显示多根内容」：整串根不许糊进 path）', () => {
	assert.equal(multi[0].path, ROOT_A);
	assert.ok(!String(multi[0].path).includes(' · '), 'path 里不许出现多根拼接');
});
check('完整根集合走 roots 字段（渲染层据此画「+N」徽标，不画进可见文本）', () => {
	assert.deepEqual(multi[0].roots, [ROOT_A, ROOT_B]);
	assert.equal(multi[1].roots, undefined, '非工作区那条组不带 roots');
});

console.log('── D. 页面壳能被调用（参数名写错会在这里炸）──');
check('renderShell 收下本页的参数组合', () => {
	const html = shell.renderShell({
		kind: 'sessions', title: '历史会话', subtitle: '按工作区',
		bodyHtml: '<div class="sv-groups"></div>', extraCss: '.sv-group{}', script: 'void 0;',
	});
	assert.ok(html.includes('<!doctype html') || html.includes('<!DOCTYPE html'), '输出里应有 doctype');
	assert.ok(html.includes('sv-groups'), 'bodyHtml 应进页面');
	assert.ok(html.includes('.sv-group{}'), 'extraCss 应进页面');
});
check('escapeHtml 挡住注入', () => {
	assert.equal(shell.escapeHtml('<img onerror=1>'), '&lt;img onerror=1&gt;');
});

console.log('── E. 页面 CSS 契约：sticky 组头必须**不透明**（用户两次报「工作区 item 与 item 重叠」）──');
/*
 * 病根（2026-10-19 实证）：组头 `position: sticky; top: 0`，滚动时下面的会话行必然从它身上经过；
 * 而它原先只用 `background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.12))` 上色，
 * 这个主题变量在真实/缺省主题里是半透明甚至透明 ⇒ 行标题从组头里透出来，看起来就是"两块 item 叠在一起"。
 * 实测复现：300px 窄栏滚 14px，第一行标题正好压在组头下沿（.out/repro-sessions-overlap.html）。
 * ⇒ 契约：底色必须是实心层（侧栏背景色），section-header 的色只能当叠加层（渐变），hover 只换叠加层。
 * ⚠ 这三条断言写成**形态判据**（不是比对整段 CSS），因为主题变量可以换、颜色可以调，但"不许透底"不能丢。
 */
const idxSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const pageCss = (() => {
	const at = idxSrc.indexOf('const PAGE_CSS = `');
	assert.ok(at >= 0, 'lib/index.js 里找不到 PAGE_CSS');
	const start = at + 'const PAGE_CSS = `'.length;
	return idxSrc.slice(start, idxSrc.indexOf('`;', start));
})();
const ruleOf = selector => {
	const at = pageCss.indexOf(selector + ' {');
	assert.ok(at >= 0, `PAGE_CSS 里找不到规则 ${selector}`);
	return pageCss.slice(at, pageCss.indexOf('}', at));
};
const headRule = ruleOf('.sv-group-header');
const headHoverRule = ruleOf('.sv-group-header:hover');
check('组头底色是实心层（半透明会让滚到下面的会话行透出来 ⇒ 看起来"重叠"）', () => {
	assert.match(headRule, /background-color:\s*var\(--vscode-sideBar-background/,
		'必须用侧栏背景色铺一层实心底');
	assert.match(headRule, /background-image:\s*linear-gradient\(var\(--sv-head-tint\)/,
		'section-header 的色只能作为叠加层（渐变）');
	assert.ok(!/(^|[;\s])background\s*:/.test(headRule),
		'不许用 background 简写铺组头底色（简写会带上半透明色 ⇒ 透底）');
	assert.ok(!/background(-color)?\s*:\s*(transparent|rgba\(|hsla\()/i.test(headRule),
		'底色不许直接写成 transparent / rgba() / hsla()');
});
check('组头 hover 只换叠加层颜色（写 background 简写会重置叠加层 ⇒ 悬停时重新透底）', () => {
	assert.ok(!/(^|[;\s])background\s*:/.test(headHoverRule), 'hover 里不许出现 background 简写');
	assert.match(headHoverRule, /--sv-head-tint\s*:/, 'hover 必须只改 --sv-head-tint');
});
/*
 * ★ 2026-10-19 第二例（用户报「sideview 的 UI 层级和 工作区下拉框弹出 UI 层级错误」）：
 * 三个**浮层**（下拉菜单 .sv-dd-items / 多根详情 .sv-roots-pop / 右键菜单 .sv-ctx）原先都只用
 * `background: var(--vscode-menu-background, ...)` 或 `editorHoverWidget-background` 上色。
 * 这两类主题色在真实主题里**可能是半透明**（`--vscode-*` 从不保证不透明）⇒ 面板下方的会话行
 * 会从浮层里透出来，看上去就是"层级错乱 / 两块 UI 叠在一起"，而用户描述的"层级错误"其实
 * 一半来自透底（另一半来自 header 那枚菜单用了 absolute + zIndex 被祖先层叠上下文困住，已在
 * chat-surface/client.workspace.js 改成 fixed）。⇒ 契约：浮层必须有**实心底 + 主题叠层**。
 */
for (const sel of ['.sv-dd-items', '.sv-roots-pop', '.sv-ctx']) {
	check(`浮层 ${sel} 必须是「实心底 + 主题叠层」（半透明主题色会让下面的行透出来 ⇒ 看起来像层级错乱）`, () => {
		const rule = ruleOf(sel);
		assert.match(rule, /background-color:\s*var\(--vscode-sideBar-background/,
			`${sel} 必须先用侧栏底色铺一层实心（--vscode-sideBar-background）`);
		assert.match(rule, /background-image:\s*linear-gradient\(/,
			`${sel} 的主题色只能作为叠加层（background-image: linear-gradient）`);
		assert.ok(!/(^|[;\s])background\s*:/.test(rule),
			`${sel} 不许用 background 简写（简写会带上半透明色 ⇒ 透底）`);
	});
}

check('会话行必须**真的**能被 hidden 隐藏（.sv-item 自己写了 display:flex ⇒ 会盖掉 UA 的 [hidden]）', () => {
	// 2026-10-19 用户报「工作区里的会话 item 太多，默认只显示最近 5 个」：服务端早就只给 5 条可见、
	// 其余带 hidden，但 `.sv-item { display: flex }` 是**作者样式**、压过浏览器内置的 `[hidden]{display:none}`
	// ⇒ 187 条全摊开，配额与搜索过滤双双静默失效。这一行是那条配额的**唯一实现基础**。
	assert.match(pageCss, /\.sv-item\[hidden\]\s*\{\s*display:\s*none/,
		'缺 .sv-item[hidden] { display: none } ⇒ 配额/搜索折叠全部失效');
});

console.log('── F. 页面脚本与**当前**分组切换控件对得上（改名只改一边 = 静默失效）──');
/*
 * 2026-10-19 踩到的形态：切换控件从「四个 chip（.sv-mode）」改成「两个下拉（.sv-dd > a.sv-dd-item）」，
 * 但页面脚本还在绑 .sv-mode ⇒ 一个都匹配不到、cookie 永远写不进去，**没有任何报错**
 * （只有真机探针 p3-49 的「选择会被记住」变红）。⇒ 契约：脚本绑的选择器必须与标记里真会渲染的类名同源。
 */
const pageScript = (() => {
	const at = idxSrc.indexOf('const PAGE_SCRIPT = `');
	assert.ok(at >= 0, 'lib/index.js 里找不到 PAGE_SCRIPT');
	const start = at + 'const PAGE_SCRIPT = `'.length;
	return idxSrc.slice(start, idxSrc.indexOf('`;', start));
})();
check('下拉项类名与脚本绑定点同源（改名只改一边 ⇒ cookie 记忆静默失效）', () => {
	assert.ok(idxSrc.includes('class="sv-dd-item'), '标记里应当渲染 a.sv-dd-item（下拉项）');
	assert.match(pageScript, /\.sv-dd-item\[href\*="groupBy="\]/, '脚本必须绑当前下拉项');
	assert.match(pageScript, /vssaros-sessions-group/, 'cookie 名不能丢（服务端读它当默认值）');
});
/**
 * ★★ 2026-10-19（本轮真栽了两次）：模板串里写反引号会**提前闭合**，而闭合之后剩下的文本仍可能
 * 拼成"语法合法"的 JS ⇒ `node --check` **绿**、正则守卫也全绿，只有**真 import** 时才炸
 * （真机表现：Host 日志 `vssaros-sessions (@vssaros/dsh-sessions): failed to import` + 页面 404）。
 * ⇒ 这里必须**动真的**：① 动态 import 模块（等价于 Host 加载它）② 页面脚本做一次真解析。
 */
await checkAsync('lib/index.js 能被真 import（不是只有 --check），页面脚本也是合法 JS', async () => {
	const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
	assert.equal(typeof mod.apply, 'function', '模块必须导出 apply（否则 Host 装上也起不来）✗');
	// eslint-disable-next-line no-new-func
	new Function(pageScript);   // 只解析、不执行
	// ★★ 2026-10-19（本轮实测栽的一次）：上面的 `new Function(源码切片)` **验不出转义问题** ——
	//   模板串里的反斜杠转义会在**生成页面时**被求值（一个反斜杠加 n 变成真换行，把页面里的
	//   字符串字面量撑断 ⇒ 浏览器 `Uncaught SyntaxError`，而这里仍然全绿 ✗）。
	//   ⇒ 必须按模板**求值一次**再解析：PAGE_SCRIPT 里没有 ${} 插值（下面断言它），所以求值等价于
	//     浏览器拿到的那段脚本。
	assert.ok(!pageScript.includes('${'), 'PAGE_SCRIPT 里出现插值 ⇒ 本断言的"求值"不再等价，需改成真渲染 ✗');
	// eslint-disable-next-line no-new-func
	const emitted = new Function('return `' + pageScript + '`;')();
	// eslint-disable-next-line no-new-func
	new Function(emitted);   // 页面真正拿到的那段脚本必须能解析
});
check('打开会话必须带 cwd + preset（宿主靠 cwd 先 session.start 接管历史会话，否则永远「正在打开会话…」）', () => {
	// 2026-10-19 用户报「双击会话 item 后打不开对应的聊天框」：真机日志里页面只发了 sessionId，
	// 而那条历史会话不在 Host 的 live 集合里 ⇒ 页面 openSession 报 `sessions.retain: unknown session`。
	assert.match(idxSrc, /data-cwd="\$\{escapeHtml\(session\.cwd\)\}"/, '行上必须带 data-cwd');
	assert.match(pageScript, /openSession\(id,\s*el\.getAttribute\('data-preset'\)/, 'openSession 必须把 preset 交上去');
	assert.match(pageScript, /el\.getAttribute\('data-cwd'\)/, 'openSession 必须把 cwd 交上去');
});
check('右键「重命名会话」：就地输入 → 走桥 renameSession（带 preset/cwd）→ 回读服务端真值确认', () => {
	// 2026-10-19 用户要求。三条都必须钉住：
	//  ① 菜单里真有这一项，且**绑的是**就地改名（不是只写个标题）；
	//  ② 改名必须**经宿主**（dsh 的 ctx.sessions.rename 只在聊天页里）⇒ 必须调桥的 renameSession；
	//  ③ 成功与否以**服务端真值**为准（回读 api/sessions），失败回滚 + 提示 —— 不许"点了就显示成功"✗。
	assert.ok(/item\('重命名会话…', function \(\) \{ startRename\(el\); \}\)/.test(pageScript), '菜单项必须真的启动就地改名 ✗');
	assert.match(pageScript, /b\.renameSession\(id, next, \{/, '必须**真的调用**桥的 renameSession ✗');
	assert.match(pageScript, /agentPreset: el\.getAttribute\('data-preset'\)/, 'renameSession 要带 preset ✗');
	assert.match(pageScript, /cwd: el\.getAttribute\('data-cwd'\)/, 'renameSession 要带 cwd（宿主可能要先把会话绑上聊天框）✗');
	assert.match(pageScript, /data-sessions-api/, '必须回读服务端真值（api/sessions）确认改名 ✗');
	assert.ok(pageScript.includes("titleEl.textContent = prevText"), '失败必须回滚标题（不许假成功）✗');
	assert.match(pageCss, /\.sv-rename \{/, '输入框要有样式（否则行高被撑开 ✗）');
});
check('「打开会话」必须有**立刻可见**的受理反馈（聊天框可能在别的 group，页面侧看不到变化 ✗）', () => {
	assert.match(pageScript, /el\.classList\.add\('is-opening'\)/, '必须给行一个受理态（点了立刻有反应）✗');
	assert.match(pageCss, /\.sv-item\.is-opening \{/, '受理态要有样式（否则加了类也看不出来 ✗）');
});
check('双击也要能打开，且不能因"两次 click"而发两遍 openSession', () => {
	assert.ok(pageScript.includes("addEventListener('dblclick'"), '必须绑 dblclick');
	assert.match(pageScript, /lastOpenAt/, '必须有去抖（dblclick 前浏览器会先发两次 click）');
});
console.log('── G. 多根工作区：组头显示**根的数量**，hover 弹出每根详情（用户 2026-10-19 要求）──');
check('徽标文本是**根的总数**（不是 +N 的多余个数），每个根的完整路径进 data-roots', () => {
	// 用户口径：多根时要"显示根的数量" —— 4 个根就写 4，而不是 +3（+3 会被读成"还有 3 个"）。
	assert.match(idxSrc, /\$\{roots\.length\} 根/, '徽标必须显示根的总数 ✗');
	assert.ok(!/\+\$\{extraRoots\}/.test(idxSrc), '不许再用 +N（那是"多出来的个数"，用户要的是总数）✗');
	assert.match(idxSrc, /data-roots="\$\{escapeHtml\(roots\.join\('\\n'\)\)\}"/, '每个根的完整路径必须落在 data-roots（浮层数据源）✗');
	assert.match(idxSrc, /sv-group-roots" role="note" tabindex="0"/, '徽标要可聚焦（键盘也能看详情）✗');
});
check('hover / 聚焦弹出自绘浮层，且 fixed 挂 body（原生 title 延迟 1s、不能换行、会被滚动容器裁）', () => {
	assert.match(pageScript, /function showRootsPop\(anchor, roots\)/, '必须自绘详情浮层 ✗');
	assert.ok(pageScript.includes('document.body.appendChild(pop)'), '浮层必须挂 body（挂组头里会被滚动容器裁掉）✗');
	assert.match(pageCss, /\.sv-roots-pop \{ position: fixed/, '浮层必须 fixed 定位 ✗');
	assert.match(pageScript, /mouseenter', function \(\) \{ showRootsPop/, 'hover 就要弹（不是点击才弹）✗');
	assert.match(pageScript, /badge\.addEventListener\('click', function \(e\) \{ e\.stopPropagation\(\); \}\);/,
		'徽标长在组头里、组头整行是折叠开关 ⇒ 点徽标必须吞掉事件（否则一点就折起整组）✗');
});
check('会话条目按**稿 A** 渲染：双行紧凑 + 状态竖条 + 行尾 ⋯（不画卡片边框）', () => {
	// 2026-10-19 用户先选 C（卡片+状态环），后改选 **A（双行紧凑 + 行尾 ⋯）**。
	// 钉五件事（形态判据，不比对整段 CSS —— 颜色可以再调，这五条不能丢）：
	//  ① 展开入口字形是「⋯」，展开后「×」；② 展开态靠 .open 高亮；
	//  ③ 状态竖条沿用 sv-dot 类名（探针钉着 sv-dot-running/awaiting）；
	//  ④ 运行中要能脉动 + 尊重减弱动效；⑤ **不许有卡片边框**（那是稿 C 的形态）。
	assert.match(idxSrc, /class="sv-arrow"[^>]*>⋯<\/span>/, '展开入口必须是「⋯」（用户明确不要三角形）✗');
	assert.ok(!/class="sv-arrow"[^>]*>▶/.test(idxSrc), '展开入口不许再用三角形 ▶ ✗');
	assert.match(pageScript, /arrow\.textContent = open \? '×' : '⋯'/, '展开后要换成「×」✗');
	assert.match(pageScript, /el\.classList\.toggle\('open', open\)/, '展开态要挂到行上（高亮用）✗');
	assert.match(pageCss, /\.sv-item\.open \{[^}]*background/, '展开态必须高亮（淡蓝底）✗');
	assert.match(pageCss, /\.sv-dot \{[^}]*width: 2px/, '状态要用**竖条**（稿 A），不是环/圆点 ✗');
	assert.match(pageCss, /@keyframes sv-bar-pulse/, '运行中的竖条要有脉动（一眼可辨）✗');
	assert.match(pageCss, /prefers-reduced-motion[^}]*\.sv-dot-running \{ animation: none/,
		'减弱动效时必须关掉脉动（否则无障碍设置形同虚设）✗');
	// 稿 A 的形态判据：**行不画边框**（有边框就是稿 C 的卡片）
	const itemRule = ruleOf('.sv-item');
	assert.match(itemRule, /border:\s*0/, '稿 A 的行不许有卡片边框（那是稿 C）✗');
	// ★ 长标题不许把右侧操作区挤到第二行：行是 flex-wrap（详情块要换行），换行判定看
	//   各项的 max-content 假设尺寸 ⇒ .sv-body 的 flex-basis 必须是 0，否则标题一长行就翻倍高。
	assert.match(pageCss, /\.sv-body \{[^}]*flex: 1 1 0/, 'sv-body 的 flex-basis 必须是 0（否则长标题会把操作区挤到下一行）✗');
});
check('组内重排不许把「展开其余」顶到列表最上面（.sv-more 是 .sv-items 的兄弟节点）', () => {
	// 2026-10-19 用户截图：组头下面第一条就是「展开其余 182 条」，然后才是会话 —— 因为重排用了
	// `wrap.appendChild(item)`，把所有行排到了 .sv-more **后面**。⇒ 行必须插到 more 之前。
	assert.match(pageScript, /insertBefore\(el,\s*more\)/, '重排必须插到 .sv-more 之前');
	assert.ok(!/items\.forEach\(function \(el\) \{ wrap\.appendChild\(el\); \}\)/.test(pageScript),
		'不许再无条件 appendChild（会把 more 顶到最上面）');
});

console.log('── H. 清空历史会话（2026-10-19 用户要求）──');
const prefsCore = await import(pathToFileURL(path.join(ROOT, 'core/prefs.js')).href);
check('prefs：清空只写 clearedAt；recent / pin 不能把清空状态抹掉；可一键恢复（pin 原样）', () => {
	const base = prefsCore.normalizePrefs({ pinned: ['a'], recent: ['b'] });
	assert.equal(base.clearedAt, 0, '没清空过必须是 0（否则会误藏整份历史）✗');
	const cleared = prefsCore.withClearedAt(base, 1_700_000_000_000);
	assert.equal(cleared.clearedAt, 1_700_000_000_000);
	// ⚠ 这两条是真 bug 的门槛：写了它们，"点开一次会话 / 固定一次"就不会把清空状态冲掉。
	assert.equal(prefsCore.withRecent(cleared, 'c').clearedAt, cleared.clearedAt, 'recent 写入把清空状态弄丢了 ✗');
	assert.equal(prefsCore.withToggledPin(cleared, 'd').clearedAt, cleared.clearedAt, 'pin 写入把清空状态弄丢了 ✗');
	const restored = prefsCore.resetCleared(cleared);
	assert.equal(restored.clearedAt, 0);
	assert.deepEqual(restored.pinned, ['a'], '恢复清空不该动 pin ✗');
});
check('隐藏判据：只藏「清空前创建 + 空闲 + 未固定」的；运行中 / 新建 / 无时间都不藏', () => {
	const T = 1000;
	const opts = { clearedAt: T, pinned: new Set(['pinned1']), isActive: core.isActiveSession };
	assert.equal(core.isHiddenByClear({ id: 'old', createdAt: 500 }, opts), true);
	assert.equal(core.isHiddenByClear({ id: 'new', createdAt: 1500 }, opts), false, '清空**之后**新建的要照常显示 ✗');
	assert.equal(core.isHiddenByClear({ id: 'pinned1', createdAt: 500 }, opts), false, '已固定必须保留 ✗');
	assert.equal(core.isHiddenByClear({ id: 'run', createdAt: 500, turnRunning: true }, opts), false, '运行中必须保留 ✗');
	assert.equal(core.isHiddenByClear({ id: 'ask', createdAt: 500, pendingQuestions: 1 }, opts), false, '等你回答的必须保留 ✗');
	assert.equal(core.isHiddenByClear({ id: 'noTime' }, opts), false, '没有 createdAt 不许猜着藏 ✗');
	assert.equal(core.isHiddenByClear({ id: 'x', createdAt: 500 }, { clearedAt: 0 }), false, '没清空过 ⇒ 全部显示 ✗');
	const split = core.filterHiddenByClear([{ id: 'old', createdAt: 500 }, { id: 'new', createdAt: 1500 }], opts);
	assert.deepEqual(split.hidden.map(s => s.id), ['old']);
	assert.deepEqual(split.kept.map(s => s.id), ['new']);
});
check('页面：清空按钮 → 页面内二次确认（带"影响多少条"）→ POST clearHistory；清空过出现「恢复」', () => {
	assert.ok(idxSrc.includes('id="sv-clear"'), '必须有「清空历史」按钮 ✗');
	assert.match(idxSrc, /id="sv-clear-panel" class="sv-confirm"/, '必须有二次确认面板（破坏性动作不许一键生效）✗');
	assert.match(idxSrc, /将从列表隐藏 <b>\$\{clearableCount\}<\/b>/, '确认面板必须显示"会影响多少条" ✗');
	assert.match(idxSrc, /运行中 \/ 等待中 <b>\$\{clearSkippedActive\}<\/b>/, '确认面板必须说明哪些会被保留 ✗');
	assert.match(idxSrc, /不会删除<\/b> dsh 里的会话数据/, '必须写清楚"不删数据"（否则用户以为真删了）✗');
	assert.match(pageScript, /postPrefs\(\{ clearHistory: true \}\)/, '确认后必须真的发 clearHistory ✗');
	assert.match(pageScript, /postPrefs\(\{ resetClear: true \}\)/, '「恢复」必须发 resetClear ✗');
	assert.match(idxSrc, /id="sv-restore"/, '清空过之后必须出现「恢复被清空的 N 条」 ✗');
	assert.match(pageCss, /\.sv-confirm\[hidden\] \{ display: none; \}/,
		'确认面板必须能真的隐藏（作者样式的 display:flex 会压过 UA 的 [hidden]，本仓踩过）✗');
	assert.match(pageCss, /\.sv-clear \{/, '清空按钮要有样式 ✗');
});
check('清空**只影响列表**：不删任何文件；API 与页面同口径', () => {
	assert.ok(!/\bunlinkSync\b|\brmSync\b|\bfs\.rm\(/.test(idxSrc), '清空历史不许删文件（删投影缓存＝假删除且不可逆 ✗）');
	assert.ok(idxSrc.includes('filterHiddenByClear(scan.rows'), 'API 侧也必须过滤（否则页面与 API 各说各话）✗');
	assert.ok(idxSrc.includes('clearedAt: apiPrefs.clearedAt'), 'API 要暴露清空状态（消费方要能区分"没有"和"被清空"）✗');
});

console.log('── J. 会话执行中实时更新状态（2026-10-19 用户报「item 状态不实时」）──');
/*
 * 页面是**服务端渲染一次**的 ⇒ 运行状态环 / 相对时间 / 组头计数只反映"打开那一刻"，
 * 会话跑起来也一直显示空闲 ✗。
 * 契约：① 有 api/live 通道，且**只查界面上的 id**（不读磁盘：2s 轮询不能扫 300 个文件）；
 *       ② 页面 2s 轮询 + 不可见时停表；③ 就地打补丁，**不整页重载**（会丢滚动/展开态）；
 *       ④ `data-idle` / `data-active` 必须跟着改（配额与「展开其余」的判据就在它们上面）。
 */
check('api/live：只按 id 查活会话（走 sessions.get + projections，不读磁盘）', () => {
	assert.ok(idxSrc.includes("url.pathname === `${ROUTE_PREFIX}/api/live`"), '必须有 api/live 端点 ✗');
	const seg = idxSrc.slice(idxSrc.indexOf('/api/live`'), idxSrc.indexOf('/api/messages`'));
	assert.match(seg, /state\.sessions\.get\(id\)/, '必须按 id 取活会话（不许全量扫盘）✗');
	assert.match(seg, /state\.projections\.stateOf\(live, unit\)/, '状态要来自投影（turnBoundary / questions）✗');
	assert.ok(!/collect\(config/.test(seg), 'api/live 里不许再跑 collect（那是 300 个文件的读盘）✗');
	assert.match(seg, /status: statusOf\(fresh\)/, '必须回 status（running/awaiting/idle）✗');
});
check('页面：2s 轮询 + 不可见停表 + 就地打补丁（不整页重载）', () => {
	assert.match(idxSrc, /data-live-api="\$\{ROUTE_PREFIX\}\/api\/live"/, '必须把 live 端点交给页面脚本 ✗');
	// ⚠ 本轮实测踩过：轮询代码排在 `var groupsEl = …` 之前 ⇒ 变量提升成 undefined ⇒ liveApi 空串
	//   ⇒ 轮询静默不启动（页面其它交互全正常，只有状态不更新）。必须自己取元素。
	assert.match(pageScript, /var liveGroups = document\.querySelector\('\.sv-groups'\)/,
		'轮询必须自己取 .sv-groups（groupsEl 在本段之后才赋值）✗');
	assert.ok(!/var liveApi = groupsEl \?/.test(pageScript),
		'不许用 groupsEl 取 live 端点（var 提升 ⇒ undefined ⇒ 轮询永不启动）✗');
	// ⚠ 断言**初始化**那一次（`if (liveApi) { liveTimer = setInterval…`），不能用宽泛的
	//   `setInterval(pollLive, 2000)` —— 切回前台那段也有同样一行，删掉初始化后它仍会绿（守卫空跑 ✗）。
	assert.match(pageScript, /if \(liveApi\) \{\s*liveTimer = window\.setInterval\(pollLive, 2000\);/,
		'必须在查出 live 端点后立刻起 2s 轮询 ✗');
	assert.match(pageScript, /if \(!liveApi \|\| document\.hidden\) \{ return; \}/, '页面不可见时必须停手（省电）✗');
	assert.match(pageScript, /addEventListener\('visibilitychange'/, '切回前台要立刻校准一次 ✗');
	assert.match(pageScript, /el\.setAttribute\('data-idle', active \? '0' : '1'\)/,
		'data-idle 必须跟着状态改（配额 / 展开其余的判据）✗');
	// 与服务端规则对齐：运行中 / 等待中的行**始终可见**（不吃 5 条配额）⇒ 变活跃时必须揭开
	assert.match(pageScript, /if \(active\) \{ el\.removeAttribute\('hidden'\); \}/,
		'行变活跃时必须取消折叠（否则用户看不到它在跑）✗');
	assert.ok(!/function pollLive[\s\S]{0,1200}location\.reload/.test(pageScript),
		'轮询里不许整页重载（会丢滚动位置、展开态与正在输入的改名框）✗');
});

console.log('── I. 空白会话默认不显示（B 方案，2026-10-19）──');
/*
 * 空白会话 = 没说过话（官方 `sessionListMetadata.blank`）。实测本机 1691 条里 1681 条是这种
 * （每开一个聊天页签产生一条）⇒ 默认显示会把"历史会话"挤满，真正有内容的会话看不见 ✗。
 * 契约：默认**不显示**；诊断行给出「显示空白会话 N」开关；prefs 里落 showBlank，且不会被
 *       recent / pin / resetClear 抹掉（抹掉 = 列表突然被空白撑满）。
 */
check('prefs：showBlank 默认 false；任何一次写入都不能把它弄丢', () => {
	const base = prefsCore.normalizePrefs(undefined);
	assert.equal(base.showBlank, false, '默认必须不显示空白会话 ✗');
	const on = prefsCore.withShowBlank(base, true);
	assert.equal(on.showBlank, true);
	assert.equal(prefsCore.withRecent(on, 'x').showBlank, true, 'recent 写入把开关弄丢了 ✗');
	assert.equal(prefsCore.withToggledPin(on, 'y').showBlank, true, 'pin 写入把开关弄丢了 ✗');
	assert.equal(prefsCore.withClearedAt(on, 123).showBlank, true, '清空把开关弄丢了 ✗');
	assert.equal(prefsCore.resetCleared(on).showBlank, true, '恢复清空不该动开关 ✗');
	assert.equal(prefsCore.withShowBlank(base, 'yes').showBlank, false, '非布尔值不许当真 ✗');
});
check('页面：默认过滤空白会话；诊断行有「显示空白会话 N」开关并说明隐藏了多少条', () => {
	assert.match(idxSrc, /prefs\.showBlank \? \[\] : clearedSplit\.kept\.filter\(row => row\.blank === true\)/,
		'必须按 blank 过滤（默认不显示）✗');
	assert.match(idxSrc, /已隐藏 \$\{blankRows\.length\} 条空白会话/, '诊断行要说明隐藏了多少条空白会话 ✗');
	assert.ok(idxSrc.includes("'sv-show-blank'") && idxSrc.includes("'sv-hide-blank'"),
		'必须有「显示 / 隐藏空白会话」开关 ✗');
	assert.match(pageScript, /postPrefs\(\{ showBlank: true \}\)/, '打开开关必须落 prefs.showBlank=true ✗');
	assert.match(pageScript, /postPrefs\(\{ showBlank: false \}\)/, '关闭开关必须落 prefs.showBlank=false ✗');
	assert.ok(idxSrc.includes('apiPrefs.showBlank ? apiCleared'), 'API 必须同口径（否则页面与 API 各说各话）✗');
	assert.match(idxSrc, /const clearableCount = visibleRows\.length/, '确认面板的数字必须与**眼前看到的行**对得上 ✗');
});

console.log('── K. 磁贴视图（稿 C：2026-10-21 用户拍板，dsh desktop 的「多会话窗口」）──');
/*
 * 稿 C = 会话磁贴矩阵：一眼看到一批会话的状态，点一块换到那条会话。
 * 契约（逐条钉住，防"看起来做了"）：
 *  ① 视图由 URL 参数切换（**服务端渲染** ⇒ 无 JS 也能切）；
 *  ② 磁贴与列表**同一批可见行**（同一份 visibleRows）⇒ 两个视图看到的会话集合永远一致；
 *  ③ 状态筛选是**纯函数**且与列表同一个 statusOf（两处判活不漂移）；
 *  ④ 磁贴必须带 sessionId / preset / cwd（宿主要靠它们接管历史会话，否则永远「正在打开会话…」）；
 *  ⑤ 点磁贴走桥 openSession 且去抖（双击不重复接管）；
 *  ⑥ live 轮询也要 patch 磁贴（否则磁贴永远停在打开那一刻的状态）；
 *  ⑦ 磁贴必须能真的被 hidden 隐藏（作者 display:flex 会压掉 UA 的 [hidden] —— 列表行已踩过这个坑）；
 *  ⑧ 搜索也要过滤磁贴（否则磁贴视图里搜索静默失效）。
 */
{
	// ① 路由：view / status 两个参数 + 传给 pageHtml
	assert.match(idxSrc, /url\.searchParams\.get\('view'\) === 'tiles' \? 'tiles' : 'list'/,
		'必须按 view 参数切视图（服务端渲染 ⇒ 无 JS 也能切）✗');
	assert.ok(idxSrc.includes('pageHtml(scan, config, groupBy, scope, view, status)'),
		'view / status 必须真的传进渲染函数 ✗');
	assert.ok(idxSrc.includes('normalizeStatusFilter(url.searchParams.get(\'status\'))'),
		'状态筛选必须走归一化（坏参数回默认，不空页）✗');
	// 视图切换链接必须带 view 参数，且**别把范围/分组口径悄悄重置**
	assert.ok(idxSrc.includes('href="?view=list&scope=${scope}&groupBy=${by}&status=${statusFilter}"'),
		'必须有「列表」视图链接 ✗');
	assert.ok(idxSrc.includes('href="?view=tiles&scope=${scope}&groupBy=${by}&status=${statusFilter}"'),
		'必须有「磁贴」视图链接 ✗');
	assert.ok(idxSrc.includes('href="?view=${view}&scope=all&groupBy=${by}"')
		&& idxSrc.includes('href="?view=${view}&scope=${scope}&groupBy=${key}"'),
		'切工作区范围/分组方式时必须**保留当前视图**（否则用户在磁贴视图点一下就掉回列表 ✗）');
	// ② 同一批可见行
	assert.match(idxSrc, /const tileRows = filterByStatus\(visibleRows, statusFilter\)/,
		'磁贴必须取**同一份 visibleRows**（两个视图看到的会话集合必须一致）✗');
	assert.ok(idxSrc.includes('tilesHtml(tileOrder, now, pinnedSet)'), '磁贴必须用上面那份行渲染 ✗');
	// ③ 纯函数筛选（core）
	check('状态筛选是纯函数：running / awaiting / idle / 全部 各归各的；坏值回全部', () => {
		const rows = [
			{ id: 'run', turnRunning: true },
			{ id: 'ask', pendingQuestions: 1 },
			{ id: 'idle' },
		];
		assert.deepEqual(core.filterByStatus(rows, 'running').map(r => r.id), ['run']);
		assert.deepEqual(core.filterByStatus(rows, 'awaiting').map(r => r.id), ['ask']);
		assert.deepEqual(core.filterByStatus(rows, 'idle').map(r => r.id), ['idle']);
		assert.equal(core.filterByStatus(rows, 'all').length, 3);
		assert.equal(core.filterByStatus(rows, 'nonsense').length, 3, '坏值必须回全部（不许空页）✗');
		assert.equal(core.normalizeStatusFilter('nonsense'), 'all');
		assert.equal(core.normalizeStatusFilter(undefined), 'all');
		assert.equal(core.filterByStatus(null, 'all').length, 0, '非数组不许抛错 ✗');
	});
	// ④ 磁贴标记：必须带 sessionId / preset / cwd
	const tileHtmlSeg = idxSrc.slice(idxSrc.indexOf('function tileHtml('), idxSrc.indexOf('function tilesHtml('));
	check('磁贴必须带 sessionId / preset / cwd（宿主靠它们接管历史会话）', () => {
		assert.ok(tileHtmlSeg.length > 0, '找不到 tileHtml ✗');
		assert.match(tileHtmlSeg, /data-session-id=/, '磁贴必须带 data-session-id ✗');
		assert.match(tileHtmlSeg, /data-preset=/, '磁贴必须带 data-preset ✗');
		assert.match(tileHtmlSeg, /data-cwd=/, '磁贴必须带 data-cwd ✗');
		assert.match(tileHtmlSeg, /class="sv-tile/, '磁贴必须有 sv-tile 类（脚本按它找）✗');
		assert.match(tileHtmlSeg, /data-status="\$\{status\}"/, '磁贴必须带 data-status（筛选/补丁的判据）✗');
	});
	// ⑤ 点磁贴走桥 + 去抖
	const tileScriptSeg = pageScript.slice(
		pageScript.indexOf("Array.prototype.forEach.call(document.querySelectorAll('.sv-tile[data-session-id]')"),
		pageScript.indexOf("var newBtn = document.getElementById('sv-new')"),
	);
	check('点磁贴 = 打开那条会话（走桥 openSession，带 preset+cwd，且去抖）', () => {
		assert.ok(tileScriptSeg.length > 0, '页面脚本里找不到磁贴交互块 ✗');
		assert.match(tileScriptSeg, /b\.openSession\(id, el\.getAttribute\('data-preset'\)/, '磁贴必须调桥 openSession ✗');
		assert.match(tileScriptSeg, /el\.getAttribute\('data-cwd'\)/, '磁贴必须把 cwd 交上去 ✗');
		assert.match(tileScriptSeg, /lastOpenAt/, '磁贴也必须去抖（双击会发两次 click）✗');
		assert.match(tileScriptSeg, /is-opening/, '磁贴要有受理反馈（点了立刻有反应）✗');
	});
	// ⑥ live 轮询也要 patch 磁贴
	const pollSeg = pageScript.slice(pageScript.indexOf('function pollLive()'), pageScript.indexOf('if (liveApi) {'));
	check('live 轮询必须把磁贴一起打补丁（否则磁贴永远停在打开那一刻）', () => {
		assert.ok(pollSeg.length > 0, '找不到 pollLive ✗');
		assert.match(pollSeg, /patchTile\(tile, s\)/, '轮询必须 patch 磁贴 ✗');
		assert.match(pageScript, /function patchTile\(el, s\)/, '必须有 patchTile ✗');
		assert.match(pollSeg, /\.sv-item\[data-session-id\], \.sv-tile\[data-session-id\]/,
			'轮询的 id 集合必须**包含磁贴**（否则磁贴的 id 根本不会被查）✗');
	});
	// ⑦ 磁贴必须能真的隐藏 + 是网格
	const tileCss = (() => {
		const at = idxSrc.indexOf('const TILE_CSS = `');
		assert.ok(at >= 0, 'lib/index.js 里找不到 TILE_CSS');
		const start = at + 'const TILE_CSS = `'.length;
		return idxSrc.slice(start, idxSrc.indexOf('`;', start));
	})();
	check('磁贴是网格，且必须能真的被 hidden 隐藏（作者 display:flex 会压掉 UA 的 [hidden]）', () => {
		assert.match(tileCss, /\.sv-tiles \{[^}]*display:\s*grid/, '磁贴必须是网格 ✗');
		assert.match(tileCss, /\.sv-tile\[hidden\] \{ display: none; \}/,
			'缺 .sv-tile[hidden] { display: none } ⇒ 搜索过滤在磁贴视图里静默失效 ✗');
	});
	// ⑧ 搜索也要过滤磁贴
	check('搜索必须同时过滤磁贴（否则磁贴视图里搜索静默失效）', () => {
		assert.match(pageScript, /var searchTiles = document\.getElementById\('sv-search'\)/,
			'必须给搜索框加磁贴过滤 ✗');
		// ⚠ 必须**切到搜索那一段**再断言：'.sv-tile[data-session-id]' 在脚本里出现两次
		//   （磁贴打开块 + 搜索块）⇒ 只在全文里找会被另一处顶掉 ⇒ 守卫空跑 ✗。
		const searchTilesSeg = pageScript.slice(
			pageScript.indexOf('var searchTiles = document.getElementById'),
			pageScript.indexOf("var clearPanelEl = document.getElementById('sv-clear-panel')"),
		);
		assert.ok(searchTilesSeg.length > 0, '找不到搜索过滤磁贴的那一段 ✗');
		assert.match(searchTilesSeg, /querySelectorAll\('\.sv-tile\[data-session-id\]'\)/,
			'搜索过滤必须按磁贴的 data-search 走 ✗');
		assert.match(searchTilesSeg, /data-search/, '磁贴过滤必须比对 data-search ✗');
	});
}

fs.rmSync(dshHome, { recursive: true, force: true });
console.log(fail.length ? `\n失败 ${fail.length} 项：${fail.join(' / ')}` : '\n全部通过 ✓');
process.exit(fail.length ? 1 : 0);
