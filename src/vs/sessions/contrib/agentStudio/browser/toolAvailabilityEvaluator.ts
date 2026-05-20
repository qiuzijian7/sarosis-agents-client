/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool Availability Evaluator — 声明式可用性条件评估
 *
 * 参考 OpenClaw 的 ToolAvailabilityExpression + evaluateToolAvailability():
 *  - 每个工具声明 availability 条件（config/env/platform/custom）
 *  - 运行时自动评估这些条件
 *  - 不满足条件的工具自动隐藏（而非执行时报错）
 *
 * 好处：
 *  - 未配置 API key 时自动隐藏相关工具
 *  - 特定环境下自动启用/禁用工具（如 web_search 需要搜索 API key）
 *  - 减少用户手动管理负担
 *  - 避免模型调用不可用工具浪费 token
 */

import type { IToolAvailability, IToolDefinition } from '../common/providers.js';

// ─── Platform Detection ─────────────────────────────────────────────

export type Platform = 'desktop' | 'web' | 'node';

/**
 * 检测当前运行平台
 */
export function detectPlatform(): Platform {
	if (typeof process !== 'undefined' && process.versions?.node) {
		return 'node';
	}
	if (typeof window !== 'undefined' && (window as any).acquireVsCodeApi) {
		return 'desktop';
	}
	return 'web';
}

// ─── Availability Context ───────────────────────────────────────────

/**
 * 可用性评估上下文 — 传入各种运行时状态供条件评估使用。
 */
export interface IAvailabilityContext {
	/** 当前平台 */
	readonly platform: Platform;
	/** 配置项获取器 */
	getConfig(key: string): unknown;
	/** 环境变量获取器 */
	getEnv(key: string): string | undefined;
	/** 自定义条件评估器 */
	evaluateCustom?(condition: string): boolean;
}

// ─── Evaluator ──────────────────────────────────────────────────────

/**
 * 评估单个可用性条件
 */
export function evaluateAvailabilityCondition(
	condition: IToolAvailability,
	context: IAvailabilityContext,
): boolean {
	let result: boolean;

	switch (condition.type) {
		case 'always':
			result = true;
			break;

		case 'config':
			// 配置项存在且非空即满足
			if (!condition.condition) { result = true; break; }
			const configValue = context.getConfig(condition.condition);
			result = configValue !== undefined && configValue !== null && configValue !== '';
			break;

		case 'env':
			// 环境变量存在且非空即满足
			if (!condition.condition) { result = true; break; }
			const envValue = context.getEnv(condition.condition);
			result = envValue !== undefined && envValue !== '';
			break;

		case 'platform':
			// 当前平台匹配即满足
			if (!condition.condition) { result = true; break; }
			result = context.platform === condition.condition;
			break;

		case 'custom':
			// 自定义条件（由 provider 实现评估）
			if (!condition.condition || !context.evaluateCustom) {
				result = true;
				break;
			}
			result = context.evaluateCustom(condition.condition);
			break;

		default:
			result = true;
	}

	// 支持取反
	return condition.negate ? !result : result;
}

/**
 * 评估一组可用性条件（所有条件需同时满足 = AND 逻辑）
 */
export function evaluateToolAvailability(
	conditions: IToolAvailability[] | undefined,
	context: IAvailabilityContext,
): boolean {
	if (!conditions || conditions.length === 0) {
		return true; // 无条件 = 始终可用
	}
	return conditions.every(c => evaluateAvailabilityCondition(c, context));
}

/**
 * 过滤工具列表 — 只返回在当前上下文中可用的工具。
 * 替代简单的 enable/disable 开关，实现智能的自动过滤。
 */
export function filterAvailableTools(
	tools: IToolDefinition[],
	context: IAvailabilityContext,
): IToolDefinition[] {
	return tools.filter(t => evaluateToolAvailability(t.availability, context));
}

// ─── Availability Explanation ───────────────────────────────────────

/**
 * 生成可用性条件的人类可读说明（供 UI 显示"为什么此工具不可用"）
 */
export function explainAvailability(
	conditions: IToolAvailability[] | undefined,
	context: IAvailabilityContext,
): { available: boolean; reasons: string[] } {
	if (!conditions || conditions.length === 0) {
		return { available: true, reasons: [] };
	}

	const reasons: string[] = [];
	let allMet = true;

	for (const condition of conditions) {
		const met = evaluateAvailabilityCondition(condition, context);
		if (!met) {
			allMet = false;
			reasons.push(_formatReason(condition));
		}
	}

	return { available: allMet, reasons };
}

function _formatReason(condition: IToolAvailability): string {
	const negStr = condition.negate ? 'NOT ' : '';
	switch (condition.type) {
		case 'config':
			return `Requires configuration: ${negStr}"${condition.condition}"`;
		case 'env':
			return `Requires environment variable: ${negStr}"${condition.condition}"`;
		case 'platform':
			return `Requires platform: ${negStr}"${condition.condition}"`;
		case 'custom':
			return `Requires condition: ${negStr}"${condition.condition}"`;
		default:
			return 'Unknown condition';
	}
}

// ─── Default Context Builder ────────────────────────────────────────

/**
 * 创建一个基于 VS Code 配置服务的可用性上下文。
 * 供 BuiltinToolProvider 和 McpToolProvider 使用。
 */
export function createAvailabilityContext(options: {
	configGetter: (key: string) => unknown;
	envGetter?: (key: string) => string | undefined;
	customEvaluator?: (condition: string) => boolean;
}): IAvailabilityContext {
	return {
		platform: detectPlatform(),
		getConfig: options.configGetter,
		getEnv: options.envGetter ?? (() => undefined),
		evaluateCustom: options.customEvaluator,
	};
}
