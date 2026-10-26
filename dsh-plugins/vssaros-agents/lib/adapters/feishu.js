// @vssaros/dsh-agents — 飞书**出站**适配器（P1：自定义机器人 webhook）
//
// ── 为什么先做 webhook 模式 ──────────────────────────────────────────────────
// 应用模式（`im/v1/messages`）需要 `app_id/app_secret` + 管理员审批权限 + 长连接，
// 而「自定义机器人」只要一个 webhook URL 就能往群里发消息 ⇒ 用它把**出站**先跑通，
// 用户能在飞书群里立刻看到成员答复（P1 的价值），入站（P2）再补。
//
// ── 鉴权 ────────────────────────────────────────────────────────────────────
// 自定义机器人可开「签名校验」：`sign = base64(HMAC-SHA256(key = `${ts}\n${secret}`, data = ''))`。
// 没开签名就不带这两项（不能带空 sign，飞书会拒）。
//
// ── 端口形状 ────────────────────────────────────────────────────────────────
// 与 `vssaros-channels/lib/core/ports.js` / 本包 `adapters/loopback.js` 同形：
//   `{ id, name, send(ctx, text) }`，ctx 里带 `webhookUrl` / `webhookSecret`。
//   ⇒ 路由层（bindings.js）不知道任何平台细节。
import { createHmac } from 'node:crypto';

/**
 * 飞书自定义机器人的签名。
 * 文档口径：`stringToSign = timestamp + "\n" + secret`，以它为 **key** 对空串做 HMAC-SHA256，再 base64。
 * 抽成纯函数是为了能单测（算法写错的话线上表现是"消息发出去了但飞书拒收"，很难查）。
 */
export function feishuSign(timestamp, secret) {
	return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/** 组装 webhook 请求体（纯函数，便于断言）。 */
export function buildWebhookPayload(text, { timestamp, secret } = {}) {
	const body = { msg_type: 'text', content: JSON.stringify({ text: String(text ?? '') }) };
	if (secret) {
		body.timestamp = String(timestamp ?? Math.floor(Date.now() / 1000));
		body.sign = feishuSign(body.timestamp, secret);
	}
	return body;
}

/**
 * 建飞书适配器。
 * `deps.fetchImpl` / `deps.now` 可注入（单测不联网）。
 */
export function createFeishuAdapter({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
	return {
		id: 'feishu',
		name: '飞书（自定义机器人 webhook）',
		/**
		 * 发一条文本。**失败必须抛**（由 hub 记为 failed），不许静默成功 ——
		 * "以为发出去了其实没有"是这个功能最难查的一类问题。
		 */
		async send(ctx, text) {
			const url = String(ctx?.webhookUrl ?? '').trim();
			if (!url) {
				throw new Error('这条绑定没有配置飞书 webhook URL');
			}
			if (typeof fetchImpl !== 'function') {
				throw new Error('当前运行时没有 fetch');
			}
			const secret = String(ctx?.webhookSecret ?? '');
			const body = buildWebhookPayload(text, { timestamp: Math.floor(now() / 1000), secret });
			let lastError = '';
			/* 网络层失败重试 1 次（webhook 偶发超时很常见）；**业务错误不重试**
			   —— code!=0 重试只会把同一条消息拒两遍。 */
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					const res = await fetchImpl(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
					});
					const json = await res.json().catch(() => null);
					const code = json && typeof json.code === 'number' ? json.code : (json && json.StatusCode);
					if (!res.ok) {
						throw new Error(`HTTP ${res.status}${json && json.msg ? ' · ' + json.msg : ''}`);
					}
					if (typeof code === 'number' && code !== 0) {
						throw new Error(`飞书拒绝（code=${code}${json && json.msg ? ' · ' + json.msg : ''}）`);
					}
					return { ok: true };
				} catch (e) {
					lastError = String((e && e.message) || e);
					/* HTTP/业务错误不重试 */
					if (/^HTTP |^飞书拒绝/.test(lastError)) { break; }
				}
			}
			throw new Error(`飞书出站失败：${lastError}`);
		},
	};
}
