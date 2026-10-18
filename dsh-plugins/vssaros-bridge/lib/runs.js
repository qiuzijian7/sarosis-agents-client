// @vssaros/dsh-bridge — runs：后台回合服务（方案重构 1.4，doc/dsh-plugin-paradigm-refactor-plan.html §5）。
//
// 做什么：给"不是聊天框"的入口（渠道 / 看板 runner / 工作流引擎 / 调度器 / Pocket）一条统一的
// 「起一条会话、投一条提示词、等它跑完、拿回结果」的通道。暴露为 cordis 服务 `vssarosRuns`
// （Host 内插件直接用）+ 桥方法 `session.run`（IDE 侧过渡期调用）。
//
// 链路已真机验证（Spike S1，`poc/dsh-p0/scripts/spike/run-spike.mjs` 14/14）：
//   workspaceRegistry.create → sessionController.create（同 id 幂等收养）→ attachSession
//   → resolveAgent → sessionController.prompt → whenIdle → snapshotEvents(水位差) → 结果
// 手法与官方 `dsh-subagent-in-process-driver`（一次性子代理）/`dsh-webhook`（createWebhookSession）同源。
//
// 纪律：
// - 投递只走 `sessionController.prompt()`（v4 会话格式拒绝插件自造 source kind，Spike 实测）；
//   prompt 自带 requestId 幂等去重 ⇒ 重试不会重复投递 ✓。
// - `whenIdle()` 是"整个 agent 停稳"，不是"这条消息结算" ⇒ 结果归属靠消息 id 锚点 +
//   `agent/inbox/spliced` 验证（同 vssaros-agents/lib/relay.js 的手法）。
// - 不订阅 `session/event` 自行重扫（P4）；结果只从 `snapshotEvents` 的**增量窗**里读。
// - 会话日志是唯一真源：runs 不持有任何"回合状态"，重启后可从日志重建（pending 丢失是可接受语义，
//   调用方按自己的存储对账重发，见 kanban runner 的设计）。

/** 默认一回合的等待上限（2 分钟）；调用方可传 timeoutMs 覆盖。 */
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── 无人值守审批（重构 1.5；语义订正见 §10-D4）───────────────────────────────
//
// 实测（Spike 5c）：web 组合里 `dsh-api-remotes` 的 Host 侦听**总是接住** `approval/request`
// 转发给客户端队列；没有浏览器连着时请求**挂起**（不变成 unavailable）⇒ 回合一直卡住 ✗。
// ⇒ 经 runs 跑的背景会话必须有一个**最终应答者**：按会话策略当场给答案（deny-by-default），
// 绝不 `next()` 给会挂起的下游；**不经 runs 的会话**（聊天框等）才放行给 UI 应答者。
//
// 策略：`session.run` 入参 `approval: { allow: string[] }` —— 该会话这一轮允许的工具名白名单；
// 缺省 = 全拒（背景会话默认无任何写权限 ✓）。同会话再 run 时新策略**整体替换**旧策略。

/**
 * 创建审批应答者。`register(listener)` 由调用方注入（生产环境 = `ctx.on('approval/request', …)`，
 * 测试里传假注册器 ⇒ 可在进程内直接驱动，不需要真 Host）。
 * @returns {{ handler: (req, next) => any, setPolicy: Function, clearPolicy: Function, hasPolicy: Function }}
 */
export function createRunsApprovalGate(register) {
	/** sessionId → { allow: Set<string> }（只存白名单；没有条目 = 全拒）。 */
	const policies = new Map();

	function setPolicy(sessionId, approval) {
		const allow = new Set(Array.isArray(approval?.allow) ? approval.allow.map(String) : []);
		policies.set(String(sessionId), { allow });
	}
	function clearPolicy(sessionId) {
		policies.delete(String(sessionId));
	}
	function hasPolicy(sessionId) {
		return policies.has(String(sessionId));
	}

	/**
	 * `approval/request` waterfall 侦听（挂根 ctx：scoped waterfall 对无标签侦听放行 ⇒ 收得到全部 agent）。
	 * 裁决顺序：① 不是 runs 管的会话 ⇒ next()（聊天框照常弹 UI）；② 白名单命中 ⇒ allowed-once；
	 * ③ 其余 ⇒ rejected（**不当场 next()**：下游 api-remotes 在无浏览器时会挂起，见文件头）。
	 */
	function handler(req, next) {
		const sessionId = req?.agent?.session?.id;
		if (sessionId === undefined || sessionId === null || !policies.has(String(sessionId))) {
			return next();
		}
		const toolName = String(req?.toolName ?? '');
		const policy = policies.get(String(sessionId));
		return policy.allow.has(toolName) ? 'allowed-once' : 'rejected';
	}
	register(handler);
	return { handler, setPolicy, clearPolicy, hasPolicy };
}

/** 事件窗里最后一条非空 assistant 文本（照 vssaros-agents/lib/core/relay.js 的口径）。 */
function finalAssistantText(events) {
	let found = null;
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'assistant/message') { continue; }
		const content = event.data?.message?.content;
		const text = typeof content === 'string'
			? content.trim()
			: (Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n').trim() : '');
		if (text) { found = { text, interrupted: event.data?.interrupted === true }; }
	}
	return found;
}

/** 事件窗里最后一个 turn/end 的 reason（completed / aborted / error / …）。 */
function lastTurnReason(events) {
	let found = null;
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type === 'turn/end') { found = event.data?.reason?.kind ?? String(event.data?.reason ?? 'unknown'); }
	}
	return found;
}

/** 会话当前日志水位（relay.js 同款：优先 `session.seq` 数字，没有就从头读）。 */
function seqOf(session) {
	return typeof session?.seq === 'number' ? session.seq : 0;
}

/**
 * 创建 runs 服务。所有依赖由调用方注入（桥插件的 inject 已含它们；别处的可选注入方自行判空）。
 * @param {object} deps { agents, sessionController, workspaceRegistry }
 */
export function createRunsService(deps) {
	const { agents, sessionController, workspaceRegistry, approvalGate } = deps;

	/**
	 * 起/续一条会话，投递一条提示词，等回合跑完，返回结果。
	 * @param {object} input { sessionId, cwd, prompt, agentPreset?, timeoutMs?, approval? }
	 *   sessionId 缺省时由 controller 分配；同一 sessionId 重复调用 = 恢复会话再投一条（实测 ✓）。
	 *   approval: { allow: string[] } = 本会话本轮允许的工具白名单；缺省 = 全拒（见文件头 1.5）。
	 */
	async function run({ sessionId, cwd, prompt, agentPreset, timeoutMs = DEFAULT_TIMEOUT_MS, approval }) {
		if (typeof cwd !== 'string' || !cwd) { throw new Error('session.run: cwd required'); }
		if (typeof prompt !== 'string' || !prompt.trim()) { throw new Error('session.run: prompt required'); }
		const workspace = await workspaceRegistry.create(cwd);
		const created = await sessionController.create({ cwd: workspace?.path ?? cwd, sessionId, agentPreset });
		const id = created?.sessionId ?? sessionId;
		if (!id) { throw new Error('session.run: 没拿到会话 id'); }
		if (workspace && !(workspace.sessionIds ?? []).includes(id)) {
			await workspace.attachSession(id);
		}
		const resolved = await sessionController.resolveAgent(id);
		const agent = resolved?.agent ?? null;
		if (!agent) {
			throw new Error(`session.run: resolveAgent 没拿到 agent：${JSON.stringify(resolved).slice(0, 200)}`);
		}
		// 审批策略**整体替换**：本轮给了就用本轮的；没给 ⇒ 全拒（背景会话的缺省安全姿态）。
		// 在投递前落位：回合第一步就可能触发审批，策略必须先于 prompt 存在 ✓。
		approvalGate?.setPolicy(id, approval);
		const before = seqOf(agent.session);
		const t0 = Date.now();
		await sessionController.prompt({
			requestId: `vssaros-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			sessionId: id,
			mode: 'queue',
			content: [{ type: 'text', text: prompt }],
		}, new AbortController().signal);
		let rejTimeout;
		const timeout = new Promise((_, rej) => { rejTimeout = rej; });
		const timer = setTimeout(() => rejTimeout(new Error(`whenIdle 超时（>${timeoutMs}ms）`)), timeoutMs);
		try {
			await Promise.race([agent.whenIdle(), timeout]);
		} finally {
			// 清掉兜底定时器：Promise.race 胜出后它还在 ⇒ 会撑着事件循环到 timeoutMs（进程退不掉 ✗，p3-95 实测）。
			clearTimeout(timer);
		}
		const events = Array.from(agent.session.snapshotEvents(before, seqOf(agent.session)));
		const final = finalAssistantText(events);
		return {
			sessionId: id,
			workspaceId: workspace?.id,
			agentPreset: created?.agentPreset ?? null,
			stopReason: lastTurnReason(events),
			finalText: final?.text ?? null,
			interrupted: final?.interrupted ?? false,
			elapsedMs: Date.now() - t0,
		};
	}

	/** 取消一条会话当前的活动（尽力而为；按 agent.cancel 的官方语义，默认清空收件箱）。 */
	async function cancel({ sessionId }) {
		const agent = agents.get(sessionId);
		if (!agent) { return { cancelled: false, reason: '会话不在运行（或不在本 Host）' }; }
		agent.cancel({ kind: 'plugin', plugin: 'vssaros-bridge' });
		return { cancelled: true };
	}

	return { run, cancel };
}
