/**
 * vssaros-memory — Bot 会话识别（VsSaros 内置化，2026-11-05「记忆收敛成一套」）。
 *
 * 以前 Bot 记忆由 @vssaros/dsh-agents 单独存放、单独注入、单独提供 `workspace_memory` 工具；
 * 现在并入本插件的 `bot` 轨（`<memoryDir>/bots/<botKey>/MEMORY.md`）。本插件不依赖
 * dsh-agents，判定「会话属于哪个 Bot」用下面这份 bot-identity v1 的**逐字副本**
 * （真源 vssaros-agents/lib/core/botIdentity.js，守卫 dsh-plugins/check-bot-identity.mjs 对账）。
 *
 * botKey 取 preset 后缀：dsh-agents 的 preset id = `vssaros-` + slugify(agentId)，
 * 所以身份记录里的 botId 经 slugify 后与 preset 后缀一致 ⇒ 两种来源落到同一个目录。
 * @module vssaros-memory/vssaros-bot
 */

/* vssaros:bot-identity v1 —— 逐字副本，真源 vssaros-agents/lib/core/botIdentity.js（守卫 dsh-plugins/check-bot-identity.mjs） */
const BOT_MODE_PRESET_IDS = ["standard", "ptc", "minimal", "cordis", "vssaros-standard", "vssaros-ptc", "vssaros-full", "vssaros-minimal", "vssaros-cordis"];
/** 是不是"可能属于某个 bot"的 preset（vssaros- 前缀且不是模式 preset）。 */
function isBotPresetId(presetId) {
	const id = String(presetId || "").trim();
	return id.indexOf("vssaros-") === 0 && id.length > 8 && BOT_MODE_PRESET_IDS.indexOf(id) < 0;
}
/** 会话属于哪个 bot：身份记录（presetId 与当前一致才采信）> 按 preset 推断（botId=null，调用方用花名册反查）。 */
function sessionBotOf(projectionValues) {
	const pv = projectionValues || {};
	const presetId = String(pv.agentPreset || "").trim();
	if (!isBotPresetId(presetId)) { return { isBot: false, botId: null, presetId: presetId, source: "none" }; }
	const rec = pv["vssaros-bot"];
	const recBot = rec && typeof rec.botId === "string" ? rec.botId.trim() : "";
	if (recBot && String(rec.presetId || "").trim() === presetId) {
		return { isBot: true, botId: recBot, presetId: presetId, source: "record" };
	}
	return { isBot: true, botId: null, presetId: presetId, source: "preset" };
}
/* /vssaros:bot-identity */

export { BOT_MODE_PRESET_IDS, isBotPresetId, sessionBotOf }

/** 与 dsh-agents `core/agents.js` 的 slugify 同口径（preset id 的字符集）。 */
export function slugifyBotId(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** botKey 合法形态（只用于拼目录，防路径逃逸）。 */
export const BOT_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/

/**
 * 会话 → `{ key, label }`；不是 Bot 会话返回 null。
 * 来源优先级：会话投影（当前 preset / 身份记录）> 创建头。拿不到投影服务时只看创建头。
 * @param {object | undefined} agent - dsh agent（`agent.session.header` / `agent.session`）。
 * @param {{ stateOf?: Function } | undefined} projections - `sessionProjections` 服务（可缺）。
 */
export function botOfAgent(agent, projections) {
  const session = agent?.session
  if (!session) return null
  const header = session.header ?? {}
  let preset = typeof header.agentPreset === 'string' ? header.agentPreset : ''
  if (!preset && typeof session.meta?.agentPreset === 'string') preset = session.meta.agentPreset
  let record
  const svc = projections ?? agent?.ctx?.get?.('sessionProjections')
  if (svc && typeof svc.stateOf === 'function') {
    try {
      const current = svc.stateOf(session, 'agentPreset')
      if (typeof current === 'string' && current) preset = current
    } catch { /* 拿不到投影就用创建头 */ }
    try {
      record = svc.stateOf(session, 'vssaros-bot') ?? undefined
    } catch { record = undefined }
  }
  const bot = sessionBotOf({ agentPreset: preset, 'vssaros-bot': record })
  if (!bot.isBot) return null
  const key = slugifyBotId(bot.botId || bot.presetId.slice('vssaros-'.length))
  if (!BOT_KEY_RE.test(key)) return null
  return { key, label: bot.botId || key }
}
