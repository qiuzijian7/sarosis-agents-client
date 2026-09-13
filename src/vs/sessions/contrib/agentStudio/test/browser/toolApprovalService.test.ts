/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ToolApprovalService — 受保护路径 fail-closed 回归测试（P1 修正，2026-09-13）。
 *
 * ## 修的是什么
 * `isProtectedPath` 原先**只在 always-allow 检查之前**求值，而
 * `isSandboxFileWriteAutoApproved` / 终端白名单 / `execAutoReview` 这三个「自动放行」
 * 分支在它之前就已 `return true` → 文档承诺的「受保护路径 fail-closed」
 * **只挡住了 always-allow，没挡住自动放行**。
 *
 * 真实缺口：`file_write` 写 `.git/hooks/pre-commit`（或写 `.git/config` 的
 * `core.hooksPath`）会被**自动放行、完全不弹审批** → 用户下次 commit 执行任意代码。
 * （`.env` 那类由 `writeDenyList` 在更早的沙箱层硬拒兜底，故不在本测试的缺口范围内。）
 *
 * ## 测试手法
 * 用「记录型审批 handler」判定**到底有没有弹审批**：
 * 受保护路径必须弹（handler 被调用 ≥1 次），普通路径不应弹（自动放行 → 0 次）。
 * 该断言在修正前会失败（受保护路径 asked=0），修正后通过 —— 是真正的回归测试。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/toolApprovalService.test.ts
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolApprovalService } from '../../browser/toolExecutionGuard.js';
import {
	ToolSecurityLevel, ToolApprovalDecision,
	type IToolCall, type IToolDefinition, type IToolApprovalRequest, type IToolApprovalHandler,
} from '../../common/providers.js';
import type { IAskRoutingContext } from '../../common/askRouting.js';
import { DEFAULT_AUTO_APPROVE, type ToolCategory, type ToolAutoApproveMode } from '../../common/toolApprovalPolicy.js';

/** 造一个「记录是否被问到审批」的服务实例（并保留最后一次请求，便于断言 reason）。 */
function makeService(): {
	svc: ToolApprovalService;
	asked: () => number;
	lastRequest: () => IToolApprovalRequest | undefined;
} {
	const svc = new ToolApprovalService();
	let count = 0;
	let last: IToolApprovalRequest | undefined;
	svc.setApprovalHandler({
		requestApproval: async (req) => { count++; last = req; return ToolApprovalDecision.AllowOnce; },
	});
	return { svc, asked: () => count, lastRequest: () => last };
}

/** `file_write` 这类写工具的真实形态：`category=filesystem` + `Dangerous`。 */
const FILE_WRITE_DEF = {
	name: 'file_write',
	category: 'filesystem',
	securityLevel: ToolSecurityLevel.Dangerous,
} as unknown as IToolDefinition;

/**
 * ★★ Phase 1（2026-09-13）：**类别档位**（`autoApproveMode`）与**地板**。
 *
 * 验证两件事，且**不依赖默认值翻转**（Phase 1 默认仍是兼容档）：
 *   1. 档位为 `ask` 时，该类别**不再自动放行** —— 这是 Phase 2 要用的能力；
 *   2. 档位为 `auto` 时，**地板仍然生效**（受保护路径 / 删除类命令）。
 *
 * 第 2 条是本设计的核心主张：类别档位放宽的是「打扰程度」，**不是安全边界**。
 */
suite('ToolApprovalService — 类别档位与地板（Phase 1）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 只注入类别档位的桩（授权表为空，避免干扰）。 */
	const storeWith = (modes: Partial<Record<ToolCategory, ToolAutoApproveMode>>) => ({
		isAllowed: (_toolName: string, _command?: string) => false,
		remember: (_toolName: string, _scope: 'workspace' | 'global', _command?: string) => { /* noop */ },
		revoke: (_key: string) => { /* noop */ },
		autoApproveMode: (c: ToolCategory): ToolAutoApproveMode => modes[c] ?? DEFAULT_AUTO_APPROVE[c],
	});

	const shellDef = {
		name: 'terminal', category: 'terminal', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;
	const shellCall = (command: string): IToolCall =>
		({ id: 'c1', name: 'terminal', arguments: { command } } as unknown as IToolCall);
	const writeCall = (p: string): IToolCall =>
		({ id: 'c2', name: 'file_write', arguments: { path: p, content: 'x' } } as unknown as IToolCall);

	test('★★ `edit: ask` → 沙箱内普通路径写入也必须弹审批（Phase 2 的能力）', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ edit: 'ask' }));
		await svc.checkAndApprove(writeCall('src/foo.ts'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 1, '档位为 ask 时不得自动放行');
	});

	test('★★ 控制组：`edit: auto`（Phase 1 默认）→ 普通路径仍自动放行', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ edit: 'auto' }));
		await svc.checkAndApprove(writeCall('src/foo.ts'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 0, '兼容档行为不变');
	});

	test('★★ 地板：即便 `edit: auto`，受保护路径仍必须弹审批', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ edit: 'auto' }));
		await svc.checkAndApprove(writeCall('.git/hooks/pre-commit'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 1, '受保护路径不因档位放宽而免审批');
	});

	test('★★ `execute: auto` → 普通命令免审批（Cline 的 auto-approve 语义）', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ execute: 'auto' }));
		await svc.checkAndApprove(shellCall('npm run build'), shellDef);
		assert.strictEqual(asked(), 0);
	});

	test('★★ 地板：`execute: auto` 也不放行删除类命令（forcedAsk，不可回滚）', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ execute: 'auto' }));
		await svc.checkAndApprove(shellCall('rm -rf build'), shellDef);
		assert.strictEqual(asked(), 1, '删除不可回滚 → 地板必须生效');
	});

	test('★★ 地板：`execute: auto` 也不放行写受保护路径的命令', async () => {
		const { svc, asked } = makeService();
		svc.setToolAllowStore(storeWith({ execute: 'auto' }));
		await svc.checkAndApprove(shellCall('echo x > .git/hooks/pre-commit'), shellDef);
		assert.strictEqual(asked(), 1);
	});
});

function writeCall(path: string): IToolCall {
	return { id: 'call-1', name: 'file_write', arguments: { path, content: 'x' } } as unknown as IToolCall;
}

suite('ToolApprovalService — 受保护路径 fail-closed（P1 修正）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 受保护路径必须弹审批：.git/hooks/pre-commit（代码执行向量）', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(writeCall('.git/hooks/pre-commit'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 1, 'git hook 写入必须弹审批（修正前被自动放行）');
	});

	test('★ 受保护路径必须弹审批：.git/config（core.hooksPath 亦可致代码执行）', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(writeCall('repo/.git/config'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 1, '.git 目录内任意文件必须弹审批');
	});

	test('★ 受保护路径必须弹审批：*.pem / id_rsa / credentials / .env', async () => {
		for (const p of ['certs/server.pem', 'deploy/id_rsa', 'secrets/credentials', '.env']) {
			const { svc, asked } = makeService();
			await svc.checkAndApprove(writeCall(p), FILE_WRITE_DEF);
			assert.strictEqual(asked(), 1, `${p} 必须弹审批`);
		}
	});

	test('★★ 控制组：普通路径仍自动放行（不得误伤高频工作流）', async () => {
		for (const p of ['src/foo.ts', 'docs/readme.md', 'package.json', 'src/vs/base/common/path.ts']) {
			const { svc, asked } = makeService();
			await svc.checkAndApprove(writeCall(p), FILE_WRITE_DEF);
			assert.strictEqual(asked(), 0, `${p} 应自动放行`);
		}
	});

	test('★★ 控制组：`.github/workflows/ci.yml` 不因含 `.git` 子串被误伤', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(writeCall('.github/workflows/ci.yml'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 0, '按**路径段**匹配，`.github` 不等于 `.git`');
	});

	/**
	 * ★★ `.vscode` 是**安全相关**目录（2026-09-13）。
	 *
	 * 三条独立理由（详见 `isProtectedPath` 上方注释）：
	 *  ① **历史上**承载过本系统的授权表（2026-09-13 已迁到 `~/.vssaros/tool-allow.json`，
	 *     符合本项目「数据一律放 .vssaros」约定）—— 旧实现写 `.vscode/settings.json` 的
	 *     `sessions.agentStudio.tools.allowedToolsWorkspace`，不保护就是
	 *     **「被约束者改写约束」**；本条保护仍保留（旧数据可能还留在文件里）；
	 *  ② 承载安全开关 —— 同文件的 `chat.agent.sensitiveReadGuard` 可关掉读守卫；
	 *  ③ `.vscode/tasks.json` 可定义任意命令并在任务运行时执行（同 `.git/hooks` 性质）。
	 *
	 * 语义是 **fail-closed 重问**（不是硬拒）—— 用户真要改时点一次「允许」即可。
	 */
	test('★★ 工作区设置文件（授权表 / 安全开关所在）必须重问', async () => {
		for (const p of ['.vscode/settings.json', '.vscode/tasks.json', '.vscode/extensions.json']) {
			const { svc, asked } = makeService();
			await svc.checkAndApprove(writeCall(p), FILE_WRITE_DEF);
			assert.strictEqual(asked(), 1, `${p} 必须重问（防静默改写授权表）`);
		}
	});

	test('★★ `.code-workspace` 同样承载 settings → 必须重问', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(writeCall('proj.code-workspace'), FILE_WRITE_DEF);
		assert.strictEqual(asked(), 1, '可被「打开工作区」加载，等同 settings');
	});

	test('★★ 控制组：`.vscode` 仅作子串出现时不得误伤', async () => {
		for (const p of ['src/vscode-helpers/a.ts', 'my-vscode/x.ts', 'src/a.ts']) {
			const { svc, asked } = makeService();
			await svc.checkAndApprove(writeCall(p), FILE_WRITE_DEF);
			assert.strictEqual(asked(), 0, `${p} 不应被误伤（按**路径段**精确匹配）`);
		}
	});
});

/**
 * ★★ MCP 来源的工具：审批卡片必须讲明「不经沙箱、无回滚点」（2026-09-13）。
 *
 * 背景：`McpToolProvider.executeTool` 把 arguments **直接透传**给 server，
 * 不经过路径沙箱 / `writeDenyList`，也不创建 checkpoint —— 所以**工具层无法做路径校验**
 * （内容与目标都在 server 侧）。
 *
 * 正确做法**不是硬拒**：用户可能故意装了需要写 `~/.ssh` 的 MCP server（如 SSH 管理类）。
 * 而是让卡片把前提讲清楚，使用户在**知情**下决定 —— 否则它与内置写工具在界面上毫无区别。
 */
suite('ToolApprovalService — MCP 工具的审批提示', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** `McpToolProvider._toDefinition` 的真实形态：`category = mcp:<serverId>`。 */
	const MCP_DEF = {
		name: 'write_file',
		category: 'mcp:filesystem',
		securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const mcpCall: IToolCall = {
		id: 'c1', name: 'write_file', arguments: { path: '/anywhere/x' },
	} as unknown as IToolCall;

	test('★★ MCP 写工具必须弹审批（不得自动放行）', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(mcpCall, MCP_DEF);
		assert.strictEqual(asked(), 1, 'MCP 写工具必须弹审批');
	});

	test('★★ reason 必须讲明「不经沙箱」与「无回滚点」', async () => {
		const { svc, lastRequest } = makeService();
		await svc.checkAndApprove(mcpCall, MCP_DEF);
		const reason = lastRequest()?.reason ?? '';
		assert.match(reason, /MCP server/, reason);
		assert.match(reason, /OUTSIDE the workspace sandbox/, reason);
		assert.match(reason, /does NOT create a rollback checkpoint/, reason);
	});

	test('★★ 控制组：内置工具的 reason 不得出现 MCP 提示', async () => {
		const { svc, lastRequest } = makeService();
		// 用受保护路径确保**一定弹审批**（普通路径会走自动放行，拿不到 request）
		await svc.checkAndApprove(writeCall('.git/config'), FILE_WRITE_DEF);
		const reason = lastRequest()?.reason ?? '';
		assert.ok(reason.length > 0, '受保护路径应弹审批');
		assert.ok(!/MCP server/.test(reason), `内置工具不该出现 MCP 提示：${reason}`);
	});
});

/**
 * ★★ shell 命令里的受保护路径（2026-09-13 补的洞）。
 *
 * `isProtected` 原先只看 `getToolCallPathArg`（工具**参数**），而 shell 工具的路径在
 * `command` **字符串**里 → 恒为 undefined → 用户「始终允许 terminal」之后，
 * `echo x > .git/hooks/pre-commit` 被**静默放行**（下次 commit 执行任意代码）、
 * `Set-Content .vscode/tasks.json` 同样（任务运行时装执行）。
 *
 * 判据真源已抽到 `common/protectedPaths.commandTouchesProtectedPath`（纯函数）。
 * 本 suite 用「**同一条命令**被显式授权后仍必须重问」钉住它 ——
 * 控制组证明该重问**只**由受保护路径触发，普通命令的免打扰不受影响。
 */
suite('ToolApprovalService — shell 命令触及受保护路径必须重问', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SHELL_DEF = {
		name: 'terminal',
		category: 'terminal',
		securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const shellCall = (command: string): IToolCall =>
		({ id: 'c1', name: 'terminal', arguments: { command } } as unknown as IToolCall);

	/** 记录次数，且一律回「本会话始终允许」—— 用来验证受保护路径能否突破 always-allow。 */
	function makeAllowSessionService(): { svc: ToolApprovalService; asked: () => number; lastRequest: () => IToolApprovalRequest | undefined } {
		const svc = new ToolApprovalService();
		let count = 0;
		let last: IToolApprovalRequest | undefined;
		svc.setApprovalHandler({
			requestApproval: async (req: IToolApprovalRequest) => {
				count++;
				last = req;
				return ToolApprovalDecision.AllowSession;
			},
		});
		return { svc, asked: () => count, lastRequest: () => last };
	}

	test('★★ 控制组：普通命令「始终允许」后不再弹（免打扰不受影响）', async () => {
		const { svc, asked } = makeAllowSessionService();
		await svc.checkAndApprove(shellCall('git status'), SHELL_DEF);
		await svc.checkAndApprove(shellCall('git status'), SHELL_DEF);
		assert.strictEqual(asked(), 1, '已授权且非受保护路径 → 第二次不应再弹');
	});

	test('★★ 写 `.git/hooks/*` 的命令：即便被显式授权也必须重问', async () => {
		const { svc, asked } = makeAllowSessionService();
		const cmd = 'echo x > .git/hooks/pre-commit';
		await svc.checkAndApprove(shellCall(cmd), SHELL_DEF);
		assert.strictEqual(asked(), 1, '首次应弹');
		await svc.checkAndApprove(shellCall(cmd), SHELL_DEF);
		assert.strictEqual(asked(), 2, '受保护路径必须重问（fail-closed，与 file_write 写 .git 同等对待）');
	});

	test('★★ 写 `.vscode/tasks.json` 的命令同样必须重问', async () => {
		const { svc, asked } = makeAllowSessionService();
		const cmd = 'Set-Content .vscode/tasks.json -Value x';
		await svc.checkAndApprove(shellCall(cmd), SHELL_DEF);
		await svc.checkAndApprove(shellCall(cmd), SHELL_DEF);
		assert.strictEqual(asked(), 2, '可致代码执行的配置同样 fail-closed');
	});
});

/**
 * ★★ 2026-09-13：**MCP 工具自报 `Safe` 不得免审批**。
 *
 * `McpToolProvider._inferSecurityLevel` 的第 1 条是
 * `annotations.readOnlyHint === true → Safe` —— 而该注解由 **server 自己声明**
 * （MCP 规范称之为 *hint*），客户端**无法验证**。若让 `Safe` 早返回放行它，
 * 就等于把「免审批」的决定权交给被审查方：一个写文件的 MCP 工具只要自称只读即可免审批。
 *
 * `isDestructiveToolCall` 兜不住（只按**工具名**匹配，`apply_change` / `sync_notes`
 * 这类名字不含破坏性动词）。
 *
 * ⚠ `securityLevel: Safe` **本身保留** —— 它还承担 `isToolAllowedInAskMode` 的
 * 「ask/plan 模式下提供哪些工具」过滤。那是「提供与否」（仍受审批门控），
 * 与「免审批执行」是两个决策；前者由自报注解决定可接受，后者不是。
 */
suite('ToolApprovalService — MCP 自报 Safe 不免审批', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 内置只读工具：`Safe` 且非 MCP → 仍应免审批。 */
	const SAFE_INTERNAL = {
		name: 'file_read',
		category: 'filesystem',
		securityLevel: ToolSecurityLevel.Safe,
	} as unknown as IToolDefinition;

	/** MCP 工具自报只读（`readOnlyHint: true` 推出的 Safe）—— 名字刻意**不含**破坏性动词。 */
	const SAFE_MCP = {
		name: 'search_graph',
		category: 'mcp:codebase-memory',
		securityLevel: ToolSecurityLevel.Safe,
	} as unknown as IToolDefinition;

	const call = (name: string): IToolCall =>
		({ id: 'c1', name, arguments: {} } as unknown as IToolCall);

	function makeService(): { svc: ToolApprovalService; asked: () => number; lastRequest: () => IToolApprovalRequest | undefined } {
		const svc = new ToolApprovalService();
		let count = 0;
		let last: IToolApprovalRequest | undefined;
		svc.setApprovalHandler({
			requestApproval: async (req: IToolApprovalRequest) => {
				count++;
				last = req;
				return ToolApprovalDecision.AllowOnce;
			},
		});
		return { svc, asked: () => count, lastRequest: () => last };
	}

	test('★★ 控制组：内置 `Safe` 工具仍免审批（免打扰不得受影响）', async () => {
		const { svc, asked } = makeService();
		assert.strictEqual(await svc.checkAndApprove(call('file_read'), SAFE_INTERNAL), true);
		assert.strictEqual(asked(), 0, '内置只读工具不应弹审批');
	});

	test('★★ MCP 工具即便自报 Safe（readOnlyHint）也必须弹审批', async () => {
		const { svc, asked, lastRequest } = makeService();
		assert.strictEqual(await svc.checkAndApprove(call('search_graph'), SAFE_MCP), true);
		assert.strictEqual(asked(), 1, 'MCP 的 Safe 来自 server 自报注解 → 不可作为免审批依据');
		// 卡片必须讲明前提（与内置工具在界面上不再一样）
		const reason = lastRequest()?.reason ?? '';
		assert.ok(/MCP server/.test(reason), `应提示 MCP 不经沙箱：${reason}`);
	});

	test('★★ 控制组：`category` 非 mcp: 的 Safe 工具仍免审批（不得扩大化）', async () => {
		const { svc, asked } = makeService();
		const notMcp = { name: 'list_files', category: 'filesystem', securityLevel: ToolSecurityLevel.Safe } as unknown as IToolDefinition;
		assert.strictEqual(await svc.checkAndApprove(call('list_files'), notMcp), true);
		assert.strictEqual(asked(), 0);
	});
});

/**
 * ★★ 2026-09-13：**后台 subagent（`inherit`）不得绕过必须用户裁决的动作**。
 *
 * `checkAndApprove` 的审批路由分支里，`inherit` 曾是无条件 `return true` ——
 * 而它排在所有 `isProtected` / `forcedAsk` / MCP 门控**之后**（那些门控只作用于
 * 上方自动放行分支与 `_isAllowed`），于是**后台 subagent 成了绕过全部审批的通道**：
 * 本文件承诺的「受保护路径一律重新弹审批」「删除类命令不参与 always-allow」
 * 「MCP 工具不走任何免审批通道」三条全被它架空。
 *
 * 原理由「能被 LLM 调到的工具即在其权限档内」**已被本项目自己的测试证伪**：
 * `writeExclusion.test.ts` 记录「Explore 档 `canWrite=false`，但其**工具面含 terminal**」——
 * 而 terminal 能写任何路径、能删任何东西 → 「能调到 ≠ 在权限档内」。
 *
 * 非交互上下文里**没有「弹卡片」这个选项**（弹了会永久挂住父级 loop），
 * 所以必须**拒绝**并由 subagent 回报父级（父级有交互能力，可以自己问用户再执行）。
 */
suite('ToolApprovalService — 后台 subagent（inherit）不得绕过必须裁决的动作', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SUBAGENT: IAskRoutingContext = { role: 'subagent' };

	const SHELL_DEF = {
		name: 'terminal', category: 'terminal', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const shellCall = (command: string): IToolCall =>
		({ id: 'c1', name: 'terminal', arguments: { command } } as unknown as IToolCall);

	const MCP_WRITE_DEF = {
		name: 'write_file', category: 'mcp:filesystem', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const mcpCall: IToolCall = { id: 'c2', name: 'write_file', arguments: { path: '/x' } } as unknown as IToolCall;

	test('★★ 控制组：普通命令在 subagent 中仍非交互放行（免打扰保留）', async () => {
		const { svc, asked } = makeService();
		assert.strictEqual(await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF, SUBAGENT), true);
		assert.strictEqual(asked(), 0, '非交互 → 不弹卡片');
	});

	test('★★ 删除类命令：subagent 必须被拒（不得静默执行不可回滚操作）', async () => {
		const { svc, asked } = makeService();
		assert.strictEqual(await svc.checkAndApprove(shellCall('rm -rf build'), SHELL_DEF, SUBAGENT), false);
		assert.strictEqual(asked(), 0, '非交互 → 直接拒绝，不弹卡片');
	});

	test('★★ 受保护路径：subagent 必须被拒（`.git/hooks` 是代码执行向量）', async () => {
		const { svc } = makeService();
		assert.strictEqual(
			await svc.checkAndApprove(shellCall('echo x > .git/hooks/pre-commit'), SHELL_DEF, SUBAGENT),
			false,
		);
	});

	test('★★ MCP 写工具：subagent 必须被拒（未经用户显式授权）', async () => {
		const { svc } = makeService();
		assert.strictEqual(await svc.checkAndApprove(mcpCall, MCP_WRITE_DEF, SUBAGENT), false);
	});

	test('★★ 控制组：用户已显式授权该 MCP 工具 → subagent 沿用授权（inherit 的本来含义）', async () => {
		const svc = new ToolApprovalService();
		let count = 0;
		svc.setApprovalHandler({
			requestApproval: async () => { count++; return ToolApprovalDecision.AllowSession; },
		});
		// 前台调用一次，用户选「本会话始终允许」
		await svc.checkAndApprove(mcpCall, MCP_WRITE_DEF);
		assert.strictEqual(count, 1);
		// 子代理再调用同一工具 → 沿用用户授权，非交互放行（而不是「一律拒绝」）
		assert.strictEqual(await svc.checkAndApprove(mcpCall, MCP_WRITE_DEF, SUBAGENT), true);
		assert.strictEqual(count, 1, '不应再弹卡片');
	});

	test('★★ 控制组：前台（无 routing）仍弹卡片（行为不变）', async () => {
		const { svc, asked } = makeService();
		await svc.checkAndApprove(shellCall('rm -rf build'), SHELL_DEF);
		assert.strictEqual(asked(), 1, '前台仍走交互确认');
	});
});

/**
 * ★★ 2026-09-13：**无审批 handler 时不得无条件放行**（第七条绕过通道）。
 *
 * `if (!this._handler) { return true; }` 此前是**无条件**放行，且**不留日志** ——
 * 受保护路径（写 `.git/hooks` 即代码执行）、删除类命令（`rm -rf`，不可回滚）、
 * MCP 工具（不经沙箱、无 checkpoint）全部静默通过。
 *
 * 而本文件另一处写着「超时按**拒绝**处理（安全优先，**绝不默认放行**危险工具）」——
 * 该分支此前与该原则相反。
 *
 * 无 handler 的真实场景：native chat pane 早期、未创建 webview controller 的宿主、
 * headless 派发。此时**没有 UI 可弹**，只有 allow / deny 两条路 —— 与 `inherit` 同构：
 * 必须用户裁决的动作只能 deny，其余保持降级放行（否则该环境下 agent 完全不可用）。
 */
suite('ToolApprovalService — 无审批 handler 时不得无条件放行', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 刻意**不**注册 handler —— 模拟「宿主没有审批 UI」。 */
	const bare = () => new ToolApprovalService();

	const SHELL_DEF = {
		name: 'terminal', category: 'terminal', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const shellCall = (command: string): IToolCall =>
		({ id: 'c1', name: 'terminal', arguments: { command } } as unknown as IToolCall);

	const MCP_WRITE_DEF = {
		name: 'write_file', category: 'mcp:filesystem', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const mcpCall: IToolCall = { id: 'c2', name: 'write_file', arguments: { path: '/x' } } as unknown as IToolCall;

	test('★★ 控制组：普通命令仍降级放行（该环境下 agent 不得完全不可用）', async () => {
		assert.strictEqual(await bare().checkAndApprove(shellCall('npm run build'), SHELL_DEF), true);
	});

	test('★★ 控制组：`Safe` 工具仍放行（更早的早返回，不受本分支影响）', async () => {
		const safe = { name: 'file_read', category: 'filesystem', securityLevel: ToolSecurityLevel.Safe } as unknown as IToolDefinition;
		assert.strictEqual(
			await bare().checkAndApprove({ id: 'c3', name: 'file_read', arguments: {} } as unknown as IToolCall, safe),
			true,
		);
	});

	test('★★ 删除类命令：必须拒绝（不可回滚）', async () => {
		assert.strictEqual(await bare().checkAndApprove(shellCall('rm -rf build'), SHELL_DEF), false);
	});

	test('★★ 受保护路径：必须拒绝（写 `.git/hooks` 即代码执行）', async () => {
		assert.strictEqual(
			await bare().checkAndApprove(shellCall('echo x > .git/hooks/pre-commit'), SHELL_DEF),
			false,
		);
	});

	test('★★ MCP 写工具：必须拒绝（不经沙箱、无 checkpoint）', async () => {
		assert.strictEqual(await bare().checkAndApprove(mcpCall, MCP_WRITE_DEF), false);
	});

	test('★★ 控制组：用户已显式授权该 MCP 工具 → 无 handler 时也沿用授权（与 inherit 一致）', async () => {
		const svc = new ToolApprovalService();
		// 先在有 UI 时让用户授权
		svc.setApprovalHandler({ requestApproval: async () => ToolApprovalDecision.AllowSession });
		assert.strictEqual(await svc.checkAndApprove(mcpCall, MCP_WRITE_DEF), true);
		// handler 消失（宿主切换 / webview 销毁）
		svc.setApprovalHandler(undefined as unknown as IToolApprovalHandler);
		assert.strictEqual(
			await svc.checkAndApprove(mcpCall, MCP_WRITE_DEF),
			true,
			'与 inherit 的判定必须一致：用户已裁决过 → 不算「需裁决」',
		);
	});

	test('★★ 用户的显式「始终拒绝」在 handler 消失后仍生效', async () => {
		const svc = new ToolApprovalService();
		// 用户先表达一次「始终拒绝」
		svc.setApprovalHandler({ requestApproval: async () => ToolApprovalDecision.DenyAlways });
		assert.strictEqual(await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF), false);
		// 宿主切换 / webview 销毁 → handler 消失
		svc.setApprovalHandler(undefined as unknown as IToolApprovalHandler);
		assert.strictEqual(
			await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF),
			false,
			'用户已表达的决定不该因为没有 UI 就被忽略',
		);
	});
});

/**
 * ★★ 2026-09-13：**显式拒绝优先于允许**（deny-overrides-allow）。
 *
 * 此前 `_isAllowed` 排在 `_isDenied` **之前** —— 于是
 * 「先对 `terminal` 选过『始终允许』（**工具级 blanket**，见 `entryMatches` 注释里
 * 写的旧数据形态），后来又明确拒绝 `terminal::rm -rf`」时**先说的赢**，
 * 用户的显式拒绝被**静默忽略**。
 *
 * 拒绝优先是权限系统的通行约定（如 IAM 的 explicit deny），也更符合直觉。
 *
 * ⚠ 本 suite **只**钉 `_isAllowed` / `_isDenied` 的相对顺序。自动放行分支
 * （沙箱内文件写 / shell 白名单 / execAutoReview）仍**有意**排在 `_isDenied` 之前 ——
 * 见 `isSandboxFileWriteAutoApproved` 的长注释（「不该把编辑能力永久锁死」）。
 */
suite('ToolApprovalService — 显式拒绝优先于允许', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SHELL_DEF = {
		name: 'terminal', category: 'terminal', securityLevel: ToolSecurityLevel.Dangerous,
	} as unknown as IToolDefinition;

	const shellCall = (command: string): IToolCall =>
		({ id: 'c1', name: 'terminal', arguments: { command } } as unknown as IToolCall);

	/** 模拟「工具级 blanket 允许」的持久化数据（旧版本写下的形态）。 */
	const blanketAllowStore = () => ({
		isAllowed: () => true,
		remember: () => { /* noop */ },
		revoke: () => { /* noop */ },
	});

	test('★★ 控制组：无拒绝时，持久化允许仍然生效（免打扰不得受影响）', async () => {
		const svc = new ToolApprovalService();
		svc.setApprovalHandler({ requestApproval: async () => { throw new Error('不应弹审批'); } });
		svc.setToolAllowStore(blanketAllowStore());
		assert.strictEqual(await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF), true);
	});

	test('★★ 工具级 blanket 允许 + 显式拒绝 → 拒绝胜出', async () => {
		const svc = new ToolApprovalService();
		// 1) 先明确拒绝该命令（此时还没有 blanket 允许）
		svc.setApprovalHandler({ requestApproval: async () => ToolApprovalDecision.DenyAlways });
		assert.strictEqual(await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF), false);
		// 2) 再注入「工具级 blanket 允许」（旧数据形态）
		svc.setToolAllowStore(blanketAllowStore());
		// 3) 显式拒绝必须仍然胜出（修正前：`_isAllowed` 先返回 true → 静默放行）
		assert.strictEqual(
			await svc.checkAndApprove(shellCall('npm run build'), SHELL_DEF),
			false,
			'显式拒绝必须压过更宽泛的允许（deny-overrides-allow）',
		);
	});
});
