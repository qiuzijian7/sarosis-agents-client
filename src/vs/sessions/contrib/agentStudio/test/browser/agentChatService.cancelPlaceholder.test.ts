/*---------------------------------------------------------------------------------------------
 *  agentChatService.cancelPlaceholder.test.ts — 「取消且无内容」不得静默丢弃（源码级断言）
 *
 *  背景（2026-09-19 用户报「llm 消息丢失」+ 真机日志取证 ✓）：
 *   `vscode-app-1789792320170.log` 同一轮里依次出现
 *     `Stream aborted by user` → `[PartsDiag] DONE partsLen=0 isCanceled=true parts=[]`
 *     → `skip persisting empty assistant turn`（**旧实现：只打一行 info 就不落盘** ✗）
 *     → 同刻服务端 `[SSE-Diag] usage completion_tokens=1119 / usage.credit=27.2` ✗✗
 *   ⇒ 用户"付了费、却连一条痕迹都没有" ⇒ 表现为「消息丢失」✓。
 *
 *  修法（两条不变量，本文件钉住 ✓）：
 *   ① **用户取消 + 无可见内容 ⇒ 必须落一条自解释占位** ✓（内容 + parts + `streamInterrupted` ✓）；
 *   ② **不得再出现静默的 `skip persisting …`（info 级）** ✗ —— 其余"无可见内容"情形改 warn 并带计数 ✓
 *      （工作流工具回合那种**不是取消** ⇒ 仍不落盘 ✓，只是不再静默 ✗）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/agentChatService.cancelPlaceholder.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('取消且无内容 ⇒ 不得静默丢弃（消息丢失回归）', () => {

	const REL = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';

	const readSrc = (): string => {
		const abs = path.join(process.cwd(), REL);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	test('★★★ 用户取消 + 无可见内容 ⇒ 必须落一条自解释占位（不得静默 ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('else if (controller.signal.aborted)'),
			'空回合守卫必须对"用户取消"单独分支（否则又变成静默丢弃 ✗）');
		assert.ok(src.includes('本轮已取消：未收到内容输出'),
			'占位必须有**可读文案**（用户看到的是"本轮已取消"，而不是"消息消失"✓）');
		assert.ok(src.includes('chatMessage.parts = deriveMessageParts('),
			'parts 必须同步派生（UI 优先按 parts 渲染 ⇒ 留空会渲染成空白 ✗）');
		assert.ok(src.includes('chatMessage.metadata = { streamInterrupted: true }'),
			'必须复用既有 `streamInterrupted` 约定（UI 会打「已中断」标记 ✓）');
	});

	test('★★★ 静默的 `skip persisting …`（info 级）不得回归 ✗', () => {
		// ⚠ 必须**先剥注释**再断言 ✓：新代码的注释里**刻意引用**了旧日志行作为取证（"这条曾经是纯静默的"✓），
		//   连注释一起查 ⇒ 必然假红 ✗（2026-09-19 首次运行就踩到，与本仓 CSS 那条同一教训 ✓）。
		const code = readSrc()
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.ok(!code.includes('skip persisting empty assistant turn'),
			'旧文案代表"只打 info 就丢弃" ✗ —— 真机上"付费却没内容"仅靠它可见，等于静默 ✓');
		assert.ok(code.includes('⚠ 未落盘：本轮无可见内容'),
			'其余"无可见内容"情形必须降级为 warn 并带计数 ✓（工作流工具回合仍不落盘 ✓，但不再静默 ✗）');
	});

	test('★★ 取消占位必须带上可核对的计数（deltas / contentLen / parts / elapsedMs ✓）', () => {
		const src = readSrc();
		for (const key of ['deltas=${_deltaCount}', 'contentLen=${fullContent.length}', 'parts=${_streamingParts.length}', 'elapsedMs=']) {
			assert.ok(src.includes(key), `占位日志必须带 ${key}（否则无法判断"内容是否曾到达" ✗）`);
		}
		assert.ok(src.includes('付费但无内容'), '必须显式提示"付费但无内容"这一情形，便于下次一眼定位 ✓');
	});

	test('★★★ 优雅停止（主流做法 ✓）：第一次 Stop 不立即切，边界处才硬中止；第二次立即停 ✓', () => {
		const src = readSrc();
		assert.ok(src.includes('private readonly _gracefulStopRequested'),
			'必须有优雅停止标记集合 ✓');
		// 第一次点：立标记 + 直接 return（不切 ✓）
		assert.ok(src.includes('this._gracefulStopRequested.add(streamKey)') && src.includes('再次点击 = 立即停'),
			'cancelStream 第一次必须先立标记并**立即 return**（否则还是会当场 abort ✗）');
		// 边界处才 abort ✓（且不 break —— 让本条 delta 走完快照 ✓）
		assert.ok(src.includes(`this._gracefulStopRequested.has(streamKey) && (delta as any).type === 'assistant_turn'`),
			'优雅停止必须在 assistant_turn 边界触发中止 ✓（只砍后续 iteration ✓，当前内容保留 ✓）');
		// 生命周期：回合开始 + finalize 都要清理 ✓（防泄漏到下一回合 ✗）
		const clears = src.split('this._gracefulStopRequested.delete(streamKey)').length - 1;
		assert.ok(clears >= 2, `优雅停止标记必须在多处清理（回合开始 + finalize ✓；实际 ${clears} 处 ✗）`);
	});

	test('★★★ 取消时**有内容**也必须打「已中断」标记（否则分不清完整 vs 被截断 ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('controller.signal.aborted || this._gracefulStopRequested.has(streamKey)'),
			'中断标记必须同时覆盖 abort 与优雅停止两种来源 ✓');
		const marks = src.split('streamInterrupted: true').length - 1;
		assert.ok(marks >= 2, `streamInterrupted 至少要在两处设置（中断草稿复用 ✓ + 取消标记 ✓；实际 ${marks} 处 ✗）`);
	});

	test('★★★ UI 必须有"正在停止"可感知反馈（否则用户误以为没反应 ✗）', () => {
		const rel = 'src/vs/sessions/browser/agentChat/agentChatPanel.composer.ts';
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		const src = fs.readFileSync(abs, 'utf8');
		assert.ok(src.includes('_requestCancelExecution()'), '取消必须走统一入口（按钮/Escape ✓）');
		assert.ok(src.includes('_markGracefulStopPending') && src.includes('chat-stopping-circle'),
			'必须有按钮脉冲态 ✓');
		assert.ok(src.includes('chat-footer-stopping'), '必须在处理中指示旁加"正在停止"小条 ✓');
		// 直接调用（绕过统一入口 ✗）只允许出现在**统一入口内部** —— 剥注释后应 ≤1 ✓
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const directCalls = code.split('this._onCancelExecution()').length - 1;
		assert.ok(directCalls <= 1,
			`取消必须统一走 _requestCancelExecution()（直接调用应只剩统一入口内部那 1 处；实际 ${directCalls} ✗）`);
		// CSS 也要有对应样式 ✓
		const css = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/browser/agentChat/media/agentChat.css'), 'utf8');
		assert.ok(css.includes('.chat-stopping-circle') && css.includes('.chat-footer-stopping'),
			'CSS 必须有"正在停止"的两套样式（按钮 + 小条 ✓）');
	});
});

// ─── ★★★ 流式草稿 journal（2026-09-19：「LLM 输出途中 app 被关闭 → 重启后内容全丢」）─────────

/**
 * 用户实测 + 对标开源（Cline 每次消息更新即写盘 / OpenCode 按 part 逐条落盘 / Continue 防抖写会话）：
 * 共性 = **流式内容增量落盘**，崩溃最多丢几秒 ✓。
 * 而本仓旧机制只在 **onWillShutdown**（优雅关闭 ✓）时救一次 ⇒ 崩溃/kill/OOM 时全丢 ✗。
 *
 * 修法（本 suite 钉住的接线不变量 ✓）：
 * ① 流式期间 journal：text delta 后节流 ≥2s 覆盖写小草稿（+ 尾部 1.5s 补一笔 ✓）；
 * ② journal 必须 **quiet**（否则每 2s 一条 info 刷屏 ✗）；
 * ③ loop **正常结束**（成功/失败两路）必须 `clearInterruptedDraft` —— 否则下次 getHistory
 *   把**已落盘的内容**再注入一条「已中断」消息 ✗；
 * ④ 草稿消费链（`_consumeInterruptedDraft` ✓ 既有）不动 ✓。
 */
suite('流式草稿 journal：崩溃保命 + 正常完成清理（2026-09-19）', () => {

	const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const SVC_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';
	const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

	test('★★★ 流式期间必须有 journal（text delta → saveInterruptedDraft，节流 ✓）', () => {
		const src = readSrc(PANE_REL);
		assert.ok(src.includes('_journalStreamingDraft()'), 'text 分支必须挂 journal ✗');
		assert.ok(src.includes('now - this._draftJournalLastAt >= 2000'), '必须有 ≥2s 节流 ✗');
		assert.ok(src.includes("saveInterruptedDraft(agentId, sessionId, text, { quiet: true })"),
			'journal 必须 quiet（每 2s 一笔 info 会刷屏 ✗）');
	});

	test('★★★ loop 正常结束（成功 + 失败两路）必须清草稿（否则重复注入「已中断」✗）', () => {
		const src = readSrc(PANE_REL);
		const clears = src.split('_clearStreamingDraft(sentSessionId)').length - 1;
		assert.ok(clears >= 2, `成功/失败两条收尾路径都要清（实际 ${clears} 处 ✗）`);
		const svc = readSrc(SVC_REL);
		assert.ok(svc.includes('async clearInterruptedDraft('), 'service 必须提供 clearInterruptedDraft ✗');
	});

	test('★★ 草稿仍是「小文件覆盖写 + 消费即删」（不改成重写整个历史 ✗ —— 关闭不被阻塞）', () => {
		const svc = readSrc(SVC_REL);
		assert.ok(svc.includes('.draft.json'), '草稿文件命名不变 ✓');
		assert.ok(svc.includes('await this.fileService.del(uri)'), '消费即删不变 ✓');
	});
});

// ─── ★★★ 草稿消费守卫（2026-09-20：「LLM 回复被拆成两个气泡」真机取证修复）─────────────

/**
 * 取证（sess_mu6wuptt_yywe05 idx 671 + 672-679 ✓）：
 *   气泡1 = `msg_…_interrupted`（`_consumeInterruptedDraft` 注入，79 字纯文本无 parts/toolCalls）；
 *   气泡2 = 同一回合的 per-iteration 落盘组（共享 turnId，`_aggregateTurns` 合并）。
 *   草稿 79 字 == 气泡2 前两条 iteration 文本拼接（逐字相等 ✓）⇒ 草稿是**活流**的 journal。
 *
 * 根因：`_consumeInterruptedDraft` 在任何 getHistory 时**无条件消费**（sendMessage 内部
 * 加载历史 / sessionHistoryView / pane 刷新都会触发），把流式中途的活草稿当崩溃遗物
 * 落盘 ⇒ 重复「已中断」气泡 ✗。次生：回合正常完成后 journal 尾部写与
 * `clearInterruptedDraft` 竞态残留（idx 668/669 相差 66ms ✓）⇒ 滞后重复注入 ✗。
 *
 * 修法（本 suite 钉住 ✓）：
 * ① 消费前活跃流守卫：同 agent+session 有活跃流 ⇒ 跳过（草稿留给真崩溃场景 ✓）；
 * ② 注入前去重：尾部连续 assistant 拼接已含草稿文本 ⇒ 丢弃 ✓；
 * ③ pane 侧草稿写/删串行链 ⇒ clear 恒排在在飞写之后 ✓。
 */
suite('中断草稿消费：活跃流守卫 + 去重 + 写删串行（2026-09-20 双气泡修复）', () => {

	const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const SVC_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';
	const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

	test('★★★ 消费前必须有活跃流守卫（流式中途的 getHistory 不得消费活草稿 ✗）', () => {
		const src = readSrc(SVC_REL);
		assert.ok(src.includes('if (this._isBucketOpen(key))'),
			'getHistory 消费草稿前必须检查活跃流（_isBucketOpen ✓）——否则流式中途的任何 getHistory 都会注入重复 ✗');
		// 守卫必须在消费调用点之前生效（剥注释后比对相对位置 ✓）
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const guardIdx = code.indexOf('if (this._isBucketOpen(key))');
		const consumeIdx = code.indexOf('this._consumeInterruptedDraft(agentId, sessionId)', guardIdx);
		assert.ok(guardIdx !== -1 && consumeIdx !== -1 && consumeIdx > guardIdx,
			'守卫必须包住所跟的消费调用 ✓');
	});

	test('★★★ 注入前必须去重（回合已正常落盘的残留草稿不得再注入 ✗）', () => {
		const src = readSrc(SVC_REL);
		assert.ok(src.includes('_isDraftAlreadyPersisted('),
			'必须有草稿去重判定（尾部 assistant 拼接包含草稿 ⇒ 丢弃 ✓）');
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		assert.ok(code.includes('skipped stale interrupted draft'),
			'去重命中必须留可观测日志 ✓');
		// 去重判定要遍历尾部连续 assistant 段（per-iteration 消息组跨多条 ✓）
		assert.ok(code.includes("if (m.role !== 'assistant') { break; }"),
			'去重必须只取尾部连续 assistant 段（遇到 user 即停 ✓）');
	});

	test('★★★ pane 侧草稿写/删必须串行（clear 不得插在在飞写之前 ✗）', () => {
		const src = readSrc(PANE_REL);
		assert.ok(src.includes('_draftWriteChain') && src.includes('_enqueueDraftOp('),
			'必须有草稿写/删串行链 ✓');
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		// journal 写与 clear 都必须入队（不得再裸 void 调用 ✗）
		assert.ok(code.includes('this._enqueueDraftOp(() => this._chatService.saveInterruptedDraft('),
			'journal 写入必须走串行链 ✗');
		assert.ok(code.includes('this._enqueueDraftOp(() => this._chatService.clearInterruptedDraft('),
			'clear 必须走同一串行链（排在在飞写之后 ✓）');
		const bareSave = code.split('void this._chatService.saveInterruptedDraft').length - 1;
		const bareClear = code.split('void this._chatService.clearInterruptedDraft').length - 1;
		assert.ok(bareSave === 0 && bareClear === 0,
			`不得再有裸 fire-and-forget 调用（save=${bareSave} / clear=${bareClear} ✗）`);
	});
});
