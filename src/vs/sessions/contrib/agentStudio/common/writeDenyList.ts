/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 写黑名单 —— 凭据 / 应用状态文件的硬拒护栏（对标 Hermes-Agent `agent/file_safety.py`）。
 *
 * ## 为什么必须有这道闸门
 * 沙箱只判「路径是否落在允许根内」，而 **`~/.vssaros` 是 5 个允许根之一**
 * （`workspaceSecurity` 第 3 条：agent 要读写自己的 skills / memory / plans）。
 * 叠加 2026-08-21「沙箱内非删除类文件操作一律自动放行」之后，形成了一条真实攻击面：
 *
 *   provider API Key 存在 `~/.vssaros/User/settings.json`
 *   （`configurationService.updateValue('sessions.agentStudio.provider.<id>.apiKey')`）
 *   → 该路径在允许根内 → `file_write` **免审批、无提示**即可改写。
 *
 * 同理还有 `chat-history/`（伪造会话历史）、`.agentmemory/`（污染记忆）、
 * `extensions/`（写扩展代码 = 任意代码执行）、`~/.ssh`、`~/.aws`、工作区里的 `.env`。
 * 改前全 src grep `.ssh|id_rsa|.aws|git-credentials|denyList` **零命中**。
 *
 * ## 与沙箱的关系：这是「拒绝」，不是「征求同意」
 * 沙箱越界会弹卡片让用户「允许本次 / 允许此工作区」；本黑名单**硬拒，不提供绕过**
 * （故 `WriteDeniedError.isSandboxViolation === false` —— 一旦置 true，
 * `agentOSService` 会把它当越界处理并弹出授权卡片，等于白做）。
 *
 * ## 只管写/删，不管读
 * 判定只在 `checkSandbox === true`（写/删路径）时调用。刻意**不做**读黑名单：
 *   · 本项目 `file_read` / `search_code` 一律不过沙箱（既有设计，见 MEMORY 铁律）；
 *   · 且 `terminal` 以同一 OS 用户运行，`cat` 随时可绕 —— 读侧黑名单只是
 *     defense-in-depth 而非边界，收益与改动面不成正比（Hermes 自己的模块注释也
 *     明确写了 "This is NOT a security boundary"）。
 *   本护栏针对的是**不可逆的破坏与凭据被改写**，写侧才是真正的边界。
 *
 * ## 边界判定纪律
 * 一律用 `extUriBiasedIgnorePathCase.isEqualOrParent`（与 `workspacePathResolver`
 * 同一把尺），**不得**用 `toLowerCase() + startsWith`：
 *   · 后者在大小写敏感文件系统上会误判（项目已记录的越界隐患）；
 *   · 且 `startsWith` 会把兄弟目录误当子路径（`~/.ssh-backup` 被 `~/.ssh` 命中）。
 * `isEqualOrParent` 按路径**段**比较，两个问题都不存在。
 *
 * 纯函数、零 Node 依赖 → 可单测、可在 common 层安全使用。
 */

import { URI } from '../../../../base/common/uri.js';
import * as path from '../../../../base/common/path.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';

/** 拒绝原因分类 —— 决定错误文案给出的替代方案。 */
export type WriteDenyReason =
	/** 凭据 / 密钥文件（provider apiKey、ssh、云厂商凭据、.env…）。 */
	| 'credential'
	/** 应用自有状态（会话历史、记忆库、备份、Electron 内部状态）。 */
	| 'app-state'
	/** 可执行代码载荷（扩展目录）—— 改写等于任意代码执行。 */
	| 'code-payload';

export interface IWriteDenyVerdict {
	readonly reason: WriteDenyReason;
	/** 命中的规则标识，进日志便于复盘（不含用户路径，避免泄漏到日志）。 */
	readonly rule: string;
	/** 给模型看的错误说明（含替代做法，避免它反复重试同一路径）。 */
	readonly message: string;
}

export interface IWriteDenyContext {
	/** OS 用户主目录（`environmentService.userHome.fsPath`）。 */
	readonly userHome?: string;
	/** 应用数据根 `~/.vssaros`（`environmentService.userDataPath`）。 */
	readonly appDataRoot?: string;
}

// ─── 规则表 ─────────────────────────────────────────────────────────────

/**
 * 应用数据根内**禁止写入**的相对路径。
 *
 * ⚠⚠ 这里必须是**精确黑名单**，绝不能反过来做白名单 —— `~/.vssaros` 下有大量
 * agent 合法写入的位置，漏放行任何一个都会造成功能回归：
 *   `tmp/`（execOutputSpill 超限输出落盘）、`skills/`（skill_manage）、
 *   `plans/`（plan 模式唯一允许的写入）、`memory/`、`agents/`、`knowledge-base/`、
 *   `workflows/`、`dashboard/`、`codebase-graph/`、`favorites/`、`media/`、`logs/`。
 * 上述目录**刻意不在本表中**，改动本表前先确认不会碰到它们（有专门的放行控制组测试）。
 */
const APP_DATA_DENY: ReadonlyArray<{ readonly rel: string; readonly reason: WriteDenyReason; readonly rule: string }> = [
	// ★ 首要目标：provider apiKey 就在 User/settings.json 里。
	//   整个 User/ 目录都拒（settings.json / mcp.json / profiles / globalStorage
	//   / workspaceStorage 都是应用配置与状态，没有一个该由 file_write 直改）。
	{ rel: 'User', reason: 'credential', rule: 'appdata:User' },
	{ rel: 'auth.json', reason: 'credential', rule: 'appdata:auth.json' },
	{ rel: 'machineid', reason: 'credential', rule: 'appdata:machineid' },
	// 会话记录 / 记忆 / 备份：应用自有状态，改写会伪造历史或污染召回。
	{ rel: 'chat-history', reason: 'app-state', rule: 'appdata:chat-history' },
	{ rel: '.agentmemory', reason: 'app-state', rule: 'appdata:.agentmemory' },
	{ rel: 'Backups', reason: 'app-state', rule: 'appdata:Backups' },
	{ rel: 'context-storage', reason: 'app-state', rule: 'appdata:context-storage' },
	{ rel: 'pending-approvals', reason: 'app-state', rule: 'appdata:pending-approvals' },
	// Electron / Chromium 内部状态：写坏会让应用无法启动，且模型没有任何正当理由动它。
	{ rel: 'Local Storage', reason: 'app-state', rule: 'appdata:Local Storage' },
	{ rel: 'Session Storage', reason: 'app-state', rule: 'appdata:Session Storage' },
	{ rel: 'WebStorage', reason: 'app-state', rule: 'appdata:WebStorage' },
	{ rel: 'Service Worker', reason: 'app-state', rule: 'appdata:Service Worker' },
	{ rel: 'Network', reason: 'app-state', rule: 'appdata:Network' },
	{ rel: 'Crashpad', reason: 'app-state', rule: 'appdata:Crashpad' },
	{ rel: 'Local State', reason: 'app-state', rule: 'appdata:Local State' },
	{ rel: 'Preferences', reason: 'app-state', rule: 'appdata:Preferences' },
	{ rel: 'argv.json', reason: 'app-state', rule: 'appdata:argv.json' },
	{ rel: 'workspaces.json', reason: 'app-state', rule: 'appdata:workspaces.json' },
	{ rel: 'installed-packages.json', reason: 'app-state', rule: 'appdata:installed-packages.json' },
	// 扩展目录：写进去等于让 agent 投放会被自动加载的代码。
	{ rel: 'extensions', reason: 'code-payload', rule: 'appdata:extensions' },
];

/** 用户主目录下的凭据目录前缀（整棵子树禁写）。 */
const HOME_DENY_DIRS: ReadonlyArray<string> = [
	'.ssh',
	'.aws',
	'.gnupg',
	'.kube',
	'.docker',
	'.azure',
	'.config/gh',
	'.config/gcloud',
];

/** 用户主目录下的精确凭据文件。 */
const HOME_DENY_FILES: ReadonlyArray<string> = [
	'.netrc',
	'.pgpass',
	'.npmrc',
	'.pypirc',
	'.git-credentials',
];

/** 系统级敏感路径（posix；Windows 上不会命中，保留成本为零）。 */
const SYSTEM_DENY: ReadonlyArray<string> = [
	'/etc/passwd',
	'/etc/shadow',
	'/etc/sudoers',
	'/etc/sudoers.d',
	'/etc/systemd',
];

/**
 * 携带密钥的环境文件 basename（**任意目录**，包括工作区内）。
 *
 * 这是本表里唯一「与位置无关」的规则：工作区是允许根，改前 `.env` 完全放行，
 * 而它routinely 含 API Key / 数据库口令。`.env.example` 是文档化的形状替代品，
 * 故**刻意不拦** `.env.example` / `.env.sample` / `.env.template`（有控制组测试）。
 */
const DENY_ENV_BASENAMES: ReadonlySet<string> = new Set([
	'.env',
	'.env.local',
	'.env.development',
	'.env.development.local',
	'.env.production',
	'.env.production.local',
	'.env.test',
	'.env.test.local',
	'.envrc',
]);

// ─── 判定 ───────────────────────────────────────────────────────────────

/** `target` 是否等于 `base` 或位于其子树内（按路径段比较，跨平台正确）。 */
function isAtOrUnder(target: string, base: string): boolean {
	if (!base) { return false; }
	return extUriBiasedIgnorePathCase.isEqualOrParent(URI.file(target), URI.file(base));
}

function denyMessage(reason: WriteDenyReason, resolvedPath: string): string {
	switch (reason) {
		case 'credential':
			return `拒绝写入受保护的凭据/配置文件："${resolvedPath}"。\n` +
				`该文件可能包含 API Key、密钥或应用凭据，任何工具都不允许改写它（此限制无法通过确认卡片放行）。\n` +
				`如果确实需要修改配置，请让用户通过设置界面操作；不要重试该路径，也不要尝试用 terminal/execute_code 绕过。`;
		case 'app-state':
			return `拒绝写入应用自有状态文件："${resolvedPath}"。\n` +
				`会话历史、记忆库、备份与运行时状态由应用自身维护，直接改写会破坏一致性（此限制无法通过确认卡片放行）。\n` +
				`请改用对应的专用工具（记忆走 memory_* 工具，会话与配置走应用界面），不要重试该路径。`;
		case 'code-payload':
			return `拒绝写入扩展/插件代码目录："${resolvedPath}"。\n` +
				`该目录下的代码会被应用自动加载执行，不允许由工具写入（此限制无法通过确认卡片放行）。\n` +
				`请把代码写到工作区内，不要重试该路径。`;
	}
}

/**
 * 判定一次**写/删**操作是否被黑名单拒绝。允许则返回 `undefined`。
 *
 * @param resolvedPath 已解析的绝对路径（必须是 `resolveWorkspacePath` 的产物 ——
 *                     相对路径与 `../` 段已折叠，否则 `a/../../.ssh/id_rsa` 可绕过）。
 */
export function checkWriteDenied(resolvedPath: string, ctx: IWriteDenyContext): IWriteDenyVerdict | undefined {
	if (!resolvedPath) { return undefined; }

	// 1) 与位置无关的规则：携带密钥的 .env 家族（含工作区内）。
	//    basename 比较用小写：Windows/macOS 不区分大小写，Linux 上 `.ENV` 也几乎
	//    总是同一意图，宁可多拦（.env.example 由白名单形状天然排除）。
	const base = path.basename(resolvedPath).toLowerCase();
	if (DENY_ENV_BASENAMES.has(base)) {
		return { reason: 'credential', rule: `env:${base}`, message: denyMessage('credential', resolvedPath) };
	}

	// 2) 应用数据根内的精确黑名单。
	if (ctx.appDataRoot) {
		for (const entry of APP_DATA_DENY) {
			if (isAtOrUnder(resolvedPath, path.join(ctx.appDataRoot, entry.rel))) {
				return { reason: entry.reason, rule: entry.rule, message: denyMessage(entry.reason, resolvedPath) };
			}
		}
	}

	// 3) 用户主目录下的凭据目录 / 文件。
	if (ctx.userHome) {
		for (const rel of HOME_DENY_DIRS) {
			if (isAtOrUnder(resolvedPath, path.join(ctx.userHome, ...rel.split('/')))) {
				return { reason: 'credential', rule: `home:${rel}`, message: denyMessage('credential', resolvedPath) };
			}
		}
		for (const rel of HOME_DENY_FILES) {
			if (isAtOrUnder(resolvedPath, path.join(ctx.userHome, rel))) {
				return { reason: 'credential', rule: `home:${rel}`, message: denyMessage('credential', resolvedPath) };
			}
		}
	}

	// 4) 系统级路径。
	for (const sys of SYSTEM_DENY) {
		if (isAtOrUnder(resolvedPath, sys)) {
			return { reason: 'credential', rule: `system:${sys}`, message: denyMessage('credential', resolvedPath) };
		}
	}

	return undefined;
}

/**
 * 写黑名单拒绝错误。
 *
 * ⚠⚠ `isSandboxViolation` **必须保持 false**：`agentOSService` / `executeTool`
 * 检测该标记后会弹出「允许本次 / 允许此工作区」确认卡片。本错误的语义是
 * **硬拒、不给绕过**，置 true 等于让整个黑名单形同虚设。
 * 有专门的单测与验证脚本钉住这一点。
 */
export class WriteDeniedError extends Error {
	readonly isSandboxViolation = false;
	readonly isWriteDenied = true;
	/**
	 * 复用 `NonRetryableToolError` 的鸭子类型标记，让 `toolExecutor` 的通用 catch
	 * 自动算出 `retryable: false`（无需改动 toolExecutor）。
	 * 黑名单拒绝是**确定性**结果，重试必然同样失败 —— 与 patch 的三种匹配失败同理。
	 * （当前 `DEFAULT_TOOL_RETRY_POLICY.maxAttempts=1` 已全局关闭工具级重试，
	 *   但语义要正确：万一将来恢复重试，这里不能白费尝试。）
	 */
	readonly isNonRetryableToolError = true;
	constructor(
		readonly resolvedPath: string,
		readonly reason: WriteDenyReason,
		readonly rule: string,
		message: string,
	) {
		super(message);
		this.name = 'WriteDeniedError';
	}
}
