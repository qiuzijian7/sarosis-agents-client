/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IToolDefinition } from './providers.js';

/**
 * 工具审批策略 —— 纯函数，无 IO / 无 Node 依赖，可单测。
 *
 * 用户策略（2026-08-21 决策）：**操作沙箱内的文件，非删除类的操作，一律直接放行。**
 *
 * 之所以能安全放行，靠的是三道**仍然生效**的闸门（不是降低要求）：
 *   ① 越界写仍被拦 —— 文件类工具的路径解析走 `checkSandbox=true`，落在允许根之外
 *      会抛 `SandboxViolationError` → 弹「安全沙箱限制」卡片交用户裁决。
 *      **所以放行的实质范围只有"沙箱内"。**
 *   ② `hardPermission` 不受影响 —— ask / plan 等只读档位仍在 executor 层禁写。
 *   ③ 有回滚点 —— handler 在写盘前调 `captureBeforeToolEdit` 生成 tool_edit
 *      checkpoint，用户可撤销。
 *
 * ⚠ 为什么用「规则」而不是硬编码工具名清单：
 * 原实现是 `new Set(['patch','file_write'])`，有两个必然踩的坑：
 *   · 将来新增文件工具（`multi_edit` / `apply_diff` / `create_file` …）会漏掉，
 *     用户又得手工维护清单；
 *   · **MCP 提供的文件工具**（如 filesystem MCP server 的 `write_file`）走
 *     `mcpToolProvider._inferSecurityLevel`，常被判 Dangerous，硬编码清单完全盖不住。
 * 改成动词模式匹配后，两类都自动覆盖，且新增删除类工具会**自动落在放行之外**。
 */

/**
 * 破坏性动词**共享基表** —— 本模块两个判定共用，避免两份清单漂移。
 *
 * 由来（2026-08-21）：`IRREVERSIBLE_FILE_VERBS`（自动放行的排除表）与
 * `DESTRUCTIVE_NAME_VERBS`（强制审批表）原本各写一份，前者漏了 `forget`/`wipe`
 * → 未来若出现 `wipe_dir`/`file_forget` 且 `category:'filesystem'`，会被**自动放行**
 * 却同时被强制审批表认定为破坏性，两个判定自相矛盾。单测的「互斥」用例当场抓到。
 */
const DESTRUCTIVE_CORE_VERBS = [
	'delete', 'remove', 'unlink', 'trash', 'destroy', 'purge', 'drop', 'forget', 'wipe',
];

/**
 * 不可回滚的文件动词 —— 一律**不放行**，仍走完整审批。
 *
 * · delete / remove / unlink / trash / destroy / purge / drop / forget / wipe：
 *   用户明确要求删除类仍需确认（共享基表 `DESTRUCTIVE_CORE_VERBS`）。
 * · move / rename：虽不是"删除"，但 `captureBeforeToolEdit` 只快照**被写入的目标文件**，
 *   移动/改名会让原路径凭空消失且没有任何快照 → 在本系统里**无法回滚**，
 *   与"非删除即可放行"背后的『可撤销』前提不符，故一并排除。
 */
const IRREVERSIBLE_FILE_VERBS = [
	...DESTRUCTIVE_CORE_VERBS,
	'move', 'rename',
];

/**
 * shell / 任意代码执行类 —— 一律**不放行**。
 *
 * 这类工具无法静态判断它到底会碰哪些路径：可以 `curl` 外传、可以 `rm -rf`，
 * 且 checkpoint 完全覆盖不到 → 上面三道闸门**全都不成立**。
 * 若要放宽只能做「命令白名单」（只放行 `git status`/`ls`/`npm run xxx` 等只读命令），
 * 绝不能整个工具豁免。
 */
const SHELL_LIKE_VERBS = [
	'terminal', 'shell', 'bash', 'exec', 'execute_code',
	'run_command', 'execute_command', 'spawn', 'process',
];

/**
 * 写入型文件动词 —— 用于识别 MCP 等没有 `category: 'filesystem'` 的文件工具。
 *
 * `diff` / `replace` / `modify` 覆盖 `apply_diff`、`search_replace`、
 * `batch_modify_files` 这类他方常见命名。即使某个**只读**工具恰好命中（如
 * `diff_files`），也无害：它根本不写盘，且只读工具通常本就是 Safe、走不到这里。
 * 破坏性语义由上面两张排除表兜底（排除优先于纳入）。
 */
const FILE_WRITE_VERBS = [
	'write', 'patch', 'edit', 'create_file', 'append',
	'insert', 'mkdir', 'make_directory', 'touch', 'save_file',
	'diff', 'replace', 'modify',
];

/** 被视为「文件操作」的 category（内置工具走这条）。 */
const FILE_CATEGORIES = ['filesystem'];

const includesAny = (haystack: string, needles: readonly string[]): boolean =>
	needles.some(n => haystack.includes(n));

/**
 * 判断该工具调用是否属于「沙箱内非删除类文件操作」，可免交互审批直接放行。
 *
 * 判定顺序刻意如此（先排除再纳入），保证新增的破坏性工具**默认不放行**：
 *   1. shell 类     → false
 *   2. 不可回滚动词 → false
 *   3. filesystem category 或写入型动词 → true
 *   4. 其余         → false（保守默认）
 */
export function isSandboxFileWriteAutoApproved(toolDef: IToolDefinition | undefined): boolean {
	const name = (toolDef?.name ?? '').toLowerCase();
	if (!name) { return false; }

	// 1) shell / 任意执行：三道闸门均不成立，永不放行
	if (includesAny(name, SHELL_LIKE_VERBS)) { return false; }

	// 2) 删除 / 移动 / 改名：不可回滚，永不放行
	if (includesAny(name, IRREVERSIBLE_FILE_VERBS)) { return false; }

	// 3) 明确的文件类工具
	const category = (toolDef?.category ?? '').toLowerCase();
	if (FILE_CATEGORIES.includes(category)) { return true; }
	if (includesAny(name, FILE_WRITE_VERBS)) { return true; }

	// 4) 判不出来就走正常审批
	return false;
}

/**
 * 破坏性动词（**按工具名**匹配，命中即强制审批）。
 *
 * ⚠ 只匹配工具名，**不匹配 description** —— 描述匹配会误伤状态流转类工具：
 * 实测 `kanban_unblock` 的描述含 "Moves it back to the todo column"，
 * 按描述匹配会把它当成破坏性操作（它只是把任务移回 todo 列）。
 *
 * ⚠ 刻意**不含 `move` / `rename`**：当前无任何移动/改名工具，而 `move` 作为子串
 * 很容易误伤未来的 `kanban_move_task` 这类状态流转工具。真出现 `file_move`
 * 时应在其定义里显式声明 `securityLevel: Dangerous`（`isSandboxFileWriteAutoApproved`
 * 已把 move/rename 排除在自动放行之外，两者配合即可）。
 */
const DESTRUCTIVE_NAME_VERBS = DESTRUCTIVE_CORE_VERBS;

/**
 * 多操作工具的破坏性取值表 —— 一个工具同时含增删改时，**只有破坏性操作才审批**。
 *
 * 若按工具整体声明 `securityLevel: Dangerous`，会连 `skill_manage(action=create)`
 * 和 `memory_governance(action=audit)`（只读查审计日志）都弹窗，与"减少打扰"相悖。
 * 这两个工具名本身也不含破坏性动词，故必须靠本表识别。
 */
const DESTRUCTIVE_OPERATIONS: ReadonlyArray<{
	readonly tool: string;
	readonly argKey: string;
	readonly values: readonly string[];
}> = [
		// skillTools: action ∈ create | patch | edit | delete
		{ tool: 'skill_manage', argKey: 'action', values: ['delete'] },
		// advancedMemoryTools: action ∈ delete | bulk_delete | audit（audit 只读）
		{ tool: 'memory_governance', argKey: 'action', values: ['delete', 'bulk_delete'] },
	];

/**
 * 判断该调用是否为破坏性操作，需**强制**弹审批 —— 即使工具没声明 securityLevel。
 *
 * 为什么必需（2026-08-21 查明）：`checkAndApprove` 读的是
 * `toolDef?.securityLevel ?? ToolSecurityLevel.Safe`，而 `inferSecurityLevel`
 * 是死代码（零生产调用）→ **内置工具不声明 securityLevel 就等于 Safe、永不审批**。
 * 85 个内置工具里仅 4 个声明了 Dangerous，导致 `delete_project` / `memory_delete` /
 * `memory_forget` / `web_recipe_remove` / `skill_manage(delete)` /
 * `memory_governance(bulk_delete)` 全部**无审批直接执行**。
 *
 * 用规则 + 操作表而不是逐个改工具定义，好处是新增的 `*_delete` / `*_remove`
 * 工具**自动**被纳入，不会再出现"新加了删除工具但忘了声明等级"的缺口。
 */
export function isDestructiveToolCall(toolName: string, args: unknown): boolean {
	const name = (toolName ?? '').toLowerCase();
	if (!name) { return false; }

	// 1) 单一用途的破坏性工具：名称命中即可
	if (includesAny(name, DESTRUCTIVE_NAME_VERBS)) { return true; }

	// 2) 多操作工具：只看操作参数
	const entry = DESTRUCTIVE_OPERATIONS.find(e => e.tool === name);
	if (entry) {
		if (!args || typeof args !== 'object') { return false; }
		const raw = (args as Record<string, unknown>)[entry.argKey];
		if (typeof raw === 'string' && entry.values.includes(raw.toLowerCase())) { return true; }
	}

	return false;
}
