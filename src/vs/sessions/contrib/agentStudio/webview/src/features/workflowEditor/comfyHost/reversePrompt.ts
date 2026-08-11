/*---------------------------------------------------------------------------------------------
 *  Reverse Prompt — build a provider text LLM request to describe an image (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.4 反推提示词.
 *  Aligned with TapCanvas reversePrompt.
 *
 *  buildReversePromptRequest(imageRef, provider) returns the request shape used
 *  by the existing imagegen RPC, or the prompt text for a pure text LLM call.
 *  Pure + DOM-free; the provider argument is the ProviderInfo from useProviderStore.
 *--------------------------------------------------------------------------------------------*/

export interface ReversePromptProviderLike {
	id: string;
	authStatus: string;
	models?: Array<{ id: string; supportsTextChat?: boolean; supportsImageGen?: boolean }>;
}

export interface ReversePromptRequest {
	providerId: string;
	modelId: string;
	/** The image ref to describe (fed as the image input). */
	imageRef: string;
	/** The instruction given to the model. */
	prompt: string;
	/** True when the provider is authenticated and ready. */
	ready: boolean;
}

export const REVERSE_PROMPT_INSTRUCTION =
	'Describe this image in rich detail for image-generation purposes: ' +
	'subject, style, lighting, composition, colors, mood, and any text visible. ' +
	'Return a single detailed English prompt.';

/**
 * Build a reverse-prompt request for a provider.
 * Falls back to the first authenticated model when the given model is missing.
 */
export function buildReversePromptRequest(
	imageRef: string,
	provider: ReversePromptProviderLike,
	modelId?: string,
): ReversePromptRequest {
	const models = provider.models ?? [];
	const pick = modelId ? models.find(m => m.id === modelId) : undefined;
	const fallback = models.find(m => m.supportsTextChat || m.supportsImageGen) ?? models[0];
	const chosen = pick ?? fallback;
	const ready = provider.authStatus === 'authenticated' && !!chosen;

	return {
		providerId: provider.id,
		modelId: chosen?.id ?? '',
		imageRef,
		prompt: REVERSE_PROMPT_INSTRUCTION,
		ready,
	};
}

/**
 * Build a reverse-prompt request from a provider list (first ready provider).
 * Returns null when no provider is authenticated.
 */
export function buildReversePromptFromProviders(
	imageRef: string,
	providers: ReversePromptProviderLike[],
): ReversePromptRequest | null {
	const ready = providers.filter(p => p.authStatus === 'authenticated');
	if (ready.length === 0) { return null; }
	for (const p of ready) {
		const r = buildReversePromptRequest(imageRef, p);
		if (r.ready) { return r; }
	}
	// All authenticated providers lack a usable model → still return the first.
	return buildReversePromptRequest(imageRef, ready[0]);
}
