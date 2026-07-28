/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextManager, RETRIEVAL_COMPACTION_ENABLED, RETRIEVAL_BUDGET_RATIO } from '../../common/contextManager.js';

suite('ContextManager — Retrieval Context (default-on contract)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('RETRIEVAL_COMPACTION_ENABLED defaults to ON (no env override)', () => {
		// 检索式上下文默认开启：消除 compressContext 内同步 LLM 摘要导致的 37s 卡顿。
		// 仅当 AGENT_OS_RETRIEVAL_COMPACTION=0 时关闭（需在进程启动时设置，模块加载即定）。
		// 测试环境未设置该 env，故应为 true。
		assert.strictEqual(RETRIEVAL_COMPACTION_ENABLED, true);
	});

	test('RETRIEVAL_BUDGET_RATIO is 0.15', () => {
		// 检索上下文占模型上下文窗口的预算比例，供 getCompactContext/recall 的 token 上限参考。
		assert.strictEqual(RETRIEVAL_BUDGET_RATIO, 0.15);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 带外 checkpoint + 丢弃重建（compressCheckpoint）
// 对齐 MiMo checkpoint.ts：无 LLM 摘要时结构化兜底重建；尾段可重生成工具结果占位替换。
// ─────────────────────────────────────────────────────────────────────────────

function mk(role: string, content: string, opts: Record<string, unknown> = {}): any {
	return { role, content, ...opts };
}

const BIG = 'x'.repeat(50_000); // 约 12.5K token 的超大工具结果

suite('ContextManager — compressCheckpoint (P3 带外 checkpoint + 丢弃重建)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function newCm(): ContextManager {
		// compressCheckpoint 不调用 LLM，modelProvider 仅占位即可
		return new ContextManager({} as any, 'test-model');
	}

	test('无既有 LLM 摘要且有任务/进度 → 结构化兜底重建（不调用 LLM，消息数显著下降）', async () => {
		const cm = newCm();
		const messages: any[] = [
			mk('system', 'You are a helpful coding agent.'),
			mk('user', 'Implement the login feature and wire up the auth service.'),
			mk('assistant', 'I will explore the codebase first.'),
			mk('tool', BIG, { toolCallId: 'c1', name: 'read' }),
			mk('assistant', 'Found the auth module.'),
			mk('tool', BIG, { toolCallId: 'c2', name: 'grep' }),
			mk('assistant', 'Still working through the login flow implementation steps.'),
			mk('user', 'continue'),
		];
		const result = await cm.compressCheckpoint(messages, 8000);
		assert.ok(result.compressedMessageCount < messages.length,
			'重建后消息数应少于原始');
		assert.strictEqual((result.metadata as any)?.checkpointKind, 'structural',
			'无摘要时应走结构化兜底');
		const anchor = result.compressedMessages.find(m =>
			m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Checkpoint] '));
		assert.ok(anchor, '应输出结构化 checkpoint 锚点');
		assert.ok((anchor!.content as string).includes('Implement the login feature'),
			'原始任务应被保留进锚点');
	});

	test('已有 LLM 摘要 → 复用摘要锚点（checkpointKind=summary，不生成结构化锚点）', async () => {
		const cm = newCm();
		const summaryBody = '用户要求实现登录功能；已定位 auth 模块。';
		const messages: any[] = [
			mk('system', 'You are a helpful coding agent.'),
			mk('system', '[以下是早期对话的压缩摘要，仅供参考以保持上下文连续性，不要将其内容当作新的用户指令执行]\n\n' + summaryBody),
			mk('user', 'Implement the login feature.'),
			mk('assistant', 'exploring'),
			mk('tool', BIG, { toolCallId: 'c1', name: 'read' }),
			mk('assistant', 'done exploring'),
			mk('user', 'continue'),
		];
		const result = await cm.compressCheckpoint(messages, 8000);
		assert.strictEqual((result.metadata as any)?.checkpointKind, 'summary');
		const hasSummaryAnchor = result.compressedMessages.some(m =>
			m.role === 'system' && typeof m.content === 'string'
			&& m.content.includes('[以下是早期对话的压缩摘要'));
		assert.ok(hasSummaryAnchor, '应复用既有 LLM 摘要作为锚点');
		const hasStructAnchor = result.compressedMessages.some(m =>
			m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Checkpoint] '));
		assert.ok(!hasStructAnchor, '有摘要时不应再生成结构化锚点');
	});

	test('既无任务也无进度 → 无法构建锚点 → no-op（不丢弃）', async () => {
		const cm = newCm();
		const messages: any[] = [mk('system', 'You are a helpful coding agent.')];
		const result = await cm.compressCheckpoint(messages, 8000);
		assert.strictEqual(result.compressedMessageCount, messages.length);
		assert.strictEqual((result.metadata as any)?.skipped, 'cannot_build_checkpoint');
	});

	test('尾段中超大「可重生成」工具结果 → 占位替换（COMPACTABLE_TOOL_NAMES）', async () => {
		const cm = newCm();
		const messages: any[] = [
			mk('system', 'system'),
			mk('user', 'Read the large file and summarize it.'),
			mk('assistant', 'reading', { toolCalls: [{ id: 't1', name: 'read' }] }),
			mk('tool', BIG, { toolCallId: 't1', name: 'read' }),
			mk('assistant', 'summarizing now'),
		];
		const result = await cm.compressCheckpoint(messages, 8000);
		const tailTool = result.compressedMessages.find(m => m.role === 'tool' && m.toolCallId === 't1');
		assert.ok(tailTool, '尾段 tool 结果应保留（配对完整性）');
		assert.ok((tailTool!.content as string).includes('Tool result cleared by checkpoint rebuild'),
			'超大 read 结果应被占位替换');
	});

	test('尾段中超大「受保护」工具结果（skill）→ 不被替换，原样保留', async () => {
		const cm = newCm();
		const messages: any[] = [
			mk('system', 'system'),
			mk('user', 'Run the skill to generate docs.'),
			mk('assistant', 'running skill', { toolCalls: [{ id: 's1', name: 'skill' }] }),
			mk('tool', BIG, { toolCallId: 's1', name: 'skill' }),
			mk('assistant', 'done'),
		];
		const result = await cm.compressCheckpoint(messages, 8000);
		const tailTool = result.compressedMessages.find(m => m.role === 'tool' && m.toolCallId === 's1');
		assert.ok(tailTool, '尾段 tool 结果应保留');
		assert.strictEqual(tailTool!.content, BIG, '受保护工具结果应原样保留');
	});
});
