/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildExecReviewPrompt, parseExecReviewResponse, decideExecAutoReview,
	EXEC_REVIEW_MAX_INPUT_CHARS, type IExecReviewDecision,
} from '../../common/execAutoReview.js';

/**
 * execAutoReview（P2，2026-09-12）—— 模型辅助命令审查的纯逻辑契约。
 *
 * 本模块的定位是**只放宽灰色地带**，因此测试重心在 fail-safe：
 * 任何「解析不出 / 调用失败 / 超时 / 结构非法」都必须回到 `ask`，
 * 绝不能因为审查故障而放行 —— 这是整条通道的安全前提。
 */
suite('execAutoReview — 模型辅助命令审查（P2）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── 响应解析 ────────────────────────────────────────────────────────────

	suite('parseExecReviewResponse', () => {

		test('★ 合法 JSON → 解析出 decision / risk / rationale', () => {
			const d = parseExecReviewResponse('{"decision":"allow","risk":"low","rationale":"read-only listing"}');
			assert.strictEqual(d.decision, 'allow');
			assert.strictEqual(d.risk, 'low');
			assert.strictEqual(d.rationale, 'read-only listing');
			assert.ok(!d.degraded, '正常解析不应标记 degraded');
		});

		test('★ 容忍 markdown 围栏（模型常自发包裹）', () => {
			const d = parseExecReviewResponse('```json\n{"decision":"ask","risk":"high"}\n```');
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(d.risk, 'high');
		});

		test('★ 容忍 JSON 前后有散文（取第一个 JSON 对象）', () => {
			const d = parseExecReviewResponse('Sure, here it is:\n{"decision":"allow","risk":"low"}\nHope that helps.');
			assert.strictEqual(d.decision, 'allow');
		});

		test('★★ 缺 decision → ask + degraded（绝不默认 allow）', () => {
			const d = parseExecReviewResponse('{"risk":"low"}');
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(d.degraded, true);
		});

		test('★★ decision 取值非法 → ask + degraded', () => {
			for (const bad of ['{"decision":"deny"}', '{"decision":"ALLOW"}', '{"decision":true}']) {
				const d = parseExecReviewResponse(bad);
				assert.strictEqual(d.decision, 'ask', `应回退 ask: ${bad}`);
				assert.strictEqual(d.degraded, true);
			}
		});

		test('★★ 空输出 / 非 JSON / 非对象 → ask + degraded', () => {
			for (const bad of ['', '   ', 'not json at all', '[1,2,3]', '{"unclosed": ']) {
				const d = parseExecReviewResponse(bad);
				assert.strictEqual(d.decision, 'ask', `应回退 ask: ${JSON.stringify(bad)}`);
				assert.strictEqual(d.degraded, true);
			}
		});

		test('risk 非法 → 降级为 unknown，但**不**丢弃结论（它不参与决策）', () => {
			const d = parseExecReviewResponse('{"decision":"allow","risk":"catastrophic"}');
			assert.strictEqual(d.decision, 'allow', 'risk 非法不应影响 decision');
			assert.strictEqual(d.risk, 'unknown');
			assert.ok(!d.degraded);
		});

		test('rationale 超长 → 截断到 200 字符 + 省略号', () => {
			const long = 'x'.repeat(500);
			const d = parseExecReviewResponse(`{"decision":"ask","risk":"low","rationale":"${long}"}`);
			assert.ok(d.rationale && d.rationale.length <= 201, `实际 ${d.rationale?.length}`);
			assert.ok(d.rationale?.endsWith('…'));
		});

		test('rationale 缺失 / 空白 → 不输出该字段', () => {
			assert.strictEqual(parseExecReviewResponse('{"decision":"allow","risk":"low"}').rationale, undefined);
			assert.strictEqual(parseExecReviewResponse('{"decision":"allow","risk":"low","rationale":"  "}').rationale, undefined);
		});
	});

	// ── prompt 构造 ─────────────────────────────────────────────────────────

	suite('buildExecReviewPrompt', () => {

		test('★ 只序列化必要字段（不送 sessionId / 会话标识等无关信息）', () => {
			const p = buildExecReviewPrompt({ command: 'ls -la', cwd: '/w' });
			assert.ok(p.includes('ls -la'), p);
			assert.ok(p.includes('/w'), p);
			assert.ok(!p.includes('sessionId'), '不应包含会话标识');
		});

		test('可选字段缺失时不输出（不打印 null/undefined）', () => {
			const p = buildExecReviewPrompt({ command: 'ls' });
			assert.ok(!p.includes('argv'), p);
			assert.ok(!p.includes('cwd'), p);
			assert.ok(!p.includes('ruleReason'), p);
			assert.ok(!p.includes('undefined'), p);
		});

		test('argv / ruleReason 提供时一并带上（帮助模型聚焦）', () => {
			const p = buildExecReviewPrompt({
				command: 'weird-tool --x', argv: ['weird-tool', '--x'],
				ruleReason: 'not recognized', cwd: '/w',
			});
			assert.ok(p.includes('weird-tool'), p);
			assert.ok(p.includes('not recognized'), p);
		});

		test('★ 超长输入截断并显式标注（提示不确定就 ask）', () => {
			const p = buildExecReviewPrompt({ command: 'x'.repeat(EXEC_REVIEW_MAX_INPUT_CHARS * 2) });
			assert.ok(p.length < EXEC_REVIEW_MAX_INPUT_CHARS + 400, `实际 ${p.length}`);
			assert.ok(p.includes('TRUNCATED'), '应显式标注截断');
			assert.ok(p.includes('answer "ask"'), '应提示不确定就 ask');
		});
	});

	// ── fail-safe 决策 ──────────────────────────────────────────────────────

	suite('decideExecAutoReview（fail-safe）', () => {

		test('★ 审查器返回 allow → 透传', async () => {
			const d = await decideExecAutoReview(
				{ command: 'ls' },
				async () => ({ decision: 'allow', risk: 'low', rationale: 'read-only' }),
			);
			assert.strictEqual(d.decision, 'allow');
			assert.strictEqual(d.risk, 'low');
		});

		test('★ 审查器返回 ask → 透传（不降级）', async () => {
			const d = await decideExecAutoReview({ command: 'rm -rf x' }, async () => ({ decision: 'ask', risk: 'high' }));
			assert.strictEqual(d.decision, 'ask');
			assert.ok(!d.degraded, '这是正常结论，不应标 degraded');
		});

		test('★★ 审查器抛错 → ask + degraded（绝不因故障放行）', async () => {
			const d = await decideExecAutoReview({ command: 'ls' }, async () => { throw new Error('model unavailable'); });
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(d.degraded, true);
			assert.ok(d.rationale?.includes('model unavailable'), d.rationale);
		});

		test('★★ 超时 → ask + degraded', async () => {
			const d = await decideExecAutoReview(
				{ command: 'ls' },
				() => new Promise<IExecReviewDecision>(() => { /* never resolves */ }),
				20, // 极短超时
			);
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(d.degraded, true);
			assert.ok(d.rationale?.includes('timed out'), d.rationale);
		});

		test('★★ 审查器返回结构非法（绕过解析器）→ ask + degraded', async () => {
			const bad = { decision: 'allow-please' } as unknown as IExecReviewDecision;
			const d = await decideExecAutoReview({ command: 'ls' }, async () => bad);
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(d.degraded, true);
		});

		test('★ 空命令 → 直接 ask，不调用审查器', async () => {
			let called = false;
			const d = await decideExecAutoReview({ command: '   ' }, async () => {
				called = true;
				return { decision: 'allow', risk: 'low' };
			});
			assert.strictEqual(d.decision, 'ask');
			assert.strictEqual(called, false, '空命令不应触发模型调用');
		});

		test('risk 非法 → 归一为 unknown（decision 不变）', async () => {
			const d = await decideExecAutoReview(
				{ command: 'ls' },
				async () => ({ decision: 'allow', risk: 'bogus' as IExecReviewDecision['risk'] }),
			);
			assert.strictEqual(d.decision, 'allow');
			assert.strictEqual(d.risk, 'unknown');
		});
	});
});
