/*---------------------------------------------------------------------------------------------
 *  ContextBuilder 单元测试 — 验证 ContextBlock 抽象 + 统一预算截断
 *--------------------------------------------------------------------------------------------*/
import { type ContextBlock, selectWithBudgetAndPriority, wrapAgentMemoryContext } from '../contextBuilder.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

export function runContextBuilderTests(): void {
	describe('ContextBlock selection', () => {
		it('selectWithBudgetAndPriority sorts by priority ascending then recency descending', () => {
			const blocks: ContextBlock[] = [
				{ type: 'episodic', content: 'dynamic', tokens: 10, recency: 1, priority: 2 },
				{ type: 'lesson', content: 'core', tokens: 10, recency: 1, priority: 1 },
				{ type: 'working', content: 'recent', tokens: 10, recency: 1, priority: 2 },
			];
			const { selected } = selectWithBudgetAndPriority(blocks, 1000);
			assertEqual(selected[0].content, 'core', 'priority=1 core comes first');
		});

		it('selectWithBudgetAndPriority truncates low-priority blocks first', () => {
			const blocks: ContextBlock[] = [
				{ type: 'lesson', content: 'core', tokens: 10, recency: 2, priority: 1 },
				{ type: 'episodic', content: 'dynamic', tokens: 10, recency: 1, priority: 2 },
			];
			const { selected } = selectWithBudgetAndPriority(blocks, 15);
			assertEqual(selected.length, 1, 'only core fits');
			assertEqual(selected[0].content, 'core', 'priority=1 block preserved');
		});

		it('fixed blocks (priority=0) are always included even over budget', () => {
			const blocks: ContextBlock[] = [
				{ type: 'slot', content: 'persona', tokens: 100, recency: 0, priority: 0 },
				{ type: 'lesson', content: 'core', tokens: 10, recency: 1, priority: 1 },
			];
			const { selected } = selectWithBudgetAndPriority(blocks, 5);
			assertEqual(selected.length, 1, 'only fixed block kept');
			assertEqual(selected[0].content, 'persona', 'fixed block preserved');
		});
	});

	describe('wrapAgentMemoryContext', () => {
		it('wraps selected blocks in stable XML tags', () => {
			const blocks: ContextBlock[] = [
				{ type: 'lesson', content: 'lesson content', tokens: 4, recency: 2, priority: 1 },
				{ type: 'episodic', content: 'episodic content', tokens: 4, recency: 1, priority: 2 },
			];
			const { text, truncated } = wrapAgentMemoryContext(blocks, 1000, 'project-x');
			assert(text.includes('<agentmemory-context project="project-x">'), 'has opening tag with project');
			assert(text.includes('</agentmemory-context>'), 'has closing tag');
			assert(text.includes('lesson content'), 'contains lesson content');
			assert(truncated === false, 'not truncated under budget');
		});
	});
}
