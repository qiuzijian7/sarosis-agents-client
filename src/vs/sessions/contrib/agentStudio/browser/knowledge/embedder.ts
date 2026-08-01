/*---------------------------------------------------------------------------------------------
 *  Embedder abstraction (shared by the llm-wiki knowledge pipeline)
 *
 *  The knowledge pipeline only needs a way to turn strings into vectors; the
 *  VS Code glue supplies an implementation that delegates to
 *  `IAiEmbeddingVectorService`.
 *--------------------------------------------------------------------------------------------*/

export interface IEmbedder {
	/** Embed a batch of texts → one vector per text. */
	embed(texts: string[]): Promise<number[][]>;
	/** Embed a single text. */
	embedOne(text: string): Promise<number[]>;
	/** Vector dimensionality, or undefined if not yet known. */
	readonly dimensions?: number;
}
