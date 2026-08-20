/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire Message Pipeline — provider 无关的「发送线」消息收口层。
 *
 * ## 为什么需要这一层（2026-08-19，修 HTTP 400 code 11133 的架构级治本方案）
 *
 * 事故复盘：IOA 网关拒绝「以 assistant 结尾」的 messages（400 invalid_parameter_value，
 * param 为空，无从定位）。触发链是 `agentTurnExecutor` 每轮开头
 * `messages = stripSyntheticSidecars(messages)` **回写权威数组**，把控制流分支刚
 * append 的 synthetic user 边界当轮删除，末尾于是暴露出 assistant。
 *
 * 排查中发现两个更严重的结构性问题：
 *
 * 1. **收口层只覆盖 1/4 provider**。修复前仅 `LanguageModelVendorProvider`（LMBridge）
 *    有 normalize/sanitize/boundary 守卫；`BuiltInBYOKModelProvider`（直连 OpenAI /
 *    Anthropic / DeepSeek）、`GeminiNativeModelProvider`、`MainProcessModelProvider`
 *    的收口层调用数均为 **0** —— 换 provider 必然复现，且 Anthropic 对此约束更严格。
 * 2. **各家方言差异散落成 boolean 开关**（isAnthropic / capabilityConfig），
 *    没有单一可审计的约束声明。
 *
 * ## 设计（借鉴 Hermes-Agent，见 references 段）
 *
 * - **单一入口**：`buildWireMessages(messages, dialect)` 固定顺序跑完所有规则。
 * - **纯函数 + 永不 mutate 入参**：对齐 Hermes `agent_runtime_helpers.py:1372`
 *   「Runs on the per-call api_messages copy only. The stored conversation history
 *   (agent.messages) is never mutated... Only the wire copy sent to the provider
 *   is cleaned.」——权威 transcript 只做「追加」与「有意压缩」，清理只作用于发送副本。
 * - **强制接入点在 `MessageFormatConverter` 三个 to* 入口内部**，而非依赖调用方自觉：
 *   所有 provider 都必须经过格式转换才能发请求，因此收口层下沉到必经之路后，
 *   现有 4 个 provider 全部自动获得保护，**未来新增 provider 亦天然受保护**。
 * - **方言表声明式表达差异**（`WIRE_DIALECTS`），对齐 Hermes 的
 *   `_REASONING_ECHO_RULES` / provider capability 表模式。
 *
 * ## references（Hermes-Agent 对应实现）
 * - `agent/agent_init.py:572` — Anthropic Sonnet/Opus 4.6+ 拒绝以 assistant 结尾（400）
 * - `agent/moa_loop.py:1023` — 「Rather than DELETE ... we APPEND a synthetic user turn」
 * - `agent/conversation_loop.py:6304` — Alternation guard（append 前校验末尾 role）
 * - `agent/message_sanitization.py:296` — close_interrupted_tool_sequence（tool 结尾闭合）
 * - `agent/agent_runtime_helpers.py:1372` — 发送副本纪律 + drop vs append 取舍
 */

import { AgentRunMessage, ensureTrailingUserBoundary, stripSyntheticSidecars } from '../agentRunState.js';

/**
 * Provider 线协议方言 —— 声明式表达各家对 messages 序列的硬约束。
 *
 * 新增 provider 时在 `WIRE_DIALECTS` 加一条即可，无需改动管道逻辑。
 */
export interface IWireDialect {
	/** 方言标识（诊断日志用） */
	readonly id: string;
	/**
	 * 要求 messages 最后一条为 user 或 tool。
	 * - OpenAI 兼容网关（IOA/copilot.tencent.com）：true —— 2026-08-19 实测 400
	 * - Anthropic：true —— trailing assistant 被解释为 prefill，no-prefill 模型
	 *   （Claude Opus 4.8）报 `400 ... must end with a user message`
	 * - Gemini：true —— tool 角色会被转成 user(functionResponse)，以 model 结尾同样报错
	 */
	readonly requiresTrailingUserOrTool: boolean;
	/** 要求首条非 system 消息为 user（Gemini contents 约束） */
	readonly requiresLeadingUser: boolean;
	/**
	 * 是否允许 assistant 消息 content/reasoning/toolCalls 全空。
	 * Anthropic：false —— 空 content blocks 数组直接 400（at least one block required）。
	 */
	readonly allowsEmptyAssistantContent: boolean;
}

/** OpenAI 兼容（含 IOA 网关 / DeepSeek / 各类 OpenAI-compatible 端点） */
const DIALECT_OPENAI: IWireDialect = {
	id: 'openai',
	requiresTrailingUserOrTool: true,
	requiresLeadingUser: false,
	allowsEmptyAssistantContent: true,
};

/** Anthropic Messages API（约束最严） */
const DIALECT_ANTHROPIC: IWireDialect = {
	id: 'anthropic',
	requiresTrailingUserOrTool: true,
	requiresLeadingUser: true,
	allowsEmptyAssistantContent: false,
};

/** Google Gemini generateContent（role 仅 user/model，tool → user(functionResponse)） */
const DIALECT_GEMINI: IWireDialect = {
	id: 'gemini',
	requiresTrailingUserOrTool: true,
	requiresLeadingUser: true,
	allowsEmptyAssistantContent: false,
};

export const WIRE_DIALECTS = {
	openai: DIALECT_OPENAI,
	anthropic: DIALECT_ANTHROPIC,
	gemini: DIALECT_GEMINI,
} as const;

export type WireDialectId = keyof typeof WIRE_DIALECTS;

export interface IWireBuildResult {
	/** 收口后的发送副本（入参永不被修改） */
	readonly wire: AgentRunMessage[];
	/** 本次应用的规则说明（排障日志用；为空表示消息序列本就合法） */
	readonly notes: readonly string[];
}

/** assistant 消息是否带有效 tool_calls */
function hasToolCalls(m: AgentRunMessage | undefined): boolean {
	const tc = (m as { tool_calls?: unknown[]; toolCalls?: unknown[] } | undefined);
	return !!(
		(Array.isArray(tc?.tool_calls) && tc.tool_calls.length > 0) ||
		(Array.isArray(tc?.toolCalls) && tc.toolCalls.length > 0)
	);
}

/** assistant 是否为「空壳」（无 content / 无 reasoning / 无 tool_calls） */
function isEmptyAssistantShell(m: AgentRunMessage): boolean {
	if (m.role !== 'assistant' || hasToolCalls(m)) { return false; }
	const content = (m as { content?: unknown }).content;
	const reasoning = (m as { reasoning?: unknown }).reasoning;
	const contentEmpty = content === undefined || content === null ||
		(typeof content === 'string' && content.trim() === '') ||
		(Array.isArray(content) && content.length === 0);
	const reasoningEmpty = !reasoning || (typeof reasoning === 'string' && reasoning.trim() === '');
	return contentEmpty && reasoningEmpty;
}

/**
 * 丢弃空壳 assistant 消息。
 *
 * 取舍依据 Hermes `agent_runtime_helpers.py:1378`：无实质内容的 assistant → **drop**
 *（"Fabricating '.' / '(continued)' text lies in the history"，伪造占位文本等于在历史里说谎）；
 * 有实质内容的 assistant → **append 一条 user**（见 ensureTrailingUserBoundary）。
 * 空壳来源：discard_prior_text 清空文本后残留的壳、首字超时中断、空响应重试。
 */
function dropEmptyAssistantShells(messages: AgentRunMessage[]): AgentRunMessage[] {
	return messages.filter(m => !isEmptyAssistantShell(m));
}

/**
 * ⚠ 关于 Hermes `close_interrupted_tool_sequence`（tool 结尾 → 补 assistant 闭合）
 * **为什么不在本层实现**：
 *
 * 该规则在 Hermes 里的调用点是 `turn_finalizer` happy path 与 conversation_loop 的
 * retry/backoff/error 早退路径 —— 即「**turn 结束时对持久化 transcript 的收尾**」，
 * 目的是防止下一次用户输入形成 `tool → user`，被严格 provider（Gemini/Claude）
 * 幻觉成「工具结果的延续」而忽略上下文。
 *
 * 而本层是**发送前**守卫，此时「以 tool 结尾」是 agent loop 的标准合法形态
 * （assistant 发起 tool_calls → tool 结果 → 请求模型基于结果继续）。若在此补
 * assistant 占位，会插入一条模型没说过的「Operation interrupted.」，并连锁触发
 * 下方 trailing-user 守卫，把正常的工具循环破坏成
 * `tool → assistant(假) → user(假)`。
 *
 * 正确的接入点是 turn 中断路径（用户停止 / 首字超时 / 异常早退）对 transcript
 * 的收尾，属于独立改进项，不在本层职责内。
 */

/**
 * 保证首条非 system 消息为 user（Gemini / Anthropic 约束）。
 *
 * 仅在首条非 system 为 assistant/tool 时插入一条极简 user 锚点。
 * 正常会话由用户消息开启，本规则只在历史被裁剪到「以 assistant 开头」时兜底。
 */
function ensureLeadingUser(messages: AgentRunMessage[]): AgentRunMessage[] {
	const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
	if (firstNonSystemIdx < 0) { return messages; }
	const first = messages[firstNonSystemIdx];
	if (first.role === 'user') { return messages; }
	return [
		...messages.slice(0, firstNonSystemIdx),
		{ role: 'user', content: '(Continuing from earlier context.)', synthetic: true } as AgentRunMessage,
		...messages.slice(firstNonSystemIdx),
	];
}

/**
 * 构建发送线消息副本 —— **所有 provider 的统一收口入口**。
 *
 * 幂等：对已合法的序列返回等价结果（`notes` 为空）。
 * 纯函数：入参数组与其元素均不被修改。
 *
 * 规则顺序经过设计，不可随意调整：
 *   1. 剥离非尾部 synthetic sidecar（尾部保留——它是本轮的 user 边界）
 *   2. 丢弃空壳 assistant（否则 Anthropic 400；也可能造成假的 trailing assistant）
 *   3. assistant 结尾 → 补 user 边界（方言开关）
 *   4. 首条非 system 非 user → 补 user 锚点（方言开关）
 *
 * 注：① tool_calls↔tool 的配对与相邻性重排由 `ContextManager.sanitizeToolPairs`
 * 在上游负责（它需要完整的 tool 语义）；② 以 tool 结尾**不做**处理，那是 agent
 * loop 的正常形态（见上方 close_interrupted_tool_sequence 说明）。
 */
export function buildWireMessages(
	messages: readonly AgentRunMessage[],
	dialect: IWireDialect,
): IWireBuildResult {
	const notes: string[] = [];
	let wire = messages.slice() as AgentRunMessage[];

	// 1. 剥离非尾部 synthetic sidecar
	const afterStrip = stripSyntheticSidecars(wire);
	if (afterStrip.length !== wire.length) {
		notes.push(`stripped ${wire.length - afterStrip.length} synthetic sidecar(s) (tail preserved)`);
	}
	wire = afterStrip;

	// 2. 丢弃空壳 assistant
	if (!dialect.allowsEmptyAssistantContent) {
		const afterDrop = dropEmptyAssistantShells(wire);
		if (afterDrop.length !== wire.length) {
			notes.push(`dropped ${wire.length - afterDrop.length} empty assistant shell(s)`);
		}
		wire = afterDrop;
	}

	// 3. assistant 结尾 → 补 user 边界
	if (dialect.requiresTrailingUserOrTool) {
		const afterBoundary = ensureTrailingUserBoundary(wire);
		if (afterBoundary.length !== wire.length) {
			notes.push('appended trailing user boundary (messages ended with assistant)');
		}
		wire = afterBoundary;
	}

	// 4. 首条非 system 非 user → 补 user 锚点
	if (dialect.requiresLeadingUser) {
		const afterLeading = ensureLeadingUser(wire);
		if (afterLeading.length !== wire.length) {
			notes.push('inserted leading user anchor (conversation started with assistant/tool)');
		}
		wire = afterLeading;
	}

	return { wire, notes };
}

/**
 * 按 provider 特征选择方言。
 *
 * @param isAnthropic Anthropic 兼容 provider（沿用 MessageFormatConverter 既有开关）
 */
export function pickDialect(kind: 'openai' | 'anthropic' | 'gemini' | undefined, isAnthropic?: boolean): IWireDialect {
	if (kind) { return WIRE_DIALECTS[kind]; }
	return isAnthropic === true ? WIRE_DIALECTS.anthropic : WIRE_DIALECTS.openai;
}
