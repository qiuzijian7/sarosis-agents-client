// @vssaros/dsh-agents — 进程内「IM 模拟器」适配器（P0）
//
// 为什么要有它：绑定/路由/幂等/分段这一整套在**没有真实凭据**时也必须能端到端验证。
// 它不连任何外网、不需要 app_id，只是把"发出去的东西"记在内存里，供探针/演练断言。
//
// ⚠ 生产形态下不要把它当成真的 IM：它没有任何鉴权、没有投递确认、重启即丢。
//   飞书适配器（P2）是另一个文件，实现同一个端口形状即可，路由层零改动。
//
// 端口形状（与 `vssaros-channels/lib/core/ports.js` 对齐）：
//   { id, name, send(ctx, text) }   ctx = { sessionKey, chatId, chatType, bindingId }
export function createLoopbackAdapter({ keep = 100 } = {}) {
	const sent = [];
	return {
		id: 'loopback',
		name: '模拟器（进程内）',
		/** 发送记录：`[{ at, chatId, chatType, bindingId, text }]`（有界，最旧先丢） */
		sent,
		async send(ctx, text) {
			sent.push({
				at: Date.now(),
				chatId: String(ctx?.chatId || ''),
				chatType: String(ctx?.chatType || 'p2p'),
				bindingId: String(ctx?.bindingId || ''),
				text: String(text ?? ''),
			});
			while (sent.length > keep) {
				sent.shift();
			}
		},
	};
}
