// @vssaros/dsh-agents — 企业微信适配器（2026-10-27，第四个渠道；**入站依赖公网回调**）
//
// ── 与前三者的关键差异（这决定它只能做成"骨架"）──────────────────────────────
//   飞书 / Telegram / Discord 的入站都是**我们去连**（WS 或轮询）⇒ 本机就能收。
//   企业微信的入站是**别人来连我们**：企业微信服务器要把消息 POST 到你的回调 URL，
//   所以必须有**公网可达的地址 + 备案域名**（企业微信还要求域名校验）。
//   ⇒ 本模块提供：出站（真能用）、回调验签 / 解密 / 解析 / 回包加密（**可离线单测**）。
//     缺的只有"把公网请求转进来"那一步 —— 需要用户自己反代到本插件的路由。
//
// ── 出站 ──────────────────────────────────────────────────────────────────
//   ① GET  /cgi-bin/gettoken?corpid=&corpsecret=       → access_token（7200s）
//   ② POST /cgi-bin/message/send?access_token=          → { touser, msgtype:'text', agentid, text:{content} }
//   ⚠ access_token 要缓存（7200s，且**取太勤会被限流**）；这里缓存到过期前 5 分钟。
//   ⚠ 主动发消息受"应用可见范围"限制：`touser` 必须是该应用的可见成员（或 `@all`）。
//
// ── 入站（回调）────────────────────────────────────────────────────────────
//   GET  验证：`?msg_signature=&timestamp=&nonce=&echostr=` ⇒ **解密 echostr** 后原样返回明文
//   POST 消息：body 是 XML，关键字段 `<Encrypt>`（AES 密文）；`msg_signature` 要验
//   回包（被动回复）也必须加密 ⇒ `encryptWecomReply()`
//
// ── 加密算法（官方口径，逐条写清，因为它没有任何"大概"的余地）─────────────────
//   key  = Base64Decode(EncodingAESKey + '=')         // 43 字符 → 32 字节
//   iv   = key[0..16]
//   明文 = random(16) + msgLen(4 字节，**大端**) + msg + corpId
//   补位 = PKCS7，块长 **32**
//   密文 = Base64(AES-256-CBC(key, iv, 补位后明文))
//  签名 = sha1( sort([token, timestamp, nonce, encrypt]).join('') )   // 字典序排序后拼接
//
// ⚠ 解密后必须校验**尾部的 corpId**：不然别的企业的密文也能解出合法结构（跨企业投递）。

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const WECOM_API_ROOT = 'https://qyapi.weixin.qq.com/cgi-bin';
/** access_token 有效期 7200s；留 5 分钟余量，避免"刚好过期"的边界。 */
const TOKEN_TTL_MS = (7200 - 300) * 1000;
const PKCS7_BLOCK = 32;

function httpError(status, message) {
	return Object.assign(new Error(message), { httpStatus: status });
}

/* ══ 加密 / 验签（纯函数，最好测）═══════════════════════════════════════════════ */

/** 由 43 字符 EncodingAESKey 解出 32 字节 key。 */
export function wecomKeyOf(encodingAesKey) {
	const raw = String(encodingAesKey ?? '').trim();
	if (raw.length !== 43) {
		throw new Error(`EncodingAESKey 必须是 43 字符（当前 ${raw.length}）`);
	}
	const key = Buffer.from(raw + '=', 'base64');
	if (key.length !== 32) {
		throw new Error(`EncodingAESKey 解出的 key 必须是 32 字节（当前 ${key.length}）`);
	}
	return key;
}

/**
 * 回调签名：`sha1(sort([token, timestamp, nonce, encrypt]).join(''))`。
 * 注意是**字典序排序**，不是按参数顺序 —— 这是最容易写错的一步。
 */
export function wecomSignature(token, timestamp, nonce, encrypt) {
	const parts = [String(token ?? ''), String(timestamp ?? ''), String(nonce ?? ''), String(encrypt ?? '')]
		.map((x) => x.trim())
		.sort();
	return createHash('sha1').update(parts.join(''), 'utf8').digest('hex');
}

/** 定长比较（避免按字符前缀提前返回）。 */
function safeEqual(a, b) {
	const x = String(a ?? '').toLowerCase();
	const y = String(b ?? '').toLowerCase();
	if (x.length !== y.length) { return false; }
	let diff = 0;
	for (let i = 0; i < x.length; i += 1) { diff |= x.charCodeAt(i) ^ y.charCodeAt(i); }
	return diff === 0;
}

/** 校验回调签名（`msg_signature` 与 `signature` 两种来源都用同一算法）。 */
export function verifyWecomSignature({ token, timestamp, nonce, encrypt, signature }) {
	if (!String(token ?? '').trim()) { return false; }
	return safeEqual(wecomSignature(token, timestamp, nonce, encrypt), signature);
}

/**
 * 解密一条密文（回调 body 的 `<Encrypt>`，或 GET 验证的 `echostr`）。
 *
 * @param options.corpId 必须给：解密后要校验尾部，防跨企业投递
 */
export function decryptWecomMessage(encrypt, encodingAesKey, options = {}) {
	const key = wecomKeyOf(encodingAesKey);
	const iv = key.subarray(0, 16);
	const buf = Buffer.from(String(encrypt ?? ''), 'base64');
	if (buf.length < 16 + 4 + 1 + PKCS7_BLOCK) {
		throw new Error('密文长度异常（太短）');
	}
	const decipher = createDecipheriv('aes-256-cbc', key, iv);
	decipher.setAutoPadding(false);
	const plain = Buffer.concat([decipher.update(buf), decipher.final()]);
	/* PKCS7 去补位（块长 32）：末字节是补位长度 */
	const pad = plain[plain.length - 1];
	if (pad < 1 || pad > PKCS7_BLOCK || pad > plain.length) {
		throw new Error('补位非法（可能 key 不对）');
	}
	const body = plain.subarray(0, plain.length - pad);
	const msgLen = body.readUInt32BE(16);            // 大端：random(16) 之后是 4 字节长度
	const start = 20;
	const end = start + msgLen;
	if (end > body.length) {
		throw new Error('消息长度越界（可能 key 或 corpId 不对）');
	}
	const msg = body.subarray(start, end).toString('utf8');
	const corpId = body.subarray(end).toString('utf8');
	const expect = String(options.corpId ?? '').trim();
	if (expect && corpId !== expect) {
		/* 这条极重要：不校验的话，别的企业的密文也能解出"结构合法"的明文 */
		throw new Error(`corpId 不匹配（密文里是 ${corpId || '(空)'}，期望 ${expect}）`);
	}
	return { msg, corpId };
}

/** 加密（被动回复必须加密，否则企业微信侧报 40008）。 */
export function encryptWecomMessage(msg, encodingAesKey, corpId) {
	const key = wecomKeyOf(encodingAesKey);
	const iv = key.subarray(0, 16);
	const msgBuf = Buffer.from(String(msg ?? ''), 'utf8');
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(msgBuf.length, 0);
	const head = Buffer.concat([randomBytes(16), lenBuf]);
	let plain = Buffer.concat([head, msgBuf, Buffer.from(String(corpId ?? ''), 'utf8')]);
	const pad = PKCS7_BLOCK - (plain.length % PKCS7_BLOCK);
	plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
	const cipher = createCipheriv('aes-256-cbc', key, iv);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/* ══ XML（企业微信的回调是 XML，且字段都包在 CDATA 里）══════════════════════════ */

/**
 * 极简 XML 取值：只认 `<Tag><![CDATA[...]]></Tag>` 与 `<Tag>...</Tag>` 两种。
 *
 * 为什么手写而不引依赖：我们要取的字段是**固定的几个**，且企业微信的 XML 结构稳定；
 * 为它引一个 XML 库不划算，而正则在这个受限形状上是安全的（不解析任意嵌套）。
 */
export function xmlField(xml, tag) {
	const src = String(xml ?? '');
	const cdata = new RegExp('<' + tag + '>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</' + tag + '>', 'i');
	const m1 = cdata.exec(src);
	if (m1) { return m1[1]; }
	const plain = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i');
	const m2 = plain.exec(src);
	return m2 ? m2[1].trim() : '';
}

/** 回调外层信封：`{ ToUserName, Encrypt, AgentID }`。 */
export function parseWecomEnvelope(xml) {
	return {
		toUserName: xmlField(xml, 'ToUserName'),
		encrypt: xmlField(xml, 'Encrypt'),
		agentId: xmlField(xml, 'AgentID'),
	};
}

/**
 * 解密后的消息体 → 我们的 msg 形状（与其它渠道同构）。
 *
 * 企业微信的 `FromUserName` 是**成员 UserID**（不是昵称）；私聊/群聊在回调里没有
 * `ChatType`（群机器人才有），所以这里按 `ChatId` 是否存在判群。
 */
export function parseWecomMessage(xml, options = {}) {
	const msgType = String(xmlField(xml, 'MsgType') || '').toLowerCase();
	const from = xmlField(xml, 'FromUserName');
	const chatId = xmlField(xml, 'ChatId') || (options.fallbackChatId ? String(options.fallbackChatId) : from);
	if (msgType !== 'text') {
		/* `event`（进群/关注等）与 `image`/`voice` 都走这里 —— 不再单独判 event：
		   它本来就是 MsgType 的一个取值，单独判是死代码。 */
		return { ignored: true, reason: msgType === 'event' ? 'event' : 'non-text', note: `MsgType=${msgType || '(空)'}` };
	}
	const content = String(xmlField(xml, 'Content') || '').trim();
	if (!content) {
		return { ignored: true, reason: 'empty-content' };
	}
	return {
		ignored: false,
		msg: {
			platform: 'wecom',
			chatId: String(chatId),
			chatType: xmlField(xml, 'ChatId') ? 'group' : 'p2p',
			messageId: String(xmlField(xml, 'MsgId') || ''),
			userId: String(from),
			userName: String(from),
			content,
			/* 群机器人回调里没有 mention 概念（群里要 @ 才推送，能收到就说明已经 @ 了） */
			mentionsBot: true,
			fromIsBot: false,
			agentId: String(xmlField(xml, 'AgentID') || options.agentId || ''),
			raw: { MsgType: msgType, FromUserName: from },
		},
	};
}

/** 被动回复的 XML（会被加密后放进 `<Encrypt>`）。 */
export function buildWecomReplyXml({ toUser, fromUser, content, timestamp = Math.floor(Date.now() / 1000) }) {
	/* ⚠ CDATA 段里**不能**用实体转义：CDATA 不解析 `&gt;`，接收方会看到字面量 `]]&gt;`（内容被改）。
	   标准做法是把 `]]>` 拆成两段 CDATA：`]]]]><![CDATA[>` —— 解析后仍然是 `]]>`。
	   （实际业务里 AI 回复几乎不含 `]]>`，但这是正确性问题，不能靠"应该不会遇到"。） */
	const safe = (v) => String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
	return '<xml>'
		+ `<ToUserName><![CDATA[${safe(toUser)}]]></ToUserName>`
		+ `<FromUserName><![CDATA[${safe(fromUser)}]]></FromUserName>`
		+ `<CreateTime>${Number(timestamp) || 0}</CreateTime>`
		+ '<MsgType><![CDATA[text]]></MsgType>'
		+ `<Content><![CDATA[${safe(content)}]]></Content>`
		+ '</xml>';
}

/* ══ 出站适配器 ═════════════════════════════════════════════════════════════ */

/**
 * 出站：换 access_token（带缓存）+ `message/send`。
 *
 * `touser` 取 `ctx.chatId`：对企业微信来说它就是**成员 UserID**（或 `@all`）。
 * ⚠ 主动消息受"应用可见范围"限制，且非客服消息有频次限制 —— 失败原因原样抛出。
 */
export function createWecomAdapter(options = {}) {
	const resolve = typeof options.resolve === 'function' ? options.resolve : async () => options;
	const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
	const now = typeof options.now === 'function' ? options.now : () => Date.now();
	/* 缓存按 corpId|secret 分键：换凭据要立刻失效，不能命中旧 token */
	const tokenCache = new Map();

	async function accessTokenOf(corpId, secret) {
		const key = corpId + '|' + secret;
		const hit = tokenCache.get(key);
		if (hit && hit.expiresAt > now()) { return hit.token; }
		const url = `${WECOM_API_ROOT}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
		const res = await fetchImpl(url);
		const raw = await res.text().catch(() => '');
		let j = null;
		try { j = JSON.parse(raw); } catch { j = null; }
		if (!res.ok || !j || Number(j.errcode ?? 0) !== 0 || !j.access_token) {
			throw new Error(`wecom 换 token 失败：${(j && j.errmsg) || ('HTTP ' + res.status)}`);
		}
		tokenCache.set(key, { token: String(j.access_token), expiresAt: now() + TOKEN_TTL_MS });
		return String(j.access_token);
	}

	return {
		id: 'wecom',
		/** 仅测试用：清空 token 缓存。 */
		__clearTokenCache() { tokenCache.clear(); },
		async send(ctx, text) {
			const creds = (await resolve().catch(() => null)) || {};
			const corpId = String(creds.corpId ?? '').trim();
			const secret = String(creds.secret ?? creds.appSecret ?? '').trim();
			const agentId = String(creds.agentId ?? '').trim();
			if (!corpId || !secret) {
				throw new Error('unavailable：缺少 Corp ID / Secret（企业微信管理后台 → 应用管理）');
			}
			if (!agentId) {
				throw new Error('unavailable：缺少 Agent ID（应用详情里的 AgentId）');
			}
			const toUser = String(ctx?.chatId ?? '').trim();
			if (!toUser) { throw new Error('wecom：缺 chatId（成员 UserID 或 @all）'); }
			const body = String(text ?? '');
			if (!body.trim()) { return { ok: true, skipped: 'empty' }; }

			const token = await accessTokenOf(corpId, secret);
			const res = await fetchImpl(`${WECOM_API_ROOT}/message/send?access_token=${encodeURIComponent(token)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ touser: toUser, msgtype: 'text', agentid: Number(agentId) || agentId, text: { content: body } }),
			});
			const raw = await res.text().catch(() => '');
			let j = null;
			try { j = JSON.parse(raw); } catch { j = null; }
			const errcode = Number((j && j.errcode) ?? 0);
			if (!res.ok || errcode !== 0) {
				/* 42001 = access_token 过期 ⇒ 丢掉缓存，下次重取（不改这次的结果） */
				if (errcode === 42001) { tokenCache.delete(corpId + '|' + secret); }
				throw new Error(`wecom 发送失败：${(j && j.errmsg) || ('HTTP ' + res.status)}${errcode ? '（errcode ' + errcode + '）' : ''}`);
			}
			return { ok: true };
		},
	};
}

/* ══ 回调处理器（GET 验证 + POST 收消息）══════════════════════════════════════════ */

/**
 * 处理一次企业微信回调。
 *
 * 返回 `{ status, body, msg? }`：调用方把 `status`/`body` 原样写回 HTTP 即可。
 *
 * @param options.token  回调 Token（后台配置的那个）
 * @param options.encodingAesKey 43 字符
 * @param options.corpId
 * @param options.onMessage  收到文本消息时调用（与其它渠道同一个 handleInbound）
 */
export async function handleWecomCallback(options, input = {}) {
	const { token, encodingAesKey, corpId, onMessage, log = () => undefined } = options;
	const method = String(input.method || 'GET').toUpperCase();
	const query = input.query || {};
	const bodyXml = String(input.body || '');

	if (!token || !encodingAesKey || !corpId) {
		return { status: 503, body: 'wecom 回调未配置（缺 token / EncodingAESKey / corpId）' };
	}

	/* ── GET：URL 验证（解密 echostr 后原样返回明文）── */
	if (method === 'GET') {
		const echostr = String(query.echostr ?? '');
		const sig = String(query.msg_signature ?? query.signature ?? '');
		if (!echostr) { return { status: 400, body: 'missing echostr' }; }
		if (!verifyWecomSignature({ token, timestamp: query.timestamp, nonce: query.nonce, encrypt: echostr, signature: sig })) {
			return { status: 401, body: 'bad signature' };
		}
		try {
			const { msg } = decryptWecomMessage(echostr, encodingAesKey, { corpId });
			/* 明文就是 echostr 的内容，验证通过必须**原样**回（企业微信会比对） */
			return { status: 200, body: msg, plain: true };
		} catch (e) {
			log('wecom GET 解密失败：' + String((e && e.message) || e));
			return { status: 400, body: 'decrypt failed' };
		}
	}

	/* ── POST：消息推送 ── */
	const env = parseWecomEnvelope(bodyXml);
	if (!env.encrypt) { return { status: 400, body: 'missing Encrypt' }; }
	const sig = String(query.msg_signature ?? query.signature ?? '');
	if (!verifyWecomSignature({ token, timestamp: query.timestamp, nonce: query.nonce, encrypt: env.encrypt, signature: sig })) {
		return { status: 401, body: 'bad signature' };
	}
	let inner = '';
	try {
		const r = decryptWecomMessage(env.encrypt, encodingAesKey, { corpId });
		inner = r.msg;
	} catch (e) {
		log('wecom POST 解密失败：' + String((e && e.message) || e));
		return { status: 400, body: 'decrypt failed' };
	}
	const parsed = parseWecomMessage(inner, { agentId: env.agentId });
	if (parsed.ignored) {
		log('wecom 忽略一条：' + parsed.reason + (parsed.note ? '（' + parsed.note + '）' : ''));
		/* 企业微信要求 5s 内回 200，否则重试；"忽略"也算处理完了 ⇒ 回空串（不回包 = 不回复） */
		return { status: 200, body: '', ignored: parsed.reason };
	}
	if (typeof onMessage === 'function') {
		/* 消息处理失败不能把 200 变成 500（否则企业微信会重投同一条） */
		try { await onMessage(parsed.msg); } catch (e) { log('wecom 派发失败：' + String((e && e.message) || e)); }
	}
	return { status: 200, body: '', msg: parsed.msg };
}
