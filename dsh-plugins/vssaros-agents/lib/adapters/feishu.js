// @vssaros/dsh-agents — 飞书**出站**适配器（两种模式，2026-10-28 起）
//
// ── 为什么现在有两种 ────────────────────────────────────────────────────────
// P1 只做了「自定义机器人 webhook」：一个 URL 就能往群里发。但真机反馈是
// **「飞书绑定，填 id 应该就可用了吧」** —— 而 webhook 模式必须先手工在群里加机器人、
// 复制 URL，比填 chat_id 麻烦得多；而且 2026-10-27 起「设置 → 渠道」里已经能存
// App ID / App Secret（`<dataRoot>/agent-im-accounts.json`），入站也是应用模式
// （WS 长连接）⇒ 出站再卡 webhook 就自相矛盾了。
//
//   ① webhook 模式（绑定的 `webhookUrl`）：走自定义机器人，**不需要**应用权限；
//   ② 应用模式（`webhookUrl` 留空）：用应用凭据换 `tenant_access_token`，
//      调 `im/v1/messages?receive_id_type=chat_id` —— **只要有 chat_id 就能发**
//      （前提：应用开了 `im:message` 权限、机器人被加进该会话）。
//
// 优先级：填了 webhookUrl 就用它（那条通道更稳，也不消耗应用权限）；
//        没填才走应用模式。两条都不可用 ⇒ **必须抛**（由 hub 记 failed / 死信）。
//
// ── 鉴权（webhook 模式）──────────────────────────────────────────────────────
// 自定义机器人可开「签名校验」：`sign = base64(HMAC-SHA256(key = `${ts}\n${secret}`, data = ''))`。
// 没开签名就不带这两项（不能带空 sign，飞书会拒）。
//
// ── 端口形状 ────────────────────────────────────────────────────────────────
// 与 `vssaros-channels/lib/core/ports.js` / 本包 `adapters/loopback.js` 同形：
//   `{ id, name, send(ctx, text) }`，ctx 里带 `chatId` / `webhookUrl` / `webhookSecret`。
//   ⇒ 路由层（bindings.js）不知道任何平台细节。
import { createHmac } from 'node:crypto';

const FEISHU_API_ROOT = 'https://open.feishu.cn/open-apis';

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

/** 组装应用模式的 `im/v1/messages` 请求体（纯函数，便于断言）。 */
export function buildAppMessagePayload(chatId, text) {
	return {
		receive_id: String(chatId ?? ''),
		msg_type: 'text',
		content: JSON.stringify({ text: String(text ?? '') }),
	};
}

/**
 * 建飞书适配器。
 *
 * `resolveApp` 由 Host 注入，返回 `{ appId, appSecret, configured }`（真源在 dsh 侧凭据文件）。
 * 注成函数而不是值 ⇒ **每次发送现取** ⇒ 用户在「设置 → 渠道」填完立刻生效，不用重启 Host。
 *
 * `deps.fetchImpl` / `deps.now` 可注入（单测不联网）。
 */
export function createFeishuAdapter({ fetchImpl = globalThis.fetch, now = () => Date.now(), resolveApp = null } = {}) {
	/* tenant_access_token 缓存：有效期 7200s，**取太勤会被限流** ⇒ 提前 5 分钟过期。 */
	let cachedToken = '';
	let tokenExpireAt = 0;

	async function appCredentials() {
		if (typeof resolveApp !== 'function') { return null; }
		const app = await resolveApp().catch(() => null);
		if (!app || !app.configured || !String(app.appId || '').trim() || !String(app.appSecret || '').trim()) {
			return null;
		}
		return { appId: String(app.appId).trim(), appSecret: String(app.appSecret).trim() };
	}

	async function tenantToken(app) {
		if (cachedToken && now() < tokenExpireAt) { return cachedToken; }
		const res = await fetchImpl(`${FEISHU_API_ROOT}/auth/v3/tenant_access_token/internal`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
		});
		const json = await res.json().catch(() => null);
		const code = json && typeof json.code === 'number' ? json.code : -1;
		if (!res.ok || code !== 0) {
			throw new Error(`unavailable：换取 tenant_access_token 失败（HTTP ${res.status}，code=${code}`
				+ `${json && json.msg ? ' · ' + json.msg : ''}）`);
		}
		const token = String(json.tenant_access_token || '');
		if (!token) { throw new Error('unavailable：飞书没有返回 tenant_access_token'); }
		const expire = Number(json.expire) > 0 ? Number(json.expire) : 7200;
		cachedToken = token;
		tokenExpireAt = now() + Math.max(60, expire - 300) * 1000;
		return token;
	}

	/** 应用模式：token → `im/v1/messages`（receive_id_type=chat_id）。 */
	async function sendViaApp(ctx, text) {
		const app = await appCredentials();
		if (!app) {
			throw new Error('unavailable：这条绑定没有 webhook URL，且「设置 → 渠道」里没有飞书应用凭据（App ID / App Secret）');
		}
		const chatId = String(ctx?.chatId ?? '').trim();
		if (!chatId) { throw new Error('飞书应用模式：缺 chatId（receive_id）'); }
		const token = await tenantToken(app);
		let lastError = '';
		/* 网络层失败重试 1 次；**业务错误不重试**（code!=0 重试只会把同一条拒两遍）。 */
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const res = await fetchImpl(`${FEISHU_API_ROOT}/im/v1/messages?receive_id_type=chat_id`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
					body: JSON.stringify(buildAppMessagePayload(chatId, text)),
				});
				const json = await res.json().catch(() => null);
				const code = json && typeof json.code === 'number' ? json.code : 0;
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}${json && json.msg ? ' · ' + json.msg : ''}`);
				}
				if (code !== 0) {
					throw new Error(`飞书拒绝（code=${code}${json && json.msg ? ' · ' + json.msg : ''}）`);
				}
				return { ok: true, via: 'app' };
			} catch (e) {
				lastError = String((e && e.message) || e);
				if (/^HTTP |^飞书拒绝/.test(lastError)) { break; }
			}
		}
		throw new Error(`飞书出站失败（应用模式）：${lastError}`);
	}

	return {
		id: 'feishu',
		name: '飞书（webhook / 应用模式）',
		/**
		 * 发一条文本。**失败必须抛**（由 hub 记为 failed），不许静默成功 ——
		 * "以为发出去了其实没有"是这个功能最难查的一类问题。
		 */
		async send(ctx, text) {
			const url = String(ctx?.webhookUrl ?? '').trim();
			/* webhookUrl 留空 ⇒ 应用模式（2026-10-28：填个 chat_id 就该能用） */
			if (!url) { return sendViaApp(ctx, text); }
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
					return { ok: true, via: 'webhook' };
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
