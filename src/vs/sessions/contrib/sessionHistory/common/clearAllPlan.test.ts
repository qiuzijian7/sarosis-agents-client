/*---------------------------------------------------------------------------------------------
 *  「清空所有会话」行为网 —— 范围判据 + 视图侧契约（CSS / 入口 / 确认门控）
 *
 *  背景（2026-10-19，用户要求"会话 sideview 增加清空所有会话"，mockup 选定稿 A + C）：
 *  这是侧栏里唯一一个**破坏性且批量**的动作 ⇒ "到底会删掉哪几条"必须由单测钉住，
 *  而不是埋在视图方法里靠肉眼看。判据在 `clearAllPlan.ts`（纯函数），本文件测它；
 *  视图里那几条**结构性**要求（入口在、样式在、确认词门控在）用源码契约补。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { planClearAll, type IClearAllSessionLike } from './clearAllPlan.js';

// ⚠ 相对**仓库根**（runner 从仓库根跑 ⇒ 相对本文件的 `../browser/...` 会找不到 ✗）
const VIEW_REL = 'src/vs/sessions/contrib/sessionHistory/browser/sessionHistoryView.ts';
const CSS_REL = 'src/vs/sessions/contrib/sessionHistory/browser/media/sessionHistoryView.css';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 会话取样：a/b 两个 agent，含运行中 / 已固定 / 打开中三种"不该随便删"的状态。 */
const A_IDLE: IClearAllSessionLike = { agentId: 'a', sessionId: 'a-idle' };
const A_RUN: IClearAllSessionLike = { agentId: 'a', sessionId: 'a-run' };
const A_PIN: IClearAllSessionLike = { agentId: 'a', sessionId: 'a-pin', pinned: true };
const A_OPEN: IClearAllSessionLike = { agentId: 'a', sessionId: 'a-open', chatOpen: true };
const B_IDLE: IClearAllSessionLike = { agentId: 'b', sessionId: 'b-idle' };
const ALL = [A_IDLE, A_RUN, A_PIN, A_OPEN, B_IDLE];

const noneActive = () => false;
const runActive = (s: IClearAllSessionLike) => s.sessionId === 'a-run';

suite('清空所有会话 · 范围判据（clearAllPlan）', () => {

	test('默认：只删"空闲且未固定且没打开"的；三类跳过各计一次', () => {
		const p = planClearAll({ sessions: ALL, agentFilter: '', skipRunning: true, skipPinned: true, isActive: runActive });
		assert.deepStrictEqual(p.targets.map(s => s.sessionId), ['a-idle', 'b-idle'], '空闲的两条才进目标 ✓');
		assert.strictEqual(p.skippedRunning, 1, '运行中的那条被跳过 ✓');
		assert.strictEqual(p.skippedPinned, 1, '已固定的那条被跳过 ✓');
		assert.strictEqual(p.skippedOpen, 1, '打开中的那条被跳过 ✓');
	});

	test('★ 打开中的会话**永远**跳过（连开关都没有）：删掉会让聊天区指着已不存在的会话 ✗', () => {
		for (const skipRunning of [true, false]) {
			for (const skipPinned of [true, false]) {
				const p = planClearAll({ sessions: ALL, agentFilter: '', skipRunning, skipPinned, isActive: runActive });
				assert.ok(!p.targets.some(s => s.sessionId === 'a-open'),
					`skipRunning=${skipRunning} skipPinned=${skipPinned}：打开中的那条不许进目标 ✗`);
				assert.strictEqual(p.skippedOpen, 1, '始终单独计数（面板要如实写出"保留了几个" ✓）');
			}
		}
	});

	test('★ 范围只认 agent 筛选（搜索词不参与 ⇒ "清空所有"不会变成"清空搜索结果" ✗）', () => {
		const p = planClearAll({ sessions: ALL, agentFilter: 'b', skipRunning: true, skipPinned: true, isActive: runActive });
		assert.deepStrictEqual(p.targets.map(s => s.sessionId), ['b-idle'], '只这一条属于 agent b ✓');
		const q = planClearAll({ sessions: ALL, agentFilter: '', skipRunning: true, skipPinned: true, isActive: runActive });
		assert.strictEqual(q.targets.length, 2, 'All Agents ⇒ 两个 agent 都算 ✓');
	});

	test('关掉"跳过运行中" ⇒ 运行中的那条进目标（开关必须真的管用）', () => {
		const p = planClearAll({ sessions: ALL, agentFilter: '', skipRunning: false, skipPinned: true, isActive: runActive });
		assert.ok(p.targets.some(s => s.sessionId === 'a-run'), '关掉开关就该纳入 ✓');
		assert.strictEqual(p.skippedRunning, 0);
		assert.strictEqual(p.runningCount, 1, '★ 面板上的数字仍是**总数**（不随勾选跳变 ✓）');
	});

	test('关掉"保留已固定" ⇒ 已固定那条进目标，且 pinnedCount 仍是总数', () => {
		const p = planClearAll({ sessions: ALL, agentFilter: '', skipRunning: true, skipPinned: false, isActive: runActive });
		assert.ok(p.targets.some(s => s.sessionId === 'a-pin'), '关掉开关就该纳入 ✓');
		assert.strictEqual(p.skippedPinned, 0);
		assert.strictEqual(p.pinnedCount, 1, '面板数字不随勾选跳变 ✓');
	});

	test('★ 一个会话同时命中多类时**只计一次**（运行中 + 已固定 ⇒ 只算运行中）', () => {
		const both: IClearAllSessionLike = { agentId: 'a', sessionId: 'both', pinned: true };
		const p = planClearAll({
			sessions: [both], agentFilter: '', skipRunning: true, skipPinned: true, isActive: () => true,
		});
		assert.deepStrictEqual(p.targets, [], '不该进目标 ✓');
		assert.strictEqual(p.skippedRunning, 1);
		assert.strictEqual(p.skippedPinned, 0, '已经算在运行中里了 ⇒ 不许再算一次（否则面板数字会比总数还大 ✗）');
		assert.strictEqual(p.runningCount, 1);
		assert.strictEqual(p.pinnedCount, 1, '总数照旧 ✓');
	});

	test('空列表 ⇒ 目标为空、各类计数为 0（面板按钮要 disabled ✓）', () => {
		const p = planClearAll({ sessions: [], agentFilter: '', skipRunning: true, skipPinned: true, isActive: noneActive });
		assert.deepStrictEqual(p.targets, []);
		assert.strictEqual(p.skippedRunning + p.skippedPinned + p.skippedOpen, 0);
	});

	test('没有会话处于运行中 ⇒ 两处计数都是 0（不许写死数字 ✗）', () => {
		const p = planClearAll({ sessions: ALL, agentFilter: '', skipRunning: true, skipPinned: true, isActive: noneActive });
		assert.strictEqual(p.runningCount, 0);
		assert.strictEqual(p.skippedRunning, 0);
		assert.ok(p.targets.some(s => s.sessionId === 'a-run'), '没在跑 ⇒ 它就是普通一条 ✓');
	});
});

suite('清空所有会话 · 视图侧契约（源码级）', () => {

	test('★ 判据走 `planClearAll`（不许在视图里另写一套 ⇒ 两份判据会各自漂移 ✗）', () => {
		const view = read(VIEW_REL);
		assert.ok(view.includes("from '../common/clearAllPlan.js'"), '视图必须 import 那份纯逻辑');
		assert.ok(view.includes('planClearAll({'), '视图的范围计算必须调它');
	});

	test('★ 真删走既有 `deleteAgentSession`（不另起一条删除链 ⇒ 两边语义会分叉 ✗）', () => {
		const view = read(VIEW_REL);
		const at = view.indexOf('private async _runClearAll');
		assert.ok(at > 0, '清空的执行方法必须在 ✓');
		const body = view.slice(at, at + 1600);       // 只看这段：别被文件后面无关的同名调用蒙过去 ✓
		assert.ok(body.includes('deleteAgentSession'), '清空必须逐条走 `deleteAgentSession` ✓');
		assert.ok(body.includes('_clearBusy'), '必须有防重入（进度期间再点一次会叠两次删除 ✗）');
	});

	test('★ 强确认：按钮初始 disabled，且门控是**输入确认词**（不是只看一眼就敢删）', () => {
		const view = read(VIEW_REL);
		assert.ok(/goBtn\.disabled = true/.test(view), '初始必须禁用 ✓');
		assert.ok(/goBtn\.disabled = input\.value\.trim\(\) !== localize\('clearAll\.confirmWord'/.test(view),
			'必须手打「清空」两个字才启用 ✓');
	});

	test('两个入口都在（稿 A 的 `···` + 稿 C 的空白右键），且共用同一枚菜单', () => {
		const view = read(VIEW_REL);
		assert.ok(view.includes('session-history-more-btn'), '稿 A：`+ New session` 行右端的 `···` 必须在');
		assert.ok(view.includes('_showMoreMenu(e as MouseEvent)'), '稿 A：点击要出菜单');
		assert.ok(/CONTEXT_MENU[\s\S]{0,300}?_showMoreMenu/.test(view), '稿 C：列表空白右键要出**同一枚**菜单 ✓');
		assert.ok(/closest\('\.session-history-item'\)\s*\{\s*return;/s.test(view) || view.includes("closest('.session-history-item')) { return; }"),
			'稿 C：条目上的右键仍归既有那条菜单 ✗ 不许抢');
	});

	test('★ dsh 会话改名**走 dsh**：绝不写 IDE 的 chat-history 索引（写了等于改名了个寂寞 ✗）', () => {
		const view = read(VIEW_REL);
		const at = view.indexOf('private _startRenameSession(');
		assert.ok(at > 0, '要能定位到改名实现');
		const body = view.slice(at, at + 4000);
		assert.ok(body.includes('renameDshSession'), '必须调 `renameDshSession`（页面 ctx.sessions.rename）✗');
		// ★ 判别力：上面那条 `includes` 在"分支被 `false &&` 禁掉"时**依然为真**（假绿 ✗）。
		//   ⇒ 必须再钉一条**精确**的：分支就是 `if (info.dshSession) {`，不许带任何禁用前缀。
		assert.ok(/if \(info\.dshSession\) \{/.test(body),
			'dsh 分支必须真的生效（写成 `if (false && info.dshSession)` 等于没接 ✗）');
		assert.ok(!/if \(false && info\.dshSession\)/.test(body), '不许把 dsh 分支禁用 ✗');
		// 关键负向：IDE 那条只能出现在 dsh 分支**之后**（早退后的正常路径）
		const dshAt = body.indexOf('renameDshSession');
		const ideAt = body.indexOf('renameAgentSession');
		assert.ok(ideAt > dshAt, 'dsh 分支必须先于 IDE 那条并 return（否则 dsh 会话会被写进 IDE 索引 ✗）');
	});

	test('★ dsh 引擎下**新建**走 dsh（开聊天页签 + preset），绝不建 IDE 会话（否则又变成两套 ✗）', () => {
		const view = read(VIEW_REL);
		const at = view.indexOf('private async _confirmNewSession(');
		assert.ok(at > 0, '要能定位到新建实现');
		const body = view.slice(at, at + 2600);
		// ★ 判别力：写成 `if (false && …)` 时 `includes` 仍为真 ⇒ 必须匹配**生效的**分支文本
		assert.ok(/if \(this\.configurationService\.getValue<string>\('sessions\.dshHarness\.chatEngine'\) === 'dsh'\) \{/.test(body),
			'必须有**生效的** dsh 引擎分支（禁用掉就等于没接 ✗）');
		assert.ok(body.includes('agentStudio.newChatInEditor'), 'dsh 会话由宿主起 ⇒ 这里开聊天页签 ✗');
		assert.ok(body.includes('agentPresetIdOf'), 'preset 必须走与 dsh 插件**同规则**的派生（否则落到不存在的 preset ⇒ 用户选的 agent 白选 ✗）');
	});

	test('★ 改名按钮/菜单项：dsh 会话有「重命名」，但**没有**「删除」（dsh 侧无删除 API）', () => {
		const view = read(VIEW_REL);
		// 行内按钮：重命名不再被 `if (!info.dshSession)` 包住；删除仍然被包住
		assert.ok(!/if \(!info\.dshSession\) \{[\s\S]{0,600}?session-history-rename-btn/.test(view),
			'重命名按钮不该再对 dsh 会话隐藏（它能走 dsh 真源 ✓）');
		assert.ok(/if \(!info\.dshSession\) \{[\s\S]{0,900}?session-history-delete-btn/.test(view),
			'删除按钮仍须对 dsh 会话隐藏（没有删除 API ⇒ 假入口 ✗）');
		assert.ok(/isDsh \? \[\] : \[[\s\S]{0,400}?sessionHistory\.delete/.test(view),
			'右键菜单的删除项仍须对 dsh 会话隐藏 ✗');
	});

	// 2026-10-19 下午：重命名**已对 dsh 会话开放**（走 `renameDshSession` ⇒ 真落在 dsh 侧），
	// 上面那两条因此拆开：改名断言"走 dsh 不写 IDE 索引"，删除仍断言"不给入口"。

	test('CSS：新增的类都真的有定义（改了 TS 忘 CSS ⇒ 面板裸奔 ✗）', () => {
		const view = read(VIEW_REL);
		const css = read(CSS_REL);
		const classes = Array.from(new Set(Array.from(view.matchAll(/session-history-clear-[a-z-]+|session-history-more-btn|session-history-new-row/g)).map(m => m[0])));
		assert.ok(classes.length >= 8, `应当收集到一批新类（实际 ${classes.length}）`);
		for (const c of classes) {
			assert.ok(css.includes('.' + c), `CSS 缺少 .${c} 的定义 ✗`);
		}
	});
});
