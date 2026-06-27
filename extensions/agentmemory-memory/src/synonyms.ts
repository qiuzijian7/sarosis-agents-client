/*---------------------------------------------------------------------------------------------
 *  同义词扩展 — BM25 关键词检索的同义词匹配。
 *  1:1 复刻 agentmemory src/state/synonyms.ts
 *
 *  查询 "auth" 时自动扩展为 "authentication" / "authn" / "authenticating"，
 *  提升召回率。所有同义词经 Porter 词干化后建立双向映射。
 *--------------------------------------------------------------------------------------------*/

import { stem } from './stemmer.js';

const SYNONYM_GROUPS: string[][] = [
	["auth", "authentication", "authn", "authenticating"],
	["authz", "authorization", "authorizing"],
	["db", "database", "datastore"],
	["perf", "performance", "latency", "throughput", "slow", "bottleneck"],
	["optim", "optimization", "optimizing", "optimise", "query-optimization"],
	["k8s", "kubernetes", "kube"],
	["config", "configuration", "configuring", "setup"],
	["deps", "dependencies", "dependency"],
	["env", "environment"],
	["fn", "function"],
	["impl", "implementation", "implementing"],
	["msg", "message", "messaging"],
	["repo", "repository"],
	["req", "request"],
	["res", "response"],
	["ts", "typescript"],
	["js", "javascript"],
	["pg", "postgres", "postgresql"],
	["err", "error", "errors"],
	["api", "endpoint", "endpoints"],
	["ci", "continuous-integration"],
	["cd", "continuous-deployment"],
	["test", "testing", "tests"],
	["doc", "documentation", "docs"],
	["infra", "infrastructure"],
	["deploy", "deployment", "deploying"],
	["cache", "caching", "cached"],
	["log", "logging", "logs"],
	["monitor", "monitoring"],
	["observe", "observability"],
	["sec", "security", "secure"],
	["validate", "validation", "validating"],
	["migrate", "migration", "migrations"],
	["debug", "debugging"],
	["container", "containerization", "docker"],
	["crash", "crashloop", "crashloopbackoff"],
	["webhook", "webhooks", "callback"],
	["middleware", "mw"],
	["paginate", "pagination"],
	["serialize", "serialization"],
	["encrypt", "encryption"],
	["hash", "hashing"],
	["memory", "memories", "memorize", "remember", "recall"],
	["context", "contextual", "background"],
	["prompt", "instruction", "directive"],
	["model", "llm", "gpt", "claude", "gemini"],
	["tool", "function", "capability"],
	["session", "conversation", "dialogue", "chat"],
	["agent", "assistant", "bot", "ai"],
];

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

/**
 * 获取词干化术语的所有同义词（已词干化）
 */
export function getSynonyms(stemmedTerm: string): string[] {
	const syns = synonymMap.get(stemmedTerm);
	return syns ? [...syns] : [];
}

/**
 * 扩展查询词列表 — 为每个词追加其同义词
 */
export function expandQueryTerms(terms: string[]): string[] {
	const expanded = new Set<string>();
	for (const term of terms) {
		expanded.add(term);
		for (const syn of getSynonyms(term)) {
			expanded.add(syn);
		}
	}
	return [...expanded];
}

/**
 * 注册自定义同义词组（运行时扩展）
 */
export function addSynonymGroup(words: string[]): void {
	const stemmed = words.map(t => stem(t.toLowerCase()));
	for (const s of stemmed) {
		if (!synonymMap.has(s)) synonymMap.set(s, new Set());
		for (const other of stemmed) {
			if (other !== s) synonymMap.get(s)!.add(other);
		}
	}
}

/**
 * 获取同义词表大小（调试用）
 */
export function getSynonymMapSize(): number {
	return synonymMap.size;
}
