/*---------------------------------------------------------------------------------------------
 *  G2/G8/G10: chunking + multiSearch + answerGen 测试
 *--------------------------------------------------------------------------------------------*/
import { chunkText, ChunkStrategy } from '../chunking.js';
import { rerankResults, executeSearch, SearchStrategy, type SearchResult } from '../multiSearch.js';
import { generateAnswerPrompt } from '../answerGen.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

export function runCogneeAlignmentTests(): void {
	describe('Chunking Engine (G2)', () => {
		it('fixed strategy splits by character count', () => {
			const text = 'a'.repeat(5000);
			const chunks = chunkText(text, ChunkStrategy.Fixed, 1000);
			assert(chunks.length >= 5, `expected >= 5 chunks, got ${chunks.length}`);
			assert(chunks[0].text.length <= 1000, 'first chunk within size');
		});

		it('semantic strategy splits by paragraphs', () => {
			const text = 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.';
			const chunks = chunkText(text, ChunkStrategy.Semantic, 30);
			assert(chunks.length >= 2, 'splits into multiple chunks');
			assert(chunks[0].text.includes('Para one'), 'first chunk has para one');
		});

		it('markdown strategy splits by headings', () => {
			const text = '# Title\n\nIntro text.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.';
			const chunks = chunkText(text, ChunkStrategy.Markdown, 100);
			assert(chunks.length >= 1, 'has chunks');
			const hasHeading = chunks.some(c => c.metadata?.heading);
			assert(hasHeading, 'at least one chunk has heading metadata');
		});

		it('code strategy detects language', () => {
			const code = 'function hello() {\n  return "world";\n}\n\nfunction bye() {\n  return "bye";\n}';
			const chunks = chunkText(code, ChunkStrategy.Code, 50);
			assert(chunks.length >= 1, 'has chunks');
			assert(chunks[0].metadata?.language !== undefined, 'language detected');
		});

		it('empty text returns single empty chunk', () => {
			const chunks = chunkText('', ChunkStrategy.Fixed, 1000);
			assertEqual(chunks.length, 1, 'single chunk for empty');
		});
	});

	describe('Multi-Search + Re-ranker (G8/G9)', () => {
		it('rerank boosts results with query terms at start', () => {
			const results: SearchResult[] = [
				{ id: '1', content: 'TypeScript is great for web development', score: 0.5, source: 'bm25' },
				{ id: '2', content: 'The weather is nice today, unrelated content here', score: 0.9, source: 'vector' },
			];
			const reranked = rerankResults('TypeScript web', results, 2);
			assert(reranked[0].id === '1', 'relevant result ranked first after rerank');
		});

		it('rerank handles empty results', () => {
			const reranked = rerankResults('test', [], 10);
			assertEqual(reranked.length, 0, 'empty input → empty output');
		});

		it('executeSearch hybrid strategy fuses BM25 + Vector', async () => {
			const results = await executeSearch('test', { strategy: SearchStrategy.Hybrid, limit: 5, rerank: false }, {
				bm25Search: (q, l) => [{ id: 'b1', content: 'bm25 result', score: 0.8, source: 'bm25' }],
				vectorSearch: async (q, l) => [{ id: 'v1', content: 'vector result', score: 0.7, source: 'vector' }],
			});
			assert(results.length >= 2, 'hybrid returns both sources');
		});

		it('executeSearch graph_only uses only graph search', async () => {
			const results = await executeSearch('test', { strategy: SearchStrategy.GraphOnly, limit: 5 }, {
				graphSearch: (q, l) => [{ id: 'g1', content: 'graph result', score: 0.9, source: 'graph' }],
				bm25Search: () => { throw new Error('should not be called'); },
			});
			assertEqual(results.length, 1, 'only graph results');
			assertEqual(results[0].source, 'graph', 'source is graph');
		});
	});

	describe('GraphRAG AnswerGen (G10)', () => {
		it('generates prompt with memory + graph + search results', () => {
			const result = generateAnswerPrompt({
				query: 'How to configure TypeScript?',
				searchResults: [
					{ content: 'Use tsconfig.json', score: 0.9, source: 'bm25' },
					{ content: 'Set strict mode', score: 0.8, source: 'vector' },
				],
				graphContext: 'TypeScript → config → tsconfig.json',
				agentMemory: 'User prefers strict TypeScript',
			});
			assert(result.prompt.includes('TypeScript'), 'prompt contains query');
			assert(result.prompt.includes('<memory>'), 'prompt has memory block');
			assert(result.prompt.includes('<graph_context>'), 'prompt has graph block');
			assert(result.prompt.includes('<search_results>'), 'prompt has search results');
			assertEqual(result.sourceCount, 2, 'source count correct');
		});

		it('handles empty search results', () => {
			const result = generateAnswerPrompt({
				query: 'test',
				searchResults: [],
			});
			assert(result.prompt.includes('test'), 'prompt contains query');
			assertEqual(result.sourceCount, 0, 'no sources');
		});
	});
}
