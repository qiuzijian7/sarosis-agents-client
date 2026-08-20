/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ask Routing (MiMo-Code `decideAskRouting`-inspired)
 *
 * 权限审批闸门（`ToolApprovalService.checkAndApprove`）在弹出交互确认之前，先按
 * 「当前 agent 的身份 / 模式」决定审批应走哪条路：
 *
 *   - foreground（用户直接会话的主 agent）→ interactive：弹交互确认卡片（现状行为）。
 *   - subagent（后台派发的子 agent）        → inherit：非交互放行。子 agent 的
 *       可见工具列表已被 SUB_AGENT_PERMISSIONS 在过滤层收窄（explore=只读 /
 *       general=可写 / scout=外部只读），能被 LLM 调到的工具即在其权限档内，
 *       后台运行不应弹交互确认阻塞父级 loop —— 等价于 MiMo「background subagent
 *       继承父授权」。
 *   - system（非交互系统 agent，如未来的 checkpoint/dream/distill）→ auto-deny：
 *       不阻塞 loop，直接拒绝越权工具。当前项目暂无独立 system agent 类别，保留
 *       该分支以对齐 MiMo 语义、便于后续扩展。
 *
 * 该模块是纯函数 + 依赖无关 → 完全可单测，与 `toolPermission.ts` 同风格。
 * 本层在 `agentPermission → sessionPermission → hardPermission` 之后串联，
 * 只决定「是否弹交互确认」，不改变 hardPermission 的不变式锁。
 *--------------------------------------------------------------------------------------------*/

/** 发起工具调用的 agent 身份。 */
export type AgentAskRole =
	/** 用户直接会话的主 agent（前台）。 */
	| 'foreground'
	/** 后台派发的子 agent（继承父授权，非交互）。 */
	| 'subagent'
	/** 非交互系统 agent（越权自动拒绝，不阻塞 loop）。 */
	| 'system';

/** 子 agent 权限档（对齐 SubAgentType 的字符串值，避免跨模块枚举耦合）。 */
export type SubAgentPermissionType = 'explore' | 'general' | 'scout';

/** 聊天模式（对齐 IAgentTurnRequest.chatMode）。单一真源：sessions/common/agentStudioService.ChatMode。 */
import type { ChatMode } from '../../../common/agentStudioService.js';
export type AskChatMode = ChatMode;

/** 审批路由上下文。 */
export interface IAskRoutingContext {
	readonly role: AgentAskRole;
	readonly subAgentType?: SubAgentPermissionType;
	readonly chatMode?: AskChatMode;
	readonly workMode?: 'plan' | 'work';

}

/** 审批路由决策。 */
export type AskRoutingDecision =
	/** 弹交互确认卡片（走 UI handler）。 */
	| 'interactive'
	/** 非交互放行（继承父授权）。 */
	| 'inherit'
	/** 非交互拒绝（不阻塞 loop）。 */
	| 'auto-deny';

/**
 * 按 agent 身份 / 模式决定审批路由。纯函数。
 *
 * @param ctx 路由上下文；undefined 视为前台交互（向后兼容，行为不变）。
 */
export function decideAskRouting(ctx: IAskRoutingContext | undefined): AskRoutingDecision {
	if (!ctx) {
		return 'interactive';
	}
	switch (ctx.role) {
		case 'system':
			return 'auto-deny';
		case 'subagent':
			return 'inherit';
		case 'foreground':
		default:
			return 'interactive';
	}
}

/**
 * 从一次 turn 的「子 agent 标记」派生审批路由上下文。
 *
 * @param subAgent  IAgentTurnRequest.subAgent（后台子 agent 派发时注入）；无则前台。
 * @param chatMode  IAgentTurnRequest.chatMode。
 */
export function deriveAskRoutingContext(
	subAgent: { readonly type: SubAgentPermissionType; readonly background: boolean } | undefined,
	chatMode?: AskChatMode,
	workMode?: 'plan' | 'work',
): IAskRoutingContext {
	if (subAgent?.background) {
		return { role: 'subagent', subAgentType: subAgent.type, chatMode, workMode };
	}
	return { role: 'foreground', chatMode, workMode };
}
