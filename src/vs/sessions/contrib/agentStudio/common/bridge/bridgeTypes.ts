/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层：核心类型与端口（对齐 cc-connect core/interfaces.go + message.go + card.go）──
// 本文件位于 common/，仅依赖 base/ 与 common/agentStudio.ts 的类型，不引入浏览器服务依赖。

import { Event } from "../../../../../base/common/event.js";
import { IDisposable } from "../../../../../base/common/lifecycle.js";

// ─── 入站：IM → Bridge ───────────────────────────────────────────────

export interface InboundAttachment {
	readonly mimeType: string; // e.g. "image/png", "application/pdf"
	readonly data: Uint8Array; // raw bytes
	readonly fileName?: string; // original filename (untrusted, sanitize before use)
	readonly filePath?: string; // optional local path after SaveFilesToDisk
}

export interface InboundMessage {
	/** 会话键，形如 "{platform}:{handle}"，如 "feishu:chatA:user1" / "loopback:default" */
	readonly sessionKey: string;
	readonly platform: string;
	readonly messageId: string;
	readonly userId: string;
	readonly userName: string;
	readonly chatName?: string;
	/** 会话 id（群聊为 chat_id，私聊为对端 id）。用于「会话→Agent」绑定路由。 */
	readonly conversationId?: string;
	readonly content: string;
	readonly images?: InboundAttachment[];
	readonly files?: InboundAttachment[];
	/** 平台特定回包句柄（如飞书 message_id+chat_id），出站时原样回传 */
	readonly replyCtx?: unknown;
	/** 来自卡片按钮/内联回调的权限决策（避免 "allow"/"deny" 字面量误入 prompt） */
	readonly isPermissionResponse?: boolean;
	/** 临时覆盖本消息的 Agent 权限模式 */
	readonly modeOverride?: string;
}

// ─── 出站：Bridge → IM ───────────────────────────────────────────────

export type OutboundType =
	| "text"
	| "thinking"
	| "tool_use"
	| "tool_result"
	| "result"
	| "error"
	| "permission_request"
	| "done";

export interface OutboundMessage {
	readonly sessionKey: string;
	readonly type: OutboundType;
	readonly content: string;
	readonly toolName?: string;
	readonly toolInput?: string;
	readonly done?: boolean;
	readonly replyCtx?: unknown;
}

/** 平台回包上下文（sessionKey + 平台回调句柄）。 */
export interface BridgeReplyCtx {
	readonly sessionKey: string;
	readonly replyCtx?: unknown;
}

// ─── 富卡片（对齐 cc-connect core/card.go）─────────────────────────────

export interface BridgeCardHeader {
	readonly title: string;
	readonly color?: string; // blue, green, red, orange, purple, grey, ...
}

export interface BridgeButton {
	readonly text: string;
	readonly type?: "primary" | "default" | "danger";
	readonly value: string; // callback data, e.g. "cmd:/new", "nav:/model"
}

export type BridgeCardElement =
	| { readonly kind: "markdown"; readonly content: string }
	| { readonly kind: "divider" }
	| { readonly kind: "actions"; readonly buttons: BridgeButton[] }
	| { readonly kind: "note"; readonly text: string; readonly tag?: string };

export interface BridgeCard {
	readonly header?: BridgeCardHeader;
	readonly elements: BridgeCardElement[];
}

// ─── 平台适配器端口（对齐 cc-connect core.Platform）────────────────────

export interface IBridgePlatform {
	readonly id: string;
	readonly name: string;
	/**
	 * 允许访问的用户白名单（逗号分隔的 userId；空或 "*" 表示允许所有人）。
	 * 由 BridgeEngine 在路由前做 allowFrom 校验（对齐 cc-connect AllowList）。
	 */
	readonly allowFrom?: string;
	/** 启动平台，注册入站消息回调。可异步（如建立 WS 连接）。 */
	start(handler: (msg: InboundMessage) => void): Promise<void> | void;
	/** 停止平台并释放资源。 */
	stop(): Promise<void> | void;
	/** 主动发消息（不引用某条入站消息）。 */
	send(ctx: BridgeReplyCtx, content: string): Promise<void>;
	/** 回复某条入站消息（带引用/线程上下文）。 */
	reply(ctx: BridgeReplyCtx, content: string): Promise<void>;
	/** 可选：原地更新上一条消息（流式预览）。 */
	update?(ctx: BridgeReplyCtx, content: string): Promise<void>;
	/** 可选：发送富卡片。 */
	sendCard?(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void>;
	replyCard?(ctx: BridgeReplyCtx, card: BridgeCard): Promise<void>;
	/** 可选：带内联按钮发送。buttons 为二维数组，每个内层数组是一行。 */
	sendWithButtons?(ctx: BridgeReplyCtx, content: string, buttons: BridgeButton[][]): Promise<void>;
}

export interface IBridgePlatformFactory {
	readonly id: string;
	create(opts: Record<string, unknown>): IBridgePlatform;
}

// ─── 会话状态（sessionKey → 路由上下文）──────────────────────────────

export interface BridgeSessionState {
	readonly sessionKey: string;
	readonly platform: string;
	agentId: string;
	agentSessionId: string;
	/** 绑定的会话 id（群聊 chat_id），用于按会话路由 Agent。 */
	conversationId?: string;
	chatMode?: string;
	modelOverride?: string;
	replyCtx?: unknown;
	/** 上一条出站的消息 id（供支持 update 的平台做流式预览） */
	lastOutboundId?: string;
}

// ─── Engine 暴露给命令的操作集（避免命令与 Engine 形成循环依赖）──────

export interface IBridgeEngineOps {
	readonly onPlatformOutbound: Event<OutboundMessage>;
	getSession(sessionKey: string): BridgeSessionState | undefined;
	ensureSession(sessionKey: string, platform: string): Promise<BridgeSessionState>;
	listAgents(): Promise<Array<{ id: string; name: string; model: string }>>;
	createSession(sessionKey: string, agentId: string, name?: string): Promise<string>;
	switchSession(sessionKey: string, agentSessionId: string): void;
	listSessions(agentId: string): Promise<Array<{ id: string; name: string; messageCount: number }>>;
	setAgent(sessionKey: string, agentId: string): void;
	/** 绑定某平台的会话 id 到指定 Agent（持久化、跨重启）。 */
	setConversationAgent(platform: string, conversationId: string, agentId: string): void;
	/** 读取某平台某会话 id 绑定的 Agent（未绑定返回 undefined）。 */
	getConversationAgent(platform: string, conversationId: string): string | undefined;
	/** 解除某平台某会话 id 的 Agent 绑定。 */
	clearConversationAgent(platform: string, conversationId: string): void;
	/** 列出某平台所有会话→Agent 绑定。 */
	listConversationBindings(platform: string): Array<{ conversationId: string; agentId: string }>;
	setModelOverride(sessionKey: string, model: string): void;
	setChatMode(sessionKey: string, mode: string): void;
	cancel(sessionKey: string): void;
	clearHistory(sessionKey: string): Promise<void>;
	/** P3：把一条内容 relay 给另一个 Agent（bot↔bot），返回其纯文本回复。 */
	relayToAgent(fromSessionKey: string, toAgentId: string, content: string): Promise<string>;
	/** P3：串行 relay 链（a→b→c），仅把最终回复回传给源会话。 */
	relayChainToAgent(fromSessionKey: string, agentIds: string[], content: string): Promise<string>;
	/** P3：查询 token 用量统计（对齐 cc-connect usage 上报）。 */
	getUsageStats(filter?: { agentId?: string; sessionKey?: string }): IBridgeUsageStats[];
}

// ─── P3：Usage 上报统计（common 层自有类型，避免反向依赖 browser 层）──

export interface IBridgeUsageStats {
	readonly agentId: string;
	readonly sessionKey?: string;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly credit: number;
	readonly calls: number;
}

// ─── Slash 命令上下文与接口 ─────────────────────────────────────────

export interface BridgeCommandContext {
	readonly engine: IBridgeEngineOps;
	readonly session: BridgeSessionState;
	readonly args: string[];
	readonly raw: string;
	/** 当前会话 id（群聊 chat_id）；私聊/无则为 undefined。 */
	readonly conversationId?: string;
	reply(text: string): void;
	replyCard(card: BridgeCard): void;
}

export interface IBridgeCommand {
	readonly name: string;
	readonly description: string;
	readonly usage?: string;
	run(ctx: BridgeCommandContext): Promise<void> | void;
}

export { IDisposable };
