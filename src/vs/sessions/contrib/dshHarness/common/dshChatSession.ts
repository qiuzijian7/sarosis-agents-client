/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * chatId → dsh 会话 id 的派生规则（方案 5.15.2）。
 *
 * 确定性是核心性质：同一 (chatId, preset) 永远派生同一个会话 id，配合控制桥
 * `session.start` 的幂等接管，"切回某 preset"就是重开它上次的专属会话（历史原样回来），
 * 跨重启恢复也不需要另存映射表。
 *
 * - 默认 preset（未显式选择）沿用 `vssaros-chat-<chatId>`（无后缀，向后兼容既有会话）；
 * - 显式选择的非基座 preset 用 `vssaros-chat-<chatId>--<presetId>`；
 * - 基座 preset（无后缀会话实际运行的 preset，从 `session.start` 结果习得）选择时回到无后缀 id。
 */

/** id 片段规范化：小写、仅保留 [a-z0-9-]（幂等接管依赖字面一致）。 */
export function sanitizeDshIdPart(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 基座（默认 preset）会话 id。 */
export function dshChatSessionId(chatId: string): string {
	return `vssaros-chat-${sanitizeDshIdPart(chatId)}`;
}

/** 显式 preset 的专属会话 id（调用方保证 preset 不是基座 preset）。 */
export function dshChatPresetSessionId(chatId: string, presetId: string): string {
	return `${dshChatSessionId(chatId)}--${sanitizeDshIdPart(presetId)}`;
}

export interface IDshChatPresetState {
	/** 无后缀基座会话实际运行的 preset（经 `session.start` 结果习得）；未知时 undefined。 */
	readonly basePreset?: string;
	/** 已知的 preset → 会话 id 映射（本窗口运行期内习得/派生）。 */
	readonly known?: ReadonlyMap<string, string>;
}

/**
 * 解析"切到 preset"的目标会话 id：
 * 已知映射优先；命中基座 preset 回无后缀 id；其余按确定性规则派生。
 */
export function resolvePresetSessionId(chatId: string, presetId: string, state: IDshChatPresetState): string {
	const known = state.known?.get(presetId);
	if (known) {
		return known;
	}
	if (state.basePreset !== undefined && presetId === state.basePreset) {
		return dshChatSessionId(chatId);
	}
	return dshChatPresetSessionId(chatId, presetId);
}

/**
 * **本页签内**新建会话的 id：`vssaros-chat-<chatId>--new-<nonce>`（2026-10-12 用户要求：
 * 聊天 header 的「＋ 新建会话」= 当前页签里再来一段新对话，**不是**新开一个 group 页签）。
 *
 * 为什么这里**故意不确定**（与上面三条规则相反）：那三条靠"同一 (chatId,preset,worktree) 恒等"
 * 实现幂等接管；而"再给我一个新会话"每次都必须不同 —— 否则第二次点还是回到同一个会话 ✗。
 * 代价：重载后不会自动回到这个新会话（符合预期：要回去走「历史会话」菜单 ✓）。
 */
export function dshChatNewSessionId(chatId: string, nonce: number | string): string {
	return `${dshChatSessionId(chatId)}--new-${sanitizeDshIdPart(String(nonce))}`;
}

/** 会话 id 的合法形态（rebind 负载校验用）：派生规则的输出全集。 */
export function isDshChatSessionId(id: unknown): id is string {
	return typeof id === 'string' && /^vssaros-chat-[a-z0-9-]{1,160}$/.test(id);
}

// ─── worktree 段（2026-10-12 方案 C：换 worktree = 新会话，preset 沿用当前值）──────────────

/** 取路径末段（`/a/b/c` 与 `C:\a\b` 都认）；本模块不依赖 node path，避免平台差异。 */
function lastSegment(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
}

/** 稳定的短哈希（djb2 → 8 位十六进制取末 6 位）：只用于让 id 不撞，不承担安全职责。 */
function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
	}
	return h.toString(16).padStart(8, '0').slice(-6);
}

/**
 * worktree 段的 id 片段：**目录名 + 路径短哈希**（例：`feature-auth-3f1a9c`）。
 *
 * 为什么不只用目录名：同名不同父目录会撞（`repo/wt-a` 与 `repo/nested/wt-a`），而 id 一撞，
 * 两个 worktree 就**共用同一个 dsh 会话** ⇒ "换了目录却还在同一段历史里"这种最难查 ✗。
 * 加哈希后仍**确定性**（幂等接管 + 重载恢复都依赖这点 ✓）。路径按小写 + 统一分隔符归一 ⇒
 * Windows 的 `C:\Repo\Wt` 与 `c:\repo\wt` 得同一个 id ✓（代价：大小写敏感的文件系统上两个仅大小写
 * 不同的目录会共用 id —— 实践中不构成问题，且比"每次重启换一个 id"安全得多）。
 */
export function worktreeIdPart(worktreePath: string): string {
	const dir = sanitizeDshIdPart(lastSegment(String(worktreePath)));
	const h = shortHash(String(worktreePath).toLowerCase().replace(/\\/g, '/'));
	return dir ? `${dir}-${h}` : `wt-${h}`;
}

/**
 * worktree 里的专属会话 id：`vssaros-chat-<chatId>[--<presetId>]--wt-<worktree 片段>`。
 *
 * 设计要点（方案 C 的全部依据）：
 *   · dsh 的会话 cwd 在 `session.start` 时定死，桥面没有"改已有会话 cwd"的方法 ⇒ 换目录**只能新开会话**；
 *   · 把 worktree 编进 id ⇒ **每个 worktree 各有一段历史**，且"切回原目录"就是幂等接管回原来的会话
 *     （不需要另存映射表 ✓ 这是确定性派生的红利）；
 *   · preset 段沿用当前值 ⇒ 用户选的 agent 不丢（但它会在**新会话**里重新装配，工具/模型/skills 重新锁定）。
 *   · 主工作区**不加** `--wt-` 段（保持向后兼容：主干上的历史仍在老会话里 ✓）。
 */
export function dshChatWorktreeSessionId(chatId: string, presetId: string | undefined, worktreePath: string): string {
	const wt = worktreeIdPart(worktreePath);
	const base = dshChatSessionId(chatId);
	return presetId
		? `${base}--${sanitizeDshIdPart(presetId)}--wt-${wt}`
		: `${base}--wt-${wt}`;
}
