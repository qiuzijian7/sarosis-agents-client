/*---------------------------------------------------------------------------------------------
 *  VectorIndex 单元测试 — 使用 embedSync (trigram) 避免依赖 @xenova/transformers
 *--------------------------------------------------------------------------------------------*/
import { VectorIndex, embedSync, cosineSimilarity } from '../vectorIndex.js';
import { describe, it, assert, assertEqual, assertApprox } from './testRunner.js';

export function runVectorTests(): void {
describe('embedSync (trigram fallback)', () => {
	it('returns Float32Array of 384 dimensions', () => {
		const vec = embedSync('hello world');
		assert(vec !== null, 'not null');
		assertEqual(vec!.length, 384, '384 dimensions');
	});

	it('similar text produces similar vectors', () => {
		const v1 = embedSync('hello world test');
		const v2 = embedSync('hello world test');
		const sim = cosineSimilarity(v1!, v2!);
		assertApprox(sim, 1.0, 0.001, 'identical text → cosine ~1.0');
	});

	it('different text produces different vectors', () => {
		const v1 = embedSync('hello world');
		const v2 = embedSync('completely different text about quantum physics');
		const sim = cosineSimilarity(v1!, v2!);
		assert(sim < 1.0, 'different text → cosine < 1.0');
	});

	it('empty string still returns a vector', () => {
		const vec = embedSync('');
		assert(vec !== null, 'not null for empty');
		assertEqual(vec!.length, 384, 'still 384 dims');
	});

	it('normalized (unit length)', () => {
		const vec = embedSync('some text for testing normalization');
		let norm = 0;
		for (let i = 0; i < vec!.length; i++) norm += vec![i] * vec![i];
		norm = Math.sqrt(norm);
		assertApprox(norm, 1.0, 0.01, 'vector is unit length');
	});
});

describe('VectorIndex', () => {
	it('add and size', () => {
		const idx = new VectorIndex();
		assertEqual(idx.size, 0, 'empty');
		const vec = embedSync('test')!;
		idx.add('d1', vec);
		assertEqual(idx.size, 1, 'after add');
	});

	it('remove', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		idx.add('d2', embedSync('world')!);
		idx.remove('d1');
		assertEqual(idx.size, 1, 'after remove');
	});

	it('clear', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		idx.add('d2', embedSync('world')!);
		idx.clear();
		assertEqual(idx.size, 0, 'cleared');
	});

	it('search returns results sorted by similarity', async () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('machine learning model')!);
		idx.add('d2', embedSync('cooking recipe pasta')!);
		idx.add('d3', embedSync('deep learning neural network')!);
		const results = await idx.search('learning neural', 3);
		assert(results.length > 0, 'has results');
		// d3 (deep learning neural network) should be more similar than d2 (cooking)
		const d3Rank = results.findIndex(r => r.id === 'd3');
		const d2Rank = results.findIndex(r => r.id === 'd2');
		assert(d3Rank >= 0 && d2Rank >= 0, 'both found');
		assert(d3Rank < d2Rank, 'd3 ranks higher than d2');
	});

	it('search empty index returns empty', async () => {
		const idx = new VectorIndex();
		const results = await idx.search('test', 10);
		assertEqual(results.length, 0, 'empty index');
	});

	it('search respects limit', async () => {
		const idx = new VectorIndex();
		for (let i = 0; i < 20; i++) {
			idx.add(`d${i}`, embedSync(`document number ${i} about topic`)!);
		}
		const results = await idx.search('topic', 5);
		assert(results.length <= 5, 'respects limit');
	});

	it('available property', () => {
		const idx = new VectorIndex();
		assert(idx.available === true, 'available is true by default');
	});
});
}
