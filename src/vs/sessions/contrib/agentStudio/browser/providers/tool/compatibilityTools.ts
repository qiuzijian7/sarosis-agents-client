/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import { IToolResultContent, NonRetryableToolError, ToolSecurityLevel } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import type { ParsedPlanTask } from '../../../common/workMode.js';
import { getPlanQueueHandle } from '../../../common/planQueueRegistry.js';
import { formatCurrentTaskReminder } from '../../../common/preLoopOrchestrator.js';
import type { AgentParadigm } from '../../../common/agentLoopStrategy.js';
import { setParadigmOverride, getParadigmOverride, clearParadigmOverride, SWITCHABLE_PARADIGMS } from '../../../common/paradigmOverride.js';
import { detectUnixOnlyCommand, UNIX_ONLY_COMMAND_HINTS, rewriteUnixPipelineToPowerShell, powerShellEncodedCommand, detectPowerShellOnlyCmdlet, powerShellCmdletGuardMessage, isCommandNotFoundFailure, detectBareSourceCode, bareSourceCodeGuardMessage, isDeterministicScriptFailure, deterministicScriptFailureMessage, detectScriptSourceWrite, scriptSourceWriteGuardMessage } from './executeCodeGuards.js';
import { runExecOutputPipeline } from './execOutputPipeline.js';
import { ProcessOutputCollector } from '../../../common/processOutputDecoder.js';
import { decideOutputSpill, spillFileName, spillNoticeMessage, selectSpillFilesToDelete } from './execOutputSpill.js';
import { resolveSarosPath, userDataRootFromPath, SarosPath } from '../../../common/sarosPaths.js';
import { shellPlatformGuidance, windowsDualShellGuidance } from './shellPlatformPrompt.js';
import { annotateCommandFailure, renderFailureHint } from './commandFailureHints.js';
import { detectGitBash, coreutilsDir } from './gitBashProvider.js';
import { detectHardlineViolation, hardlineViolationMessage } from './commandSafety.js';
import { detectStaleWorktreeAccess, staleWorktreeWarning } from '../../../common/worktreeBinding.js';
import { computePatch } from '../../../common/patchMatcher.js';
import { SHELL_APPROVAL_SHAPE_GUIDANCE } from '../../../common/shellCommandSafety.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { encodeBase64 } from '../../../../../../base/common/buffer.js';

export interface CompatToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	agentOS: IAgentOSService;
	fileService: IFileService;
	logService: ILogService;
	id: string;
	/** 工作区根目录（首个 folder 的 fsPath），execute_code 默认 cwd 回退到此处。 */
	workspaceRoot: string | undefined;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, p: string, requireInWorkspace?: boolean) => Promise<string>;
	/** 回滚点服务 —— patch 免审批后，checkpoint 是用户唯一的撤销手段。 */
	checkpointService: ICheckpointService;
	/** 用于定位 `~/.vssaros/tmp/`（execute_code 超限输出落盘目标）。 */
	environmentService: INativeEnvironmentService;
}

/**
 * _registerCompatibilityTools — 从 builtinToolProvider 抽取（source 硬编码 'saros.builtin-tools'）。
 */
export function registerCompatibilityTools(ctx: CompatToolContext): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// read_skill / list_skills 已在 _registerSkillTools 中注册

	// ── switch_paradigm: 运行时切换 AgentLoop 范式（turn 边界生效）─────────
	// 写入 per-agent 范式覆盖；主循环每次 resolve 策略与注入策略提示词时优先
	// 读取覆盖值。切换只在下一 turn 生效（策略/预算本就 per-turn 创建，无中间态）。
	ctx.register({
		definition: {
			name: 'switch_paradigm',
			description: 'Switch the agent-loop paradigm for subsequent turns. Use "mimo" for task-gated execution (DB-truth stop gate: the loop checks the task board before finishing), "budgeted-react" for the default Hermes-style loop. The switch takes effect on the NEXT turn — the current turn keeps its current paradigm. Pass paradigm="default" to clear the override and fall back to the agent configuration.',
			inputSchema: {
				type: 'object',
				properties: {
					paradigm: {
						type: 'string',
						enum: [...SWITCHABLE_PARADIGMS, 'default'],
						description: 'budgeted-react (Hermes: budget gate + delegation) | mimo (MiMo-Code: budgeted-react + task-board stop gate) | react | plan-explore | readonly | delegation | default (clear override)',
					},
				},
				required: ['paradigm'],
			},
			category: 'utility', source: ctx.id,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) {
				return text('Error: switch_paradigm requires an active agent context.');
			}
			const target = String(args['paradigm'] ?? '');
			if (target === 'default') {
				clearParadigmOverride(agentId);
				return text('✅ Paradigm override cleared — the agent configuration takes effect from the next turn.');
			}
			if (!SWITCHABLE_PARADIGMS.includes(target as AgentParadigm)) {
				return text(`Error: unknown paradigm "${target}". Allowed: ${[...SWITCHABLE_PARADIGMS, 'default'].join(' | ')}`);
			}
			const previous = getParadigmOverride(agentId);
			setParadigmOverride(agentId, target as AgentParadigm);
			const notes: string[] = [];
			if (target === 'mimo') {
				notes.push('MiMo mode: the loop will check the task board (kanban) before finishing — unfinished session tasks trigger re-entry (max 3). Create/complete tasks with kanban_create/kanban_complete so the gate has ground truth.');
			}
			return text(
				`✅ Paradigm switch scheduled: ${previous ? `${previous} → ` : ''}${target} (effective from your NEXT turn). ` +
				`Note: the system prompt strategy section changes with the paradigm, so the prompt cache rebuilds once on the next turn (one-time cost).` +
				(notes.length > 0 ? `\n\n${notes.join('\n')}` : ''),
			);
		},
	});

	// ── plan_register: 注册有序任务队列（方案1：调研 → 拆任务 → 依次执行）────
	// 与 update_plan 的区别：update_plan 是软追踪（仅 UI 卡片，不回读）；
	// plan_register 把任务写入当前 turn 的执行队列 —— 主循环在每轮无工具调用时
	// 自动推进队列并注入 CURRENT TASK 提醒，形成强引导的依次执行。
	ctx.register({
		definition: {
			name: 'plan_register',
			description: 'Register an ordered task queue for sequential execution in this turn. Use AFTER research/exploration (delegate_task/plan_explore) when the goal decomposes into multiple ordered steps: the system injects a CURRENT TASK reminder per task and auto-advances the queue when you finish a task and stop calling tools. Tasks execute in THIS agent turn (not delegated); for parallel independent work use delegate_task instead.',
			inputSchema: {
				type: 'object',
				properties: {
					tasks: {
						type: 'array',
						description: 'Ordered tasks (2-8). They execute strictly in order — put blocking/foundational steps first.',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string', description: 'Short imperative title, e.g. "Add retry logic to fetcher"' },
								description: { type: 'string', description: 'What to do, including key findings from prior research relevant to this task' },
								deliverable: { type: 'string', description: 'Expected output of this task (optional)' },
								files: { type: 'array', items: { type: 'string' }, description: 'Priority files to touch (optional)' },
							},
							required: ['title', 'description'],
						},
					},
				},
				required: ['tasks'],
			},
			category: 'planning', source: ctx.id,
		},
		handler: async (args, _signal, agentId) => {
			const rawTasks = Array.isArray(args['tasks']) ? args['tasks'] as Array<Record<string, unknown>> : [];
			const tasks: ParsedPlanTask[] = rawTasks
				.map(t => ({
					title: String(t?.['title'] ?? '').trim(),
					description: String(t?.['description'] ?? '').trim(),
					deliverable: typeof t?.['deliverable'] === 'string' ? String(t['deliverable']) : undefined,
					files: Array.isArray(t?.['files']) ? (t['files'] as unknown[]).map(String) : undefined,
				}))
				.filter(t => t.title.length > 0);
			if (tasks.length === 0) {
				return text('Error: plan_register requires at least 1 task with a non-empty title.');
			}
			const handle = agentId ? getPlanQueueHandle(agentId) : undefined;
			if (!handle) {
				// 无活动 turn 队列（如非 agent loop 上下文）—— 降级为文本指引，不阻塞流程。
				return text(`No active execution queue for this agent — execute the following tasks in order manually:\n${tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}`);
			}
			handle.setPlan(tasks);
			const reminder = formatCurrentTaskReminder(tasks[0], 0, tasks.length);
			return text(`✅ Registered ${tasks.length} tasks for sequential execution. The queue auto-advances when you finish each task and stop calling tools.\n\n${reminder}`);
		},
	});

	// ── update_plan: LLM 自主规划（对齐 OpenClaw update_plan）─────────
	// 极简模型：LLM 传入完整步骤列表（替换语义），系统仅校验约束。
	// 步骤状态：pending | in_progress | completed
	// 约束：最多一个 in_progress（对齐 OpenClaw PLAN_STEP_STATUSES）
	// 2026-07-04: 替代旧的 todo 工具（CRUD 式 task list），
	// 对齐 OpenClaw 的交织式规划：update_plan → 执行工具 → update_plan（更新状态）
	ctx.register({
		definition: {
			name: 'update_plan',
			displaySummary: 'Track short work plan.',
			replaySafe: true,
			description: 'Update current run plan. ' +
				'Use for non-trivial multi-step work; keep plan current while executing. ' +
				'Short steps; max one in_progress; skip for simple one-step work.',
			inputSchema: {
				type: 'object',
				properties: {
					plan: {
						type: 'array',
						description: 'Ordered list of steps (replaces previous plan).',
						minItems: 1,
						items: {
							type: 'object',
							properties: {
								step: { type: 'string', description: 'Short step description.' },
								status: {
									type: 'string',
									enum: ['pending', 'in_progress', 'completed'],
									description: 'pending | in_progress | completed.',
								},
							},
					required: ['step', 'status'],
				},
					},
					explanation: {
						type: 'string',
						description: 'Optional short note explaining what changed.',
					},
				},
				required: ['plan'],
			},
			category: 'todo', source: ctx.id,
		},
		handler: async (args) => {
			const plan = args['plan'];
			if (!Array.isArray(plan) || plan.length === 0) {
				return text('update_plan error: "plan" must be a non-empty array of steps');
			}
			// 校验约束：最多一个 in_progress（对齐 OpenClaw）
			const inProgressCount = plan.filter(
				(s: any) => s?.status === 'in_progress'
			).length;
			if (inProgressCount > 1) {
				return text(`update_plan error: at most one step may be in_progress (found ${inProgressCount})`);
			}
			// 校验每个步骤
			for (const s of plan) {
				if (!s || typeof s.step !== 'string' || !s.step.trim()) {
					return text('update_plan error: each step must have a non-empty "step" string');
				}
				if (!['pending', 'in_progress', 'completed'].includes(s.status)) {
					return text(`update_plan error: invalid status "${s.status}" for step "${s.step}"`);
				}
			}
			const explanation = args['explanation'] as string | undefined;
			// 对齐 OpenClaw: content: [] — LLM 不重复看到计划文本
			// details 供 UI 渲染结构化计划卡片（进度条 + 步骤状态）
			return {
				content: [] as IToolResultContent[],
				details: {
					status: 'updated' as const,
					plan: plan as Array<{ step: string; status: string }>,
					...(explanation ? { explanation } : {}),
				},
			};
		},
	});

		// ── patch: 定点文件编辑 ──────────────────────────────────
		// 匹配逻辑全在 common/patchMatcher.ts（纯函数、可单测）。
		// 2026-08-21 重写，起因日志 1787311348450：旧实现三次调用全失败却全记为
		// 成功，模型退化成用 execute_code 跑 python3 做字节替换。详见 patchMatcher
		// 顶部注释。这里只负责 IO + 把失败**抛出去**（抛错才会记 FAILED）。
		ctx.register({
			definition: {
				name: 'patch',
				description: 'Apply a targeted edit to a file by replacing an exact block of text. Preferred over file_write for modifying existing files. ALWAYS read the file first (file_read) and copy the "search" text verbatim from it — the match must be exact except for line endings, which are handled automatically. If "search" occurs more than once the call fails, so include enough surrounding context to make it unique (or pass replace_all=true deliberately). Do not issue multiple patch calls for the same file in one batch; apply them one at a time so each sees the previous result.' +
				' RULES: (1) "search" and "replace" MUST differ — a pure-whitespace change is rejected as a no-op. (2) After a successful patch within a region, re-read the file before patching that same region again; the text may have changed, so never assume the previous content is still present.',
				inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to patch' }, search: { type: 'string', description: 'Exact text to search for, copied verbatim from the file' }, replace: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' } }, required: ['path', 'search', 'replace'] },
				// category 必须是 'filesystem'（不是 'file'）：inferSecurityLevel 只在
				// category==='filesystem' 分支里检查 name.includes('patch')。旧值 'file'
				// 使 patch 一路落到名称模式表（其中并无 'patch'）→ 被判 Safe → 全程
				// 无审批、无 checkpoint。此处再显式声明 securityLevel 作双保险，
				// 不再依赖字符串推断。
				category: 'filesystem', source: ctx.id,
				securityLevel: ToolSecurityLevel.Dangerous,
			},
			handler: async (args, _signal, agentId) => {
				const filePath = String(args['path'] ?? '');
				const search = String(args['search'] ?? '');
				const replace = String(args['replace'] ?? '');
				const replaceAll = Boolean(args['replace_all']);
				// 入参缺失是模型的确定性错误，重试同样的参数无意义 → 直接抛不可重试
				if (!filePath || !search) {
					throw new NonRetryableToolError('patch failed: both "path" and "search" are required.');
				}
				const resolved = await ctx.resolveAndCheckWorkspacePath(agentId, filePath);
				const fileUri = URI.file(resolved);
				const buf = await ctx.fileService.readFile(fileUri);
				const original = buf.value.toString();

				const outcome = computePatch(original, search, replace, replaceAll, filePath);
				if (!outcome.ok) {
					// 必须抛错：走 return 会被 executeTool 记成 OK、模型收到"成功"。
					// 用 NonRetryableToolError —— 同参数重试必然同样失败，只会浪费
					// 三次尝试与三倍日志（见 toolExecutor 的 retryable 注释）。
					ctx.logService.warn(`[BuiltinTools] patch ${filePath} rejected: ${outcome.reason}`);
					throw new NonRetryableToolError(outcome.message);
				}

				// ── 回滚点（2026-08-21）────────────────────────────────────
				// patch 免交互审批（见 ToolApprovalService.checkAndApprove 的豁免），
				// 因此 checkpoint 是用户唯一的撤销手段 —— **必须**在写盘前快照。
				// 此前 captureBeforeToolEdit 只有 file_write(coreTools:775) 调用，
				// patch 改文件既不问也留不下回滚点，属真实缺口。
				if (agentId) {
					await ctx.checkpointService.captureBeforeToolEdit(agentId, fileUri.toString(), outcome.content);
				}

				await ctx.fileService.writeFile(fileUri, VSBuffer.fromString(outcome.content));
				const parts = [`Patched ${filePath} — replaced ${outcome.replacedCount} occurrence${outcome.replacedCount === 1 ? '' : 's'}.`];
				if (outcome.lineEndingAdjusted) {
					// 明确告知，避免模型下次仍按 \n 提交而以为是自己运气好
					parts.push(`(Your search text used different line endings; it was converted to the file's ${outcome.lineEnding} before matching.)`);
				}
				return text(parts.join(' '));
			},
		});

	// ── process / session_search ─────────────────
	// 平台不适用 — 返回友好提示（web_search/web_extract 已有真实 handler，不在此注册 stub）
	for (const [name, desc, msg] of [
		['process', 'Manage background processes.', 'Process management is not natively available. Use the terminal tool to launch commands. For long-running processes, use the timeout parameter to control execution duration.'],
		['session_search', 'Search past conversation sessions.', 'Session search is not yet available. Past conversations are stored in ~/.saros/sessions/.'],
	] as const) {
		ctx.register({
			definition: { name, description: desc, inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } }, category: 'utility', source: ctx.id },
			handler: async () => text(msg),
		});
	}

	// ── execute_code：真实代码执行沙箱（主进程 spawn，非交互式，真实 exit code）─────
	// 区别于 terminal（pty 交互 shell，1.5s idle 判完成、无可靠 exit code、无资源限制）：
	// execute_code 经主进程 vscode:execCode 用 child_process.spawn 单次执行命令，拿到
	// 真实 exit code + 超时 kill + 输出截断。researcher 子代理（只读、无 terminal）经此
	// 运行 anysearch CLI（python3 scripts/anysearch_cli.py <cmd>）。
	ctx.register({
		definition: {
			name: 'execute_code',
			// ── description 的「独有约束」原则（2026-08-22 第二轮，日志 1787373914386）──
			//
			// 上一轮（对标 MiMo `tool/bash.txt`）把这段扩成三段式共 2824 chars ≈ **706
			// tokens**，是第二名 search_code（312 tok）的 2.3 倍、27 个工具 description
			// 总量的 22%。而 toolsSchema 恒为 13709 tok，已是 systemPrompt（~5694 tok）
			// 的 2.4 倍 —— 固定开销占首次请求 inputTokens 的 74%。
			//
			// 更关键的是**内容重复**：`environmentDirective.ts:39-45` 早已下发
			// 「Unix-only 命令不可用 + PowerShell 等价物 + For code search, prefer the
			// dedicated search_code / search_files tools over shell pipelines」，
			// `systemPromptComposer` 的 General Tool Usage 也有「When a specialized tool
			// exists, use it directly」。同一条规则讲两遍不仅烧 token，两处不同步时还会
			// 给出矛盾指引。
			//
			// **三层分工原则**（本次确立）：
			//   系统提示词 → 通用规则（讲一次，所有工具共享）
			//   工具 description → 仅该工具**独有**的约束
			//   护栏 → 兜底拦截
			// 故此处只保留系统提示词没有的：patch/file_write 映射（环境段只讲了
			// search_*）、依赖目录可搜、shell 写文件边界、cwd 优先于 cd &&、description
			// 字段要求。PowerShell cmdlet 名一律不再重复（环境段按平台下发，更准确）。
			description: 'Execute a shell command or script (e.g. a python3/node CLI) and return stdout, stderr and the real exit code.'
				+ ' Non-interactive single-shot execution with timeout kill — use THIS (not the interactive terminal) for anything whose'
				+ ' exit code or full output you intend to act on: builds, type checks, test runs, linters, one-off CLI scripts such as'
				+ ' `python3 scripts/anysearch_cli.py search "your query"`. Requires the interpreter (python3/node) on PATH.'
				+ ' The "command" argument must be a SHELL COMMAND LINE, not raw source code — to run inline code pass it to an'
				+ ' interpreter (python3 -c "..." / node -e "...") or use a heredoc.'
				// ① 用途边界：只补系统提示词未覆盖的两条映射 + 依赖目录可搜
				+ '\n\nThis tool is for TERMINAL operations (git, npm, docker, builds, tests, CLI scripts), NOT file operations:'
				+ ' use search_files / search_code / file_read to find and read, patch to edit part of a file, file_write to create one.'
				+ ' Those are indexed and cannot time out on a huge tree. To search a dependency, point search_code\'s path_filter at it'
				+ ' (e.g. node_modules/<pkg>/dist) — allowed and indexed; never hand-roll a script that reads the bundle.'
				// ② shell 写文件的合理边界（系统提示词完全没有；对齐 MiMo bash.gpt.txt）
				+ '\n\nShell writes are fine when they are the natural result of a command (formatter, code generator, build or package'
				+ ' script) or for generated/binary data patch cannot represent. Do NOT use redirection, sed -i or an inline script'
				+ ' merely to bypass patch: those create no checkpoint, skip edit approval, are not reviewable as a diff, and are blocked.'
				// ③ 调用形态：cwd 是本工具独有参数，必须在此说明
				+ '\n\nUse "cwd" instead of `cd <dir> && <cmd>` (good: {command:"npm run compile", cwd:"src/webview"}).'
				+ ' If you must chain dependent commands, use `;` or `&&` on a SINGLE line, never newlines.'
				// ③b 审批形态（2026-08-22）：说明**对模型有意义的后果**，而非实现细节。
				// 背景：原 description 已写「用 cwd 而非 cd && 」，理由却是「worktree/sandbox
				// 检查要重新解析」——对模型无感，实测它照旧写 `cd X && (Get-Content y).Count`。
				// 更糟的是上一行原本主动建议用 `&&`，而 `&&` 恰恰强制触发审批（自相矛盾）。
				// ⚠ 文案真源在 `shellCommandSafety.SHELL_APPROVAL_SHAPE_GUIDANCE`（与
				// BLOCKING_SHELL_TOKENS 同模块），terminal 工具共用同一份 —— 不要在此内联复制。
				+ SHELL_APPROVAL_SHAPE_GUIDANCE
				// ④ description 字段（本工具独有的必填约定）
				+ ' Always pass a short "description" (5-10 words) — it is all the user sees while the command runs.'
				+ (isWindows ? windowsDualShellGuidance('execute_code') : shellPlatformGuidance('posix', 'execute_code')),
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to execute, e.g. "python3 scripts/anysearch_cli.py search \\"your query\\""' },
					// 2026-08-22（对齐 MiMo bash.txt）：5-10 词说明。除 UI/审批卡片展示外，
					// 还解决「args 后到时工具卡空白」—— tool_start 只带工具名，有了
					// description 卡片在命令文本到达前就能显示意图（见 toolCardArgsRefresh）。
					description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words, e.g. "Type-check the webview package". Shown in the UI while the command runs.' },
					cwd: { type: 'string', description: 'Working directory the command runs in (default: workspace root). ALWAYS prefer this over `cd <dir> && <cmd>`: the `&&` forces a user-approval prompt that interrupts you, a leading cd has to be re-parsed out of the command string for worktree/sandbox checks, and it silently breaks when the command is later edited.' },
					timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 120). Raise it for builds/test suites; a killed command returns exit -1 and its output is lost.' },
				},
				required: ['command'],
			},
			category: 'terminal', source: ctx.id, securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args) => {
			const command = String(args['command'] ?? '').trim();
			if (!command) { throw new Error('command is required'); }
			// HARDLINE 不可绕过地板（灾难性/不可逆命令，任何审批与自主模式都无法放行）
			const hardline = detectHardlineViolation(command);
			if (hardline) {
				throw new NonRetryableToolError(hardlineViolationMessage(hardline, 'execute_code'));
			}
			// 裸源码护栏（2026-08-21，日志 1787292837471）：模型把多行 Python 源码
			// 直接当 command 传入 → shell 拿 `import` 当程序名 → exit 1。
			// 平台无关（POSIX shell 同样失败），故置于平台护栏之前。
			const bareSource = detectBareSourceCode(command);
			if (bareSource) {
				throw new NonRetryableToolError(bareSourceCodeGuardMessage(bareSource, 'execute_code'));
			}
			// 源码写入护栏（2026-08-21，日志 1787319805992）：patch 连败后模型退化为
			// 跑 python heredoc 直接 open(p,"w") 重写 .tsx，且成功 —— shell 路径不留
			// checkpoint、不过编辑审批，仓库被改却无回滚点。详见 executeCodeGuards。
			const sourceWrite = detectScriptSourceWrite(command);
			if (sourceWrite) {
				ctx.logService.warn(
					`[CompatTools] execute_code BLOCKED: script writes source file directly ` +
					`(${sourceWrite.api}, target=${sourceWrite.target})`,
				);
				throw new NonRetryableToolError(scriptSourceWriteGuardMessage(sourceWrite, 'execute_code'));
			}
			// 2026-08-29（日志 1787974178941）：移除 `timeout` 的 120s 封顶。
		//
		// 事故：本项目 `npm run compile` 全量编译必然 >120s，被主进程 process tree
		// killed 强杀（exit -1）。模型拿不到编译结果只能反复重试，单轮 140s+，
		// 表现为「LLM 卡住」——真正卡的是这个工具超时上限。
		//
		// 新语义（与 app.ts 的 vscode:execCode 保持一致）：
		//   · 未传      → 沿用默认 30s（保留安全兜底）
		//   · 正数      → 按该值（不再封顶，可任意大）
		//   · 0/负数/非法 → 0，表示**不限时**，跑完为止
		const _rawTimeout = args['timeout'];
		let timeoutSec: number;
		if (_rawTimeout === undefined || _rawTimeout === null || _rawTimeout === '') {
			timeoutSec = 30;
		} else {
			const _n = Number(_rawTimeout);
			timeoutSec = Number.isFinite(_n) && _n > 0 ? _n : 0;
		}
			// Hermes 环境归一（2026-08-18）：Git Bash 可用时经主进程以 bash -c 执行
			// （PATH 前缀注入 <gitRoot>\usr\bin → coreutils 可用），跳过 Unix 拦截；
			// 不可用回退 cmd.exe（shell:true）+ 拦截护栏。
			const gitBash = isWindows ? await detectGitBash(ctx.fileService, ctx.logService) : undefined;
			// Windows 护栏：仅【无 Git Bash 回退模式】下处理 Unix-only 命令（head/grep/sed…
			// 在 cmd.exe 下必败 exit 255）。
			//
			// 2026-08-20（日志 1787217670299）：此前一律抛 NonRetryableToolError 让模型
			// 自行改写，但实测同一会话里它连续 3 次照旧发 `grep` —— 提示给的是「模式」
			// 而非可执行命令。现改为**能安全映射就直接改写并执行**（head/tail/grep →
			// Select-Object/Select-String，经 -EncodedCommand 绕开 cmd+PS 双层转义），
			// 仅 sed/awk 等语义不可一一对应的形态才保留抛错。
			let effectiveCommand = command;
			const rewriteNotes: string[] = [];
			if (isWindows && !gitBash) {
				const unixCmd = detectUnixOnlyCommand(command);
				if (unixCmd) {
					const rewrite = rewriteUnixPipelineToPowerShell(command);
					if (rewrite) {
						effectiveCommand = powerShellEncodedCommand(
							rewrite.script,
							bytes => encodeBase64(VSBuffer.wrap(bytes)),
						);
						rewriteNotes.push(...rewrite.notes);
						ctx.logService.info(
							`[CompatTools] execute_code: auto-rewrote Unix pipeline to PowerShell — ${rewrite.notes.join('; ')}`,
						);
					} else {
						throw new NonRetryableToolError(
							`execute_code: Unix-only command '${unixCmd}' is not available on Windows (cmd.exe, Git Bash not installed) — it would fail with exit 255, ` +
							`and its arguments cannot be mapped to PowerShell automatically. ` +
							`Rewrite the pipeline with a PowerShell equivalent: ... | ${UNIX_ONLY_COMMAND_HINTS[unixCmd] ?? unixCmd} ` +
							`(e.g. powershell -NoProfile -Command "<your cmd> | Select-Object -First 60"), then reissue execute_code with the corrected command. ` +
							`For searching file CONTENT prefer search_code, and for finding FILES prefer search_files — both are indexed and need no shell.`
						);
					}
				}
				// 反向护栏（2026-08-21，日志 1787292837471）：模型「过度纠正」——读了上面
				// 的 PowerShell 提示却漏掉 `powershell -Command` 外壳，把 cmdlet 直接塞进
				// cmd.exe 管道（`... | Out-String -Width 500`）→ exit 255 必败。
				// 与 Unix 方言完全对称，同样在执行前拦下并给出正确包裹写法。
				// 放在 Unix 改写之后：自动改写产出的是 -EncodedCommand（含 powershell），
				// 天然被 detectPowerShellOnlyCmdlet 的「已包裹」判定放行。
				const psCmdlet = detectPowerShellOnlyCmdlet(effectiveCommand);
				if (psCmdlet) {
					throw new NonRetryableToolError(powerShellCmdletGuardMessage(psCmdlet, 'execute_code'));
				}
			}
			const rawCwd = typeof args['cwd'] === 'string' && args['cwd'].trim() ? args['cwd'].trim() : undefined;
			// cwd 不为空时走沙箱校验；否则默认使用工作区根目录（不传 cwd 时
			// Node.js spawn 默认 process.cwd() = Electron app dir，不是 workspace root）。
			// 技能 CLI 不在此做自动解析——绝对路径由技能注入/read_skill 直接给出。
			const cwd: string | undefined = rawCwd
				? await ctx.resolveAndCheckWorkspacePath(undefined, rawCwd, false)
				: ctx.workspaceRoot;

			// ── 越界访问未绑定 worktree 副本（2026-08-20，日志 1787217670299）────────
			// execute_code 是 shell，对 `cd .worktrees/<branch>/...` 没有任何路径约束，
			// 而 `.worktrees/**` 对 search_code / search_files / 代码图是硬排除的。该次
			// 事故里模型正是在 `.worktrees/feat-chat` 的过期副本里用 findstr 反复找主仓
			// 才有的符号（连续 exit 1），搜索永远无从印证。此处**不阻断执行**（用户可能
			// 就是要排查某个 worktree），但把警告与主仓等价路径附在输出里让模型能纠正。
			//
			// 检测对象是 cwd + 原始命令串（路径常直接写在 `cd` / findstr 参数里）。
			const worktreeHit = detectStaleWorktreeAccess(cwd, undefined)
				?? detectStaleWorktreeAccess(command.replace(/\\/g, '/'), undefined);
			const worktreeNote = worktreeHit ? staleWorktreeWarning(worktreeHit, 'shell command') : undefined;
			if (worktreeNote) {
				ctx.logService.warn(`[CompatTools] execute_code: ${worktreeNote}`);
			}
		// Windows cmd 不支持 heredoc（`python3 << 'EOF' ... EOF` 报 "此时不应有 <<", exit 1）。
		// 检测 heredoc：提取解释器 + 脚本，改经 stdin 传给解释器执行（跨平台）。
		// 注意用 effectiveCommand：Unix→PowerShell 改写后不含 heredoc，检测自然落空。
		const heredoc = _extractHeredoc(effectiveCommand);
		if (heredoc) {
			ctx.logService.info(`[CompatTools] execute_code: heredoc detected, running ${heredoc.interpreter} via stdin`);
		}
		// Git Bash 模式：传 shell 路径 + coreutils PATH 前缀给主进程（Hermes
		// _prepend_git_bash_dirs 同款思路——非登录 bash 不 source /etc/profile，
		// 必须显式把 usr\bin 前置到 PATH，head/tail/grep 等才可用）。
		const result = await _execCodeSandbox(
			effectiveCommand, cwd, timeoutSec * 1000, ctx.logService, heredoc,
			gitBash ? { shell: gitBash.bashPath, pathPrefix: coreutilsDir(gitBash) } : undefined,
		);
			// 传入模型的原始命令（非 base64 改写后的）—— Shape 选择与 passthrough
			// 判定都要看模型的真实意图（`--json` 等标志在改写后仍在，但 heredoc 包装
			// 会掩盖 `tsc` 之类的形态特征）。
			//
			// 2026-08-22：管道之后仍超限的，改为**全量落盘 + 内联头部 + 检索引导**，
			// 替代原先的「中段永久丢弃」（关键错误常正落在中段）。落盘失败则退回截断。
			const pipedOut = _pipeExecOutput(result.stdout, command);
			const pipedErr = _pipeExecOutput(result.stderr, command);
			const spilled = await _spillIfNeeded(ctx, command, pipedOut, pipedErr);
			const out = spilled.stdout;
			const err = spilled.stderr;
			// 回显模型原始命令（而非 base64 后的 -EncodedCommand），改写另行注明——
			// 否则模型看到一串 base64 完全无法理解自己执行了什么。
			const parts = [`$ ${command}`, ''];
			if (rewriteNotes.length > 0) {
				parts.push(
					`[rewrite-note] Unix-only commands are unavailable here (no Git Bash); the pipeline was ` +
					`auto-translated to PowerShell and executed as such: ${rewriteNotes.join('; ')}. ` +
					`Issue PowerShell syntax directly next time, or better: use search_code / search_files ` +
					`(indexed, no shell) for content/file lookup.`,
					'',
				);
			}
			if (worktreeNote) { parts.push(worktreeNote, ''); }
			if (out) { parts.push(out); }
			if (err) { parts.push(`[stderr]\n${err}`); }
			parts.push(`(exit code: ${result.exitCode})`);
			// ── 失败下一步提示（Hermes terminal_hints 式，2026-08-21）───────────
			// 工具级重试已移除（重试决策交给模型），因此必须由提示明确告知「别重试」
			// 还是「稍后重试」，否则模型只会盲目重发同一条必败命令。
			// 至多一条、只说下一步动作；命中不了就不产出（宁缺毋滥）。
			const failureHint = result.success
				? undefined
				: annotateCommandFailure(result.exitCode, `${result.stdout}\n${result.stderr}`);
			if (failureHint) {
				parts.push('', renderFailureHint(failureHint));
				ctx.logService.info(`[CompatTools] execute_code failure hint: ${failureHint.id} (exit ${result.exitCode})`);
			}
			const body = parts.join('\n');
			// 失败（非 0 exit / 启动失败 / 超时）→ 抛错触发失败熔断，避免子代理对失败命令反复重试
			if (!result.success) {
				// 失败分类（2026-08-21，日志 1787292837471）：「命令/程序不存在」是**确定性
				// 失败** —— 命令名不会在退避间隙里变对。旧版一律抛普通 Error → toolExecutor
				// 判为可重试 → 退避重试 3 次（实测 exit 255 `'Out-String' 不是内部或外部命令`
				// 与 exit 1 `'import' 不是内部或外部命令` 各重试 3 次，浪费 4 次执行 + ~6s
				// 退避，模型只拿到同一条错误重复 3 遍）。工具级重试其后已整体移除
				// （460 份日志 216 次重试 0 次成功），分类仍保留 —— 其错误文案是模型引导。
				const combined = `${result.stdout}\n${result.stderr}`;
				if (isCommandNotFoundFailure(combined)) {
					throw new NonRetryableToolError(
						`execute_code failed (exit ${result.exitCode}) — command or program not found; retrying will not help.\n${body}\n` +
						`Fix the command itself: verify the executable name exists on this platform ` +
						`(Windows shell here), or wrap PowerShell cmdlets in powershell -NoProfile -Command "...". ` +
						`If you meant to run inline source code, pass it to an interpreter (e.g. python3 -c "...") ` +
						`instead of issuing the source as a shell command.`
					);
				}
				// 脚本自身语法/逻辑错误同样确定性（2026-08-21，日志 1787302409958 ITER 50：
				// heredoc 内 assert 失败 → exit 1 被重试 3 次）。刻意保守，只认解释器
				// 明确报出的确定性异常类型，编译/网络类 exit 1 仍保留重试。
				if (isDeterministicScriptFailure(combined)) {
					throw new NonRetryableToolError(deterministicScriptFailureMessage(result.exitCode, body));
				}
				throw new Error(`execute_code failed (exit ${result.exitCode}):\n${body}`);
			}
			return text(body);
		},
	});

	ctx.logService.info('[BuiltinTools] _registerCompatibilityTools: registered aliases + missing core tools');
}

// ── execute_code 沙箱执行 helpers ────────────────────────────────────────────
interface IExecCodeResult { success: boolean; stdout: string; stderr: string; exitCode: number; }

/**
 * 技能 CLI 路径策略（用户拍板 2026-08-03）：execute_code **不**自动到 skillRegistry
 * 查找脚本。绝对路径由技能注入/read_skill 直接给出（_renderInjection 的
 * scriptPaths 与 read_skill 返回的 scriptPaths 字段），模型应直接使用绝对路径
 * 调用 CLI——从根上避免相对路径 + cwd 解析问题。
 */

async function _execCodeSandbox(command: string, cwd: string | undefined, timeoutMs: number, logService: ILogService, heredoc?: { interpreter: string; script: string }, shellExec?: { shell: string; pathPrefix: string }): Promise<IExecCodeResult> {
	// 优先：主进程 vscode:execCode（Electron 桌面，主进程 child_process.spawn，见 app.ts）。
	const vscodeBridge = (globalThis as any).vscode;
	if (vscodeBridge?.ipcRenderer?.invoke) {
		try {
			logService.trace(`[CompatTools] execute_code via main-process vscode:execCode: ${command}${shellExec ? ` (shell=${shellExec.shell})` : ''}`);
			return await vscodeBridge.ipcRenderer.invoke('vscode:execCode', heredoc
				? { script: heredoc.script, interpreter: heredoc.interpreter, cwd, timeoutMs }
				: { command, cwd, timeoutMs, shell: shellExec?.shell, pathPrefix: shellExec?.pathPrefix }) as IExecCodeResult;
		} catch (invokeErr) {
			logService.warn(`[CompatTools] execute_code: vscode:execCode invoke failed, trying child_process fallback: ${invokeErr}`);
		}
	}
	// 回退：当前上下文可直接 require child_process（Electron renderer nodeIntegration）。
	if (typeof process !== 'undefined' && (process as any).versions?.electron) {
		return _execCodeNodeFallback(command, cwd, timeoutMs, heredoc, shellExec);
	}
	throw new Error('execute_code is not available in this context (no main-process channel, no child_process)');
}

function _execCodeNodeFallback(command: string, cwd: string | undefined, timeoutMs: number, heredoc?: { interpreter: string; script: string }, shellExec?: { shell: string; pathPrefix: string }): Promise<IExecCodeResult> {
	return new Promise((resolve) => {
		try {
			// eslint-disable-next-line local/code-import-patterns
			const cp = require('child_process') as typeof import('child_process');
			// 与主进程 vscode:execCode 一致：强制 Python UTF-8 输出（Windows 默认 GBK
			// 遇 emoji 等抛 UnicodeEncodeError exit 1）。
			// Git Bash 模式（2026-08-18）：shell 指定 bash.exe，PATH 前置 coreutils。
			const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } as Record<string, string>;
			const shellOpt: boolean | string = shellExec?.shell ?? true;
			if (shellExec && env.PATH && !env.PATH.toLowerCase().startsWith(shellExec.pathPrefix.toLowerCase())) {
				env.PATH = `${shellExec.pathPrefix};${env.PATH}`;
			}
			const child = heredoc
				? cp.spawn(heredoc.interpreter, [], { cwd, env, windowsHide: true })
				: cp.spawn(command, [], { shell: shellOpt, cwd, env, windowsHide: true });
			if (heredoc) { child.stdin?.write(heredoc.script); child.stdin?.end(); }
			// 输出解码与主进程 handler 一致（2026-08-22）：收集字节 + 结束时整体解码。
			// 逐 chunk `d.toString()` 有两个缺陷 —— 按 UTF-8 解 Windows 控制台的 CP936
			// 中文错误得到 mojibake；且跨 chunk 的多字节字符会被切断。
			// renderer 侧拿不到 chcp 探测结果，传 undefined 让解码器用 gbk 作回退候选
			// （先严格试 UTF-8，通过就用 UTF-8，故对非中文环境无副作用）。
			const stdoutCollector = new ProcessOutputCollector();
			const stderrCollector = new ProcessOutputCollector();
			let settled = false;
			// 与主进程 app.ts 保持一致：timeoutMs=0 表示**不限时**，不安装 kill timer。
			// ⚠ 直接 setTimeout(fn, 0) 会被理解成"下一轮事件循环立即执行" → 命令刚 spawn
			// 就被判超时杀掉，与"不限时"的语义完全相反。clearTimeout(undefined) 是安全的
			// no-op，下方 error/close 回收不受影响。
			const t = timeoutMs > 0 ? setTimeout(() => {
				if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ success: false, stdout: stdoutCollector.decode(), stderr: stderrCollector.decode() + `\n[timeout: process killed after ${Math.round(timeoutMs / 1000)}s]`, exitCode: -1 }); }
			}, timeoutMs) : undefined;
			child.stdout?.on('data', (d: Buffer) => stdoutCollector.push(d));
			child.stderr?.on('data', (d: Buffer) => stderrCollector.push(d));
			child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(t); resolve({ success: false, stdout: stdoutCollector.decode(), stderr: err.message, exitCode: -1 }); } });
			child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(t); resolve({ success: code === 0, stdout: stdoutCollector.decode(), stderr: stderrCollector.decode(), exitCode: code ?? -1 }); } });
		} catch (err) {
			resolve({ success: false, stdout: '', stderr: String(err), exitCode: -1 });
		}
	});
}

/**
 * 检测 shell heredoc 命令（`python3 << 'EOF'\n<script>\nEOF`），提取解释器与脚本内容。
 * Windows cmd 不支持 heredoc 语法（报 "此时不应有 <<"），需改为经 stdin 传脚本执行。
 * 支持 `<< TAG` / `<<- TAG` / `<< 'TAG'` / `<< "TAG"`，解释器限 python/python3/py/node/deno/bash/sh。
 *
 * ⚠ 解释器后允许 flag 参数（2026-08-20 修）：模型很常写 `python3 - <<'PY'`
 * （`-` = 从 stdin 读脚本，与 heredoc 语义重复但完全合法）、`python3 -u <<'PY'`、
 * `node --input-type=module <<'JS'`。此前正则只允许 `解释器\s*<<`，这类写法
 * **匹配失败** → 落到 shell 分支 → Windows cmd 报 "此时不应有 <<"（exit 1），
 * 模型拿到无意义报错后常原样重试，白烧多轮（实测事故日志 1787210015867）。
 * 现在把 flag 段（`-`、`-u`、`--flag=value` 等）纳入匹配并丢弃：脚本经 stdin
 * 喂给解释器时 `-` 本就是默认行为，其余 flag 对本用途无影响。
 */
function _extractHeredoc(command: string): { interpreter: string; script: string } | undefined {
	const m = command.match(/^\s*(python3?|py|node|deno|bash|sh)((?:\s+-{1,2}[A-Za-z0-9][\w-]*(?:=\S+)?|\s+-)*)\s*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\r?\n([\s\S]*?)\r?\n\3\s*;?\s*$/);
	if (!m) { return undefined; }
	return { interpreter: m[1], script: m[4] };
}

const EXEC_OUTPUT_MAX = 65536; // 64KB，与 terminal 输出截断一致

/** 只跑 token 效率管道，不截断（截断/落盘由 _spillIfNeeded 决定）。 */
function _pipeExecOutput(s: string, command: string): string {
	if (!s) { return s; }
	return runExecOutputPipeline(s, command).text;
}

/** 落盘序号 —— 同一毫秒内多次落盘也不重名。 */
let _spillSeq = 0;

/**
 * 超限输出落盘：把全量写入 `~/.vssaros/tmp/`，返回「内联头部 + 检索引导」。
 *
 * 为什么落这里而不是工作区：`~/.vssaros` 是沙箱 5 个允许根之一，模型后续
 * `file_read` 该路径不会触发越界确认卡片；写工作区 tmp/ 会污染用户仓库与
 * git status。详见 execOutputSpill 头注释。
 *
 * **任何 IO 失败都必须优雅退化为截断** —— 落盘只是优化，绝不能让它把一次成功的
 * 命令执行变成工具错误。
 */
async function _spillIfNeeded(
	ctx: CompatToolContext,
	command: string,
	stdout: string,
	stderr: string,
): Promise<{ stdout: string; stderr: string }> {
	const dOut = decideOutputSpill(stdout);
	const dErr = decideOutputSpill(stderr);
	if (!dOut.shouldSpill && !dErr.shouldSpill) {
		return { stdout, stderr };
	}
	try {
		const tmpDir = resolveSarosPath(userDataRootFromPath(ctx.environmentService.userDataPath), SarosPath.tmp);
		await ctx.fileService.createFolder(tmpDir);
		await _pruneSpillFiles(ctx, tmpDir);

		const now = new Date();
		const fileName = spillFileName(now, ++_spillSeq);
		const target = joinPath(tmpDir, fileName);
		// 单个文件里同时保存两个流，附命令头 —— 模型只需读一个路径
		const body = [
			`# command: ${command}`,
			`# captured: ${now.toISOString()}`,
			'',
			'===== stdout =====',
			stdout,
			'',
			'===== stderr =====',
			stderr,
		].join('\n');
		await ctx.fileService.writeFile(target, VSBuffer.fromString(body));
		ctx.logService.info(
			`[CompatTools] execute_code: output spilled to ${target.fsPath} ` +
			`(stdout=${dOut.totalChars} stderr=${dErr.totalChars} chars)`,
		);
		return {
			stdout: dOut.shouldSpill
				? spillNoticeMessage(target.fsPath, dOut.totalChars, dOut.inlineHead)
				: stdout,
			stderr: dErr.shouldSpill
				? spillNoticeMessage(target.fsPath, dErr.totalChars, dErr.inlineHead)
				: stderr,
		};
	} catch (e) {
		ctx.logService.warn(`[CompatTools] execute_code: output spill failed, falling back to truncation: ${e}`);
		return { stdout: _truncateExecOutput(stdout), stderr: _truncateExecOutput(stderr) };
	}
}

/** 回收超龄/超量的落盘文件（失败不影响主流程）。 */
async function _pruneSpillFiles(ctx: CompatToolContext, tmpDir: URI): Promise<void> {
	try {
		const stat = await ctx.fileService.resolve(tmpDir, { resolveMetadata: true });
		const files = (stat.children ?? [])
			.filter(c => !c.isDirectory)
			.map(c => ({ name: c.name, mtimeMs: c.mtime ?? 0 }));
		const toDelete = selectSpillFilesToDelete(files, Date.now());
		for (const name of toDelete) {
			try { await ctx.fileService.del(joinPath(tmpDir, name)); } catch { /* 单个失败跳过 */ }
		}
		if (toDelete.length > 0) {
			ctx.logService.trace(`[CompatTools] pruned ${toDelete.length} stale exec-output file(s)`);
		}
	} catch { /* 目录不存在等 —— 无需回收 */ }
}

/**
 * 输出后处理：先过 token 效率管道，仍超限才头尾截断。
 *
 * ★ 2026-08-22（横向对标 MiMo-Code 的 bash_token_efficient_* 后重构）：原实现**只有**
 * 头尾截断 —— ANSI 转义、`\r` 进度帧、npm deprecation、依赖栈帧全部原样占 token，
 * 而真正有用的中段被永久丢弃。tsc 这类「同一根因重复几十上百条」的输出是最坏情况：
 * 头尾各半会同时保留大量重复 + 丢掉中段。
 *
 * 现在顺序是「先降噪聚合，再截断」，且管道内部有 never-worse 契约（任何没让字节变小
 * 的步骤一律丢弃），所以最坏情况不劣于原实现。
 */
function _truncateExecOutput(s: string, command?: string): string {
	if (!s) { return s; }
	let out = s;
	if (command) {
		const piped = runExecOutputPipeline(s, command);
		out = piped.text;
	}
	if (out.length <= EXEC_OUTPUT_MAX) { return out; }
	const half = EXEC_OUTPUT_MAX >> 1;
	return out.slice(0, half) + `\n... (${out.length - EXEC_OUTPUT_MAX} chars omitted) ...\n` + out.slice(-half);
}
