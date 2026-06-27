/*---------------------------------------------------------------------------------------------
 *  隐私过滤器 — 在记忆落盘前剥离敏感信息。
 *  参考 agentmemory src/functions/privacy.ts
 *--------------------------------------------------------------------------------------------*/

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

const SECRET_PATTERNS = [
	/(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
	/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
	/sk-proj-[A-Za-z0-9\-_]{20,}/g,
	/(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
	/sk-ant-[A-Za-z0-9\-_]{20,}/g,
	/gh[pus]_[A-Za-z0-9]{36,}/g,
	/github_pat_[A-Za-z0-9_]{22,}/g,
	/xoxb-[A-Za-z0-9\-]+/g,
	/AKIA[0-9A-Z]{16}/g,
	/AIza[A-Za-z0-9\-_]{35}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/npm_[A-Za-z0-9]{36}/g,
	/glpat-[A-Za-z0-9\-_]{20,}/g,
	/x-tai-identity[:\s=]+[A-Za-z0-9._\-]{20,}/gi,
];

export function stripPrivateData(input: string): string {
	let result = input.replace(PRIVATE_TAG_RE, '[REDACTED]');
	for (const pattern of SECRET_PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags);
		result = result.replace(re, '[REDACTED_SECRET]');
	}
	return result;
}

export function stripUndefinedLiterals(s: string | undefined | null): string {
	if (!s) return '';
	if (!s.includes('undefined')) return s;
	return s.replace(/(?:undefined)+/g, '');
}
