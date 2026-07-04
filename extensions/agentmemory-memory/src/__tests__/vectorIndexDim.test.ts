/*---------------------------------------------------------------------------------------------
 *  VectorIndex 维度验证测试 — v2 序列化格式、维度不匹配拒绝加载
 *--------------------------------------------------------------------------------------------*/
import { VectorIndex, embedSync } from '../vectorIndex.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

export function runVectorDimensionTests(): void {
describe('VectorIndex dimension tracking', () => {
	it('dimension starts at 0', () => {
		const idx = new VectorIndex();
		assertEqual(idx.dimension, 0, 'initial dimension is 0');
	});

	it('dimension set on first add', () => {
		const idx = new VectorIndex();
		const vec = embedSync('test')!;
		idx.add('d1', vec);
		assertEqual(idx.dimension, 384, 'dimension = 384 after first add');
	});

	it('clear resets dimension', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		assertEqual(idx.dimension, 384, 'dimension set');
		idx.clear();
		assertEqual(idx.dimension, 0, 'dimension reset after clear');
	});

	it('importVectors sets dimension', () => {
		const idx = new VectorIndex();
		const data = [
			{ id: 'v1', vector: Array.from(embedSync('test')!) },
		];
		const imported = idx.importVectors(data);
		assertEqual(imported, 1, 'imported 1');
		assertEqual(idx.dimension, 384, 'dimension set from import');
	});
});

describe('VectorIndex serialize (v2 format)', () => {
	it('serialize includes v: 2 and dimensions', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		idx.add('d2', embedSync('world')!);
		const json = idx.serialize();
		const parsed = JSON.parse(json);
		assertEqual(parsed.v, 2, 'version 2');
		assertEqual(parsed.dimensions, 384, 'dimensions field');
		assertEqual(parsed.size, 2, 'size 2');
		assert(Array.isArray(parsed.vectors), 'vectors array');
		assert(typeof parsed.savedAt === 'number', 'has savedAt');
	});

	it('serialize/deserialize roundtrip', () => {
		const idx1 = new VectorIndex();
		idx1.add('d1', embedSync('machine learning')!);
		idx1.add('d2', embedSync('neural network')!);
		const json = idx1.serialize();

		const idx2 = new VectorIndex();
		const imported = idx2.deserialize(json);
		assertEqual(imported, 2, 'imported 2 vectors');
		assertEqual(idx2.size, 2, 'size 2 after deserialize');
		assertEqual(idx2.dimension, 384, 'dimension restored');
	});

	it('deserialize handles empty JSON', () => {
		const idx = new VectorIndex();
		const result = idx.deserialize('{}');
		assertEqual(result, 0, '0 imported from empty');
	});

	it('deserialize handles invalid JSON', () => {
		const idx = new VectorIndex();
		const result = idx.deserialize('not valid json');
		assertEqual(result, 0, '0 imported from invalid');
	});
});

describe('VectorIndex dimension mismatch', () => {
	it('refuses to load when dimension mismatches', () => {
		// Create index with 384-dim vectors
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		assertEqual(idx.dimension, 384, 'index has 384-dim');

		// Serialize with wrong dimension metadata
		const fakeJson = JSON.stringify({
			v: 2,
			dimensions: 768,  // Mismatch!
			vectors: [{ id: 'wrong', vector: new Array(768).fill(0.1) }],
		});

		const result = idx.deserialize(fakeJson);
		assertEqual(result, 0, 'refused to load mismatched dimension');
	});

	it('loads when dimension matches', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		assertEqual(idx.dimension, 384, 'index has 384-dim');

		const json = JSON.stringify({
			v: 2,
			dimensions: 384,  // Match!
			vectors: [{ id: 'd2', vector: Array.from(embedSync('world')!) }],
		});

		const result = idx.deserialize(json);
		assertEqual(result, 1, 'loaded 1 vector');
	});

	it('loads v1 format (no dimension check) when index is empty', () => {
		const idx = new VectorIndex();
		assertEqual(idx.dimension, 0, 'empty index has dim 0');

		// v1 format (no version, no dimensions)
		const v1Json = JSON.stringify({
			vectors: [{ id: 'd1', vector: Array.from(embedSync('test')!) }],
		});

		const result = idx.deserialize(v1Json);
		assertEqual(result, 1, 'loaded v1 format');
	});

	it('dimension mismatch only triggers when index already has vectors', () => {
		const idx = new VectorIndex();
		assertEqual(idx.dimension, 0, 'empty');

		// Even with v2 and wrong dimensions, empty index loads
		const json = JSON.stringify({
			v: 2,
			dimensions: 768,
			vectors: [{ id: 'd1', vector: new Array(768).fill(0.1) }],
		});

		const result = idx.deserialize(json);
		// Empty index (dim=0) should accept since no mismatch check when dim=0
		assertEqual(result, 1, 'loaded into empty index');
	});
});

describe('VectorIndex exportVectors', () => {
	it('exports all vectors with id and vector array', () => {
		const idx = new VectorIndex();
		idx.add('d1', embedSync('hello')!);
		idx.add('d2', embedSync('world')!);
		const exported = idx.exportVectors();
		assertEqual(exported.length, 2, 'exported 2');
		assert(typeof exported[0].id === 'string', 'has id');
		assert(Array.isArray(exported[0].vector), 'vector is array');
	});

	it('empty index exports empty array', () => {
		const idx = new VectorIndex();
		const exported = idx.exportVectors();
		assertEqual(exported.length, 0, 'empty export');
	});
});
}
