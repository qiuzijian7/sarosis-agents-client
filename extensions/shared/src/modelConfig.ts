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
 */
export function getModelTokenLimits(modelName: string): IModelTokenLimits {
	// Claude models with 1M context
	if (modelName.includes('claude') && modelName.includes('1m')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 16_384 };
	}
	// Claude models
	if (modelName.includes('claude')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 16_384 };
	}
	// GPT models
	if (modelName.includes('gpt')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 16_384 };
	}
	// Gemini Pro / 2.5-Pro (1M context)
	if (modelName.includes('gemini-pro') || modelName.includes('gemini-2.5-pro')) {
		return { maxInputTokens: 1_000_000, maxOutputTokens: 8_192 };
	}
	// Gemini other
	if (modelName.includes('gemini')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
	}
	// DeepSeek
	if (modelName.includes('deepseek')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
	}
	// GLM
	if (modelName.includes('glm')) {
		return { maxInputTokens: 200_000, maxOutputTokens: 8_192 };
	}
	// MiniMax
	if (modelName.includes('minimax')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
	}
	// Kimi
	if (modelName.includes('kimi')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
	}
	// Hunyuan
	if (modelName.includes('hunyuan')) {
		return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
	}
	// Default
	return { maxInputTokens: 128_000, maxOutputTokens: 8_192 };
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
	'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex',
	'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
	// Google
	'gemini-3.1-pro', 'gemini-3.0-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite',
	// 国产 (-ioa 后缀走内部免费额度)
	'glm-5.1-ioa', 'glm-5.0-ioa', 'glm-5.0-turbo-ioa', 'glm-5v-turbo-ioa',
	'glm-4.6-ioa', 'glm-4.6v-ioa', 'glm-4.7-ioa',
	'deepseek-v3-2-volc-ioa',
	'minimax-m2.5-ioa', 'minimax-m2.7-ioa',
	'kimi-k2.5-ioa', 'kimi-k2-thinking',
	'hunyuan-2.0-thinking-ioa', 'hunyuan-chat',
	'hunyuan-image-v3.0-ioa', 'hunyuan-image-v2.0-general-edit-ioa',
];
