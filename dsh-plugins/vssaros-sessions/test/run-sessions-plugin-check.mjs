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

const ROOT = path.resolve(import.meta.dirname, '../lib');
const { readSessionCaches, projCacheDirOf, dshHomeOf } = await import(new URL('file:///' + path.join(ROOT, 'store.js').replace(/\\/g, '/')).href);
const core = await import(new URL('file:///' + path.join(ROOT, 'core/sessionList.js').replace(/\\/g, '/')).href);
const shell = await import(new URL('file:///' + path.join(ROOT, 'pageShell.js').replace(/\\/g, '/')).href);

const fail = [];
const check = (label, fn) => { try { fn(); console.log(`  ✔ ${label}`); } catch (e) { fail.push(label); console.log(`  ✗ ${label}：${e.message}`); } };

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
const groups = core.buildSessionGroups(scan.sessions);
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

console.log('── C2. 按 Bot 分组（2026-10-12 用户要求：两种分组方式）──');
const botGroups = core.buildSessionGroups(scan.sessions, { by: 'bot' });
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
	const groups = core.buildSessionGroups(scan.sessions, { by: 'bot' });
	const named = core.applyPresetNames(groups, 'bot', names);
	assert.equal(named[0].title, '标准助手');
	assert.equal(named[0].path, 'vssaros-saros', '真身（preset id）不藏');
	assert.deepEqual(named.slice(1).map(g => g.title), groups.slice(1).map(g => g.title), '查不到的组保持原样');
	assert.equal(core.applyPresetNames(groups, 'workspace', names)[0].title, groups[0].title, '工作区分组不受影响');
	assert.equal(core.applyPresetNames(groups, 'bot', new Map())[0].title, groups[0].title, '空花名册 ⇒ 原样（回落 id）');
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

fs.rmSync(dshHome, { recursive: true, force: true });
console.log(fail.length ? `\n失败 ${fail.length} 项：${fail.join(' / ')}` : '\n全部通过 ✓');
process.exit(fail.length ? 1 : 0);
