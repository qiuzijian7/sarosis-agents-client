// 渠道路由（重构 2.3 的核心环）：入站消息 → 专属会话 → vssarosRuns 驱动 → 回传。
//
// ── 映射口径 ────────────────────────────────────────────────────────────────
// `sessionKey = chat:<platform>:<chatId>`（方案 2.3）：一个 IM 群/私聊固定映射到一条
// dsh 会话。同一 chatId 的消息**续跑同一条历史**（runs.run 同 sessionId 幂等收养 ✓）——
// 群里的上下文不会丢，也不会每条消息起新会话。
//
// ── 纪律 ────────────────────────────────────────────────────────────────────
// · 白名单 fail-closed：适配器报 `allowFrom`，不匹配的 userId 直接拒（回一句"不在白名单"），
//   缺省（适配器没报）⇒ 全拒 ✓（legacy 的 loopback 就是这么写的，口径一致）。
// · 一次只跑一个回合/会话：同一 sessionKey 的消息**排队**（不是并发）——IM 群里消息乱序到达
//   是常态，并发跑两条 ⇒ 历史交错 ✗。
// · 回合结果只回**最终文本**（finalText）；没有最终文本 ⇒ 如实说"这回合没产出文本"
//   （可能是工具占满/被打断），不编一个 ✗。
// · 审批：后台会话没有人工 ⇒ 走 1.5 的审批闸（`approval.allow` 白名单，默认全拒）；
//   审批 IM 卡片待真机适配器对接（要平台卡片回调 ⇒ 本轮不做）。

/** 一条会话一个 promise 链（消息串行）。 */
const queues = new Map();

/** 白名单判定：allowFrom 为空 ⇒ 全拒；否则只放行匹配的 userId。 */
export function allowFromCheck(allowFrom, userId) {
	const allowed = String(allowFrom ?? '').trim();
	if (!allowed) { return false; }
	return allowed.split(',').map(s => s.trim()).includes(String(userId ?? '').trim());
}

/** 入站消息 → sessionKey（chat:<platform>:<chatId>；缺 chatId 时用 sessionKey 兜底）。 */
export function sessionKeyOf(msg) {
	const platform = String(msg?.platform ?? '').trim();
	const chatId = String(msg?.chatId ?? msg?.conversationId ?? '').trim();
	if (platform && chatId) { return `chat:${platform}:${chatId}`; }
	return String(msg?.sessionKey ?? '').trim();
}

/** 建路由器。deps: { runs, log, cwdOf(platform), approvalAllow(platform) }。 */
export function createChannelRouter(deps) {
	const { runs, log, cwdOf, approvalAllow } = deps;

	/** 处理一条入站消息（排队 → 驱动 → 回传）。 */
	function handle(adapter, msg) {
		const key = sessionKeyOf(msg);
		if (!key) {
			log('warn', `入站消息缺 sessionKey/chatId，丢弃：${JSON.stringify({ platform: msg?.platform, messageId: msg?.messageId })}`);
			return;
		}
		// 白名单：fail-closed
		if (!allowFromCheck(adapter.allowFrom, msg.userId)) {
			log('warn', `用户 ${msg.userId} 不在 ${adapter.id} 的白名单（allowFrom=${adapter.allowFrom ?? '(空)'}），拒绝`);
			void adapter.send({ sessionKey: key, replyCtx: msg.replyCtx }, '（不在白名单，拒绝处理）');
			return;
		}
		// 排队：同一会话的消息串行
		const prev = queues.get(key) ?? Promise.resolve();
		const next = prev.then(() => drive(adapter, key, msg)).catch(e => {
			log('warn', `回合出错（${key}）：${String(e?.message ?? e)}`);
		});
		queues.set(key, next);
	}

	async function drive(adapter, key, msg) {
		const cwd = cwdOf(adapter.id);
		const allow = approvalAllow(adapter.id);
		log('info', `驱动会话 ${key}（${adapter.id}，${msg.userName}）：${String(msg.content).slice(0, 60)}`);
		const result = await runs.run({
			sessionId: key,
			cwd,
			prompt: String(msg.content ?? ''),
			approval: { allow },
		});
		const text = typeof result.finalText === 'string' && result.finalText.trim()
			? result.finalText
			: `（这回合没产出文本，stopReason=${result.stopReason ?? '未知'}）`;
		await adapter.send({ sessionKey: key, replyCtx: msg.replyCtx }, text);
	}

	return { handle };
}
