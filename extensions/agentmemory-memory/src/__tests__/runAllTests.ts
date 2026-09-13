/*---------------------------------------------------------------------------------------------
 *  测试入口 — 运行所有单元测试。
 *  编译后: node out/__tests__/runAllTests.js
 *--------------------------------------------------------------------------------------------*/
import { runBM25Tests } from './bm25Index.test.js';
import { runPrivacyFilterTests } from './privacyFilter.test.js';
import { runVectorTests } from './vectorIndex.test.js';
import { runVectorDimensionTests } from './vectorIndexDim.test.js';
import { runAmV2Tests } from './amV2.test.js';
import { runAmV2IntegrationTests } from './amV2Integration.test.js';
import { runAmReplicationTests } from './amReplication.test.js';
import { printSummary, drainAsync } from './testRunner.js';

async function main(): Promise<void> {
	console.log('🧪 AgentMemory Unit Tests\n');

	// ─── Independent module tests (still used by V2) ───
	// P2-10：dedup/rrf/sentinel 测试已随影子模块移入 _unused/
	console.log('📦 Core Module Tests\n');
	runBM25Tests();
	runPrivacyFilterTests();
	runVectorTests();
	runVectorDimensionTests();

	// ─── V2 stateless function architecture ───
	console.log('\n📦 V2 Architecture Tests\n');
	await runAmV2Tests();

	// ─── amReplication tests ───
	console.log('\n📦 amReplication (原版机制复刻) Tests\n');
	await runAmReplicationTests();

	// ─── V2 Integration Tests (lifecycle call timing) ───
	console.log('\n📦 V2 Integration Tests\n');
	await runAmV2IntegrationTests();

	// 先等待所有 async it 落定（vectorIndex/bm25 等含异步用例，
	// 不等待会以 unhandledRejection 随机爆进程且结果不计入统计）。
	await drainAsync();
	printSummary();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
