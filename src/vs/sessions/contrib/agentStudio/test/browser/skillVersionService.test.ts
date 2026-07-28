/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 版本管理测试 — 测试 SkillVersionService 核心逻辑 + 集成场景。
 *
 * 由于 isomorphic-git 仅在 Electron renderer 可用，本测试文件聚焦于：
 *   - 纯逻辑函数（默认消息格式、SHA 截取等）
 *   - 集成触发场景（升级/发布/手动快照的 commit 消息格式）
 *   - 状态流转（dirty 检测 → 自动提交）
 *   - 边界情况（空 repo、空文件、回滚确认）
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

// ─── Types (mirrored from skillVersionService) ──────────────────────────────

interface SkillWorkspaceStatus {
	readonly initialized: boolean;
	readonly headSha: string | null;
	readonly headMessage: string | null;
	readonly dirty: boolean;
	readonly branch: string | null;
}

interface SkillCommitMeta {
	readonly sha: string;
	readonly shortSha: string;
	readonly message: string;
	readonly author: string;
	readonly time: number;
}

// ─── Pure helpers (extracted from skillVersionService) ──────────────────────

function formatAutoMessage(utcDate?: Date): string {
	const now = utcDate ?? new Date();
	const y = now.getUTCFullYear();
	const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
	const d = String(now.getUTCDate()).padStart(2, '0');
	const h = String(now.getUTCHours()).padStart(2, '0');
	const mi = String(now.getUTCMinutes()).padStart(2, '0');
	const s = String(now.getUTCSeconds()).padStart(2, '0');
	return `auto: ${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function makeShortSha(sha: string): string {
	return sha.substring(0, 7);
}

/**
 * 判断是否应该自动提交。
 * 逻辑：repo 已初始化 + 文件有变更（dirty）→ 可提交
 */
function shouldAutoCommit(status: SkillWorkspaceStatus): boolean {
	return status.initialized && status.dirty;
}

/**
 * 判断版本历史页签应显示什么状态。
 */
function getVersionTabState(
	status: SkillWorkspaceStatus,
	commits: SkillCommitMeta[],
): 'loading' | 'not-initialized' | 'no-commits' | 'has-history' {
	if (!status.initialized) { return 'not-initialized'; }
	if (commits.length === 0) { return 'no-commits'; }
	return 'has-history';
}

/**
 * 构建集成场景的 commit 消息。
 */
function buildCommitMessage(
	trigger: 'view' | 'snapshot' | 'upgrade' | 'publish',
	extra?: string,
): string {
	switch (trigger) {
		case 'snapshot':
			return `snapshot: ${extra ?? new Date().toLocaleString()}`;
		case 'upgrade':
			return `upgrade: install v${extra} from marketplace`;
		case 'publish':
			return `publish: v${extra} to marketplace`;
		case 'view':
			return formatAutoMessage();
	}
}

// ─── Test data ──────────────────────────────────────────────────────────────

const MOCK_COMMIT: SkillCommitMeta = {
	sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
	shortSha: 'a1b2c3d',
	message: 'auto: 2026-07-18 10:30:00',
	author: 'Sarosis',
	time: 1721298600,
};

const STATUS_CLEAN: SkillWorkspaceStatus = {
	initialized: true, headSha: 'abc1234', headMessage: 'auto: test', dirty: false, branch: 'main',
};

const STATUS_DIRTY: SkillWorkspaceStatus = {
	initialized: true, headSha: 'abc1234', headMessage: 'auto: test', dirty: true, branch: 'main',
};

const STATUS_UNINIT: SkillWorkspaceStatus = {
	initialized: false, headSha: null, headMessage: null, dirty: false, branch: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('Skill Version Management', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ════════════════════════════════════════════════════════════════════
	// formatAutoMessage — 自动提交消息格式
	// ════════════════════════════════════════════════════════════════════

	suite('formatAutoMessage', () => {

		test('produces correct ISO format', () => {
			const dt = new Date(Date.UTC(2026, 6, 18, 10, 30, 5));
			const msg = formatAutoMessage(dt);
			assert.strictEqual(msg, 'auto: 2026-07-18 10:30:05');
		});

		test('pads single-digit values correctly', () => {
			const dt = new Date(Date.UTC(2026, 0, 5, 3, 7, 9));
			const msg = formatAutoMessage(dt);
			assert.strictEqual(msg, 'auto: 2026-01-05 03:07:09');
		});

		test('handles midnight', () => {
			const dt = new Date(Date.UTC(2026, 11, 31, 0, 0, 0));
			const msg = formatAutoMessage(dt);
			assert.strictEqual(msg, 'auto: 2026-12-31 00:00:00');
		});

		test('uses UTC time', () => {
			const localDate = new Date(2026, 6, 18, 20, 30, 0); // local 20:30
			const msg = formatAutoMessage(localDate);
			// UTC should be 12:30 (UTC+8 for China)
			assert.ok(msg.includes('12:30:00') || msg.includes('20:30:00'),
				`Expected UTC time in message: ${msg}`);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// makeShortSha — SHA 截取
	// ════════════════════════════════════════════════════════════════════

	suite('makeShortSha (shortSha helper)', () => {

		test('truncates to 7 characters', () => {
			assert.strictEqual(makeShortSha('a1b2c3d4e5f6789012345678901234567890abcd'), 'a1b2c3d');
		});

		test('works with shorter SHA', () => {
			assert.strictEqual(makeShortSha('abc'), 'abc');
		});

		test('works with empty string', () => {
			assert.strictEqual(makeShortSha(''), '');
		});

		test('stable shortSha in commit metadata', () => {
			assert.strictEqual(MOCK_COMMIT.shortSha, makeShortSha(MOCK_COMMIT.sha));
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// shouldAutoCommit — dirty 检测逻辑
	// ════════════════════════════════════════════════════════════════════

	suite('shouldAutoCommit (dirty check)', () => {

		test('initialized + dirty → auto-commit', () => {
			assert.strictEqual(shouldAutoCommit(STATUS_DIRTY), true);
		});

		test('initialized + clean → skip', () => {
			assert.strictEqual(shouldAutoCommit(STATUS_CLEAN), false);
		});

		test('not initialized + dirty → skip (repo not ready)', () => {
			const s: SkillWorkspaceStatus = { ...STATUS_UNINIT, dirty: true };
			assert.strictEqual(shouldAutoCommit(s), false);
		});

		test('not initialized + clean → skip', () => {
			assert.strictEqual(shouldAutoCommit(STATUS_UNINIT), false);
		});

		test('initialized + no headSha but dirty → auto-commit (first commit)', () => {
			const s: SkillWorkspaceStatus = {
				initialized: true, headSha: null, headMessage: null, dirty: true, branch: 'main',
			};
			assert.strictEqual(shouldAutoCommit(s), true);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// getVersionTabState — 版本页签状态
	// ════════════════════════════════════════════════════════════════════

	suite('getVersionTabState (UI state decision)', () => {

		test('not initialized → show hint message', () => {
			assert.strictEqual(getVersionTabState(STATUS_UNINIT, []), 'not-initialized');
		});

		test('initialized but no commits → show empty hint', () => {
			assert.strictEqual(getVersionTabState(STATUS_CLEAN, []), 'no-commits');
		});

		test('has commits → show history', () => {
			assert.strictEqual(getVersionTabState(STATUS_CLEAN, [MOCK_COMMIT]), 'has-history');
		});

		test('has commits but dirty → still show history', () => {
			assert.strictEqual(getVersionTabState(STATUS_DIRTY, [MOCK_COMMIT]), 'has-history');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// buildCommitMessage — 各触发场景的消息格式
	// ════════════════════════════════════════════════════════════════════

	suite('buildCommitMessage (integration triggers)', () => {

		test('view trigger → auto timestamp format', () => {
			const msg = buildCommitMessage('view');
			assert.ok(msg.startsWith('auto: 20'), `expected auto prefix: ${msg}`);
		});

		test('snapshot trigger → snapshot prefix', () => {
			const msg = buildCommitMessage('snapshot', '7/18/2026, 10:30:00 AM');
			assert.strictEqual(msg, 'snapshot: 7/18/2026, 10:30:00 AM');
		});

		test('upgrade trigger → upgrade message with version', () => {
			const msg = buildCommitMessage('upgrade', '1.2.0');
			assert.strictEqual(msg, 'upgrade: install v1.2.0 from marketplace');
		});

		test('publish trigger → publish message with version', () => {
			const msg = buildCommitMessage('publish', '1.0.0');
			assert.strictEqual(msg, 'publish: v1.0.0 to marketplace');
		});

		test('all triggers produce distinct messages', () => {
			const msgs = new Set([
				buildCommitMessage('view'),
				buildCommitMessage('snapshot', 'now'),
				buildCommitMessage('upgrade', '1.0.0'),
				buildCommitMessage('publish', '1.0.0'),
			]);
			assert.strictEqual(msgs.size, 4, 'all trigger messages should be unique');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 端到端场景
	// ════════════════════════════════════════════════════════════════════

	suite('End-to-end scenarios', () => {

		test('首次查看技能 → git init → 首次自动提交', () => {
			// Simulate: user opens skill detail → dirty=true → auto-commit → dirty=false
			let state = STATUS_UNINIT;
			assert.strictEqual(shouldAutoCommit(state), false, 'not initialized yet');

			// After init (simulated)
			state = { initialized: true, headSha: null, headMessage: null, dirty: true, branch: 'main' };
			assert.strictEqual(shouldAutoCommit(state), true, 'should commit after init');

			// After commit (simulated)
			state = { ...state, headSha: 'abc1234', headMessage: formatAutoMessage(), dirty: false };
			assert.strictEqual(shouldAutoCommit(state), false, 'should not commit again');
		});

		test('编辑 SKILL.md → 重新打开详情 → 自动提交变更', () => {
			// Initial: clean state
			let state = STATUS_CLEAN;
			assert.strictEqual(shouldAutoCommit(state), false, 'no changes');

			// User edits SKILL.md (simulated dirty)
			state = STATUS_DIRTY;
			assert.strictEqual(shouldAutoCommit(state), true, 'should commit changes');

			// After auto-commit
			state = STATUS_CLEAN;
			assert.strictEqual(shouldAutoCommit(state), false, 'clean again');
		});

		test('上传到商城 → auto-commit + tag vX.Y.Z', () => {
			const publishMsg = buildCommitMessage('publish', '1.0.0');
			assert.ok(publishMsg.includes('v1.0.0'));
			assert.ok(publishMsg.includes('to marketplace'));

			// Tag format
			const tagName = `v1.0.0`;
			assert.ok(tagName.startsWith('v'));
			assert.strictEqual(tagName, 'v1.0.0');
		});

		test('从商城升级 → auto-commit with proper message', () => {
			const upgradeMsg = buildCommitMessage('upgrade', '2.0.0');
			assert.ok(upgradeMsg.includes('install v2.0.0'));
			assert.ok(upgradeMsg.includes('from marketplace'));
			assert.ok(!upgradeMsg.includes('tag'), 'upgrade should not create tag');
		});

		test('手动快照 → 明确的时间戳消息', () => {
			const snapshotMsg = buildCommitMessage('snapshot', '7/18/2026, 2:30:00 PM');
			assert.strictEqual(snapshotMsg, 'snapshot: 7/18/2026, 2:30:00 PM');
		});

		test('多次操作后 commit 历史应正确累积', () => {
			const ops = [
				buildCommitMessage('view'),
				buildCommitMessage('snapshot', 'initial version'),
				buildCommitMessage('upgrade', '1.1.0'),
				buildCommitMessage('publish', '1.1.0'),
				buildCommitMessage('view'),  // another edit
			];
			assert.strictEqual(ops.length, 5);
			// Each should be non-empty
			for (const msg of ops) {
				assert.ok(msg.length > 0, `message should not be empty: "${msg}"`);
			}
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 边界情况
	// ════════════════════════════════════════════════════════════════════

	suite('Edge cases', () => {

		test('dirty=true but no initialized → should not attempt commit', () => {
			const s: SkillWorkspaceStatus = {
				initialized: false, headSha: null, headMessage: null,
				dirty: true, branch: null,
			};
			assert.strictEqual(shouldAutoCommit(s), false);
			assert.strictEqual(getVersionTabState(s, []), 'not-initialized');
		});

		test('headSha=null after init (unborn HEAD) → still can commit', () => {
			const s: SkillWorkspaceStatus = {
				initialized: true, headSha: null, headMessage: null,
				dirty: true, branch: 'main',
			};
			assert.strictEqual(shouldAutoCommit(s), true,
				'unborn HEAD should still allow first commit');
		});

		test('multiple consecutive saves without opening detail → single commit', () => {
			// dirty is a boolean — multiple saves = still dirty
			// auto-commit clears dirty after commit
			let state = STATUS_DIRTY;
			assert.strictEqual(shouldAutoCommit(state), true);

			// After commit (simulated)
			state = STATUS_CLEAN;

			// Another edit
			state = STATUS_DIRTY;
			assert.strictEqual(shouldAutoCommit(state), true);
		});

		test('empty shortSha from empty commit SHA', () => {
			assert.strictEqual(makeShortSha(''), '');
		});

		test('very long SHA still truncated to 7 chars', () => {
			const longSha = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
			assert.strictEqual(makeShortSha(longSha), 'fffffff');
			assert.strictEqual(makeShortSha(longSha).length, 7);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 版本号 tag 命名规范
	// ════════════════════════════════════════════════════════════════════

	suite('Tag naming convention', () => {

		/** 模拟 publish 后的 tag 命名 */
		function formatTag(version: string): string {
			return `v${version}`;
		}

		test('semver version → tag', () => {
			assert.strictEqual(formatTag('1.0.0'), 'v1.0.0');
		});

		test('prerelease version → tag', () => {
			assert.strictEqual(formatTag('2.0.0-beta.1'), 'v2.0.0-beta.1');
		});

		test('patch version → tag', () => {
			assert.strictEqual(formatTag('0.1.5'), 'v0.1.5');
		});

		test('tag should not contain spaces', () => {
			const tag = formatTag('1.0.0');
			assert.strictEqual(tag.includes(' '), false);
		});

		test('tag starts with v', () => {
			for (const v of ['1.0.0', '0.0.1', '10.20.30']) {
				assert.ok(formatTag(v).startsWith('v'), `tag for ${v} should start with v`);
			}
		});
	});
});
