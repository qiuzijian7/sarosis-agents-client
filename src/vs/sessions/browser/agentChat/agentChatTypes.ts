/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Chat — Type definitions (ported from saros-webui)

import { AgentStatus } from '../../common/agentStudioTypes.js';

/** Chat message with streaming/tool-call/thinking support */
export interface IAgentChatMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system';
	content: string;
	readonly timestamp: number;
	isStreaming?: boolean;
	toolCalls?: IToolCall[];
	thinking?: string;
	isThinking?: boolean;
	currentStep?: string;           // 'call_llm' | 'execute_tool' | custom
	tokenUsage?: { input: number; output: number; total: number };
	metadata?: Record<string, unknown>;
}

/** Tool call within a message */
export interface IToolCall {
	id: string;
	name: string;
	args?: string;
	result?: string;
	status?: 'running' | 'completed';
}

/** Status display mapping */
export const STATUS_MAP: Record<AgentStatus, { label: string; color: string; bg: string; dot: string; animated: boolean }> = {
	[AgentStatus.Idle]:     { label: '空闲',   color: '#9ca3af',  bg: 'rgba(255,255,255,0.05)', dot: '#9ca3af',  animated: false },
	[AgentStatus.Working]:  { label: '工作中', color: '#4ade80',  bg: 'rgba(74,222,128,0.08)',  dot: '#4ade80',  animated: true  },
	[AgentStatus.Thinking]: { label: '思考中', color: '#7cb9ff',  bg: 'rgba(124,185,255,0.08)', dot: '#7cb9ff',  animated: true  },
	[AgentStatus.Error]:     { label: '出错',   color: '#e94560',  bg: 'rgba(233,69,96,0.08)',   dot: '#e94560',  animated: false },
	[AgentStatus.Offline]:   { label: '离线',   color: '#6b7280',  bg: 'rgba(255,255,255,0.02)', dot: 'rgba(255,255,255,0.2)', animated: false },
};

/** Agent info passed to the chat panel */
export interface IAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly avatarUrl?: string;
	readonly status: AgentStatus;
	readonly isPM?: boolean;
	readonly customPrompt?: string;
	readonly model?: string;
	readonly provider?: string;
	/** Agent type — only 'planner' supports plan mode */
	readonly agentType?: 'general' | 'planner' | string;
}

/** Provider info for model selector */
export interface IProviderInfo {
	readonly id: string;
	readonly label: string;
}

/** Model info for model selector */
export interface IModelInfo {
	readonly id: string;
	readonly label: string;
	readonly provider: string;
}

/** Chat mode — mirrors webview ChatMode */
export type ChatMode = 'craft' | 'ask' | 'plan';

/** Mode option metadata for the composer mode dropdown */
export interface IModeOption {
	readonly id: ChatMode;
	readonly label: string;
	readonly description: string;
	readonly icon: string;       // SVG path d=
}

/** Header dropdown panel types (toolbar buttons) */
export type HeaderPanelType =
	| 'worktree'
	| 'message-nav'
	| 'history'
	| 'settings'
	| null;

/** Worktree info for header dropdown */
export interface IWorktreeItem {
	readonly path: string;
	readonly branch: string;
}

/** Lightweight summary of a user message — fed into the message-nav dropdown */
export interface IMessageNavItem {
	readonly id: string;
	readonly summary: string;
	readonly timestamp: number;
}

/** Session info bar payload */
export interface ISessionInfo {
	readonly mode: ChatMode;
	readonly superior?: { id: string; name: string };
	readonly subordinates?: ReadonlyArray<{ id: string; name: string }>;
	readonly taskCount: number;
}

/** Agent session metadata for the chat-history side panel */
export interface IAgentSessionMeta {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

/** Token usage snapshot used to render the context-usage ring */
export interface IContextUsage {
	readonly used: number;
	readonly limit: number;
	readonly percent: number; // 0-100
	readonly ratio: number;   // 0-1
}

/** Checkpoint info for the CheckpointBar */
export interface ICheckpointInfo {
	readonly id: string;
	readonly label: string;
	readonly timestamp: number;
	readonly fileCount: number;
	readonly files: ReadonlyArray<{ path: string; status: 'modified' | 'created' | 'deleted' }>;
}

/** Global unique message ID generator */
let _msgSeq = 0;
export function uniqueMsgId(): string {
	return `msg-${Date.now()}-${(++_msgSeq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export { AgentStatus };
