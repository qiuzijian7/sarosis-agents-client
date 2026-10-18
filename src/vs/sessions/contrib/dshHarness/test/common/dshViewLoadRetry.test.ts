/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视图加载重试的**有界性**守卫（2026-10-12 实测事故的回归）。
 *
 * ## 事故
 * dev 实例 main.log 里 `view dsh-chat-w1-… load retry 1/3 in 500ms (HTTP 401)` 连续 **449 条**
 * （18:15:12 → 18:19:05，每 500ms 一条），计数**永远是 1**：401 的错误文档也会走完 `did-finish-load`，
 * 而那里无条件把重试预算清零 ⇒ "3 次有界重试"变成永不停止的循环（每个循环还各发一次
 * `session.cookies.get` + `loadURL`）。用户侧表现为 dsh 聊天页一直空白。
 *
 * ## 为什么有**源码级**守卫
 * bug 的所在是 `dshViewHost.ts` 的**接线**（`did-finish-load` 里无条件复位），而那是 electron-main
 * 文件、单测跑不起来（依赖 electron）。所以：纯逻辑用行为测试钉住，接线用一次精确的源码扫描钉住
 * ——第一次改动这条接线（比如有人把判据去掉）就必须让守卫变红。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { newViewLoadRetryState, onDocumentFinishedLoad, onMainFrameNavigated, planLoadRetry, resetViewLoadRetry, shouldResetRetryBudget, VIEW_LOAD_MAX_RETRIES, withAuthRetry } from '../../common/dshViewLoadRetry.js';

suite('dshHarness / view load retry（有界重试）', () => {

	/** 一轮"导航 + 文档加载完成"（`did-navigate` → `did-finish-load`）。 */
	const navigate = (state: ReturnType<typeof newViewLoadRetryState>, httpResponseCode: number) =>
		onDocumentFinishedLoad(onMainFrameNavigated(state, httpResponseCode));

	// ── 事故本体：401 错误文档不得复位预算 ────────────────────────────────────

	test('★ 回归 2026-10-12：每轮都 401（错误文档也 did-finish-load）时，重试必须恰好 3 次后停手', () => {
		let state = newViewLoadRetryState();
		const attempts: number[] = [];
		const delays: number[] = [];
		// 现场是"停不下来"（449 轮还没停），所以这里给足轮数：一旦无限重试，循环会跑满 50 轮
		for (let i = 0; i < 50; i++) {
			state = onMainFrameNavigated(state, 401);   // 这次导航 401
			state = onDocumentFinishedLoad(state);      // 401 的错误文档照样加载完成
			const plan = planLoadRetry(state, { useAuthUrl: true });
			state = plan.state;
			if (!plan.retry) {
				break;
			}
			attempts.push(plan.attempt);
			delays.push(plan.delayMs);
		}
		assert.deepStrictEqual(attempts, [1, 2, 3], '重试次数必须是 1/2/3 各一次（旧实现永远停在 1，无限循环）');
		assert.deepStrictEqual(delays, [500, 1000, 1500], '退避保持 500/1000/1500ms');
		assert.strictEqual(state.loadFailures, VIEW_LOAD_MAX_RETRIES);
		// 预算耗尽后即使再来 401 也不再重试（不会再产生任何日志/请求）
		const exhausted = planLoadRetry(navigate(state, 401), { useAuthUrl: true });
		assert.strictEqual(exhausted.retry, false, '超限后必须停手（否则就是崩溃/重试循环）');
		assert.strictEqual(exhausted.attempt, VIEW_LOAD_MAX_RETRIES);
	});

	test('★ 401 的加载完成不算成功：shouldResetRetryBudget 为假，且不清零 retriedAuth', () => {
		const state = onDocumentFinishedLoad(onMainFrameNavigated(planLoadRetry(newViewLoadRetryState(), { useAuthUrl: true }).state, 401));
		assert.strictEqual(shouldResetRetryBudget(onMainFrameNavigated(newViewLoadRetryState(), 401)), false);
		assert.strictEqual(state.loadFailures, 1, '预算必须保留');
		assert.strictEqual(state.retriedAuth, true, '已切过 authUrl 的事实不能被抹掉');
	});

	// ── 反向：真成功必须复位，别把"有界"做成"一次就废" ──────────────────────

	test('真成功（200）才复位预算：偶发失败不会被历史失败拖累', () => {
		let state = newViewLoadRetryState();
		state = planLoadRetry(state, {}).state;
		state = planLoadRetry(state, {}).state;
		assert.strictEqual(state.loadFailures, 2);
		state = navigate(state, 200);
		assert.deepStrictEqual(state, { loadFailures: 0, retriedAuth: false, lastNavigationCode: 200 });
		assert.strictEqual(planLoadRetry(state, {}).attempt, 1, '复位后又是完整的 3 次机会');
	});

	test('只有 401 特殊对待：500 等失败页加载完成仍算"加载完成"并复位（保留原有行为）', () => {
		const state = navigate(planLoadRetry(newViewLoadRetryState(), {}).state, 500);
		assert.strictEqual(shouldResetRetryBudget(onMainFrameNavigated(newViewLoadRetryState(), 500)), true);
		assert.strictEqual(state.loadFailures, 0);
	});

	test('状态码拿不到（Electron 给 0，如 about:blank）同样算加载完成，预算不会卡死', () => {
		const state = navigate(planLoadRetry(newViewLoadRetryState(), {}).state, 0);
		assert.strictEqual(state.loadFailures, 0);
	});

	test('没有 did-finish-load 的失败链（did-fail-load / render-process-gone）照样消耗预算', () => {
		let state = newViewLoadRetryState();
		for (let i = 0; i < VIEW_LOAD_MAX_RETRIES; i++) {
			const plan = planLoadRetry(state, { useAuthUrl: true });
			assert.strictEqual(plan.retry, true);
			state = plan.state;
		}
		assert.strictEqual(planLoadRetry(state, { useAuthUrl: true }).retry, false);
	});

	// ── 其它入口 ─────────────────────────────────────────────────────────────

	test('resetViewLoadRetry：手动重载 / 换 Host 后预算回满（用户唯一的自救路径不能失效）', () => {
		let state = newViewLoadRetryState();
		for (let i = 0; i < VIEW_LOAD_MAX_RETRIES; i++) {
			state = planLoadRetry(state, {}).state;
		}
		assert.strictEqual(planLoadRetry(state, {}).retry, false, '先确认已耗尽');
		const reset = resetViewLoadRetry();
		assert.deepStrictEqual(reset, newViewLoadRetryState());
		assert.strictEqual(planLoadRetry(reset, {}).attempt, 1);
	});

	test('withAuthRetry：只切 authUrl，不消耗预算（白屏看门狗那条链不占重试次数）', () => {
		const state = withAuthRetry(newViewLoadRetryState());
		assert.strictEqual(state.retriedAuth, true);
		assert.strictEqual(state.loadFailures, 0);
	});

	test('转移函数不可变：不改动传入的状态对象', () => {
		const before = newViewLoadRetryState();
		planLoadRetry(before, { useAuthUrl: true });
		onMainFrameNavigated(before, 401);
		onDocumentFinishedLoad(before);
		withAuthRetry(before);
		assert.deepStrictEqual(before, { loadFailures: 0, retriedAuth: false, lastNavigationCode: undefined });
	});

	// ── 接线守卫（源码扫描：electron-main 不可单测，但这条接线就是 bug 本体）────

	suite('dshViewHost 接线', () => {
		const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
		const REL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';

		const source = (() => {
			const abs = join(REPO, REL);
			return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
		})();

		test('★ 接线守卫：did-navigate 要记账状态码，did-finish-load 的复位必须由 shouldResetRetryBudget 把关', () => {
			// 取不到源码时**直接失败**（不能空跑通过：守卫一旦静默失效，事故就能再溜回来）
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);

			const navigateAt = source.indexOf("wc.on('did-navigate'");
			assert.ok(navigateAt > 0, "did-navigate 处理器不见了（改名/挪走就要同步改这条守卫）");
			const navigateBlock = source.slice(navigateAt, navigateAt + 700);
			assert.match(navigateBlock, /onMainFrameNavigated\(/, 'did-navigate 必须把这次主 frame 导航的状态码记进 retry 状态（did-finish-load 的判据依赖它）');

			const finishAt = source.indexOf("wc.on('did-finish-load'");
			assert.ok(finishAt > 0, "did-finish-load 处理器不见了（改名/挪走就要同步改这条守卫）");
			const finishBlock = source.slice(finishAt, finishAt + 700);
			assert.match(finishBlock, /shouldResetRetryBudget\(/, 'did-finish-load 的预算复位必须由 shouldResetRetryBudget 把关（无条件复位 = 401 无限重试，2026-10-12 事故）');
		});

		test('★ 接线守卫：重试计数只由 common/dshViewLoadRetry 提供（旧的两个裸字段不得复活）', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /planLoadRetry\(slot\.retry/, '重试必须走 planLoadRetry（有界 + 统一退避）');
			assert.doesNotMatch(source, /slot\.loadFailures/, '旧的裸计数 slot.loadFailures 不得复活（有界性判据在 common/dshViewLoadRetry）');
			assert.doesNotMatch(source, /slot\.retriedAuth/, '旧的裸标记 slot.retriedAuth 不得复活（已收进 retry 状态）');
		});

		test('★ 接线守卫：推送快照必须在 did-finish-load 补发（否则页面永远收不到 worktree 列表）', () => {
			// 2026-10-13 用户报"没有显示 worktree ui"：渲染进程在 `createView().then()` 里**立刻**推，
			// 而那一刻页面刚开始加载、preload 的 `ipcRenderer.on` 还没注册 ⇒ 这条 send 被静默丢弃 ✗
			// ⇒ 页面 `dataset.vssarosWorktrees` 恒空 ⇒ chip 按设计 `return null`（UI 不出现，
			// 且日志里零痕迹：成功不打、失败走 trace）⇒ 报障时只能靠猜 ✗✗。
			// 修法 = 主进程留快照 + 页面就绪（did-finish-load）时补发；这三处缺一处就退回原状。
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /slot\.lastWorktrees = options;/, 'pushWorktrees 必须**先留快照**（页面未就绪时 send 会被丢弃）');
			assert.match(source, /slot\.lastThemeTokens = tokens;/, 'pushTheme 同理：留快照，供页面就绪后补发');
			assert.match(source, /this\._replayPushedSnapshots\(slot\);/, 'did-finish-load 必须调用补发');
			const replayAt = source.indexOf('private _replayPushedSnapshots(');
			assert.ok(replayAt > 0, '补发实现不见了（改名/挪走就要同步改这条守卫）');
			assert.match(source.slice(replayAt, replayAt + 1400), /wc\.send\(DSH_PAGE_IPC_WORKTREES, slot\.lastWorktrees\)/,
				'补发必须真的把 worktree 列表发出去（只留快照不发 = 还是空 UI）');
		});

		test('★ 接线守卫：页面就绪后要自证"页面侧渲染出什么"（否则永远只知道"我们发出去了"）', () => {
			// 2026-10-13 复盘"没有显示 worktree ui"：`replayed N worktree option(s)` 只证明主进程**发出去了**，
			// 从"发出"到"用户看得见"还隔着两层（preload 写 dataset → 页面按 list.length===0 决定是否渲染），
			// 而这两层在日志里**零痕迹** ⇒ 只能靠猜 ✗。这条钉住"就绪后跑一次 PAGE_SURFACE_REPORT"这条接线。
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.match(source, /const PAGE_SURFACE_REPORT = /, '页面侧自证探针不见了');
			// ★ 2026-10-15：两枚 chip 合并为单枚入口（`vssaros-context-entry`，方案 C）⇒ 自证改认新标记 ✓
			assert.match(source, /contextChip: !!document\.querySelector\("\[data-vssaros-context-chip\]"\)/,
				'探针必须读**真实 DOM**里有没有那枚合并入口（只报"数据到了"仍然分不清是哪一层坏；'
				+ '认旧的两个标记会永远 false ⇒ 假告警 ✗）');
			// ★ 2026-10-16（方案 A：hero 里"借官方触发器"）：hero（空白会话屏）那一行**没有我们自己的 chip**
			//   —— 官方 WorkspaceChip 写死在 heroWorkspaceRow 里（走不了 slot），我们的面板挂它的**浮层槽**上
			//   ⇒ 只认 contextChip 会把空白会话屏读成"我们的入口没出来"（假告警 ✗）⇒ 必须另认 hero 壳标记 ✓。
			assert.match(source, /contextHeroEntry: !!document\.querySelector\("\[data-vssaros-context-hero\]"\)/,
				'hero 壳标记必须进自证（否则空白会话屏永远报"入口没出来"的假告警 ✗）');
			assert.match(source, /void this\._reportPageSurface\(slot, PAGE_SURFACE_REPORT_DELAY_MS\);/,
				'did-finish-load 必须触发这次自证（不触发 = 这层可见性又没了）');
			// ★ 2026-10-15：两枚 chip 合并后，这句 warn 的文案也跟着改了（"chip" → "合并入口"）✓
			//   ⚠ 文案变动必须同步守卫 —— 我上一轮改了产品文案却没更新这条，它就一直红着 ✗
			assert.match(source, /worktree 数据已到页面但合并入口未渲染/,
				'"数据到了却没渲染"必须升为 warn —— 这才是用户报 UI 没出来时唯一要看的信号');
		});

		test('★ 接线守卫：卡片动作（定位 / 看改动 / 在终端打开）的页面侧结果必须进自证', () => {
			// 2026-10-13 用户报「点定位报 No explorer view available」「点条目没有 diff」：页面侧本来
			// 就记着计数与最近失败原因（`client.cardActions.js` 的 state.reveals / diffsOpened /
			// lastDiffPath / terminalsOpened / cardActionError），但**从前只在页面 state 里** ✗
			// ⇒ 连"点击到没到页面"都答不出。这里钉住"自证探针必须把这些一起读出来"＋"失败要升 warn"。
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			for (const field of ['reveals:', 'lastRevealed:', 'diffsOpened:', 'lastDiffPath:', 'terminalsOpened:', 'cardActionError:']) {
				assert.ok(source.includes(field), `自证快照缺少 ${field}（少了它就又回到"点了没反应只能猜"✗）`);
			}
			// ★ 2026-10-13 加：agent chip 那一路（用户报"人格读取失败 + chip 只在选中过 agent 后才显示"时，
			//   快照里**一个字段都没有** ⇒ 只能回头去读页面 state 或猜 ✗）
			for (const field of ['agentChip: !!document.querySelector("[data-vssaros-agent-chip]")', 'agentChipSource:', 'agentChipLabel:', 'agentPreset:', 'personaProbeError:']) {
				assert.ok(source.includes(field), `自证快照缺少 ${field}（agent chip 为什么没出来又要靠猜 ✗）`);
			}
			assert.match(source, /const cardErr = \/"cardActionError":"/,
				'必须从快照里取 cardActionError 才能判定"页面侧失败"');
			assert.match(source, /卡片动作在页面侧失败: \$\{cardErr\[1\]\}/,
				'页面侧失败必须升为 warn 并带上原因（只弹通知不进日志 = 排查时看不到 ✗）');
			// ★ 一次性探针采不到"用户几分钟后才点的按钮"✗ ⇒ 必须续期轮询；而轮询要**变化才记**才不吵
			assert.match(source, /lastSurfaceReport\?: string;/, '槽位要存最近一次快照原文（用于比对变化）');
			assert.match(source, /slot\.lastSurfaceReport !== text/, '只在快照变化时写日志（否则 15 秒一轮会刷屏 ✗）');
			assert.match(source, /PAGE_SURFACE_REPORT_INTERVAL_MS/, '探针必须续期轮询（跑一次 = 采不到真实点击 ✗）');
			// ★ 2026-10-15：**客户端连接抖动**要记账（用户报"初次启动该页面卡了一段时间才加载出 session"）。
			//   实测那段的全部来源就是它：页面 `ready+3.9s` 已加载完 ✓、`ready+7.9s` 连我们的入口 chip 都在 ✓，
			//   而 dsh 客户端连接**阶梯重连 7 次直到 `ready+32.4s`**（退避 1/2/3/6/9/15s ✗）。
			//   记账后"首启卡多久"是一行日志；不记账就只能像这次一样从三条间接证据反推 ✗。
			assert.match(source, /connChurn\?: \{ count: number; firstAt: number; lastAt: number; lastRetry: number; timer\?:/,
				'槽位要有连接抖动记账位（含静默收口定时器 ✓；否则只剩 7 条散行 retry #N，看不出"卡了多久" ✗）');
			// ★ 2026-10-15（判据修正）：第一版用"自证快照能刷新"当链路稳定 ⇒ 实测在抖动未停时就早报
			//   ✗（快照走主进程→渲染进程的 executeJavaScript，与页面↔Host 的客户端连接是**两条通道** ✗）。
			//   现改为**静默 N 秒才收口**（每次抖动重翔定时器）⇒ 这几条把它钉死 ✓。
			assert.match(source, /CONN_CHURN_QUIET_MS/, '必须有静默判稳窗口（没有它 ⇒ 又回到"快照刷新就当稳定"的错判据 ✗）');
			assert.match(source, /clearTimeout\(c\.timer\)/, '每次抖动必须重翔定时器（不重翔 ⇒ 抖动中途就报"已稳定" ✗）');
			// ★ 2026-10-15（用户报"聊天框 copy 按钮点击没反应"）：CDP 实测根因 = 独立 partition 权限默认
			//   全拒 ⇒ `writeText` NotAllowedError + `execCommand('copy')` 返回 false +
			//   `permissions.query('clipboard-write')="denied"` ✗✓（我们的皮没吞点击：click path 全在
			//   dsh DOM ✓）⇒ 必须放行剪贴板写，且两个名字（Chromium 新/旧）都要 ✓。
			assert.match(source, /'clipboard-sanitized-write'/, 'dsh 视图 partition 必须放行剪贴板写（否则官方复制按钮永远静默失败 ✗）');
			assert.match(source, /'clipboard-write'/, 'Chromium 新旧两个权限名都要放行（只放一个 ⇒ 另一路仍拒 ✗）');
			assert.match(source, /startsWith\(this\._connection\.origin\)/,
				'放行必须限定我们自己的 dsh Host（环回 origin）—— 不能对所有页面放开剪贴板写 ✗');
			// ★ 2026-10-15（用户报"积分 chip 一直 —"）：页面侧样本池是 chunk 级的**活推送**数组，
			//   页面重载即清零 ✗ ⇒ 主进程必须在视图就绪后回放最近样本，且每次导航只回放一次
			//   （重复回放 ⇒ 按时间窗求和会重复计 ✗）。
			assert.match(source, /setCreditReplaySource/, '必须支持注入计费样本回放源（否则重载后历史回合永远"积分 —" ✗）');
			assert.match(source, /creditsReplayedAt/, '回放必须按"每次导航一次"记账（少了复位 ⇒ 只回放第一次 ✗）');
			// ⚠ 用 includes 而不是正则：`[connection]` 在正则里是**字符类**（会被当成"c/o/n/…任一字符"✗），
			//   而源码里那段是**正则字面量文本**（`retry #(\d+)`）⇒ 正则套正则要双重转义，极易写错 ✗
			//   （我第一版就写错了，守卫当场红 ✓）。逐字片段用 includes 最稳 ✓。
			assert.ok(source.includes('connection lost, retry #('),
				'必须识别 dsh 那句连接丢失并取到 retry 序号（识别不到 ⇒ 记账永远为空 ✗）');
			assert.match(source, /距首次已 \$\{secs\}s/,
				'抖动行必须带"距首次多久"（只报次数看不出卡多久 ✗）');
			assert.match(source, /客户端连接已稳定：共抖动/,
				'链路稳定后要收口成一行小结（否则"卡了多久"永远算不出来 ✗）');
			assert.match(source, /connChurnReported = true/,
				'小结只能打一次（每 15 秒一轮都打 = 把日志淹掉 ✗；这正是用户抱怨过的"同义行埋掉"✗）');
			// ★ 2026-10-14：自证快照必须报"页面**实际加载**了哪几个我们的 chunk"。
			//   当时用户问"chat-surface 是不是缺少子智能体/任务列表那两块 UI 的插件"，而页面上一块都没有 ——
			//   我花了三轮才靠"state 字段形状 + 已装目录名"反推出"跑的是 0.2.66、源码已经 0.2.68" ✗。
			//   这一条把那个推断变成**一眼可读** ✓；⚠ 必须做在**宿主侧**：插件旧的时候它自己报不出东西，
			//   把标记写进插件 = 盲区闭环 ✗。
			assert.match(source, /ourChunks: \(function \(\) \{/,
				'自证快照必须含"页面实际加载的 chunk 清单"（少了它就只能靠字段形状反推跑了哪一版 ✗）');
			assert.ok(source.includes('n.indexOf("/@vssaros/dsh-chat-surface/") < 0'),
				'必须按**真实请求路径**筛我们的 chunk（实测形态 /plugins/@vssaros/dsh-chat-surface/<file>?rev=…）；'
				+ '不筛就会把 dsh 自己那几十个 client-ui-* 一起列进来 ⇒ 等于没答 ✗');
		});

		test('★ 行为守卫：自证探针**真的跑一遍**（字段名/语法坏掉时它会红，而不是静默返回半截）', () => {
			// 为什么不能只做正则断言：这段探针是**模板字符串里的 JS**，写错字段名/少个括号都不会被
			// tsgo 发现（它在字符串里 ✗）⇒ 只有真跑一次才知道它还认不认这些字段。
			// 用假 window/document 执行它，断几个关键字段 ✓（本次改动的 4 个动作都在里面）。
			const m = /const PAGE_SURFACE_REPORT = `([\s\S]*?)`;/.exec(source);
			assert.ok(m, 'PAGE_SURFACE_REPORT 模板不见了');
			const probe = m[1];
			// 这段是模板字符串 ⇒ 里面**绝不能有反引号**（会提前闭合 ⇒ 整个文件语法错；已踩过两次 ✗）
			assert.ok(!probe.includes('\u0060'), 'PAGE_SURFACE_REPORT 模板里不得出现反引号');
			const fakeWindow = {
				__vssarosChatSurface: {
					opened: true, sessionId: 'sess-1', cardActions: true,
					reveals: 1, lastRevealed: 'G:\\ws\\a.ts',
					diffsOpened: 2, lastDiffPath: 'G:\\ws\\b.ts', terminalsOpened: 3,
				},
			};
			const fakeDocument = {
				documentElement: { dataset: { vssarosWorktrees: '[{"path":"G:\\\\ws\\\\a"}]' } },
				// ⚠ 刻意**按选择器区分**（只塞 chip 那个标记）：两个标记若都返回同一个对象，
				//   下面那条 `contextHeroEntry === false` 就成了**假守卫** ✗（它得真读自己的标记 ✓）。
				querySelector: (sel: string) => sel.indexOf('data-vssaros-context-chip') >= 0 ? {} : null,
			};
			// ★ 2026-10-14：页面已发出的请求（真实形态）⇒ 只留我们的 chunk，且去重/排序 ✓
			const fakePerformance = {
				getEntriesByType: (kind: string) => kind === 'resource' ? [
					{ name: 'http://127.0.0.1:1531/plugins/@vssaros/dsh-chat-surface/client.hero.js?rev=555c9a99186d' },
					{ name: 'http://127.0.0.1:1531/plugins/@vssaros/dsh-chat-surface/client.todos.js?rev=555c9a99186d' },
					// 同一个 chunk 被请求两次（热重载 / 二次挂载）⇒ 不许出两条 ✓
					{ name: 'http://127.0.0.1:1531/plugins/@vssaros/dsh-chat-surface/client.hero.js?rev=555c9a99186d' },
					// dsh 自己的包名里**不含**我们的 scope ⇒ 必须被排除（不排除就等于没答 ✗）
					{ name: 'http://127.0.0.1:1531/plugins/@deepseek-ai/dsh-client-ui-chat/client.js?rev=555c9a99186d' },
					{ name: 'http://127.0.0.1:1531/plugins/@vssaros/dsh-chat-surface/client.agents.js' },
				] : [],
			};
			const text = String(new Function('window', 'document', 'performance', `return ${probe}`)(fakeWindow, fakeDocument, fakePerformance));
			const parsed = JSON.parse(text) as Record<string, unknown>;
			assert.deepStrictEqual(parsed.ourChunks, ['client.agents.js', 'client.hero.js', 'client.todos.js'],
				'必须报出"页面实际加载了哪几个我们的 chunk"（只留我们的 scope ✓ / 去重 ✓ / 排序 ✓）；'
				+ '这条就是"插件改了却没生效"的一眼判据 —— 少了 client.todos.js 就说明装的是旧插件 ✓');
			// 拿不到资源计时（老环境）时**不许把整条探针搞崩** —— 崩了 ⇒ 15 秒一轮的自证全变
			// "report failed: …" ⇒ 等于把这一层观测整片搞瞎 ✗（返回值形态要稳定）。
			const degraded = String(new Function('window', 'document', `return ${probe}`)(fakeWindow, fakeDocument));
			assert.ok(Array.isArray((JSON.parse(degraded) as Record<string, unknown>).ourChunks),
				'没有 performance 计时数据时该字段必须仍是数组（或 null），不许整条探针抛错 ✗');
			assert.strictEqual(parsed.diffsOpened, 2, '看改动计数必须读得出来');
			assert.strictEqual(parsed.lastDiffPath, 'G:\\ws\\b.ts', '最近一次 diff 路径必须读得出来');
			assert.strictEqual(parsed.reveals, 1, '定位计数必须读得出来');
			assert.strictEqual(parsed.terminalsOpened, 3, '终端计数必须读得出来');
			assert.strictEqual(parsed.cardActionError, null, '没有失败时必须是 null（不是 undefined ✗）');
			assert.strictEqual(parsed.worktreeItems, 1, 'worktree 负载条数仍要能数');
			// ★ 2026-10-15：两枚 chip 合并成单枚入口 ⇒ 探针字段随之改名（`worktreeChip` → `contextChip`）✓
			assert.strictEqual(parsed.contextChip, true, '合并入口的存在性仍要能判（改名了，别守着旧字段 ✗）');
			// ★ 2026-10-16（方案 A）：hero 壳标记要能**单独**判 —— 这一屏没有我们自己的 chip，
			//   两个字段各读各的标记（fakeDocument 只塞了 chip 那个 ⇒ 这里必须是 false ✓）。
			assert.strictEqual(parsed.contextHeroEntry, false,
				'hero 壳标记必须独立可判（与 contextChip 同值就说明它没读自己的标记 ⇒ 假守卫 ✗）');
		});
	});
});
