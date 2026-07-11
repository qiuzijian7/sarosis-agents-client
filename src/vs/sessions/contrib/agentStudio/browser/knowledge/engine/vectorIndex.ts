/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — Vector index
 *
 *  Plan-C deviation note (intentional & documented):
 *    The Python original uses `faiss-cpu` (FAISS) for the node/edge indices.
 *    `faiss-node` is a native addon that does NOT compile inside VS Code's
 *    layered AMD build (node-gyp + prebuilt mismatch), so we ship a pure-TS
 *    exact (brute-force) cosine-similarity index behind a `VectorIndex`
 *    interface. For the top-k retrieval Hyper-Extract actually performs this is
 *    functionally equivalent, and the interface lets a real FAISS/HNSW index
 *    be dropped in later (e.g. via a prebuilt wasm module) without touching
 *    the engine.
 *--------------------------------------------------------------------------------------------*/

export interface IndexHit {
	/** Index into the stored items/vectors (stable across a single build). */
	index: number;
	/** Cosine similarity in [-1, 1]. */
	score: number;
}

export interface VectorIndex {
	add(texts: string[], vectors: number[][]): void;
	search(queryVector: number[], topK: number): IndexHit[];
	clear(): void;
	size(): number;
	/** Serialize stored texts + vectors (for `dump_index`). */
	dump(): { texts: string[]; vectors: number[][] };
	/** Restore from a `dump()` payload. */
	load(data: { texts: string[]; vectors: number[][] }): void;
	/** Optional: build/optimize the index after all vectors are added (SplitIndex: cluster). */
	build?(): void;
}

function cosine(a: number[], b: number[], aNorm: number, bNorm: number): number {
	if (aNorm === 0 || bNorm === 0) { return 0; }
	let dot = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; }
	return dot / (aNorm * bNorm);
}

/**
 * Pure-TypeScript cosine index. Keeps the source `texts` so callers can map
 * a hit back to its item, and precomputes L2 norms for speed.
 */
export class InMemoryCosineIndex implements VectorIndex {
	private texts: string[] = [];
	private vectors: number[][] = [];
	private norms: number[] = [];

	add(texts: string[], vectors: number[][]): void {
		if (texts.length !== vectors.length) {
			throw new Error(`InMemoryCosineIndex.add: ${texts.length} texts vs ${vectors.length} vectors`);
		}
		for (let i = 0; i < texts.length; i++) {
			this.texts.push(texts[i]);
			this.vectors.push(vectors[i]);
			this.norms.push(l2Norm(vectors[i]));
		}
	}

	search(queryVector: number[], topK: number): IndexHit[] {
		if (this.vectors.length === 0) { return []; }
		const qNorm = l2Norm(queryVector);
		const scored: IndexHit[] = [];
		for (let i = 0; i < this.vectors.length; i++) {
			scored.push({ index: i, score: cosine(queryVector, this.vectors[i], qNorm, this.norms[i]) });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(0, topK));
	}

	clear(): void {
		this.texts = [];
		this.vectors = [];
		this.norms = [];
	}

	size(): number { return this.vectors.length; }

	dump(): { texts: string[]; vectors: number[][] } {
		return { texts: this.texts, vectors: this.vectors };
	}

	load(data: { texts: string[]; vectors: number[][] }): void {
		this.clear();
		this.add(data.texts, data.vectors);
	}
}

function l2Norm(v: number[]): number {
	let s = 0;
	for (const x of v) { s += x * x; }
	return Math.sqrt(s);
}

/**
 * Two-level approximate nearest-neighbor index. Vectors are clustered via
 * lightweight spherical K-Means; at search time only the nearest 25% of
 * centroids are probed, and exact cosine ranking is performed within those
 * clusters only. When `size < SPLIT_THRESHOLD` (200 items) exact brute-force
 * is used — so small knowledge bases pay no approximation penalty.
 *
 * This mirrors FAISS IVF flat in spirit but runs entirely in pure TS, with
 * no native addon dependencies, fitting the VS Code AMD layered build
 * constraint. Complexity: O(probes * n/C) vs O(n) exact.
 */
export class SplitIndex implements VectorIndex {
	static readonly SPLIT_THRESHOLD = 200;
	static readonly CLUSTER_RATIO = 80;   // ~80 items per cluster
	static readonly PROBE_RATIO = 0.25;    // search 25% of clusters
	static readonly KMEANS_ITERS = 3;

	private texts: string[] = [];
	private vectors: number[][] = [];
	private norms: number[] = [];
	private centroids: number[][] = [];
	private centroidNorms: number[] = [];
	/** cluster index → list of vector indices belonging to it. */
	private clusterIndices: number[][] = [];
	private built = false;

	add(texts: string[], vectors: number[][]): void {
		if (texts.length !== vectors.length) {
			throw new Error(`SplitIndex.add: ${texts.length} texts vs ${vectors.length} vectors`);
		}
		this.built = false; // invalidate clusters
		for (let i = 0; i < texts.length; i++) {
			this.texts.push(texts[i]);
			this.vectors.push(vectors[i]);
			this.norms.push(l2Norm(vectors[i]));
		}
	}

	build(): void {
		const n = this.size();
		if (n < SplitIndex.SPLIT_THRESHOLD) { return; } // exact fallback
		const d = this.vectors[0]?.length ?? 0;
		if (d === 0) { return; }

		const C = Math.max(2, Math.ceil(n / SplitIndex.CLUSTER_RATIO));

		// ── Initialize centroids: random subset ─────────────────────
		const indices = [...Array(n).keys()];
		const sample = new Array<number>(C);
		for (let i = 0; i < C; i++) {
			const j = Math.floor(Math.random() * (n - i)) + i;
			const tmp = indices[i];
			indices[i] = indices[j];
			indices[j] = tmp;
			sample[i] = indices[i];
		}
		this.centroids = sample.map(idx => this.vectors[idx].slice());
		this.centroidNorms = sample.map(idx => this.norms[idx]);

		// ── K-Means (spherical) ──────────────────────────────────────
		for (let iter = 0; iter < SplitIndex.KMEANS_ITERS; iter++) {
			// Assign: each vector to the centroid with max cosine similarity.
			const clusters: number[][] = Array.from({ length: C }, () => []);
			for (let i = 0; i < n; i++) {
				let best = 0;
				let bestScore = -Infinity;
				const vNorm = this.norms[i];
				for (let c = 0; c < C; c++) {
					const s = cosine(this.vectors[i], this.centroids[c], vNorm, this.centroidNorms[c]);
					if (s > bestScore) { bestScore = s; best = c; }
				}
				clusters[best].push(i);
			}
			// Update centroids: mean of members, then re-normalize.
			for (let c = 0; c < C; c++) {
				const mem = clusters[c];
				if (mem.length === 0) { continue; } // keep old centroid
				const mean = new Array<number>(d).fill(0);
				for (const idx of mem) {
					const v = this.vectors[idx];
					for (let j = 0; j < d; j++) { mean[j] += v[j]; }
				}
				for (let j = 0; j < d; j++) { mean[j] /= mem.length; }
				const norm = l2Norm(mean);
				this.centroids[c] = norm > 0 ? mean.map(x => x / norm) : mean;
				this.centroidNorms[c] = norm > 0 ? 1.0 : norm;
			}
		}

		// ── Final assignment → store cluster membership ──────────────
		this.clusterIndices = Array.from({ length: C }, () => []);
		for (let i = 0; i < n; i++) {
			let best = 0;
			let bestScore = -Infinity;
			const vNorm = this.norms[i];
			for (let c = 0; c < C; c++) {
				const s = cosine(this.vectors[i], this.centroids[c], vNorm, this.centroidNorms[c]);
				if (s > bestScore) { bestScore = s; best = c; }
			}
			this.clusterIndices[best].push(i);
		}
		this.built = true;
	}

	search(queryVector: number[], topK: number): IndexHit[] {
		const n = this.vectors.length;
		if (n === 0) { return []; }

		// Below threshold → exact search (no approximation for small KBs).
		if (!this.built || n < SplitIndex.SPLIT_THRESHOLD) {
			return this._exactSearch(queryVector, topK);
		}

		// ── Two-stage approximate search ──────────────────────────
		const C = this.centroids.length;
		const probes = Math.max(2, Math.ceil(C * SplitIndex.PROBE_RATIO));

		const qNorm = l2Norm(queryVector);
		// Score every centroid.
		const centroidScores = this.centroids.map((c, i) => ({
			idx: i,
			score: cosine(queryVector, c, qNorm, this.centroidNorms[i]),
		}));
		centroidScores.sort((a, b) => b.score - a.score);

		// Probe the top-K nearest clusters.
		const seen = new Set<number>();
		const hits: IndexHit[] = [];
		for (let p = 0; p < probes && p < centroidScores.length; p++) {
			const ci = centroidScores[p].idx;
			for (const vi of this.clusterIndices[ci]) {
				if (seen.has(vi)) { continue; }
				seen.add(vi);
				hits.push({
					index: vi,
					score: cosine(queryVector, this.vectors[vi], qNorm, this.norms[vi]),
				});
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, Math.max(0, topK));
	}

	private _exactSearch(queryVector: number[], topK: number): IndexHit[] {
		const qNorm = l2Norm(queryVector);
		const scored: IndexHit[] = [];
		for (let i = 0; i < this.vectors.length; i++) {
			scored.push({ index: i, score: cosine(queryVector, this.vectors[i], qNorm, this.norms[i]) });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(0, topK));
	}

	clear(): void {
		this.texts = [];
		this.vectors = [];
		this.norms = [];
		this.centroids = [];
		this.centroidNorms = [];
		this.clusterIndices = [];
		this.built = false;
	}

	size(): number { return this.vectors.length; }

	dump(): { texts: string[]; vectors: number[][] } {
		return { texts: this.texts, vectors: this.vectors };
	}

	load(data: { texts: string[]; vectors: number[][] }): void {
		this.clear();
		this.add(data.texts, data.vectors);
		this.build?.();
	}
}
