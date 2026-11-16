import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ROOM_BUDGET_DEFAULTS, ROOM_BUDGET_LIMITS, ROOM_LIMITS, budgetStopOf, estimateTokens, normalizeWakeSettings, normalizeWriteScopes, roomBudgetOf, roomPrompt, writeScopesOverlap,
} from '../lib/core/rooms.js';
import { GOAL_LIMITS, taskWriteScopes } from '../lib/core/goals.js';
import { countToolCalls } from '../lib/core/relay.js';

const members = [{ id: 'designer', name: 'Designer' }, { id: 'coder', name: 'Coder' }];

test('P3 预算归一化：逐群字段钳制、非法值拒绝、空输入保持旧契约', () => {
	assert.deepEqual(normalizeWakeSettings({}), {});
	const out = normalizeWakeSettings({
		maxTurns: 0, maxEstimatedTokens: 10, maxWallMs: 10, idleRelayLimit: 99,
		contextLines: 999, newLines: 0,
	});
	assert.equal(out.maxTurns, ROOM_BUDGET_LIMITS.maxTurnsMin);
	assert.equal(out.maxEstimatedTokens, ROOM_BUDGET_LIMITS.maxEstimatedTokensMin);
	assert.equal(out.maxWallMs, ROOM_BUDGET_LIMITS.maxWallMsMin);
	assert.equal(out.idleRelayLimit, ROOM_BUDGET_LIMITS.idleRelayLimitMax);
	assert.equal(out.contextLines, ROOM_BUDGET_LIMITS.contextLinesMax);
	assert.equal(out.newLines, ROOM_BUDGET_LIMITS.newLinesMin);
	assert.throws(() => normalizeWakeSettings({ maxTurns: 'x' }));
	assert.equal(ROOM_BUDGET_DEFAULTS.contextLines, ROOM_LIMITS.contextLines);
	assert.equal(ROOM_BUDGET_DEFAULTS.newLines, ROOM_LIMITS.newLines);
	assert.equal(GOAL_LIMITS.writeScopes, ROOM_BUDGET_LIMITS.writeScopesMax);
});

test('P3 token 估算与 roomBudgetOf / budgetStopOf', () => {
	assert.equal(estimateTokens('1234'), 1);
	assert.equal(estimateTokens('12345'), 2);
	assert.equal(estimateTokens(''), 0);
	const budget = roomBudgetOf({ maxTurns: 2, maxEstimatedTokens: 10, maxWallMs: 1_000, idleRelayLimit: 1, contextLines: 2, newLines: 3 });
	assert.equal(budget.maxTurns, 2);
	const injected = roomBudgetOf({}, { maxTurns: 7, maxEstimatedTokens: 20_000 });
	assert.equal(injected.maxTurns, 7);
	assert.equal(injected.maxEstimatedTokens, 20_000);
	const round = { startedAt: 0, metrics: { turns: 2, promptChars: 10, outputChars: 5, estimatedTokens: 4, toolCalls: 1, relays: 0 } };
	assert.equal(budgetStopOf(round, budget, 100, 0).reason, 'maxTurns');
	round.metrics.turns = 1;
	round.metrics.estimatedTokens = 10;
	assert.equal(budgetStopOf(round, budget, 100, 0).reason, 'maxEstimatedTokens');
	round.metrics.estimatedTokens = 1;
	assert.equal(budgetStopOf(round, budget, 1_000, 0).reason, 'maxWallMs');
	assert.equal(budgetStopOf(round, budget, 100, 1).reason, 'idleRelayLimit');
	assert.equal(budgetStopOf(round, budget, 100, 0), null);
});

test('P3 writeScopes 归一化、重叠判定、任务写范围投影', () => {
	assert.deepEqual(normalizeWriteScopes([' ./src/a.ts ', 'src/a.ts', '', 'x'.repeat(500)]).length, 2);
	assert.equal(writeScopesOverlap('src/a.ts', 'src/a.ts'), true);
	assert.equal(writeScopesOverlap(['src/**'], ['src/a.ts']), true);
	assert.equal(writeScopesOverlap(['docs/*'], ['src/a.ts']), false);
	assert.equal(writeScopesOverlap('*', 'src/a.ts'), true);
	assert.equal(writeScopesOverlap([], ['src/a.ts']), false);
	const goal = { status: 'active', current: 0, stages: [{ tasks: [{ botId: 'designer', task: '写设计', writeScopes: ['design/**'] }, { botId: 'coder', task: '写代码', writeScopes: ['src/**'] }] }] };
	assert.deepEqual(taskWriteScopes(goal, 'designer'), ['design/**']);
});

test('P3 roomPrompt 真实长群样本：上下文压缩与关联证据', () => {
	const log = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, who: '用户', text: `line-${index + 1}` }));
	const prompt = roomPrompt({
		room: { name: '长群', admin: 'designer', notice: '只做指定范围' },
		member: members[0],
		members,
		log,
		seen: 190,
		place: { ordered: false, with: ['Coder'] },
		calledBy: '用户',
		workDir: 'C:/work',
		contextLines: 2,
		newLines: 3,
	});
	assert.match(prompt, /line-189/);
	assert.match(prompt, /line-200/);
	assert.doesNotMatch(prompt, /line-1\b/);
	assert.match(prompt, /只做指定范围/);
	assert.match(prompt, /C:\/work/);
});

test('P3 countToolCalls 与 taskWriteScopes 保守统计', () => {
	assert.equal(countToolCalls([]), 0);
	assert.equal(countToolCalls([
		{ type: 'tool/call' },
		{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }, { type: 'text', text: 'ok' }] } } },
	]), 2);
	assert.deepEqual(taskWriteScopes(undefined, 'designer'), []);
});
