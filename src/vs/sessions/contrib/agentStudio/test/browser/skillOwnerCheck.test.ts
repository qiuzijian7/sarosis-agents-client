/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 所有权检查测试 — 验证上传/升级/编辑按钮的权限控制逻辑。
 *
 * 测试场景：
 *   - 包存在 + 是 owner      → 显示升级/最新按钮
 *   - 包存在 + 非 owner       → 隐藏全部操作按钮，显示只读
 *   - 包不存在（首次上传）    → 显示上传按钮（无限制）
 *   - 包存在 + 无用户信息     → 显示上传按钮（兜底允许）
 *   - getPackage 抛异常       → 显示上传按钮（首次上传）
 *   - 未登录                  → 提示登录
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

// ─── Pure logic helpers (模拟所有权判断的核心逻辑) ──────────────────────────

interface PackageAuthor {
	readonly id: string;
	readonly username: string;
	readonly displayName?: string;
}

interface CurrentUser {
	readonly id: string;
	readonly username: string;
	readonly displayName?: string;
}

/**
 * 判断当前用户是否为包的所有者。
 * 对应 resourceManagerEditorPane._addMarketplaceStatusButtons 中的判断逻辑。
 */
function isOwnerOfPackage(
	packageAuthor: PackageAuthor | undefined,
	currentUser: CurrentUser | undefined,
): boolean {
	if (!packageAuthor?.id || !currentUser?.id) {
		// 包无作者 或 用户未登录 → 无法判断，允许操作（兜底）
		return true;
	}
	return packageAuthor.id === currentUser.id;
}

/**
 * 判断是否应隐藏上传/升级按钮（非所有者视角）。
 * 规则：
 *   - getPackage 成功 + 包有作者 + 当前用户已登录 + 不是所有者 → 隐藏
 *   - 其他情况 → 显示
 */
function shouldHideUploadButtons(
	getPackageResult: 'success' | 'error',
	packageAuthor?: PackageAuthor,
	currentUser?: CurrentUser,
): boolean {
	if (getPackageResult === 'error') {
		// 包不存在 → 显示上传按钮（首次上传无限制）
		return false;
	}
	return !isOwnerOfPackage(packageAuthor, currentUser);
}

/**
 * 判断是否应锁定编辑面板（只读模式）。
 * 对应 resourceManagerEditorPane._checkOwnerLock 逻辑。
 */
function shouldLockEditor(
	getPackageResult: 'success' | 'error',
	packageAuthor?: PackageAuthor,
	currentUser?: CurrentUser,
): boolean {
	if (getPackageResult === 'error') {
		// 包不在商城 → 本地skill，允许编辑
		return false;
	}
	return !isOwnerOfPackage(packageAuthor, currentUser);
}

// ─── Test data ───────────────────────────────────────────────────────────────

const OWNER_AUTHOR: PackageAuthor = { id: 'user-001', username: 'alice' };
const OTHER_AUTHOR: PackageAuthor = { id: 'user-002', username: 'bob' };
const NO_ID_AUTHOR: PackageAuthor = { id: '', username: 'unknown' };
const USER_ALICE: CurrentUser = { id: 'user-001', username: 'alice' };
const USER_BOB: CurrentUser = { id: 'user-002', username: 'bob' };
const USER_NO_ID: CurrentUser = { id: '', username: '' };

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('Skill Owner Check', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ════════════════════════════════════════════════════════════════════
	// isOwnerOfPackage — 核心所有权判断
	// ════════════════════════════════════════════════════════════════════

	suite('isOwnerOfPackage', () => {

		test('owner matches current user → true', () => {
			assert.strictEqual(isOwnerOfPackage(OWNER_AUTHOR, USER_ALICE), true);
		});

		test('owner does NOT match current user → false', () => {
			assert.strictEqual(isOwnerOfPackage(OTHER_AUTHOR, USER_ALICE), false);
		});

		test('no author id → true (fallback allow)', () => {
			assert.strictEqual(isOwnerOfPackage(NO_ID_AUTHOR, USER_ALICE), true);
		});

		test('author undefined → true (fallback allow)', () => {
			assert.strictEqual(isOwnerOfPackage(undefined, USER_ALICE), true);
		});

		test('no current user → true (fallback allow)', () => {
			assert.strictEqual(isOwnerOfPackage(OWNER_AUTHOR, undefined), true);
		});

		test('no current user id → true (fallback allow)', () => {
			assert.strictEqual(isOwnerOfPackage(OWNER_AUTHOR, USER_NO_ID), true);
		});

		test('both author and user undefined → true', () => {
			assert.strictEqual(isOwnerOfPackage(undefined, undefined), true);
		});

		test('same user id, different username → true (id is authoritative)', () => {
			const author: PackageAuthor = { id: 'user-001', username: 'old_name' };
			const user: CurrentUser = { id: 'user-001', username: 'new_name' };
			assert.strictEqual(isOwnerOfPackage(author, user), true);
		});

		test('same username, different id → false (id is authoritative)', () => {
			const author: PackageAuthor = { id: 'user-001', username: 'alice' };
			const user: CurrentUser = { id: 'user-002', username: 'alice' };
			assert.strictEqual(isOwnerOfPackage(author, user), false);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// shouldHideUploadButtons — 上传/升级按钮显隐逻辑
	// ════════════════════════════════════════════════════════════════════

	suite('shouldHideUploadButtons', () => {

		test('package exists + is owner → show buttons (not hidden)', () => {
			assert.strictEqual(shouldHideUploadButtons('success', OWNER_AUTHOR, USER_ALICE), false);
		});

		test('package exists + is NOT owner → hide buttons', () => {
			assert.strictEqual(shouldHideUploadButtons('success', OTHER_AUTHOR, USER_ALICE), true);
		});

		test('package does NOT exist (first upload) → show buttons', () => {
			assert.strictEqual(shouldHideUploadButtons('error', undefined, USER_ALICE), false);
		});

		test('package does NOT exist (first upload) + has weird author → show buttons', () => {
			assert.strictEqual(shouldHideUploadButtons('error', OTHER_AUTHOR, USER_ALICE), false,
				'first upload should always allow regardless of any author info');
		});

		test('package exists + no author id → show buttons (fallback)', () => {
			assert.strictEqual(shouldHideUploadButtons('success', NO_ID_AUTHOR, USER_ALICE), false);
		});

		test('package exists + no current user → show buttons (fallback)', () => {
			assert.strictEqual(shouldHideUploadButtons('success', OWNER_AUTHOR, undefined), false);
		});

		test('package exists + author undefined → show buttons (fallback)', () => {
			assert.strictEqual(shouldHideUploadButtons('success', undefined, USER_BOB), false);
		});

		test('package exists + both ids empty → show buttons (fallback)', () => {
			assert.strictEqual(shouldHideUploadButtons('success', NO_ID_AUTHOR, USER_NO_ID), false);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// shouldLockEditor — 编辑面板锁定逻辑
	// ════════════════════════════════════════════════════════════════════

	suite('shouldLockEditor', () => {

		test('package exists + is owner → do NOT lock (allow editing)', () => {
			assert.strictEqual(shouldLockEditor('success', OWNER_AUTHOR, USER_ALICE), false);
		});

		test('package exists + is NOT owner → lock editor', () => {
			assert.strictEqual(shouldLockEditor('success', OTHER_AUTHOR, USER_ALICE), true);
		});

		test('package does NOT exist (local skill) → do NOT lock', () => {
			assert.strictEqual(shouldLockEditor('error', undefined, USER_ALICE), false,
				'local skills should always be editable');
		});

		test('package does NOT exist + not owner → do NOT lock', () => {
			assert.strictEqual(shouldLockEditor('error', OTHER_AUTHOR, USER_ALICE), false,
				'first-time upload, editor should not be locked');
		});

		test('package exists + no author → do NOT lock (fallback)', () => {
			assert.strictEqual(shouldLockEditor('success', undefined, USER_BOB), false);
		});

		test('package exists + no current user → do NOT lock (fallback)', () => {
			assert.strictEqual(shouldLockEditor('success', OWNER_AUTHOR, undefined), false);
		});

		test('package exists + no author id → do NOT lock (fallback)', () => {
			assert.strictEqual(shouldLockEditor('success', NO_ID_AUTHOR, USER_BOB), false);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 端到端场景模拟（模拟完整的 UI 行为逻辑）
	// ════════════════════════════════════════════════════════════════════

	suite('End-to-end scenarios', () => {

		/**
		 * 模拟完整的 UI 决策流程：
		 * 1. 检查包是否存在 → 决定首次上传 vs 更新
		 * 2. 检查所有权 → 决定是否隐藏按钮和锁定面板
		 */
		function decideUIBehavior(
			getPackageResult: 'success' | 'error',
			packageAuthor?: PackageAuthor,
			currentUser?: CurrentUser,
		): {
			showUpload: boolean;      // 显示"上传到商城"按钮
			showUpgrade: boolean;     // 显示"升级"按钮或"已是最新"徽章
			showDelete: boolean;      // 显示"卸载"按钮
			showEdit: boolean;        // 显示"编辑文件"按钮
			showToggle: boolean;      // 显示"启用/禁用"开关
			isReadonly: boolean;      // 面板是否为只读
		} {
			const locked = shouldLockEditor(getPackageResult, packageAuthor, currentUser);
			const hideMarketBtns = shouldHideUploadButtons(getPackageResult, packageAuthor, currentUser);

			if (getPackageResult === 'error') {
				// 包不存在 → 首次上传
				return {
					showUpload: true,
					showUpgrade: false,
					showDelete: true,
					showEdit: true,
					showToggle: true,
					isReadonly: false,
				};
			}

			if (hideMarketBtns) {
				// 包存在 + 非所有者 → 只读模式
				return {
					showUpload: false,
					showUpgrade: false,
					showDelete: false,
					showEdit: false,
					showToggle: false,
					isReadonly: true,
				};
			}

			// 包存在 + 所有者 → 全部可用
			return {
				showUpload: false,
				showUpgrade: true,
				showDelete: true,
				showEdit: true,
				showToggle: true,
				isReadonly: false,
			};
		}

		test('owner viewing their own skill → full control', () => {
			const ui = decideUIBehavior('success', OWNER_AUTHOR, USER_ALICE);
			assert.strictEqual(ui.showUpload, false, 'already on marketplace, no upload');
			assert.strictEqual(ui.showUpgrade, true, 'should show upgrade/status');
			assert.strictEqual(ui.showDelete, true, 'can delete locally');
			assert.strictEqual(ui.showEdit, true, 'can edit');
			assert.strictEqual(ui.showToggle, true, 'can enable/disable');
			assert.strictEqual(ui.isReadonly, false, 'not readonly');
		});

		test('non-owner viewing someone else\'s skill → readonly', () => {
			const ui = decideUIBehavior('success', OTHER_AUTHOR, USER_ALICE);
			assert.strictEqual(ui.showUpload, false);
			assert.strictEqual(ui.showUpgrade, false, 'cannot upgrade');
			assert.strictEqual(ui.showDelete, false, 'cannot delete');
			assert.strictEqual(ui.showEdit, false, 'cannot edit');
			assert.strictEqual(ui.showToggle, false, 'cannot toggle');
			assert.strictEqual(ui.isReadonly, true, 'should be readonly');
		});

		test('new skill not on marketplace → can upload and edit', () => {
			const ui = decideUIBehavior('error', undefined, USER_ALICE);
			assert.strictEqual(ui.showUpload, true, 'can upload to marketplace');
			assert.strictEqual(ui.showUpgrade, false, 'no upgrade since not on marketplace');
			assert.strictEqual(ui.showDelete, true);
			assert.strictEqual(ui.showEdit, true);
			assert.strictEqual(ui.showToggle, true);
			assert.strictEqual(ui.isReadonly, false);
		});

		test('new skill not on marketplace + different user → still can upload', () => {
			const ui = decideUIBehavior('error', OTHER_AUTHOR, USER_ALICE);
			assert.strictEqual(ui.showUpload, true,
				'first-time upload should always be allowed');
			assert.strictEqual(ui.isReadonly, false,
				'local skill should be editable');
		});

		test('package exists + no author id → fallback full access', () => {
			// If server returns a package without author info, we allow
			const ui = decideUIBehavior('success', NO_ID_AUTHOR, USER_BOB);
			assert.strictEqual(ui.showUpgrade, true, 'fallback: show upgrade even for unknown owner');
			assert.strictEqual(ui.isReadonly, false, 'fallback: not locked');
		});

		test('package exists + no current user → fallback full access', () => {
			const ui = decideUIBehavior('success', OWNER_AUTHOR, undefined);
			assert.strictEqual(ui.showUpgrade, true, 'fallback: show upgrade');
			assert.strictEqual(ui.isReadonly, false, 'fallback: not locked');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 边界情况
	// ════════════════════════════════════════════════════════════════════

	suite('Edge cases', () => {

		test('package exists + author is owner + user not logged in → allow', () => {
			// Not logged in means currentUser is undefined
			assert.strictEqual(shouldLockEditor('success', OWNER_AUTHOR, undefined), false,
				'when not logged in, fallback to allow editing');
			assert.strictEqual(shouldHideUploadButtons('success', OWNER_AUTHOR, undefined), false,
				'when not logged in, show buttons');
		});

		test('author has displayName only but no id → allow', () => {
			const author: PackageAuthor = { id: '', username: '', displayName: 'Some Name' };
			assert.strictEqual(isOwnerOfPackage(author, USER_ALICE), true,
				'no id means cannot verify, allow');
		});

		test('user switches identity (different login) → should lock', () => {
			const ui = decideUIBehavior('success', OWNER_AUTHOR, USER_BOB);
			assert.strictEqual(ui.isReadonly, true,
				'different user should see readonly mode');
			assert.strictEqual(ui.showUpgrade, false,
				'different user should not see upgrade');
		});
	});
});
