/*---------------------------------------------------------------------------------------------
 *  BM25 Index 单元测试
 *--------------------------------------------------------------------------------------------*/
import { BM25Index } from '../bm25Index.js';
import { describe, it, assert, assertEqual, assertApprox } from './testRunner.js';

export function runBM25Tests(): void {
describe('BM25Index', () => {
	it('add and size', () => {
		const idx = new BM25Index();
		assertEqual(idx.size, 0, 'empty index size');
		idx.add('doc1', 'hello world test');
		assertEqual(idx.size, 1, 'after add size');
		idx.add('doc2', 'another document');
		assertEqual(idx.size, 2, 'after second add');
	});

	it('remove', () => {
		const idx = new BM25Index();
		idx.add('doc1', 'hello world');
		idx.add('doc2', 'another doc');
		idx.remove('doc1');
		assertEqual(idx.size, 1, 'after remove');
		assert(idx.search('hello').length === 0, 'removed doc not in search');
	});

	it('search returns ranked results', () => {
		const idx = new BM25Index();
		idx.add('d1', 'the quick brown fox jumps over the lazy dog');
		idx.add('d2', 'the lazy dog sleeps all day');
		idx.add('d3', 'quick fox is quick');
		const results = idx.search('quick fox');
		assert(results.length > 0, 'has results');
		// d3 has "quick" twice + "fox" once — should rank high
		assert(results[0].id === 'd3' || results[0].id === 'd1', 'top result is relevant');
	});

	it('search empty query returns empty', () => {
		const idx = new BM25Index();
		idx.add('d1', 'hello world');
		assertEqual(idx.search('').length, 0, 'empty query');
	});

	it('search no match returns empty', () => {
		const idx = new BM25Index();
		idx.add('d1', 'hello world');
		assertEqual(idx.search('xyz123').length, 0, 'no match');
	});

	it('add same id replaces old content', () => {
		const idx = new BM25Index();
		idx.add('d1', 'old content here');
		idx.add('d1', 'new content there');
		assertEqual(idx.size, 1, 'size still 1');
		assert(idx.search('old').length === 0, 'old content gone');
		assert(idx.search('new').length > 0, 'new content found');
	});

	it('clear resets everything', () => {
		const idx = new BM25Index();
		idx.add('d1', 'hello');
		idx.add('d2', 'world');
		idx.clear();
		assertEqual(idx.size, 0, 'cleared');
		assertEqual(idx.search('hello').length, 0, 'no results after clear');
	});

	it('CJK tokenization', () => {
		const idx = new BM25Index();
		idx.add('d1', '使用 TypeScript 开发记忆系统');
		idx.add('d2', 'Python 数据分析');
		const results = idx.search('记忆系统');
		assert(results.length > 0, 'CJK search has results');
		assertEqual(results[0].id, 'd1', 'correct CJK doc');
	});

	it('score is positive for matching docs', () => {
		const idx = new BM25Index();
		idx.add('d1', 'machine learning models');
		const results = idx.search('machine learning');
		assert(results.length > 0, 'has results');
		assert(results[0].score > 0, 'score is positive');
	});
});
}
