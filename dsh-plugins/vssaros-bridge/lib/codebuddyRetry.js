const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 上游 CodeBuddy 限流（HTTP 429 / code 14003 `too many requests`）的冷却窗口是 30s
 * （错误体 `retry_policy.retry_after`）。中转站有时只透传纯文本 `relay error: too many requests`，
 * 拿不到结构化 hint；若沿用本地 500ms 起步的退避，maxRetries=5 会在几秒内全部撞在同一个
 * 限流窗口上 ⇒ `exceeded retry limit, last status: 429 Too Many Requests`。
 * 故对已确认的限流失败，兜底按上游要求的 30s 等待。
 */
const RATE_LIMIT_FALLBACK_MS = 30_000;

export const CODEBUDDY_RETRY_POLICY = Object.freeze({
	mode: 'normal',
	backoff: Object.freeze({ maxDelayMs: 30_000 }),
});

function rateLimitedByText(message) {
	const text = String(message ?? '');
	return /^\s*429\b|\b429\s+Too Many Requests\b|too many requests|rate[ _-]?limit/i.test(text);
}

function isRateLimited(failure, message) {
	const code = String(failure?.code ?? '').toUpperCase();
	const status = Number(failure?.status ?? failure?.statusCode);
	return code === 'RATE_LIMIT' || code === '429' || status === 429 || rateLimitedByText(message);
}

function parseBody(message) {
	if (typeof message !== 'string') return undefined;
	const prefixed = /^\s*(?:429|5\d\d)\s+(\{[\s\S]*\})\s*$/.exec(message)?.[1];
	// 中转站/上游也可能直接把错误体（或 OpenAI 风格的 `error` 包装）作为 message 透传。
	// 只在文本已表明是限流时才按裸 JSON 解析，避免对任意 JSON 误注入退避。
	const text = prefixed ?? (rateLimitedByText(message) ? message.trim() : undefined);
	if (!text || !text.startsWith('{') || !text.endsWith('}')) return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch { return undefined; }
}

function retryAfterMs(policy) {
	if (!policy || policy.retry === false) return undefined;
	const seconds = policy.retry_after;
	const ms = typeof seconds === 'number' ? seconds * 1000 : NaN;
	return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_DELAY_MS ? ms : undefined;
}

function retryHint(message, failure) {
	const limited = isRateLimited(failure, message);
	const parsed = parseBody(message);
	const policy = parsed?.retry_policy ?? parsed?.error?.retry_policy ?? parsed?.data?.retry_policy;
	if (policy?.retry === false) return undefined;
	const ms = retryAfterMs(policy);
	if (ms !== undefined) return ms;
	return limited ? RATE_LIMIT_FALLBACK_MS : undefined;
}

function enrich(chunk) {
	const failure = chunk?.type === 'finish' && chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined;
	if (!failure) return chunk;
	if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) return chunk;
	const ms = retryHint(failure.message, failure);
	return ms === undefined ? chunk : { ...chunk, reason: { ...chunk.reason, failure: { ...failure, providerRetryAfterMs: ms } } };
}

async function awaitStream(result, signal) {
	if (!signal) return result;
	const upstream = Promise.resolve(result);
	let onAbort;
	const cancelled = new Promise((_, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
	try { return await Promise.race([upstream, cancelled]); }
	finally { signal.removeEventListener('abort', onAbort); }
}

export function codebuddyRetryListener(options, next) {
	const result = next();
	if (options?.provider !== 'vssaros-codebuddy') return result;
	const iterate = async function* (stream) {
		options.signal?.throwIfAborted();
		for await (const chunk of stream) {
			options.signal?.throwIfAborted();
			yield enrich(chunk);
		}
	};
	if (result && typeof result[Symbol.asyncIterator] === 'function') return iterate(result);
	if (result && typeof result.then === 'function') {
		return (async function* () { yield* iterate(await awaitStream(result, options.signal)); })();
	}
	return result;
}
