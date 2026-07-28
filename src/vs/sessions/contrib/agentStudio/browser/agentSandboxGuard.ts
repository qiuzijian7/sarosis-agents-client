/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Sandbox Guard — 工具审批 + 安全沙箱确认 UI。
 * 从 agentOSService.ts 抽出 ~180 行。
 */

import { ILogService } from '../../../../platform/log/common/log.js';
import { IToolApprovalHandler, IToolCallInfo, IToolProvider, SandboxConfirmationDecision, ISandboxViolationInfo } from '../common/providers.js';
import type { IConfirmationData } from '../../../browser/agentChat/agentChatTypes.js';

export interface SandboxGuardDeps {
	readonly logService: ILogService;
	/** 工具审批服务。 */
	readonly approvalService: { setApprovalHandler(h: IToolApprovalHandler): void };
	/** 待决沙箱确认 Map。 */
	readonly pendingSandboxConfirmations: Map<string, (decision: SandboxConfirmationDecision) => void>;
	/** 工具执行代理（用于重执行被沙箱拦截的调用）。 */
	executeToolCalls: (toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal) => Promise<Array<{ toolCallId: string; content: any; success: boolean }>>;
	/** 获取 BuiltinToolProvider（用于 sandbox bypass）。 */
	getBuiltinProvider: () => (IToolProvider & { addSandboxBypassRoot?: (p: string) => void; removeSandboxBypassRoot?: (p: string) => void }) | undefined;
	/** 持久化沙箱根目录到 workspace。 */
	persistSandboxRoot: (workspaceId: string, dir: string) => Promise<void>;
}

export class SandboxGuard {
	constructor(private readonly _deps: SandboxGuardDeps) { }

	setToolApprovalHandler(handler: IToolApprovalHandler): void {
		this._deps.approvalService.setApprovalHandler(handler);
		this._deps.logService.info('[AgentOS] Tool approval handler registered');
	}

	// ─── 沙箱确认 ──────────────────────────────────────────────

	mapConfirmationButtonToDecision(buttonId: string): SandboxConfirmationDecision {
		switch (buttonId) {
			case 'allow_once': return SandboxConfirmationDecision.AllowOnce;
			case 'allow_workspace': return SandboxConfirmationDecision.AllowWorkspace;
			case 'use_suggested': return SandboxConfirmationDecision.UseSuggested;
			case 'cancel':
			case 'reject':
			case 'deny':
				return SandboxConfirmationDecision.Cancel;
			default:
				this._deps.logService.warn(`[AgentOS] Unknown sandbox confirmation button "${buttonId}" → Cancel`);
				return SandboxConfirmationDecision.Cancel;
		}
	}

	mapDecisionToCardStatus(decision: SandboxConfirmationDecision): 'approved' | 'rejected' | 'cancelled' {
		return decision === SandboxConfirmationDecision.Cancel ? 'cancelled' : 'approved';
	}

	/** 工具结果是否因安全沙箱限制而失败 */
	isSandboxViolation(result: { metadata?: { sandboxViolation?: ISandboxViolationInfo } }): boolean {
		return !!result.metadata?.sandboxViolation;
	}

	/** 生成沙箱确认卡片数据。 */
	buildConfirmationCard(toolName: string, v: ISandboxViolationInfo): IConfirmationData {
		const allowedList = v.allowedRoots.length > 0
			? v.allowedRoots.map(r => `  • ${r}`).join('\n')
			: '  （无 — 请确认已正确配置工作区）';
		const lines: string[] = [
			`工具 "${toolName}" 请求访问的路径不在允许的工作区目录内：`,
			`  ${v.requestedPath}`,
			'',
			'当前允许的工作区目录：',
			allowedList,
		];
		if (v.suggestedPath) {
			lines.push('', `建议路径（落在允许根内）：${v.suggestedPath}`);
		}
		const buttons: Array<{ id: string; label: string; primary?: boolean; danger?: boolean }> = [
			{ id: 'allow_once', label: '允许本次', primary: true },
			{ id: 'allow_workspace', label: '允许此工作区' },
		];
		if (v.suggestedPath) {
			buttons.push({ id: 'use_suggested', label: '改用建议路径' });
		}
		buttons.push({ id: 'cancel', label: '取消', danger: true });
		return {
			id: '',
			title: '安全沙箱限制',
			message: lines.join('\n'),
			detail: v.resolvedPath !== v.requestedPath ? `解析后: ${v.resolvedPath}` : undefined,
			buttons,
			status: 'pending',
			securityLevel: 'dangerous',
		};
	}

	/** 等待用户对沙箱受限工具调用的决策。 */
	awaitConfirmation(confirmationId: string): Promise<SandboxConfirmationDecision> {
		return new Promise<SandboxConfirmationDecision>((resolve) => {
			this._deps.pendingSandboxConfirmations.set(confirmationId, resolve);
		});
	}

	/** 把路径参数值从 requestedPath 改写为 suggestedPath */
	_rewritePathArgs(args: unknown, requestedPath: string, suggestedPath: string): unknown {
		if (typeof args === 'string') {
			try {
				const parsed = JSON.parse(args) as Record<string, unknown>;
				this._rewritePathInObject(parsed, requestedPath, suggestedPath);
				return JSON.stringify(parsed);
			} catch { return args; }
		}
		if (args && typeof args === 'object') {
			const cloned = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
			this._rewritePathInObject(cloned, requestedPath, suggestedPath);
			return cloned;
		}
		return args;
	}

	private _rewritePathInObject(obj: Record<string, unknown>, requestedPath: string, suggestedPath: string): void {
		for (const key of Object.keys(obj)) {
			const val = obj[key];
			if (typeof val === 'string' && val === requestedPath) {
				obj[key] = suggestedPath;
			} else if (val && typeof val === 'object') {
				this._rewritePathInObject(val as Record<string, unknown>, requestedPath, suggestedPath);
			}
		}
	}

	/** 按用户决策重执行被沙箱拦截的工具调用。 */
	async reExecuteAfterSandbox(
		tc: IToolCallInfo,
		agentId: string,
		worktreePath: string | undefined,
		signal: AbortSignal | undefined,
		decision: SandboxConfirmationDecision,
		v: ISandboxViolationInfo,
		workspaceId: string,
	): Promise<{ toolCallId: string; content: any; success: boolean }> {
		if (decision === SandboxConfirmationDecision.Cancel) {
			return {
				toolCallId: tc.id,
				content: [{ type: 'text', text: '操作已取消：用户拒绝了沙箱受限路径。请改用允许的工作区目录，或选择「允许此工作区」/「改用建议路径」。' }],
				success: false,
			};
		}

		let reCall = tc;
		if (decision === SandboxConfirmationDecision.UseSuggested && v.suggestedPath) {
			reCall = { ...tc, arguments: this._rewritePathArgs(tc.arguments, v.requestedPath, v.suggestedPath) as string };
		}

		const builtin = this._deps.getBuiltinProvider();

		if (decision === SandboxConfirmationDecision.AllowOnce) {
			builtin?.addSandboxBypassRoot?.(v.requestedPath);
		} else if (decision === SandboxConfirmationDecision.AllowWorkspace) {
			const dir = v.requestedPath.replace(/[\\/][^\\/]*$/, '');
			await this._deps.persistSandboxRoot(workspaceId, dir);
		}

		try {
			const results = await this._deps.executeToolCalls([reCall], agentId, worktreePath, signal);
			const r = results[0];
			return { toolCallId: r.toolCallId, content: r.content, success: r.success };
		} finally {
			if (decision === SandboxConfirmationDecision.AllowOnce) {
				builtin?.removeSandboxBypassRoot?.(v.requestedPath);
			}
		}
	}
}
