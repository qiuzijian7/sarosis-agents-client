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

/**
 * 敏感 key 名（完整单词匹配，避免误伤 `author`/`authority` 等）。
 * 命中即替换**整个值**（不管值内容）—— 因为递归过滤时 key 与值已分开，
 * `stripPrivateData` 的 `key=value` 模式匹配不到纯值（实测 `"password":"xxx"` 漏网）。
 */
const SENSITIVE_KEY_RE = /^(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|credentials|private[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?key)$/i;

/**
 * 递归剥离对象/数组里所有字符串值的敏感信息（深度限制，防循环引用/深嵌套）。
 * 用于 `observe()` 的 `payload.data` —— 工具输入/输出的 key 不固定，只能**逐值**过滤。
 * number/boolean/null/undefined 原样返回（不动类型）。
 *
 * 两级过滤：① key 名命中 `SENSITIVE_KEY_RE` ⇒ 整个值替换；② 否则用 `stripPrivateData`
 * 扫值里的 `key=value` 模式（如 `"output": "token=ghp_..."`）。
 */
export function stripPrivateDataDeep(value: unknown, depth = 0): unknown {
	if (depth > 6) { return value; } // 深度限制（防循环引用/深嵌套拖慢）
	if (typeof value === 'string') { return stripPrivateData(value); }
	if (Array.isArray(value)) { return value.map(v => stripPrivateDataDeep(v, depth + 1)); }
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === 'string') {
				if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[REDACTED_SECRET]'; continue; }
				out[k] = stripPrivateData(v);
			} else {
				out[k] = stripPrivateDataDeep(v, depth + 1);
			}
		}
		return out;
	}
	return value;
}
