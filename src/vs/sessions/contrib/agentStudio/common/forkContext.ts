/*---------------------------------------------------------------------------------------------
 *  Fork Prefix Cache (MiMo-Code-inspired)
 *
 *  MiMo-Code freezes a sub-agent's system prompt + tools into a `ForkContext` so the forked
 *  agent's request shares an identical prefix with the parent → the LLM provider's prompt
 *  cache (Anthropic cache_creation/cache_read, OpenAI cached_tokens) hits instead of
 *  re-billing the (large, stable) system+tool prefix every turn.
 *
 *  `buildForkContext` snapshots the system prompt + a canonical, sorted tool descriptor
 *  list and computes a stable fingerprint. `prefixCacheAligned` tells the caller whether a
 *  child request (its system prompt + tools) would align with a parent's frozen prefix.
 *
 *  Pure + dependency-free (FNV-1a hash, no node:crypto) → unit-testable.
 *--------------------------------------------------------------------------------------------*/

export interface IForkToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
}

export interface IForkContext {
	readonly systemPrompt: string;
	readonly tools: readonly IForkToolDescriptor[];
	/** Stable hash of (systemPrompt + canonical tool set). Identical prefix => identical fp. */
	readonly toolsFingerprint: string;
}

/** FNV-1a 32-bit hash — stable across runs, no crypto dependency (browser-safe). */
function fnv1a(str: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

function fingerprint(systemPrompt: string, tools: readonly IForkToolDescriptor[]): string {
	const toolSig = tools
		.map((t) => `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`)
		.join(' ');
	return fnv1a(`${systemPrompt} ${toolSig}`);
}

/**
 * Snapshot a (systemPrompt, tools) prefix into a frozen ForkContext. Tools are sorted by
 * name so the fingerprint is independent of declaration order.
 */
export function buildForkContext(systemPrompt: string, tools: readonly IForkToolDescriptor[]): IForkContext {
	const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
	return {
		systemPrompt,
		tools: sorted,
		toolsFingerprint: fingerprint(systemPrompt, sorted),
	};
}

/**
 * True when a child request's (systemPrompt, tools) would align with a parent's frozen
 * prefix → the provider's prompt cache would hit. Returns false when no parent context.
 */
export function prefixCacheAligned(
	parent: IForkContext | undefined,
	childSystem: string,
	childTools: readonly IForkToolDescriptor[],
): boolean {
	if (!parent) { return false; }
	return buildForkContext(childSystem, childTools).toolsFingerprint === parent.toolsFingerprint;
}

/**
 * Decision record for the request-construction end: given a parent ForkContext (frozen
 * prefix) and the child's (system, tools), tells whether the child's prefix aligns with
 * the parent's so the provider prompt cache would hit, plus the child's own fingerprint.
 *
 * Pure + dependency-free → unit-testable. Consumed by MessageFormatConverter to decide
 * where to inject `cache_control` breakpoints.
 */
export interface IForkPrefixCacheDecision {
	/** child prefix === parent frozen prefix → safe to break the cache at the prefix */
	readonly aligned: boolean;
	/** child's own frozen prefix (system + tools) */
	readonly childFork: IForkContext;
	/** parent fingerprint, when a parent context was supplied */
	readonly parentFingerprint?: string;
}

export function evaluateForkPrefixCache(
	parent: IForkContext | undefined,
	childSystem: string,
	childTools: readonly IForkToolDescriptor[],
): IForkPrefixCacheDecision {
	const childFork = buildForkContext(childSystem, childTools);
	return {
		aligned: prefixCacheAligned(parent, childSystem, childTools),
		childFork,
		parentFingerprint: parent?.toolsFingerprint,
	};
}
