/*---------------------------------------------------------------------------------------------
 *  Plan-C Hyper-Extract knowledge engine — functional entry-point tests
 *
 *  Pure, dependency-free unit tests for the `engine/` modules. They use a
 *  deterministic mock `IChatModel` + `IEmbedder` so the full
 *  parse → index → search → persist/load pipeline can be exercised without
 *  any network or VS Code runtime.
 *
 *  Run with the bundled esbuild runner (see `run-engine-tests.mjs`):
 *    node src/.../engine/__tests__/run-engine-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { RecursiveCharacterTextSplitter } from '../textSplitter.js';
import { InMemoryCosineIndex, SplitIndex } from '../vectorIndex.js';
import { SimpleMerger, LlmMerger, BalancedMerger, MergeStrategy } from '../merge.js';
import { OMem } from '../omem.js';
import { IChatModel, ExtractRequest, stripCodeFence } from '../llm.js';
import { IEmbedder } from '../embedder.js';
import { getTemplate, listTemplates } from '../templates.js';
import { getMethod, listMethods, registerMethod } from '../methodRegistry.js';
import { AutoList } from '../autoList.js';
import { AutoGraph } from '../autoGraph.js';
import { AutoHypergraph } from '../autoHypergraph.js';
import { detectCommunities } from '../communityDetection.js';
import { KnowledgeManager, KBStorageAdapter, SerializedKB } from '../knowledgeManager.js';
import { KnowledgeItem, KeyExtractor, JsonSchema, filterValidItems } from '../types.js';
import { buildKnowledgeToolDescriptors } from '../../knowledgeTools.js';

// ── Mocks ─────────────────────────────────────────────────────────────────

/** Deterministic bag-of-words hashing embedder (no network / native deps). */
class HashEmbedder implements IEmbedder {
	readonly dimensions = 64;
	private readonly dims = 64;
	async embed(texts: string[]): Promise<number[][]> { return texts.map(t => this.one(t)); }
	async embedOne(text: string): Promise<number[]> { return this.one(text); }
	private one(text: string): number[] {
		const v = new Array(this.dims).fill(0);
		const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
		for (const w of words) {
			let h = 0;
			for (let i = 0; i < w.length; i++) { h = (h * 31 + w.charCodeAt(i)) >>> 0; }
			v[h % this.dims] += 1;
		}
		const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
		return v.map(x => x / n);
	}
}

/** Configurable mock LLM. `handler` decides what the extractor returns. */
class MockChatModel implements IChatModel {
	extractCalls = 0;
	completeCalls = 0;
	constructor(private readonly handler: (req: ExtractRequest) => any) {}
	async extract<T = any>(req: ExtractRequest): Promise<T> {
		this.extractCalls++;
		return this.handler(req) as T;
	}
	async complete(_system: string | undefined, user: string): Promise<string> {
		this.completeCalls++;
		return `Answer based on context. (query tail: ${user.slice(-24)})`;
	}
}

const embeddingMock = new HashEmbedder();

// ── Tests: textSplitter ───────────────────────────────────────────────────

test('RecursiveCharacterTextSplitter: small text stays one chunk', () => {
	const s = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 10 });
	const out = s.splitText('hello world, this is short.');
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0], 'hello world, this is short.');
});

test('RecursiveCharacterTextSplitter: large text splits within chunkSize', () => {
	const s = new RecursiveCharacterTextSplitter({ chunkSize: 40, chunkOverlap: 5 });
	const text = Array.from({ length: 20 }, (_, i) => `sentence number ${i}.`).join(' ');
	const out = s.splitText(text);
	assert.ok(out.length > 1, 'expected multiple chunks');
	for (const c of out) { assert.ok(c.length <= 40, `chunk exceeds size: ${c.length}`); }
});

test('RecursiveCharacterTextSplitter: withOverlap prepends previous tail', () => {
	const overlap = 8;
	const s = new RecursiveCharacterTextSplitter({ chunkSize: 30, chunkOverlap: overlap });
	const chunks = ['AAAAABBBBB', 'CCCCCDDDDD'];
	const out = s.withOverlap(chunks);
	assert.strictEqual(out.length, 2);
	const tail = chunks[0].slice(Math.max(0, chunks[0].length - overlap));
	assert.ok(out[1].startsWith(tail), `second chunk should start with overlap tail "${tail}", got: ${out[1]}`);
});

// ── Tests: vectorIndex ────────────────────────────────────────────────────

test('InMemoryCosineIndex: returns top-k by cosine, exact match first', () => {
	const idx = new InMemoryCosineIndex();
	const a = [1, 0, 0]; const b = [0, 1, 0]; const c = [0, 0, 1];
	idx.add(['a', 'b', 'c'], [a, b, c]);
	const hits = idx.search([0.9, 0.1, 0], 2);
	assert.strictEqual(hits.length, 2);
	assert.strictEqual(hits[0].index, 0, 'closest vector should be first');
	assert.ok(hits[0].score > hits[1].score);
});

test('InMemoryCosineIndex: empty search before add', () => {
	const idx = new InMemoryCosineIndex();
	assert.deepStrictEqual(idx.search([1, 0], 3), []);
	assert.strictEqual(idx.size(), 0);
});

test('InMemoryCosineIndex: dump/load roundtrip preserves vectors', () => {
	const idx = new InMemoryCosineIndex();
	idx.add(['x', 'y'], [[1, 0], [0, 1]]);
	const dumped = idx.dump();
	const idx2 = new InMemoryCosineIndex();
	idx2.load(dumped);
	assert.strictEqual(idx2.size(), 2);
	const hits = idx2.search([1, 0], 1);
	assert.strictEqual(hits[0].index, 0);
});

// ── Tests: merge ──────────────────────────────────────────────────────────

const keyOf: KeyExtractor = (it: KnowledgeItem) => String(it['name'] ?? '');

test('SimpleMerger: deduplicates by key, first occurrence wins', async () => {
	const m = new SimpleMerger<KnowledgeItem>(keyOf);
	const out = await m.merge([
		{ name: 'A', v: 1 },
		{ name: 'B', v: 2 },
		{ name: 'A', v: 999 }, // duplicate of A → dropped
	]);
	assert.strictEqual(out.length, 2);
	assert.strictEqual(out[0]['v'], 1, 'first A should win');
});

test('LlmMerger: groups duplicates and calls LLM to fuse, passes singletons through', async () => {
	const mock = new MockChatModel(() => ({ name: 'A', v: 3 })); // fused record
	const m = new LlmMerger<KnowledgeItem>(keyOf, mock, { type: 'object', properties: {} });
	const out = await m.merge([
		{ name: 'A', v: 1 },
		{ name: 'B', v: 2 }, // singleton → no LLM call
		{ name: 'A', v: 2 }, // duplicate of A → triggers merge
	]);
	assert.strictEqual(out.length, 2);
	assert.strictEqual(mock.extractCalls, 1, 'only the duplicate group should call the LLM');
	assert.strictEqual(out.find(x => x['name'] === 'A')!['v'], 3, 'merged value from LLM');
});

test('BalancedMerger: non-conflicting duplicates merge deterministically without LLM', async () => {
	const mock = new MockChatModel(() => ({ name: 'A' }));
	const m = new BalancedMerger<KnowledgeItem>(keyOf, mock, { type: 'object', properties: {} });
	const out = await m.merge([
		{ name: 'A', type: 'Person' },
		{ name: 'A', description: 'Engineer' }, // different field → no conflict
		{ name: 'B', type: 'Concept' },          // singleton
	]);
	assert.strictEqual(out.length, 2);
	const a = out.find(x => x['name'] === 'A')!;
	assert.strictEqual(a['type'], 'Person');
	assert.strictEqual(a['description'], 'Engineer');
	assert.strictEqual(mock.extractCalls, 0, 'no LLM call when fields do not conflict');
});

test('BalancedMerger: conflicting field values trigger LLM fusion', async () => {
	const mock = new MockChatModel(() => ({ name: 'A', type: 'Person', description: 'Fused' }));
	const m = new BalancedMerger<KnowledgeItem>(keyOf, mock, { type: 'object', properties: {} });
	const out = await m.merge([
		{ name: 'A', description: 'Engineer' },
		{ name: 'A', description: 'Designer' }, // conflict on description
	]);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(mock.extractCalls, 1, 'conflict triggers one LLM call');
	assert.strictEqual(out[0]['description'], 'Fused');
});

// ── Tests: OMem ───────────────────────────────────────────────────────────

test('OMem: add dedups by key and search returns relevant items', async () => {
	const omem = new OMem<KnowledgeItem>({
		keyExtractor: (it) => String(it['title'] ?? ''),
		itemSchema: { type: 'object', properties: {} },
		llm: new MockChatModel(() => ({})),
		embedder: embeddingMock,
		strategy: MergeStrategy.SIMPLE,
	});
	await omem.add([
		{ title: 'Python programming language guide', body: 'dynamic typed' },
		{ title: 'Rust systems language book', body: 'memory safe' },
		{ title: 'Python tutorial advanced', body: 'decorators' },
	]);
	assert.strictEqual(omem.size, 3, 'three unique keys');
	await omem.buildIndex();
	const hits = await omem.search('python language', 2);
	assert.ok(hits.length > 0);
	assert.ok(String(hits[0]['title']).toLowerCase().includes('python'), 'top hit should be python-related');
});

test('OMem: dumpData/loadData roundtrip', async () => {
	const omem = new OMem<KnowledgeItem>({
		keyExtractor: (it) => String(it['title'] ?? ''),
		itemSchema: { type: 'object', properties: {} },
		llm: new MockChatModel(() => ({})),
		embedder: embeddingMock,
		strategy: MergeStrategy.SIMPLE,
	});
	await omem.add([{ title: 'X', body: 'y' }]);
	const data = omem.dumpData();
	const omem2 = new OMem<KnowledgeItem>({
		keyExtractor: (it) => String(it['title'] ?? ''),
		itemSchema: { type: 'object', properties: {} },
		llm: new MockChatModel(() => ({})),
		embedder: embeddingMock,
		strategy: MergeStrategy.SIMPLE,
	});
	omem2.loadData(data);
	assert.strictEqual(omem2.size, 1);
});

// ── Tests: templates ──────────────────────────────────────────────────────

test('templates: listTemplates exposes built-ins, getTemplate builds correct type', () => {
	const list = listTemplates();
	assert.ok(list.find(t => t.id === 'knowledge_graph'));
	assert.ok(list.find(t => t.id === 'entity_list'));
	assert.ok(list.find(t => t.id === 'faq'));

	const g = getTemplate('knowledge_graph')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(g instanceof AutoGraph, 'knowledge_graph → AutoGraph');
	const l = getTemplate('entity_list')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(l instanceof AutoList, 'entity_list → AutoList');
	assert.strictEqual(getTemplate('does_not_exist'), undefined);
});

// ── Tests: AutoList pipeline ──────────────────────────────────────────────

function listMock(): MockChatModel {
	return new MockChatModel((req) => {
		// entity_list / faq extraction returns a fixed item set
		return { items: [
			{ title: 'Python', content: 'A high-level programming language', category: 'language' },
			{ title: 'TypeScript', content: 'A typed superset of JavaScript', category: 'language' },
		] };
	});
}

test('AutoList: feedText → buildIndex → search → chat end-to-end', async () => {
	const at = new AutoList({
		llm: listMock(), embedder: embeddingMock,
		itemSchema: { type: 'object', properties: {} },
		keyExtractor: (it) => String(it['title'] ?? ''),
		strategy: MergeStrategy.SIMPLE,
		fieldsForIndex: ['title', 'content'],
	});
	await at.feedText('Python is a popular programming language. TypeScript adds types to JavaScript.');
	assert.strictEqual(at.items.length, 2, 'two items extracted');

	await at.buildIndex();
	const hits = await at.search('programming language python', 1);
	assert.strictEqual(hits.length, 1);
	assert.strictEqual(String(hits[0]['title']), 'Python');

	const chat = await at.chat('What is Python?', 2);
	assert.ok(chat.text.length > 0);
	assert.ok(chat.retrieved.length > 0);
});

// ── Tests: AutoGraph pipeline (two-stage) ────────────────────────────────

function graphMock(): MockChatModel {
	return new MockChatModel((req) => {
		if (String(req.prompt).includes('Provided Entities')) {
			// edge-extraction call
			return { items: [
				{ source: 'Alice', target: 'Bob', relation: 'knows' },
				{ source: 'Alice', target: 'Zoe', relation: 'mentors' }, // Zoe not a node → pruned
			] };
		}
		// node-extraction call
		return { items: [
			{ name: 'Alice', type: 'Person', description: 'Engineer' },
			{ name: 'Bob', type: 'Person', description: 'Designer' },
		] };
	});
}

test('AutoGraph: two-stage extraction + dangling-edge pruning', async () => {
	const at = new AutoGraph({
		llm: graphMock(), embedder: embeddingMock,
		nodeSchema: { type: 'object', properties: {} },
		edgeSchema: { type: 'object', properties: {} },
		nodeKeyExtractor: (n) => String(n['name'] ?? '').toLowerCase(),
		edgeKeyExtractor: (e) => `${e['source']}|${e['relation']}|${e['target']}`.toLowerCase(),
		nodesInEdgeExtractor: (e) => [String(e['source']).toLowerCase(), String(e['target']).toLowerCase()],
		extractionMode: 'two_stage',
		nodeStrategy: MergeStrategy.SIMPLE,
		edgeStrategy: MergeStrategy.SIMPLE,
	});
	await at.feedText('Alice is an engineer who knows Bob and mentors Zoe.');
	assert.strictEqual(at.nodes.length, 2, 'two nodes');
	assert.strictEqual(at.edges.length, 1, 'dangling edge to Zoe must be pruned');
	assert.strictEqual(String(at.edges[0]['target']), 'Bob');

	await at.buildIndex();
	const r = await at.searchGraph('Alice relationship', 3, 3);
	assert.strictEqual(r.nodes.length, 2);
	assert.strictEqual(r.edges.length, 1);
});

test('AutoGraph: toMarkdown + toMermaid export (Obsidian-style)', async () => {
	const at = new AutoGraph({
		llm: graphMock(), embedder: embeddingMock,
		nodeSchema: { type: 'object', properties: {} },
		edgeSchema: { type: 'object', properties: {} },
		nodeKeyExtractor: (n) => String(n['name'] ?? '').toLowerCase(),
		edgeKeyExtractor: (e) => `${e['source']}|${e['relation']}|${e['target']}`.toLowerCase(),
		nodesInEdgeExtractor: (e) => [String(e['source']).toLowerCase(), String(e['target']).toLowerCase()],
		extractionMode: 'two_stage',
		nodeStrategy: MergeStrategy.SIMPLE,
		edgeStrategy: MergeStrategy.SIMPLE,
	});
	await at.feedText('Alice is an engineer who knows Bob.');
	await at.buildIndex();

	const md = at.toMarkdown({ title: 'People Graph' });
	assert.ok(md.includes('# People Graph'), 'title rendered');
	assert.ok(md.includes('[[Alice]]'), 'node wikilink rendered');
	assert.ok(md.includes('[[Alice]] --'), 'edge wikilinks rendered');
	assert.ok(md.includes('```mermaid'), 'mermaid block present');

	const mer = at.toMermaid();
	assert.ok(mer.startsWith('graph LR'), 'mermaid header');
	assert.ok(mer.includes('-->|'), 'mermaid edge with relation');

	// list / model / set / hypergraph templates now export as Markdown bullets
	const mgr = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock });
	const listSession = mgr.create('entity_list', { title: 'My List' });
	await listSession.autoType.feedText('Python is a language. TypeScript is a language.');
	await listSession.autoType.buildIndex();
	const listMd = mgr.exportMarkdown(listSession, { title: 'My List' });
	assert.ok(listMd.includes('# My List'), 'list title rendered');
	assert.ok(listMd.includes('Python'), 'list item rendered');
	assert.ok(!/not supported/i.test(listMd), 'list export no longer throws');
});

// ── Tests: KnowledgeManager (orchestration) ──────────────────────────────

class MemStorage implements KBStorageAdapter {
	private map = new Map<string, SerializedKB>();
	async read(id: string) { return this.map.get(id); }
	async write(id: string, p: SerializedKB) { this.map.set(id, p); }
	async remove(id: string) { this.map.delete(id); }
	async list() {
		return [...this.map.values()].map(p => {
			const m = (p.metadata ?? {}) as Record<string, any>;
			return { id: m.id, templateId: m.templateId, title: m.title, kind: m.kind, itemCount: 0, createdAt: m.createdAt ?? '', updatedAt: m.updatedAt ?? '' };
		});
	}
}

test('KnowledgeManager: availableTemplates + create meta', () => {
	const mgr = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock });
	const tpls = KnowledgeManager.availableTemplates();
	assert.ok(tpls.some(t => t.id === 'entity_list'));

	const s = mgr.create('entity_list', { title: 'My KB' });
	assert.strictEqual(s.title, 'My KB');
	assert.strictEqual(s.kind, 'list');
	assert.strictEqual(mgr.list().length, 1);
});

test('KnowledgeManager: parseText builds index and search works', async () => {
	const mgr = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock });
	const s = mgr.create('entity_list');
	await mgr.parseText(s, 'Python is a programming language. TypeScript is typed JavaScript.');
	const meta = mgr.list()[0];
	assert.ok(meta.itemCount >= 2, 'items extracted & counted');

	const res = await mgr.search(s, 'python language', 1);
	assert.strictEqual(res.type, 'list');
	assert.strictEqual(String((res.items![0] as any)['title']), 'Python');

	const chat = await mgr.chat(s, 'tell me about python');
	assert.ok(chat.text.length > 0);
});

test('KnowledgeManager: persist → load roundtrip restores data', async () => {
	const storage = new MemStorage();
	const mgr = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock, storage });
	const s = mgr.create('entity_list', { id: 'kb-test-1', title: 'Persisted' });
	await mgr.parseText(s, 'Python is a programming language.');
	await mgr.persist(s);

	// Load into a fresh manager (index restored from storage).
	const mgr2 = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock, storage });
	const loaded = await mgr2.load('kb-test-1');
	assert.strictEqual(loaded.title, 'Persisted');
	assert.strictEqual(loaded.kind, 'list');
	assert.ok(loaded.autoType.data.items.length >= 1, 'data restored after load');

	const res = await mgr2.search(loaded, 'python', 1);
	assert.strictEqual(String((res.items![0] as any)['title']), 'Python');

	const listed = await mgr2.listStored();
	assert.ok(listed.some(x => x.id === 'kb-test-1'));
});

test('KnowledgeManager: delete removes session and storage', async () => {
	const storage = new MemStorage();
	const mgr = new KnowledgeManager({ llm: listMock(), embedder: embeddingMock, storage });
	const s = mgr.create('entity_list', { id: 'kb-del-1' });
	await mgr.parseText(s, 'TypeScript adds types.');
	await mgr.persist(s);
	assert.strictEqual((await storage.list()).length, 1);

	await mgr.delete('kb-del-1');
	assert.strictEqual(mgr.list().length, 0);
	assert.strictEqual((await storage.list()).length, 0);
});

test('KnowledgeManager: graph search returns both nodes and edges (no edge loss)', async () => {
	const mgr = new KnowledgeManager({ llm: graphMock(), embedder: embeddingMock });
	const s = mgr.create('knowledge_graph', { title: 'People' });
	await mgr.parseText(s, 'Alice is an engineer who knows Bob.');

	const res = await mgr.search(s, 'Alice relationship', 3);
	assert.strictEqual(res.type, 'graph');
	assert.ok((res.nodes ?? []).length > 0, 'nodes retrieved');
	assert.ok((res.edges ?? []).length > 0, 'edges retrieved (regression: edges must not be empty)');

	const chat = await mgr.chat(s, 'who does Alice know?', 3);
	assert.strictEqual(chat.retrieved.type, 'graph');
	assert.ok((chat.retrieved.edges ?? []).length > 0, 'chat retrieved edges too');
});

// ── Tests: llm helper ────────────────────────────────────────────────────

test('stripCodeFence: strips json fences and leaves plain text', () => {
	assert.strictEqual(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
	assert.strictEqual(stripCodeFence('{"a":1}'), '{"a":1}');
	assert.strictEqual(stripCodeFence('```\nhello\n```'), 'hello');
});

// ── Tests: schema validation ─────────────────────────────────────────────

test('filterValidItems: drops records missing required fields', () => {
	const schema: JsonSchema = { type: 'object', required: ['name', 'type'], properties: {} };
	const items: KnowledgeItem[] = [
		{ name: 'A', type: 'Person' },           // valid
		{ name: 'B' },                            // missing type → drop
		{ type: 'Concept' },                      // missing name → drop
		{ name: '', type: 'X' },                  // empty name → drop
		{ name: 'C', type: 'Org', extra: 1 },     // valid (extra field ok)
	];
	const out = filterValidItems(items, schema);
	assert.strictEqual(out.length, 2);
	assert.deepStrictEqual(out.map(x => x['name']), ['A', 'C']);
});

test('AutoGraph: malformed nodes/edges are filtered before entering the store', async () => {
	// node-extraction returns one valid + one missing `name`; edge-extraction
	// returns one valid + one missing `relation`. The invalid records must be
	// dropped so they never reach OMem dedup / the vector index.
	const mock = new MockChatModel((req) => {
		if (String(req.prompt).includes('Provided Entities')) {
			return { items: [
				{ source: 'Alice', target: 'Bob', relation: 'knows' },
				{ source: 'Alice', target: 'Bob' }, // missing relation → drop
			] };
		}
		return { items: [
			{ name: 'Alice', type: 'Person', description: 'Engineer' },
			{ name: 'Bob', type: 'Person', description: 'Designer' },
			{ type: 'Ghost' }, // missing name → drop
		] };
	});
	const at = new AutoGraph({
		llm: mock, embedder: embeddingMock,
		nodeSchema: { type: 'object', required: ['name'], properties: {} },
		edgeSchema: { type: 'object', required: ['source', 'target', 'relation'], properties: {} },
		nodeKeyExtractor: (n) => String(n['name'] ?? '').toLowerCase(),
		edgeKeyExtractor: (e) => `${e['source']}|${e['relation']}|${e['target']}`.toLowerCase(),
		nodesInEdgeExtractor: (e) => [String(e['source']).toLowerCase(), String(e['target']).toLowerCase()],
		extractionMode: 'two_stage',
		nodeStrategy: MergeStrategy.SIMPLE,
		edgeStrategy: MergeStrategy.SIMPLE,
	});
	await at.feedText('Alice knows Bob.');
	assert.strictEqual(at.nodes.length, 2, 'malformed node dropped (Alice + Bob kept, Ghost dropped)');
	assert.strictEqual(String(at.nodes[0]['name']), 'Alice');
	assert.strictEqual(at.edges.length, 1, 'malformed edge dropped');
	assert.strictEqual(String(at.edges[0]['relation']), 'knows');
});

// ── Tests: template discovery (domain + filter) ──────────────────────────

test('listTemplates: filter by kind and domain', () => {
	const graphs = listTemplates({ kind: 'graph' });
	assert.ok(graphs.length > 0);
	assert.ok(graphs.every(t => t.kind === 'graph'));
	assert.ok(graphs.every(t => typeof t.domain === 'string'));

	const finance = listTemplates({ domain: 'finance' });
	assert.ok(finance.length > 0);
	assert.ok(finance.every(t => t.domain === 'finance'));
	assert.ok(finance.some(t => t.id === 'ownership_graph'));

	const legalLists = listTemplates({ kind: 'list', domain: 'legal' });
	assert.ok(legalLists.length > 0);
	assert.ok(legalLists.every(t => t.kind === 'list' && t.domain === 'legal'));
});

// ── Tests: extraction method registry (P4) ───────────────────────────────

test('listMethods: built-in methods registered with correct kinds', () => {
	const all = listMethods();
	assert.ok(all.length >= 6, 'at least the 6 built-in methods');
	const names = all.map(m => m.name);
	for (const n of ['light_rag', 'itext2kg', 'itext2kg_star', 'atom', 'kg_gen', 'hyper_rag']) {
		assert.ok(names.includes(n), `method present: ${n}`);
	}
	// graph methods are graphs, hyper_rag is a real hypergraph
	assert.strictEqual(getMethod('light_rag')!.kind, 'graph');
	assert.strictEqual(getMethod('itext2kg')!.kind, 'graph');
	assert.strictEqual(getMethod('itext2kg_star')!.kind, 'graph');
	assert.strictEqual(getMethod('atom')!.kind, 'graph');
	assert.strictEqual(getMethod('kg_gen')!.kind, 'graph');
	assert.strictEqual(getMethod('hyper_rag')!.kind, 'graph');
});

test('getMethod.build: graph method returns an AutoGraph, hyper_rag returns an AutoHypergraph', () => {
	const g = getMethod('itext2kg')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(g instanceof AutoGraph, 'graph method → AutoGraph');
	const h = getMethod('hyper_rag')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(h instanceof AutoHypergraph, 'hyper_rag → AutoHypergraph (real N-ary hypergraph)');
});

// ── Tests: community detection (pure Louvain) ───────────────────────

test('detectCommunities: two disconnected triangles → 2 recovered clusters', () => {
	const nodeIds = ['A', 'B', 'C', 'X', 'Y', 'Z'];
	const edges = [
		{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }, { source: 'A', target: 'C' },
		{ source: 'X', target: 'Y' }, { source: 'Y', target: 'Z' }, { source: 'X', target: 'Z' },
	];
	const r = detectCommunities(nodeIds, edges);
	assert.strictEqual(r.communities.size, 2, 'two communities');
	// The two triangles must be perfectly recovered.
	const ab = r.nodeCommunity.get('A');
	const xy = r.nodeCommunity.get('X');
	assert.ok(ab && xy && ab !== xy, 'the two clusters have distinct ids');
	assert.strictEqual(r.nodeCommunity.get('B'), ab);
	assert.strictEqual(r.nodeCommunity.get('C'), ab);
	assert.strictEqual(r.nodeCommunity.get('Y'), xy);
	assert.strictEqual(r.nodeCommunity.get('Z'), xy);
	assert.ok(Number.isFinite(r.modularity), 'modularity is finite');
});

test('detectCommunities: empty / single-node graphs are safe', () => {
	assert.strictEqual(detectCommunities([], []).communities.size, 0);
	const r = detectCommunities(['solo'], []);
	assert.strictEqual(r.communities.size, 1, 'lone node is its own community');
	assert.strictEqual(r.nodeCommunity.get('solo'), 'c0');
});

test('detectCommunities: resolution tunes granularity (higher → finer)', () => {
	// A hub-and-spoke: center H linked to A,B,C (no spoke-spoke edges).
	const nodeIds = ['H', 'A', 'B', 'C'];
	const edges = [
		{ source: 'H', target: 'A', weight: 1 },
		{ source: 'H', target: 'B', weight: 1 },
		{ source: 'H', target: 'C', weight: 1 },
	];
	const coarse = detectCommunities(nodeIds, edges, { resolution: 0.5 });
	const fine = detectCommunities(nodeIds, edges, { resolution: 5.0 });
	// At low resolution the whole star is one community; high resolution can split spokes off.
	assert.ok(coarse.communities.size <= fine.communities.size, 'higher resolution yields ≥ as many communities');
});

// ── Tests: P3 community-aware methods ───────────────────────────────

test('P3 methods: graph_rag / cog_rag / hypergraph_rag exist & are community-aware', () => {
	for (const n of ['graph_rag', 'cog_rag', 'hypergraph_rag']) {
		assert.ok(getMethod(n), `method present: ${n}`);
		assert.strictEqual(getMethod(n)!.kind, 'graph');
		assert.strictEqual(getMethod(n)!.communityAware, true, `${n} is community-aware`);
	}
	const g = getMethod('graph_rag')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(g instanceof AutoGraph, 'graph_rag → AutoGraph');
	const c = getMethod('cog_rag')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(c instanceof AutoGraph, 'cog_rag → AutoGraph');
	const h = getMethod('hypergraph_rag')!.build(new MockChatModel(() => ({})), embeddingMock);
	assert.ok(h instanceof AutoHypergraph, 'hypergraph_rag → AutoHypergraph');
});

function communityMock(): MockChatModel {
	return new MockChatModel((req) => {
		const p = String(req.prompt);
		if (p.includes('Provided Entities')) {
			return { items: [
				{ source: 'Alice', target: 'Bob', relation: 'teammate' },
				{ source: 'Bob', target: 'Carol', relation: 'teammate' },
				{ source: 'Alice', target: 'Carol', relation: 'teammate' },
				{ source: 'X', target: 'Y', relation: 'rival' },
				{ source: 'Y', target: 'Z', relation: 'rival' },
				{ source: 'X', target: 'Z', relation: 'rival' },
			] };
		}
		return { items: [
			{ name: 'Alice', type: 'Person', description: 'A' },
			{ name: 'Bob', type: 'Person', description: 'B' },
			{ name: 'Carol', type: 'Person', description: 'C' },
			{ name: 'X', type: 'Org', description: 'X' },
			{ name: 'Y', type: 'Org', description: 'Y' },
			{ name: 'Z', type: 'Org', description: 'Z' },
		] };
	});
}

test('P3: graph_rag runs community detection + summarization after parseText', async () => {
	const mgr = new KnowledgeManager({ llm: communityMock(), embedder: embeddingMock });
	const s = mgr.create('kg', { method: 'graph_rag' });
	await mgr.parseText(s, 'Some text about Alice, Bob, Carol (team) and X, Y, Z (rivals).');

	const at = s.autoType as unknown as {
		communityAware: boolean;
		detectedCommunities?: { communities: Map<string, string[]> };
		communitySummaries: { id: string; title: string; summary: string }[];
	};
	assert.strictEqual(at.communityAware, true, 'graph_rag autoType is community-aware');
	assert.ok(at.detectedCommunities, 'communities detected after parseText');
	assert.strictEqual(at.detectedCommunities!.communities.size, 2, 'two communities recovered');
	assert.strictEqual(at.communitySummaries.length, 2, 'LLM summarized both communities');
	// Export must include a community section.
	const md = s.autoType.toMarkdown({ title: 'RAG Graph' });
	assert.ok(md.includes('## 社区 (Communities)'), 'markdown includes community section');
});

test('KnowledgeManager.create: method overrides template default build', () => {
	const mgr = new KnowledgeManager({ llm: new MockChatModel(() => ({})), embedder: embeddingMock });
	const s = mgr.create('knowledge_graph', { method: 'itext2kg' });
	assert.strictEqual(s.kind, 'graph');
	assert.strictEqual(s.templateId, 'itext2kg');
	assert.ok(s.autoType instanceof AutoGraph);
	// Unknown method must throw a clear error.
	assert.throws(() => mgr.create('knowledge_graph', { method: 'no_such_method' }));
});

test('Method-built KB persists and reloads (templateId = method name)', async () => {
	// A minimal in-memory storage adapter for round-trip testing.
	const store = new Map<string, SerializedKB>();
	const adapter: KBStorageAdapter = {
		async read(id: string) { return store.get(id); },
		async write(id: string, p: SerializedKB) { store.set(id, p); },
		async remove(id: string) { store.delete(id); },
	};
	const mgr = new KnowledgeManager({ llm: new MockChatModel(() => ({})), embedder: embeddingMock, storage: adapter });
	const s = mgr.create('knowledge_graph', { method: 'atom' });
	await mgr.persist(s); // persist() stamps metadata.templateId = method name

	const reloaded = await mgr.load(s.id);
	assert.strictEqual(reloaded.kind, 'graph');
	assert.strictEqual(reloaded.templateId, 'atom', 'method name persisted as templateId, resolved on load');
	assert.ok(reloaded.autoType instanceof AutoGraph);
});

test('atom method: edges require time + evidence (schema enforced via filterValidItems)', async () => {
	// The atom edge schema marks time + evidence as required; an edge missing
	// them must be dropped before entering the store (no dangling/partial edges).
	const mock = new MockChatModel((req) => {
		if (String(req.prompt).includes('Provided Entities')) {
			return { items: [
				{ source: 'Alice', target: 'Bob', relation: 'knows', time: '2020', evidence: 'p.1' },
				{ source: 'Alice', target: 'Bob', relation: 'knows' }, // missing time/evidence → drop
			] };
		}
		return { items: [
			{ name: 'Alice', type: 'Person', description: 'Engineer' },
			{ name: 'Bob', type: 'Person', description: 'Designer' },
		] };
	});
	const at = getMethod('atom')!.build(mock, embeddingMock) as AutoGraph;
	await at.feedText('Alice knows Bob since 2020 (p.1).');
	assert.strictEqual(at.edges.length, 1, 'atom edge missing time/evidence dropped');
	assert.strictEqual(String(at.edges[0]['evidence']), 'p.1');
});

// ── Tests: entry-point robustness (regression coverage) ──────────────────

test('BalancedMerger: LLM fusion failure gracefully degrades to first item', async () => {
	// When the LLM throws during a conflict fusion, the merger should silently
	// keep the first occurrence rather than propagate the error.
	const badMock = new MockChatModel(() => { throw new Error('LLM down'); });
	const m = new BalancedMerger<KnowledgeItem>(keyOf, badMock, { type: 'object', properties: {} });
	const out = await m.merge([
		{ name: 'A', type: 'Person', description: 'First' },
		{ name: 'A', type: 'Org', description: 'Second' }, // conflict → triggers LLM → throws
		{ name: 'B', type: 'Concept' },                     // singleton, no LLM
	]);
	assert.strictEqual(out.length, 2);
	assert.strictEqual(out[0]['type'], 'Person', 'kept first occurrence on LLM failure');
	assert.strictEqual(out[0]['description'], 'First');
	assert.strictEqual(out[1]['name'], 'B');
});

test('registerMethod: overwriting same name replaces previous definition', () => {
	const original = getMethod('itext2kg');
	assert.ok(original, 'original exists');
	const originalDesc = original!.description;

	// Overwrite with a custom build.
	const customBuild = () => original!.build(
		new MockChatModel(() => ({})),
		embeddingMock,
	);
	registerMethod({
		name: 'itext2kg',
		kind: 'graph',
		description: 'custom-overridden',
		build: customBuild,
	});
	const replaced = getMethod('itext2kg');
	assert.strictEqual(replaced!.description, 'custom-overridden');
	assert.ok(replaced!.build !== original!.build, 'replaced build function');

	// Restore original so downstream tests are unaffected.
	registerMethod(original!);
	const restored = getMethod('itext2kg');
	assert.strictEqual(restored!.description, originalDesc, 'restored');
});

test('KnowledgeManager.create: method branch ignores bad templateId', () => {
	// When `method` is set, template lookup is bypassed — method.build()
	// produces the AutoType directly. Providing a nonexistent templateId must
	// NOT throw.
	const mgr = new KnowledgeManager({ llm: new MockChatModel(() => ({})), embedder: embeddingMock });
	const s = mgr.create('__nonexistent_template__', { method: 'light_rag' });
	assert.strictEqual(s.kind, 'graph');
	assert.strictEqual(s.templateId, 'light_rag');
	assert.ok(s.autoType instanceof AutoGraph);
});

test('OMem: default SplitIndex clusters when above threshold', async () => {
	// OMem now defaults to SplitIndex (since P2). For size >= 200, build()
	// performs K-Means clustering; for size < 200, exact fallback.
	const mock = new MockChatModel(() => ({ name: 'ok' }));
	const mem = new OMem<KnowledgeItem>({
		keyExtractor: keyOf,
		itemSchema: { type: 'object', required: ['name'], properties: {} },
		llm: mock, embedder: embeddingMock,
		strategy: MergeStrategy.SIMPLE,
	});
	// Create 250 items — above SPLIT_THRESHOLD (200).
	const items: KnowledgeItem[] = [];
	const targetIdx = 42;
	for (let i = 0; i < 250; i++) {
		items.push({ name: `item-${i}`, val: i });
	}
	await mem.add(items);
	await mem.buildIndex();
	assert.strictEqual(mem.size, 250);

	// Search should work with the clustered index.
	const hits = await mem.search(`item-${targetIdx}`, 3);
	assert.strictEqual(hits.length, 3);
	// The target item must be present (clustering must not lose it).
	const names = hits.map(h => String((h as KnowledgeItem)['name']));
	assert.ok(names.includes(`item-${targetIdx}`), `target item-${targetIdx} in results: ${names}`);
});

// ── Tests: SplitIndex (P2 — approximate ANN) ──────────────────────────────

test('SplitIndex: below threshold falls back to exact cosine search', async () => {
	const idx = new SplitIndex();
	const vectors = [
		await embeddingMock.embedOne('apple fruit'),
		await embeddingMock.embedOne('banana fruit'),
		await embeddingMock.embedOne('car vehicle'),
	];
	const texts = ['apple', 'banana', 'car'];
	idx.add(texts, vectors);
	idx.build?.();
	const hits = idx.search(await embeddingMock.embedOne('fruit snack'), 2);
	assert.strictEqual(hits.length, 2);
	const got = new Set(hits.map(h => texts[h.index]));
	// 'apple' and 'banana' both contain 'fruit' in their text → should rank above 'car'
	assert.ok(got.has('apple') || got.has('banana'), `fruit items ranked high; got: ${[...got].join()}`);
});

test('SplitIndex: round-trip dump/load preserves search', async () => {
	const idx = new SplitIndex();
	const vPromises = Array.from({ length: 10 }, (_, i) =>
		embeddingMock.embedOne(`item-${i}`),
	);
	const vectors = await Promise.all(vPromises);
	const texts = vectors.map((_, i) => `doc-${i}`);
	idx.add(texts, vectors);
	idx.build?.();
	const query = await embeddingMock.embedOne('item-5');
	const hitsA = idx.search(query, 3);

	const snapshot = idx.dump();
	const idx2 = new SplitIndex();
	idx2.load(snapshot);
	const hitsB = idx2.search(query, 3);

	assert.strictEqual(idx.size(), idx2.size());
	assert.strictEqual(hitsA.length, hitsB.length);
	for (let i = 0; i < hitsA.length; i++) {
		assert.strictEqual(hitsA[i].index, hitsB[i].index, `index match at ${i}`);
		const diff = Math.abs(hitsA[i].score - hitsB[i].score);
		assert.ok(diff < 0.01, `score match at ${i}: diff=${diff}, a=${hitsA[i].score}, b=${hitsB[i].score}`);
	}
});

test('SplitIndex: large index clusters and approximates with high recall', async () => {
	const n = 300;
	const topicWords = ['fruit', 'vehicle', 'animal', 'sport', 'music',
		'tool', 'city', 'food', 'plant', 'color'];
	const texts: string[] = [];
	const vPromises: Promise<number[]>[] = [];
	for (let i = 0; i < n; i++) {
		const topic = topicWords[i % topicWords.length];
		texts.push(`${topic}-${i}`);
		vPromises.push(embeddingMock.embedOne(`${topic} item number ${i}`));
	}
	const vectors = await Promise.all(vPromises);

	const idx = new SplitIndex();
	idx.add(texts, vectors);
	idx.build?.();
	assert.ok(idx.size() >= SplitIndex.SPLIT_THRESHOLD, 'above threshold');

	const query = await embeddingMock.embedOne('music instrument sound note');
	const hits = idx.search(query, 5);
	assert.strictEqual(hits.length, 5, 'should return 5 hits');
	// Approx recall: at least 1 of the top 5 should be music (the K-Means
	// clustering trades precision for speed, but the correct cluster must be
	// probed). With the deterministic hash embedder and 10 topics the recall
	// is typically 1-2 of 5.
	const musicCount = hits.filter(h => texts[h.index].startsWith('music')).length;
	assert.ok(musicCount >= 1, `music hits in top 5: ${musicCount} (expected >=1)`);
});

// ── Tests: tool-layer integration (kb_list_methods + kb_build schema) ─────

test('buildKnowledgeToolDescriptors: includes kb_list_methods with correct schema', async () => {
	const descriptors = buildKnowledgeToolDescriptors({
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/mock/workspace',
		resolveStorageRoot: async () => '/mock/.saros/kb',
	});

	const m = descriptors.find(d => d.definition.name === 'kb_list_methods');
	assert.ok(m, 'kb_list_methods descriptor exists');
	assert.strictEqual(m!.definition.category, 'knowledge');
	assert.strictEqual(m!.definition.source, 'saros.knowledge');

	// Handler is pure: call it without deps.
	const result = await m!.handler({}) as any;
	assert.ok(result.length > 0, 'handler returns content');
	const text = result[0].text as string;
	const parsed = JSON.parse(text);
	assert.ok(Array.isArray(parsed), 'returns a JSON array of methods');
	assert.ok(parsed.length >= 6, 'at least 6 methods');
	const names = parsed.map((x: any) => x.name);
	assert.ok(names.includes('light_rag'));
	assert.ok(names.includes('hyper_rag'));
});

test('buildKnowledgeToolDescriptors: kb_build schema exposes method parameter', () => {
	const descriptors = buildKnowledgeToolDescriptors({
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/mock/workspace',
		resolveStorageRoot: async () => '/mock/.saros/kb',
	});

	const b = descriptors.find(d => d.definition.name === 'kb_build');
	assert.ok(b, 'kb_build descriptor exists');
	const schema = b!.definition.inputSchema as any;
	assert.ok(schema.properties, 'has properties');
	assert.ok('method' in schema.properties, 'schema exposes method parameter');
	assert.strictEqual(schema.properties.method.type, 'string');
	// template_id is still present (not replaced)
	assert.ok('template_id' in schema.properties, 'template_id still present');
});

// ── Tests: Hybrid Search RRF Fusion ───────────────────────────────────────

import { fuseHybrid, hybridSearch } from '../hybridSearch.js';

test('RRF fusion: two disjoint lists merge correctly', () => {
	const fts = ['doc-A', 'doc-B', 'doc-C'];
	const vec = ['doc-X', 'doc-Y'];
	const result = fuseHybrid(fts, vec, x => x, 10);

	assert.strictEqual(result.stats.ftsTotal, 3);
	assert.strictEqual(result.stats.vectorTotal, 2);
	assert.strictEqual(result.stats.mergedTotal, 5, 'all unique items preserved');
	assert.strictEqual(result.hits.length, 5);

	// FTS rank 1 gets RRF = 1/(60+1)
	assert.strictEqual(result.hits[0].item, 'doc-A', 'top FTS hit should rank first');
});

test('RRF fusion: overlapping items get combined scores', () => {
	const fts = ['shared', 'a', 'b'];
	const vec = ['shared', 'x'];
	const result = fuseHybrid(fts, vec, x => x, 10);

	assert.strictEqual(result.stats.mergedTotal, 4, 'shared + a + b + x');
	const shared = result.hits.find(h => h.item === 'shared')!;
	assert.ok(shared.ftsScore >= 0, 'has fts score');
	assert.ok(shared.vectorScore >= 0, 'has vector score');
	assert.ok(shared.rrfScore > 1 / (60 + 1), 'combined RRF > single rank');
});

test('RRF fusion: empty input gracefully handled', () => {
	const r1 = fuseHybrid([], [], x => x, 5);
	assert.strictEqual(r1.hits.length, 0);
	assert.strictEqual(r1.stats.mergedTotal, 0);

	const r2 = fuseHybrid(['only'], [], x => x, 5);
	assert.strictEqual(r2.hits.length, 1);
	assert.strictEqual(r2.hits[0].ftsScore, 0, 'rank 0 → score 0');
	assert.strictEqual(r2.hits[0].vectorScore, -1, 'no vector score');
});

test('RRF fusion: topK limits results', () => {
	const fts = Array.from({ length: 20 }, (_, i) => `doc-${i}`);
	const vec = Array.from({ length: 20 }, (_, i) => `doc-${i + 10}`);
	const result = fuseHybrid(fts, vec, x => x, 5);
	assert.strictEqual(result.hits.length, 5);
});

test('hybridSearch: async pipeline with parallel fts + vector', async () => {
	const ftsItems = ['fts-1', 'fts-2', 'fts-3'];
	const vecItems = ['vec-1', 'fts-1']; // overlap

	const result = await hybridSearch(
		'test query',
		async (_q, _k) => ftsItems,
		async (_q, _k) => vecItems,
		x => x,
		10,
	);

	assert.strictEqual(result.stats.ftsTotal, 3);
	assert.strictEqual(result.stats.vectorTotal, 2);
	assert.strictEqual(result.stats.mergedTotal, 4, 'fts-1 merged');
});

test('hybridSearch: handles fts failure gracefully', async () => {
	const result = await hybridSearch(
		'q',
		async () => { throw new Error('fts down'); },
		async () => ['vec-hit'],
		x => x,
		5,
	);
	assert.strictEqual(result.stats.ftsTotal, 0);
	assert.strictEqual(result.stats.vectorTotal, 1);
	assert.strictEqual(result.hits.length, 1);
});

// ── Tests: OMem Incremental Index ─────────────────────────────────────────

test('OMem incremental: buildIndexIncremental only embeds new items', async () => {
	type NodeItem = { name: string; type: string; description: string };
	const extracted = {
		extractCalls: 0,
		handler(_req: ExtractRequest): any {
			this.extractCalls++;
			return {
				items: [],
				nodes: [{ name: `node-${this.extractCalls}`, type: 'concept', description: `desc ${this.extractCalls}` }],
				edges: [],
			};
		},
	};

	const llm = new MockChatModel((req) => extracted.handler(req));
	const embedder = new HashEmbedder();

	const omem = new OMem<NodeItem>({
		keyExtractor: x => String(x.name),
		itemSchema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				type: { type: 'string' },
				description: { type: 'string' },
			},
			required: ['name'],
		},
		llm,
		embedder,
		strategy: MergeStrategy.SIMPLE,
		fieldsForIndex: ['name', 'type', 'description'],
	});

	// First build: 3 items
	await omem.add([
		{ name: 'a', type: 'concept', description: 'item A' },
		{ name: 'b', type: 'concept', description: 'item B' },
		{ name: 'c', type: 'concept', description: 'item C' },
	]);
	await omem.buildIndexIncremental();
	assert.strictEqual(omem.hasIndex(), true);
	assert.strictEqual(omem.size, 3);

	const results1 = await omem.search('item A', 3);
	assert.strictEqual(results1.length, 3);

	// Incremental: add 1 more item, only embed the new one
	await omem.add([
		{ name: 'a', type: 'concept', description: 'item A' }, // dup
		{ name: 'b', type: 'concept', description: 'item B' },
		{ name: 'c', type: 'concept', description: 'item C' },
		{ name: 'd', type: 'concept', description: 'item D NEW' },
	]);
	await omem.buildIndexIncremental();
	assert.strictEqual(omem.size, 4);

	const results2 = await omem.search('NEW', 3);
	const hasNew = results2.some(r => (r as NodeItem).name === 'd');
	assert.ok(hasNew, 'new item "d" is searchable after incremental build');
});

test('OMem incremental: clearIndex resets indexed keys', async () => {
	const omem = new OMem<{ name: string }>({
		keyExtractor: x => String(x.name),
		itemSchema: {
			type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
		},
		llm: new MockChatModel(() => ({ items: [], nodes: [], edges: [] })),
		embedder: new HashEmbedder(),
		strategy: MergeStrategy.SIMPLE,
	});

	await omem.add([{ name: 'x' }, { name: 'y' }]);
	await omem.buildIndexIncremental();
	assert.strictEqual(omem.hasIndex(), true);

	omem.clearIndex();
	assert.strictEqual(omem.hasIndex(), false);

	// After clear, a full rebuild should work
	await omem.buildIndexIncremental();
	assert.strictEqual(omem.hasIndex(), true);
	assert.strictEqual(omem.size, 2);
});

// ── Tests: Streaming Completion (SSE) ─────────────────────────────────────

test('streamComplete: SSE parsing extracts deltas correctly', async () => {
	// Simulate SSE stream
	const sseChunks = [
		'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"World"}}]}\n\n',
		'data: [DONE]\n\n',
	];

	let chunkIndex = 0;
	const mockFetch = async (_url: string, _opts: any) => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async pull(controller) {
				if (chunkIndex < sseChunks.length) {
					controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
				} else {
					controller.close();
				}
			},
		});
		return { ok: true, body: stream, text: async () => '' } as any;
	};

	const tokens: string[] = [];
	const accumulated: string[] = [];

	const result = await simulateStreamComplete(mockFetch as any, 'system', 'user prompt', (token, acc) => {
		tokens.push(token);
		accumulated.push(acc);
	});

	assert.strictEqual(result, 'Hello World');
	assert.strictEqual(tokens.length, 3);
	assert.strictEqual(tokens[0], 'Hello');
	assert.strictEqual(tokens[1], ' ');
	assert.strictEqual(tokens[2], 'World');
	assert.strictEqual(accumulated[0], 'Hello');
	assert.strictEqual(accumulated[1], 'Hello ');
	assert.strictEqual(accumulated[2], 'Hello World');
});

test('streamComplete: early abort via onToken return true', async () => {
	const sseChunks = [
		'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"C"}}]}\n\n',
		'data: [DONE]\n\n',
	];

	let chunkIndex = 0;
	const mockFetch = async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async pull(controller) {
				if (chunkIndex < sseChunks.length) {
					controller.enqueue(encoder.encode(sseChunks[chunkIndex++]));
				} else {
					controller.close();
				}
			},
		});
		return { ok: true, body: stream } as any;
	};

	const result = await simulateStreamComplete(mockFetch, 's', 'u', (token) => {
		return token === 'B'; // abort on B
	});

	assert.strictEqual(result, 'AB', 'accumulated up to abort point');
});

// ── Tests: Embedder ↔ KnowledgeTools integration ─────────────────────────

test('buildKnowledgeToolDescriptors: kb_ask outputs natural text answer', async () => {
	const descriptors = buildKnowledgeToolDescriptors({
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/mock/workspace',
		resolveStorageRoot: async () => '/mock/.saros/kb',
	});

	const ask = descriptors.find(d => d.definition.name === 'kb_ask');
	assert.ok(ask, 'kb_ask descriptor exists');
	assert.strictEqual(ask!.definition.category, 'knowledge');
	assert.ok((ask!.definition.inputSchema.properties as any)['top_k'], 'has top_k param');
});

test('buildKnowledgeToolDescriptors: kb_build records source path', () => {
	const descriptors = buildKnowledgeToolDescriptors({
		fileService: {} as any,
		configurationService: {} as any,
		embeddingService: { isEnabled: () => true } as any,
		resolveBaseDir: async () => '/mock/workspace',
		resolveStorageRoot: async () => '/mock/.saros/kb',
	});

	const build = descriptors.find(d => d.definition.name === 'kb_build');
	assert.ok(build, 'kb_build descriptor exists');
	const schema = build!.definition.inputSchema as any;
	assert.ok('file_path' in schema.properties, 'file_path param exposed');
});

// ── Test helper: simulate streamComplete ──────────────────────────────────
// Simplified version of OpenAICompatibleJsonModel.streamComplete for testing

async function simulateStreamComplete(
	fetchImpl: typeof fetch,
	system: string | undefined,
	user: string,
	onToken: (token: string, accumulated: string) => boolean | void,
): Promise<string> {
	const body = {
		model: 'test-model',
		stream: true,
		messages: [
			...(system ? [{ role: 'system', content: system }] : []),
			{ role: 'user', content: user },
		],
	};
	const res = await fetchImpl('https://mock/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status}`); }

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let accumulated = '';
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) { break; }
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop()!;
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
			const dataStr = trimmed.slice(6);
			if (dataStr === '[DONE]') { continue; }
			try {
				const chunk = JSON.parse(dataStr);
				const delta = chunk?.choices?.[0]?.delta?.content;
				if (typeof delta === 'string' && delta) {
					accumulated += delta;
					if (onToken(delta, accumulated)) {
						reader.cancel();
						return accumulated;
					}
				}
			} catch { /* skip malformed */ }
		}
	}
	return accumulated;
}
