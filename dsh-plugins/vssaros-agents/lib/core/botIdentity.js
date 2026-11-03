// @vssaros/dsh-agents — 会话的 Bot 身份（纯逻辑，零 I/O、零 dsh 依赖，可单测）。2026-11-03。
//
// ★ 为什么要有这个模块（"每个 bot 一个 preset"重构第 2 步）：
//   以前"这个会话是哪个 bot"全靠会话的 agentPreset 推断，分散在 ~40 处、5 套写法；"哪些 preset 是模式
//   不是 bot"的排除表有 9 份副本且互不一致（vssaros-full 被胶囊/⚙/欢迎卡当成 bot；记忆把 vssaros-ptc /
//   vssaros-full 当成名叫 ptc / full 的人设分区）。而且第 3 步要把多个 bot 合并进共享的能力 preset ——
//   到那时 presetId 不再能说明"是哪个 bot"。
//
// ★ 身份怎么存：dsh 会话日志的 **plugin record**（`dsh-session` 的 `appendPluginRecord`，事件带 `ignorable: true`）：
//   · 模型看不到（不进 model-visible surface）；不认识它的读取方保留并跳过（不会让会话打不开）；
//   · fork / resume 随日志一起带走；建会话时即可写入（不用等第一轮）。
//   · ⚠ 格式迁移时是 best-effort 保留 ⇒ 记录丢了必须能退回 presetId 推断（`resolveSessionBot` 的兜底）。
//
// ★ 判据（单一真源 = `resolveSessionBot`）：
//   ① presetId 是模式 preset（或不是 vssaros- 前缀）⇒ 不是 bot 会话；
//   ② 有身份记录且记录里的 presetId == 会话当前 preset ⇒ 记录的 botId（权威）；
//      （空会话可以换 preset —— 换过之后旧记录与当前 preset 对不上 ⇒ 不采信，回落 ③）
//   ③ 否则按 presetId 反查花名册（`presetToAgent`），查不到返回 botId=null（调用方自行决定兜底）。
//
// ⚠ 本文件的 MODE_PRESET_IDS 是真源；客户端 chunk（chat-surface 5 个 chunk）与 vssaros-memory 各有一份
//   **逐字副本**（它们不能 import 本包），由 dsh-plugins/check-bot-identity.mjs 守卫比对。改这里必须同步改副本。

/** preset id 前缀（与 core/agents.js 的 PRESET_ID_PREFIX 一致）。 */
export const BOT_PRESET_PREFIX = 'vssaros-';

/**
 * **模式** preset（不是 bot）：官方四个 + 我们的组合版（preset-sync.mjs 生成的 vssaros-standard / -ptc / -full，
 * 以及与官方同名的 -minimal / -cordis 防御）。
 */
export const MODE_PRESET_IDS = Object.freeze([
	'standard', 'ptc', 'minimal', 'cordis',
	'vssaros-standard', 'vssaros-ptc', 'vssaros-full', 'vssaros-minimal', 'vssaros-cordis',
]);

/** 是不是模式 preset。 */
export function isModePreset(presetId) {
	return MODE_PRESET_IDS.includes(String(presetId ?? '').trim());
}

/** 是不是"可能属于某个 bot"的 preset（vssaros- 前缀且不是模式）。 */
export function isBotPresetId(presetId) {
	const id = String(presetId ?? '').trim();
	return id.startsWith(BOT_PRESET_PREFIX) && id.length > BOT_PRESET_PREFIX.length && !isModePreset(id);
}

/** 身份记录的事件类型（plugin record 语法：`plugin:` + 小写段）。 */
export const BOT_IDENTITY_RECORD_TYPE = 'plugin:vssaros/bot-identity';

/** 身份投影 key（带 wire ⇒ 页面 `summary.projectionValues["vssaros-bot"]` 可读）。 */
export const BOT_PROJECTION_KEY = 'vssaros-bot';

/** 投影状态版本：字段或折叠语义一变就 +1。 */
export const BOT_PROJECTION_STATE_VERSION = 1;

/** 身份记录的数据体（写入口统一走它，别各拼各的）。 */
export function identityRecordData({ botId, presetId }) {
	return { v: 1, botId: String(botId ?? ''), presetId: String(presetId ?? '') };
}

/** 从一条会话事件里读身份记录；不是就返回 undefined。 */
export function botIdentityOfEvent(event) {
	if (!event || event.type !== BOT_IDENTITY_RECORD_TYPE || event.ignorable !== true) {
		return undefined;
	}
	const data = event.data;
	const botId = typeof data?.botId === 'string' ? data.botId.trim() : '';
	const presetId = typeof data?.presetId === 'string' ? data.presetId.trim() : '';
	return botId ? { botId, presetId, atSeq: typeof event.seq === 'number' ? event.seq : -1 } : undefined;
}

/** 在事件序列里找**最后一条**身份记录（memory 包等拿不到投影时用；`snapshotEvents()` 的结果）。 */
export function lastBotIdentityOf(events) {
	let found;
	for (const event of Array.isArray(events) ? events : []) {
		const hit = botIdentityOfEvent(event);
		if (hit) { found = hit; }
	}
	return found;
}

/**
 * `sessionProjections` 单元：fold 身份记录 → `{ botId, presetId, atSeq }`（没有记录 = null）。
 * 忽略的事件**必须返回同一引用**（dsh 靠 `Object.is` 抑制下游发布）。
 */
export function botIdentityProjection() {
	return {
		key: BOT_PROJECTION_KEY,
		stateSchema: { parse: value => value },
		init: () => null,
		apply(state, event) {
			const hit = botIdentityOfEvent(event);
			return hit ? hit : state;
		},
		stateVersion: BOT_PROJECTION_STATE_VERSION,
		wire: {
			viewSchema: { parse: value => value },
			view: state => (state ? { botId: state.botId, presetId: state.presetId } : null),
		},
	};
}

/**
 * **唯一判据**：这个会话属于哪个 bot。
 * @param input.agentPreset 会话当前 preset（dsh `agentPreset` 投影）
 * @param input.identity 身份记录（`vssaros-bot` 投影状态 / `lastBotIdentityOf`），可缺
 * @param presetToAgent `(presetId) => agentId | undefined`（花名册反查；缺省不反查）
 * @returns `{ isBot, botId, presetId, source }`；source ∈ 'record' | 'preset' | 'none'
 */
export function resolveSessionBot({ agentPreset, identity } = {}, presetToAgent) {
	const presetId = String(agentPreset ?? '').trim();
	if (!isBotPresetId(presetId)) {
		return { isBot: false, botId: null, presetId, source: 'none' };
	}
	const recBot = typeof identity?.botId === 'string' ? identity.botId.trim() : '';
	if (recBot && String(identity.presetId ?? '').trim() === presetId) {
		return { isBot: true, botId: recBot, presetId, source: 'record' };
	}
	let mapped;
	try { mapped = typeof presetToAgent === 'function' ? presetToAgent(presetId) : undefined; } catch { mapped = undefined; }
	return { isBot: true, botId: typeof mapped === 'string' && mapped ? mapped : null, presetId, source: 'preset' };
}
