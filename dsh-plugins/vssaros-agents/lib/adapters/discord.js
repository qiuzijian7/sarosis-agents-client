// @vssaros/dsh-agents — Discord 适配器（2026-10-27，第二个**非轮询**渠道）
//
// ── 为什么它是第三个真实渠道 ────────────────────────────────────────────────
// 飞书 = WS 长连接（但靠官方 SDK），Telegram = HTTP 长轮询，Discord = **原生 WebSocket**。
// 三者传输完全不同，但上层（绑定 / 策略 / 配对 / 死信 / 界面）**一行没改** ——
// 这是"加渠道只写薄适配器"的第三次验证。
//
// ⚠ Node 22 自带 `globalThis.WebSocket`（实测 `typeof === 'function'`）⇒ 不加任何依赖。
//
// ── 出站（纯 HTTP，简单）──────────────────────────────────────────────────
//   POST https://discord.com/api/v10/channels/{channel_id}/messages
//   headers: { Authorization: 'Bot <token>', content-type: 'application/json' }
//   body:    { content }            // 上限 2000 字 ⇒ 上层已按 1900 分段
//   429 ⇒ 响应体带 `retry_after`（秒），**如实抛**，不静默重试。
//
// ── 入站（Gateway WebSocket，协议要点都写在这里）──────────────────────────
//   ① GET /gateway/bot           → { url, shards, session_start_limit }
//   ② 连 `url/?v=10&encoding=json`
//   ③ 收 op=10 HELLO             → d.heartbeat_interval（毫秒）
//   ④ 发 op=2 IDENTIFY           → { token, intents, properties: { os, browser, device } }
//   ⑤ 收 op=0 READY              → d.user.id（botId）、d.session_id
//   ⑥ 收 op=0 MESSAGE_CREATE     → 一条消息
//   ⑦ 心跳 op=1（每 interval 一次，首包带 jitter）；op=11 是 ACK
//   ⑧ op=7 RECONNECT ⇒ 重连；op=9 INVALID_SESSION ⇒ 重新 IDENTIFY
//
//   ⚠ **MESSAGE_CONTENT 是 privileged intent**：必须在 Discord 开发者后台
//     （Bot → Privileged Gateway Intents）手动开启，否则事件里 `content` 是空串 ——
//     症状是"消息能收到、但内容全空"。这条在 `imPlatforms.js` 的 note 里也写了。
//   ⚠ 关闭码 4004（鉴权失败）**不该重试**：token 错了，重试只会刷日志。

import {
	MAX_IMAGE_BYTES, MAX_IMAGES, buildMultipartFormData, imageExtensionOf, imageMediaTypeOf, imageMediaTypeOfFile,
} from './media.js';

/** Discord REST 根（版本固定 v10；换版本要整包回归）。 */
export const DISCORD_API_ROOT = 'https://discord.com/api/v10';

/**
 * 我们订阅的 intents（位掩码）：
 *   GUILDS(1) | GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768)
 * = 37377
 * 少一个 `MESSAGE_CONTENT` 就收不到正文；少 `DIRECT_MESSAGES` 就收不到私聊。
 */
export const DISCORD_INTENTS = 37377;
export const DISCORD_INTENT_PARTS = { GUILDS: 1, GUILD_MESSAGES: 512, DIRECT_MESSAGES: 4096, MESSAGE_CONTENT: 32768 };

/** 鉴权失败（不该重试）。 */
const CLOSE_AUTH_FAILED = 4004;

function httpError(status, message) {
	return Object.assign(new Error(message), { httpStatus: status });
}

/* ══ 出站 ═══════════════════════════════════════════════════════════════════ */

/**
 * 出站适配器。
 *
 * `resolve` 每次 `send` 现取凭据（与飞书/Telegram 同一条纪律：设置里改完不必重启 Host）。
 * `fetchImpl` 只为可测（ESM 无法 mock 全局 fetch）。
 */
export function createDiscordAdapter(options = {}) {
	const resolve = typeof options.resolve === 'function' ? options.resolve : async () => options;
	const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
	return {
		id: 'discord',
		/**
		 * 出站。`images` 可选（2026-10-27 富媒体）。
		 *
		 * 有图时改走 `multipart/form-data`：文本放普通字段 `content`，
		 * 文件字段名**必须是 `files[0]`**（Discord 的约定，写 `file` 会被当未知字段忽略）。
		 * 只有图没有文本也允许（`content` 发空串，Discord 接受）。
		 */
		async send(ctx, text, images) {
			const creds = (await resolve().catch(() => null)) || {};
			const token = String(creds.botToken ?? creds.appSecret ?? '').trim();
			if (!token) {
				throw new Error('unavailable：缺少 Bot Token（Discord 开发者后台 → Bot → Reset Token）');
			}
			const channelId = String(ctx?.chatId ?? '').trim();
			if (!channelId) { throw new Error('discord：缺 chatId（channel_id）'); }
			const body = String(text ?? '');
			const pics = (Array.isArray(images) ? images : []).filter((x) => x && x.data);
			const first = pics[0] || null;
			/* ⚠ 判 `trim()` 而不是判空串：纯空白（分段器切出来的空白段）不该占一次 API 调用，
			   但**正文保留原样**（不替用户裁空白）。有图时"没正文"也照发。 */
			if (!body.trim() && !first) { return { ok: true, skipped: 'empty' }; }

			const url = `${DISCORD_API_ROOT}/channels/${encodeURIComponent(channelId)}/messages`;
			let init;
			if (first) {
				const mediaType = imageMediaTypeOf(first.mediaType) || 'image/jpeg';
				const form = buildMultipartFormData(
					{ content: body },
					{
						field: 'files[0]',
						filename: first.name || ('image.' + imageExtensionOf(mediaType)),
						mimeType: mediaType,
						buffer: Buffer.from(String(first.data), 'base64'),
					},
				);
				init = { method: 'POST', headers: { authorization: 'Bot ' + token, 'content-type': form.contentType }, body: form.body };
			} else {
				init = { method: 'POST', headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ content: body }) };
			}

			const res = await fetchImpl(url, init);
			const raw = await res.text().catch(() => '');
			if (res.status === 429) {
				/* Discord 的限流窗口是"每频道每秒 5 条"，撞上很常见 —— 如实报 retry_after 让上层退避 */
				let after = '';
				try { after = String(JSON.parse(raw)?.retry_after ?? ''); } catch { after = ''; }
				throw new Error('discord 限流：429' + (after ? `（retry_after=${after}s）` : ''));
			}
			if (!res.ok) {
				throw new Error(`discord 发送失败：HTTP ${res.status} ${raw.slice(0, 160)}`);
			}
			return { ok: true };
		},
	};
}

/* ══ 入站解析 ═══════════════════════════════════════════════════════════════ */

/**
 * 把一条 Discord `MESSAGE_CREATE` 解析成我们的 msg 形状。
 *
 * 与飞书/Telegram 的差异（都在这里吸收，上层不用知道）：
 *   · `guild_id` 有 ⇒ 群；没有 ⇒ 私聊（DM channel）
 *   · `author.bot === true` ⇒ `fromIsBot`（防环）
 *   · @ 判定：`mentions` 里有 bot 自己（或任何 bot）算"提到了 bot"；
 *     填了 `botUserId` 才能**精确**判"是不是在叫我"
 *   · `content` 可能为空（没开 MESSAGE_CONTENT，或纯附件消息）⇒ 明确 ignore + reason
 */
export function parseDiscordMessage(payload, options = {}) {
	const botUserId = String(options.botUserId ?? '').trim();
	const d = payload || {};
	const author = d.author || {};
	const isGuild = !!d.guild_id;
	const mentions = Array.isArray(d.mentions) ? d.mentions : [];
	const mentionedAnyBot = mentions.some((m) => m && (m.bot === true || (botUserId && String(m.id) === botUserId)));
	const mentionedMe = botUserId ? mentions.some((m) => String(m?.id) === botUserId) : mentionedAnyBot;
	const ref = d.referenced_message || null;

	/* ★ 防环优先：bot 发的消息一律丢（含 bot 发的图）—— 两个 bot 互刷是最容易出的事故 */
	if (author.bot === true) {
		return { ignored: true, reason: 'from-bot' };
	}

	/* ★ 2026-10-27 富媒体：Discord 的附件给的是**公开 CDN url**，不需要换票，直接 fetch。
	   `content_type` 偶尔为空 ⇒ 退回看扩展名（`imageMediaTypeOfFile`）。 */
	const attachments = [];
	for (const a of (Array.isArray(d.attachments) ? d.attachments : [])) {
		if (!a || !a.url) { continue; }
		const mimeType = imageMediaTypeOfFile(a.content_type, a.filename);
		if (!mimeType) { continue; }
		attachments.push({
			kind: 'image',
			url: String(a.url),
			mimeType,
			size: Number(a.size) || 0,
			fileName: String(a.filename || ''),
		});
	}

	const content = String(d.content ?? '').trim();
	if (!content && !attachments.length) {
		return { ignored: true, reason: 'empty-content', note: '可能是没开 MESSAGE_CONTENT，也可能是纯贴纸/非图片附件' };
	}
	return {
		ignored: false,
		msg: {
			platform: 'discord',
			chatId: String(d.channel_id ?? ''),
			chatType: isGuild ? 'group' : 'p2p',
			messageId: String(d.id ?? ''),
			userId: String(author.id ?? ''),
			userName: String(author.global_name || author.username || author.id || ''),
			/* 纯图片消息没有文本 ⇒ 占位（下游按"有内容"处理） */
			content: content || '[图片]',
			attachments,
			/* 与其它渠道同口径：群里必须 @ 才处理（策略层再判，这里只报事实） */
			mentionsBot: mentionedMe,
			fromIsBot: author.bot === true,
			repliesToBot: !!(ref && ref.author && ref.author.bot === true),
			guildId: d.guild_id ? String(d.guild_id) : '',
			raw: { id: d.id, channel_id: d.channel_id, guild_id: d.guild_id },
		},
	};
}

/* ══ 入站传输（Gateway WS，可注入以便单测）═════════════════════════════════════════ */

/**
 * 真实的 WebSocket 传输。
 *
 * 对网关只暴露三件事：`create(handlers)` → `{ send, close }`。
 * 单测传一个假 transport 就能把 IDENTIFY / 心跳 / 分发 / 重连全跑一遍，不连真 Discord。
 */
export function createWebSocketTransport(options = {}) {
	const Impl = options.WebSocketImpl || globalThis.WebSocket;
	return {
		available: typeof Impl === 'function',
		create(handlers = {}) {
			if (typeof Impl !== 'function') {
				throw new Error('unavailable：当前 Node 没有 WebSocket（需要 Node 22+）');
			}
			const ws = new Impl(handlers.url);
			ws.addEventListener('open', () => { try { handlers.onOpen?.(); } catch { /* 忽略 */ } });
			ws.addEventListener('message', (ev) => {
				let frame = null;
				try { frame = JSON.parse(String(ev.data)); } catch { return; }
				try { handlers.onFrame?.(frame); } catch { /* 单帧解析失败不该断连接 */ }
			});
			ws.addEventListener('error', () => { try { handlers.onError?.(new Error('discord gateway 连接出错')); } catch { /* 忽略 */ } });
			ws.addEventListener('close', (ev) => {
				try { handlers.onClose?.({ code: Number(ev.code) || 0, reason: String(ev.reason || '') }); } catch { /* 忽略 */ }
			});
			return {
				send(obj) {
					try { ws.send(JSON.stringify(obj)); } catch { /* 已断开 */ }
				},
				close() {
					try { ws.close(); } catch { /* 已断开 */ }
				},
			};
		},
	};
}

/* ══ 入站网关（IDENTIFY + 心跳 + 分发 + 重连）══════════════════════════════════════ */

/**
 * Discord 入站网关。
 *
 * ⚠ 状态机刻意简单：连上 → HELLO → IDENTIFY → READY → 干活；
 *   收到 RECONNECT/异常关闭 ⇒ 退避重连；4004 鉴权失败 ⇒ **不再重试**（token 错，重试无意义）。
 * ⚠ `stop()` 期间要把 `stopped` 置真并清心跳 —— 与 Telegram 那次 stop 竞争同一个教训。
 */
export function createDiscordGateway(options = {}) {
	const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
	const transport = options.transport || createWebSocketTransport(options);
	const resolve = typeof options.resolve === 'function' ? options.resolve : async () => options;
	const onMessage = typeof options.onMessage === 'function' ? options.onMessage : async () => undefined;
	const onError = typeof options.onError === 'function' ? options.onError : () => undefined;
	const log = typeof options.log === 'function' ? options.log : () => undefined;
	const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

	const st = { status: 'idle', attempts: 0, lastError: '', lastEventAt: 0, botUserId: '', sessionId: '' };
	let socket = null;
	let heartbeatTimer = null;
	let stopped = true;
	let seq = 0;
	let backoff = 1000;

	const stateOf = () => ({
		status: st.status,
		attempts: st.attempts,
		lastError: st.lastError,
		lastEventAt: st.lastEventAt,
	});

	function stopHeartbeat() {
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
	}

	function startHeartbeat(intervalMs) {
		stopHeartbeat();
		const every = Math.max(1000, Number(intervalMs) || 41250);
		heartbeatTimer = setInterval(() => {
			if (stopped || !socket) { return; }
			socket.send({ op: 1, d: seq || null });
		}, every);
		/* 别让心跳把进程钉住（Host 退出时不该等它） */
		if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') { heartbeatTimer.unref(); }
	}

	/**
	 * 下载图片 → 挂 `msg.images` → 派发。
	 *
	 * ⚠ 单张失败只记日志：不能因为一张图让整条消息丢掉（与 Telegram 同一条纪律）。
	 * ⚠ 上限来自 `media.js`，与派发侧的 `slice(0, 2)` 必须一致。
	 */
	async function deliverMessage(msg) {
		const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
		if (atts.length) {
			const images = [];
			for (const a of atts.slice(0, MAX_IMAGES)) {
				try {
					const res = await fetchImpl(a.url);
					if (!res.ok) { log('discord 图片下载失败：HTTP ' + res.status); continue; }
					const buffer = Buffer.from(await res.arrayBuffer());
					if (buffer.length > MAX_IMAGE_BYTES) {
						log('discord 图片过大（' + buffer.length + ' B），跳过');
						continue;
					}
					images.push({ mediaType: a.mimeType, data: buffer.toString('base64'), name: a.fileName || '' });
				} catch (e) {
					log('discord 图片下载失败：' + String((e && e.message) || e));
				}
			}
			if (images.length) { msg.images = images; }
		}
		await onMessage(msg);
	}

	function handleFrame(frame) {
		const op = Number(frame?.op);
		const d = frame?.d;
		if (typeof frame?.s === 'number') { seq = frame.s; }

		if (op === 10) {
			/* HELLO：起心跳 + 发 IDENTIFY */
			startHeartbeat(d?.heartbeat_interval);
			(async () => {
				const creds = (await resolve().catch(() => null)) || {};
				const token = String(creds.botToken ?? '').trim();
				if (!token) {
					st.status = 'error';
					st.lastError = 'unavailable：缺少 Bot Token';
					onError(new Error(st.lastError));
					return;
				}
				if (stopped || !socket) { return; }
				socket.send({
					op: 2,
					d: {
						token,
						intents: DISCORD_INTENTS,
						properties: { os: process.platform, browser: 'vssaros-agents', device: 'vssaros-agents' },
					},
				});
			})();
			return;
		}

		if (op === 0) {
			const t = String(frame?.t ?? '');
			if (t === 'READY') {
				st.status = 'ready';
				st.attempts = 0;
				st.lastError = '';
				backoff = 1000;
				st.botUserId = String(d?.user?.id ?? '');
				st.sessionId = String(d?.session_id ?? '');
				log('discord gateway ready（bot ' + st.botUserId + '）');
				return;
			}
			if (t === 'MESSAGE_CREATE') {
				st.lastEventAt = Date.now();
				const parsed = parseDiscordMessage(d, { botUserId: st.botUserId });
				if (parsed.ignored) {
					log('discord 忽略一条：' + parsed.reason + (parsed.note ? '（' + parsed.note + '）' : ''));
					return;
				}
				/* 单条失败不能断连接（与 Telegram loop 的教训一致） */
				void deliverMessage(parsed.msg).catch((e) => {
					log('discord 处理消息失败：' + String((e && e.message) || e));
				});
				return;
			}
			return;
		}

		if (op === 11) { return; }        // HEARTBEAT_ACK
		if (op === 7) {                   // RECONNECT
			log('discord 要求重连');
			try { socket?.close(); } catch { /* 忽略 */ }
			return;
		}
		if (op === 9) {                   // INVALID_SESSION ⇒ 重新 IDENTIFY（等下一次 HELLO 再来）
			log('discord INVALID_SESSION，将重新识别');
			return;
		}
	}

	async function connectOnce() {
		const creds = (await resolve().catch(() => null)) || {};
		const token = String(creds.botToken ?? '').trim();
		if (!token) { throw new Error('unavailable：缺少 Bot Token'); }

		const res = await fetchImpl(`${DISCORD_API_ROOT}/gateway/bot`, {
			headers: { authorization: 'Bot ' + token },
		});
		const raw = await res.text().catch(() => '');
		if (!res.ok) {
			throw new Error(`拿 gateway 地址失败：HTTP ${res.status} ${raw.slice(0, 160)}`);
		}
		let url = '';
		try { url = String(JSON.parse(raw)?.url ?? ''); } catch { url = ''; }
		if (!url) { throw new Error('gateway 响应里没有 url'); }

		return new Promise((resolvePromise, rejectPromise) => {
			let settled = false;
			let timer = null;
			/* ⚠ 用 `done` 而不是裸 settle：settle 时要清掉握手超时定时器，
			   否则一次成功的连接还会留一个 5s 后触发的 reject（被 settled 挡住，但白占一个 timer）。 */
			const done = (fn, v) => {
				if (settled) { return; }
				settled = true;
				if (timer) { clearTimeout(timer); timer = null; }
				fn(v);
			};
			socket = transport.create({
				url: url + '/?v=10&encoding=json',
				onOpen: () => { st.status = 'connecting'; },
				onFrame: (frame) => {
					/* ① 先结算握手：op=10 HELLO 到了就说明 WS 起来了（此时 start() 可以返回"连接中"）。
					      ⚠ 不在 0ms 就 resolve —— 那样后面的 4004/连接失败**根本影响不到 start()**，
					      界面会先显示"连接中"再变"错误"，而调用方以为启动成功了。 */
					if (Number(frame?.op) === 10) { done(resolvePromise, 'hello'); }
					try { handleFrame(frame); } catch (e) { log('discord 帧处理异常：' + String((e && e.message) || e)); }
				},
				onError: (e) => { st.lastError = String((e && e.message) || e); },
				onClose: ({ code, reason }) => {
					stopHeartbeat();
					socket = null;
					if (stopped) { st.status = 'stopped'; done(resolvePromise, 'stopped'); return; }
					if (code === CLOSE_AUTH_FAILED) {
						st.status = 'error';
						st.lastError = '鉴权失败（4004）：Bot Token 无效';
						done(rejectPromise, new Error(st.lastError));
						return;
					}
					st.status = 'error';
					st.lastError = `连接关闭（${code}${reason ? ' ' + reason : ''}）`;
					/* 握手前就断开 ⇒ 对 start() 而言是失败；握手后断开 ⇒ 交给重连循环 */
					done(rejectPromise, new Error(st.lastError));
				},
			});
			/* 握手兜底：5s 没 HELLO 就当作连不上（不让 start 无限挂） */
			timer = setTimeout(() => done(rejectPromise, new Error('discord 握手超时：5s 内没收到 HELLO')), 5000);
			if (timer && typeof timer.unref === 'function') { timer.unref(); }
		});
	}

	return {
		state: stateOf,
		async start() {
			if (!stopped) { return stateOf(); }
			if (transport.available === false) {
				const e = new Error('unavailable：当前 Node 没有 WebSocket（需要 Node 22+）');
				st.status = 'error';
				st.lastError = String(e.message);
				throw e;
			}
			stopped = false;
			st.status = 'connecting';
			st.attempts = 0;
			st.lastError = '';
			/* 先同步连一次：连不上就抛（不假装"正在连接"） */
			await connectOnce();
			if (st.status === 'error') { throw new Error(st.lastError || 'discord 连接失败'); }
			void (async () => {
				while (!stopped) {
					await sleep(backoff);
					if (stopped) { break; }
					st.attempts += 1;
					backoff = Math.min(30000, backoff * 2);
					try {
						await connectOnce();
					} catch (e) {
						st.lastError = String((e && e.message) || e);
						onError(e);
						break;
					}
				}
			})();
			return stateOf();
		},
		async stop() {
			stopped = true;
			stopHeartbeat();
			try { socket?.close(); } catch { /* 忽略 */ }
			socket = null;
			st.status = 'stopped';
			return stateOf();
		},
	};
}
