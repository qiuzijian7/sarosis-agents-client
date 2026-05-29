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
): vscode.LanguageModelChatInformation {
	const displayName = generateDisplayName(modelName);
	return {
		id: `${vendorPrefix}-${modelName}`,
		name: displayName,
		family,
		version: '1',
		maxInputTokens: tokenLimits.maxInputTokens,
		maxOutputTokens: tokenLimits.maxOutputTokens,
		tooltip: displayName,
		detail,
		capabilities: {},
	};
}

/**
 * Get model token limits based on model name heuristics.
 * Values are based on actual API responses (see logs).
 */
export function getModelTokenLimits(modelName: string): IModelTokenLimits {
	// Claude models with 1M context
	if (modelName.includes('claude') && modelName.includes('1m')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 16_384, maxAllowedSize: 1_000_000 };
	}
	// Claude models (non-1M): maxInputTokens=176000, maxAllowedSize=200000
	if (modelName.includes('claude')) {
		return { maxInputTokens: 176_000, maxOutputTokens: 16_384, maxAllowedSize: 200_000 };
	}
	// GPT-5.5: 1M context
	if (modelName.includes('gpt-5.5')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 16_384, maxAllowedSize: 1_000_000 };
	}
	// GPT-5.4, GPT-5.3-codex: 272k context
	if (modelName.includes('gpt-5.4') || modelName.includes('gpt-5.3-codex')) {
		return { maxInputTokens: 272_000, maxOutputTokens: 16_384, maxAllowedSize: 272_000 };
	}
	// Other GPT models: 128k context (default)
	if (modelName.includes('gpt')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 16_384, maxAllowedSize: 128_000 };
	}
	// Gemini-3.5-flash: 1M context
	if (modelName.includes('gemini-3.5-flash')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, maxAllowedSize: 1_000_000 };
	}
	// Gemini-3.1-flash-lite, Gemini-3.0-pro, Gemini-3.0-flash: 200k context
	if (modelName.includes('gemini-3.1-flash-lite') || modelName.includes('gemini-3.0-pro') || modelName.includes('gemini-3.0-flash')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 8_192, maxAllowedSize: 200_000 };
	}
	// Gemini Pro / 2.5-Pro (1M context)
	if (modelName.includes('gemini-pro') || modelName.includes('gemini-2.5-pro')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, maxAllowedSize: 1_000_000 };
	}
	// Other Gemini models: 128k context
	if (modelName.includes('gemini')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
	}
	// DeepSeek (ioa): 96k context
	if (modelName.includes('deepseek') && modelName.includes('ioa')) {
		return { maxInputTokens: 96_000, maxOutputTokens: 8_192, maxAllowedSize: 96_000 };
	}
	// DeepSeek (other): 128k context
	if (modelName.includes('deepseek')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
	}
	// GLM (ioa): 200k context
	if (modelName.includes('glm') && modelName.includes('ioa')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 8_192, maxAllowedSize: 200_000 };
	}
	// GLM (other): 200k context
	if (modelName.includes('glm')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 8_192, maxAllowedSize: 200_000 };
	}
	// Kimi (ioa): 256k context
	if (modelName.includes('kimi') && modelName.includes('ioa')) {
		return { maxInputTokens: 256_000, maxOutputTokens: 8_192, maxAllowedSize: 256_000 };
	}
	// Kimi (other): 128k context
	if (modelName.includes('kimi')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
	}
	// MiniMax (ioa): 200k context
	if (modelName.includes('minimax') && modelName.includes('ioa')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 8_192, maxAllowedSize: 200_000 };
	}
	// MiniMax (other): 128k context
	if (modelName.includes('minimax')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
	}
	// Hunyuan: 128k context
	if (modelName.includes('hunyuan')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
	}
	// Default: 128k context
	return { maxInputTokens: 128_000, maxOutputTokens: 8_192, maxAllowedSize: 128_000 };
}

/** Default CC Internal model list (Claude only) */
export const CC_INTERNAL_DEFAULT_MODELS = [
	'claude-sonnet-4.6', 'claude-sonnet-4.6-1m',
	'claude-4.5', 'claude-haiku-4.5',
	'claude-opus-4.7', 'claude-opus-4.7-1m',
	'claude-opus-4.6', 'claude-opus-4.6-1m',
	'claude-opus-4.5',
];

/** Default CodeBuddy model list (all vendors) */
export const CODEBUDDY_DEFAULT_MODELS = [
	// Anthropic
	'claude-sonnet-4.6', 'claude-sonnet-4.6-1m', 'claude-4.5', 'claude-haiku-4.5',
	'claude-opus-4.7', 'claude-opus-4.7-1m', 'claude-opus-4.6', 'claude-opus-4.6-1m', 'claude-opus-4.5',
	// OpenAI
	'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex',
	'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
	// Google
	'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3.0-pro', 'gemini-3.0-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite',
	// 国产 (-ioa 后缀走内部免费额度)
	'glm-5.1-ioa', 'glm-5.0-ioa', 'glm-5.0-turbo-ioa', 'glm-5v-turbo-ioa',
	'glm-4.6-ioa', 'glm-4.6v-ioa', 'glm-4.7-ioa',
	'deepseek-v3-2-volc-ioa',
	'minimax-m2.5-ioa', 'minimax-m2.7-ioa',
	'kimi-k2.5-ioa', 'kimi-k2.6-ioa', 'kimi-k2-thinking',
	'hunyuan-2.0-thinking-ioa', 'hunyuan-chat',
	'hunyuan-image-v3.0-ioa', 'hunyuan-image-v2.0-general-edit-ioa',
];

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

/**
 * Default CodeBuddy model configurations (full info).
 * Based on actual API responses (see logs).
 */
export const CODEBUDDY_DEFAULT_MODEL_CONFIGS: IModelConfig[] = [
	// Anthropic Claude models
	{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', maxInputTokens: 176000, maxAllowedSize: 200000 },
	{ id: 'claude-sonnet-4.6-1m', name: 'Claude Sonnet 4.6 (1M)', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'claude-4.5', name: 'Claude 4.5', maxInputTokens: 176000, maxAllowedSize: 200000 },
	{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', maxInputTokens: 176000, maxAllowedSize: 200000 },
	{ id: 'claude-opus-4.7', name: 'Claude Opus 4.7', maxInputTokens: 176000, maxAllowedSize: 200000 },
	{ id: 'claude-opus-4.7-1m', name: 'Claude Opus 4.7 (1M)', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'claude-opus-4.6', name: 'Claude Opus 4.6', maxInputTokens: 176000, maxAllowedSize: 200000 },
	{ id: 'claude-opus-4.6-1m', name: 'Claude Opus 4.6 (1M)', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'claude-opus-4.5', name: 'Claude Opus 4.5', maxInputTokens: 176000, maxAllowedSize: 200000 },
	// OpenAI GPT models
	{ id: 'gpt-5.5', name: 'GPT-5.5', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'gpt-5.4', name: 'GPT-5.4', maxInputTokens: 272000, maxAllowedSize: 272000 },
	{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', maxInputTokens: 272000, maxAllowedSize: 272000 },
	{ id: 'gpt-5.2', name: 'GPT-5.2', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'gpt-5.1', name: 'GPT-5.1', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', maxInputTokens: 128000, maxAllowedSize: 128000 },
	// Google Gemini models
	{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'gemini-3.0-pro', name: 'Gemini 3.0 Pro', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', maxInputTokens: 1000000, maxAllowedSize: 1000000 },
	{ id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', maxInputTokens: 200000, maxAllowedSize: 200000 },
	// 国产模型 (-ioa 后缀走内部免费额度)
	{ id: 'glm-5.1-ioa', name: 'GLM-5.1 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-5.0-ioa', name: 'GLM-5.0 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-5.0-turbo-ioa', name: 'GLM-5.0 Turbo (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-5v-turbo-ioa', name: 'GLM-5V Turbo (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-4.6-ioa', name: 'GLM-4.6 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-4.6v-ioa', name: 'GLM-4.6V (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'glm-4.7-ioa', name: 'GLM-4.7 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'deepseek-v3-2-volc-ioa', name: 'DeepSeek V3.2 Volc (IOA)', maxInputTokens: 96000, maxAllowedSize: 96000 },
	{ id: 'minimax-m2.5-ioa', name: 'MiniMax M2.5 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'minimax-m2.7-ioa', name: 'MiniMax M2.7 (IOA)', maxInputTokens: 200000, maxAllowedSize: 200000 },
	{ id: 'kimi-k2.5-ioa', name: 'Kimi K2.5 (IOA)', maxInputTokens: 256000, maxAllowedSize: 256000 },
	{ id: 'kimi-k2.6-ioa', name: 'Kimi K2.6 (IOA)', maxInputTokens: 256000, maxAllowedSize: 256000 },
	{ id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'hunyuan-2.0-thinking-ioa', name: 'Hunyuan 2.0 Thinking (IOA)', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'hunyuan-chat', name: 'Hunyuan Chat', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'hunyuan-image-v3.0-ioa', name: 'Hunyuan Image V3.0 (IOA)', maxInputTokens: 128000, maxAllowedSize: 128000 },
	{ id: 'hunyuan-image-v2.0-general-edit-ioa', name: 'Hunyuan Image V2.0 General Edit (IOA)', maxInputTokens: 128000, maxAllowedSize: 128000 },
	// 其他模型（从日志中看到）
	{ id: 'hy3-preview-agent-ioa', name: 'HY3 Preview Agent (IOA)', maxInputTokens: 192000, maxAllowedSize: 192000 },
	{ id: 'auto', name: 'Auto', maxInputTokens: 168000, maxAllowedSize: 168000 },
	{ id: 'echo', name: 'Echo', maxInputTokens: 120000, maxAllowedSize: 120000 },
];
