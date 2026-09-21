/*---------------------------------------------------------------------------------------------
 *  subAgentTraceOwnership.test.ts — 子代理旁路总线的**归属过滤 + 兜底挂载**（2026-09-21）
 *
 *  真机取证（`~/.vssaros-dev/logs/20260921T121630/window1/renderer.log`）：
 *    · 同窗口两个面板：pane#1 = sess_mu97itly_x099ee（流式中，本回合调了 delegate_task）；
 *      pane#2 = sess_mu6wuptt_yywe05（自 12:17 空闲）。
 *    · `[fireSubAgentTrace] ... parentToolCallIds=[delegate_task_2_12b0a566]` 之后紧跟
 *      `WARN [SubAgentCard] trace dropped: 无流式 assistant 消息（count=1）` ×16，
 *      而 upsert=32 全部 `attached=1`（0 个"只丢不挂"组）⇒ 丢弃全部来自**旁观面板**。
 *
 *  根因：`onDidSubAgentTrace` 是**全局**总线（每个 pane 都订阅），而
 *  `ISubAgentTraceSnapshot` 原先**只有 groupId + subagentData**、不带归属 ⇒
 *    ① 非流式面板必然丢弃却打 WARN（噪声）；
 *    ② **更危险**：双会话并行流式时，pane#B 会把 pane#A 的快照 `updateMessage(asstId, {subAgents})`
 *       挂进自己的会话（跨会话错挂 ✗）。
 *
 *  修法（本文件钉住 ✓）：
 *    A. 快照加 `agentId`/`sessionId`（父回合身份），三个生产者（delegationTools / planExploreTool）填充；
 *       pane 订阅处非本会话 ⇒ **静默**丢弃（trace 级）。
 *    C. 本会话但无流式消息 ⇒ 兜底挂到「历史里含该父工具卡的最后一条 assistant 消息」；
 *       找不到父卡即放弃（自校验，不猜测 ✗）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/subAgentTraceOwnership.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('子代理 trace 归属过滤 + 兜底挂载', () => {

	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	/** 剥注释后再断言：本仓注释会刻意引用旧写法/旧日志作取证，连注释查会假红 ✓ */
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	const AGENT_OS = 'src/vs/sessions/contrib/agentStudio/common/agentOS.ts';
	const PANE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const DELEGATION = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/delegationTools.ts';
	const PLAN_EXPLORE = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/planExploreTool.ts';
	const SVC = 'src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts';

	test('★★★ 快照契约必须携带父回合身份（agentId/sessionId，可选以兼容 workflow 未接线）', () => {
		const src = code(AGENT_OS);
		const idx = src.indexOf('interface ISubAgentTraceSnapshot');
		assert.ok(idx !== -1, '找不到 ISubAgentTraceSnapshot ✗');
		const body = src.slice(idx, src.indexOf('}', idx));
		assert.ok(body.includes('agentId?: string'), '快照必须带 agentId（归属过滤的前提）✗');
		assert.ok(body.includes('sessionId?: string'), '快照必须带 sessionId（归属过滤的前提）✗');
	});

	test('★★★ 生产者必须填充身份（delegationTools 三处 + planExploreTool 一处）', () => {
		for (const [rel, count] of [[DELEGATION, 3], [PLAN_EXPLORE, 1]] as Array<[string, number]>) {
			const src = code(rel);
			const fireIdx: number[] = [];
			for (let i = src.indexOf('fireSubAgentTrace({'); i !== -1; i = src.indexOf('fireSubAgentTrace({', i + 1)) { fireIdx.push(i); }
			assert.strictEqual(fireIdx.length, count, `${rel} 的 fire 点数量变了（期望 ${count}）——请同步补身份 ✗`);
			// 每个 fire 块**内部**前 200 字符必须带身份（注意 `handler: async (args, signal, agentId, sessionId,…)`
			// 里也有同形文本 ⇒ 只能按 fire 块窗口查，不能全文计数 ✓）
			for (const i of fireIdx) {
				assert.ok(src.slice(i, i + 200).includes('agentId, sessionId,'),
					`${rel}: 该 fire 点未带 agentId/sessionId（跨会话会错挂、旁观面板无法过滤 ✗）`);
			}
		}
	});

	test('★★★ pane 侧：非本会话必须静默丢弃（不得再刷 WARN），且判定在挂载之前', () => {
		const src = code(PANE);
		assert.ok(src.includes('_isSubAgentTraceMine('), '缺少归属判定方法 ✗');
		const guardIdx = src.indexOf('if (!this._isSubAgentTraceMine(snapshot))');
		assert.ok(guardIdx !== -1, '订阅处必须先做归属过滤 ✗');
		assert.ok(src.includes('trace skipped: 非本会话'), '非本会话必须留 trace 级可观测日志（不是 WARN）✗');
		// 过滤必须在「无流式 assistant 消息」判定之前（否则旁观面板又会走兜底/告警 ✗）
		const noStreamIdx = src.indexOf('无流式 assistant 消息', guardIdx);
		assert.ok(noStreamIdx > guardIdx, '归属过滤必须早于「无流式消息」分支 ✗');
		// 归属判定语义：有身份但本 pane 无会话 ⇒ 拒收
		const mineIdx = src.indexOf('private _isSubAgentTraceMine(');
		const mineBody = src.slice(mineIdx, mineIdx + 700);
		assert.ok(mineBody.includes('!this._currentSessionId || ownerSession !== this._currentSessionId'),
			'会话身份不匹配（含本 pane 无会话）必须拒收 ✗');
		assert.ok(mineBody.includes('!this._currentAgentId || ownerAgent !== this._currentAgentId'),
			'agent 身份不匹配必须拒收 ✗');
	});

	test('★★ 本会话但无流式消息 ⇒ 兜底挂到历史（自校验：找不到父卡即放弃）', () => {
		const src = code(PANE);
		assert.ok(src.includes('_mountSubAgentTraceToHistory('), '缺少兜底挂载方法 ✗');
		const idx = src.indexOf('private _mountSubAgentTraceToHistory(');
		const body = src.slice(idx, idx + 1600);
		assert.ok(body.includes("if (m?.role !== 'assistant') { continue; }"), '只允许挂到 assistant 消息 ✗');
		assert.ok(body.includes('parentIds.has(String(tc.id))'),
			'必须按 parentToolCallId 严格匹配父工具卡（自校验，不猜测 ✗）');
		assert.ok(body.includes('this._remapAndAttachSubAgents(m)'),
			'必须复用父卡重映射（渲染侧按 tc.subAgents 过滤）✗');
		assert.ok(body.includes('this._chatPanel.updateMessage(m.id, { subAgents: m.subAgents })'),
			'必须仅传 subAgents（轻量原地重建；带 isStreaming 会全量重建 ✗）');
		// 兜底失败后仍要保留 WARN（真异常不得静默）
		const paneSrc = code(PANE);
		const mountIdx = paneSrc.indexOf('this._mountSubAgentTraceToHistory(snapshot?.subagentData');
		const after = paneSrc.slice(mountIdx, mountIdx + 600);
		assert.ok(after.includes('trace dropped: 无流式 assistant 消息'),
			'兜底挂载失败必须保留 WARN（真丢卡不得静默 ✗）');
	});

	test('★★ 去重签名纳入归属（同 groupId 换归属不得被吞）+ 日志带 owner', () => {
		const src = code(SVC);
		assert.ok(src.includes('const owner = `'), 'agentOSService 必须计算 owner 标识 ✗');
		assert.ok(src.includes('const contentSig = `${owner}#`'),
			'内容签名必须含归属（否则跨会话同 groupId 会被误去重 ✗）');
		assert.ok(src.includes('owner=${owner}'), 'info 日志必须带 owner（与 pane 的 trace skipped 对读定位串台 ✓）');
	});
});
