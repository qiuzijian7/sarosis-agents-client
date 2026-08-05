/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 模型访问 — 从 agentOSService.ts 抽出 5 个方法（~90 行）。
 *
 * 负责模型 Provider 查找、流式 delta 适配、上下文窗口解析、错误格式化。
 */

import { ILogService } from '../../../../platform/log/common/log.js';
import { IModelProvider, IChatStreamDelta } from '../common/providers.js';
import type { TimeoutPolicy } from '../common/resilience.js';

export interface ModelAccessDeps {
	readonly logService: ILogService;
	readonly modelProviders: IModelProvider[];
	activeSelection: { providerId: string; modelId: string } | undefined;
	modelStreamTimeoutPolicy: TimeoutPolicy;
}

/** 按活跃选择的 providerId 查找 IModelProvider。 */
export function getActiveModelProvider(deps: ModelAccessDeps): IModelProvider | undefined {
	if (!deps.activeSelection) { return undefined; }
	return deps.modelProviders.find(p => p.id === deps.activeSelection!.providerId);
}

/** 解析模型真实上下文窗口（token），取不到回退 128000。 */
export async function resolveContextWindow(
	deps: ModelAccessDeps,
	provider: IModelProvider,
	modelId: string
): Promise<number> {
	const FALLBACK = 128000;
	try {
		const models = await provider.listModels?.();
		const info = models?.find((m: any) => m.id === modelId);
		// 优先 contextWindow：IOA 网关模型 (languageModelsBridge) 已将其设为
		// maxInput - maxOutput，是网关安全上限。maxInputTokens 是模型声明最大值，
		// 可能超出网关实际限制（如 hy3-ioa 声明 192K 但网关拒绝 >128K 的请求）。
		const win = info?.contextWindow ?? info?.maxInputTokens;
		if (typeof win === 'number' && win > 0) { return win; }
	} catch (err) {
		deps.logService.warn(`[AgentOS] _resolveContextWindow failed for ${modelId}, falling back to ${FALLBACK}: ${err}`);
	}
	return FALLBACK;
}

/** 中文错误消息格式化（超时 / 通用失败）。 */
export function formatUserFacingError(
	deps: ModelAccessDeps,
	error: Error | undefined,
	triedModels: string[]
): string {
	const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
	if (isTimeout) {
		// 首 token 超时（流未产出任何 delta）与中途静默（已有 delta）语义不同，分别提示。
		const isFirstToken = typeof error.message === 'string' && error.message.includes('first-token');
		const tried = triedModels.length > 0 ? triedModels.join('、') : '';
		if (isFirstToken) {
			// 优先从错误消息解析实际生效的预算（自适应首 token 超时会按 prompt 大小放宽，
			// 静态 policy 值可能与实际不符）。格式：'Stream first-token timeout after 90000ms'。
			const match = /after (\d+)ms/.exec(error.message);
			const effectiveMs = match ? Number(match[1]) : (deps.modelStreamTimeoutPolicy.firstTokenTimeout ?? 45_000);
			const firstSec = Math.round(effectiveMs / 1000);
			return [
				'⚠️ 模型响应超时（首 token）',
				'',
				`主模型在 ${firstSec} 秒内未开始返回任何内容。`,
				'',
				'可能原因：',
				'· 网关冷启动或模型负载较高，推理慢启动',
				'· 当前请求体过大（上下文过长 / 工具列表过多）',
				'',
				'建议：直接重新发送消息重试（网关预热后通常立即恢复）；若反复出现，可切换到更稳定的模型 / Provider。',
			].join('\n');
		}
		const idleSec = Math.round((deps.modelStreamTimeoutPolicy.idleTimeout ?? 180_000) / 1000);
		const triedLine = tried
			? `主模型在约 ${idleSec} 秒内未再返回内容。系统已自动尝试切换备用模型（${tried}），但仍未成功。`
			: `主模型在约 ${idleSec} 秒内未再返回内容。`;
		return [
			'⚠️ 模型响应超时',
			'',
			triedLine,
			'',
			'可能原因：',
			'· 网络或网关连接不稳定（连接存活但不再吐出数据）',
			'· 当前请求体过大，网关在生成大响应时卡住',
			'',
			'建议：重新发送消息重试；若反复出现，可切换到更稳定的模型 / Provider。',
		].join('\n');
	}
	const msg = error?.message || '未知错误';
	const tried = triedModels.length > 0 ? `（已尝试备用模型：${triedModels.join('、')}）` : '';
	return `所有模型均调用失败${tried}。最后错误：${msg}`;
}

/** IModelDelta → IChatStreamDelta 类型适配与防污染。 */
export function adaptModelDelta(deps: ModelAccessDeps, delta: any): IChatStreamDelta {
	const safeContent = (v: unknown): string => (typeof v === 'string' ? v : '');
	if (delta.type === 'text') { return { type: 'text', content: safeContent(delta.content) }; }
	if (delta.type === 'thinking') { return { type: 'thinking', content: safeContent(delta.content) }; }
	if (delta.type === 'tool_call' && delta.toolCall) {
		if (delta.toolCall.name) {
			const result: any = { type: 'tool_start' as any, content: '', toolCallId: delta.toolCall.id, toolName: delta.toolCall.name };
			if (delta.toolCall.displayName !== undefined) { result.displayName = delta.toolCall.displayName; }
			if (delta.toolCall.renderType !== undefined) { result.renderType = delta.toolCall.renderType; }
			if (delta.toolCall.defaultShow !== undefined) { result.defaultShow = delta.toolCall.defaultShow; }
			if (delta.toolCall.serverExecuted) { result.serverExecuted = true; }
			deps.logService.info(`[AgentOS] _adaptModelDelta tool_start: name=${delta.toolCall.name}, defaultShow=${delta.toolCall.defaultShow}, displayName=${delta.toolCall.displayName}, renderType=${delta.toolCall.renderType}`);
			return result;
		}
		return { type: 'tool_args' as any, content: delta.toolCall.arguments || '', toolCallId: delta.toolCall.id };
	}
	// tool_progress（2026-07-26 治本）：工具参数生成进度透传——
	// resilience/subagent 看门狗据此续命；UI 仅作轻量提示，不进正文/装配。
	if (delta.type === 'tool_progress') { return { type: 'tool_progress', stage: safeContent(delta.content) }; }
	if (delta.type === 'done') { return { type: 'done' }; }
	if (delta.type === 'error') { return { type: 'error', content: safeContent(delta.error) || safeContent(delta.content) || 'Unknown error' }; }
	if (delta.type === 'usage' && delta.usage) { return { type: 'usage', usage: delta.usage }; }
	return { type: 'text', content: '' };
}
