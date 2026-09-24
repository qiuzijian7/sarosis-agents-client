/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IToolDefinition, ToolSecurityLevel } from './providers.js';

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
 *   · **MCP 提供的文件工具**（如 filesystem MCP server 的 `write_file`）名字各异
 *     （走 `mcpToolProvider._inferSecurityLevel`），硬编码清单完全盖不住。
 * 改成动词模式匹配后，新增工具自动被纳入判定，且新增删除类工具会**自动落在放行之外**。
 *
 * ⚠ 2026-09-13 修正：**MCP 来源的工具不再自动放行**（改为走审批）。
 * 上面原本写「MCP 文件工具也自动覆盖」，但那把本函数的放行论证架空了 ——
 * 三道闸门对 MCP 工具**全都不成立**（详见 `isSandboxFileWriteAutoApproved` 步骤 3）。
 * 保留的是「用规则识别、不维护硬编码清单」这一半意图；收回的是「让 MCP 写工具也免审批」。
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

/**
 * MCP 工具的 category 前缀（`mcp:<serverId>`）—— **单一真源**。
 *
 * 由 `McpToolProvider._toDefinition` 生成，本模块据此识别「MCP 来源的工具」。
 * 定义在 `common/` 是为了避免 `common → browser` 的反向依赖（browser 侧引用本常量）。
 */
export const MCP_TOOL_CATEGORY_PREFIX = 'mcp:';

/**
 * 是否 **MCP 来源**的工具（`category = mcp:<serverId>`，由 `McpToolProvider._toDefinition` 生成）。
 *
 * 抽成函数是为了让「MCP 工具必须走审批」这条判定有**单一真源** —— 目前两处依赖它：
 *   · `isSandboxFileWriteAutoApproved` 步骤 3（写工具不自动放行）；
 *   · `ToolApprovalService.checkAndApprove` 的 `Safe` 早返回（2026-09-13 补，见那里的长注释）。
 *
 * 两处的论证**同构**：MCP 工具不经路径沙箱、不建 checkpoint，且其 `securityLevel`
 * 来自 **server 自报的注解**（不可验证）→ 任何「免审批」通道都不适用于它。
 */
export function isMcpSourcedTool(toolDef: IToolDefinition | undefined): boolean {
	return (toolDef?.category ?? '').toLowerCase().startsWith(MCP_TOOL_CATEGORY_PREFIX);
}

// ─── 类别模型（Phase 1，2026-09-13）─────────────────────────────────────────
//
// 目标：把「哪些调用免审批」从**代码内定的多条分支**改为**用户可控的类别档位**
// （对齐 Cline 的「默认全问 + 类别自动批准」）。
//
// ## 为什么先做「兼容档」而不是直接切 Cline 默认
// 本项目此前的策略是**明确记录的用户决策**（见 `toolExecutionGuard` 里
// 「操作沙箱内的文件、非删除类的操作，都可以直接放行」2026-08-21）——
// 直接翻转默认会让每次 `file_write` / `patch` 都弹卡片，属**行为反转**。
// 故 Phase 1 只引入模型 + 兼容档（**零行为变化**，现有 32 个审批用例全绿即为验收），
// Phase 2 再单独决策是否翻转默认值。

/**
 * 工具类别 —— 审批档位的**粒度**（对齐 Cline 的 auto-approve 分类）。
 *
 * `mcp` 单列：MCP 工具的 `securityLevel` 来自 server 自报、不可验证，
 * 故它必须能独立于 `read` 控制（不能因为「看着像只读」就归进 read）。
 */
export type ToolCategory = 'read' | 'edit' | 'execute' | 'web' | 'mcp' | 'other';

/**
 * 类别档位。
 *
 *  - `ask`  —— 每次都弹审批（**Cline 的默认**）
 *  - `safe` —— 只放行「已知只读 / 验证构建」的调用（本项目的中间档；
 *              没有它就无法平滑迁移 —— 今天的 `execute` 正是这个行为）
 *  - `auto` —— 除**地板**外全放行（Cline 的 auto-approve）
 *
 * ⚠ 三档都**不豁免地板**：受保护路径 / 删除类命令 / 破坏性工具名 / 未授权 MCP /
 * 沙箱越界 / `hardPermission` 一律照旧（见 `toolExecutionGuard._requiresUserDecision`）。
 */
export type ToolAutoApproveMode = 'ask' | 'safe' | 'auto';

/** 全部类别（顺序固定，便于 UI 与序列化稳定）。 */
export const TOOL_CATEGORIES: readonly ToolCategory[] = ['read', 'edit', 'execute', 'web', 'mcp', 'other'];

/** 合法档位集合（宽容解析用）。 */
const VALID_MODES: readonly string[] = ['ask', 'safe', 'auto'];

/**
 * **兼容档** —— **当前生效的默认值**（用户决策，2026-09-13）。
 *
 * ## 它编码的是这条产品策略
 *
 * > **沙箱内、非删除类的操作，直接放行。**（2026-08-21 用户决策）
 *
 * 逐条对应：
 *
 * | 类别 | 档 | 实现该策略的哪条分支 |
 * |---|---|---|
 * | `read` | `auto` | `Safe` 早返回（只读工具免审批） |
 * | `edit` | `auto` | `isSandboxFileWriteAutoApproved`（**沙箱内 + 非删除类** 写入免审批） |
 * | `execute` | `safe` | 终端白名单 + `execAutoReview`（**只放行已知只读/验证构建**） |
 * | `web` / `mcp` / `other` | `ask` | 本就弹审批 |
 *
 * 「沙箱内」由更早的 `resolveAndCheckWorkspacePath`（`checkSandbox=true`）保证 ——
 * 越界写会抛 `SandboxViolationError` 弹卡片，**不因档位而放宽** ✓
 * 「非删除类」由 `isSandboxFileWriteAutoApproved` 排除 delete/remove/move/rename ✓
 * 以及 `detectForcedAskCommand` 对删除类 shell 命令强制审批 ✓
 *
 * ⚠ 这条策略**有测试守着**（`toolApprovalPolicy.test.ts` 的「策略」suite）——
 * 改动本常量会让那些用例失败，而不是静默改变产品行为。
 */
export const COMPAT_AUTO_APPROVE: Readonly<Record<ToolCategory, ToolAutoApproveMode>> = {
	read: 'auto',
	edit: 'auto',
	execute: 'safe',
	web: 'ask',
	mcp: 'ask',
	other: 'ask',
};

/**
 * **Cline 风格默认**（「默认全问，只读不问」）—— ⚠ **已评估并被否决**（2026-09-13）。
 *
 * 保留它有两个用途：
 *   1. **记录被否决的备选方案**及其与现行默认的确切差别（只差 `edit` / `execute` 两处），
 *      避免将来有人重新提出时又要从零论证一遍；
 *   2. 供用户**按需自行选择**（在 `tool-allow.json` 里写 `autoApprove` 即可 ——
 *      「缺省」与「显式选默认」在 `toolAllowStore` 里被刻意区分，故显式选择会被尊重）。
 *
 * ## 为什么否决（用户原话）
 * > **沙箱内非删除类操作直接放行**
 *
 * 即：默认全问会显著增加弹窗量，而「沙箱内 + 非删除」已经被三道闸门兜住
 * （越界写被沙箱拦、删除类被 `forcedAsk` 拦、有 checkpoint 可回滚），
 * 不值得为它牺牲免打扰。**安全边界不因这次选择而放宽** —— 地板一条未动 ✓
 *
 * ⚠ **不要**把它设为 `DEFAULT_AUTO_APPROVE`：`toolApprovalPolicy.test.ts` 的策略用例
 * 会失败（那是刻意的 —— 产品默认值变更必须是显式决策，不能顺手改）。
 */
export const CLINE_DEFAULT_AUTO_APPROVE: Readonly<Record<ToolCategory, ToolAutoApproveMode>> = {
	read: 'auto',
	edit: 'ask',
	execute: 'ask',
	web: 'ask',
	mcp: 'ask',
	other: 'ask',
};

/**
 * 当前生效的默认档位 —— **= 兼容档**（用户决策，2026-09-13：沙箱内非删除类操作直接放行）。
 *
 * ⚠ 这是**产品策略**，不是实现细节：改动它会让 `toolApprovalPolicy.test.ts` 的
 * 「策略」suite 失败。要改必须同时改那组用例 —— 让变更**显式**发生。
 */
export const DEFAULT_AUTO_APPROVE: Readonly<Record<ToolCategory, ToolAutoApproveMode>> = COMPAT_AUTO_APPROVE;

/**
 * 宽容解析用户配置里的 `autoApprove` —— **坏值一律退化为默认档**。
 *
 * 与 `toolAllowStore.parseToolAllowFile` 同一纪律：配置是**安全状态**，
 * 宁可退回默认（该问就问），也不要把坏数据解释成「放行」。
 */
export function normalizeAutoApprove(raw: unknown): Record<ToolCategory, ToolAutoApproveMode> {
	const out = { ...DEFAULT_AUTO_APPROVE } as Record<ToolCategory, ToolAutoApproveMode>;
	if (!raw || typeof raw !== 'object') { return out; }
	const obj = raw as Record<string, unknown>;
	for (const cat of TOOL_CATEGORIES) {
		const v = obj[cat];
		if (typeof v === 'string' && VALID_MODES.includes(v)) {
			out[cat] = v as ToolAutoApproveMode;
		}
	}
	return out;
}

/**
 * 判定工具所属类别 —— **单一真源**（UI 档位、审批查表、序列化都用它）。
 *
 * 判定顺序（先排除再纳入，与 `isSandboxFileWriteAutoApproved` 同风格）：
 *   1. MCP（`category` 前缀是权威标记，必须先判 —— 否则「自称只读」会落进 `read`）
 *   2. shell / terminal → `execute`
 *   3. web → `web`
 *   4. filesystem：按动词分 `edit`（写/删）或 `read`
 *   5. 其余：名字含写动词 → `edit`；`securityLevel === Safe` → `read`；否则 `other`
 *
 * ⚠ 与 `isSandboxFileWriteAutoApproved` 的关系：后者的放行集合必须**落在** `edit` 内，
 * 否则 `edit: ask` 时仍会从它溜过去。判据顺序（shell → MCP → 写动词）与之一致。
 */
export function classifyToolCategory(toolDef: IToolDefinition | undefined): ToolCategory {
	if (!toolDef) { return 'other'; }
	const category = (toolDef.category ?? '').toLowerCase();
	const name = (toolDef.name ?? '').toLowerCase();

	// 1) MCP：`category` 前缀权威，且其 securityLevel 不可信 —— 必须先判
	if (category.startsWith(MCP_TOOL_CATEGORY_PREFIX)) { return 'mcp'; }

	// 2) shell / terminal（含任意带 shell 动词的名字）
	if (category === 'shell' || category === 'terminal' || includesAny(name, SHELL_LIKE_VERBS)) {
		return 'execute';
	}

	// 3) 网络类
	if (category === 'web' || includesAny(name, WEB_NAME_HINTS)) { return 'web'; }

	// 4) 文件类：写 / 删 → edit，其余 → read
	const isFileWrite = includesAny(name, FILE_WRITE_VERBS) || includesAny(name, IRREVERSIBLE_FILE_VERBS);
	if (category === 'filesystem') { return isFileWrite ? 'edit' : 'read'; }
	if (isFileWrite) { return 'edit'; }

	// 5) 兜底：声明为 Safe 的按只读处理（与 `Safe` 早返回同口径），其余归 other
	return toolDef.securityLevel === ToolSecurityLevel.Safe ? 'read' : 'other';
}

/** 名字里出现这些词视为网络类工具（与 `inferSecurityLevel` 的 cautiousPatterns 同源意图）。 */
const WEB_NAME_HINTS: readonly string[] = [
	'http', 'fetch', 'browser', 'navigate', 'download', 'upload', 'web_', 'crawl', 'scrape',
];

const includesAny = (haystack: string, needles: readonly string[]): boolean =>
	needles.some(n => haystack.includes(n));

/**
 * 判断该工具调用是否属于「沙箱内非删除类文件操作」，可免交互审批直接放行。
 *
 * 判定顺序刻意如此（先排除再纳入），保证新增的破坏性工具**默认不放行**：
 *   1. shell 类        → false
 *   2. 不可回滚动词    → false
 *   3. MCP 来源的工具  → false（三道闸门同样全不成立）
 *   4. filesystem category 或写入型动词 → true
 *   5. 其余            → false（保守默认）
 */
export function isSandboxFileWriteAutoApproved(toolDef: IToolDefinition | undefined): boolean {
	const name = (toolDef?.name ?? '').toLowerCase();
	if (!name) { return false; }
	const category = (toolDef?.category ?? '').toLowerCase();

	// 1) shell / 任意执行：三道闸门均不成立，永不放行
	if (includesAny(name, SHELL_LIKE_VERBS)) { return false; }

	// 2) 删除 / 移动 / 改名：不可回滚，永不放行
	if (includesAny(name, IRREVERSIBLE_FILE_VERBS)) { return false; }

	// 3) MCP 来源的工具：三道闸门**同样全都不成立**，永不放行（2026-09-13 修正）
	//
	// 本函数的放行论证建立在「三道仍然生效的闸门」上（见模块头注释）：
	//   ① 越界写仍被拦 —— 文件类工具走 resolveAndCheckWorkspacePath(checkSandbox=true)；
	//   ② hardPermission 不受影响；
	//   ③ 有回滚点 —— handler 写盘前调 captureBeforeToolEdit。
	//
	// 但对 MCP 工具，①③ **都不成立**：
	//   · `McpToolProvider.executeTool` 把 arguments **直接透传**给 server
	//     （`routed.tool.call(call.arguments, ...)`），不经过任何路径解析 → 路径沙箱与
	//     `writeDenyList`（`.env` / `~/.ssh` / **`User/settings.json`——provider apiKey 所在**）
	//     对它**全部不生效**；server 是否尊重 roots 属其自身行为，不是我们的安全边界。
	//   · MCP 工具**不创建 checkpoint** → 写入不可回滚（与 move/rename 被排除同理）。
	//   · 且 MCP schema 各异，**无法静态判断它到底会碰哪些路径**。
	//
	// 这与 {@link SHELL_LIKE_VERBS} 的排除论证**完全同构**（「无法静态判断会碰哪些路径
	// + checkpoint 覆盖不到 → 三道闸门全不成立 → 绝不能整个工具豁免」）。
	//
	// ⚠ 2026-09-13 更正：上一版这里写「只读 MCP 工具在 Safe 早返回处即放行，**不受本排除影响**，
	// 免打扰能力不变」—— 那句话把 `Safe` 当成了可信事实，而 MCP 的 `securityLevel` 来自
	// **server 自报的 `annotations.readOnlyHint`**（客户端无法验证）。
	// 该早返回**已同步关闭**（见 `checkAndApprove`）→ 现在 MCP 工具无论自报什么都走审批，
	// 用户可对具体工具选「始终允许」来恢复免打扰。
	if (isMcpSourcedTool(toolDef)) { return false; }

	// 4) 明确的文件类工具
	if (FILE_CATEGORIES.includes(category)) { return true; }
	if (includesAny(name, FILE_WRITE_VERBS)) { return true; }

	// 5) 判不出来就走正常审批
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
		// ★ 2026-09-24（P1-5）：processTools: action ∈ list | output | wait | terminate。
		//   前三个是读/等 ⇒ 不审批；terminate 会杀掉 agent 正在跑的后台任务（可能是一次
		//   跑了很久的构建/服务）⇒ 每次都问。多操作工具按操作参数判（与 skill_manage 同一形态）。
		{ tool: 'process', argKey: 'action', values: ['terminate'] },
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

// ── 删除类命令的「强制审批」（P2，2026-09-13，对齐 MiMo `bash_delete` FORCED_ASK）──
//
// ## 缺口
// `commandSafety.HARDLINE_PATTERNS` 只拦「灾难性」删除（`rm -rf /`、`rm -rf ~`、`mkfs`、
// `dd` 写块设备…），其余删除走**普通审批**。而 `terminal` / `execute_code` 是
// `securityLevel: Dangerous` —— 用户一旦点过「始终允许 terminal」（或某个命令级 glob），
// `rm -rf <子目录>` / `git reset --hard` / `git clean -fd` 就**永久免审批**。
// 而删除**没有 checkpoint**（`captureBeforeToolEdit` 只在 file_write / patch 的 handler
// 里调用）→ 一旦执行**不可回滚**。
//
// ## 语义：命中即「每次都必须问」
// 两条「免打扰」通道对它**都不生效**：
//   · `_isAllowed`（always-allow 记忆，含跨会话持久化）；
//   · `execAutoReview`（模型审查说 allow）。
// 与 MiMo 同源：`bash_delete` 是 FORCED_ASK，任何 allow（含 `*`）都不能预授权。
// ⚠ 本判定**只影响审批**，不改变 hardPermission 档位，也不改变 subagent 的 `inherit`
// 路由（那是另一套刻意设计，不在本次范围）。
//
// ## 判据刻意保守
// 只认「明确以删除 / 丢弃为目的」的形态，避免误伤 `git stash list`、普通 `git branch`、
// `npm run clean`、`git clean -n`（dry-run）等。
// 误判方向偏「多问一次」而非「漏拦」—— 多问一次的代价是点一下，漏拦的代价是丢文件。

/** 删除类命令头（含 PowerShell / cmd 别名；PowerShell 里 `rm` 是 `Remove-Item` 的别名）。 */
const DELETE_COMMAND_HEADS = 'rm|rmdir|rd|del|erase|unlink|shred|remove-item';

/**
 * 删除类命令的**前置语境**：命令起始位置，或常见包装器之后。
 *
 * 为什么必须限定：`rm` 作为子串极易误伤（`npm run rm-x`、`docker run --rm`、
 * `echo "sudo rm"`）。要求命令起始位置（`^` / `|` / `;` / `&` 之后）可挡掉绝大部分；
 * 再补 `xargs` / `sudo` / `-exec` 三种包装器，覆盖 `xargs rm`、
 * `find … -exec rm {} \;` 这类真实删除形态。
 *
 * ⚠ `-exec` 必须写成 `(?:^|\s)-exec\b` 而**不能**写 `\b-exec\b`：`\b` 是「词字符 ↔
 * 非词字符」的边界，而空格与 `-` 都是非词字符 → `\b` 在 ` -exec` 处**永不成立**
 * （该写法实测永远匹配不到，是首版的真实 bug）。
 */
const DELETE_COMMAND_PREFIX = '(?:^|[|;&]+|\\bxargs\\b|\\bsudo\\b|(?:^|\\s)-exec\\b)';

/** 强制审批的命令形态表（形状与 `commandSafety.HARDLINE_PATTERNS` 一致）。 */
export const FORCED_ASK_COMMAND_PATTERNS: ReadonlyArray<{
	readonly id: string;
	readonly pattern: RegExp;
	readonly label: string;
}> = [
	{
		id: 'delete-command',
		pattern: new RegExp(`${DELETE_COMMAND_PREFIX}\\s*(?:${DELETE_COMMAND_HEADS})\\b`, 'im'),
		label: 'file/directory deletion (rm / rmdir / del / erase / unlink / shred / Remove-Item)',
	},
	{
		id: 'git-reset-hard',
		pattern: /\bgit\s+reset\s+--hard\b/i,
		label: 'git reset --hard (discards all working-tree changes)',
	},
	{
		// 必须带 `f`：`git clean -n` 是 dry-run；`-d` 单独用也要 `-f` 才真删
		id: 'git-clean-force',
		pattern: /\bgit\s+clean\b[^|;&\n]*\s-[a-zA-Z]*f[a-zA-Z]*/i,
		label: 'git clean -f (deletes untracked files)',
	},
	{
		id: 'git-branch-force-delete',
		pattern: /\bgit\s+branch\b[^|;&\n]*\s-D\b/,
		label: 'git branch -D (force-deletes an unmerged branch)',
	},
	{
		// `--force-with-lease` 更安全，由负向断言排除
		id: 'git-push-force',
		pattern: /\bgit\s+push\b[^|;&\n]*\s(?:-f|--force)(?![\w-])/i,
		label: 'git push --force (overwrites remote history)',
	},
	{
		id: 'git-stash-discard',
		pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
		label: 'git stash drop/clear (discards stashed changes)',
	},
];

/**
 * 判断一条 shell 命令是否属于「删除类」—— 命中即**强制审批**，不参与 always-allow
 * 记忆、也不送模型审查（见上方长注释）。
 *
 * @returns 命中的形态（供日志）；未命中返回 `undefined`（走正常审批流程）。
 */
export function detectForcedAskCommand(command: string): { readonly id: string; readonly label: string } | undefined {
	if (!command) { return undefined; }
	return FORCED_ASK_COMMAND_PATTERNS.find(p => p.pattern.test(command));
}
