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

// ─── 上次绑定的会话（重启后恢复；2026-10-20）─────────────────────────────────

/**
 * 持久化的"本页签上次绑定的会话"。
 *
 * 为什么需要（2026-10-20 用户报）：从会话 A 切到 B 聊完、关掉 app、重开 ⇒ 聊天框又是 A。
 * 因为切换只走宿主内存（`slot.sessionId` / `_chatSession`），而启动时的目标会话是
 * `_sessionIdFor()` **纯函数派生**出来的 ⇒ 必然回到派生会话 A，B 明明还在磁盘上。
 * 把实际绑定落盘、启动时优先恢复它，这条链才闭环。
 */
export interface IRememberedSession {
	readonly sessionId: string;
	readonly cwd: string;
	/** 归一化后的 preset：基座 preset 与"未显式选择"都记成 `''`（两种语义等价，见 `_savePresetState`）。 */
	readonly preset: string;
}

/** preset 归一化：基座 preset 与"未显式选择"等价 ⇒ 都记成 `''`。 */
export function normalizeRememberedPreset(preset: string | undefined, basePreset: string | undefined): string {
	if (!preset || (basePreset !== undefined && preset === basePreset)) {
		return '';
	}
	return preset;
}

/** 序列化记录（写入工作区存储的字符串）。 */
export function serializeRememberedSession(sessionId: string, cwd: string, preset: string | undefined, basePreset: string | undefined): string {
	const record: IRememberedSession = { sessionId, cwd, preset: normalizeRememberedPreset(preset, basePreset) };
	return JSON.stringify(record);
}

/** 解析存储值；损坏 / 缺字段 ⇒ `undefined`（当作没记过，调用方回退派生会话）。 */
export function parseRememberedSession(raw: string | null | undefined): IRememberedSession | undefined {
	if (typeof raw !== 'string' || !raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown; preset?: unknown };
		if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
			return undefined;
		}
		if (typeof parsed.cwd !== 'string' || !parsed.cwd) {
			return undefined;
		}
		return {
			sessionId: parsed.sessionId,
			cwd: parsed.cwd,
			preset: typeof parsed.preset === 'string' ? parsed.preset : '',
		};
	} catch {
		return undefined;
	}
}

/**
 * 这条记录还能用于本次绑定吗（**目录**与 **preset** 两道校验）。
 *
 * 为什么是这两道：
 *   · 目录不同 ⇒ 那是另一个 worktree / 工作区的会话，恢复过来就是"串目录" ✗；
 *   · preset 不同 ⇒ 各 preset 有专属会话（`resolvePresetSessionId`），恢复成别的 preset 的会话 ✗。
 * 第三道（会话**是否还存在**）必须查会话索引，不能靠纯函数，由调用方（宿主）补。
 */
export function rememberedSessionMatches(
	stored: IRememberedSession,
	options: { readonly cwd: string; readonly preset?: string; readonly basePreset?: string }
): boolean {
	if (!options.cwd) {
		return false;
	}
	if (normalizeCwdForReuse(stored.cwd) !== normalizeCwdForReuse(options.cwd)) {
		return false;
	}
	return stored.preset === normalizeRememberedPreset(options.preset, options.basePreset);
}

// ─── 复用"空白会话"（2026-10-19，对齐 dsh 官方） ─────────────────────────────

/** 参与复用判定的最小形状（`IDshSessionSummary` 的子集）。 */
export interface IBlankSessionCandidate {
	readonly id: string;
	readonly cwd?: string;
	readonly agentPreset?: string;
	/** dsh 官方口径：折叠前缀里**没有任何回合**（用户还没发过消息）。 */
	readonly blank?: boolean;
	readonly updatedAt?: number;
}

/** 路径归一化：大小写不敏感 + 反斜杠转正斜杠 + 去尾斜杠（同一个目录在 Windows 上有多种写法）。 */
function normalizeCwdForReuse(p: string): string {
	return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 挑一个**可复用的空白会话**（返回它的 id；没有合适的 ⇒ `undefined`）。
 *
 * 为什么需要它（2026-10-19 用户问「为什么会有这么多空白会话、官方怎么做」）：dsh 的
 * `session.create` 参数原文是 **"Blank Session to reuse while it is reusable, or the identity of a
 * new Session when none is stored under it"** —— 官方「新建对话」是**优先复用**那个还没说过话的会话。
 * 我们此前的宿主每开一个页签就派生一个**新** sessionId（从不复用）⇒ 每开一次页签就永久多一条
 * `blank: true` 的会话（实测本机 1691 条里 1681 条是空白）✗。
 *
 * 判定（四条全中才复用）：
 *   ① `blank === true`（有回合的会话绝不能拿来当"新对话"）；
 *   ② `cwd` 与本次绑定目录**同一目录**（不同工作区的历史不能串）；
 *   ③ `agentPreset` 与本次一致（否则"新对话"会跑在别人设的 preset 上）；
 *   ④ 不在 `exclude` 里（= 本窗口**已经有页签绑着它**；复用会让两个页签显示同一条会话 ✗）。
 * 多个候选时取 `updatedAt` 最新的那个（最近刚被关掉的空白页签，最可能仍然干净）。
 */
export function pickReusableBlankSession(
	candidates: readonly IBlankSessionCandidate[],
	options: { readonly cwd: string; readonly agentPreset?: string; readonly exclude?: ReadonlySet<string> }
): string | undefined {
	const cwd = normalizeCwdForReuse(options.cwd);
	const wantPreset = options.agentPreset ?? '';
	if (!cwd) {
		return undefined;
	}
	let best: IBlankSessionCandidate | undefined;
	for (const candidate of candidates) {
		if (!candidate || typeof candidate.id !== 'string' || !candidate.id) {
			continue;
		}
		if (candidate.blank !== true) {
			continue;
		}
		if (options.exclude && options.exclude.has(candidate.id)) {
			continue;
		}
		if (typeof candidate.cwd !== 'string' || normalizeCwdForReuse(candidate.cwd) !== cwd) {
			continue;
		}
		if ((candidate.agentPreset ?? '') !== wantPreset) {
			continue;
		}
		if (!best || (candidate.updatedAt ?? 0) > (best.updatedAt ?? 0)) {
			best = candidate;
		}
	}
	return best?.id;
}
