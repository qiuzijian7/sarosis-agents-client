// 本地 Agent 引擎徽标的真源（P2 · 2026-11-09）。
//
// chat-surface 的 client chunk 跑在 `__ModuleLoader__` realm 里，只被允许 `require("react")`
// （见 check-chat-surface-chunks.mjs 的 loadChunk 约束）⇒ 不能直接引用本模块。
// 因此 `client.settings.js` / `client.conversationViews.js` 各内联一份**同形**的
// LOCAL_AGENT_BADGES + localAgentBadgeOf；`dsh-plugins/check-local-agent-badge.mjs`
// 静态对账三份，防止某天改了一处忘了另一处。
export const LOCAL_AGENT_BADGES = Object.freeze({
	'vssaros-codex-cli': 'Codex CLI',
	'vssaros-claude-code': 'Claude Code',
	'vssaros-opencode': 'OpenCode',
	'vssaros-kimi-cli': 'Kimi CLI',
	'vssaros-hermes-cli': 'Hermes Agent',
	'vssaros-gemini-cli': 'Gemini CLI',
});

/** 从 `provider/model`、`model:` 文本或 route 里取出可显示的引擎名；非本地 Agent 返回 undefined。 */
export function localAgentBadgeOf(text) {
	const value = String(text ?? '').trim().toLowerCase();
	if (!value.startsWith('vssaros-')) return undefined;
	const route = value.split('/')[0];
	if (Object.hasOwn(LOCAL_AGENT_BADGES, route)) return LOCAL_AGENT_BADGES[route];
	if (route.startsWith('vssaros-acp-')) return '自定义 ACP Agent';
	return undefined;
}
