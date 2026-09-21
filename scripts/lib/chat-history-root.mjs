/*---------------------------------------------------------------------------------------------
 *  会话历史根目录解析（供 `scripts/*.mjs` 共用）—— 2026-09-21。
 *
 *  必须与 `AgentChatService._getChatHistoryRoot()` **保持一致** ✗✓：
 *      userRoamingDataHome/../chat-history
 *  即：Windows `%APPDATA%\vssaros\chat-history` ✓；Linux/mac `~/.vssaros/chat-history` ✓。
 *
 *  之所以抽成共用模块：根目录口径是**跨脚本的约定** ✗ —— 两个脚本各写一份，
 *  早晚会在某次改动后对不上（一个能读到、一个读不到 ✗✓）。
 *--------------------------------------------------------------------------------------------*/
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 候选路径（按优先级 ✓）。 */
export function chatHistoryRootCandidates() {
	return [
		process.env.APPDATA ? path.join(process.env.APPDATA, 'vssaros', 'chat-history') : undefined,
		path.join(os.homedir(), '.vssaros', 'chat-history'),
		path.join(os.homedir(), '.config', 'vssaros', 'chat-history'),
	].filter(Boolean);
}

/**
 * 解析会话历史根目录：显式覆盖 > 环境变量 `SAROSIS_CHAT_HISTORY_ROOT` > 首个**存在**的候选 > 首候选 ✓。
 */
export function resolveChatHistoryRoot(override) {
	const explicit = override ?? process.env.SAROSIS_CHAT_HISTORY_ROOT;
	if (explicit) { return explicit; }
	const candidates = chatHistoryRootCandidates();
	for (const dir of candidates) {
		if (existsSync(dir)) { return dir; }
	}
	return candidates[0];
}

/** 某 agent 的 sessions 目录 ✓。 */
export function sessionsDirOf(root, agentId) {
	return path.join(root, agentId, 'sessions');
}
