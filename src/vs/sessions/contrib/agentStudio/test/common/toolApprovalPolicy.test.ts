/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isSandboxFileWriteAutoApproved, isDestructiveToolCall } from '../../common/toolApprovalPolicy.js';
import { ToolSecurityLevel } from '../../common/providers.js';

/**
 * 用户策略（2026-08-21）：操作沙箱内的文件、非删除类操作 → 直接放行。
 *
 * 这些用例锁定策略边界。**新增破坏性工具时若有人误改判定，反向断言会当场失败。**
 */
suite('toolApprovalPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const def = (name: string, category?: string) => ({
		name,
		description: '',
		inputSchema: { type: 'object' as const },
		category,
		source: 'builtin',
		securityLevel: ToolSecurityLevel.Dangerous,
	} as any);

	suite('放行：沙箱内非删除类文件操作', () => {
		test('内置 patch / file_write（category=filesystem）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('patch', 'filesystem')), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('file_write', 'filesystem')), true);
		});
		test('file_read 也归入 filesystem（实际走 Safe 早返回，不影响）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('file_read', 'filesystem')), true);
		});
		test('★ 未来新增的文件工具自动覆盖（无需改清单）', () => {
			for (const n of ['multi_edit', 'apply_diff', 'create_file', 'file_append', 'mkdir', 'touch_file']) {
				assert.strictEqual(isSandboxFileWriteAutoApproved(def(n)), true, n);
			}
		});
		test('★ MCP 文件工具（无 filesystem category）靠动词识别', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_file', 'mcp')), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('edit_block', 'mcp')), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('save_file', undefined)), true);
		});
		test('category 大小写不敏感', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('foo_tool', 'FileSystem')), true);
		});
		test('工具名大小写不敏感', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('File_Write')), true);
		});
	});

	suite('★ 不放行：删除类（用户明确要求仍需确认）', () => {
		test('delete / remove / unlink / trash / destroy / purge / drop', () => {
			for (const n of ['file_delete', 'delete_project', 'remove_file', 'web_recipe_remove',
				'unlink_path', 'trash_file', 'destroy_index', 'purge_cache', 'drop_table']) {
				assert.strictEqual(isSandboxFileWriteAutoApproved(def(n, 'filesystem')), false, n);
			}
		});
		test('★ 删除类即使 category=filesystem 也不放行（排除优先于纳入）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('file_delete', 'filesystem')), false);
		});
		test('★ 名字里同时含 write 和 delete → 仍不放行', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_then_delete', 'filesystem')), false);
		});
	});

	suite('★ 不放行：move / rename（本系统无法回滚）', () => {
		test('move / rename 排除', () => {
			// checkpoint 只快照被写入的目标文件，move 会让原路径消失且无快照
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('move_file', 'filesystem')), false);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('file_rename', 'filesystem')), false);
		});
	});

	suite('★ 不放行：shell / 任意代码执行', () => {
		test('terminal / execute_code / bash 等一律不放行', () => {
			for (const n of ['terminal', 'execute_code', 'run_command', 'execute_command',
				'bash_tool', 'shell_exec', 'spawn_process']) {
				assert.strictEqual(isSandboxFileWriteAutoApproved(def(n, 'terminal')), false, n);
			}
		});
		test('★ shell 排除优先于文件动词（`write` 也救不了它）', () => {
			// 关键：三道闸门对任意命令全不成立，名字里带 write 也不能放行
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('shell_write', 'filesystem')), false);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('exec_and_write', 'filesystem')), false);
		});
	});

	suite('保守默认：判不出来就走审批', () => {
		test('无关工具不放行', () => {
			for (const n of ['web_extract', 'new_agent', 'search_code', 'memory_recall', 'kanban_create']) {
				assert.strictEqual(isSandboxFileWriteAutoApproved(def(n, 'web')), false, n);
			}
		});
		test('undefined / 空名不放行（不崩）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(undefined), false);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('')), false);
		});
		test('无 category 且无文件动词 → 不放行', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('mystery_tool')), false);
		});
	});

	/**
	 * 破坏性调用强制审批。背景：`checkAndApprove` 读 `securityLevel ?? Safe`，
	 * 而 `inferSecurityLevel` 是死代码 → 85 个工具里仅 4 个声明 Dangerous，
	 * 其余删除类工具原本**无审批直接执行**。
	 */
	suite('isDestructiveToolCall — 强制审批', () => {
		test('★ 审计实测的 4 个单一用途删除工具全部命中', () => {
			for (const n of ['delete_project', 'memory_delete', 'memory_forget', 'web_recipe_remove']) {
				assert.strictEqual(isDestructiveToolCall(n, {}), true, n);
			}
		});
		test('其他破坏性动词也命中（未来新增工具自动纳入）', () => {
			for (const n of ['cache_purge', 'index_destroy', 'file_unlink', 'wipe_state', 'trash_item', 'drop_table']) {
				assert.strictEqual(isDestructiveToolCall(n, {}), true, n);
			}
		});
		test('★ kanban_unblock 不命中（描述含 "Moves it back" 的误报已避免）', () => {
			// 只按工具名匹配，不看 description —— 否则状态流转工具会被误拦
			assert.strictEqual(isDestructiveToolCall('kanban_unblock', {}), false);
		});
		test('★ 刻意不含 move/rename（防误伤未来的 kanban_move_task）', () => {
			assert.strictEqual(isDestructiveToolCall('kanban_move_task', {}), false);
			assert.strictEqual(isDestructiveToolCall('file_rename', {}), false);
		});
		test('常规工具不命中', () => {
			for (const n of ['file_write', 'patch', 'search_code', 'index_repository', 'terminal', 'memory_recall']) {
				assert.strictEqual(isDestructiveToolCall(n, {}), false, n);
			}
		});

		suite('★ 多操作工具按操作参数判定（不整体标级）', () => {
			test('skill_manage: 仅 action=delete 需审批', () => {
				assert.strictEqual(isDestructiveToolCall('skill_manage', { action: 'delete', name: 'x' }), true);
				for (const a of ['create', 'edit', 'patch']) {
					assert.strictEqual(isDestructiveToolCall('skill_manage', { action: a, name: 'x' }), false, a);
				}
			});
			test('memory_governance: delete/bulk_delete 需审批，audit 不需要', () => {
				assert.strictEqual(isDestructiveToolCall('memory_governance', { action: 'delete' }), true);
				assert.strictEqual(isDestructiveToolCall('memory_governance', { action: 'bulk_delete' }), true);
				assert.strictEqual(isDestructiveToolCall('memory_governance', { action: 'audit' }), false);
			});
			test('取值大小写不敏感', () => {
				assert.strictEqual(isDestructiveToolCall('skill_manage', { action: 'DELETE' }), true);
			});
			test('缺 action / args 非对象 → 不强制（走工具自身声明）', () => {
				assert.strictEqual(isDestructiveToolCall('skill_manage', {}), false);
				assert.strictEqual(isDestructiveToolCall('skill_manage', undefined), false);
				assert.strictEqual(isDestructiveToolCall('skill_manage', 'not-an-object'), false);
				assert.strictEqual(isDestructiveToolCall('skill_manage', { action: 123 }), false);
			});
		});

		test('空名不崩', () => {
			assert.strictEqual(isDestructiveToolCall('', {}), false);
			assert.strictEqual(isDestructiveToolCall(undefined as any, {}), false);
		});

		test('★ 与自动放行互斥：破坏性调用不会被 auto-approve 命中', () => {
			for (const n of ['delete_project', 'memory_delete', 'memory_forget', 'web_recipe_remove']) {
				assert.strictEqual(isDestructiveToolCall(n, {}), true, n);
				assert.strictEqual(isSandboxFileWriteAutoApproved(def(n, 'filesystem')), false, n);
			}
			// skill_manage(delete) 也不能被自动放行
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('skill_manage', 'skills')), false);
		});
	});
});
