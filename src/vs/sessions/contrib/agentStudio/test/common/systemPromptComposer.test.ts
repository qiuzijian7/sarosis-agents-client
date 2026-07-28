/*---------------------------------------------------------------------------------------------
 *  分层系统提示词组合器（systemPromptComposer）单元测试
 *
 *  覆盖：
 *   - joinSections：\n\n 分节、跳过空白、自动 trim、确定性
 *   - composeFrozenPrefix：stable+context 合成冻结前缀，空 context 时仅 stable
 *   - composeVolatileMessage：有内容返回 volatile，空白返回 undefined
 *   - 缓存对齐不变量：volatile 变化不改变冻结前缀（fork 指纹稳定）
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	joinSections,
	composeFrozenPrefix,
	composeVolatileMessage,
	buildCompactToolSection,
	type ISystemPromptTiers,
} from '../../common/systemPromptComposer.js';
import { buildForkContext } from '../../common/forkContext.js';

const T = (stable: string, context: string, volatile: string): ISystemPromptTiers => ({ stable, context, volatile });

suite('systemPromptComposer', () => {

	suite('joinSections', () => {
		test('多段以 \\n\\n 连接', () => {
			assert.strictEqual(joinSections('a', 'b', 'c'), 'a\n\nb\n\nc');
		});

		test('跳过空白与 undefined 段', () => {
			assert.strictEqual(joinSections('a', '', '   ', undefined, 'b'), 'a\n\nb');
		});

		test('每段自动 trim', () => {
			assert.strictEqual(joinSections('  a  ', '\n b \n'), 'a\n\nb');
		});

		test('全空 → 空串', () => {
			assert.strictEqual(joinSections('', undefined, '  '), '');
		});

		test('确定性：相同输入 → 相同字节', () => {
			const x = joinSections('persona', 'global-prefix', 'rules');
			const y = joinSections('persona', 'global-prefix', 'rules');
			assert.strictEqual(x, y);
		});
	});

	suite('composeFrozenPrefix', () => {
		test('stable + context 合成冻结前缀', () => {
			const fp = composeFrozenPrefix(T('stable-persona', 'context-workspace', 'volatile-x'));
			assert.strictEqual(fp, 'stable-persona\n\ncontext-workspace');
		});

		test('空 context → 仅 stable', () => {
			const fp = composeFrozenPrefix(T('stable-only', '', 'volatile-x'));
			assert.strictEqual(fp, 'stable-only');
		});

		test('冻结前缀不包含 volatile', () => {
			const fp = composeFrozenPrefix(T('s', 'c', 'volatile-must-not-appear'));
			assert.ok(!fp.includes('volatile-must-not-appear'));
		});
	});

	suite('composeVolatileMessage', () => {
		test('有内容 → 返回 volatile 文本', () => {
			assert.strictEqual(composeVolatileMessage(T('s', 'c', 'persona memory')), 'persona memory');
		});

		test('空白 → undefined', () => {
			assert.strictEqual(composeVolatileMessage(T('s', 'c', '   ')), undefined);
			assert.strictEqual(composeVolatileMessage(T('s', 'c', '')), undefined);
		});
	});

	suite('缓存对齐不变量', () => {
		test('volatile 变化 → 冻结前缀与 fork 指纹不变', () => {
			const base = T('stable-persona', 'context-ws', '');
			const withVolatile = T('stable-persona', 'context-ws', 'persona memory v2 + active skill');
			const fp1 = composeFrozenPrefix(base);
			const fp2 = composeFrozenPrefix(withVolatile);
			assert.strictEqual(fp1, fp2, 'volatile 不得进入冻结前缀');

			const tools = [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }];
			const fork1 = buildForkContext(fp1, tools);
			const fork2 = buildForkContext(fp2, tools);
			assert.strictEqual(fork1.toolsFingerprint, fork2.toolsFingerprint, 'volatile 变化不得改变前缀指纹');
		});

		test('context 变化 → 冻结前缀指纹改变（符合预期，context 属前缀）', () => {
			const a = composeFrozenPrefix(T('stable', 'context-A', ''));
			const b = composeFrozenPrefix(T('stable', 'context-B', ''));
			const tools = [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }];
			assert.notStrictEqual(
				buildForkContext(a, tools).toolsFingerprint,
				buildForkContext(b, tools).toolsFingerprint,
			);
		});
	});

	suite('buildCompactToolSection (P0 反 101K 回归)', () => {
		test('输出包含排序后的名称清单', () => {
			const s = buildCompactToolSection(['read_file', 'search_files', 'file_write']);
			assert.ok(s.includes('Built-in tools: file_write, read_file, search_files'), '名称应按字母序一行列出');
		});

		test('确定性（相同输入 → 相同字节）', () => {
			const a = buildCompactToolSection(['b', 'a', 'c']);
			const b = buildCompactToolSection(['b', 'a', 'c']);
			assert.strictEqual(a, b, '相同输入必须产生相同字节（缓存对齐前提）');
			assert.ok(a.includes('Built-in tools: a, b, c'));
		});

		test('不含「名称: 描述」逐项大列表（101K 主因必须杜绝）', () => {
			const s = buildCompactToolSection(['read_file', 'search_files', 'file_write', 'terminal', 'task']);
			// 旧的 101K 形态：每个工具一行 `- <name>: <长描述>`。确保不再出现。
			const bulletPattern = /^- [a-z_]+:\s+\S+/m;
			assert.ok(!bulletPattern.test(s), '不得出现逐工具 "name: description" 列表项');
			// 也不应重复出现工具名以外的长描述性句子
			assert.ok(!s.includes('You can use this tool to', '不应含逐工具长描述'));
		});

		test('提示 MCP 走 tool_search 桥接、且含反幻觉规则', () => {
			const s = buildCompactToolSection(['read_file']);
			assert.ok(s.includes('tool_search → tool_describe → tool_call'), '应引导 MCP 走桥接');
			assert.ok(s.includes('CRITICAL ANTI-HALLUCINATION RULES'), '应保留反幻觉规则');
			assert.ok(s.includes('NEVER claim you have done something without actually calling a tool'), '反幻觉条目完整');
		});

		test('空列表 → 仅含标题与规则（不崩、不空）', () => {
			const s = buildCompactToolSection([]);
			assert.ok(s.includes('## Available Tools'));
			assert.ok(s.includes('Built-in tools:'));
			assert.ok(!s.includes('undefined'));
		});
	});
});
