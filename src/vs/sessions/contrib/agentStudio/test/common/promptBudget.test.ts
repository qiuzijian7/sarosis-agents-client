/*---------------------------------------------------------------------------------------------
 *  提示词预算可观测（promptBudget）单元测试
 *
 *  覆盖：
 *   - weightedCharCount / estimateTextTokens：CJK 加权、空串、与压缩口径同源
 *   - classifySystemSegment：各注入来源标签 + 未知回退（不静默丢失）
 *   - buildPromptBudgetReport：不重复计算、前缀按段归因 + 残差行、tools 分组求和守恒
 *   - formatPromptBudgetLog：日志格式契约（会被 grep 统计，改动需同步本测试）
 *   - shouldEmitBudgetReport：首次必打 / 小漂移沉默 / 大漂移再打（含控制组）
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	weightedCharCount,
	estimateTextTokens,
	classifySystemSegment,
	buildPromptBudgetReport,
	formatPromptBudgetLog,
	shouldEmitBudgetReport,
	IMAGE_TOKEN_COST,
	BUDGET_DRIFT_RATIO,
} from '../../common/promptBudget.js';

suite('promptBudget', () => {

	suite('token 估算', () => {
		test('ASCII 每字符权重 1', () => {
			assert.strictEqual(weightedCharCount('abcd'), 4);
			assert.strictEqual(estimateTextTokens('abcd'), 1);
		});

		test('CJK 每字符权重 2.67（修正裸 chars/4 的系统性低估）', () => {
			assert.ok(Math.abs(weightedCharCount('中文') - 5.34) < 1e-9);
			// 5.34 / 4 = 1.335 → ceil = 2；裸 chars/4 会得到 1，低估一半
			assert.strictEqual(estimateTextTokens('中文'), 2);
		});

		test('空串 → 0（不返回 NaN，不 ceil 出 1）', () => {
			assert.strictEqual(estimateTextTokens(''), 0);
			assert.strictEqual(weightedCharCount(''), 0);
		});

		test('全角标点计入 CJK 权重段', () => {
			assert.ok(weightedCharCount('，') > 2.6);
		});
	});

	suite('classifySystemSegment', () => {
		test('按已有结构标记识别来源', () => {
			assert.strictEqual(classifySystemSegment('<system-reminder>x</system-reminder>'), 'injected/system-reminder');
			assert.strictEqual(classifySystemSegment('<durable-context>\nfoo'), 'injected/durable-context');
			assert.strictEqual(classifySystemSegment('## Recently Touched Files\na.ts'), 'injected/touched-files');
			assert.strictEqual(classifySystemSegment('<agentmemory-past-errors>\n- x'), 'injected/agent-memory');
			assert.strictEqual(classifySystemSegment('TOOL_USE_ENFORCEMENT: do it'), 'injected/tool-enforcement');
		});

		test('未知内容归到 injected/other（绝不静默丢失）', () => {
			assert.strictEqual(classifySystemSegment('some brand new injection'), 'injected/other');
		});

		test('只看前 400 字符（避免长内容里的偶然词误分类）', () => {
			const s = 'x'.repeat(500) + '## Recently Touched Files';
			assert.strictEqual(classifySystemSegment(s), 'injected/other');
		});
	});

	suite('buildPromptBudgetReport', () => {
		const msgs = (frozen: string, extra: Array<{ role: string; content: string }> = []) => [
			{ role: 'system', content: frozen },
			...extra,
		];

		test('第一条 system 无命名段 → 单行 system:frozen', () => {
			const messages = msgs('AAAA');
			const r = buildPromptBudgetReport({
				messages,
				messagesTokens: estimateTextTokens('AAAA'),
				contextWindow: 1000,
			});
			assert.ok(r.lines.some((l) => l.name === 'system:frozen'));
			assert.strictEqual(r.systemMessageCount, 1);
			assert.strictEqual(r.conversationTokens, 0);
		});

		test('命名段细分冻结前缀，未认领部分进 (unattributed) 残差行', () => {
			const a = 'A'.repeat(400);
			const b = 'B'.repeat(400);
			const tail = 'C'.repeat(400); // 未登记的追加内容（如 TOOL_USE_ENFORCEMENT）
			const frozen = `${a}\n\n${b}\n\n${tail}`;
			const r = buildPromptBudgetReport({
				messages: msgs(frozen),
				messagesTokens: estimateTextTokens(frozen),
				frozenPrefixSegments: [{ name: 'persona', text: a }, { name: 'global-prefix', text: b }],
				contextWindow: 10000,
			});
			assert.ok(r.lines.some((l) => l.name === 'system:frozen/persona'));
			assert.ok(r.lines.some((l) => l.name === 'system:frozen/global-prefix'));
			const un = r.lines.find((l) => l.name === 'system:frozen/(unattributed)');
			assert.ok(un, '未认领内容必须显式出行，不得静默吞掉');
			assert.ok(un!.tokens >= estimateTextTokens(tail) - 2);
		});

		test('段和恰好等于前缀时不产生残差行（控制组）', () => {
			const only = 'A'.repeat(400);
			const r = buildPromptBudgetReport({
				messages: msgs(only),
				messagesTokens: estimateTextTokens(only),
				frozenPrefixSegments: [{ name: 'persona', text: only }],
				contextWindow: 10000,
			});
			assert.ok(!r.lines.some((l) => l.name === 'system:frozen/(unattributed)'));
		});

		test('不重复计算：system + conversation 即消息侧全部开销', () => {
			const frozen = 'S'.repeat(200);
			const messages = msgs(frozen, [
				{ role: 'user', content: 'U'.repeat(100) },
				{ role: 'assistant', content: 'A'.repeat(80) },
			]);
			const authoritative = estimateTextTokens(frozen) + estimateTextTokens('U'.repeat(100)) + estimateTextTokens('A'.repeat(80));
			const r = buildPromptBudgetReport({ messages, messagesTokens: authoritative, contextWindow: 10000 });
			assert.strictEqual(r.systemTokens + r.conversationTokens, authoritative);
			assert.strictEqual(r.estimatorDelta, 0, '与权威口径应无残差');
			assert.ok(!r.lines.some((l) => l.name === 'messages:(estimator-delta)'));
		});

		test('与权威 messagesTokens 不符时输出对账残差行', () => {
			const frozen = 'S'.repeat(200);
			const r = buildPromptBudgetReport({
				messages: msgs(frozen),
				messagesTokens: estimateTextTokens(frozen) + 777,
				contextWindow: 10000,
			});
			const delta = r.lines.find((l) => l.name === 'messages:(estimator-delta)');
			assert.ok(delta, '口径漂移必须可见');
			assert.strictEqual(delta!.tokens, 777);
			assert.strictEqual(r.estimatorDelta, 777);
		});

		test('tools 分组求和守恒，total = messagesTokens + toolsTokens', () => {
			const frozen = 'S'.repeat(200);
			const msgTok = estimateTextTokens(frozen);
			const r = buildPromptBudgetReport({
				messages: msgs(frozen),
				messagesTokens: msgTok,
				toolGroups: [
					{ name: 'core', tokens: 1200, count: 10 },
					{ name: 'memory', tokens: 400, count: 4 },
				],
				contextWindow: 10000,
			});
			assert.strictEqual(r.toolsTokens, 1600);
			assert.strictEqual(r.totalTokens, msgTok + 1600);
			assert.strictEqual(r.toolCount, 14);
			assert.ok(r.lines.some((l) => l.name === 'tools:core' && l.tokens === 1200));
		});

		test('注入型 system 消息按来源分类并同名合并', () => {
			const messages = msgs('S'.repeat(100), []);
			messages.push({ role: 'system', content: '<system-reminder>a</system-reminder>' } as any);
			messages.push({ role: 'system', content: '<system-reminder>b</system-reminder>' } as any);
			const r = buildPromptBudgetReport({ messages, messagesTokens: 999, contextWindow: 10000 });
			const line = r.lines.filter((l) => l.name === 'system:injected/system-reminder');
			assert.strictEqual(line.length, 1, '同来源必须合并为一行');
			assert.strictEqual(r.systemMessageCount, 3);
		});

		test('图片按固定成本计，不按 base64 字符计', () => {
			const messages = [
				{ role: 'user', content: 'hi', contentParts: [{ type: 'image' }, { type: 'text' }] },
			];
			const r = buildPromptBudgetReport({ messages, messagesTokens: 0, contextWindow: 10000 });
			assert.ok(r.conversationTokens >= IMAGE_TOKEN_COST);
		});

		test('lines 按 tokens 降序；hottestTools 降序且受条数限制', () => {
			const r = buildPromptBudgetReport({
				messages: msgs('S'.repeat(40)),
				messagesTokens: 10,
				toolGroups: [{ name: 'a', tokens: 10, count: 1 }, { name: 'b', tokens: 500, count: 1 }],
				toolCosts: [
					{ name: 't1', tokens: 10 }, { name: 't2', tokens: 500 }, { name: 't3', tokens: 300 },
				],
				hottestToolCount: 2,
				contextWindow: 10000,
			});
			for (let i = 1; i < r.lines.length; i++) {
				assert.ok(r.lines[i - 1].tokens >= r.lines[i].tokens, 'lines 必须降序');
			}
			assert.deepStrictEqual(r.hottestTools.map((t) => t.name), ['t2', 't3']);
		});

		test('contextWindow<=0 时 usedPct=0（不产生 Infinity/NaN）', () => {
			const r = buildPromptBudgetReport({ messages: msgs('S'), messagesTokens: 5, contextWindow: 0 });
			assert.strictEqual(r.usedPct, 0);
		});

		test('pct 之和约等于 100%（去掉残差行后不重复计量）', () => {
			const frozen = 'S'.repeat(400);
			const r = buildPromptBudgetReport({
				messages: msgs(frozen, [{ role: 'user', content: 'U'.repeat(200) }]),
				messagesTokens: estimateTextTokens(frozen) + estimateTextTokens('U'.repeat(200)),
				toolGroups: [{ name: 'core', tokens: 300, count: 3 }],
				contextWindow: 10000,
			});
			const sum = r.lines.reduce((n, l) => n + l.pct, 0);
			assert.ok(Math.abs(sum - 100) < 0.5, `pct 之和应为 100，实际 ${sum}`);
		});
	});

	suite('formatPromptBudgetLog 格式契约', () => {
		const report = () => buildPromptBudgetReport({
			messages: [{ role: 'system', content: 'S'.repeat(400) }, { role: 'user', content: 'U'.repeat(80) }],
			messagesTokens: 120,
			toolGroups: [{ name: 'core', tokens: 500, count: 5 }],
			toolCosts: [{ name: 'terminal', tokens: 200 }],
			contextWindow: 100000,
		});

		test('首行以 [PromptBudget] total= 开头并含窗口占比', () => {
			const out = formatPromptBudgetLog(report());
			const head = out.split('\n')[0];
			assert.ok(head.startsWith('[PromptBudget] total='), head);
			assert.ok(head.includes('% of 100000 window'), head);
			assert.ok(head.includes('system=') && head.includes('tools='), head);
		});

		test('明细行两空格缩进；hottest tools 行存在', () => {
			const out = formatPromptBudgetLog(report());
			const rest = out.split('\n').slice(1);
			assert.ok(rest.length > 0);
			for (const l of rest) {
				assert.ok(l.startsWith('  '), `明细行必须两空格缩进: ${l}`);
			}
			assert.ok(rest.some((l) => l.includes('hottest tools: terminal=200')));
		});

		test('note 参数出现在首行', () => {
			const out = formatPromptBudgetLog(report(), 'turn baseline');
			assert.ok(out.split('\n')[0].endsWith('turn baseline'));
		});

		test('明细行超过上限时合并为 (others ×N) 且不丢 token', () => {
			const groups = Array.from({ length: 20 }, (_, i) => ({ name: `ts${i}`, tokens: 100 + i, count: 1 }));
			const r = buildPromptBudgetReport({
				messages: [{ role: 'system', content: 'S' }],
				messagesTokens: 1,
				toolGroups: groups,
				contextWindow: 100000,
			});
			const out = formatPromptBudgetLog(r);
			const others = out.split('\n').find((l) => l.includes('(others ×'));
			assert.ok(others, '超限行必须合并出行');
			const shownSum = out.split('\n').slice(1)
				.map((l) => Number(/\s(\d+)\s{2}/.exec(l)?.[1] ?? 0))
				.reduce((a, b) => a + b, 0);
			assert.ok(shownSum > 0 && shownSum <= r.totalTokens);
		});
	});

	suite('shouldEmitBudgetReport 节流', () => {
		test('每 turn 首次必打', () => {
			assert.strictEqual(shouldEmitBudgetReport(1000, 0), true);
		});

		test('小幅波动沉默（控制组：不能每 iteration 都刷）', () => {
			assert.strictEqual(shouldEmitBudgetReport(1050, 1000), false);
			assert.strictEqual(shouldEmitBudgetReport(950, 1000), false);
		});

		test('漂移达阈值即上报（含压缩后骤降）', () => {
			assert.strictEqual(shouldEmitBudgetReport(1000 * (1 + BUDGET_DRIFT_RATIO), 1000), true);
			assert.strictEqual(shouldEmitBudgetReport(500, 1000), true);
		});

		test('total<=0 不上报（无数据不刷日志）', () => {
			assert.strictEqual(shouldEmitBudgetReport(0, 0), false);
			assert.strictEqual(shouldEmitBudgetReport(-1, 100), false);
		});
	});
});
