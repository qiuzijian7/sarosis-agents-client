/*---------------------------------------------------------------------------------------------
 *  RRF (Reciprocal Rank Fusion) 单元测试
 *--------------------------------------------------------------------------------------------*/
import { rrfFuse, rrfFuseWithDiversify, type RRFStream } from '../rrf.js';
import { describe, it, assert, assertEqual, assertApprox } from './testRunner.js';

export function runRRFTests(): void {
describe('RRF Fusion', () => {
	it('empty streams returns empty', () => {
		const result = rrfFuse([]);
		assertEqual(result.length, 0, 'empty input');
	});

	it('single stream preserves order', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], weight: 1.0 },
		];
		const result = rrfFuse(streams);
		assertEqual(result.length, 3, '3 results');
		assertEqual(result[0].id, 'a', 'first is a');
		assertEqual(result[1].id, 'b', 'second is b');
		assertEqual(result[2].id, 'c', 'third is c');
	});

	it('higher weight ranks higher', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }, { id: 'b' }], weight: 0.9 },
			{ results: [{ id: 'b' }, { id: 'a' }], weight: 0.1 },
		];
		const result = rrfFuse(streams);
		// 'a' is rank 0 in high-weight stream, 'b' is rank 0 in low-weight stream
		// a should win because 0.9 * 1/61 > 0.1 * 1/61 + 0.9 * 1/62
		assertEqual(result[0].id, 'a', 'high-weight rank 0 wins');
	});

	it('doc in multiple streams gets combined score', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'shared' }, { id: 'only_a' }], weight: 0.5 },
			{ results: [{ id: 'shared' }, { id: 'only_b' }], weight: 0.5 },
		];
		const result = rrfFuse(streams);
		assertEqual(result[0].id, 'shared', 'shared doc ranks first');
		assert(result[0].score > result[1].score, 'shared score is higher');
	});

	it('zero weight stream is ignored', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }], weight: 1.0 },
			{ results: [{ id: 'b' }], weight: 0 },
		];
		const result = rrfFuse(streams);
		assertEqual(result.length, 1, 'only 1 result');
		assertEqual(result[0].id, 'a', 'only weighted stream counted');
	});

	it('k parameter affects score smoothing', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }, { id: 'b' }], weight: 1.0 },
		];
		const resultK60 = rrfFuse(streams, 60);
		const resultK1 = rrfFuse(streams, 1);
		// With k=1, the rank difference is more pronounced
		const diff60 = resultK60[0].score - resultK60[1].score;
		const diff1 = resultK1[0].score - resultK1[1].score;
		assert(diff1 > diff60, 'smaller k → larger score gap');
	});

	it('score is positive', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }, { id: 'b' }], weight: 0.5 },
		];
		const result = rrfFuse(streams);
		for (const r of result) {
			assert(r.score > 0, `score for ${r.id} is positive`);
		}
	});

	it('results sorted by score descending', () => {
		const streams: RRFStream[] = [
			{ results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], weight: 0.5 },
			{ results: [{ id: 'c' }, { id: 'b' }, { id: 'a' }], weight: 0.5 },
		];
		const result = rrfFuse(streams);
		for (let i = 1; i < result.length; i++) {
			assert(result[i - 1].score >= result[i].score, `result ${i-1} >= result ${i}`);
		}
	});
});

describe('RRF with Diversification', () => {
	it('limits results per session', () => {
		const streams: RRFStream[] = [
			{ results: [
				{ id: 's1_a' }, { id: 's1_b' }, { id: 's1_c' }, { id: 's1_d' },
				{ id: 's2_a' }, { id: 's2_b' },
			], weight: 1.0 },
		];
		const result = rrfFuseWithDiversify(streams, 60, 2, (id) => id.split('_')[0]);
		// s1 has 4 results, but maxPerSession=2 → first 2 in sorted, rest in overflow
		const s1Count = result.filter(r => r.id.startsWith('s1')).indexOf(result.find(r => r.id.startsWith('s2'))!) ;
		// First 2 should be s1, then s2, then overflow s1
		assertEqual(result[0].id, 's1_a', 'first is s1_a');
		assertEqual(result[1].id, 's1_b', 'second is s1_b');
		assertEqual(result[2].id, 's2_a', 'third is s2_a (diversified)');
	});

	it('overflow appended at end', () => {
		const streams: RRFStream[] = [
			{ results: [
				{ id: 'a1' }, { id: 'a2' }, { id: 'a3' },
				{ id: 'b1' },
			], weight: 1.0 },
		];
		const result = rrfFuseWithDiversify(streams, 60, 1, (id) => id[0]);
		// a1, b1, then a2, a3 in overflow
		assertEqual(result[0].id, 'a1', 'a1 first');
		assertEqual(result[1].id, 'b1', 'b1 second (diversified)');
		// a2 and a3 should be after b1
		const a2Index = result.findIndex(r => r.id === 'a2');
		assert(a2Index > 1, 'a2 in overflow (after position 1)');
	});
});
}
