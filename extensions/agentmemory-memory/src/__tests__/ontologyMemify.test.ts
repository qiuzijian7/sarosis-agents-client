/*---------------------------------------------------------------------------------------------
 *  G4/G5/G13: Ontology + Memify + DiskCache 测试
 *--------------------------------------------------------------------------------------------*/
import { OntologyConfig, DEFAULT_SOFTWARE_ONTOLOGY, buildOntologyPrompt, MemifyPipeline, type MemifyGraph } from '../ontology.js';
import { DiskCacheAdapter } from '../diskCache.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

// --- Mock KV Store for DiskCache tests ---
class MockKV {
	private store = new Map<string, Map<string, string>>();
	async get(scope: string, key: string): Promise<string | null> {
		return this.store.get(scope)?.get(key) ?? null;
	}
	async set(scope: string, key: string, value: string): Promise<void> {
		if (!this.store.has(scope)) this.store.set(scope, new Map());
		this.store.get(scope)!.set(key, value);
	}
	async delete(scope: string, key: string): Promise<void> {
		this.store.get(scope)?.delete(key);
	}
	async list(scope: string): Promise<Array<{ key: string; value: string }>> {
		const m = this.store.get(scope);
		if (!m) return [];
		return Array.from(m.entries()).map(([key, value]) => ({ key, value }));
	}
}

export function runOntologyMemifyTests(): void {
	describe('Ontology (G4)', () => {
		it('DEFAULT_SOFTWARE_ONTOLOGY has entities and relations', () => {
			assert(DEFAULT_SOFTWARE_ONTOLOGY.entities.length >= 5, 'has >= 5 entities');
			assert(DEFAULT_SOFTWARE_ONTOLOGY.relations.length >= 3, 'has >= 3 relations');
		});

		it('buildOntologyPrompt generates LLM prompt', () => {
			const prompt = buildOntologyPrompt(DEFAULT_SOFTWARE_ONTOLOGY);
			assert(prompt.includes('Entity Types'), 'has entity types section');
			assert(prompt.includes('Relationship Types'), 'has relation types section');
			assert(prompt.includes('Project'), 'includes Project entity');
			assert(prompt.includes('depends_on'), 'includes depends_on relation');
			assert(prompt.includes('<entities>'), 'has XML template');
		});

		it('custom ontology generates tailored prompt', () => {
			const custom: OntologyConfig = {
				name: 'Test',
				entities: [{ type: 'Widget', properties: ['id', 'color'] }],
				relations: [{ type: 'contains', sourceType: 'Widget', targetType: 'Widget' }],
			};
			const prompt = buildOntologyPrompt(custom);
			assert(prompt.includes('Widget'), 'includes Widget');
			assert(prompt.includes('contains'), 'includes contains relation');
			assert(prompt.includes('color'), 'includes color property');
		});
	});

	describe('MemifyPipeline (G5)', () => {
		it('dedup pass removes duplicate entities', async () => {
			const pipeline = new MemifyPipeline();
			const graph: MemifyGraph = {
				entities: [
					{ id: 'e1', type: 'Project', name: 'MyApp', properties: {} },
					{ id: 'e2', type: 'Project', name: 'myapp', properties: {} }, // same type+name (case-insensitive)
					{ id: 'e3', type: 'Tool', name: 'Webpack', properties: {} },
				],
				relations: [
					{ id: 'r1', type: 'uses', source: 'e1', target: 'e3' },
					{ id: 'r2', type: 'uses', source: 'e2', target: 'e3' }, // e2 will be removed
				],
			};
			const result = await pipeline.memify(graph);
			assert(result.graph.entities.length === 2, `expected 2 entities, got ${result.graph.entities.length}`);
			const dedupPass = result.passes.find(p => p.name === 'dedup');
			assert(dedupPass !== undefined, 'dedup pass exists');
			assert(dedupPass!.changes === 1, 'removed 1 duplicate');
		});

		it('merge pass combines properties from duplicates', async () => {
			const pipeline = new MemifyPipeline();
			const graph: MemifyGraph = {
				entities: [
					{ id: 'e1', type: 'Project', name: 'App', properties: { lang: 'TS' } },
					{ id: 'e2', type: 'Project', name: 'app', properties: { version: '2.0' } },
				],
				relations: [],
			};
			const result = await pipeline.memify(graph);
			const merged = result.graph.entities[0];
			assert(merged.properties['lang'] === 'TS', 'has lang property');
			assert(merged.properties['version'] === '2.0', 'has version property (merged)');
		});

		it('refine pass removes self-referencing relations', async () => {
			const pipeline = new MemifyPipeline();
			const graph: MemifyGraph = {
				entities: [
					{ id: 'e1', type: 'Module', name: 'A', properties: {} },
				],
				relations: [
					{ id: 'r1', type: 'depends_on', source: 'e1', target: 'e1' }, // self-ref
					{ id: 'r2', type: 'depends_on', source: 'e1', target: 'e1' }, // duplicate
				],
			};
			const result = await pipeline.memify(graph);
			assertEqual(result.graph.relations.length, 0, 'self-refs and dups removed');
		});

		it('infer pass adds transitive relations', async () => {
			const pipeline = new MemifyPipeline();
			const graph: MemifyGraph = {
				entities: [
					{ id: 'a', type: 'Module', name: 'A', properties: {} },
					{ id: 'b', type: 'Module', name: 'B', properties: {} },
					{ id: 'c', type: 'Module', name: 'C', properties: {} },
				],
				relations: [
					{ id: 'r1', type: 'depends_on', source: 'a', target: 'b' },
					{ id: 'r2', type: 'depends_on', source: 'b', target: 'c' },
				],
			};
			const result = await pipeline.memify(graph);
			// Should infer a → c
			const hasInferred = result.graph.relations.some(r => r.source === 'a' && r.target === 'c' && r.type === 'depends_on');
			assert(hasInferred, 'transitive relation a→c inferred');
			const inferPass = result.passes.find(p => p.name === 'infer');
			assert(inferPass !== undefined && inferPass.changes >= 1, 'infer pass added >= 1 relation');
		});

		it('full pipeline returns all 4 passes', async () => {
			const pipeline = new MemifyPipeline();
			const result = await pipeline.memify({ entities: [], relations: [] });
			assertEqual(result.passes.length, 4, '4 passes executed');
			assertEqual(result.passes[0].name, 'dedup', 'first pass is dedup');
			assertEqual(result.passes[1].name, 'merge', 'second pass is merge');
			assertEqual(result.passes[2].name, 'refine', 'third pass is refine');
			assertEqual(result.passes[3].name, 'infer', 'fourth pass is infer');
		});
	});

	describe('DiskCacheAdapter (G13)', () => {
		it('set and get from memory cache', async () => {
			const kv = new MockKV();
			const cache = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache.set('key1', 'value1');
			const val = await cache.get('key1');
			assertEqual(val, 'value1', 'value retrieved from memory');
			await cache.dispose();
		});

		it('falls back to SQLite on memory miss', async () => {
			const kv = new MockKV();
			const cache1 = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache1.set('key1', 'persisted_value');
			await cache1.flush(); // write to SQLite
			await cache1.dispose();

			// New cache instance — memory is empty, should find in SQLite
			const cache2 = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			const val = await cache2.get('key1');
			assertEqual(val, 'persisted_value', 'value recovered from SQLite');
			await cache2.dispose();
		});

		it('expired entries are not returned', async () => {
			const kv = new MockKV();
			const cache = new DiskCacheAdapter<string>(kv as any, 'test_cache', 1); // 1ms TTL
			await cache.set('key1', 'short_lived');
			await new Promise(r => setTimeout(r, 10)); // wait for expiry
			const val = await cache.get('key1');
			assertEqual(val, undefined, 'expired entry not returned');
			await cache.dispose();
		});

		it('clear removes all entries', async () => {
			const kv = new MockKV();
			const cache = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache.set('k1', 'v1');
			await cache.set('k2', 'v2');
			await cache.clear();
			assertEqual(await cache.get('k1'), undefined, 'k1 cleared');
			assertEqual(await cache.get('k2'), undefined, 'k2 cleared');
			await cache.dispose();
		});

		it('getStats reports memory and dirty counts', async () => {
			const kv = new MockKV();
			const cache = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache.set('k1', 'v1');
			await cache.set('k2', 'v2');
			const stats = cache.getStats();
			assertEqual(stats.memorySize, 2, '2 in memory');
			assertEqual(stats.dirtySize, 2, '2 dirty');
			await cache.dispose();
		});

		it('restore loads from SQLite into memory', async () => {
			const kv = new MockKV();
			const cache1 = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache1.set('key1', 'restored_value');
			await cache1.flush();
			await cache1.dispose();

			const cache2 = new DiskCacheAdapter<string>(kv as any, 'test_cache', 60000);
			await cache2.restore();
			const stats = cache2.getStats();
			assert(stats.memorySize >= 1, `memory restored, got ${stats.memorySize}`);
			await cache2.dispose();
		});
	});
}
