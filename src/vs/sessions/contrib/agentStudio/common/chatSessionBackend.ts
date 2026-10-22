/*---------------------------------------------------------------------------------------------
 *  会话存储后端（A1 方案第 1 步：**接缝 + 能力矩阵**，不改现有行为）
 *
 *  背景（2026-10-19）：左侧「历史会话」与 dsh 聊天框是**两套数据源**，用户要求统一真源。
 *  调研结论（见 `doc/dsh-session-single-source-plan.md`）：dsh 会话是 **append-only 事件流**
 *  （`session.v4.jsonl.zstd`），IDE 会话是**可任意改写的消息数组** ⇒ 只有「聊天会话」能迁 dsh；
 *  工作流 / 编排 / 知识库 / bridge / 手机端会话必须留在本地存储（它们靠 `appendMessage` /
 *  `clearHistory` / `replaceHistory` 直接写消息，dsh 侧没有这些能力）。
 *
 *  本文件只放**纯逻辑**（可单测、不碰 fs / IPC / 服务）：
 *    · 会话 id 归谁（`isDshSessionId`）
 *    · 该走哪个后端（`resolveSessionBackend`）
 *    · 每个后端**真的支持哪些方法**（`SUPPORTED_*` / `backendSupports`）
 *    · 不支持时怎么报错（`unsupportedError` —— 必须**明确失败**，绝不允许静默成功 ✗）
 *
 *  第 2 步才把 `agentChatService` 改成路由层并按这里的能力矩阵抛错；第 1 步不动它 ⇒ 零风险。
 *--------------------------------------------------------------------------------------------*/

/** 后端标识。 */
export type SessionBackendId = 'local' | 'dsh';

/**
 * `IAgentChatService` 里与「会话存储」相关的动作（用于能力矩阵）。
 *
 * ⚠ 这里列的是**能力**，不是方法签名 —— 后端只要能给出对应语义即可（dsh 侧是事件流分页读）。
 */
export type SessionBackendCapability =
	| 'list'              // 列出某 agent 的会话
	| 'create'            // 新建会话
	| 'history'           // 读消息历史
	| 'send'              // 发起一轮对话
	| 'rename'            // 改名
	| 'fork'              // 复制出一条新会话
	| 'deleteSession'     // 删除整个会话
	| 'appendMessage'     // 直接往会话里塞一条消息（不经过 agent）
	| 'clearHistory'      // 清空历史
	| 'deleteMessagesAfter' // 截断历史
	| 'replaceHistory';   // 整体替换历史

/** 本地后端（现状 `chat-history/<agent>/…`，可任意改写）⇒ 全部支持。 */
export const SUPPORTED_LOCAL: readonly SessionBackendCapability[] = [
	'list', 'create', 'history', 'send', 'rename', 'fork',
	'deleteSession', 'appendMessage', 'clearHistory', 'deleteMessagesAfter', 'replaceHistory',
];

/**
 * dsh 后端（Host 侧事件流）。
 *
 * ❌ 没有的三项（全部实测，见方案文档 §2）：
 *    · `deleteSession` —— `dsh-api-session-controller/client.js` 全文无 delete/remove/archive/purge
 *    · `appendMessage` / `clearHistory` / `deleteMessagesAfter` / `replaceHistory` —— 事件流不可变
 */
export const SUPPORTED_DSH: readonly SessionBackendCapability[] = [
	'list', 'create', 'history', 'send', 'fork',
];

const CAPS: Record<SessionBackendId, readonly SessionBackendCapability[]> = {
	local: SUPPORTED_LOCAL,
	dsh: SUPPORTED_DSH,
};

/** 该后端支不支持这个动作。 */
export function backendSupports(backend: SessionBackendId, cap: SessionBackendCapability): boolean {
	return CAPS[backend].indexOf(cap) >= 0;
}

/** dsh 会话 id 的形态：我们派生的 `vssaros-*` 与 dsh/agent 内核的 `session-<uuid>`。 */
const DSH_ID_RE = /^(?:vssaros-.+|session-[0-9a-f]{8}-[0-9a-f-]+)$/i;

/** 本地会话 id 由 `agentChatService.createAgentSession` 生成：`sess_<base36>_<rand>`。 */
const LOCAL_ID_RE = /^sess_[0-9a-z]+_[0-9a-z]+$/i;

/**
 * 这条会话 id 是不是 **dsh 侧**的。
 *
 * ⚠ 两个命名空间**互不相交**（`sess_xxx` 与 `vssaros-…` / `session-…`）⇒ 判据只认形态，
 *   不猜、不查表（查表会在 dsh 未就绪时给出错的答案 ✗）。
 */
export function isDshSessionId(sessionId: string | undefined | null): boolean {
	if (typeof sessionId !== 'string' || sessionId.length === 0) {
		return false;
	}
	// 本地形态优先否决：即便将来出现奇怪的 `sess_` 前缀也绝不归到 dsh
	if (LOCAL_ID_RE.test(sessionId)) {
		return false;
	}
	return DSH_ID_RE.test(sessionId);
}

/**
 * 这次会话操作该走哪个后端。
 *
 * @param engine    当前聊天引擎（`DshHarnessSettings.ChatEngine`：`'dsh'` / `'legacy'` / 其它）
 * @param sessionId 目标会话 id（新建时为 undefined ⇒ 按引擎决定）
 */
export function resolveSessionBackend(opts: {
	readonly engine: string | undefined;
	readonly sessionId?: string;
}): SessionBackendId {
	if (opts.engine !== 'dsh') {
		return 'local';   // legacy 引擎（或 dsh 未启用）⇒ 一律本地
	}
	// dsh 引擎下：**老会话仍在本地**（迁移前建的），只有 dsh 会话走 dsh
	return isDshSessionId(opts.sessionId) ? 'dsh' : 'local';
}

/** 不支持该动作时抛的错（消息里带后端与动作 ⇒ 日志/通知能说清是哪半边不行）。 */
export function unsupportedError(backend: SessionBackendId, cap: SessionBackendCapability): Error {
	return new Error(`[chatSessionBackend] 后端 ${backend} 不支持 ${cap}`);
}

/**
 * **IDE agent → dsh preset** 的 id 派生（A1 第 4 步：侧栏新建会话要能指定 dsh 的 preset）。
 *
 * ⚠ 这是**复制**而不是"再设计"：真源在 `dsh-plugins/vssaros-agents/lib/core/agents.js`
 *   的 `slugify()` + `presetIdOf()`（`vssaros-` + slug）。改那边 ⇒ **必须同步这里**，
 *   否则侧栏建的会话会落到**不存在的 preset**（dsh 侧静默按默认处理 ⇒ 用户选的 agent 白选 ✗）。
 */
const PRESET_ID_PREFIX = 'vssaros-';

/** 与插件同规则：小写、非字母数字折成单个连字符、去首尾连字符。 */
function slugify(name: string): string {
	return String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** `presetId = 'vssaros-' + slugify(agentId)`；slug 为空（纯符号/空串）⇒ 回退 `'agent'`。 */
export function agentPresetIdOf(agentId: string): string {
	const safe = slugify(agentId);
	return `${PRESET_ID_PREFIX}${safe || 'agent'}`;
}
