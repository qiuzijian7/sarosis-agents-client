/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool-call loop guardrail primitives.
 *
 * 直译自 Hermes-Agent `agent/tool_guardrails.py`。设计原则：本模块**纯函数无副作用**，
 * 它只跟踪每个 turn 的工具调用观察 + 返回决策，由调用方决定如何处置（warn / block / halt）。
 *
 * 三种细粒度循环信号：
 *   1) exact_failure  — 同一 (tool_name + canonical args) 反复失败
 *   2) same_tool_failure — 同名工具不论参数都反复失败
 *   3) idempotent_no_progress — 只读工具（read_file/search 等）同签名同结果反复返回
 *
 * 配合点：
 *   - before_call(name, args)：在调度执行前调用，返回 block 时合成 tool_result + 跳过执行
 *   - after_call(name, args, result, failed)：在执行后调用，返回 halt 时退出主循环
 *   - reset_for_turn()：每个新 turn 进入主循环前调用，清空计数器
 */

// ─── 幂等（只读）工具白名单 ─────────────────────────────────────────────
// 这些工具不修改外部状态；同样的参数应该返回同样的结果。
// 命中此名单 + 同签名 + 同结果哈希 → 触发 idempotent_no_progress。
//
// 与 Hermes 对齐 + 项目内置工具补齐：file_read / search_files / list /
// http_get / read_skill / list_skills / kanban_show / kanban_list / recall。
export const IDEMPOTENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	// 项目内置（builtinToolProvider.ts）
	'file_read',
	'search_files',
	'recall',
	'read_skill',
	'list_skills',
	'kanban_show',
	'kanban_list',
	// Hermes 命名（兼容外部 MCP 工具）
	'read_file',
	'web_search',
	'web_extract',
	'session_search',
	'browser_snapshot',
	'browser_console',
	'browser_get_images',
	'mcp_filesystem_read_file',
	'mcp_filesystem_read_text_file',
	'mcp_filesystem_read_multiple_files',
	'mcp_filesystem_list_directory',
	'mcp_filesystem_list_directory_with_sizes',
	'mcp_filesystem_directory_tree',
	'mcp_filesystem_get_file_info',
	'mcp_filesystem_search_files',
]);

// ─── 修改型工具黑名单 ─────────────────────────────────────────────────
// 命中此名单的工具一定**不会**被当作幂等工具，即便它出现在 IDEMPOTENT 名单里
// （兜底：防止同名外部工具误判）。修改型工具不应触发 no_progress 检测，因为
// 它们的"无进展"反而可能是正常重试（如 terminal 重新执行同一脚本）。
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	'terminal',
	'execute_code',
	'file_write',
	'write_file',
	'patch',
	'todo',
	'memory',
	'skill_manage',
	'browser_click',
	'browser_type',
	'browser_press',
	'browser_scroll',
	'browser_navigate',
	'send_message',
	'cronjob',
	'delegate_task',
	'process',
	// 项目内 kanban 写类
	'kanban_create',
	'kanban_complete',
	'kanban_block',
	'kanban_unblock',
	'kanban_heartbeat',
	'kanban_comment',
	'kanban_link',
	'kanban_specify',
	'kanban_decompose',
	'kanban_swarm',
]);

// ─── 配置 ────────────────────────────────────────────────────────────
export interface IToolCallGuardrailConfig {
	/** 是否启用 warn 等级（不阻断执行，仅在结果中追加提示）。默认开启 */
	warningsEnabled: boolean;
	/** 是否启用 hard stop（block / halt）。默认开启 —— IDE 嵌入式 Agent 应主动叫停 */
	hardStopEnabled: boolean;

	/** exact_failure：同 (name+args) 失败次数 ≥ N 时，warn */
	exactFailureWarnAfter: number;
	/** exact_failure：同 (name+args) 失败次数 ≥ N 时，block 后续同签名调用 */
	exactFailureBlockAfter: number;

	/** same_tool_failure：同名工具失败次数 ≥ N 时，warn */
	sameToolFailureWarnAfter: number;
	/** same_tool_failure：同名工具失败次数 ≥ N 时，halt（退出主循环） */
	sameToolFailureHaltAfter: number;

	/** idempotent_no_progress：同签名同结果次数 ≥ N 时，warn */
	noProgressWarnAfter: number;
	/** idempotent_no_progress：同签名同结果次数 ≥ N 时，block */
	noProgressBlockAfter: number;
}

/**
 * 默认配置 —— 推荐收紧值（适合 IDE 嵌入式 Agent）。
 * 与 saros-agents-client 主循环 MAX_TOOL_ITERATIONS=30 对齐；
 * 主动叫停优先于继续尝试，避免上下文越跑越偏。
 */
export const DEFAULT_GUARDRAIL_CONFIG: IToolCallGuardrailConfig = {
	warningsEnabled: true,
	hardStopEnabled: true,
	exactFailureWarnAfter: 2,
	exactFailureBlockAfter: 3,    // 收紧值：3 次同 args 失败即 block（Hermes 默认 5）
	sameToolFailureWarnAfter: 3,
	sameToolFailureHaltAfter: 5,  // 收紧值：5 次同名失败即 halt（Hermes 默认 8）
	noProgressWarnAfter: 2,
	noProgressBlockAfter: 3,      // 收紧值：3 次同结果即 block（Hermes 默认 5）
};

// ─── 数据结构 ────────────────────────────────────────────────────────
export interface IToolCallSignature {
	readonly toolName: string;
	readonly argsHash: string;
}

export type GuardrailAction = 'allow' | 'warn' | 'block' | 'halt';

export type GuardrailCode =
	| 'allow'
	| 'repeated_exact_failure_warning'
	| 'repeated_exact_failure_block'
	| 'same_tool_failure_warning'
	| 'same_tool_failure_halt'
	| 'idempotent_no_progress_warning'
	| 'idempotent_no_progress_block';

export interface IToolGuardrailDecision {
	readonly action: GuardrailAction;
	readonly code: GuardrailCode;
	readonly message: string;
	readonly toolName: string;
	readonly count: number;
	readonly signature: IToolCallSignature;
}

// ─── 工具函数 ────────────────────────────────────────────────────────
function canonicalToolArgs(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== 'object') {
		return '{}';
	}
	// 等价于 Python 的 json.dumps(sort_keys=True, separators=(',', ':'))
	return stableStringify(args);
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) {
		return JSON.stringify(value ?? null);
	}
	if (typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return '[' + value.map(stableStringify).join(',') + ']';
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts: string[] = [];
	for (const k of keys) {
		const v = (value as Record<string, unknown>)[k];
		if (v === undefined) { continue; }
		parts.push(JSON.stringify(k) + ':' + stableStringify(v));
	}
	return '{' + parts.join(',') + '}';
}

export function sha256Hex(value: string): string {
	// 用于循环检测（非安全场景），不需要真正的 SHA-256；这里用一个稳定的
	// 64 位混合哈希，避免在 webview/renderer 引入 node:crypto 依赖。
	// 算法：FNV-1a 64bit（拆成两个 32bit），输出 16 位 hex。
	let h1 = 0x811c9dc5 | 0;
	let h2 = 0x1b873593 | 0;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x85ebca6b);
		h2 = (h2 << 13) | (h2 >>> 19);
	}
	const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
	const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
	return hex1 + hex2;
}

export function buildToolCallSignature(
	toolName: string,
	args: Record<string, unknown> | undefined,
): IToolCallSignature {
	return { toolName, argsHash: sha256Hex(canonicalToolArgs(args)) };
}

function signatureKey(sig: IToolCallSignature): string {
	return `${sig.toolName}::${sig.argsHash}`;
}

function resultHash(result: string | null | undefined): string {
	if (result === null || result === undefined) {
		return sha256Hex('');
	}
	// 优先按 JSON 规范化（屏蔽 key 顺序差异）
	try {
		const parsed = JSON.parse(result);
		return sha256Hex(stableStringify(parsed));
	} catch {
		return sha256Hex(result);
	}
}

/**
 * 兜底分类器：把工具结果判定为 "failed=true/false"。
 *
 * 直译自 Hermes `agent.display._detect_tool_failure`。生产路径调用方
 * 都会显式传 `failed`（已知 success 字段），此函数仅用于 standalone /
 * 测试场景下保持行为一致。
 */
export function classifyToolFailure(toolName: string, result: string | null | undefined): boolean {
	if (result === null || result === undefined) { return false; }

	if (toolName === 'terminal') {
		try {
			const data = JSON.parse(result);
			if (data && typeof data === 'object' && 'exit_code' in data) {
				const exit = (data as { exit_code?: unknown }).exit_code;
				if (exit !== null && exit !== undefined && exit !== 0) {
					return true;
				}
			}
		} catch {
			// not json → fall through
		}
		return false;
	}

	const lowered = result.slice(0, 500).toLowerCase();
	if (lowered.includes('"error"') || lowered.includes('"failed"') || result.startsWith('Error')) {
		return true;
	}
	return false;
}

// ─── Controller ──────────────────────────────────────────────────────
/**
 * 工具调用循环护栏控制器（per-turn）。
 *
 * 用法：
 *   const ctrl = new ToolGuardrailController();
 *   ctrl.resetForTurn();  // 每个 agent turn 主循环开始时调用
 *   for each tool call in iteration:
 *     const before = ctrl.beforeCall(name, args);
 *     if (before.action === 'block') {
 *       // 不要执行，把 toolGuardSyntheticResult(before) 当作 tool result 喂回
 *       // 模型 + break 主循环（halt_decision 已被记录）
 *     }
 *     const result = await execute(...);
 *     const after = ctrl.afterCall(name, args, resultStr, { failed });
 *     if (after.action === 'halt') {
 *       // halt 信号：把 appendToolGuardGuidance(result, after) 喂回模型
 *       // 然后 break 主循环
 *     } else if (after.action === 'warn') {
 *       // warn：把 appendToolGuardGuidance(result, after) 拼到 result 末尾
 *     }
 */
export class ToolGuardrailController {
	private readonly _config: IToolCallGuardrailConfig;
	private _exactFailureCounts = new Map<string, number>();
	private _sameToolFailureCounts = new Map<string, number>();
	private _noProgress = new Map<string, { resultHash: string; count: number }>();
	private _haltDecision: IToolGuardrailDecision | undefined;

	constructor(config?: Partial<IToolCallGuardrailConfig>) {
		this._config = { ...DEFAULT_GUARDRAIL_CONFIG, ...(config ?? {}) };
	}

	get config(): Readonly<IToolCallGuardrailConfig> { return this._config; }

	get haltDecision(): IToolGuardrailDecision | undefined { return this._haltDecision; }

	resetForTurn(): void {
		this._exactFailureCounts.clear();
		this._sameToolFailureCounts.clear();
		this._noProgress.clear();
		this._haltDecision = undefined;
	}

	beforeCall(toolName: string, args: Record<string, unknown> | undefined): IToolGuardrailDecision {
		const signature = buildToolCallSignature(toolName, args);
		const sigKey = signatureKey(signature);

		if (!this._config.hardStopEnabled) {
			return this._allow(toolName, signature);
		}

		// (1) exact_failure block
		const exactCount = this._exactFailureCounts.get(sigKey) ?? 0;
		if (exactCount >= this._config.exactFailureBlockAfter) {
			const decision: IToolGuardrailDecision = {
				action: 'block',
				code: 'repeated_exact_failure_block',
				message: `Blocked ${toolName}: the same tool call failed ${exactCount} times with identical arguments. ` +
					'Stop retrying it unchanged; change strategy or explain the blocker.',
				toolName,
				count: exactCount,
				signature,
			};
			this._haltDecision = decision;
			return decision;
		}

		// (2) idempotent_no_progress block
		if (this._isIdempotent(toolName)) {
			const record = this._noProgress.get(sigKey);
			if (record && record.count >= this._config.noProgressBlockAfter) {
				const decision: IToolGuardrailDecision = {
					action: 'block',
					code: 'idempotent_no_progress_block',
					message: `Blocked ${toolName}: this read-only call returned the same result ${record.count} times. ` +
						'Stop repeating it unchanged; use the result already provided or try a different query.',
					toolName,
					count: record.count,
					signature,
				};
				this._haltDecision = decision;
				return decision;
			}
		}

		return this._allow(toolName, signature);
	}

	afterCall(
		toolName: string,
		args: Record<string, unknown> | undefined,
		result: string | null | undefined,
		opts?: { failed?: boolean },
	): IToolGuardrailDecision {
		const signature = buildToolCallSignature(toolName, args);
		const sigKey = signatureKey(signature);
		const failed = opts?.failed ?? classifyToolFailure(toolName, result ?? null);

		if (failed) {
			const exactCount = (this._exactFailureCounts.get(sigKey) ?? 0) + 1;
			this._exactFailureCounts.set(sigKey, exactCount);
			this._noProgress.delete(sigKey);

			const sameCount = (this._sameToolFailureCounts.get(toolName) ?? 0) + 1;
			this._sameToolFailureCounts.set(toolName, sameCount);

			// halt 优先级最高 —— 先看是否触发同名工具 halt
			if (this._config.hardStopEnabled && sameCount >= this._config.sameToolFailureHaltAfter) {
				const decision: IToolGuardrailDecision = {
					action: 'halt',
					code: 'same_tool_failure_halt',
					message: `Stopped ${toolName}: it failed ${sameCount} times this turn. ` +
						'Stop retrying the same failing tool path and choose a different approach.',
					toolName,
					count: sameCount,
					signature,
				};
				this._haltDecision = decision;
				return decision;
			}

			// 然后是 warn 等级
			if (this._config.warningsEnabled && exactCount >= this._config.exactFailureWarnAfter) {
				return {
					action: 'warn',
					code: 'repeated_exact_failure_warning',
					message: `${toolName} has failed ${exactCount} times with identical arguments. ` +
						'This looks like a loop; inspect the error and change strategy instead of retrying it unchanged.',
					toolName,
					count: exactCount,
					signature,
				};
			}
			if (this._config.warningsEnabled && sameCount >= this._config.sameToolFailureWarnAfter) {
				return {
					action: 'warn',
					code: 'same_tool_failure_warning',
					message: toolFailureRecoveryHint(toolName, sameCount),
					toolName,
					count: sameCount,
					signature,
				};
			}

			return this._allow(toolName, signature, exactCount);
		}

		// success path：清空失败计数
		this._exactFailureCounts.delete(sigKey);
		this._sameToolFailureCounts.delete(toolName);

		// 修改型工具不参与 no_progress 跟踪
		if (!this._isIdempotent(toolName)) {
			this._noProgress.delete(sigKey);
			return this._allow(toolName, signature);
		}

		// idempotent path：跟踪同签名同结果
		const rh = resultHash(result);
		const previous = this._noProgress.get(sigKey);
		const repeatCount = previous && previous.resultHash === rh ? previous.count + 1 : 1;
		this._noProgress.set(sigKey, { resultHash: rh, count: repeatCount });

		if (this._config.warningsEnabled && repeatCount >= this._config.noProgressWarnAfter) {
			return {
				action: 'warn',
				code: 'idempotent_no_progress_warning',
				message: `${toolName} returned the same result ${repeatCount} times. ` +
					'Use the result already provided or change the query instead of repeating it unchanged.',
				toolName,
				count: repeatCount,
				signature,
			};
		}

		return this._allow(toolName, signature, repeatCount);
	}

	private _isIdempotent(toolName: string): boolean {
		if (MUTATING_TOOL_NAMES.has(toolName)) { return false; }
		return IDEMPOTENT_TOOL_NAMES.has(toolName);
	}

	private _allow(toolName: string, signature: IToolCallSignature, count = 0): IToolGuardrailDecision {
		return {
			action: 'allow',
			code: 'allow',
			message: '',
			toolName,
			count,
			signature,
		};
	}
}

// ─── 决策工具函数 ────────────────────────────────────────────────────
/**
 * 为 block 的工具调用合成一个 role=tool 的 content 字符串。
 *
 * 用法：当 beforeCall 返回 block 时不真正执行工具，而是把这个字符串当作
 * "这次调用的 tool result" 喂回模型，让模型在下一轮看到 guardrail 信号。
 */
export function toolGuardSyntheticResult(decision: IToolGuardrailDecision): string {
	return JSON.stringify({
		error: decision.message,
		guardrail: {
			action: decision.action,
			code: decision.code,
			tool_name: decision.toolName,
			count: decision.count,
		},
	});
}

/**
 * 把 warn / halt 的 guidance 追加到现有 result 末尾。
 * 模型在下一轮可以"看到"自己刚刚被打了 warning，从而调整行为。
 */
export function appendToolGuardGuidance(result: string, decision: IToolGuardrailDecision): string {
	if ((decision.action !== 'warn' && decision.action !== 'halt') || !decision.message) {
		return result;
	}
	const label = decision.action === 'halt' ? 'Tool loop hard stop' : 'Tool loop warning';
	const suffix = `\n\n[${label}: ${decision.code}; count=${decision.count}; ${decision.message}]`;
	return (result || '') + suffix;
}

function toolFailureRecoveryHint(toolName: string, count: number): string {
	const common = `${toolName} has failed ${count} times this turn. This looks like a loop. ` +
		'Do not switch to text-only replies; keep using tools, but diagnose before retrying. ' +
		'First inspect the latest error/output and verify your assumptions. ';
	if (toolName === 'terminal') {
		return common +
			'For terminal failures, run a small diagnostic such as `pwd && ls -la` in the same tool, ' +
			'then try an absolute path, a simpler command, a different working directory, ' +
			'or a different tool such as file_read/file_write/patch.';
	}
	return common +
		'Try different arguments, a narrower query/path, an absolute path when relevant, ' +
		'or a different tool that can make progress. If the blocker is external, report ' +
		'the blocker after one diagnostic attempt instead of repeating the same failing path.';
}
