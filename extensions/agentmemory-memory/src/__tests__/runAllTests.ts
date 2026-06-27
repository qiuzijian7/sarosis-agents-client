/*---------------------------------------------------------------------------------------------
 *  测试入口 — 运行所有单元测试。
 *  编译后: node out/__tests__/runAllTests.js
 *--------------------------------------------------------------------------------------------*/
import { runBM25Tests } from './bm25Index.test.js';
import { runPrivacyFilterTests } from './privacyFilter.test.js';
import { runDedupTests } from './dedup.test.js';
import { runRRFTests } from './rrf.test.js';
import { runVectorTests } from './vectorIndex.test.js';
import { runConcurrencyTests } from './concurrency.test.js';
import { printSummary } from './testRunner.js';

async function main(): Promise<void> {
	console.log('🧪 AgentMemory Unit Tests\n');

	runBM25Tests();
	runPrivacyFilterTests();

	// async tests need special handling
	await runDedupTests();
	await new Promise(r => setTimeout(r, 150)); // wait for dedup timer tests

	runRRFTests();
	runVectorTests();

	// Concurrency tests (async)
	await runConcurrencyTests();

	printSummary();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
