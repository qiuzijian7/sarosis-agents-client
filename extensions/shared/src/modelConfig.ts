/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared model configuration utilities for Sarosis chat model providers.
 */

import * as vscode from 'vscode';
import { IModelTokenLimits } from './types';

/**
 * Parse a models configuration value (string or string[]) into an array of model names.
 */
export function parseModelsConfig(modelsConfig: unknown): string[] | null {
	if (!modelsConfig) { return null; }

	let modelNames: string[] = [];
	if (Array.isArray(modelsConfig)) {
		modelNames = modelsConfig.filter((m: unknown) => typeof m === 'string' && (m as string).trim().length > 0) as string[];
	} else if (typeof modelsConfig === 'string') {
		modelNames = modelsConfig.split(',').map((m: string) => m.trim()).filter((m: string) => m.length > 0);
	}

	return modelNames.length > 0 ? modelNames : null;
}

/**
 * Generate a human-readable display name from a model identifier.
 * e.g. "claude-sonnet-4.6" → "Claude Sonnet 4.6"
 */
export function generateDisplayName(modelName: string): string {
	return modelName
		.split('-')
		.map(part => /^\d+(\.\d+)*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(' ');
}

/**
 * Create a vscode.LanguageModelChatInformation object for a given model.
 */
export function createModelInfo(
	modelName: string,
	vendorPrefix: string,
	family: string,
	detail: string,
	tokenLimits: IModelTokenLimits,
	capabilities?: { supportsImages?: boolean; supportsToolCall?: boolean },
): vscode.LanguageModelChatInformation {
	const displayName = generateDisplayName(modelName);
	return {
		id: vendorPrefix ? `${vendorPrefix}-${modelName}` : modelName,
		name: displayName,
		family,
		version: '1',
		maxInputTokens: tokenLimits.maxInputTokens,
		maxOutputTokens: tokenLimits.maxOutputTokens,
		tooltip: displayName,
		detail,
		capabilities: {
			imageInput: capabilities?.supportsImages ?? false,
			toolCalling: capabilities?.supportsToolCall ?? true,
		},
	};
}

// ─── Token 限制回退策略（对齐 MiMo-Code 数据驱动模型）──────────────────────
// 不再硬编码每个模型的 token 限制。模型元数据应从 provider 的 API（如 CodeBuddy
// /v3/config）实时获取。以下常量仅在元数据不可用时作为安全回退。
// 参考：MiMo-Code packages/opencode/src/provider/transform.ts

/** 默认上下文窗口大小（对齐 MiMo DEFAULT_CONTEXT_WINDOW = 1_000_000） */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** 输出 token 安全上限（对齐 MiMo OUTPUT_TOKEN_MAX = 32_000） */
export const OUTPUT_TOKEN_MAX = 32_000;

/**
 * 当模型元数据不可用时返回的默认 token 限制（非 CodeBuddy 插件回退）。
 * 对齐 MiMo-Code: context=1M, output=32K。
 */
export function getDefaultTokenLimits(): IModelTokenLimits {
	return {
		maxInputTokens: DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: OUTPUT_TOKEN_MAX,
		maxAllowedSize: DEFAULT_CONTEXT_WINDOW,
	};
}

/**
 * 将服务端返回的 maxOutputTokens 钳制到安全上限。
 * 对齐 MiMo maxOutputTokens(): min(limit.output, OUTPUT_TOKEN_MAX)。
 * 服务端值为 0/undefined/falsy 时回退到 OUTPUT_TOKEN_MAX。
 */
export function clampOutputTokens(serverMaxOutput: number | undefined | null): number {
	if (!serverMaxOutput || serverMaxOutput <= 0) { return OUTPUT_TOKEN_MAX; }
	return Math.min(serverMaxOutput, OUTPUT_TOKEN_MAX);
}

/**
 * Model configuration interface with full model information.
 */
export interface IModelConfig {
	id: string;
	name: string;
	vendor?: string;
	maxOutputTokens?: number;
	maxInputTokens: number;
	supportsToolCall?: boolean;
	supportsImages?: boolean;
	disabledMultimodal?: boolean;
	maxAllowedSize: number;
	supportsReasoning?: boolean;
	onlyReasoning?: boolean;
	temperature?: number;
	reasoning?: {
		effort: string;
		summary?: string;
	};
	relatedModels?: {
		lite?: string;
		reasoning?: string;
	};
	descriptionEn?: string;
	descriptionZh?: string;
	credits?: string;
	tags?: string[];
	top_p?: number;
	top_k?: number;
	repetition_penalty?: number;
	isDefault?: boolean;
	supportsExtra?: boolean;
}
