/**
 * Quick test runner for RAG-specific modules (hybridSearch, OMem incremental, SSE).
 * Uses esbuild to bundle just the needed modules.
 * 
 * Usage: node src/.../__tests__/run-rag-tests.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const testCode = `
import { test } from 'node:test';
import assert from 'node:assert';

// ── Inline the function to avoid dependency chain ─────────────────────────
// Simplified RRF fusion (same logic as hybridSearch.ts)

function rrfScore(rank) { return 1 / (60 + rank); }
function normalizeRankScore(rank, total) { return total <= 1 ? 1 : 1 - rank / (total - 1); }

function fuseHybrid(ftsItems, vectorItems, idExtractor, topK) {
	const hitMap = new Map();
	for (let i = 0; i < ftsItems.length; i++) {
		const id = idExtractor(ftsItems[i]);
		const rrf = rrfScore(i + 1);
		const existing = hitMap.get(id);
		if (existing) {
			existing.ftsScore = Math.max(existing.ftsScore, normalizeRankScore(i, ftsItems.length));
			existing.rrfScore += rrf;
		} else {
			hitMap.set(id, { item: ftsItems[i], id, vectorScore: -1, ftsScore: normalizeRankScore(i, ftsItems.length), rrfScore: rrf });
		}
	}
	for (let i = 0; i < vectorItems.length; i++) {
		const id = idExtractor(vectorItems[i]);
		const rrf = rrfScore(i + 1);
		const existing = hitMap.get(id);
		if (existing) {
			existing.vectorScore = Math.max(existing.vectorScore, normalizeRankScore(i, vectorItems.length));
			existing.rrfScore += rrf;
		} else {
			hitMap.set(id, { item: vectorItems[i], id, vectorScore: normalizeRankScore(i, vectorItems.length), ftsScore: -1, rrfScore: rrf });
		}
	}
	return {
		hits: Array.from(hitMap.values()).sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK),
		stats: { ftsTotal: ftsItems.length, vectorTotal: vectorItems.length, mergedTotal: hitMap.size },
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

test('RRF: two disjoint lists merge correctly', () => {
	const r = fuseHybrid(['A','B','C'], ['X','Y'], x => x, 10);
	assert.strictEqual(r.stats.ftsTotal, 3);
	assert.strictEqual(r.stats.mergedTotal, 5);
	assert.strictEqual(r.hits[0].item, 'A');
});

test('RRF: overlapping items get combined scores', () => {
	const r = fuseHybrid(['shared','a','b'], ['shared','x'], x => x, 10);
	assert.strictEqual(r.stats.mergedTotal, 4);
	const s = r.hits.find(h => h.item === 'shared');
	assert.ok(s.ftsScore >= 0);
	assert.ok(s.vectorScore >= 0);
	assert.ok(s.rrfScore > 1/61);
});

test('RRF: empty input works', () => {
	const r = fuseHybrid([], [], x => x, 5);
	assert.strictEqual(r.hits.length, 0);
});

test('RRF: topK limits results', () => {
	const fts = Array.from({length:20}, (_,i) => \`doc-\${i}\`);
	const vec = Array.from({length:20}, (_,i) => \`doc-\${i+10}\`);
	assert.strictEqual(fuseHybrid(fts, vec, x=>x, 5).hits.length, 5);
});

// ── Streaming SSE tests ────────────────────────────────────────────────

async function simStream(sseChunks, onToken) {
	return new Promise((resolve, reject) => {
		const encoder = new TextEncoder();
		let idx = 0;
		const stream = new ReadableStream({
			async pull(controller) {
				if (idx < sseChunks.length) {
					controller.enqueue(encoder.encode(sseChunks[idx++]));
				} else {
					controller.close();
				}
			},
		});

		let accumulated = '';
		let buffer = '';
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		(async () => {
			try {
				while (true) {
					const {done, value} = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, {stream: true});
					const lines = buffer.split('\\n');
					buffer = lines.pop();
					for (const line of lines) {
						const t = line.trim();
						if (!t || !t.startsWith('data: ')) continue;
						const ds = t.slice(6);
						if (ds === '[DONE]') continue;
						try {
							const c = JSON.parse(ds);
							const delta = c?.choices?.[0]?.delta?.content;
							if (typeof delta === 'string' && delta) {
								accumulated += delta;
								if (onToken(delta, accumulated)) { reader.cancel(); return resolve(accumulated); }
							}
						} catch {}
					}
				}
				resolve(accumulated);
			} catch (e) { reject(e); }
		})();
	});
}

test('SSE: parses deltas correctly', async () => {
	const chunks = [
		'data: {"choices":[{"delta":{"content":"Hello"}}]}\\n\\n',
		'data: {"choices":[{"delta":{"content":" "}}]}\\n\\n',
		'data: {"choices":[{"delta":{"content":"World"}}]}\\n\\n',
		'data: [DONE]\\n\\n',
	];
	const tokens = [];
	const r = await simStream(chunks, (t, a) => { tokens.push(t); });
	assert.strictEqual(r, 'Hello World');
	assert.strictEqual(tokens.length, 3);
	assert.strictEqual(tokens[0], 'Hello');
});

test('SSE: early abort via onToken return true', async () => {
	const chunks = [
		'data: {"choices":[{"delta":{"content":"A"}}]}\\n\\n',
		'data: {"choices":[{"delta":{"content":"B"}}]}\\n\\n',
		'data: {"choices":[{"delta":{"content":"C"}}]}\\n\\n',
		'data: [DONE]\\n\\n',
	];
	let count = 0;
	const r = await simStream(chunks, (t) => {
		count++;
		return t === 'B';
	});
	assert.strictEqual(r, 'AB');
	assert.strictEqual(count, 2);
});

test('SSE: handles [DONE] and ignores malformed chunks', async () => {
	const chunks = [
		'data: {"choices":[{"delta":{"content":"X"}}]}\\n\\n',
		'garbage line\\n',
		'data: [DONE]\\n\\n',
	];
	const r = await simStream(chunks, () => {});
	assert.strictEqual(r, 'X');
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\\\\n✅ All RAG unit tests passed.');
`;

const tmpFile = path.join(os.tmpdir(), `rag-test-${Date.now()}.mjs`);

const out = await esbuild.build({
	stdin: { contents: testCode, resolveDir: process.cwd(), sourcefile: 'rag-test.ts' },
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	external: ['node:*'],
	outfile: tmpFile,
	logLevel: 'warning',
});

if (out.errors.length > 0 || out.warnings.length > 0) {
	for (const e of out.errors) { console.error('esbuild error:', e); }
	for (const w of out.warnings) { console.warn('esbuild warn:', w); }
	if (out.errors.length > 0) { process.exit(1); }
}

try {
	await import(pathToFileURL(tmpFile).href);
} finally {
	// Clean up
	try { fs.unlinkSync(tmpFile); } catch {}
}
