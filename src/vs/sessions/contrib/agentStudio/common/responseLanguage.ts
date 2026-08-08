/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LLM 回答语言限制。
 *
 * 设计原则：回答语言完全由 Agent Studio 的设置决定，**不**探测操作系统语言。
 *  - `sessions.agentStudio.preferences.responseLanguage` 设为具体语言（如 zh-Hans）时直接使用；
 *  - 设为 `auto` 时，跟随 `sessions.agentStudio.preferences.language`（Agent Studio 显示语言，
 *    默认 zh-CN），由调用方（agentDriverService / taskOrchestrationService）传入，而非读取
 *    navigator.languages / platform.language 等操作系统/UI 语言。
 *  - 设为 `match-user` 时，跟随用户当轮输入语言。
 *
 * 参考：Hermes-Agent / mimo-code 通过 prompt 注入语言；continue 读 vscode.env.language——
 * 但本实现以 Agent Studio 显式设置为准，避免与操作系统语言产生预期差异。
 */

/** 归一化语言码 → 自然语言名称（用于 prompt 指令）。 */
export const LANGUAGE_NAMES: Record<string, string> = {
	'en': 'English',
	'zh-Hans': 'Simplified Chinese (简体中文)',
	'zh-Hant': 'Traditional Chinese (繁體中文)',
	'ja': 'Japanese (日本語)',
	'ko': 'Korean (한국어)',
	'fr': 'French (Français)',
	'de': 'German (Deutsch)',
	'es': 'Spanish (Español)',
	'pt': 'Portuguese (Português)',
	'ru': 'Russian (Русский)',
	'it': 'Italian (Italiano)',
};

/** 哨兵：跟随用户当前输入语言（mimo-code minimax.txt 风格）。 */
export const MATCH_USER_LANGUAGE = 'match-user';

/**
 * BCP-47 / VS Code 语言码 → 归一化码。
 */
function normalizeLangCode(raw: string): string {
	const lc = raw.toLowerCase();
	if (lc.startsWith('zh')) {
		if (lc.includes('hant') || lc.includes('tw') || lc.includes('hk') || lc.includes('mo')) {
			return 'zh-Hant';
		}
		return 'zh-Hans';
	}
	const map: Record<string, string> = { ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', pt: 'pt', ru: 'ru', it: 'it', en: 'en' };
	for (const [prefix, code] of Object.entries(map)) {
		if (lc.startsWith(prefix)) { return code; }
	}
	return 'en';
}

/**
 * 解析最终生效的语言码。
 * @param setting 用户设置值（'auto' | 'match-user' | 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | ...）
 * @param fallbackLanguage 当 setting='auto' 时使用的语言（由调用方传入，
 *        例如 Agent Studio 的显示语言设置 sessions.agentStudio.preferences.language，默认 zh-CN）。
 *        传 undefined / 'auto' 时回退 'en'。不再探测操作系统语言。
 */
export function resolveResponseLanguageCode(setting: string | undefined, fallbackLanguage?: string): string {
	if (!setting || setting === 'auto') {
		// 'auto' = 跟随 Agent Studio 显示语言设置（由调用方提供），不再探测操作系统语言
		const fb = (fallbackLanguage && fallbackLanguage !== 'auto') ? normalizeLangCode(fallbackLanguage) : 'en';
		return fb;
	}
	return setting;
}

/**
 * 构造「回答语言」系统提示词段落（## Response Language）。
 * 作为全局边界规则注入 stable 层；子代理通过继承 request.systemPrompt 自动获得（Hermes 风格一致性）。
 * @param setting 用户设置值（'auto' | 'match-user' | 具体语言）。非 'auto' 时直接生效。
 * @param fallbackLanguage 当 setting='auto' 时使用的语言（由调用方传入 = Agent Studio 显示语言设置）。
 */
export function buildResponseLanguageDirective(setting: string | undefined, fallbackLanguage?: string): string {
	const code = resolveResponseLanguageCode(setting, fallbackLanguage);

	if (code === MATCH_USER_LANGUAGE) {
		return [
			'## Response Language',
			'',
			'Match the language of the user\'s most recent message. If the user writes in Chinese, ' +
			'reply in Chinese; if in English, reply in English; and so on. Preserve code identifiers, ' +
			'commands, file paths, API names, and technical terms in their original form.',
			'',
		].join('\n');
	}

	const name = LANGUAGE_NAMES[code] ?? code;
	return [
		'## Response Language',
		'',
		`Respond in ${name}. Preserve code identifiers, commands, file paths, API names, ` +
		'and technical terms in their original form. If the user explicitly asks for another ' +
		'language, follow the user\'s request.',
		'',
	].join('\n');
}
