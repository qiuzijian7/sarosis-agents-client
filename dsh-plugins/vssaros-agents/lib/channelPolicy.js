// @vssaros/dsh-agents — 渠道准入策略（**OpenClaw 同构**，2026-10-27）
//
// ── 为什么是这个形状 ────────────────────────────────────────────────────────
// 调研结论：开源参考是 **OpenClaw**（31 个渠道 + WebChat，2026.10.4）。它真正值得复刻的
// **不是渠道数量**，而是这一层语义 —— channel 只是 transport，只决定两件事：
//   ① 谁能触达 Agent（准入控制）  ② 回复怎么投递（出站）
//
// 我们原先把准入压成了"白名单 + @ 判定"两条，缺了它四件关键东西：
//   · 私聊四态（pairing / allowlist / open / disabled）—— 陌生人该**挂起**而不是静默丢
//   · 群策略三态（allowlist / open / disabled）+ **房间白名单**（rooms）
//   · **群内发送者白名单在 mention 之前**检查（回复 bot 不能绕过）
//   · **环形风暴预算**（bot 之间互相触发会打爆额度）
//
// ⇒ 这一层做成**纯函数**（无 IO）：好测、可在 Hub/探针/未来别的渠道层复用。
//
// ── 默认即安全（与 OpenClaw 一致）──────────────────────────────────────────
//   未配置：私聊 `pairing`（陌生人消息**扣留**、回配对码），群聊 `allowlist`（fail-closed）。
//   **空配置不会静默开放** —— 这是整套设计的底线。
//
// ── 明确没做的（不是忘了）─────────────────────────────────────────────────
//   · 配对码的**发放/批准/过期**（`pairing` 只在此处给出 `pairing-required` 判定，
//     码表与 approve 流程是独立一块，见下一期）
//   · 多账号 `accounts` + `defaultAccount`、按 channel+account 的 bindings 匹配
//   · dead-letter 队列、热重载
//   这三项在 README/汇报里都单列，避免"看起来支持了"。

/** 私聊策略（默认 pairing：陌生人被扣留，而不是处理或静默丢）。 */
export const DM_POLICIES = ['pairing', 'allowlist', 'open', 'disabled'];
/** 群聊策略（默认 allowlist：fail-closed）。 */
export const GROUP_POLICIES = ['allowlist', 'open', 'disabled'];

/** 环形风暴预算默认值（与 OpenClaw `botLoopProtection` 同量级）。 */
export const LOOP_DEFAULTS = { maxEvents: 20, windowMs: 60_000, cooldownMs: 60_000 };

function arr(v) {
	if (Array.isArray(v)) { return v.map((s) => String(s ?? '').trim()).filter(Boolean); }
	const s = String(v ?? '').trim();
	return s ? s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * 把绑定的零散字段整理成一份**策略对象**（缺省即安全）。
 * 兼容旧绑定：`mentionPolicy:'at'` 等价于 `requireMention:true`。
 */
export function normalizePolicy(binding) {
	const b = binding || {};
	const mentionPolicy = String(b.mentionPolicy ?? '').trim();
	const requireMention = b.requireMention !== undefined
		? b.requireMention === true
		: (mentionPolicy ? mentionPolicy === 'at' : true);

	return {
		dmPolicy: DM_POLICIES.includes(String(b.dmPolicy)) ? String(b.dmPolicy) : 'pairing',
		groupPolicy: GROUP_POLICIES.includes(String(b.groupPolicy)) ? String(b.groupPolicy) : 'allowlist',
		allowFrom: arr(b.allowFrom),
		groupAllowFrom: arr(b.groupAllowFrom),
		/** 房间白名单：`null`/空 = 未配置（此时按 `groupPolicy` 判）。 */
		rooms: arr(b.rooms),
		requireMention,
		mentionPatterns: arr(b.mentionPatterns),
		direction: String(b.direction ?? 'both'),
		enabled: b.enabled === true,
	};
}

/**
 * 这条消息算不算"叫到了我"。
 * 顺序与 OpenClaw 一致：**@ 提及** → **回复我的消息** → **自定义触发词**。
 */
export function mentionHit(policy, msg) {
	if (msg && msg.mentionsBot === true) { return 'at'; }
	if (msg && msg.repliesToBot === true) { return 'reply'; }
	const text = String((msg && msg.content) ?? '');
	if (text && policy.mentionPatterns.length) {
		for (const p of policy.mentionPatterns) {
			// 触发词按**字面量**匹配（不做正则：用户写的 `@claw` 里 `.` `(` 不该被当元字符）
			if (text.includes(p)) { return 'pattern'; }
		}
	}
	return '';
}

/**
 * 准入判定（纯函数）。返回 `{ ok, reason, mention }`：
 *   reason ∈ ok | disabled | direction | dm-disabled | group-disabled | room-not-allowlisted
 *           | no-whitelist | sender | no-mention | pairing-required
 *
 * ⚠ 检查顺序是**语义**，不是实现细节：
 *   1. 停用 / 方向 —— 最先（省掉后面所有判断）
 *   2. 会话类型分流：私聊走 DM 策略，群聊走 group 策略（**互不借用**）
 *   3. 房间白名单（群）—— 在发送者之前：一个没被允许的房间，讨论谁都无关
 *   4. 发送者白名单 —— 群内用 `groupAllowFrom`（配了才用），否则 `allowFrom`
 *   5. mention —— **最后**：白名单外的人 @ 了也不能进
 */
export function decideInbound(binding, msg, opts = {}) {
	const policy = normalizePolicy(binding);
	/* ★ 2026-10-27：**已批准配对**的人与 config 的 allowFrom **合并**（不是替换）——
	   与 OpenClaw 一致。批准表来自 `pairing.js`，由调用方注入（本函数保持纯函数）。 */
	const approved = Array.isArray(opts.approved) ? opts.approved.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
	if (approved.length) {
		policy.allowFrom = Array.from(new Set([...policy.allowFrom, ...approved]));
	}
	if (!policy.enabled) {
		return { ok: false, reason: 'disabled' };
	}
	if (policy.direction === 'out') {
		return { ok: false, reason: 'direction' };
	}

	const isGroup = String((msg && msg.chatType) ?? binding?.chatType ?? '') === 'group';
	const sender = String((msg && msg.userId) ?? '').trim();
	const roomId = String((msg && msg.chatId) ?? '').trim();

	if (!isGroup) {
		/* ── 私聊 ──────────────────────────────────────────────────────── */
		if (policy.dmPolicy === 'disabled') {
			return { ok: false, reason: 'dm-disabled' };
		}
		const open = policy.dmPolicy === 'open' && policy.allowFrom.includes('*');
		if (policy.dmPolicy === 'open' && !open) {
			/* OpenClaw 的硬规则：`open` 必须显式写 `"*"`，否则等同于没配
			   —— 防止有人以为写了 open 就开放，其实一个都进不来却查不出原因。 */
			return { ok: false, reason: 'no-whitelist' };
		}
		if (policy.dmPolicy === 'pairing') {
			// 已在白名单 ⇒ 直接放行；否则**挂起等配对**（上层发码，本轮只给判定）
			if (policy.allowFrom.length && policy.allowFrom.includes(sender)) {
				return { ok: true, reason: 'ok', mention: '' };
			}
			return { ok: false, reason: 'pairing-required' };
		}
		if (policy.dmPolicy === 'allowlist') {
			if (!policy.allowFrom.length) {
				return { ok: false, reason: 'no-whitelist' };
			}
			return policy.allowFrom.includes(sender)
				? { ok: true, reason: 'ok', mention: '' }
				: { ok: false, reason: 'sender' };
		}
		return { ok: true, reason: 'ok', mention: '' };  // open + '*'
	}

	/* ── 群聊 ────────────────────────────────────────────────────────── */
	if (policy.groupPolicy === 'disabled') {
		return { ok: false, reason: 'group-disabled' };
	}
	// 房间白名单：配了就必须命中（`*` = 全部房间）
	if (policy.rooms.length) {
		const hit = policy.rooms.includes('*') || policy.rooms.includes(roomId);
		if (!hit) {
			return { ok: false, reason: 'room-not-allowlisted' };
		}
	} else if (policy.groupPolicy === 'allowlist') {
		// 没配房间白名单却要求 allowlist ⇒ fail-closed（空配置不开门）
		return { ok: false, reason: 'no-whitelist' };
	}

	// 群内发送者白名单：配了才用；**必须在 mention 之前**
	const groupAllow = policy.groupAllowFrom.length ? policy.groupAllowFrom : [];
	if (groupAllow.length && !groupAllow.includes('*') && !groupAllow.includes(sender)) {
		return { ok: false, reason: 'sender' };
	}

	if (policy.requireMention) {
		const mention = mentionHit(policy, msg);
		if (!mention) {
			return { ok: false, reason: 'no-mention' };
		}
		return { ok: true, reason: 'ok', mention };
	}
	return { ok: true, reason: 'ok', mention: mentionHit(policy, msg) };
}

/**
 * 环形风暴预算（**滑动窗口 + 冷却**）。
 *
 * 为什么必须有：A bot 在群里说话 → 我们的出站推到 IM → IM 事件回来 → 又派发 ⇒
 * 两个 bot 互相触发能在一分钟内打爆额度与账单。`sender_type=app` 只挡"自己发的"，
 * 挡不住"另一个 bot 发的"。
 *
 * 语义（与 OpenClaw `botLoopProtection` 同量级）：同一 `(platform, chatId)` 在
 * `windowMs` 内超过 `maxEvents` ⇒ 进入 `cooldownMs` 冷却，期间全拒。
 */
export function createLoopGuard(options = {}) {
	const maxEvents = Math.max(1, Number(options.maxEvents) || LOOP_DEFAULTS.maxEvents);
	const windowMs = Math.max(1000, Number(options.windowMs) || LOOP_DEFAULTS.windowMs);
	const cooldownMs = Math.max(0, Number(options.cooldownMs ?? LOOP_DEFAULTS.cooldownMs));
	const now = typeof options.now === 'function' ? options.now : () => Date.now();
	const hits = new Map();   // key → number[]（窗口内时间戳）
	const cooling = new Map(); // key → 冷却截止时间

	return {
		/** 记一次并判定：`{ ok:false, reason:'loop', retryAfterMs }` = 本轮不该处理。 */
		allow(key) {
			const k = String(key ?? '');
			const t = now();
			const until = cooling.get(k) || 0;
			if (until > t) {
				return { ok: false, reason: 'loop', retryAfterMs: until - t };
			}
			const list = (hits.get(k) || []).filter((x) => t - x < windowMs);
			list.push(t);
			hits.set(k, list);
			if (list.length > maxEvents) {
				cooling.set(k, t + cooldownMs);
				hits.delete(k);   // 冷却期不继续累计，避免冷却结束后立刻再触发
				return { ok: false, reason: 'loop', retryAfterMs: cooldownMs };
			}
			return { ok: true, reason: 'ok' };
		},
		/** 测试/运维用：清空某个 key 或全部。 */
		reset(key) {
			if (key === undefined) { hits.clear(); cooling.clear(); return; }
			hits.delete(String(key));
			cooling.delete(String(key));
		},
	};
}

/**
 * 入站文本消毒（**复刻 OpenClaw 的第二层**）。
 *
 * 两件事：
 *   ① 剥掉各家 chat-template 的特殊 token（ChatML `<|im_start|>`、Llama `<|start_header_id|>`、
 *      Gemma `<|start_of_turn|>`、Mistral `[INST]`、Phi `<|endoftext|>`）—— 这些能被用来
 *     伪造"系统回合"；
 *   ② 把外部内容包进 `<<<EXTERNAL_UNTRUSTED_CONTENT …>>>`，让模型看得见来源是外部。
 *
 * ⚠ 如实说明（与上游文档同一口径）：这两步**不能让不可信消息变得可安全执行**，
 *   它们只是降低"伪造系统消息"的成功率。真正的闸是工具审批（我们已有 pre-execute ask）。
 */
const TEMPLATE_TOKENS = [
	/<\|im_start\|>/gi, /<\|im_end\|>/gi, /<\|start_header_id\|>/gi, /<\|end_header_id\|>/gi,
	/<\|start_of_turn\|>/gi, /<\|end_of_turn\|>/gi, /<\|endoftext\|>/gi,
	/\[INST\]/gi, /\[\/INST\]/gi,
];

export function sanitizeInbound(text) {
	const raw = String(text ?? '');
	let out = raw;
	const stripped = [];
	for (const re of TEMPLATE_TOKENS) {
		if (re.test(out)) {
			stripped.push(String(re));
			out = out.replace(re, '');
		}
		re.lastIndex = 0;
	}
	return { text: out, stripped };
}

/** 包成"外部不可信内容"块（只在**派发给 agent** 时用；存档/展示仍用原文）。 */
export function wrapExternal(text, meta) {
	const who = [meta?.platform, meta?.chatType, meta?.userName || meta?.userId].filter(Boolean).join(' · ');
	return `<<<EXTERNAL_UNTRUSTED_CONTENT source="im" ${who ? `from="${who}"` : ''}>>>\n`
		+ String(text ?? '')
		+ '\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>';
}
