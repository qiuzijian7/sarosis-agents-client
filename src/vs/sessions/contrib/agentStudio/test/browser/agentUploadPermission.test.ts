/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 上传权限（owner 控制）单元测试。
 *
 * 覆盖点：
 *   1. canUploadAgent  — 内置 agent / 认领式 / owner 本人 / 非 owner / 未登录 各分支
 *   2. resolveClaimOwner — 未登录返回 undefined（不覆盖 owner）/ 已登录返回当前用户
 *
 * 设计说明：权限逻辑抽为纯函数（common/uploadPermission.ts），本测试直接调用纯函数，
 *          避免实例化依赖繁重的 AgentStudioService。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canUploadAgent, resolveClaimOwner } from '../../common/uploadPermission.js';
import type { Agent } from '../../common/agentStudioTypes.js';

const OWNER_A = 'taihu:staffid:100001';
const OWNER_B = 'taihu:staffid:100002';

/** 构造一个最小可编译的 Agent 测试对象（仅关注权限相关字段）。 */
function makeAgent(overrides: Partial<Agent> = {}): Agent {
	const base: Agent = {
		id: 'agent-test',
		name: 'Test Agent',
		role: 'assistant',
		description: '',
		icon: '🤖',
		model: 'claude-sonnet-4-20250514',
		skills: [],
		category: 'General',
		source: 'custom',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	} as Agent;
	return { ...base, ...overrides } as Agent;
}

suite('Agent Studio - Upload Ownership Permission', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('canUploadAgent', () => {

		test('内置 agent（source=builtin）— 任何用户都不可上传（系统资产）', () => {
			const agent = makeAgent({ source: 'builtin', owner: OWNER_A });
			// 即使传入 owner 本人，内置 agent 也永不显示上传按钮
			assert.strictEqual(canUploadAgent(agent, OWNER_A), false);
			assert.strictEqual(canUploadAgent(agent, undefined), false);
			assert.strictEqual(canUploadAgent(agent, OWNER_B), false);
		});

		test('自定义 agent + owner 为空 + 未登录 — 允许认领式上传（兼容存量）', () => {
			const agent = makeAgent({ source: 'custom', owner: '' });
			assert.strictEqual(canUploadAgent(agent, undefined), true);
		});

		test('自定义 agent + owner 为空 + 已登录 — 允许认领式上传', () => {
			const agent = makeAgent({ source: 'custom', owner: '' });
			assert.strictEqual(canUploadAgent(agent, OWNER_A), true);
		});

		test('自定义 agent + owner 为空（undefined）+ 已登录 — 允许认领式上传', () => {
			const agent = makeAgent({ source: 'custom' }); // owner 未设置 → undefined
			assert.strictEqual(canUploadAgent(agent, OWNER_A), true);
		});

		test('自定义 agent + owner=A + 当前用户=A — 可上传（本人）', () => {
			const agent = makeAgent({ source: 'custom', owner: OWNER_A });
			assert.strictEqual(canUploadAgent(agent, OWNER_A), true);
		});

		test('自定义 agent + owner=A + 当前用户=B — 不可上传（非 owner）', () => {
			const agent = makeAgent({ source: 'custom', owner: OWNER_A });
			assert.strictEqual(canUploadAgent(agent, OWNER_B), false);
		});

		test('自定义 agent + owner=A + 未登录 — 不可上传（无法比对 owner）', () => {
			const agent = makeAgent({ source: 'custom', owner: OWNER_A });
			assert.strictEqual(canUploadAgent(agent, undefined), false);
		});

		test('owner 空字符串与 undefined 都视为未认领（等价）', () => {
			const empty = makeAgent({ source: 'custom', owner: '' });
			const unset = makeAgent({ source: 'custom' });
			assert.strictEqual(canUploadAgent(empty, OWNER_A), canUploadAgent(unset, OWNER_A));
			assert.strictEqual(canUploadAgent(empty, OWNER_A), true);
		});
	});

	suite('resolveClaimOwner', () => {

		test('未登录（currentUserId 为空）— 返回 undefined，不应改写 owner', () => {
			assert.strictEqual(resolveClaimOwner(undefined), undefined);
		});

		test('未登录（currentUserId 为空串）— 返回 undefined', () => {
			assert.strictEqual(resolveClaimOwner(''), undefined);
		});

		test('已登录 — 返回当前用户 ID（即应写入 Agent.owner 的值）', () => {
			assert.strictEqual(resolveClaimOwner(OWNER_A), OWNER_A);
		});
	});
});
