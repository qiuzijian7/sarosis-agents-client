/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 provider 目录 —— 单一数据源。
 *
 * 背景（重构于 P1）：内置 provider 的原本身份信息曾在两处各自维护：
 *   - `browser/builtInBYOKModelProvider.ts` 的 `BUILTIN_BYOK_PROVIDERS`（驱动**运行时**：
 *     `_getBaseUrl()` 从它取 baseUrl，聊天请求实际用它）
 *   - `browser/views/providerView.ts` 的 `PROVIDER_DEFINITIONS`（驱动**设置 UI**：
 *     卡片展示、Base URL placeholder、连通性测试）
 *
 * 两处手工同步，已实际漂移（gemini 的 defaultBaseUrl 不同、custom 项缺失），
 * 后果是「UI 展示/测试的端点」与「聊天真实使用的端点」不一致。
 *
 * 现在共享身份字段（id / name / baseUrl / 配置键）只在本文件定义一次，
 * 两个注册表各自派生，只补充自己独有的关注点：
 *   - 功能侧：priority / modelsEndpointPath / staticModels / 协议标志
 *   - UI 侧：icon / iconColor / description
 *
 * 本模块刻意**不依赖任何 DOM 或 browser/ 代码**，因此可在 Node 测试环境中直接导入。
 */

import {
	AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
	AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
	AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
	AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
	AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
	AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
	AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
	AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
	AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
	AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
	AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
	AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
} from './constants.js';

/**
 * 内置 provider 的共享身份信息。
 *
 * 只包含两侧都需要的字段；协议/模型/UI 展示等专属信息由各注册表补充。
 */
export interface IBuiltinProviderIdentity {
	/** 唯一 id，如 'openrouter' */
	readonly id: string;
	/** 展示名，如 'OpenRouter' */
	readonly name: string;
	/** API key 的配置键 */
	readonly apiKeyConfigKey: string;
	/** Base URL 的配置键 */
	readonly baseUrlConfigKey: string;
	/** 默认 Base URL（未配置时使用） */
	readonly defaultBaseUrl: string;
}

/**
 * 内置 provider 身份目录（唯一来源）。
 *
 * 顺序即默认展示顺序；两侧注册表都按此顺序派生，避免顺序漂移。
 */
export const BUILTIN_PROVIDER_IDENTITIES: readonly IBuiltinProviderIdentity[] = [
	{
		id: 'openrouter',
		name: 'OpenRouter',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
	},
	{
		id: 'nous',
		name: 'Nous',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
		defaultBaseUrl: 'https://api.nous.com/v1',
	},
	{
		id: 'gemini',
		name: 'Gemini',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
		// Gemini 的 OpenAI 兼容端点。UI 侧此前误写为 'https://generativelanguage.googleapis.com'
		// （缺 /v1beta/openai 后缀），导致 UI 展示的端点与聊天实际使用的端点不一致。
		defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
		defaultBaseUrl: 'https://api.anthropic.com',
	},
	{
		id: 'main',
		name: 'Main',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
		defaultBaseUrl: '',
	},
	{
		id: 'ollama',
		name: 'Ollama',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
		defaultBaseUrl: 'http://localhost:11434',
	},
	{
		id: 'custom',
		name: 'Custom',
		apiKeyConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
		baseUrlConfigKey: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
		defaultBaseUrl: '',
	},
];

/** 按 id 取身份信息；未注册时返回 undefined。 */
export function findBuiltinProviderIdentity(id: string): IBuiltinProviderIdentity | undefined {
	return BUILTIN_PROVIDER_IDENTITIES.find(identity => identity.id === id);
}
