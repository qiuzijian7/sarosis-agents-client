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

/** Header panel types (toolbar buttons) */
export type HeaderPanelType = 'prompt' | 'condense-skill' | 'skills' | 'config-html' | 'params' | 'memory' | null;

/** Global unique message ID generator */
let _msgSeq = 0;
export function uniqueMsgId(): string {
	return `msg-${Date.now()}-${(++_msgSeq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export { AgentStatus };
