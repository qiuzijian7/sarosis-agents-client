/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Post-compaction loop guard — 直译自 OpenClaw `post-compaction-loop-guard.ts`。
 *
 * 作用：防止"compaction 后重新发起 LLM 调用，模型继续原来的循环"。
 * 当 compaction 完成并重新发起调用时，如果接下来 N 次工具调用（windowSize）
 * 都是同一个 (toolName + argsHash + resultHash) 三元组，说明 compaction 没有
 * 打破循环，应该直接 abort，避免在无意义的循环里消耗无限 tokens。
 *
 * 配合点：
 *   - armPostCompaction()：在 compressContext 完成后、重新发起 LLM 调用前调用
 *   - observe(call)：在每个工具执行完成后调用
 *   - observe() 返回 shouldAbort=true 时：yield done + 走 summary 兜底
 */

import { sha256Hex } from './toolGuardrailController.js';

// ─── 观测数据结构 ───────────────────────────────────────────────────────

export interface IPostCompactionObservation {
	toolName: string;
	argsHash: string;
	resultHash: string;
}

// ─── 判断结果 ───────────────────────────────────────────────────────────

export type PostCompactionVerdict =
	| { shouldAbort: false; armed: boolean; remainingAttempts: number }
	| {
			shouldAbort: true;
			armed: boolean;
			remainingAttempts: number;
			detector: 'compaction_loop_persisted';
			count: number;
			toolName: string;
			message: string;
	  };

// ─── Guard 接口 ──────────────────────────────────────────────────────────

export interface IPostCompactionGuard {
	/**
	 * 在 compaction 完成后、重新发起 LLM 调用前调用。
	 * 将 remainingAttempts 重置为 windowSize，开始观察接下来的工具调用。
	 */
	armPostCompaction(): void;

	/**
	 * 在每个工具执行完成后调用。
	 * 若在 window 内观察到 ≥ windowSize 次相同的 (toolName+argsHash+resultHash) 三元组，
	 * 返回 shouldAbort=true → 调用方应 abort 并走 summary 兜底。
	 */
	observe(call: IPostCompactionObservation): PostCompactionVerdict;

	/** 诊断快照 */
	snapshot(): { armed: boolean; remainingAttempts: number };
}

// ─── 实现 ────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 3;

/**
 * 工具函数：从工具调用参数构建 argsHash（稳定序列化，无安全需求）。
 * 注意：toolGuardrailController.buildToolCallSignature 也做了这件事；
 * 这里单独提供一个公开版本供 PostCompactionGuard 使用。
 */
export function buildArgsHash(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== 'object') {
		return sha256Hex('{}');
	}
	return sha256Hex(stableStringify(args));
}

/** 工具函数：从工具结果构建 resultHash（JSON 规范化后取哈希）。 */
export function buildResultHash(result: string | null | undefined): string {
	if (result === null || result === undefined) {
		return sha256Hex('');
	}
	try {
		const parsed = JSON.parse(result);
		return sha256Hex(stableStringify(parsed));
	} catch {
		return sha256Hex(result);
	}
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

/** 创建 post-compaction loop detector（per-run）。 */
export function createPostCompactionGuard(windowSize?: number): IPostCompactionGuard {
	let remainingAttempts = 0;
	let _armed = false;
	const history: IPostCompactionObservation[] = [];
	const _windowSize = Math.max(1, windowSize ?? DEFAULT_WINDOW_SIZE);

	function armPostCompaction(): void {
		remainingAttempts = _windowSize;
		history.length = 0;
		_armed = true;
	}

	function observe(call: IPostCompactionObservation): PostCompactionVerdict {
		if (!_armed || remainingAttempts <= 0) {
			return { shouldAbort: false, armed: false, remainingAttempts: 0 };
		}

		remainingAttempts--;
		history.push(call);

		const armedAfter = remainingAttempts > 0;

		// 比较完整的 (toolName + argsHash + resultHash) 三元组：
		// 同 args 但不同结果 → 有进展，不 abort
		// 同结果但不同 args → 有进展，不 abort
		const matches = history.filter(
			(entry) =>
				entry.toolName === call.toolName &&
				entry.argsHash === call.argsHash &&
				entry.resultHash === call.resultHash,
		);

		if (matches.length >= _windowSize) {
			return {
				shouldAbort: true,
				armed: armedAfter,
				remainingAttempts,
				detector: 'compaction_loop_persisted',
				count: matches.length,
				toolName: call.toolName,
				message: `CRITICAL: tool "${call.toolName}" repeated ${matches.length} times with identical arguments and results within ${_windowSize} attempts after compaction. The compaction did not break the loop. Aborting to prevent runaway token use.`,
			};
		}

		return { shouldAbort: false, armed: armedAfter, remainingAttempts };
	}

	function snapshot() {
		return { armed: _armed, remainingAttempts };
	}

	return { armPostCompaction, observe, snapshot };
}