/*---------------------------------------------------------------------------------------------
 *  regexValidator —— 复刻 continue（core/util/regexValidator.ts）的正则校验/净化机制。
 *
 *  背景（2026-07-27，日志 1785132636052 对比 continue 后重构）：Sarosis 的 search_code
 *  原走「图谱内容 grep + deadline」，缺少 continue 那套「ripgrep 前把 query 校验/净化并
 *  回传 warning」的健壮性闭环。本模块把 continue 的三件套原样落地，供 search_code（ripgrep
 *  引擎）在执行前调用：修常见问题（三重转义、裸制表符/换行）、给 ripgrep 特有告警
 *  （lookahead 需 PCRE2、八进制转义）、区分字面 vs 正则并转义字面量。
 *--------------------------------------------------------------------------------------------*/

export interface RegexValidationResult {
	isValid: boolean;
	sanitizedQuery?: string;
	error?: string;
	warning?: string;
}

/**
 * 校验并净化一个正则模式（对齐 continue validateAndSanitizeRegex）。
 * 只做「能自动修的就修 + 其余回传 warning」，不因语法可疑而拒绝执行
 * （ripgrep 支持部分 JS 不支持的语法，故 JS RegExp 编译失败仅告警）。
 */
export function validateAndSanitizeRegex(query: string): RegexValidationResult {
	const problematicPatterns: Array<{ pattern: RegExp; issue: string; fix: ((s: string) => string) | null }> = [
		{
			// 三重反斜杠序列
			pattern: /\\\\\\/g,
			issue: 'Triple backslash sequences may cause parsing errors',
			fix: (s: string) => s.replace(/\\\\\\/g, '\\\\'),
		},
		{
			// 未转义的括号（{} 是合法量词，单独处理，不在此列）
			pattern: /(?<!\\)[\[\]()]/g,
			issue: 'Unescaped brackets or parentheses',
			fix: null, // 仅告警——可能是有意的正则构造
		},
		{
			// 非量词形态的未转义花括号
			pattern: /(?<!\\)\{(?![0-9,}]*\})/g,
			issue: "Unescaped braces that don't appear to be quantifiers",
			fix: null,
		},
		{
			// 裸制表符/换行/回车（应转义）
			pattern: /[\t\n\r]/g,
			issue: 'Raw whitespace characters should be escaped',
			fix: (s: string) => s.replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'),
		},
	];

	let sanitizedQuery = query;
	const warnings: string[] = [];

	for (const check of problematicPatterns) {
		if (check.pattern.test(query)) {
			if (check.fix) {
				sanitizedQuery = check.fix(sanitizedQuery);
				warnings.push(`Fixed: ${check.issue}`);
			} else {
				warnings.push(`Warning: ${check.issue}`);
			}
		}
	}

	// 尝试作为 JS 正则编译以捕获基础语法错误（失败不拒绝，仅告警——ripgrep 可能仍支持）
	try {
		// eslint-disable-next-line no-new
		new RegExp(sanitizedQuery);
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : 'Unknown error';
		warnings.push(`Pattern may have syntax issues: ${errorMessage}`);
	}

	// ripgrep 特有：合法 JS 正则但在 rg 下可能不如预期
	const ripgrepSpecificIssues: Array<{ pattern: RegExp; warning: string }> = [
		{ pattern: /\\[0-7]{3}/g, warning: 'Octal escape sequences may not work as expected in ripgrep' },
		{ pattern: /\(\?[<!=]/, warning: 'Lookahead/lookbehind assertions require ripgrep to be compiled with PCRE2' },
	];
	for (const issue of ripgrepSpecificIssues) {
		if (issue.pattern.test(sanitizedQuery)) {
			warnings.push(issue.warning);
		}
	}

	return {
		isValid: true,
		sanitizedQuery,
		warning: warnings.length > 0 ? warnings.join('; ') : undefined,
	};
}

/** 把字面串转义为可安全用于正则的模式（对齐 continue escapeLiteralForRegex）。 */
export function escapeLiteralForRegex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判定 query 是否「更像字面搜索」而非有意的正则（对齐 continue looksLikeLiteralSearch）。
 * 规则：含未转义元字符、但没有转义元字符、也没有正则构造（\d\w\s、量词 {n,m}、字符类）。
 */
export function looksLikeLiteralSearch(query: string): boolean {
	const hasUnescapedMetachars = /[.*+?^${}()|[\]]/g.test(query);
	const hasEscapedMetachars = /\\[.*+?^${}()|[\]\\]/g.test(query);
	const hasEscapeSequences = /\\[dws]/g.test(query); // \d \w \s
	const hasQuantifiers = /\{[0-9,]+\}/g.test(query); // {2,4} {3}

	const bracketPattern = /\[[^\]]*\]/g;
	const brackets = query.match(bracketPattern);
	let hasCharacterClasses = false;
	if (brackets) {
		hasCharacterClasses = brackets.some((bracket) => {
			const inside = bracket.slice(1, -1);
			return /-/.test(inside) || inside.length > 1 || inside.startsWith('^');
		});
	}

	const hasRegexConstructs = hasEscapeSequences || hasQuantifiers || hasCharacterClasses;
	return hasUnescapedMetachars && !hasEscapedMetachars && !hasRegexConstructs;
}

/**
 * 为 ripgrep 准备 query：净化问题模式并回传 warning（对齐 continue prepareQueryForRipgrep）。
 */
export function prepareQueryForRipgrep(query: string): { query: string; warning?: string } {
	const validation = validateAndSanitizeRegex(query);
	return {
		query: validation.sanitizedQuery || query,
		warning: validation.warning,
	};
}
