/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	isSandboxFileWriteAutoApproved, isDestructiveToolCall, detectForcedAskCommand, isMcpSourcedTool,
	classifyToolCategory, normalizeAutoApprove, TOOL_CATEGORIES,
	DEFAULT_AUTO_APPROVE, COMPAT_AUTO_APPROVE, CLINE_DEFAULT_AUTO_APPROVE,
} from '../../common/toolApprovalPolicy.js';
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
		test('★ 无 category 的写工具靠动词识别（兜底路径）', () => {
			// ⚠ 2026-09-13：真实的 MCP 工具 category 是 `mcp:<serverId>`
			// （见 `McpToolProvider._toDefinition`），已由下方「MCP 来源的工具」suite **排除**。
			// 本用例只覆盖「无 category」的兜底动词匹配 —— 原先这里断言 MCP 工具应自动放行，
			// 与新行为矛盾，已改写。
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_file', undefined)), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('edit_block', undefined)), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('save_file', undefined)), true);
		});
		test('category 大小写不敏感', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('foo_tool', 'FileSystem')), true);
		});
		test('工具名大小写不敏感', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('File_Write')), true);
		});
	});

	/**
	 * ★ 2026-09-13 修正：MCP 来源的工具**不再自动放行**（改为走审批）。
	 *
	 * `isSandboxFileWriteAutoApproved` 的放行论证建立在「三道闸门」上，但对 MCP 工具：
	 *   ① 路径沙箱 / `writeDenyList` **都不经过** —— `McpToolProvider.executeTool` 把
	 *      arguments 直接透传给 server（`routed.tool.call(call.arguments, ...)`），
	 *      不做任何路径解析；server 是否尊重 roots 属其自身行为，不是我们的边界。
	 *   ③ 不创建 checkpoint → 写入**不可回滚**（与 move/rename 被排除同理）。
	 * ⇒ 与 {@link SHELL_LIKE_VERBS} 的排除论证完全同构。
	 *
	 * 真实缺口：`~/.vssaros/User/settings.json`（**provider apiKey 所在**）不在
	 * `isProtectedPath` 里，MCP 写工具此前可**免审批**改写它。
	 */
	suite('★ 不放行：MCP 来源的工具（三道闸门全不成立）', () => {

		/** MCP 工具的真实形态：`category = mcp:<serverId>`。 */
		const mcp = (name: string, serverId = 'filesystem') => def(name, `mcp:${serverId}`);

		test('★ MCP 文件写工具不再自动放行（本次修正的核心）', () => {
			for (const n of [
				'write_file', 'edit_file', 'create_file', 'append_file',
				'save_file', 'write_multiple_files', 'edit_block',
			]) {
				assert.strictEqual(isSandboxFileWriteAutoApproved(mcp(n)), false, n);
			}
		});

		test('★ 不受 `filesystem` 类目豁免影响（category 是 `mcp:*` 而非 `filesystem`）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_file', 'mcp:filesystem')), false);
		});

		test('★ category 前缀大小写不敏感', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_file', 'MCP:filesystem')), false);
		});

		test('★★ 控制组：内置文件工具仍自动放行（不得误伤高频工作流）', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('file_write', 'filesystem')), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('patch', 'filesystem')), true);
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('write_file', 'filesystem')), true,
				'category=filesystem 的是内置路径，仍放行');
		});

		test('★★ 控制组：名字含 mcp 但 category 不是 mcp: 的工具按原规则判定', () => {
			assert.strictEqual(isSandboxFileWriteAutoApproved(def('mcp_write')), true,
				'无 category → 走动词规则（write）→ 仍放行');
		});

		/**
		 * ★ 2026-09-13：「MCP 来源」判定的**单一真源**。
		 *
		 * 两处消费它：`isSandboxFileWriteAutoApproved` 步骤 3（写工具不自动放行）与
		 * `ToolApprovalService.checkAndApprove` 的 `Safe` 早返回（MCP 自报 Safe 也不免审批）。
		 */
		test('★ isMcpSourcedTool：按 category 前缀判定，大小写不敏感', () => {
			assert.strictEqual(isMcpSourcedTool(def('x', 'mcp:filesystem')), true);
			assert.strictEqual(isMcpSourcedTool(def('x', 'MCP:filesystem')), true);
			assert.strictEqual(isMcpSourcedTool(def('x', 'filesystem')), false);
			assert.strictEqual(isMcpSourcedTool(def('x', 'mcp')), false, '`mcp` 无冒号 → 不是本前缀');
			assert.strictEqual(isMcpSourcedTool(def('x')), false);
			assert.strictEqual(isMcpSourcedTool(undefined), false);
		});
	});

	/**
	 * ★★ 类别模型（Phase 1，2026-09-13）—— 「默认全问 + 类别自动批准」的**粒度真源**。
	 *
	 * 它是 `checkAndApprove` 的档位查表依据，也是 UI 档位、配置序列化的共同词汇。
	 * 判定顺序里 **MCP 必须最优先** —— 否则「自称只读」的 MCP 写工具会落进 `read`，
	 * 把「自报注解不可信」这条结论（本文件上方 suite）在类别层重新打开。
	 */
	suite('★ classifyToolCategory — 类别真源', () => {

		test('★★ MCP 优先于一切（自报 Safe 也不得落进 read）', () => {
			assert.strictEqual(classifyToolCategory(def('write_file', 'mcp:fs')), 'mcp');
			assert.strictEqual(
				classifyToolCategory({ ...def('search_graph', 'mcp:x'), securityLevel: ToolSecurityLevel.Safe } as any),
				'mcp',
				'即便自称 Safe，也必须归 mcp（其 securityLevel 不可验证）',
			);
		});

		test('★ shell / terminal → execute', () => {
			for (const n of ['terminal', 'execute_code', 'shell', 'bash']) {
				assert.strictEqual(classifyToolCategory(def(n, 'shell')), 'execute', n);
			}
			// 无 category 时靠 shell 动词兜底
			assert.strictEqual(classifyToolCategory(def('terminal')), 'execute');
			assert.strictEqual(classifyToolCategory(def('execute_code')), 'execute');
		});

		test('★ 文件类：写 / 删 → edit，只读 → read', () => {
			assert.strictEqual(classifyToolCategory(def('file_write', 'filesystem')), 'edit');
			assert.strictEqual(classifyToolCategory(def('patch', 'filesystem')), 'edit');
			assert.strictEqual(classifyToolCategory(def('delete_file', 'filesystem')), 'edit');
			assert.strictEqual(classifyToolCategory(def('file_read', 'filesystem')), 'read');
			assert.strictEqual(classifyToolCategory(def('list_files', 'filesystem')), 'read');
		});

		test('★ web → web（按 category 或名字线索）', () => {
			assert.strictEqual(classifyToolCategory(def('anything', 'web')), 'web');
			assert.strictEqual(classifyToolCategory(def('web_fetch')), 'web');
			assert.strictEqual(classifyToolCategory(def('browser_click', 'browser')), 'web');
		});

		test('★ 兜底：Safe → read；其余 → other', () => {
			assert.strictEqual(
				classifyToolCategory({ ...def('kanban_unblock'), securityLevel: ToolSecurityLevel.Safe } as any),
				'read',
				'声明为 Safe 且无写动词 → 按只读处理（与 Safe 早返回同口径）',
			);
			assert.strictEqual(classifyToolCategory(def('kanban_unblock')), 'other', 'def() 默认 Dangerous');
		});

		test('★ 空 / undefined → other（不崩）', () => {
			assert.strictEqual(classifyToolCategory(undefined), 'other');
		});
	});

	/**
	 * ★★ 档位配置的**宽容解析**：坏值一律退化为默认档。
	 *
	 * 与 `toolAllowStore` 同一纪律 —— 配置是**安全状态**，宁可退回「该问就问」，
	 * 也不要把坏数据解释成放行。
	 */
	suite('★ normalizeAutoApprove — 宽容解析与预设', () => {

		test('★★ 坏值 / 缺失一律退化为默认档', () => {
			for (const bad of [undefined, null, 'nope', 42, { edit: 'yes' }, { edit: true }, { unknown: 'auto' }]) {
				const r = normalizeAutoApprove(bad);
				for (const c of TOOL_CATEGORIES) {
					assert.strictEqual(r[c], DEFAULT_AUTO_APPROVE[c], `${JSON.stringify(bad)} → ${c}`);
				}
			}
		});

		test('★ 合法档位原样保留，未提供的类别回落默认', () => {
			const r = normalizeAutoApprove({ edit: 'ask', execute: 'auto' });
			assert.strictEqual(r['edit'], 'ask');
			assert.strictEqual(r['execute'], 'auto');
			assert.strictEqual(r['read'], DEFAULT_AUTO_APPROVE['read'], '未提供的类别回落默认');
		});

		/**
		 * ★★ **产品策略**：**沙箱内、非删除类的操作，直接放行**（用户决策 2026-08-21，
		 * 2026-09-13 明确确认继续沿用）。
		 *
		 * ## 这组用例存在的意义
		 *
		 * 让默认档的变更**显式发生**：谁想翻转默认值（例如改成 Cline 式「默认全问」），
		 * 就必须先让这里失败、再来改用例 —— 而不是顺手改一行常量就**悄悄改变产品行为**。
		 *
		 * ## 策略成立的三个前提（都由更早的层保证，不由档位放宽）
		 *
		 * | 分句 | 由谁保证 |
		 * |---|---|
		 * | 「**沙箱内**」 | `resolveAndCheckWorkspacePath(checkSandbox=true)` 越界抛 `SandboxViolationError` |
		 * | 「**非删除类**」 | `isSandboxFileWriteAutoApproved` 排除 delete/remove/move/rename；shell 侧 `detectForcedAskCommand` |
		 * | 「**可撤销**」 | `file_write` / `patch` 写盘前 `captureBeforeToolEdit` 生成 checkpoint |
		 */
		suite('★★ 产品策略：沙箱内非删除类操作直接放行（默认档）', () => {

			test('★★ 默认档 = 兼容档，且**不是** Cline 的「默认全问」', () => {
				assert.deepStrictEqual({ ...DEFAULT_AUTO_APPROVE }, { ...COMPAT_AUTO_APPROVE },
					'默认档必须是兼容档 —— 它编码「沙箱内非删除类操作直接放行」这条产品策略');
				assert.notDeepStrictEqual({ ...DEFAULT_AUTO_APPROVE }, { ...CLINE_DEFAULT_AUTO_APPROVE },
					'Cline 式「默认全问」已评估并否决（2026-09-13）—— 不得成为默认值');
			});

			test('★★ 逐条钉住策略的四个分句', () => {
				// 「沙箱内非删除类操作」→ edit 必须 auto
				assert.strictEqual(DEFAULT_AUTO_APPROVE['edit'], 'auto', '沙箱内非删除类写入免审批');
				// 只读工具不问
				assert.strictEqual(DEFAULT_AUTO_APPROVE['read'], 'auto');
				// 终端**不是**无条件放行：只放行「已知只读 / 验证构建」（safe 档）
				assert.strictEqual(DEFAULT_AUTO_APPROVE['execute'], 'safe', '终端是 safe 档而非 auto');
				// 这三类本就弹审批
				for (const c of ['web', 'mcp', 'other'] as const) {
					assert.strictEqual(DEFAULT_AUTO_APPROVE[c], 'ask', `${c} 应弹审批`);
				}
			});

			test('★★ 策略边界：删除 / 移动类**一律不自动放行**（「非删除类」的实现）', () => {
				// 删除类：用户明确要求删除也仍需确认（共享 DESTRUCTIVE_CORE_VERBS）
				// 移动/改名：captureBeforeToolEdit 只快照被写入的目标文件，原路径凭空消失
				//   → 本系统里**无法回滚**，与「非删除即可放行」背后的『可撤销』前提不符。
				for (const n of ['delete_file', 'remove_file', 'unlink_file', 'trash_file', 'move_file', 'rename_file']) {
					assert.strictEqual(
						isSandboxFileWriteAutoApproved(def(n, 'filesystem')), false,
						`${n} 属删除/移动类，不得自动放行`,
					);
				}
				// shell 侧：删除类命令由 forcedAsk 兜住（不可回滚 → 逐次确认）
				assert.ok(detectForcedAskCommand('rm -rf build'), '删除类 shell 命令必须强制审批');
			});

			test('★ Cline 预设与兼容档的差别必须只有 edit / execute 两处', () => {
				assert.deepStrictEqual(
					TOOL_CATEGORIES.filter(c => CLINE_DEFAULT_AUTO_APPROVE[c] !== COMPAT_AUTO_APPROVE[c]),
					['edit', 'execute'],
					'差别多一处都说明有人改了某个预设却没同步测试',
				);
			});
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
			test('★ process（P1-5）：仅 terminate 需审批（list/output/wait 是读/等）', () => {
				assert.strictEqual(isDestructiveToolCall('process', { action: 'terminate', pid: 't1' }), true);
				for (const a of ['list', 'output', 'wait']) {
					assert.strictEqual(isDestructiveToolCall('process', { action: a, pid: 't1' }), false, a);
				}
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

		/**
		* 删除类命令的「强制审批」（P2，2026-09-13，对齐 MiMo `bash_delete` FORCED_ASK）。
		*
		* 缺口：`commandSafety.HARDLINE_PATTERNS` 只拦灾难性删除（`rm -rf /`、`mkfs`…），
		* 其余删除走普通审批 —— 而 `terminal` 是 Dangerous，用户点过「始终允许」后
		* `rm -rf <子目录>` 就**永久免审批**，且删除**没有 checkpoint**（不可回滚）。
		* 故这些命令必须逐次确认，且不参与 always-allow / 模型审查两条免打扰通道。
		*/
		suite('detectForcedAskCommand — 删除类强制审批', () => {

		test('★ 删除类命令头命中（含 PowerShell / cmd 别名与包装器）', () => {
			for (const c of [
				'rm -rf src/foo',
				'rmdir /s /q build',
				'cd src && rm -rf dist',
				'git status | rm -rf tmp',
				'Remove-Item -Recurse -Force out',
				'del /f /s /q dist',
				'unlink path/to/file',
				'shred -u secrets.txt',
				'sudo rm -rf /var/log/app',
				'find . -name "*.log" -exec rm {} ;',
				'ls | xargs rm -f',
			]) {
				assert.ok(detectForcedAskCommand(c), `应命中：${c}`);
			}
		});

		test('★ 破坏性 git 子命令命中', () => {
			for (const c of [
				'git reset --hard',
				'git reset --hard HEAD~3',
				'git clean -fd',
				'git clean -fdx',
				'git branch -D feature/x',
				'git push --force origin main',
				'git push -f',
				'git stash drop',
				'git stash clear',
			]) {
				assert.ok(detectForcedAskCommand(c), `应命中：${c}`);
			}
		});

		test('★★ 控制组 A：只读 / 安全的同类命令不得命中', () => {
			for (const c of [
				'git clean -n',                    // dry-run
				'git clean -nd',
				'git stash list',
				'git stash show',
				'git branch',                      // 只列出
				'git branch -d merged-branch',     // 安全删除（未合并会被 git 拒绝）
				'git push --force-with-lease',     // 比 --force 安全
				'git reset',                       // 只重置 index，不动工作树
				'git reset HEAD~1',
				'git log --oneline',
			]) {
				assert.strictEqual(detectForcedAskCommand(c), undefined, `不应命中：${c}`);
			}
		});

		test('★★ 控制组 B：同名子串不得误伤', () => {
			for (const c of [
				'npm run rm-stale',
				'docker run --rm alpine echo hi',
				'npm run build:rm',
				'echo "please rm -rf nothing"',
			]) {
				assert.strictEqual(detectForcedAskCommand(c), undefined, `不应命中：${c}`);
			}
		});

		test('空命令不崩', () => {
			assert.strictEqual(detectForcedAskCommand(''), undefined);
		});
		});
});
