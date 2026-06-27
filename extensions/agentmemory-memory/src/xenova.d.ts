/**
 * Type declarations for @xenova/transformers (optional dependency).
 * The actual package is dynamically imported at runtime — if not installed,
 * vector search gracefully degrades to trigram-based pseudo-embeddings.
 */
declare module '@xenova/transformers' {
	export interface PipelineOutput {
		data: Float32Array | number[] | Record<string, unknown>;
		[key: string]: unknown;
	}

	export interface Pipeline {
		(text: string, options?: { pooling?: string; normalize?: boolean }): Promise<PipelineOutput>;
	}

	export function pipeline(task: string, model: string): Promise<Pipeline>;

	export const env: {
		allowRemoteModels: boolean;
		allowLocalModels: boolean;
		cacheDir?: string;
		[key: string]: unknown;
	};
}
