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
import { runMemoryTypesTests } from './memoryTypes.test.js';
import { runSkillExtractTests } from './skillExtract.test.js';
import { runConsolidationTests } from './consolidation.test.js';
import { runVectorDimensionTests } from './vectorIndexDim.test.js';
import { runLessonsTests } from './lessons.test.js';
import { runContextBuilderTests } from './contextBuilder.test.js';
import { runRetentionScoringTests } from './retentionScoring.test.js';
import { runProjectProfileTests } from './projectProfile.test.js';
import { runSlotEditingTests } from './slotEditing.test.js';
import { runRoutineAndInsightTests } from './insights.test.js';
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

	// ─── New tests for recent modifications ───
	console.log('\n📦 Recent Feature Tests\n');
	runMemoryTypesTests();
	runVectorDimensionTests();
	runLessonsTests();

	await runSkillExtractTests();
	runConsolidationTests();
	// ConsolidationPipeline uses itAsync — wait for async tests to complete
	await new Promise(r => setTimeout(r, 500));

	runContextBuilderTests();

	// ─── Q1/Q2/Q3/Q4/Q6: agentmemory feature alignment tests ───
	console.log('\n📦 AgentMemory Feature Alignment Tests\n');
	runRetentionScoringTests();
	runProjectProfileTests();
	runSlotEditingTests();
	runRoutineAndInsightTests();

	printSummary();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});
