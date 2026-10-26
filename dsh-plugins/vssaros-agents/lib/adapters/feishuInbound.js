// @vssaros/dsh-agents — 飞书**入站**骨架（P2）
//
// ── 为什么是"骨架" ──────────────────────────────────────────────────────────
// 飞书的「长连接」不是裸 WebSocket：它用官方 SDK 做 protobuf 握手/心跳/分帧
// （`@larksuiteoapi/node-sdk` 的 `WSClient`）。手写那一层不现实，也不该自己维护。
// 所以这里把**传输层做成注入的**：
//   · 有 SDK 时（P2 真机）：`createSdkTransport()` 用官方 WSClient
//   · 没有 SDK 时：`transport.start()` 抛 `unavailable`，网关如实上报（UI 显示"没装 SDK"）
//   · 单测/演练：注入假 transport，喂事件即可验完整链路
//
// ── 这一层只做三件事 ────────────────────────────────────────────────────────
// ① 解析：飞书事件 → 我们统一的 `msg`（`parseFeishuEvent`，纯函数）
// ② 防环：**bot 自己发的消息**（`sender_type === 'app'`）直接丢
// ③ 重连：断线指数退避（1s→2s→…→30s），`stop()` 后不再重连
//
// 幂等不在这里做 —— 它在 `imSeen.js`（跨重启），因为飞书会重投事件。

/** 去掉飞书 @ 占位符（`@_user_1`）并收拾多余空格。 */
export function stripAtPlaceholders(text) {
	return String(text ?? '')
		.replace(/@_user_\d+/g, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.trim();
}

/** 从飞书 `content` 里取纯文本（它是 JSON 字符串；解析失败就原样返回）。 */
export function textOfContent(content) {
	const raw = String(content ?? '');
	if (!raw) {
		return '';
	}
	try {
		const j = JSON.parse(raw);
		if (j && typeof j.text === 'string') {
			return stripAtPlaceholders(j.text);
		}
		return '';
	} catch {
		return stripAtPlaceholders(raw);
	}
}

/**
 * 解析飞书事件（纯函数，便于单测）。
 *
 * 返回：
 *   `{ kind:'challenge', challenge }`  —— URL 校验（HTTP 模式用；长连接不走这条，但保留）
 *   `{ kind:'message', msg }`          —— 一条可处理的用户消息
 *   `{ kind:'ignore', reason }`        —— 明确不处理（原因写清，别静默）
 */
export function parseFeishuEvent(payload) {
	const p = payload && typeof payload === 'object' ? payload : {};

	// ① URL 校验（HTTP 模式）
	if (p.type === 'url_verification' || p.challenge) {
		return { kind: 'challenge', challenge: String(p.challenge ?? '') };
	}

	// ② 事件包：v2 结构 `{ header:{event_type}, event:{...} }`
	const eventType = String(p?.header?.event_type ?? p?.event?.type ?? '');
	const ev = p?.event ?? p;
	if (!eventType) {
		return { kind: 'ignore', reason: 'no-event-type' };
	}
	if (eventType !== 'im.message.receive_v1') {
		return { kind: 'ignore', reason: 'unsupported-event:' + eventType };
	}

	const message = ev?.message ?? {};
	// ③ 防环：bot 自己（或别的应用）发的消息不能回灌，否则 IM→bot→IM 会自激
	const senderType = String(ev?.sender?.sender_type ?? message?.sender_type ?? '');
	if (senderType === 'app') {
		return { kind: 'ignore', reason: 'from-app' };
	}

	const chatId = String(message.chat_id ?? ev?.chat_id ?? '').trim();
	const messageId = String(message.message_id ?? '').trim();
	const chatType = String(message.chat_type ?? 'p2p') === 'group' ? 'group' : 'p2p';
	const msgType = String(message.message_type ?? 'text');
	if (!chatId || !messageId) {
		return { kind: 'ignore', reason: 'missing-chat-or-message-id' };
	}
	if (msgType !== 'text') {
		/* P2 只处理文本；图片/文件等如实标注（P4 再说），不要当成空消息丢进去 */
		return { kind: 'ignore', reason: 'unsupported-message-type:' + msgType };
	}

	const mentions = Array.isArray(message.mentions) ? message.mentions : [];
	const text = textOfContent(message.content);
	if (!text) {
		return { kind: 'ignore', reason: 'empty-text' };
	}

	const openId = String(ev?.sender?.sender_id?.open_id ?? ev?.sender?.sender_id?.user_id ?? '').trim();
	const userName = String(ev?.sender?.sender_id?.union_id ?? '').trim();

	return {
		kind: 'message',
		msg: {
			platform: 'feishu',
			chatId,
			chatType,
			messageId,
			userId: openId,
			userName: userName || openId,
			content: text,
			/* 群里是否 @ 了我们的 bot：mention 里带 `bot` 标记，或 key 是 bot 的 open_id。
			   我们不知道自己的 open_id ⇒ 采用「有任意 mention 就算 @」的保守近似，
			   并把原始 mentions 一起带出去（将来可精确匹配）。 */
			mentionsBot: mentions.length > 0,
			mentions: mentions.map((m) => ({
				key: String(m?.key ?? ''),
				name: String(m?.name ?? ''),
				openId: String(m?.id?.open_id ?? ''),
			})),
		},
	};
}

/**
 * 建入站网关。
 *
 * `transport` 契约（注入）：
 *   `{ start({ onEvent, onError }) => Promise<{ close(): void|Promise<void> }> }`
 *   —— 只要能"开始收事件 / 关闭"就够了，具体是 SDK 长连接还是假实现由调用方决定。
 *
 * `onMessage(msg)`：解析出的消息（调用方一般接到 `hub.handleInbound`）。
 */
export function createFeishuGateway({ transport, onMessage, log, baseDelayMs = 1000, maxDelayMs = 30_000 } = {}) {
	let handle = null;
	let stopped = false;
	let attempt = 0;
	let timer = null;
	const state = { status: 'idle', attempts: 0, lastError: '', lastEventAt: 0 };

	const note = (level, msg) => {
		try { log?.(level, msg); } catch { /* 忽略 */ }
	};

	function scheduleRetry() {
		if (stopped) {
			return;
		}
		attempt += 1;
		state.attempts = attempt;
		const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
		note('warn', `飞书长连接断开，${delay}ms 后重连（第 ${attempt} 次）`);
		timer = setTimeout(() => { void connect(); }, delay);
		if (typeof timer?.unref === 'function') {
			timer.unref();
		}
	}

	async function connect() {
		if (stopped) {
			return;
		}
		state.status = 'connecting';
		try {
			handle = await transport.start({
				onEvent: (payload) => {
					state.lastEventAt = Date.now();
					const parsed = parseFeishuEvent(payload);
					if (parsed.kind === 'message') {
						state.status = 'ready';
						attempt = 0;
						Promise.resolve(onMessage?.(parsed.msg)).catch((e) => {
							note('warn', `入站处理失败：${String(e?.message ?? e)}`);
						});
						return;
					}
					if (parsed.kind === 'ignore') {
						note('info', `忽略事件：${parsed.reason}`);
					}
				},
				onError: (e) => {
					state.lastError = String(e?.message ?? e);
					note('warn', `飞书长连接错误：${state.lastError}`);
					try { handle?.close?.(); } catch { /* 忽略 */ }
					handle = null;
					scheduleRetry();
				},
			});
			state.status = 'ready';
			attempt = 0;
			note('info', '飞书长连接已就绪');
		} catch (e) {
			state.status = 'error';
			state.lastError = String(e?.message ?? e);
			scheduleRetry();
		}
	}

	return {
		id: 'feishu-inbound',
		async start() {
			stopped = false;
			await connect();
		},
		async stop() {
			stopped = true;
			if (timer) { clearTimeout(timer); timer = null; }
			try { await handle?.close?.(); } catch { /* 忽略 */ }
			handle = null;
			state.status = 'stopped';
		},
		state() {
			return { ...state };
		},
	};
}

/**
 * 默认 transport：用官方 SDK 的长连接（`@larksuiteoapi/node-sdk` 的 `WSClient`）。
 *
 * ⚠ 我们这个包**不把 SDK 作为依赖**（几十 MB，且只有真机用）：装了才用，没装就如实报
 *   `unavailable` —— 这一条比"假装连上了"重要得多（否则用户会一直等一个不存在的事件）。
 */
export function createSdkTransport({ appId, appSecret, importSdk } = {}) {
	return {
		async start({ onEvent, onError }) {
			const id = String(appId ?? '').trim();
			const secret = String(appSecret ?? '').trim();
			if (!id || !secret) {
				throw new Error('unavailable：缺少 app_id / app_secret（飞书开放平台 → 企业自建应用）');
			}
			const load = importSdk || (() => import('@larksuiteoapi/node-sdk'));
			let sdk;
			try {
				sdk = await load();
			} catch {
				throw new Error('unavailable：未安装 @larksuiteoapi/node-sdk（npm i @larksuiteoapi/node-sdk 后重启 Host）');
			}
			const WSClient = sdk?.WSClient || sdk?.default?.WSClient;
			if (typeof WSClient !== 'function') {
				throw new Error('unavailable：SDK 里没有 WSClient（版本不匹配）');
			}
			const client = new WSClient({ appId: id, appSecret: secret });
			/* SDK 的事件回调签名因版本而异：统一按 `{ header, event }` 透传给解析层，
			   解析层对其它形状也是宽容的（见 `parseFeishuEvent`）。 */
			await client.start({
				onEvent: (data) => { try { onEvent?.(data); } catch (e) { onError?.(e); } },
				onError,
			});
			return { close: () => client.close?.() };
		},
	};
}
