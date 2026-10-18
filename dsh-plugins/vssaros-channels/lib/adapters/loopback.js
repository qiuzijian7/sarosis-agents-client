// Loopback 适配器：测试/演示用（无外部 IM 凭证）。移植自 legacy `loopbackPlatform.ts`。
//
// 入站由进程内 `postInbound()` 注入；出站记进 `outbounds`（探针断言用）。
// 白名单：只放行本平台自己产生的 userId（`tester`）——与 legacy 同口径（fail-closed ✓）。

const LOOPBACK_USER_ID = 'tester';

export function createLoopbackAdapter() {
	let handler;
	const outbounds = [];
	let counter = 0;
	return {
		id: 'loopback',
		name: 'Loopback（测试/演示）',
		allowFrom: LOOPBACK_USER_ID,
		outbounds,
		start(h) { handler = h; },
		stop() { handler = undefined; },
		/** 模拟一条入站消息。 */
		postInbound(content, chatId = 'default', replyCtx) {
			if (!handler) { throw new Error('loopback 尚未 start()'); }
			const messageId = `lb_${Date.now()}_${counter++}`;
			handler({
				sessionKey: `chat:loopback:${chatId}`,
				platform: 'loopback',
				chatId,
				messageId,
				userId: LOOPBACK_USER_ID,
				userName: 'Tester',
				content: String(content),
				replyCtx: replyCtx ?? messageId,
			});
		},
		async send(ctx, content) {
			outbounds.push({ sessionKey: ctx.sessionKey, content: String(content), replyCtx: ctx.replyCtx });
		},
		/** 探针用：清空出站记录。 */
		clear() { outbounds.length = 0; },
	};
}
