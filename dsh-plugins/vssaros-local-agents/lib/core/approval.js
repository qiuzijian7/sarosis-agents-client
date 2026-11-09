// `approve_agent_action`：把 CLI 的 ACP 权限请求桥成 dsh 审批卡（P1）。
//
// fail-closed 三条：
//   ① 没有 approval 服务 / request 不是函数 → deny；
//   ② 只有官方返回的精确字符串 'allowed-once' 才算 allow；
//   ③ 审批抛错、自由文本、任何非预期值一律 deny。
// 工具结果固定是 JSON 字符串 `{"decision":"allow|deny"}`，由 acpAdapter.parseDecision 解析；
// 模型或人给出的自由文本无法伪造 allow。
import { APPROVE_TOOL } from './mcp.js';

export function createApproveToolDefinition({ requestApproval }) {
	return {
		name: APPROVE_TOOL,
		description: 'Answer a permission request from a local agent CLI. Returns JSON {"decision":"allow"} only when the user explicitly approves once.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', description: 'What the CLI wants to do' },
				options: { type: 'array', items: { type: 'object', additionalProperties: true } },
			},
			required: ['action'],
			additionalProperties: false,
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		execute: async (params, exec) => {
			const decision = await requestApproval(exec, params);
			return JSON.stringify({ decision: decision === 'allow' ? 'allow' : 'deny' });
		},
	};
}

/** 官方审批缝调用（与 vssaros-browser/lib/index.js:495-544 同口径）。 */
export function createApprovalRequester(ctx) {
	return async (exec, params) => {
		const approval = (() => {
			try { return ctx.get?.('approval'); } catch { return undefined; }
		})();
		if (!approval || typeof approval.request !== 'function') return 'deny';
		const action = String(params?.action ?? 'an action');
		try {
			const outcome = await approval.request({
				...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
				...(exec?.callId !== undefined ? { callId: exec.callId } : {}),
				...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
				toolName: APPROVE_TOOL,
				reason: `本地 Agent 请求执行：${action}`,
				displayReason: {
					en: `Allow the local agent to ${action}?`,
					zh: `允许本地 Agent 执行「${action}」吗？`,
				},
			});
			return outcome === 'allowed-once' ? 'allow' : 'deny';
		} catch {
			return 'deny';
		}
	};
}
