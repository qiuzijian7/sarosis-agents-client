/**
 * Cold-start & index cache analyzer — parses the gateway log (JSON Lines)
 * and reports:
 *   - cold-start count & duration (SQLite ready → KV store ready on port)
 *   - index cache hit/miss (index cache loaded vs stale)
 *   - index cache save count & duration (index cache saved in Xms)
 *   - Worker incremental build duration (Worker 增量构建完成 in Xms)
 *   - provider writeMemory call count & estimated rate
 *
 * Env knobs:
 *   AGENTMEMORY_GATEWAY_LOG   path to gateway.log (default: ~/.vssaros-dev/.agentmemory/gateway.log)
 *   AGENTMEMORY_LOG_TAIL      analyze only the last N lines (default: all)
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LogEntry {
	kind: string;
	msg: string;
	ts: string;
	port?: number;
	dataDir?: string;
}

interface ColdStart {
	sqliteReadyTs: Date;
	kvReadyTs: Date;
	durationMs: number;
	port: number;
}

interface CacheSave {
	ts: Date;
	durationMs: number;
	bm25Docs: number;
	vectorDocs: number;
	mode: string;
}

interface WorkerBuild {
	ts: Date;
	durationMs: number;
	docs: number;
}

interface Stats {
	coldStarts: ColdStart[];
	cacheLoaded: number;
	cacheStale: number;
	cacheSaves: CacheSave[];
	workerBuilds: WorkerBuild[];
	writeMemoryCalls: number;
	firstWriteTs: Date | null;
	lastWriteTs: Date | null;
}

function parseLog(logPath: string, tailLines?: number): Stats {
	if (!existsSync(logPath)) {
		throw new Error(`gateway log not found: ${logPath}`);
	}
	const content = readFileSync(logPath, "utf8");
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	const toParse = tailLines ? lines.slice(-tailLines) : lines;

	const stats: Stats = {
		coldStarts: [],
		cacheLoaded: 0,
		cacheStale: 0,
		cacheSaves: [],
		workerBuilds: [],
		writeMemoryCalls: 0,
		firstWriteTs: null,
		lastWriteTs: null,
	};

	let pendingSqliteReady: Date | null = null;

	for (const line of toParse) {
		let entry: LogEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // skip non-JSON lines
		}
		const ts = new Date(entry.ts);
		const msg = entry.msg;

		// Cold start: SQLite ready → KV store ready on port
		if (msg.includes("SQLite KV store ready")) {
			pendingSqliteReady = ts;
		} else if (msg.includes("KV store ready on port") && pendingSqliteReady) {
			stats.coldStarts.push({
				sqliteReadyTs: pendingSqliteReady,
				kvReadyTs: ts,
				durationMs: ts.getTime() - pendingSqliteReady.getTime(),
				port: entry.port ?? 0,
			});
			pendingSqliteReady = null;
		}

		// Index cache hit/miss
		if (msg.includes("index cache loaded")) {
			stats.cacheLoaded++;
		} else if (msg.includes("index cache stale")) {
			stats.cacheStale++;
		}

		// Index cache save
		const saveMatch = msg.match(/index cache saved.*in (\d+)ms.*bm25=(\d+) doc.*vector=(\d+) doc.*mode=(\w+)/);
		if (saveMatch) {
			stats.cacheSaves.push({
				ts,
				durationMs: parseInt(saveMatch[1]!, 10),
				bm25Docs: parseInt(saveMatch[2]!, 10),
				vectorDocs: parseInt(saveMatch[3]!, 10),
				mode: saveMatch[4]!,
			});
		}

		// Worker incremental build
		const workerMatch = msg.match(/Worker.*增量构建完成.*(\d+)ms.*(\d+) doc/);
		if (workerMatch) {
			stats.workerBuilds.push({
				ts,
				durationMs: parseInt(workerMatch[1]!, 10),
				docs: parseInt(workerMatch[2]!, 10),
			});
		}

		// provider writeMemory calls
		if (msg.includes("[provider] writeMemory")) {
			stats.writeMemoryCalls++;
			if (!stats.firstWriteTs) stats.firstWriteTs = ts;
			stats.lastWriteTs = ts;
		}
	}

	return stats;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function printStats(stats: Stats): void {
	console.log("\n=== Cold Start ===");
	if (stats.coldStarts.length === 0) {
		console.log("  (no cold starts found)");
	} else {
		console.log(`  count: ${stats.coldStarts.length}`);
		const durations = stats.coldStarts.map((c) => c.durationMs);
		const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
		const min = Math.min(...durations);
		const max = Math.max(...durations);
		console.log(`  duration: avg=${formatDuration(avg)} min=${formatDuration(min)} max=${formatDuration(max)}`);
		console.log(`  ports: ${[...new Set(stats.coldStarts.map((c) => c.port))].join(", ")}`);
	}

	console.log("\n=== Index Cache ===");
	console.log(`  loaded (hit): ${stats.cacheLoaded}`);
	console.log(`  stale (miss): ${stats.cacheStale}`);
	const total = stats.cacheLoaded + stats.cacheStale;
	if (total > 0) {
		const hitRate = ((stats.cacheLoaded / total) * 100).toFixed(1);
		console.log(`  hit rate: ${hitRate}%`);
	}

	console.log("\n=== Index Cache Saves ===");
	if (stats.cacheSaves.length === 0) {
		console.log("  (no saves found)");
	} else {
		console.log(`  count: ${stats.cacheSaves.length}`);
		const durations = stats.cacheSaves.map((s) => s.durationMs);
		const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
		const min = Math.min(...durations);
		const max = Math.max(...durations);
		console.log(`  duration: avg=${formatDuration(avg)} min=${formatDuration(min)} max=${formatDuration(max)}`);
		const lastSave = stats.cacheSaves[stats.cacheSaves.length - 1]!;
		console.log(`  last save: bm25=${lastSave.bm25Docs} docs, vector=${lastSave.vectorDocs} docs, mode=${lastSave.mode}`);
	}

	console.log("\n=== Worker Incremental Builds ===");
	if (stats.workerBuilds.length === 0) {
		console.log("  (no worker builds found)");
	} else {
		console.log(`  count: ${stats.workerBuilds.length}`);
		const durations = stats.workerBuilds.map((b) => b.durationMs);
		const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
		const min = Math.min(...durations);
		const max = Math.max(...durations);
		console.log(`  duration: avg=${formatDuration(avg)} min=${formatDuration(min)} max=${formatDuration(max)}`);
	}

	console.log("\n=== Provider writeMemory Calls ===");
	console.log(`  count: ${stats.writeMemoryCalls}`);
	if (stats.firstWriteTs && stats.lastWriteTs) {
		const spanMs = stats.lastWriteTs.getTime() - stats.firstWriteTs.getTime();
		const rate = spanMs > 0 ? (stats.writeMemoryCalls / (spanMs / 1000)).toFixed(1) : "N/A";
		console.log(`  time span: ${formatDuration(spanMs)}`);
		console.log(`  rate: ${rate} calls/sec`);
	}
}

function main(): void {
	const logPath =
		process.env["AGENTMEMORY_GATEWAY_LOG"] ||
		join(homedir(), ".vssaros-dev", ".agentmemory", "gateway.log");
	const tailLines = process.env["AGENTMEMORY_LOG_TAIL"]
		? parseInt(process.env["AGENTMEMORY_LOG_TAIL"], 10)
		: undefined;

	console.log(`[cold-start] analyzing ${logPath}`);
	if (tailLines) {
		console.log(`[cold-start] tail: last ${tailLines} lines`);
	}

	const stats = parseLog(logPath, tailLines);
	printStats(stats);
}

main();
