// @vssaros/dsh-agents — Telegram 适配器（**纯 HTTP，无 SDK**，2026-10-27）
//
// ── 为什么先做 Telegram（而不是继续深挖飞书）──────────────────────────────
// ① 它是 OpenClaw 的 **bundled** 渠道：只要一个 bot token，不需要应用审批、不需要公网 IP；
// ② Bot API 是**纯 HTTP**（`getUpdates` 长轮询 + `sendMessage`）⇒ 不引入几十 MB 的 SDK；
// ③ 它正好用来验证这套架构的承诺：**加一个渠道 = 写一个薄适配器**，
//    路由 / 绑定 / 策略 / 配对 / 死信 / 界面**一行都不用改**。
//
// ── 与飞书的差异（都体现在这里，而不是散落到上层）──────────────────────────
//   · 入站是**长轮询**（拉），飞书是 WS 长连接（推）
//   · 偏移量 `offset` 必须在内存里推进（否则同一条会被反复取到）
//   · 群里的 `@` 判定：`entities[].type==='mention'` + 文本里的 `@botUsername`
//   · 出站是 `sendMessage`，限流 429 会带 `retry_after`
//
// ── 凭据 ────────────────────────────────────────────────────────────────────
// 从 **dsh 侧**（`imPlatforms.js` 定义的 `botToken` 字段，存在 `<dataRoot>/agent-im-accounts.json`）
// 通过注入的 `getCreds()` 现取 —— 与飞书入站同一套"每次 start 现取"的做法，
// 用户在设置里改完 token 不必重启 Host。
//
// ── 防环 ────────────────────────────────────────────────────────────────────
// `from.is_bot === true` 的消息**直接丢弃**（与飞书 `sender_type=app` 同一道闸）。
// 没有这条，两个 bot 在同一个群里会互相触发到打爆额度。

/** 官方 API 根（可在测试里换成本地假服务）。 */
export const TELEGRAM_API_ROOT = 'https://api.telegram.org';

/** 长轮询等多久（秒）。Telegram 上限 50s；我们用 25s，留出网络抖动余量。 */
export const TELEGRAM_POLL_TIMEOUT_SEC = 25;

/* 图片判定统一在 `media.js`（与 Discord 共用一份，避免两边漂移）。
   这里 **re-export** 是为了不破坏既有导入：单测、gateway 都从本文件取 `imageMediaTypeOf`。 */
import { buildMultipartFormData, imageExtensionOf, imageMediaTypeOf } from './media.js';
export { imageMediaTypeOf };

/**
 * 统一解析 Telegram 的 `{ ok, description, parameters }` 信封（失败如实抛）。
 *
 * ⚠ 做成**文件级函数**而不是对象方法：对象方法要靠 `this`，而 `send` 一旦被解构
 *   （`const { send } = adapter`）`this` 就丢了 —— 那种事在重构时很容易发生。
 */
async function telegramCheck(res) {
	const body = await res.json().catch(() => ({}));
	if (!res.ok || body?.ok !== true) {
		/* 429 带 retry_after：如实报出去，由上层决定是否退避（不要在适配器里静默重试） */
		const hint = body?.parameters?.retry_after ? `（retry_after=${body.parameters.retry_after}s）` : '';
		throw new Error(`telegram 出站失败：${body?.description || ('HTTP ' + res.status)}${hint}`);
	}
	return { messageId: body?.result?.message_id };
}

function httpError(status, message) {
	const e = new Error(message);
	e.httpStatus = status;
	return e;
}

/**
 * 出站：`sendMessage`（纯文本）。
 * `ctx.chatId` 由绑定提供；`ctx.botToken` 优先，其次走 `getCreds()`。
 */
export function createTelegramAdapter(options = {}) {
	const apiRoot = String(options.apiRoot || TELEGRAM_API_ROOT).replace(/\/+$/, '');
	const fetchImpl = options.fetchImpl || ((...a) => fetch(...a));
	const getCreds = typeof options.getCreds === 'function' ? options.getCreds : async () => ({});

	return {
		id: 'telegram',
		name: 'Telegram',
		/**
		 * 出站。`images` 可选（2026-10-27 富媒体）：`[{ mediaType, data(base64), name }]`。
		 *
		 * 策略：
		 *   · 有图 ⇒ 先 `sendPhoto`（图 + caption）
		 *   · 文本超过 caption 上限（1024）⇒ 再 `sendMessage` 发全文（**不截断丢内容**）
		 *   · 无图 ⇒ 原 `sendMessage`
		 *   · 多张图：只发第一张（Telegram 单条只能一张；多张要 mediaGroup，本轮不做）
		 */
		async send(ctx, text, images) {
			let token = String(ctx?.botToken ?? '').trim();
			if (!token) {
				const creds = await getCreds().catch(() => ({}));
				token = String(creds?.values?.botToken ?? creds?.botToken ?? '').trim();
			}
			if (!token) {
				throw new Error('unavailable：缺少 telegram botToken（在「设置 → 渠道」里填）');
			}
			const chatId = String(ctx?.chatId ?? '').trim();
			if (!chatId) {
				throw new Error('telegram 出站失败：缺少 chatId');
			}
			const full = String(text ?? '');
			const pics = (Array.isArray(images) ? images : []).filter((x) => x && x.data);
			const first = pics[0] || null;

			if (!first) {
				const res = await fetchImpl(`${apiRoot}/bot${token}/sendMessage`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ chat_id: chatId, text: full, disable_web_page_preview: true }),
				});
				return telegramCheck(res);
			}

			const mediaType = imageMediaTypeOf(first.mediaType) || 'image/jpeg';
			const caption = full.length > 1024 ? '' : full;
			const form = buildMultipartFormData(
				{ chat_id: chatId, ...(caption ? { caption } : {}) },
				{
					field: 'photo',
					filename: first.name || ('image.' + imageExtensionOf(mediaType)),
					mimeType: mediaType,
					buffer: Buffer.from(String(first.data), 'base64'),
				},
			);
			const res = await fetchImpl(`${apiRoot}/bot${token}/sendPhoto`, {
				method: 'POST',
				headers: { 'content-type': form.contentType },
				body: form.body,
			});
			const sent = await telegramCheck(res);
			/* caption 装不下（>1024）⇒ 全文另发一条，避免"发图成功但用户看不到正文" */
			if (!caption && full.trim()) {
				const res2 = await fetchImpl(`${apiRoot}/bot${token}/sendMessage`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ chat_id: chatId, text: full, disable_web_page_preview: true }),
				});
				await telegramCheck(res2);
			}
			return sent;
		},
	};
}

/**
 * 把一条 Telegram update 归一成我们的入站消息。
 *
 * 返回 `{ kind: 'message', message }` 或 `{ kind: 'ignore', reason }`：
 *   ignore 的 reason 会进日志（`from-app` / `no-text` / `unsupported-chat`）。
 */
export function parseTelegramUpdate(update, options = {}) {
	const botUsername = String(options.botUsername ?? '').replace(/^@/, '').trim().toLowerCase();
	const upd = update || {};
	const msg = upd.message || upd.edited_message || upd.channel_post;
	if (!msg) {
		return { kind: 'ignore', reason: 'no-message' };
	}
	const from = msg.from || {};
	/* ★ 防环：机器人发的消息直接丢（与飞书 `sender_type=app` 同一道闸） */
	if (from.is_bot === true) {
		return { kind: 'ignore', reason: 'from-app' };
	}
	const chat = msg.chat || {};
	const chatTypeRaw = String(chat.type || '');
	const chatType = chatTypeRaw === 'private' ? 'p2p' : (chatTypeRaw === 'group' || chatTypeRaw === 'supergroup' ? 'group' : '');
	if (!chatType) {
		return { kind: 'ignore', reason: 'unsupported-chat' };
	}
	/* ★ 2026-10-27 富媒体：先看有没有图片，再判"整条消息有没有内容"。
	   Telegram 的 `photo` 是**多档尺寸数组**（同一张图），取最后一档 = 最大档；
	   `document` 只有 mime 是 image/* 才当图片（pdf/zip 不处理 —— 不把二进制塞进 prompt）。 */
	const photos = Array.isArray(msg.photo) ? msg.photo.filter((p) => p && p.file_id) : [];
	const doc = (msg.document && String(msg.document.mime_type || '').toLowerCase().startsWith('image/'))
		? msg.document : null;
	const attachments = [];
	if (photos.length) {
		const biggest = photos[photos.length - 1];
		attachments.push({
			kind: 'image',
			fileId: String(biggest.file_id),
			mimeType: 'image/jpeg',        // Telegram 的 photo 恒为 jpeg（服务端转码过）
			size: Number(biggest.file_size) || 0,
			fileName: '',
		});
	} else if (doc) {
		attachments.push({
			kind: 'image',
			fileId: String(doc.file_id),
			mimeType: String(doc.mime_type).toLowerCase(),
			size: Number(doc.file_size) || 0,
			fileName: String(doc.file_name || ''),
		});
	}
	const text = String(msg.text ?? msg.caption ?? '');
	if (!text && !attachments.length) {
		return { kind: 'ignore', reason: 'no-text' };
	}

	/* @ 判定：文本里出现 `@botUsername`（最可靠），否则看 entities 里有没有 mention。
	   ⚠ 没配 botUsername 时退化成"有 mention 即算 @" —— 与飞书侧同一近似，理由也同一句：
	     我们不一定知道自己的 username，但**有 mention 至少说明有人在叫某个 bot**。 */
	const lower = text.toLowerCase();
	const entities = Array.isArray(msg.entities) ? msg.entities : [];
	const hasMentionEntity = entities.some((e) => e && e.type === 'mention');
	const mentionsBot = botUsername
		? lower.includes('@' + botUsername)
		: hasMentionEntity;

	const repliedFrom = msg.reply_to_message && msg.reply_to_message.from ? msg.reply_to_message.from : null;
	const repliesToBot = !!(repliedFrom && repliedFrom.is_bot === true);

	return {
		kind: 'message',
		message: {
			platform: 'telegram',
			chatId: String(chat.id ?? ''),
			chatType,
			chatName: String(chat.title || chat.username || ''),
			messageId: String(msg.message_id ?? ''),
			userId: String(from.id ?? ''),
			userName: String(from.username || from.first_name || ''),
			/* 纯图片消息没有文本 ⇒ 给一个占位，下游的策略与派发仍然按"有内容"处理 */
			content: text || '[图片]',
			attachments,
			mentionsBot,
			repliesToBot,
			raw: upd,
		},
	};
}

/**
 * 长轮询传输层：只负责"取一批 update"，不管理循环与状态（那部分在 gateway 里）。
 * 拆开是为了单测能喂假的 `fetchImpl`，也能在真机换成本地假服务。
 */
export function createHttpTransport(options = {}) {
	const apiRoot = String(options.apiRoot || TELEGRAM_API_ROOT).replace(/\/+$/, '');
	const fetchImpl = options.fetchImpl || ((...a) => fetch(...a));
	const getCreds = typeof options.getCreds === 'function' ? options.getCreds : async () => ({});

	async function tokenOf() {
		const creds = await getCreds().catch(() => ({}));
		const token = String(creds?.values?.botToken ?? creds?.botToken ?? '').trim();
		if (!token) {
			throw new Error('unavailable：缺少 telegram botToken（在「设置 → 渠道」里填）');
		}
		return token;
	}

	return {
		async getUpdates({ offset = 0, timeoutSec = TELEGRAM_POLL_TIMEOUT_SEC } = {}) {
			const token = await tokenOf();
			const url = `${apiRoot}/bot${token}/getUpdates?timeout=${Number(timeoutSec)}`
				+ (offset ? `&offset=${Number(offset)}` : '');
			const res = await fetchImpl(url, { method: 'GET' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body?.ok !== true) {
				throw new Error(`telegram getUpdates 失败：${body?.description || ('HTTP ' + res.status)}`);
			}
			return Array.isArray(body.result) ? body.result : [];
		},
		/** 取 bot 自己的 username（用于群内 @ 判定）。拿不到就返回空串，不抛。 */
		async getMe() {
			try {
				const token = await tokenOf();
				const res = await fetchImpl(`${apiRoot}/bot${token}/getMe`, { method: 'GET' });
				const body = await res.json().catch(() => ({}));
				return body?.ok === true ? String(body.result?.username || '') : '';
			} catch {
				return '';
			}
		},
		/**
		 * 下载一个文件（图片用）。两步：`getFile` 换临时路径 → 取流。
		 * ⚠ Telegram 的文件 URL 里**带 token**：拼接时不要 encode 整个 URL，也不要写进日志。
		 */
		async download(fileId) {
			const token = await tokenOf();
			const meta = await fetchImpl(`${apiRoot}/bot${token}/getFile?file_id=${encodeURIComponent(String(fileId))}`, { method: 'GET' });
			const mj = await meta.json().catch(() => ({}));
			if (!meta.ok || mj?.ok !== true || !mj.result?.file_path) {
				throw new Error(`telegram getFile 失败：${mj?.description || ('HTTP ' + meta.status)}`);
			}
			const filePath = String(mj.result.file_path);
			const res = await fetchImpl(`${apiRoot}/file/bot${token}/${filePath}`, { method: 'GET' });
			if (!res.ok) { throw new Error(`telegram 下载失败：HTTP ${res.status}`); }
			const buffer = Buffer.from(await res.arrayBuffer());
			return { buffer, filePath };
		},
	};
}

/**
 * 入站网关：长轮询循环 + 退避 + 状态。
 *
 * 状态形状与飞书网关**保持一致**（`{ status, attempts, lastError, lastEventAt }`），
 * 这样配置页的「入站状态」那块不用为每个平台写一套渲染。
 */
export function createTelegramGateway(options = {}) {
	const transport = options.transport;
	const onMessage = typeof options.onMessage === 'function' ? options.onMessage : async () => undefined;
	const log = typeof options.log === 'function' ? options.log : () => undefined;
	const now = typeof options.now === 'function' ? options.now : () => Date.now();
	const pollTimeoutSec = Number(options.pollTimeoutSec ?? TELEGRAM_POLL_TIMEOUT_SEC);

	const st = { status: 'idle', attempts: 0, lastError: '', lastEventAt: 0, offset: 0 };
	let running = false;
	let stopped = true;
	let botUsername = '';
	let timer = null;

	function schedule(delayMs, fn) {
		timer = setTimeout(() => { timer = null; void fn(); }, Math.max(0, delayMs));
		if (timer && typeof timer.unref === 'function') { timer.unref(); }
	}

	/** 处理一条 update（offset 推进 + 解析 + 派发 + 失败只记日志）。
	 *  ⚠ start 的首拉和 loop 必须**共用**这一处：否则某一侧会漏掉日志/漏推 offset。 */
	async function handleOne(u) {
		const id = Number(u?.update_id);
		if (Number.isFinite(id)) { st.offset = Math.max(st.offset, id + 1); }
		const parsed = parseTelegramUpdate(u, { botUsername });
		if (parsed.kind === 'ignore') {
			if (parsed.reason !== 'no-message') {
				log('info', `telegram 入站忽略（${parsed.reason}）`);
			}
			return;
		}
		st.lastEventAt = now();
		/* ★ 2026-10-27 富媒体：把图片下成 base64 挂到 msg.images（下游只认 mediaType + data）。
		   ⚠ 每张最多 5MB、每条最多 2 张：prompt 要装得下，且 IM 用户随手发的大图很常见。
		   ⚠ 单张下载失败只记日志（不能因为一张图让整条消息丢掉）。 */
		const atts = Array.isArray(parsed.message.attachments) ? parsed.message.attachments : [];
		if (atts.length && typeof transport.download === 'function') {
			const images = [];
			for (const a of atts.slice(0, 2)) {
				const mediaType = imageMediaTypeOf(a.mimeType);
				if (!mediaType) { log('info', `telegram 图片类型不支持（${a.mimeType}），跳过`); continue; }
				try {
					const f = await transport.download(a.fileId);
					if (f.buffer.length > 5 * 1024 * 1024) { log('info', `telegram 图片过大（${f.buffer.length} B），跳过`); continue; }
					images.push({ mediaType, data: f.buffer.toString('base64'), name: a.fileName || '' });
				} catch (e) {
					log('warn', `telegram 图片下载失败：${String((e && e.message) || e)}`);
				}
			}
			if (images.length) { parsed.message.images = images; }
		}
		try {
			await onMessage(parsed.message);
		} catch (e) {
			log('warn', `telegram 入站处理失败：${String((e && e.message) || e)}`);
		}
	}

	async function loop() {
		if (stopped) { return; }
		try {
			const updates = await transport.getUpdates({ offset: st.offset, timeoutSec: pollTimeoutSec });
			/* ★ 竞争：拉取期间可能已被 stop（甚至 stop 就发生在这段 await 里）
			   ⇒ 先看 stopped，别把状态写回 ready —— 否则界面显示"已连接"但实际不再轮询。 */
			if (stopped) { return; }
			st.status = 'ready';
			st.lastError = '';
			if (st.attempts) { st.attempts = 0; }
			for (const u of updates) {
				await handleOne(u);
			}
			schedule(300, loop);   // 长轮询正常返回后稍等再拉（避免空转烧 CPU）
		} catch (e) {
			st.attempts += 1;
			st.lastError = String((e && e.message) || e);
			st.status = 'error';
			const backoff = Math.min(30_000, 1000 * (2 ** Math.min(st.attempts, 5)));
			log('warn', `telegram 长轮询失败（第 ${st.attempts} 次）：${st.lastError}；${Math.round(backoff / 1000)}s 后重试`);
			schedule(backoff, loop);
		}
	}

	return {
		state() {
			return {
				status: st.status,
				attempts: st.attempts,
				lastError: st.lastError,
				lastEventAt: st.lastEventAt,
				offset: st.offset,
				botUsername,
			};
		},
		async start() {
			if (running) {
				return this.state();
			}
			stopped = false;
			/* 先拿 username（@ 判定要用）；拿不到不阻塞启动 */
			if (typeof transport.getMe === 'function') {
				botUsername = await transport.getMe().catch(() => '');
			}
			try {
				const updates = await transport.getUpdates({ offset: st.offset, timeoutSec: 0 });
				/* ★ 竞争：拉取期间可能已被 stop（甚至 stop 就发生在这段 await 里）
				   ⇒ 先看 stopped，别把状态写回 ready —— 否则界面显示"已连接"但实际不再轮询。 */
				if (stopped) { return; }
				st.status = 'ready';
				st.lastError = '';
				st.attempts = 0;
				// 首次拉到的积压也按顺序处理（offset 会推进）
				for (const u of updates) {
					await handleOne(u);
				}
			} catch (e) {
				st.status = 'error';
				st.lastError = String((e && e.message) || e);
				st.attempts = 1;
				running = false;
				stopped = true;
				throw e;              // ← 起不来就如实抛（不要"假装在连"）
			}
			running = true;
			schedule(300, loop);
			return this.state();
		},
		async stop() {
			stopped = true;
			running = false;
			if (timer) { clearTimeout(timer); timer = null; }
			st.status = 'stopped';
			return this.state();
		},
	};
}
