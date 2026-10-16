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
import * as fs from 'fs';
import * as path from 'path';
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

	suite('buildCompactToolSection × 模型族分发（P2）', () => {
		const names = ['file_read', 'patch'];

		test('省略 family ≡ generic（向后兼容基线，字节必须相同）', () => {
			assert.strictEqual(buildCompactToolSection(names), buildCompactToolSection(names, 'generic'));
		});

		test('generic 保留「不支持 FC 就打印 JSON」退路', () => {
			const s = buildCompactToolSection(names, 'generic');
			assert.ok(s.includes('{"name": "<tool_name>", "arguments": {<args>}}'));
			assert.ok(s.includes('FALLBACK'));
		});

		test('原生族去掉 JSON 退路，且反幻觉第 4 条同步改写', () => {
			const s = buildCompactToolSection(names, 'anthropic');
			assert.ok(!s.includes('{"name": "<tool_name>", "arguments": {<args>}}'), '原生族不得保留 JSON 退路');
			assert.ok(!s.includes('fenced code block'), '第 4 条不得再把代码块说成 fallback');
			assert.ok(s.includes('NATIVE function call'));
			// 规则表编号必须保持连续（4 由调用方给定）
			assert.ok(/^4\. \*\*Output format\*\*/m.test(s), '第 4 条编号应保持为 4');
		});

		test('反幻觉规则表其余条目与工具名清单不受族影响', () => {
			for (const family of ['generic', 'anthropic', 'openai'] as const) {
				const s = buildCompactToolSection(names, family);
				assert.ok(s.includes('Built-in tools: file_read, patch'), family);
				assert.ok(s.includes('CRITICAL ANTI-HALLUCINATION RULES'), family);
				assert.ok(s.includes('1. **NEVER claim you have done something'), family);
				assert.ok(s.includes('tool_search → tool_describe → tool_call'), family);
			}
		});

		test('同族确定性 / 跨族有差异（前缀缓存按模型分是预期行为）', () => {
			assert.strictEqual(buildCompactToolSection(names, 'openai'), buildCompactToolSection(names, 'openai'));
			assert.notStrictEqual(buildCompactToolSection(names, 'openai'), buildCompactToolSection(names, 'generic'));
			// 同为原生族则字节一致（避免无谓地按族拆散缓存）
			assert.strictEqual(buildCompactToolSection(names, 'openai'), buildCompactToolSection(names, 'anthropic'));
		});
	});

	suite('buildCompactToolSection × 工具可见性联动（2026-10-12）', () => {
		const names = ['file_read'];

		test('缺省 bridgeVisible ≡ true（字节与历史一致，前缀缓存不回归）', () => {
			assert.strictEqual(
				buildCompactToolSection(names),
				buildCompactToolSection(names, 'generic', {}),
				'省略 options 与传空对象必须同字节',
			);
			assert.strictEqual(
				buildCompactToolSection(names, 'generic'),
				buildCompactToolSection(names, 'generic', { bridgeVisible: true }),
				'bridgeVisible 缺省必须是 true（否则老调用点字节会变、缓存全失效）',
			);
		});

		test('★ 桥接可见 ⇒ 保留「tool_search → tool_describe → tool_call」指引（对照组）', () => {
			const s = buildCompactToolSection(names, 'generic', { bridgeVisible: true });
			assert.ok(s.includes('tool_search → tool_describe → tool_call'),
				'桥接在下发集里时必须保留原指引 —— 也是本套断言的对照组，防"两边都不含"的空跑');
		});

		test('★★ 桥接不可见 ⇒ **整段不得出现 tool_search**，并改说"没有检索桥接"', () => {
			// 依据：`assembleToolDefs` 在 `allDeferrable.length === 0` 时**提前返回且不附
			// 桥接工具**（`toolSearchAssembler.ts:395-404`）⇒ 只开 core/Always 工具集的会话
			// 里这三个工具根本没下发，此时教模型用它 = 指向不存在的工具 ✗（正是本段
			// 反幻觉规则在防的失败）。
			const s = buildCompactToolSection(names, 'generic', { bridgeVisible: false });
			// ⚠ 判据只钉 `tool_search` / `tool_describe`，**不钉** `tool_call` 裸串：
			//   `buildToolCallFormatDirective`（另一个模块）的反例文案里有 `<tool_call>`
			//   （"DO NOT use XML tags like `<tool_call>`"），与桥接无关，钉它必然误报 ✗。
			assert.ok(!s.includes('tool_search'), '桥接不可见时不得出现 tool_search（否则模型会去调一个没下发的工具）');
			assert.ok(!s.includes('tool_describe'), '桥接不可见时不得出现 tool_describe');
			assert.ok(!s.includes('tool_search → tool_describe → tool_call'),
				'不得保留桥接调用链（可执行的指引形态）');
			assert.ok(s.includes('NO tool-discovery bridge'),
				'必须明确说明本会话没有检索桥接 —— "不提"会被读成"照旧可用" ✗');
		});

		test('可见性只影响那一句：名称清单与反幻觉规则不受影响', () => {
			for (const bridgeVisible of [true, false]) {
				const s = buildCompactToolSection(names, 'generic', { bridgeVisible });
				assert.ok(s.includes('Built-in tools: file_read'), String(bridgeVisible));
				assert.ok(s.includes('CRITICAL ANTI-HALLUCINATION RULES'), String(bridgeVisible));
			}
		});
	});

	suite('buildRetrievalStrategyLines（Web Search Strategy 段的可见性 gate）', () => {
		// 为什么单独钉它：这是 2026-10-12「同一病灶第三例」修的那一段 —— 前两例
		// （tool_search / tool_describe）有守卫，这一段当时**没有**（注释自己说"那条守卫只盯
		// 那两个名字，抓不到这一段"）。修完不补守卫 = 下次有人加一条检索路径时没有任何东西
		// 会拦 ⇒ 这里把它的四条不变量钉死。
		const grab = (names: string[]) => buildCompactToolSection(names);

		test('一个检索工具都没有 ⇒ 整段不出现（连标题也没有）', () => {
			const s = grab(['file_read']);
			assert.ok(!s.includes('## Web Search Strategy'), 'paths===0 时整段必须消失（含标题）');
		});

		test('只有 web_search ⇒ 出现且只有它是检索路径；无对比句、无 fallback', () => {
			const s = grab(['web_search']);
			assert.ok(s.includes('## Web Search Strategy'));
			assert.ok(s.includes('`web_search`'), 'rule 1 必须是 web_search');
			assert.ok(!s.includes('anysearch'), 'anysearch 未集齐两个工具 ⇒ 不得出现');
			assert.ok(!s.includes('skip rule 1'), 'anysearch 不在 ⇒ 对比句不得出现（否则指向不存在的 rule 2）');
			assert.ok(!s.includes('Fallback'), '只有一条检索路径 ⇒ fallback 不得出现（没有"另一个工具"可切）');
		});

		test('web_search + anysearch（read_skill+execute_code 都在）⇒ 对比句在且编号正确', () => {
			const s = grab(['web_search', 'read_skill', 'execute_code']);
			assert.ok(s.includes('skip rule 1'), '两条主路径都在 ⇒ 对比句必须在');
			assert.ok(s.includes('Fallback'), '两条检索路径 ⇒ fallback 必须在');
			// 对比句硬编码 "rule 1 = web_search, rule 2 = anysearch" ⇒ 编号必须真的如此。
			const r1 = s.indexOf('1. **Latest/current facts');
			const r2 = s.indexOf('2. **Structured identifiers');
			assert.ok(r1 > -1 && r2 > -1 && r1 < r2, 'rule 1 必须是 web_search、rule 2 必须是 anysearch（对比句的正确性依赖这个顺序）');
		});

		test('anysearch 的两个前置工具缺一 ⇒ anysearch 路径不出现', () => {
			// read_skill 单独在（execute_code 不在）⇒ 起不了 python 子进程 ⇒ 不得教模型走这条路
			const s = grab(['read_skill']);
			assert.ok(!s.includes('anysearch'), 'execute_code 不在 ⇒ anysearch 路径不得出现（它要起子进程）');
		});

		test('规则编号在任何可见性组合下都连续（无跳号）', () => {
			// 抽几个代表性组合（全枚举已用脚本实证过 16/16，这里钉住防回归的关键几个）
			for (const names of [
				['web_search'],
				['web_extract'],
				['read_skill', 'execute_code'],
				['web_search', 'web_extract'],
				['web_search', 'read_skill', 'execute_code', 'web_extract'],
			]) {
				const s = grab(names);
				// ⚠ 只数**本段**的编号：反幻觉规则表也是 `N. **…**` 的独立编号表（1..6），
				//   不切开会把两张表混成一个序列 ⇒ 误报（第一版就这么红的）。
				const seg = s.split('## Web Search Strategy')[1]?.split(/\n## /)[0] ?? '';
				const m = seg.match(/^(\d+)\. \*\*/gm) ?? [];
				const nums = m.map(x => parseInt(x, 10));
				const seq = nums.every((n, i) => n === i + 1);
				assert.ok(seq, `编号必须连续：${names.join(',')} → ${nums.join(',')}`);
			}
		});
	});

	suite('buildCompactToolSection × 跨源码：调用点必须传可见性', () => {
		test('★ agentDriverService 调用点必须传 `{ bridgeVisible: … }`（防「加了参数没人传」）', () => {
			const abs = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts');
			assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
			const code = fs.readFileSync(abs, 'utf8');
			assert.ok(/buildCompactToolSection\(\s*[\s\S]{0,200}?bridgeVisible:\s*promptToolInventory\.bridgeVisible/.test(code),
				'调用 buildCompactToolSection 时必须传 bridgeVisible —— 否则"桥接不可见"的会话仍拿到旧指引，'
				+ '本开关会静默退化成装饰性参数 ✗');
		});
	});
});
