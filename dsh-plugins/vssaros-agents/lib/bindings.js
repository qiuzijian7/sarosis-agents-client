// @vssaros/dsh-agents — IM 绑定（P0）
//
// ── 这个模块解决什么 ────────────────────────────────────────────────────────
// 已有的 `vssaros-channels` 插件把「一个 IM 会话 ⇄ 一条匿名 dsh 会话」跑通了，
// 但它**不认识我们的 bot 和群**。本模块补上那一层：把 **指定的 bot / 群** 与
// **指定的 IM 会话** 绑起来，双向流转。
//
//   IM 平台 ──适配器──> 入站事件 ──> [binding 表] ──> dispatchAgent / dispatchGroup
//      ▲                                   │                      │
//      └──────────── 出站（deliver）──── 回复回收 <────────────────┘
//
// ── 适配器端口 ──────────────────────────────────────────────────────────────
// 与 `vssaros-channels/lib/core/ports.js` **同形**（`{ id, name, send(ctx,text) }`），
// 所以将来飞书适配器可以直接搬过来用，这里的路由一行不改 —— 这就是留这个接缝的目的。
//
// ── P0 的范围（明确不做）────────────────────────────────────────────────────
// · 不做飞书真实适配器（要 app 凭据 + 长连接；P2 接入）
// · 幂等表只在内存（有界 500 条）—— Host 重启会丢；P2 落盘
// · 出站只做纯文本分段（图片/卡片 P4）
//
// ── 三条安全默认（都是 fail-closed）────────────────────────────────────────
// ① 白名单为空 ⇒ **拒绝所有**（与 channels 的 allowFrom 口径一致）
// ② 绑定只能由**人**创建/修改/删除（bot 不能把自己的输出外发到外部 IM）
// ③ 群聊默认 `mentionPolicy='at'`：没 @ 到 bot 的消息不处理
import { renameWithRetry } from './atomicWrite.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';
import { listDeadLetters, removeDeadLetter } from './deadLetters.js';
import { outboxNote } from './outbox.js';
import { AGENT_MESSAGE_KIND } from './core/relay.js';
import { clipDispatchText, dispatchModeOf, normalizeActor } from './groups.js';
/* 渠道准入策略（**OpenClaw 同构**）：四态私聊 / 三态群 / 房白名单 / 触发词 / 风暴预算 / 消毒。
   纯函数、无 IO ⇒ 能被 Hub、探针、以及未来的任何渠道层复用（这也是"复刻语义而非渠道"的落点）。 */
import { DM_POLICIES, GROUP_POLICIES, createLoopGuard, decideInbound, sanitizeInbound } from './channelPolicy.js';

const FILE_NAME = 'agent-bindings.json';

/** 支持的平台。`loopback` 是**测试/演练**适配器（进程内，不需要真实凭据）。 */
export const BINDING_PLATFORMS = ['discord', 'feishu', 'loopback', 'telegram', 'wecom'];
/** 方向：`in` = 只 IM→我们；`out` = 只我们→IM；`both` = 双向。 */
export const BINDING_DIRECTIONS = ['both', 'in', 'out'];
/** 群里什么消息才算给 bot：`at` 只认 @；`all` 全部消息。 */
export const BINDING_MENTION_POLICIES = ['at', 'all'];
/** 出站单条长度上限（保守值；飞书实际更大，但分段小一点更容易读）。 */
export const OUT_SEGMENT_CHARS = 3000;
/** 入站幂等表容量（有界，避免无限增长）。 */
export const SEEN_KEEP = 500;

function httpError(status, message) {
	const e = new Error(message);
	/* ⚠ 路由层的 catch 读的是 `e.httpStatus`（全插件统一口径）；只设 `status` 会被当成 400。
	   两个都设，避免以后有人改了一边。 */
	e.httpStatus = status;
	e.status = status;
	return e;
}

/** 绑定文件路径（单测直接用）。 */
export function bindingsPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 读绑定表（文件不存在 / 解析失败 ⇒ 空表，不抛）。 */
export async function readBindings(config) {
	try {
		const text = await readFile(bindingsPathOf(config), 'utf8');
		const body = JSON.parse(text);
		return Array.isArray(body?.bindings) ? body.bindings : [];
	} catch {
		return [];
	}
}

/** 原子写（tmp + rename；与 groups 同口径 —— 半截文件会让读方拿到空表）。 */
async function writeBindings(config, bindings) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, bindings }, null, 2);
	JSON.parse(text); // 自证合法
	const target = bindingsPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, 'utf8');
	await renameWithRetry(tmp, target);
}

/** 只有人能动绑定（bot 自绑 = 把内部输出外发，属数据外泄面）。 */
function assertHuman(actor) {
	if (normalizeActor(actor).kind !== 'human') {
		throw httpError(403, '只有人能创建/修改/删除 IM 绑定（bot 不能自绑）。');
	}
}

/** 把用户输入归一成合法绑定（`existing` 给了就是"局部更新"语义）。 */
export function normalizeBinding(input, existing) {
	const cur = existing || {};
	const pick = (key, allowed, fallback) => {
		const raw = input?.[key] === undefined ? cur[key] : input[key];
		const val = String(raw ?? '').trim().toLowerCase();
		return allowed.includes(val) ? val : fallback;
	};
	const platform = pick('platform', BINDING_PLATFORMS, 'loopback');
	const targetKind = String((input?.targetKind === undefined ? cur.targetKind : input.targetKind) ?? '').trim() === 'group'
		? 'group' : 'agent';
	const targetId = String((input?.targetId === undefined ? cur.targetId : input.targetId) ?? '').trim();
	const chatId = String((input?.chatId === undefined ? cur.chatId : input.chatId) ?? '').trim();
	const chatType = String((input?.chatType === undefined ? cur.chatType : input.chatType) ?? 'p2p').trim() === 'group'
		? 'group' : 'p2p';
	const rawAllow = input?.allowFrom === undefined ? cur.allowFrom : input.allowFrom;
	const allowFrom = (Array.isArray(rawAllow) ? rawAllow : String(rawAllow ?? '').split(','))
		.map(s => String(s ?? '').trim()).filter(Boolean);
	/* 飞书出站凭据（P1 只支持「自定义机器人 webhook」）。
	   `webhookSecret` 的语义：`undefined` = 保留原值（局部更新时不误清）；`''` = 显式清除。 */
	const webhookUrl = String((input?.webhookUrl === undefined ? cur.webhookUrl : input.webhookUrl) ?? '').trim();
	const webhookSecret = input?.webhookSecret === undefined
		? String(cur.webhookSecret ?? '')
		: String(input.webhookSecret ?? '');
	/* ★ 2026-10-27 渠道策略字段（OpenClaw 同构）：**必须存下来**，否则判定永远走旧路径。
	   逐个"有才写"：没配 ⇒ 字段不存在 ⇒ `shouldAcceptInbound` 走原来的白名单+@ 逻辑
	   ⇒ 已有绑定行为不变（这点很重要，属性写错会表现为"配了 dmPolicy 但一点用没有"）。 */
	const pickEnumOrUndef = (key, allowed) => {
		const raw = input?.[key] === undefined ? cur[key] : input[key];
		if (raw === undefined || raw === null || !String(raw).trim()) { return undefined; }
		const val = String(raw).trim().toLowerCase();
		return allowed.includes(val) ? val : undefined;
	};
	const listOrUndef = (key) => {
		const raw = input?.[key] === undefined ? cur[key] : input[key];
		if (raw === undefined) { return undefined; }
		const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\n]/))
			.map((s) => String(s ?? '').trim()).filter(Boolean);
		return list.length ? list : undefined;
	};
	const boolOrUndef = (key) => {
		const raw = input?.[key] === undefined ? cur[key] : input[key];
		if (raw === undefined || raw === null) { return undefined; }
		return raw === true || raw === 'true';
	};
	const dmPolicy = pickEnumOrUndef('dmPolicy', DM_POLICIES);
	const groupPolicy = pickEnumOrUndef('groupPolicy', GROUP_POLICIES);
	const rooms = listOrUndef('rooms');
	const groupAllowFrom = listOrUndef('groupAllowFrom');
	const mentionPatterns = listOrUndef('mentionPatterns');
	const requireMention = boolOrUndef('requireMention');
	return {
		webhookUrl,
		webhookSecret,
		platform,
		chatId,
		chatType,
		chatName: String((input?.chatName === undefined ? cur.chatName : input.chatName) ?? '').trim(),
		targetKind,
		targetId,
		direction: pick('direction', BINDING_DIRECTIONS, 'both'),
		mentionPolicy: pick('mentionPolicy', BINDING_MENTION_POLICIES, 'at'),
		allowFrom,
		dispatchMode: dispatchModeOf({ dispatchMode: input?.dispatchMode === undefined ? cur.dispatchMode : input.dispatchMode }),
		enabled: (input?.enabled === undefined ? (cur.enabled === undefined ? true : cur.enabled) : input.enabled) === true,
		/* 有才写（undefined 会被 JSON 丢掉 ⇒ 旧绑定不受影响） */
		...(dmPolicy ? { dmPolicy } : {}),
		...(groupPolicy ? { groupPolicy } : {}),
		...(rooms ? { rooms } : {}),
		...(groupAllowFrom ? { groupAllowFrom } : {}),
		...(mentionPatterns ? { mentionPatterns } : {}),
		...(requireMention === undefined ? {} : { requireMention }),
	};
}

/**
 * 传输层校验（按平台分）。放在服务端而不是前端 —— 前端能绕过，
 * 而"什么都没配却以为绑好了"会静默丢消息。
 *
 * ★ 2026-10-28：飞书 `webhookUrl` **不再是必填**。用户原话「飞书绑定，填 id 应该就可用了吧」
 *   —— 确实如此：dsh 侧已经存了 App ID / App Secret（「设置 → 渠道」），出站走应用模式
 *   （`im/v1/messages`，只要 chat_id）。webhook 只是另一条更省权限的通道。
 *   ⚠ 但仍然 fail-closed：**两条通道都不具备**时报 400，别让人等到真跑一次对话才发现发不出去。
 *     `deps.appConfigured(platform)` 由 index.js 注入（读凭据文件）；没注入（单测/旧调用）⇒ 跳过该项。
 */
async function assertTransport(binding, deps) {
	if (binding.platform !== 'feishu') {
		return;
	}
	const url = String(binding.webhookUrl || '').trim();
	if (url) {
		if (!/^https?:\/\//i.test(url)) {
			throw httpError(400, 'webhookUrl 必须是 http(s) 地址（在飞书群 → 设置 → 群机器人 → 自定义机器人里拿）。');
		}
		return;
	}
	if (deps && typeof deps.appConfigured === 'function') {
		const configured = await deps.appConfigured('feishu').catch(() => false);
		if (!configured) {
			throw httpError(400, '飞书绑定二选一：填自定义机器人 webhook URL，或先在「设置 → 渠道」填 App ID / App Secret（应用模式，机器人需在该会话里）');
		}
	}
}

/** 校验（新建/更新共用）：目标必须存在且是合法组合。 */
async function assertBindingTarget(config, binding, deps) {
	if (!binding.chatId) {
		throw httpError(400, 'chatId 不能为空（IM 侧的会话 id）。');
	}
	if (!binding.targetId) {
		throw httpError(400, 'targetId 不能为空（要绑定哪个 bot / 群）。');
	}
	const scan = await deps.scanAgents(config);
	if (binding.targetKind === 'agent') {
		if (!scan.agents.some(a => String(a.id) === binding.targetId)) {
			throw httpError(400, `没有这个 bot：${binding.targetId}`);
		}
		return;
	}
	if (deps.groupExists && !(await deps.groupExists(config, binding.targetId))) {
		throw httpError(400, `没有这个群：${binding.targetId}`);
	}
}

/** 同一 (platform, chatId) 只能绑一个目标 —— 否则入站不知道该给谁。 */
function assertChatUnique(bindings, binding, selfId) {
	const dup = bindings.find(b => b.id !== selfId
		&& b.platform === binding.platform && b.chatId === binding.chatId);
	if (dup) {
		throw httpError(409, `这个 IM 会话（${binding.platform}:${binding.chatId}）已经绑给 ${dup.targetKind}:${dup.targetId} 了。`);
	}
}

/** 新建绑定。 */
export async function createBinding(config, input, deps) {
	assertHuman(input?.actor);
	const binding = { id: randomUUID(), ...normalizeBinding(input), createdAt: Date.now(), updatedAt: Date.now() };
	await assertTransport(binding, deps);
	await assertBindingTarget(config, binding, deps);
	const bindings = await readBindings(config);
	assertChatUnique(bindings, binding, '');
	await writeBindings(config, [...bindings, binding]);
	return { binding, bindings: [...bindings, binding] };
}

/** 更新绑定（局部字段）。 */
export async function updateBinding(config, input, deps) {
	assertHuman(input?.actor);
	const id = String(input?.id ?? '').trim();
	const bindings = await readBindings(config);
	const idx = bindings.findIndex(b => b.id === id);
	if (idx < 0) {
		throw httpError(404, `没有这个绑定：${id || '(没给 id)'}`);
	}
	const next = { ...bindings[idx], ...normalizeBinding(input, bindings[idx]), updatedAt: Date.now() };
	await assertTransport(next, deps);
	await assertBindingTarget(config, next, deps);
	assertChatUnique(bindings, next, id);
	const out = bindings.slice();
	out[idx] = next;
	await writeBindings(config, out);
	return { binding: next, bindings: out };
}

/** 删除绑定（`id` 或 `(platform, chatId)` 二选一）。 */
export async function deleteBinding(config, input) {
	assertHuman(input?.actor);
	const id = String(input?.id ?? '').trim();
	const platform = String(input?.platform ?? '').trim().toLowerCase();
	const chatId = String(input?.chatId ?? '').trim();
	const bindings = await readBindings(config);
	const out = bindings.filter(b => (id ? b.id !== id
		: !(b.platform === platform && b.chatId === chatId)));
	if (out.length === bindings.length) {
		throw httpError(404, '没找到要删的绑定。');
	}
	await writeBindings(config, out);
	return { bindings: out, removed: bindings.length - out.length };
}

/**
 * 把某条死信的**发送者**加进对应绑定的白名单（2026-10-29）。
 *
 * 为什么做成服务端动作：死信里有 `userId`，而"加白名单"要写绑定 —— 跨两个文件两步，
 * 让用户自己去「最近失败」抄 id、再回绑定页粘贴，正是"消息没反应"这条排查链最常断的地方。
 *
 * 语义（每条都别放松）：
 *   · 按 `(platform, chatId)` 找绑定；没有 ⇒ 404（**不猜**该绑给谁）
 *   · 已在白名单 ⇒ 幂等（`already: true`），不重复写
 *   · 缺 `userId`（有些 reason 没有）⇒ 400，别造一个空串白名单项
 *   · 成功后把该条死信删掉（已处理的东西不该继续占着"最近失败"）
 */
export async function allowDeadLetterSender(config, input) {
	assertHuman(input?.actor);
	const items = (await listDeadLetters(config, { limit: 200 })).items;
	const id = String(input?.id ?? '').trim();
	const entry = id ? items.find((x) => String(x.id) === id) : null;
	const platform = String(entry?.platform ?? input?.platform ?? '').trim().toLowerCase();
	const chatId = String(entry?.chatId ?? input?.chatId ?? '').trim();
	const userId = String(entry?.userId ?? input?.userId ?? '').trim();
	if (!platform || !chatId) {
		throw httpError(400, '缺 platform / chatId（要么直接给这条死信的 id）');
	}
	if (!userId) {
		throw httpError(400, '这条记录没有发送者 id（不猜、不塞空字符串）');
	}
	const bindings = await readBindings(config);
	const idx = bindings.findIndex((b) => String(b.platform) === platform && String(b.chatId) === chatId);
	if (idx < 0) {
		throw httpError(404, `这个 IM 会话（${platform}:${chatId}）还没有绑定 —— 先在 Bots 里给它建一条绑定，再加发送者`);
	}
	const cur = bindings[idx];
	const list = Array.isArray(cur.allowFrom) ? cur.allowFrom.slice() : [];
	const already = list.includes(userId);
	if (!already) {
		list.push(userId);
		const out = bindings.slice();
		out[idx] = { ...cur, allowFrom: list, updatedAt: Date.now() };
		await writeBindings(config, out);
	}
	if (id) { await removeDeadLetter(config, id).catch(() => undefined); }
	return {
		already,
		userId,
		binding: { id: cur.id, platform: cur.platform, chatId: cur.chatId, allowFrom: list },
	};
}

/** 绑定表（带目标显示名，UI 直接用，不用再自己查一遍）。 */
export async function listBindings(config, deps) {
	const bindings = await readBindings(config);
	const scan = await deps.scanAgents(config).catch(() => ({ agents: [] }));
	const nameOf = new Map(scan.agents.map(a => [String(a.id), String(a.name || a.id)]));
	return {
		/* ⚠ 密钥**永不出现在响应里**：只给 `hasSecret`（前端据此显示"已配置/未配置"）。
		   这一条是硬约束 —— 一旦把 webhookSecret 返回，它就会出现在浏览器 devtools、
		   截图、以及别人复制走的 JSON 里。 */
		bindings: bindings.map(({ webhookSecret, ...b }) => ({
			...b,
			...(webhookSecret ? { hasSecret: true } : {}),
			targetName: String(nameOf.get(String(b.targetId)) || b.chatName || b.targetId),
		})),
		platforms: BINDING_PLATFORMS,
	};
}

/* ── 纯函数：入站该不该处理 ───────────────────────────────────────────────── */

/**
 * 入站判定。返回 `{ ok, reason }`；`reason` 用于日志/系统提示（不静默丢弃）。
 *
 * 判定顺序（先便宜后昂贵，且**安全项优先**）：
 *   ① 绑定停用 ⇒ disabled
 *   ② 方向只出不进 ⇒ direction
 *   ③ 白名单为空 ⇒ no-whitelist（fail-closed，与 channels 一致）
 *   ④ 发送者不在白名单 ⇒ sender
 *   ⑤ 群聊且只认 @ 却没 @ 到 ⇒ no-mention
 */
export function shouldAcceptInbound(binding, msg, opts = {}) {
	/* ★ 2026-10-27：绑定里**带了策略字段** ⇒ 走 OpenClaw 同构的四态/三态判定。
	   为什么留旧路径：已有绑定没有这些字段，直接换语义会让 `dmPolicy` 缺省成 `pairing`
	   ⇒ 原来能用的私聊突然全被挂起等配对（行为突变，用户只会看到"bot 不理我了"）。 */
	const usesPolicy = !!binding && [
		binding.dmPolicy, binding.groupPolicy, binding.rooms,
		binding.groupAllowFrom, binding.mentionPatterns, binding.requireMention,
	].some((v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()));
	if (usesPolicy) {
		const v = decideInbound(binding, msg, opts);
		return { ok: v.ok, reason: v.reason, ...(v.mention ? { mention: v.mention } : {}) };
	}

	if (!binding || binding.enabled !== true) {
		return { ok: false, reason: 'disabled' };
	}
	if (binding.direction === 'out') {
		return { ok: false, reason: 'direction' };
	}
	const allow = Array.isArray(binding.allowFrom) ? binding.allowFrom : [];
	if (!allow.length) {
		return { ok: false, reason: 'no-whitelist' };
	}
	const sender = String(msg?.userId ?? '').trim();
	if (!allow.includes(sender)) {
		return { ok: false, reason: 'sender' };
	}
	const isGroup = String(msg?.chatType ?? binding.chatType) === 'group';
	if (isGroup && binding.mentionPolicy === 'at' && msg?.mentionsBot !== true) {
		return { ok: false, reason: 'no-mention' };
	}
	return { ok: true, reason: 'ok' };
}

/** 入站幂等键（平台消息 id 是唯一的；缺了就退化成时间+内容指纹）。 */
export function inboundKeyOf(msg) {
	const platform = String(msg?.platform ?? '').trim();
	const id = String(msg?.messageId ?? '').trim();
	if (platform && id) {
		return `${platform}:${id}`;
	}
	return `${platform}:${String(msg?.userId ?? '')}:${String(msg?.content ?? '').slice(0, 32)}`;
}

/**
 * 出站分段（纯函数）。
 * 优先在**换行**处切，避免把一个词/一条命令劈开；找不到换行才硬切。
 */
export function splitOutbound(text, limit = OUT_SEGMENT_CHARS) {
	const s = String(text ?? '');
	if (!s) {
		return [];
	}
	if (s.length <= limit) {
		return [s];
	}
	const out = [];
	let rest = s;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'));
		const at = cut > limit * 0.5 ? cut + 1 : limit;   // 太靠前就硬切，否则会切出很多碎片
		out.push(rest.slice(0, at));
		rest = rest.slice(at);
	}
	if (rest) {
		out.push(rest);
	}
	return out;
}

/** 找 (platform, chatId) 对应的绑定。 */
export function findBindingForChat(bindings, platform, chatId) {
	const p = String(platform ?? '').trim().toLowerCase();
	const c = String(chatId ?? '').trim();
	return (Array.isArray(bindings) ? bindings : []).find(b => b.platform === p && b.chatId === c) || null;
}

/** 找某个 bot / 群**启用中的**出站绑定（可能有多条）。 */
export function findOutboundBindings(bindings, targetKind, targetId) {
	return (Array.isArray(bindings) ? bindings : []).filter(b => b.enabled === true
		&& b.direction !== 'in'
		&& b.targetKind === targetKind
		&& String(b.targetId) === String(targetId));
}

/* ── 出站管线（Hub）─────────────────────────────────────────────────────── */

/**
 * 建 Hub。`deps`：
 *   · `scanAgents(config)` / `groupExists(config,id)` —— 校验目标
 *   · `dispatchAgent(config, binding, msg)` —— 入站派给某个 bot（返回 { sessionId, messageId }）
 *   · `dispatchGroup(config, binding, msg)` —— 入站派给某个群
 *   · `log(level, msg)`
 *
 * 适配器通过 `register(adapter)` 注入；没注册的平台 ⇒ 出站如实失败（不假装成功）。
 */
export function createBindingHub(deps) {
	const adapters = new Map();
	/* 环形风暴预算（可按需覆盖：`createBindingHub({ loop: { maxEvents, windowMs, cooldownMs } })`） */
	const loopGuard = createLoopGuard(deps.loop || {});
	/* 最近出现的 IM 会话（2026-10-27）：内存环形，最多 20 条。
	   为什么内存就够：它的用途是"帮用户拿到 Telegram chat_id"这种**当下**的事，
	   重启后重新发一句话就有；落盘反而会留下外部会话 id 的历史。 */
	const RECENT_CAP = 20;
	const recent = [];
	function noteRecent(msg) {
		const platform = String(msg?.platform ?? '').trim().toLowerCase();
		const chatId = String(msg?.chatId ?? '').trim();
		if (!platform || !chatId) { return; }
		const key = `${platform}:${chatId}`;
		const hit = recent.find((x) => x.key === key);
		const at = nowOf();
		if (hit) {
			hit.lastAt = at;
			hit.count = (hit.count || 1) + 1;
			if (msg?.userName) { hit.userName = String(msg.userName); }
			return;
		}
		recent.unshift({
			key, platform, chatId,
			chatType: String(msg?.chatType ?? ''),
			userName: String(msg?.userName ?? ''),
			lastAt: at, count: 1,
		});
		while (recent.length > RECENT_CAP) { recent.pop(); }
	}
	const nowOf = () => Date.now();

	const seen = [];
	const seenSet = new Set();

	function log(level, msg) {
		try { deps.log?.(level, msg); } catch { /* 日志失败不影响主流程 */ }
	}

	function markSeen(key) {
		if (seenSet.has(key)) {
			return false;
		}
		seenSet.add(key);
		seen.push(key);
		while (seen.length > SEEN_KEEP) {
			const old = seen.shift();
			seenSet.delete(old);
		}
		return true;
	}

	async function handleInboundInner(msg) {
		const platform = String(msg?.platform ?? '').trim().toLowerCase();
		const chatId = String(msg?.chatId ?? '').trim();
		const key = inboundKeyOf({ ...msg, platform });
		/* 幂等：优先用**跨重启**的存储（`deps.seen`，见 imSeen.js）；
		   没注入就退回进程内（单测/演练够用，但 Host 重启后会重复处理 —— 那条注释写在 imSeen 里）。 */
		const firstTime = deps.seen && typeof deps.seen.mark === 'function'
			? await deps.seen.mark(key)
			: markSeen(key);
		if (!firstTime) {
			return { ok: false, reason: 'duplicate', key };
		}
		/* 记下这次出现过的会话 id（不论后面是被拒还是成功）—— 设置页要把它列出来给用户复制 */
		noteRecent({ ...msg, platform });

		const bindings = await readBindings(deps.config);
		const binding = findBindingForChat(bindings, platform, chatId);
		if (!binding) {
			return { ok: false, reason: 'unbound', key };
		}
		/* ★ 环形风暴预算（2026-10-27，复刻 OpenClaw `botLoopProtection`）：
		   同一 `(platform, chatId)` 在窗口内超预算 ⇒ 进冷却、全拒。
		   `sender_type=app` 只挡得住"我们自己发的"，挡不住"另一个 bot 发的"——
		   两个 bot 互相触发能在一分钟内打爆额度与账单。 */
		const loop = loopGuard.allow(`${platform}:${chatId}`);
		if (!loop.ok) {
			log('warn', `入站被风暴预算拦下（${platform}:${chatId}）：冷却 ${Math.ceil((loop.retryAfterMs || 0) / 1000)}s`);
			return { ok: false, reason: 'loop', key, binding, retryAfterMs: loop.retryAfterMs };
		}
		/* ★ 2026-10-27：把**已批准的配对**并入判定用的白名单（与 config allowFrom 合并）。
		   pairing 表由 `pairing.js` 提供；没注入就当作空（行为等同"仅 config 白名单"）。 */
		let approved = [];
		if (deps.pairing && typeof deps.pairing.approvedFor === 'function') {
			approved = await deps.pairing.approvedFor(platform).catch(() => []);
		}
		const verdict = shouldAcceptInbound(binding, { ...msg, chatType: msg?.chatType ?? binding.chatType }, { approved });
		if (!verdict.ok) {
			log('info', `入站被拒（${platform}:${chatId}）：${verdict.reason}`);
			/* ★ 2026-10-27 配对：`dmPolicy=pairing` 且对方未获批准 ⇒ **登记请求 + 回码**。
			   只有 Hub 知道 (platform, chatId, userId)，也只有它能用该绑定的适配器把码发回去 ——
			   否则陌生人永远不知道自己该做什么。
			   ⚠ 消息本身**不处理**（挂起）：这正是 pairing 与 allowlist 的语义差别。 */
			if (verdict.reason === 'pairing-required' && deps.pairing && typeof deps.pairing.request === 'function') {
				const pr = await deps.pairing.request({
					platform, chatId, userId: msg?.userId, userName: msg?.userName,
				}).catch((e) => ({ error: String((e && e.message) || e) }));
				if (pr && pr.code) {
					log('info', `配对请求已登记（${platform}:${String(msg?.userId)}）⇒ 码 ${pr.code}`);
					const text = `你的配对码是 ${pr.code}（1 小时内有效）。请在 VsSaros 的「设置 → 渠道」里批准后再发消息。`;
					/* 尽力回一条（用同作用域的 `deliver`：分段/失败上报都已就绪）；发不出去不影响"已登记" */
					await deliver(binding, text).catch(() => undefined);
				}
				return { ok: false, reason: verdict.reason, key, binding, pairing: pr };
			}
			return { ok: false, reason: verdict.reason, key, binding };
		}
		/* ★ 入站消毒（2026-10-27，复刻 OpenClaw 第二层）：剥掉 chat-template 特殊 token
		   （`<|im_start|>` 这类能被用来伪造"系统回合"）。
		   ⚠ 如实说明：这一步**不能**让不可信消息变得可安全执行，真正的闸是工具审批。
		   只在派发副本上动 —— `msg` 本身不变（日志/存档仍是原文）。 */
		const cleaned = sanitizeInbound(msg?.content);
		if (cleaned.stripped.length) {
			log('warn', `入站文本含 ${cleaned.stripped.length} 个 chat-template token，已剥离（${platform}:${chatId}）`);
		}
		const safeMsg = { ...msg, content: cleaned.text };
		try {
			const r = binding.targetKind === 'group'
				? await deps.dispatchGroup(deps.config, binding, safeMsg)
				: await deps.dispatchAgent(deps.config, binding, safeMsg);
			return { ok: true, reason: 'ok', key, binding, ...r };
		} catch (e) {
			log('warn', `入站派发失败（${platform}:${chatId}）：${String(e?.message ?? e)}`);
			return { ok: false, reason: 'dispatch-error', key, binding, error: String(e?.message ?? e) };
		}
	}

	/**
	 * 入站入口（**外层**）：跑完内部逻辑后，把"被拒/失败"记一条死信。
	 *
	 * 为什么包在外层而不改内部那 6 个 return：6 处分散改容易漏（漏掉的那条就永远查不到），
	 * 而"哪些 reason 该记"是**一张表**，放在一处最不容易漂。
	 * ⚠ 死信写入失败绝不能影响入站结果（`catch` 掉，只记日志）。
	 */
	async function handleInbound(msg) {
		const r = await handleInboundInner(msg);
		if (r && r.ok === false && deps.deadLetters && typeof deps.deadLetters.record === 'function') {
			await deps.deadLetters.record({
				reason: r.reason,
				platform: String(msg?.platform ?? ''),
				chatId: String(msg?.chatId ?? ''),
				chatType: String(msg?.chatType ?? ''),
				userId: String(msg?.userId ?? ''),
				userName: String(msg?.userName ?? ''),
				messageId: String(msg?.messageId ?? ''),
				text: String(msg?.content ?? ''),
				detail: r.error || (r.pairing && r.pairing.throttled ? '配对请求过多' : ''),
			}).catch(() => undefined);
		}
		return r;
	}

	/**
	 * 出站：分段 + 逐段发送。返回真实结果（失败不吞）。
	 *
	 * `images` 是**可选**的（2026-10-27 出站富媒体）：`[{ mediaType, data(base64), name }]`。
	 * ⚠ 图片只挂在**第一段**上 —— 一条长答复会被切成多段，每段都带图会重复发送 N 次。
	 * ⚠ 只有图、没有文本时也要能发：`splitOutbound('')` 返回空数组，这里补一个空段。
	 */
	async function deliver(binding, text, images) {
		const adapter = adapters.get(String(binding?.platform ?? ''));
		if (!adapter) {
			return { ok: false, reason: 'no-adapter', sent: 0, failed: 0, segments: 0 };
		}
		const pics = (Array.isArray(images) ? images : []).filter((x) => x && x.data).slice(0, 2);
		const segments = splitOutbound(text);
		if (!segments.length && !pics.length) {
			return { ok: true, reason: 'empty', sent: 0, failed: 0, segments: 0 };
		}
		const segs = segments.length ? segments : [''];
		const ctx = {
			sessionKey: `chat:${binding.platform}:${binding.chatId}`,
			chatId: binding.chatId,
			chatType: binding.chatType,
			bindingId: binding.id,
			/* 平台凭据在这里交给适配器（P1：飞书的 webhook URL 与签名密钥）。
			   ⚠ 只进内存，不进日志、不进 GET 响应（`listBindings` 会把 secret 挡掉）。 */
			webhookUrl: binding.webhookUrl || '',
			webhookSecret: binding.webhookSecret || '',
		};
		let sent = 0;
		let failed = 0;
		let lastError = '';
		let first = true;
		for (const seg of segs) {
			try {
				/* 图只跟第一段走（见上面的注释） */
				await adapter.send(ctx, seg, first ? pics : []);
				first = false;
				sent += 1;
			} catch (e) {
				first = false;
				failed += 1;
				lastError = String(e?.message ?? e);
			}
		}
		return { ok: failed === 0, reason: failed ? 'send-failed' : 'ok', sent, failed, segments: segs.length, images: pics.length, error: lastError };
	}

	/**
	 * 回复回收后调用：把这条答复推给**该绑定**对应的 IM 会话。
	 * `entry` 来自 outbox（`kind:'im'`），里面带着 `bindingId`。
	 */
	async function deliverForEntry(entry, text, images) {
		if (!entry?.bindingId) {
			return { ok: false, reason: 'no-binding' };
		}
		const bindings = await readBindings(deps.config);
		const binding = bindings.find(b => b.id === entry.bindingId);
		if (!binding || binding.enabled !== true || binding.direction === 'in') {
			return { ok: false, reason: 'binding-inactive' };
		}
		return deliver(binding, text, images);
	}

	/**
	 * 把一条答复推给某个 bot / 群的**所有**出站绑定（群镜像用）。
	 * 返回逐绑定的结果数组 —— 调用方可以把失败写进 deliveries / 日志，不静默。
	 */
	async function deliverForTarget(targetKind, targetId, text) {
		const bindings = await readBindings(deps.config);
		const targets = findOutboundBindings(bindings, targetKind, targetId);
		if (!targets.length) {
			return [];
		}
		const out = [];
		for (const b of targets) {
			const r = await deliver(b, text);
			out.push({ bindingId: b.id, platform: b.platform, chatId: b.chatId, ...r });
		}
		return out;
	}

	/**
	 * 测试发送：用**真实适配器**给这条绑定发一条消息（2026-10-27）。
	 *
	 * 为什么值得单独做：「配完了到底通不通」现在是**只能靠真跑一次对话**才知道 ——
	 * 用户填完 Telegram token / 飞书 webhook 后，要等真有答复才看到失败。
	 * 这个入口把那次等待变成一次点击，且失败原因**原样**返回（不包装成"发送失败"）。
	 *
	 * ⚠ 三种前置条件明确拒，而不是发出去再说：
	 *   · 绑定不存在 / 已停用
	 *   · 只入向（`direction === 'in'`）—— 它根本不打算发
	 *   · 该平台没有适配器（比如 Discord 未接入）
	 */
	async function testBinding(id) {
		const bindings = await readBindings(deps.config);
		const b = bindings.find((x) => String(x.id) === String(id));
		if (!b) { throw httpError(404, `绑定不存在：${id}`); }
		if (b.enabled !== true) { throw httpError(400, '绑定已停用，先启用再测'); }
		if (b.direction === 'in') { throw httpError(400, '这条绑定是"只入向"，没有出站通道可测'); }
		if (!adapters.has(String(b.platform))) {
			throw httpError(400, `平台「${b.platform}」没有适配器（未接入）`);
		}
		const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
		const r = await deliver(b, `【测试】来自 VsSaros 的测试消息 —— 收到即说明「${b.platform}」出站可用。\n时间：${stamp}`);
		return {
			bindingId: b.id,
			platform: b.platform,
			chatId: b.chatId,
			...r,
			/* deliver 的 `ok` 已说明结果；这里补一句人话，避免界面只看到 reason 代码 */
			detail: r.ok ? `已发出（${r.sent} 段）` : (r.error || r.reason),
		};
	}

	return {
		register(adapter) {
			adapters.set(String(adapter.id), adapter);
			return adapter.id;
		},
		adapters() { return [...adapters.keys()]; },
		handleInbound,
		deliver,
		deliverForEntry,
		deliverForTarget,
		/** 「测试发送」：用**真实适配器**给这条绑定发一条消息（2026-10-27）。 */
		testBinding,
		recentChats: () => recent.map((x) => ({
			platform: x.platform, chatId: x.chatId, chatType: x.chatType,
			userName: x.userName, lastAt: x.lastAt, count: x.count,
		})),
		/** 仅测试：清空幂等表。 */
		resetSeen() { seen.length = 0; seenSet.clear(); },
	};
}

/* ── 入站派发实现（P0 只做 bot 侧；群侧走既有 postGroupMessage）────────── */

/**
 * 把一条 IM 文本派给某个 bot 的会话。
 *
 * ⚠ 为什么不走 `runs.run({sessionId})`（channels 的做法）：那是给**专用会话**用的，
 *   会**新开一个回合**；而这里的会话是用户正在 IDE 里用的同一条，必须走
 *   `steer`/`followup`（与群派发同一套），否则会和交互式回合打架。
 */
export async function dispatchImToAgent(config, state, binding, msg, deps) {
	const agent = (await deps.scanAgents(config)).agents.find(a => String(a.id) === String(binding.targetId));
	if (!agent) {
		throw httpError(404, `绑定指向的 bot 不存在：${binding.targetId}`);
	}
	/* ★ 2026-10-29（真机：飞书里能收到答复，但 Bots 页/工作区里只有一串「(未命名会话)」）：
	   每个绑定**固定一条会话**，建好顺手起名。
	     · 记住的会话还活着 ⇒ 直接复用（上下文稳定，也不会每次新建一条未命名会话）
	     · 不活（归档 / 删 / Host 重启）⇒ 重新挑或新建，并更新映射
	     · 只有**新建**的才改名（改名是用户可见动作，已有名字的不覆盖）
	   映射单独存文件（见 imSessionMap.js 头注释：塞进 binding 会被 normalize 抹掉）。 */
	const sessMap = deps.imSessions || null;
	let sessionId = '';
	let created = false;
	if (sessMap && typeof sessMap.get === 'function') {
		sessionId = String((await sessMap.get(config, binding.id).catch(() => '')) || '');
	}
	/* 首次派发（还没有映射）即使复用了旧会话，也要命名一次 ——
	   否则这条绑定永远是一串「(未命名会话)」里的一个，用户认不出来。
	   之后只在新建时命名，**不覆盖用户手动改过的名字**。 */
	const firstBind = !sessionId;
	const canDeliver = (id) => {
		const l = id ? state.agents?.get?.(id) : null;
		return !!l && (typeof l.steer === 'function' || typeof l.followup === 'function');
	};
	if (sessionId && !canDeliver(sessionId)) { sessionId = ''; }
	if (!sessionId) {
		const picked = await deps.ensureSession(config, state, agent);
		sessionId = picked.sessionId;
		created = picked.created === true;
		if (sessMap && typeof sessMap.set === 'function') {
			await sessMap.set(config, binding.id, sessionId).catch(() => undefined);
		}
	}
	const live = state.agents?.get?.(sessionId);
	if (!live || (typeof live.steer !== 'function' && typeof live.followup !== 'function')) {
		throw httpError(503, `会话不在运行，收不了 IM 消息：${sessionId}`);
	}
	/* 起名（尽力而为，失败不影响派发）：让它在 Bots 页 / 工作区会话列表里一眼认得出。 */
	if ((created || firstBind) && typeof deps.renameSession === 'function') {
		const whereLabel = String(msg?.chatType ?? binding.chatType) === 'group' ? '群' : '私聊';
		const platLabel = binding.platform === 'feishu' ? '飞书'
			: binding.platform === 'telegram' ? 'Telegram'
				: binding.platform === 'discord' ? 'Discord'
					: binding.platform === 'wecom' ? '企业微信' : String(binding.platform || 'IM');
		const title = (platLabel + ' · ' + String(binding.chatName || whereLabel)).slice(0, 60);
		await deps.renameSession(sessionId, title).catch(() => undefined);
	}
	const who = String(msg?.userName || msg?.userId || 'IM 用户');
	const where = String(msg?.chatType ?? binding.chatType) === 'group' ? '群' : '私聊';
	const header = `[${binding.platform} ${where} · ${who}]`;

	/* ★ 2026-10-27 富媒体：IM 里的图片转成 prompt 的 `image` part。
	   依据：dsh 的 `PromptContentPart` 联合类型已含 `{ type:'image', mediaType, data }`
	   （data 是 base64）—— 不需要跨层改动，上一轮我判断错了。
	   ⚠ 只放行 jpeg/png：标错 mediaType 比丢掉更糟（上游会按错误格式解码）。
	   ⚠ 单条最多 2 张（与适配器侧一致），防止一次塞进几十兆。 */
	const contentParts = [{ type: 'text', text: `${header}\n${clipDispatchText(String(msg?.content ?? ''))}\n\n你的答复会回传到这个 IM 会话。` }];
	const images = Array.isArray(msg?.images) ? msg.images.slice(0, 2) : [];
	for (const img of images) {
		const raw = String((img && img.mediaType) || '').toLowerCase();
		const mediaType = raw === 'image/png' ? 'image/png' : (raw === 'image/jpeg' || raw === 'image/jpg' ? 'image/jpeg' : '');
		const data = String((img && img.data) || '');
		if (!mediaType || !data) { continue; }
		contentParts.push({
			type: 'image',
			mediaType,
			data,
			...(img.name ? { name: String(img.name).slice(0, 120) } : {}),
		});
	}

	const message = {
		id: randomUUID(),
		role: 'user',
		content: contentParts,
		source: { kind: AGENT_MESSAGE_KIND, from: null, hop: 1, to: agent.id, im: `${binding.platform}:${binding.chatId}` },
	};
	if (binding.dispatchMode === 'followup' && typeof live.followup === 'function') {
		live.followup(message);
	} else if (typeof live.steer === 'function') {
		live.steer(message);
	} else {
		live.followup(message);
	}
	/* outbox 记 `kind:'im'`：回复回收时据 `bindingId` 找回绑定并推回 IM */
	outboxNote(config, {
		kind: 'im',
		sessionId,
		bindingId: binding.id,
		messageId: message.id,
		agentId: String(agent.id),
		agentName: String(agent.name || agent.id),
		platform: binding.platform,
		chatId: binding.chatId,
	});
	return { sessionId, messageId: message.id, agentId: String(agent.id), agentName: String(agent.name || agent.id) };
}
