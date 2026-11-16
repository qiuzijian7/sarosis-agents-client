const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const CODEBUDDY_RETRY_POLICY = Object.freeze({
	mode: 'normal',
	backoff: Object.freeze({ maxDelayMs: 30_000 }),
});

function retryHint(message) {
	if (typeof message !== 'string') return undefined;
	const body = /^\s*(?:429|5\d\d)\s+(\{[\s\S]*\})\s*$/.exec(message)?.[1];
	if (!body) return undefined;
	let parsed;
	try { parsed = JSON.parse(body); } catch { return undefined; }
	const policy = parsed?.retry_policy;
	if (policy?.retry === false) return undefined;
	const seconds = policy?.retry_after;
	const ms = typeof seconds === 'number' ? seconds * 1000 : NaN;
	return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_DELAY_MS ? ms : undefined;
}

function enrich(chunk) {
	const failure = chunk?.type === 'finish' && chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined;
	if (!failure) return chunk;
	if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) return chunk;
	const ms = retryHint(failure.message);
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
