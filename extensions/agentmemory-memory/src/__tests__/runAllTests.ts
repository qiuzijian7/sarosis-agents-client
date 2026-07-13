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
import { runVectorDimensionTests } from './vectorIndexDim.test.js';
import { runAmV2Tests } from './amV2.test.js';
import { runAmV2IntegrationTests } from './amV2Integration.test.js';
import { printSummary } from './testRunner.js';

async function main(): Promise<void> {
	console.log('🧪 AgentMemory Unit Tests\n');

	// ─── Independent module tests (still used by V2) ───
	console.log('📦 Core Module Tests\n');
	runBM25Tests();
	runPrivacyFilterTests();
	await runDedupTests();
	await new Promise(r => setTimeout(r, 150)); // wait for dedup timer tests
	runRRFTests();
	runVectorTests();
	runVectorDimensionTests();
	await runConcurrencyTests();

	// ─── V2 stateless function architecture ───
	console.log('\n📦 V2 Architecture Tests\n');
	await runAmV2Tests();

	// ─── V2 Integration Tests (lifecycle call timing) ───
	console.log('\n📦 V2 Integration Tests\n');
	await runAmV2IntegrationTests();

	printSummary();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
