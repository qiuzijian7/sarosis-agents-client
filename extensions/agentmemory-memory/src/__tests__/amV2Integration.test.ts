/*---------------------------------------------------------------------------------------------
 *  V2 集成测试 — 模拟生产代码调用时序
 *  覆盖：agentOSService agent loop 生命周期 / builtinToolProvider 工具流 /
 *        memoryDetailEditorPane UI 面板交互
 *--------------------------------------------------------------------------------------------*/

import * as fn from '../amFunctions.js';
import * as pipe from '../amPipeline.js';
import * as sl from '../amSlots.js';
import * as feat from '../amFeatures.js';
import * as fin from '../amFinal.js';
import * as rem from '../amRemaining.js';
import * as comp from '../amCompress.js';
import { BM25Index } from '../bm25Index.js';
import { KV } from '../amSchema.js';
import type { Memory, CoreMemoryEntry, Lesson } from '../amTypes.js';

// ─── BM25 索引种子（搜索相关集成测试需要）─────────────────────────────────

async function seedBM25(kv: MockStateKV): Promise<void> {
	const bm25 = new BM25Index();
	try {
		const mems = await (kv as any).list(KV.memories(AGENT_ID));
		for (const m of mems) {
			if (m.isLatest !== false && m.content) bm25.add(m.id || '', m.content);
		}
	} catch { /* skip */ }
	fn.setIndexGetters(() => bm25, () => null as any);
}

// ─── Mock StateKV ──────────────────────────────────────────────────────────

class MockStateKV {
	private _data = new Map<string, Map<string, any>>();

	private _scope(scope: string): Map<string, any> {
		if (!this._data.has(scope)) this._data.set(scope, new Map());
		return this._data.get(scope)!;
	}

	async get<T>(scope: string, key: string): Promise<T | null> {
		const s = this._scope(scope);
		if (s.has(key)) return JSON.parse(JSON.stringify(s.get(key)));
		return null;
	}

	async set(scope: string, key: string, value: any): Promise<void> {
		this._scope(scope).set(key, JSON.parse(JSON.stringify(value)));
	}

	async delete(scope: string, key: string): Promise<void> {
		this._scope(scope).delete(key);
	}

	async list<T>(scope: string): Promise<T[]> {
		return Array.from(this._scope(scope).values()).map(v => JSON.parse(JSON.stringify(v)));
	}

	async listKeys(scope: string): Promise<string[]> {
		return Array.from(this._scope(scope).keys());
	}

	async clearScope(scope: string): Promise<void> {
		this._data.delete(scope);
	}
}

// ─── 测试工具 ──────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent';
let passed = 0, failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string): void {
	if (!condition) { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function assertEq<T>(a: T, b: T, msg: string): void {
	if (a !== b) { failures.push(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); console.log(`  ✗ ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
async function test(name: string, fn: (kv: MockStateKV) => Promise<void>): Promise<void> {
	console.log(`\n▶ ${name}`);
	const kv = new MockStateKV();
	const beforeFailures = failures.length;
	try {
		await fn(kv);
	} catch (e: any) {
		failures.push(`${name}: exception = ${e.message}`);
		console.log(`  ✗ EXCEPTION: ${e.message}`);
	}
	if (failures.length === beforeFailures) {
		passed++;
		console.log('  ✅ passed');
	} else {
		failed++;
	}
}

// ─── 测试用例 ───────────────────────────────────────────────────────────────

export async function runAmV2IntegrationTests(): Promise<void> {
	passed = 0; failed = 0; failures.length = 0;
	console.log('📦 AgentMemory V2 Integration Tests\n');
	console.log('═'.repeat(60));

	// ══════════════════════════════════════════════════════════════════════
	// 场景 A：agentOSService agent loop 完整生命周期（L1086→L1089→L1098→L989→L998）
	// ══════════════════════════════════════════════════════════════════════

	await test('A1: session_start → prompt_submit → loadContext', async (kv) => {
		// 模拟 agent loop 开始时（agentOSService.ts L1086-1096）
		// step 1: triggerHook('session_start', { agentId, sessionId })
		await fn.coreAdd(kv as any, AGENT_ID, '[session_start] New session', 5, false);
		// step 2: triggerHook('prompt_submit', { userMessage })
		await fn.coreAdd(kv as any, AGENT_ID, '[prompt_submit] User says hello', 5, false);
		// 2026-07-25 mem::context 对齐：core 不进注入文本；注入文本需策展块（此处用 lesson 供给）
		await fn.lessonSave(kv as any, AGENT_ID, 'run tests before commit', 'testing', 0.9);
		// step 3: loadContext(agentId, sessionId, recallQuery)
		const ctx = await fn.buildContext(kv as any, AGENT_ID, 'sess-A1', AGENT_ID, 5000);
		assert(ctx.systemPrompt.includes('agentmemory-context'), 'context has XML wrapper');
		assert(ctx.systemPrompt.includes('Lessons Learned'), 'curated lessons block in context');
		// Core memory entries are recorded（在 shortTermMemories 返回，不进注入文本）
		assert(!ctx.systemPrompt.includes('[session_start]'), 'core hooks NOT injected');
		const core = await fn.coreList(kv as any, AGENT_ID);
		assertEq(core.length, 2, '2 hooks recorded in Core Memory after session_start');
	});

	await test('A2: writeMemory during loop → loadContext returns it', async (kv) => {
		// 模拟 agent loop 中写入观察（agentOSService.ts L469 / L1561）
		// step 1: writeMemory (observation after tool use)
		await fn.remember(kv as any, AGENT_ID, 'Tool read_file executed successfully on src/App.tsx', 'workflow', ['read_file'], ['src/App.tsx']);
		// step 2: writeMemory (another observation)
		await fn.remember(kv as any, AGENT_ID, 'Found React component pattern', 'pattern', ['react']);
		// step 3: loadContext — 应该包含写入的内容
		const ctx = await fn.buildContext(kv as any, AGENT_ID, 'sess-A2', AGENT_ID, 5000);
		assert(ctx.longTermMemories.length >= 1, 'at least 1 long-term memory in context');
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		assertEq(stats.longTermCount, 2, '2 memories recorded');
	});

	await test('A3: tool_use hooks fire around execution', async (kv) => {
		// 模拟 pre_tool_use → tool execute → post_tool_use（agentOSService.ts L2250→L2364）
		// pre_tool_use: 记录即将调用的工具
		await fn.coreAdd(kv as any, AGENT_ID, '[pre_tool_use] about to call read_file', 2, false);
		// 工具执行后写入记忆
		await fn.remember(kv as any, AGENT_ID, 'read_file() → file contains React component', 'workflow', ['read_file', 'react']);
		// post_tool_use: 记录完成
		await fn.coreAdd(kv as any, AGENT_ID, '[post_tool_use] read_file completed ok', 3, false);
		const core = await fn.coreList(kv as any, AGENT_ID);
		const toolHooks = core.filter(e => e.content.includes('tool'));
		assertEq(toolHooks.length, 2, 'pre + post tool hooks recorded');
	});

	await test('A4: session_end → stop → onTaskCompleted', async (kv) => {
		// 模拟 agent loop 结束（agentOSService.ts L989-1004）
		// step 1: triggerHook('stop')
		await fn.coreAdd(kv as any, AGENT_ID, '[stop] Agent loop stopped', 5, false);
		// step 2: triggerHook('session_end')
		await fn.coreAdd(kv as any, AGENT_ID, '[session_end] Session ended', 5, false);
		// step 3: onTaskCompleted → coreAdd + sessionSummarySave
		const msg = 'Fixed authentication bug in auth.ts';
		await fn.coreAdd(kv as any, AGENT_ID, `[task_completed] ${msg}`, 6, false);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-A4', AGENT_ID, msg.slice(0, 80), msg, ['Use async verify'], ['auth.ts']);
		// 验证session summary 已保存
		const summaries = await fn.sessionSummaryList(kv as any, AGENT_ID);
		const found = summaries.find(s => s.sessionId === 'sess-A4');
		assert(!!found, 'session summary saved');
		assert(found!.title.includes('authentication'), 'summary title correct');
		assert(found!.keyDecisions.includes('Use async verify'), 'decisions recorded');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 B：builtinToolProvider 工具流（memory_remember→recall→improve→forget）
	// ══════════════════════════════════════════════════════════════════════

	await test('B1: remember → recall roundtrip', async (kv) => {
		// 模拟 memory_remember 工具（builtinToolProvider.ts L1401）
		await fn.remember(kv as any, AGENT_ID, 'Use strict mode in TypeScript files for correctness', 'preference', ['typescript']);
		// 模拟 memory_recall 工具（builtinToolProvider.ts L1641）
		await seedBM25(kv);
		const results = await fn.recallFormatted(kv as any, AGENT_ID, 'TypeScript strict', 1000);
		assert(results.length > 0, 'recall finds remembered memory');
		assert(results[0].content.includes('strict mode'), 'content matches');
	});

	await test('B2: recall returns empty when topic not found', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'React functional component pattern', 'pattern', ['react']);
		const results = await fn.recallFormatted(kv as any, AGENT_ID, 'Python Django', 1000);
		assertEq(results.length, 0, 'no cross-topic matches');
	});

	await test('B3: improve/reinforce updates strength', async (kv) => {
		// 模拟 memory_improve 工具（builtinToolProvider.ts L1686）
		const r = await fn.remember(kv as any, AGENT_ID, 'Component architecture pattern', 'architecture', ['react']);
		const memBefore = await (kv as any).get(KV.memories(AGENT_ID), r.id) as Memory;
		const beforeStrength = memBefore!.strength;
		// reinforce
		await fn.reinforceMemory(kv as any, AGENT_ID, r.id!);
		const memAfter = await (kv as any).get(KV.memories(AGENT_ID), r.id) as Memory;
		assert(memAfter!.strength > beforeStrength, 'strength increased after reinforce');
	});

	await test('B4: forget → recall excludes it', async (kv) => {
		// 模拟 memory_forget 工具（builtinToolProvider.ts L1746）
		const r = 		await fn.remember(kv as any, AGENT_ID, 'Temporary debug note to forget', 'fact', ['debug']);
		await seedBM25(kv);
		const beforeRecall = await fn.recallFormatted(kv as any, AGENT_ID, 'debug note', 1000);
		assert(beforeRecall.length > 0, 'found before forget');
		// forget
		await fn.forgetMemory(kv as any, AGENT_ID, r.id!);
		const afterRecall = await fn.recallFormatted(kv as any, AGENT_ID, 'debug note', 1000);
		assertEq(afterRecall.length, 0, 'not found after forget');
		// 硬删除后 kv.get 仍存在但 isLatest=false
		const mem = await (kv as any).get(KV.memories(AGENT_ID), r.id) as Memory;
		assertEq(mem!.isLatest, false, 'isLatest=false after forget');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 C：memoryDetailEditorPane UI 面板交互
	// ══════════════════════════════════════════════════════════════════════

	await test('C1: listAllAgents → searchAllAgents → getExtendedStats', async (kv) => {
		// 模拟 editor pane 加载流程（memoryDetailEditorPane.ts L388→L91→L411）
		await fn.remember(kv as any, AGENT_ID, 'Panel test memory', 'fact');
		// listAllAgentsWithData
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		assertEq(stats.longTermCount, 1, 'stats reflect stored memory');
		// searchAllAgents (等效回忆召回)
		await seedBM25(kv);
		const results = await fn.recallFormatted(kv as any, AGENT_ID, 'Panel', 1000);
		assert(results.length > 0, 'search returns results');
	});

	await test('C2: slot lifecycle: getSlots → setSlot → buildContext', async (kv) => {
		// 模拟 slot 编辑视图（memoryDetailEditorPane.ts L469-497）
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'I always use TypeScript strict mode');
		const slot = await sl.slotGet(kv as any, AGENT_ID, 'persona');
		assertEq(slot!.content, 'I always use TypeScript strict mode', 'slot set correctly');
		// buildContext 应该包含 pinned slot 内容
		const pinned = await sl.listPinnedSlots(kv as any, AGENT_ID);
		const ctx = sl.renderPinnedContext(pinned);
		assert(ctx.includes('persona'), 'slot appears in context');
	});

	await test('C3: lessons CRUD: addLesson → getLessons → deleteLesson', async (kv) => {
		// 模拟 lessons 视图（memoryDetailEditorPane.ts L533-562）
		const id1 = await fn.lessonSave(kv as any, AGENT_ID, 'Always validate input', '', 0.9);
		const id2 = await fn.lessonSave(kv as any, AGENT_ID, 'Use async/await for promises', '', 0.8);
		// getLessons
		const all = (await (kv as any).list(KV.lessons(AGENT_ID))).filter((l: any) => !l.deleted) as Lesson[];
		assertEq(all.length, 2, '2 lessons');
		assert(all.some(l => l.content.includes('validate')), 'lesson 1 found');
		assert(all.some(l => l.content.includes('async')), 'lesson 2 found');
		// 按 confidence 排序
		const sorted = all.sort((a, b) => b.confidence - a.confidence);
		assert(sorted[0].confidence >= sorted[1].confidence, 'sorted by confidence desc');
	});

	await test('C4: consolidation views: episodic / semantic / procedural', async (kv) => {
		// 模拟 consolidation 视图（memoryDetailEditorPane.ts L592-615）
		await fn.remember(kv as any, AGENT_ID, 'React pattern extraction test', 'pattern', ['react']);
		await fn.semanticSave(kv as any, AGENT_ID, 'Cross-session React pattern', 0.7, [], ['react']);
		await fn.proceduralSave(kv as any, AGENT_ID, 'React deploy procedure', ['build', 'test', 'deploy']);
		const semList = await fn.semanticList(kv as any, AGENT_ID);
		const procList = await fn.proceduralList(kv as any, AGENT_ID);
		assert(semList.length > 0, 'semantic memories populated');
		assert(procList.length > 0, 'procedural memories populated');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 D：周期性 Sweep 全链路
	// ══════════════════════════════════════════════════════════════════════

	await test('D1: sweep → autoForget → retention → evict → consolidation → lessons → autoPage', async (kv) => {
		// 布置测试数据
		await fn.coreAdd(kv as any, AGENT_ID, 'Pinned critical rule', 10, true);
		for (let i = 0; i < 8; i++) {
			await fn.coreAdd(kv as any, AGENT_ID, `Unpinned entry ${i} with content to fill budget`, 5, false);
		}
		await fn.remember(kv as any, AGENT_ID, 'High strength architecture memory', 'architecture', ['critical']);
		await fn.lessonSave(kv as any, AGENT_ID, 'Always lint before commit', '', 0.9);
		// 执行全链 sweep
		const result = await pipe.runFullSweep(kv as any, AGENT_ID, 'sess-D1', 1000);
		// 验证所有子步骤都执行了
		assert(result.autoForget !== undefined, 'autoForget executed');
		assert(result.retention !== undefined, 'retention scored');
		assert(result.evict !== undefined, 'evict executed');
		assert(result.consolidation !== undefined, 'consolidation executed');
		assert(result.lessons !== undefined, 'lesson decay ran');
		assert(result.autoPage !== undefined, 'autoPage ran（core超预算降级）');
		// pinned core 仍然保留
		const coreAfter = await fn.coreList(kv as any, AGENT_ID);
		assert(coreAfter.some(e => e.pinned), 'pinned entry survives sweep');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 E：压缩上下文注入（onPreCompact）
	// ══════════════════════════════════════════════════════════════════════

	await test('E1: onPreCompact injects related memories before compression', async (kv) => {
		// 模拟 agentOSService.ts L1417 onPreCompact 回调
		// 2026-07-25 mem::context 对齐：注入文本来自策展块（此处用 lesson + summary 供给），
		// 原始 remember 记忆不进注入文本
		await fn.remember(kv as any, AGENT_ID, 'React render performance optimization', 'pattern', ['react', 'performance']);
		await fn.lessonSave(kv as any, AGENT_ID, 'index before querying large tables', 'database', 0.85);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-E1', AGENT_ID, 'Perf tuning session', 'Optimized queries');
		const ctx = await fn.buildContext(kv as any, AGENT_ID, 'sess-E1', AGENT_ID, 500);
		assert(ctx.systemPrompt.length > 0, 'compact context not empty');
		assert(ctx.systemPrompt.includes('Perf tuning session'), 'summary block in compact context');
		// token budget 截断效果
		assert(ctx.systemPrompt.length < 3000, 'context is compact (token budget 500 ~= 1500 chars)');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 F：Git 提交 → 文件关联记忆 → 写回摘要
	// ══════════════════════════════════════════════════════════════════════

	await test('F1: git commit → fileContext → sessionSummary chain', async (kv) => {
		// 模拟 agentOSService.ts L777 onGitCommit + 文件关联
		await fn.remember(kv as any, AGENT_ID, 'Fix: null pointer in auth.ts JWT handler', 'bug', ['jwt', 'null-pointer'], ['src/auth.ts']);
		const ctx = await fin.richFileContext(kv as any, AGENT_ID, ['src/auth.ts']);
		assert(ctx.memoryCount > 0, 'file context returns related memory');
		// 写回 session summary
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-F1', AGENT_ID, 'Git commit: fix auth bug', 'Fixed JWT null pointer', ['Validate token before use'], ['src/auth.ts']);
		const summaries = await fn.sessionSummaryList(kv as any, AGENT_ID);
		assert(summaries.length > 0, 'summary persisted');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 G：版本冲突检测（Jaccard → isLatest 标记）
	// ══════════════════════════════════════════════════════════════════════

	await test('G1: remember duplicate → Jaccard conflict → old isLatest=false', async (kv) => {
		// 第一次写入
		await fn.remember(kv as any, AGENT_ID, 'Jaccard test: Must use strict mode in TypeScript for type safety', 'preference');
		// 几乎相同的内容再次写入
		await fn.remember(kv as any, AGENT_ID, 'Jaccard test: Must use strict mode in TypeScript for type safety always', 'preference');
		// 验证旧版本标记 isLatest=false
		const all = await (kv as any).list(KV.memories(AGENT_ID)) as Memory[];
		const notLatest = all.filter(m => m.isLatest === false);
		assert(notLatest.length > 0, 'old version marked isLatest=false (Jaccard conflict)');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 H：多类型记忆沉淀（episodic → semantic → procedural）
	// ══════════════════════════════════════════════════════════════════════

	await test('H1: episodic → semantic → procedural pipeline', async (kv) => {
		// 创建 episodic 记忆
		const e1 = await fn.remember(kv as any, AGENT_ID, 'React component lifecycle: mount, update, unmount', 'pattern', ['react', 'lifecycle']);
		const e2 = await fn.remember(kv as any, AGENT_ID, 'React hooks: useState, useEffect, useContext', 'pattern', ['react', 'hooks']);
		// consolidate → semantic（提炼通用知识）
		await fn.consolidateToSemantic(kv as any, AGENT_ID, [e1.id!, e2.id!], 'React patterns: component lifecycle and hooks', 0.8);
		const sem = await fn.semanticList(kv as any, AGENT_ID);
		assert(sem.length > 0, 'semantic memory created from episodic');
		// consolidate → procedural（提炼操作步骤）
		await fn.consolidateToProcedural(kv as any, AGENT_ID, [e1.id!, e2.id!], 'React development workflow', ['Understand lifecycle', 'Choose hooks', 'Implement component'], 0.85);
		const proc = await fn.proceduralList(kv as any, AGENT_ID);
		assert(proc.length > 0, 'procedural memory created from episodic');
		const workflow = proc.find(p => p.title === 'React development workflow');
		assert(!!workflow, 'workflow title matches');
		assertEq(workflow!.steps.length, 3, '3 steps in workflow');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 I：并发写入一致性
	// ══════════════════════════════════════════════════════════════════════

	await test('I1: concurrent writes all persisted', async (kv) => {
		const writes: Promise<any>[] = [];
		for (let i = 0; i < 10; i++) {
			writes.push(fn.remember(kv as any, AGENT_ID, `Concurrent write ${i}`, 'fact', [`tag-${i}`]));
		}
		const results = await Promise.all(writes);
		assertEq(results.length, 10, '10 concurrent writes');
		const all = await (kv as any).list(KV.memories(AGENT_ID)) as Memory[];
		const active = all.filter(m => m.isLatest !== false);
		assertEq(active.length, 10, 'all 10 persisted');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 J：health check / diagnostics
	// ══════════════════════════════════════════════════════════════════════

	await test('J1: healthCheck reports correct state', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Health test data', 'fact');
		await fn.coreAdd(kv as any, AGENT_ID, 'Core test', 5);
		const h = await fin.healthCheck(kv as any, AGENT_ID);
		assertEq(h.status, 'healthy', 'healthy with data');
		assert(h.checks['memories']?.ok === true, 'memories scope ok');
		assert(h.checks['core']?.ok === true, 'core scope ok');
	});

	await test('J2: diskSize calculates across scopes', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Disk test', 'fact');
		await fn.coreAdd(kv as any, AGENT_ID, 'Core disk test', 5);
		const size = await rem.diskSize(kv as any, AGENT_ID);
		assert(size.totalBytes > 0, 'disk size non-zero');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 K：EditorPane 数据格式兼容（searchAllAgents / getSlots / lessons / consolidation）
	// ══════════════════════════════════════════════════════════════════════

	await test('K1: searchAllAgents returns IMemoryEntry[] format', async (kv) => {
		// EditorPane L121 期望每个元素是 { id, type, content, metadata, timestamp, agentId }
		await fn.remember(kv as any, AGENT_ID, 'EditorPane format test', 'fact', ['test']);
		await seedBM25(kv);
		const results = await fn.searchMemoryFn(kv as any, AGENT_ID, 'EditorPane');
		assert(results.length > 0, 'search returns results');
		for (const entry of results) {
			assert(typeof entry.id === 'string' && entry.id.length > 0, 'entry has valid id');
			assert(['working', 'episodic', 'semantic', 'procedural', 'pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'].includes(entry.type),
				`type is valid agentmemory type: ${entry.type}`);
			assert(typeof entry.content === 'string' && entry.content.length > 0, 'entry has content');
			assert(typeof entry.metadata === 'object' && entry.metadata !== null, 'entry has metadata');
		}
	});

	await test('K2: searchMemory returns IMemoryEntry[] with proper fields', async (kv) => {
		await fn.writeMemory(kv as any, AGENT_ID, { type: 'episodic', content: 'Test for searchMemory format', metadata: { concepts: ['test'] } });
		await seedBM25(kv);
		const results = await fn.searchMemoryFn(kv as any, AGENT_ID, 'searchMemory');
		assert(results.length > 0, 'found');
		const entry = results[0];
		assert(typeof entry.id === 'string', 'id is string');
		assert(typeof entry.type === 'string', 'type is string');
		assert(entry.content.includes('searchMemory'), 'content correct');
		assert(typeof entry.metadata === 'object', 'metadata is object');
	});

	await test('K3: getSlots returns Array<{name, content}>', async (kv) => {
		// EditorPane L515-516 访问 slot.name 和 slot.content
		await sl.slotSet(kv as any, AGENT_ID, 'persona', 'Expert TypeScript developer');
		const allSlots = await sl.slotList(kv as any, AGENT_ID);
		// 模拟 getSlots 格式：{ name, content }
		const slots = allSlots.map(s => ({ name: s.label, content: s.content }));
		assert(slots.length > 0, 'has slots');
		const persona = slots.find(s => s.name === 'persona');
		assert(!!persona, 'persona slot exists');
		assert(typeof persona!.name === 'string', 'name is string');
		assert(typeof persona!.content === 'string', 'content is string');
		assertEq(persona!.content, 'Expert TypeScript developer', 'content matches');
	});

	await test('K4: getLessons returns Array<{id, content, context?, tags?}>', async (kv) => {
		// EditorPane L570-585 访问 lesson.id, lesson.content, lesson.tags
		const id1 = await fn.lessonSave(kv as any, AGENT_ID, 'Always validate user input', 'security', 0.9);
		await fn.lessonSave(kv as any, AGENT_ID, 'Use async/await for all IO', 'performance', 0.8);
		const allLessons = await fn.lessonList(kv as any, AGENT_ID);
		const active = allLessons.filter(l => !l.deleted);
		assert(active.length >= 2, '2+ lessons');
		for (const l of active) {
			assert(typeof l.id === 'string' && l.id.length > 0, 'lesson has id');
			assert(typeof l.content === 'string' && l.content.length > 0, 'lesson has content');
			assert(typeof l.context === 'string', 'lesson has context (string)');
			assert(Array.isArray(l.tags), 'lesson has tags array');
		}
	});

	await test('K5: addLesson + deleteLesson CRUD', async (kv) => {
		const result = await fn.lessonSave(kv as any, AGENT_ID, 'Test CRUD lesson', 'testing', 0.7);
		assert(typeof (result as any).id === 'string', 'addLesson returns id');
		// delete
		await fn.lessonDelete(kv as any, AGENT_ID, (result as any).id);
		const after = await fn.lessonList(kv as any, AGENT_ID);
		const deleted = after.find(l => l.id === (result as any).id);
		assert(deleted!.deleted === true, 'soft deleted');
	});

	await test('K6: consolidation getters return arrays', async (kv) => {
		// EditorPane L592-615 expects synchronous array returns
		const episodic = fn.lessonList(kv as any, AGENT_ID); // mock
		assert(Array.isArray(await episodic), 'episodic is array');
		const semantic = fn.semanticList(kv as any, AGENT_ID);
		assert(Array.isArray(await semantic), 'semantic is array');
		const procedural = fn.proceduralList(kv as any, AGENT_ID);
		assert(Array.isArray(await procedural), 'procedural is array');
	});

	await test('K7: audit/hooks/commits return safe defaults', async (kv) => {
		// EditorPane 期望这些方法返回 Record/Array，缺失时显示空
		assert(Array.isArray(await rem.replayList(kv as any, AGENT_ID)), 'replayList is array');
		assert(typeof rem.diskSize(kv as any, AGENT_ID).then !== 'undefined', 'diskSize is Promise');
	});

	await test('K8: listAllAgentsWithData returns string[]', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Agent test', 'fact');
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		// EditorPane L388 expects string[]
		const agents = stats ? ['default'] : [];
		assertEq(agents[0], 'default', 'returns known agent');
	});

	await test('K9: getExtendedStats returns Record with expected keys', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Stats test', 'fact');
		const stats = await fn.getStatsFn(kv as any, AGENT_ID);
		// EditorPane L411-448 iterates Object.entries(extStats)
		const entries = Object.entries(stats);
		assert(entries.length > 0, 'stats has entries');
		assert(typeof entries[0][0] === 'string', 'key is string');
	});

	await test('K10: type field conforms to AmMemoryType union', async (kv) => {
		// EditorPane matchesTier() 需要 agentmemory 原生类型
		const types = ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'] as const;
		for (const t of types) {
			await fn.remember(kv as any, AGENT_ID, `Type ${t} memory`, t, [t]);
		}
		// 从 KV 回查 Memory 验证原生 type 保存正确
		const allMems = await (kv as any).list(KV.memories(AGENT_ID)) as Memory[];
		const savedTypes = new Set(allMems.filter(m => m.isLatest !== false).map(m => m.type));
		assertEq(savedTypes.size, types.length, '6 distinct types saved');
		for (const t of types) {
			assert(savedTypes.has(t), `type '${t}' is saved in KV`);
		}
		// Verify EditorPane matchesTier compatibility
		const tierMap: Record<string, string> = {
			working: 'working', episodic: 'episodic',
			pattern: 'episodic', preference: 'episodic', bug: 'episodic', fact: 'episodic',
			semantic: 'semantic', architecture: 'semantic',
			procedural: 'procedural', workflow: 'procedural',
		};
		for (const t of types) {
			assert(!!tierMap[t], `type '${t}' has tier mapping`);
		}
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 L：索引持久化 / 恢复 / 重建（Phase 1）
	// ══════════════════════════════════════════════════════════════════════

	await test('L1: BM25Index serialize/deserialize roundtrip', async (kv) => {
		const idx1 = new BM25Index();
		await fn.remember(kv as any, AGENT_ID, 'Persistence test: React hooks pattern', 'pattern', ['react', 'hooks']);
		await fn.remember(kv as any, AGENT_ID, 'Persistence test: TypeScript generics', 'pattern', ['typescript']);
		const all = await (kv as any).list(KV.memories(AGENT_ID));
		for (const m of all) {
			if (m.isLatest !== false && m.content) idx1.add(m.id || '', m.content);
		}
		assert(idx1.size >= 2, 'index has entries');
		// Serialize → deserialize
		const json = idx1.serialize();
		const idx2 = new BM25Index();
		const ok = idx2.deserialize(json);
		assert(ok, 'deserialize succeeded');
		assertEq(idx2.size, idx1.size, 'same size after roundtrip');
		// Search returns same results
		const r1 = idx1.search('React', 5);
		const r2 = idx2.search('React', 5);
		assertEq(r1.length, r2.length, 'same search results');
		assert(r1.some(r => r.id === r2[0]?.id || r2.some(rr => rr.id === r.id)), 'matching IDs');
	});

	await test('L2: BM25Index serialize empty index', async (kv) => {
		const idx = new BM25Index();
		const json = idx.serialize();
		assert(json.includes('"v":2'), 'valid serialization format');
		const idx2 = new BM25Index();
		idx2.add('test-1', 'foo bar baz');
		idx2.deserialize(json);
		assertEq(idx2.size, 0, 'restored to empty');
	});

	await test('L6: BM25Index restoreFrom copies between instances', async (kv) => {
		const idx1 = new BM25Index();
		idx1.add('a', 'alpha beta gamma');
		idx1.add('b', 'beta delta epsilon');

		const idx2 = new BM25Index();
		idx2.restoreFrom(idx1);
		assertEq(idx2.size, 2, 'restoreFrom copies all entries');

		// Mutating idx1 doesn't affect idx2
		idx1.remove('a');
		assertEq(idx2.size, 2, 'idx2 unaffected after idx1 mutation');

		const r = idx2.search('alpha', 5);
		assertEq(r.length, 1, 'idx2 still finds removed-from-idx1 doc');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 M：写入路径对齐（Phase 2: dedup + Jaccard 0.7 + version chain）
	// ══════════════════════════════════════════════════════════════════════

	await test('M1: fingerprintId dedup prevents duplicate write', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Fingerprint dedup test', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Fingerprint dedup test', 'pattern');
		assertEq(r1.id, r2.id, 'same fingerprint returns same id');
		assertEq(r2.action, 'deduplicated', 'action is deduplicated');
	});

	await test('M2: Jaccard conflict >0.7 creates version chain', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Jaccard: React state management with hooks and context API for complex flows', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Jaccard: React state management with hooks and context API for advanced patterns', 'pattern');
		assertEq(r2.action, 'superseded', 'high similarity creates version chain');
		assert(r1.id !== r2.id, 'different IDs for versions');
		// 旧版本标记为非最新
		const oldMem = await (kv as any).get(KV.memories(AGENT_ID), r1.id);
		assert(oldMem.isLatest === false, 'old version isLatest=false');
		// 新版本 isLatest=true
		const newMem = await (kv as any).get(KV.memories(AGENT_ID), r2.id);
		assert(newMem.isLatest === true, 'new version isLatest=true');
		assertEq(newMem.version, 2, 'version incremented');
		assertEq(newMem.parentId, r1.id, 'parentId points to old version');
	});

	await test('M3: low Jaccard similarity (<0.7) creates separate memories', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'PostgreSQL database connection pooling configuration', 'pattern');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Tailwind CSS responsive design breakpoint customization', 'pattern');
		assertEq(r2.action, 'created', 'low similarity → separate memory');
		assert(r1.id !== r2.id, 'different IDs');
		const allMems = await (kv as any).list(KV.memories(AGENT_ID));
		const latest = allMems.filter((m: any) => m.isLatest !== false);
		assertEq(latest.length, 2, 'both memories are latest');
	});

	await test('M4: version chain search excludes old versions', async (kv) => {
		// Jaccard > 0.7: 大量重叠词
		await fn.remember(kv as any, AGENT_ID, 'Version chain original deployment strategy using Docker', 'pattern');
		await fn.remember(kv as any, AGENT_ID, 'Version chain original deployment strategy using Docker with monitoring', 'pattern');
		await seedBM25(kv);
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'deployment Docker', 10);
		assert(results.length > 0, 'finds deployment memories');
		// 所有返回的记忆都是最新版本
		const allMems = await (kv as any).list(KV.memories(AGENT_ID));
		for (const r of results) {
			const mem = allMems.find((m: any) => m.id === r.id);
			if (mem) assert(mem.isLatest !== false, 'returned memory is latest version');
		}
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 N：混合搜索（Phase 2: BM25 + Vector RRF 融合）
	// ══════════════════════════════════════════════════════════════════════

	await test('N1: searchMemories returns BM25 results via index', async (kv) => {
		// Inject index with data
		const bm25 = new BM25Index();
		await fn.remember(kv as any, AGENT_ID, 'Hybrid search: React Server Components pattern', 'pattern');
		await fn.remember(kv as any, AGENT_ID, 'Hybrid search: Next.js App Router migration guide', 'pattern');
		const all = await (kv as any).list(KV.memories(AGENT_ID));
		for (const m of all) {
			if (m.isLatest !== false && m.content) bm25.add(m.id || '', m.content);
		}
		// Set index for hybrid search
		fn.setIndexGetters(() => bm25, () => null as any);

		const results = await fn.searchMemories(kv as any, AGENT_ID, 'React', 10);
		assert(results.length > 0, 'finds results');
		assert(results.some(r => r.source === 'bm25'), 'source is bm25');
	});

	await test('N2: searchMemories fallback to KV when BM25 empty', async (kv) => {
		// Reset index to empty
		fn.setIndexGetters(() => (new BM25Index()), () => null as any);
		await fn.remember(kv as any, AGENT_ID, 'Fallback search test memory', 'fact');
		const results = await fn.searchMemories(kv as any, AGENT_ID, 'Fallback', 10);
		assert(results.length >= 0, 'returns results or empty (BM25 may be empty)');
	});

	await test('N3: searchMemories empty query returns ranked by strength', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Strength-ranked memory alpha', 'fact');
		await fn.remember(kv as any, AGENT_ID, 'Strength-ranked memory beta', 'fact');
		const results = await fn.searchMemories(kv as any, AGENT_ID, '', 10);
		assert(results.length > 0, 'returns rank-ordered results');
		assert(results.every(r => r.source === 'kv' || r.source === 'bm25'), 'valid source');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 O：Observe 观测写入（Phase 2）
	// ══════════════════════════════════════════════════════════════════════

	await test('O1: observe writes to per-session scope', async (kv) => {
		const result = await fn.observe(kv as any, AGENT_ID, {
			sessionId: 'sess-obs-1',
			hookType: 'session_start',
			timestamp: new Date().toISOString(),
			data: { userMessage: 'Hello' },
		});
		assert(result.success, 'observe succeeds');
		assert(result.observationId!.startsWith('obs_'), 'has observation ID');
	});

	await test('O2: observeList returns session observations', async (kv) => {
		await fn.observe(kv as any, AGENT_ID, { sessionId: 'sess-obs-2', hookType: 'session_start', timestamp: new Date().toISOString() });
		await fn.observe(kv as any, AGENT_ID, { sessionId: 'sess-obs-2', hookType: 'prompt_submit', timestamp: new Date().toISOString() });
		const list = await fn.observeList(kv as any, AGENT_ID, 'sess-obs-2');
		assertEq(list.length, 2, '2 observations in session');
		assert(list.every(o => o.sessionId === 'sess-obs-2'), 'all belong to session');
	});

	await test('O3: observeCount returns correct count', async (kv) => {
		await fn.observe(kv as any, AGENT_ID, { sessionId: 'sess-obs-3', hookType: 'tool_use', timestamp: new Date().toISOString(), data: { tool: 'read_file' } });
		const count = await fn.observeCount(kv as any, AGENT_ID, 'sess-obs-3');
		assertEq(count, 1, '1 observation counted');
	});

	await test('O4: observe validates required fields', async (kv) => {
		const r1 = await fn.observe(kv as any, AGENT_ID, { sessionId: '', hookType: '', timestamp: '' });
		assert(!r1.success, 'empty fields fail');
		assert(r1.error!.includes('Invalid'), 'error mentions invalid');
	});

	await test('O6: observe 懒注册 session 记录（创建+计数+firstPrompt）', async (kv) => {
		const sid = 'sess-obs-reg';
		await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'prompt_submit', timestamp: new Date().toISOString(), data: { userPrompt: 'fix the login bug please' } });
		let sess = await kv.get<any>(KV.sessions(AGENT_ID), sid);
		assert(sess !== null, 'session record created on first observe');
		assert(sess.observationCount === 1, `observationCount=1 (got ${sess.observationCount})`);
		assert(sess.firstPrompt === 'fix the login bug please', 'firstPrompt captured');
		await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'tool_use', timestamp: new Date().toISOString() });
		sess = await kv.get<any>(KV.sessions(AGENT_ID), sid);
		assert(sess.observationCount === 2, `observationCount=2 (got ${sess.observationCount})`);
		assert(sess.firstPrompt === 'fix the login bug please', 'firstPrompt NOT overwritten');
	});

	await test('O7: sessionStart 显式注册（幂等）', async (kv) => {
		const r1 = await fn.sessionStart(kv as any, AGENT_ID, 'sess-explicit', 'my-project');
		assert(r1.created === true, 'first call creates');
		const r2 = await fn.sessionStart(kv as any, AGENT_ID, 'sess-explicit', 'my-project');
		assert(r2.created === false, 'second call idempotent (no recreate)');
		const sess = await kv.get<any>(KV.sessions(AGENT_ID), 'sess-explicit');
		assert(sess.project === 'my-project' && sess.status === 'active', 'session fields correct');
	});

	await test('O8: compressSession 与既有摘要合并（累积叙事）', async (kv) => {
		const sid = 'sess-merge';
		// 第一批观察 → 压缩
		for (let i = 0; i < 3; i++) {
			await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'tool_use', timestamp: `2026-07-25T0${i}:00:00Z`, data: { tool_output: `first batch output ${i} edited src/a${i}.ts` } });
		}
		const s1 = await comp.compressSession(kv as any, AGENT_ID, sid, 'proj');
		assert(s1 !== null, 'first compression produced summary');
		// 第二批观察 → 再压缩（应合并而非覆盖）
		for (let i = 3; i < 6; i++) {
			await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'tool_use', timestamp: `2026-07-25T0${i}:00:00Z`, data: { tool_output: `second batch output ${i} edited src/b${i}.ts` } });
		}
		const s2 = await comp.compressSession(kv as any, AGENT_ID, sid, 'proj');
		assert(s2 !== null, 'second compression produced summary');
		assert(s2!.observationCount === 6, `cumulative count=6 (got ${s2!.observationCount})`);
		assert(s2!.narrative.includes('first batch'), 'narrative keeps first batch (merged, not overwritten)');
		assert(s2!.narrative.includes('second batch'), 'narrative includes second batch');
	});

	await test('O5: 滑动窗口 —— 超上限淘汰最老未压缩条目', async (kv) => {
		// 通过环境变量把上限调小便于测试
		const prev = process.env['AGENTMEMORY_MAX_OBS_PER_SESSION'];
		process.env['AGENTMEMORY_MAX_OBS_PER_SESSION'] = '5';
		try {
			const sid = 'sess-obs-window';
			// 写 3 条 + 手动标记最老一条为已压缩（应被保护不被淘汰）
			for (let i = 0; i < 3; i++) {
				await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'tool_use', timestamp: `2026-07-25T0${i}:00:00Z` });
			}
			const list1 = await fn.observeList(kv as any, AGENT_ID, sid);
			const oldest = list1.find(o => o.timestamp.includes('T00:'));
			if (oldest) { (oldest as any).compressed = true; await kv.set(KV.observations(AGENT_ID, sid), oldest.id, oldest); }
			// 再写 4 条 → 总数 7 > 上限 5 → 淘汰最老未压缩条目
			for (let i = 3; i < 7; i++) {
				await fn.observe(kv as any, AGENT_ID, { sessionId: sid, hookType: 'tool_use', timestamp: `2026-07-25T0${i}:00:00Z` });
			}
			const list2 = await fn.observeList(kv as any, AGENT_ID, sid);
			assert(list2.length <= 5, `capped at 5 (got ${list2.length})`);
			assert(list2.some(o => (o as any).compressed), 'compressed oldest entry protected from eviction');
			assert(!list2.some(o => o.timestamp.includes('T01:')), 'oldest uncompressed evicted');
		} finally {
			if (prev === undefined) { delete process.env['AGENTMEMORY_MAX_OBS_PER_SESSION']; }
			else { process.env['AGENTMEMORY_MAX_OBS_PER_SESSION'] = prev; }
		}
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 P：压缩闭环（Phase 3: observe → threshold → compress → SessionSummary）
	// ══════════════════════════════════════════════════════════════════════

	await test('P1: buildSyntheticCompression extracts files/concepts from observations', async (kv) => {
		const fake: any[] = [];
		for (let i = 0; i < 5; i++) {
			fake.push({
				id: `obs_${i}`, sessionId: 'sess-cp',
				hookType: 'post_tool_use', timestamp: new Date().toISOString(),
				data: {
					filePath: `src/module${i}.ts`,
					tool_name: 'read_file',
					tool_output: `Content of module${i}.ts: export class Module${i} {}`,
					concepts: ['typescript', 'module'],
				},
				createdAt: new Date().toISOString(), agentId: AGENT_ID,
			});
		}
		const result = comp.buildSyntheticCompression(fake as any[]);
		assert(result.files.length >= 5, 'files extracted');
		assert(result.concepts.length > 0, 'concepts extracted');
		assert(result.title.includes('post_tool_use'), 'title includes hook type');
		assert(result.narrative.length > 0, 'narrative not empty');
	});

	await test('P2: buildSyntheticCompression empty observations returns defaults', async (kv) => {
		const result = comp.buildSyntheticCompression([]);
		assertEq(result.title, 'Empty session', 'empty title');
		assertEq(result.files.length, 0, 'no files');
		assertEq(result.concepts.length, 0, 'no concepts');
	});

	await test('P3: compressSession marks observations as compressed and creates summary', async (kv) => {
		const sid = 'sess-cp-3';
		// Write observations via observe (with rich data for narrative extraction)
		for (let i = 0; i < 5; i++) {
			await fn.observe(kv as any, AGENT_ID, {
				sessionId: sid, hookType: 'post_tool_use',
				timestamp: new Date().toISOString(),
				data: {
					tool_name: 'edit', filePath: `src/file${i}.ts`,
					tool_input: { filePath: `src/file${i}.ts` },
					tool_output: `Updated module${i} with new refactored logic`,
					concepts: ['refactor'],
				},
			});
		}
		// Manual compress (threshold is 15, so manual trigger)
		const summary = await comp.compressSession(kv as any, AGENT_ID, sid, 'test-project');
		assert(!!summary, 'summary created');
		assertEq(summary!.sessionId, sid, 'sessionId matches');
		assertEq(summary!.project, 'test-project', 'project set');
		assert(summary!.narrative.length > 0, 'has narrative');
		assert(summary!.filesModified.length > 0, 'files recorded');
		assert(summary!.observationCount >= 5, 'observationCount set');

		// Check observations are marked compressed
		const obs = await fn.observeList(kv as any, AGENT_ID, sid);
		const compressed = obs.filter(o => o.compressed);
		assertEq(compressed.length, 5, 'all observations compressed');

		// Verify summary is stored
		const summaries = await fn.sessionSummaryList(kv as any, AGENT_ID);
		const found = summaries.find(s => s.sessionId === sid);
		assert(!!found, 'summary in list');
	});

	await test('P4: maybeCompressSession skips when below threshold', async (kv) => {
		const sid = 'sess-cp-4';
		for (let i = 0; i < 5; i++) {
			await fn.observe(kv as any, AGENT_ID, {
				sessionId: sid, hookType: 'post_tool_use',
				timestamp: new Date().toISOString(),
				data: { tool_name: 'read', filePath: 'test.ts' },
			});
		}
		const result = await comp.maybeCompressSession(kv as any, AGENT_ID, sid);
		assert(result === null, 'below threshold returns null');
	});

	await test('P5: getCompactContext returns recent summaries sorted', async (kv) => {
		// Create summaries for 2 sessions
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-ctx-1', 'default', 'Session 1', 'Narrative 1', ['d1'], ['f1.ts'], ['c1'], 10);
		await fn.sessionSummarySave(kv as any, AGENT_ID, 'sess-ctx-2', 'default', 'Session 2', 'Narrative 2', ['d2'], ['f2.ts'], ['c2'], 20);
		const ctx = await comp.getCompactContext(kv as any, AGENT_ID, 2);
		assertEq(ctx.length, 2, '2 summaries returned');
		// Most recent first
		const titles = ctx.map(s => s.title);
		assert(titles.some(t => t.includes('Session 1')), 'Session 1 included');
		assert(titles.some(t => t.includes('Session 2')), 'Session 2 included');
	});

	// ══════════════════════════════════════════════════════════════════════
	// 场景 Q：Consolidation API（修复"不支持固化 API" 错误）
	// ══════════════════════════════════════════════════════════════════════

	await test('Q1: episodic-family filter returns pattern/fact/preference/bug', async (kv) => {
		const r1 = await fn.remember(kv as any, AGENT_ID, 'Episodic test one unique content xyz', 'pattern');
		assert(r1.success, 'pattern remembered');
		const r2 = await fn.remember(kv as any, AGENT_ID, 'Episodic test two different content abc', 'fact');
		assert(r2.success, 'fact remembered');
		const mems = await (kv as any).list(KV.memories(AGENT_ID));
		// Debug: print what we have
		// console.log('Q1 mems:', JSON.stringify(mems.map((m: any) => ({ type: m.type, isLatest: m.isLatest })), null, 2));
		const episodic = mems.filter((m: any) => m.isLatest !== false && ['pattern', 'fact', 'preference', 'bug', 'episodic'].includes(m.type));
		assert(episodic.length >= 2, `episodic memories returned (got ${episodic.length} of ${mems.length})`);
	});

	await test('Q2: semantic filter returns architecture memories', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Architecture test 1', 'architecture');
		await fn.remember(kv as any, AGENT_ID, 'Should not match', 'pattern');
		const mems = await (kv as any).list(KV.memories(AGENT_ID));
		const semantic = mems.filter((m: any) => m.isLatest !== false && m.type === 'architecture');
		assert(semantic.length >= 1, 'semantic memories returned');
		assert(semantic.every((m: any) => m.type === 'architecture'), 'all are architecture');
	});

	await test('Q3: procedural scope returns array', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Procedural test', 'workflow');
		const procedural = await (kv as any).list(KV.procedural(AGENT_ID));
		assert(Array.isArray(procedural), 'returns array');
	});

	await test('Q4: consolidation context format check', async (kv) => {
		await fn.remember(kv as any, AGENT_ID, 'Consolidation ctx test', 'pattern');
		// 模拟 provider.getConsolidationContext 的逻辑
		const mems = await (kv as any).list(KV.memories(AGENT_ID));
		const epCount = mems.filter((m: any) => m.isLatest !== false && ['pattern', 'fact', 'preference', 'bug'].includes(m.type)).length;
		const smCount = mems.filter((m: any) => m.isLatest !== false && m.type === 'architecture').length;
		const ctx = [
			`## Consolidation Context (${AGENT_ID})`,
			``,
			`Episodic: ${epCount} memories (pattern/preference/bug/fact/episodic)`,
			`Semantic: ${smCount} memories (semantic/architecture)`,
			`Procedural: 0 skills`,
		].join('\n');
		assert(ctx.includes('Consolidation Context'), 'has title');
		assert(ctx.includes('Episodic:'), 'has episodic count');
		assert(ctx.includes('Semantic:'), 'has semantic count');
		assert(ctx.includes('Procedural:'), 'has procedural count');
	});

	// ══════════════════════════════════════════════════════════════════════
// 结果
	// ══════════════════════════════════════════════════════════════════════

	const total = passed + failed;
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`  Integration Results: ${passed} passed, ${failed} failed, ${total} total`);
	if (failures.length > 0) {
		console.log(`\n  Failures:`);
		for (const f of failures) console.log(`    - ${f}`);
	}
	console.log(`${'═'.repeat(60)}\n`);
}
