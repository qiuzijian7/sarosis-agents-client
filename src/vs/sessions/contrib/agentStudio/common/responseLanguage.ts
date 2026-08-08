/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LLM 回答语言限制。
 *
 * 设计参考（兄弟项目源码）：
 *  - mimo-code: renderer 侧 `navigator.languages` 检测 OS 语言（packages/desktop/src/renderer/i18n/index.ts
 *    `detectLocale()`），prompt 用 "Match the user's language unless instructed otherwise"。
 *  - void (VS Code fork): 主进程 `app.getPreferredSystemLanguages()?.[0]` 作为 osLocale（src/main.ts）。
 *  - Hermes-Agent: 语言通过 prompt / system message 注入；子代理需继承父语言（delegate_tool 注释）。
 *  - continue: 读取 `vscode.env.language`。
 *
 * 本实现采用 mimo-code/void 的 renderer 检测法（Electron Chromium 下 `navigator.languages`
 * 即 OS 首选语言，等价于 void 的 `app.getPreferredSystemLanguages()`），无需 IPC。
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
 * 检测操作系统当前设置的语言。
 *
 * 优先级（参考 continue 读 vscode.env.language 的做法）：
 *  1. caller 显式传入（如 agentDriverService 从 platform.language 注入）
 *  2. renderer navigator.languages（mimo-code detectLocale / void getPreferredSystemLanguages 等价法）
 *  3. 回退 'en'
 *
 * 返回归一化语言码（en / zh-Hans / zh-Hant / ja / ko / fr / de / es / pt / ru / it）。
 */
export function detectOSLanguage(overrideLang?: string): string {
	// continue 风格：优先使用 VS Code 平台 UI 语言（等价于 vscode.env.language）
	if (overrideLang) {
		return normalizeLangCode(overrideLang);
	}

	// mimo-code / void 风格：renderer navigator.languages
	if (typeof navigator !== 'object' || !navigator) {
		return 'en';
	}
	const languages: readonly string[] =
		(navigator.languages && navigator.languages.length > 0)
			? navigator.languages
			: (navigator.language ? [navigator.language] : []);
	for (const raw of languages) {
		if (!raw) { continue; }
		const code = normalizeLangCode(raw);
		if (code !== 'en') { return code; }
	}
	return 'en';
}

/**
 * 解析最终生效的语言码。
 * @param setting 用户设置值（'auto' | 'match-user' | 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | ...）
 * @param osLanguage 平台 UI 语言（等价于 vscode.env.language / platform.language），传 undefined 则自动检测
 */
export function resolveResponseLanguageCode(setting: string | undefined, osLanguage?: string): string {
	if (!setting || setting === 'auto') {
		return detectOSLanguage(osLanguage);
	}
	return setting;
}

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
 * 构造「回答语言」系统提示词段落（## Response Language）。
 * 作为全局边界规则注入 stable 层；子代理通过继承 request.systemPrompt 自动获得（Hermes 风格一致性）。
 * @param setting 用户设置值
 * @param osLanguage 平台 UI 语言（等价于 vscode.env.language / platform.language），传 undefined 则自动检测
 */
export function buildResponseLanguageDirective(setting: string | undefined, osLanguage?: string): string {
	const code = resolveResponseLanguageCode(setting, osLanguage);

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
