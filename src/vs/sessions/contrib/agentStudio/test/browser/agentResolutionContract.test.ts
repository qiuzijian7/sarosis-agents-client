/*---------------------------------------------------------------------------------------------
 *  Agent 解析链路契约测试 —— 守护 `_currentAgent` 缺陷的修复。
 *
 *  背景（缺陷）：
 *  `agentTurnExecutor.ts` 曾用 `host._currentAgent` 取当前 Agent，但该成员在
 *  `AgentOSService` 上**从未声明过**，仅因 `host: any` 未被 tsc 拦下 —— 运行时恒为
 *  `undefined`，致使 `enrichWithStats` 的 `ctx.agent` 一直为空，只读 agent 永远
 *  收不到「This is a read-only agent」提醒。
 *
 *  本文件分两层守护：
 *  1. 行为层 —— 直接驱动 `SystemReminderTagProvider`，证明 `ctx.agent` 的有/无
 *     会真实改变输出（即该字段并非装饰）。这是缺陷的**实际后果面**。
 *  2. 源码层 —— 断言 executor 不再引用 `host._currentAgent`，且解析函数走的是
 *     Agent 注册表。`resolveCurrentAgent` 是 executor 内部函数无法直接 import，
 *     故以源码不变量兜底，防回归。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemReminderTagProvider } from '../../browser/messageEnrichment/builtinTagProviders.js';
import type { IEnrichContext } from '../../browser/messageEnrichment/userMessageEnricher.js';
import type { Agent } from '../../../../common/agentStudioTypes.js';
import type { IAgentTurnRequest } from '../../common/providers.js';

const READ_ONLY_NOTICE = 'This is a read-only agent';

/** 最小 request 桩 —— provider 只经 ctx 透传，不读其字段。 */
const REQUEST_STUB = { agentId: 'saros-claw', sessionId: 's1', messages: [] } as unknown as IAgentTurnRequest;

function buildContext(agent: Agent | undefined): IEnrichContext {
	return { request: REQUEST_STUB, agent };
}

function makeAgent(id: string, tools: string[] | undefined): Agent {
	return { id, name: id, tools } as unknown as Agent;
}

function renderReminder(agent: Agent | undefined): string {
	const content = new SystemReminderTagProvider().buildContent(buildContext(agent));
	assert.ok(typeof content === 'string', 'system_reminder 应始终产出内容（至少含工作记忆说明）');
	return content;
}

suite('Agent resolution contract (_currentAgent fix)', () => {

	// ── 第 1 层：行为 —— ctx.agent 必须真实影响输出 ──────────────────

	test('只读 agent（无 file_write / patch）→ 追加只读提醒', () => {
		const reminder = renderReminder(makeAgent('code-explorer', ['search_code', 'file_read']));
		assert.ok(
			reminder.includes(READ_ONLY_NOTICE),
			'只读 agent 必须收到只读提醒，否则模型会尝试写文件',
		);
	});

	test('可写 agent（含 file_write）→ 不追加只读提醒', () => {
		const reminder = renderReminder(makeAgent('saros-claw', ['file_read', 'file_write']));
		assert.ok(!reminder.includes(READ_ONLY_NOTICE), '可写 agent 不应被标记为只读');
	});

	test('可写 agent（仅含 patch 亦算可写）→ 不追加只读提醒', () => {
		const reminder = renderReminder(makeAgent('patcher', ['patch']));
		assert.ok(!reminder.includes(READ_ONLY_NOTICE), 'patch 也是写能力，不应判为只读');
	});

	test('★ 缺陷复现：agent 为 undefined 时只读提醒丢失', () => {
		// 这正是修复前的实际状态（host._currentAgent 恒 undefined）。
		// 断言「丢失」是刻意的：它锁定 ctx.agent 是行为的必要输入 ——
		// 若哪天 provider 改为不依赖 agent，此断言会失败并提醒重新评估本修复。
		const reminder = renderReminder(undefined);
		assert.ok(
			!reminder.includes(READ_ONLY_NOTICE),
			'agent 缺失时无法判定只读 → 提醒丢失（修复前的缺陷后果）',
		);
		assert.ok(reminder.length > 0, '即便无 agent，工作记忆说明仍应产出');
	});

	test('agent.tools 为 undefined（未配置工具）→ 视为只读', () => {
		const reminder = renderReminder(makeAgent('bare', undefined));
		assert.ok(
			reminder.includes(READ_ONLY_NOTICE),
			'tools 未配置时 `?.some()` 为 undefined → 走只读分支',
		);
	});

	test('agent.tools 为空数组 → 视为只读', () => {
		const reminder = renderReminder(makeAgent('empty', []));
		assert.ok(reminder.includes(READ_ONLY_NOTICE), '空工具集不具备写能力');
	});

	// ── 第 2 层：源码不变量 —— 防缺陷回归 ────────────────────────────

	const executorSource = readFileSync(
		join(
			process.cwd(),
			'src/vs/sessions/contrib/agentStudio/browser/agentTurnExecutor.ts',
		),
		'utf8',
	);

	test('executor 不再读取不存在的 host._currentAgent', () => {
		const offenders = executorSource
			.split(/\r?\n/)
			.map((line, idx) => ({ line, lineNo: idx + 1 }))
			.filter(({ line }) => /host\._currentAgent\b/.test(line) && !line.trimStart().startsWith('*'));
		assert.deepStrictEqual(
			offenders.map(o => o.lineNo),
			[],
			`host._currentAgent 在宿主上从未声明，恒为 undefined；命中行：${offenders.map(o => o.lineNo).join(', ')}`,
		);
	});

	test('富化调用点经 resolveCurrentAgent 取 agent', () => {
		assert.ok(
			/agent:\s*resolveCurrentAgent\(host,\s*request\.agentId\)/.test(executorSource),
			'enrichWithStats 的 ctx.agent 必须由 resolveCurrentAgent 按 agentId 解析',
		);
	});

	test('resolveCurrentAgent 走 Agent 注册表并按 id 匹配', () => {
		assert.ok(
			/function resolveCurrentAgent\(/.test(executorSource),
			'resolveCurrentAgent 应存在于 executor',
		);
		assert.ok(
			/host\._configReaderDeps\.getAgentsSync\(\)/.test(executorSource),
			'应经 _configReaderDeps.getAgentsSync() 读注册表（宿主构造时接好）',
		);
		assert.ok(
			/candidate\.id === agentId/.test(executorSource),
			'必须按 agentId 精确匹配，避免取错 agent',
		);
	});
});
