/*---------------------------------------------------------------------------------------------
 *  查询扩展 — 同义词扩展 + 实体提取 + 重述生成。
 *  1:1 复刻 agentmemory src/functions/query-expansion.ts + state/synonyms.ts
 *
 *  将原始查询扩展为多个子查询，提高召回率。
 *  同义词组使用 Porter 词干化匹配（stem 后比较）。
 *--------------------------------------------------------------------------------------------*/

import { stem } from './stemmer.js';

export interface QueryExpansionResult {
	original: string;
	reformulations: string[];
	entityExtractions: string[];
}

// ─── Synonym groups (46 groups, 1:1 from agentmemory state/synonyms.ts) ────

const SYNONYM_GROUPS: string[][] = [
	['auth', 'authentication', 'authn', 'authenticating'],
	['authz', 'authorization', 'authorizing'],
	['db', 'database', 'datastore'],
	['perf', 'performance', 'latency', 'throughput', 'slow', 'bottleneck'],
	['optim', 'optimization', 'optimizing', 'optimise', 'query-optimization'],
	['k8s', 'kubernetes', 'kube'],
	['config', 'configuration', 'configuring', 'setup'],
	['deps', 'dependencies', 'dependency'],
	['env', 'environment'],
	['fn', 'function'],
	['impl', 'implementation', 'implementing'],
	['msg', 'message', 'messaging'],
	['repo', 'repository'],
	['req', 'request'],
	['res', 'response'],
	['ts', 'typescript'],
	['js', 'javascript'],
	['pg', 'postgres', 'postgresql'],
	['err', 'error', 'errors'],
	['api', 'endpoint', 'endpoints'],
	['ci', 'continuous-integration'],
	['cd', 'continuous-deployment'],
	['test', 'testing', 'tests'],
	['doc', 'documentation', 'docs'],
	['infra', 'infrastructure'],
	['deploy', 'deployment', 'deploying'],
	['cache', 'caching', 'cached'],
	['log', 'logging', 'logs'],
	['monitor', 'monitoring'],
	['observe', 'observability'],
	['sec', 'security', 'secure'],
	['validate', 'validation', 'validating'],
	['migrate', 'migration', 'migrations'],
	['debug', 'debugging'],
	['container', 'containerization', 'docker'],
	['crash', 'crashloop', 'crashloopbackoff'],
	['webhook', 'webhooks', 'callback'],
	['middleware', 'mw'],
	['paginate', 'pagination'],
	['serialize', 'serialization'],
	['encrypt', 'encryption'],
	['hash', 'hashing'],
	// Additional groups beyond agentmemory (domain-specific)
	['refactor', 'refactoring', 'cleanup', 'restructure'],
	['async', 'asynchronous', 'promise', 'callback', 'await'],
	['component', 'widget', 'view', 'ui', 'element'],
	['hook', 'lifecycle', 'effect', 'event'],
];

// Build stemmed synonym map: stemmedTerm → Set of stemmed synonyms
const synonymMap = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
	const stemmed = group.map(t => stem(t.toLowerCase()));
	for (const s of stemmed) {
		if (!synonymMap.has(s)) synonymMap.set(s, new Set());
		for (const other of stemmed) {
			if (other !== s) synonymMap.get(s)!.add(other);
		}
	}
}

/** Get synonyms for a word (stemmed matching) */
function getSynonyms(word: string): string[] {
	const stemmed = stem(word.toLowerCase());
	const syns = synonymMap.get(stemmed);
	return syns ? [...syns] : [];
}

/** Extract entity-like terms from a query */
function extractEntities(query: string): string[] {
	const entities: string[] = [];
	const seen = new Set<string>();

	// File paths
	for (const m of query.matchAll(/[\w-]+\/[\w./-]+\.\w+/g)) {
		if (!seen.has(m[0])) { seen.add(m[0]); entities.push(m[0]); }
	}

	// Tech keywords
	for (const m of query.matchAll(/\b(jwt|auth|database|cache|api|middleware|router|component|service|module|config|test|deploy|docker|redis|postgres|graphql|error|exception|retry|timeout|batch|queue|worker|pipeline)\b/gi)) {
		const lower = m[0].toLowerCase();
		if (!seen.has(lower)) { seen.add(lower); entities.push(lower); }
	}

	// Function/class names (CamelCase)
	for (const m of query.matchAll(/\b([A-Z][a-z]+[A-Z][a-z]+)\b/g)) {
		if (!seen.has(m[1])) { seen.add(m[1]); entities.push(m[1]); }
	}

	return entities;
}

/**
 * Expand a query into multiple reformulations + entity extractions.
 * This improves recall by searching for synonyms and related terms.
 */
export function expandQuery(query: string): QueryExpansionResult {
	const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
	const reformulations: string[] = [];
	const entityExtractions = extractEntities(query);

	// Build synonym-expanded queries
	for (const word of words) {
		const syns = getSynonyms(word);
		if (syns.length > 0) {
			// Replace the word with each synonym
			for (const syn of syns.slice(0, 3)) { // cap at 3 synonyms per word
				const expanded = query.replace(new RegExp(word, 'gi'), syn);
				if (expanded !== query && !reformulations.includes(expanded)) {
					reformulations.push(expanded);
				}
			}
		}
	}

	// Add entity-only query (just the extracted entities)
	if (entityExtractions.length > 0) {
		reformulations.push(entityExtractions.join(' '));
	}

	return {
		original: query,
		reformulations: reformulations.slice(0, 5), // cap to prevent explosion
		entityExtractions,
	};
}
