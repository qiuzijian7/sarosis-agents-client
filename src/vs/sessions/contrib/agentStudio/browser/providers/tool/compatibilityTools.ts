/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
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
import { detectUnixOnlyCommand, UNIX_ONLY_COMMAND_HINTS } from './executeCodeGuards.js';
import { detectGitBash, coreutilsDir } from './gitBashProvider.js';
import { detectHardlineViolation, hardlineViolationMessage } from './commandSafety.js';

export interface CompatToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	agentOS: IAgentOSService;
	fileService: IFileService;
	logService: ILogService;
	id: string;
	/** 工作区根目录（首个 folder 的 fsPath），execute_code 默认 cwd 回退到此处。 */
	workspaceRoot: string | undefined;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, p: string, requireInWorkspace?: boolean) => Promise<string>;
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

		// ── patch: 基础文件补丁 ──────────────────────────────────
		ctx.register({
			definition: {
				name: 'patch',
				description: 'Apply a patch to a file by searching for text and replacing it. Safer than file_write for targeted edits.',
				inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to patch' }, search: { type: 'string', description: 'Text to search for' }, replace: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' } }, required: ['path', 'search', 'replace'] },
				category: 'file', source: ctx.id,
			},
			handler: async (args, _signal, agentId) => {
				const filePath = String(args['path'] ?? '');
				const search = String(args['search'] ?? '');
				const replace = String(args['replace'] ?? '');
				const replaceAll = Boolean(args['replace_all']);
				if (!filePath || !search) { return text('Error: path and search are required'); }
				try {
					const resolved = await ctx.resolveAndCheckWorkspacePath(agentId, filePath);
					const fileUri = URI.file(resolved);
					const buf = await ctx.fileService.readFile(fileUri);
					let content = buf.value.toString();
					if (replaceAll) {
						content = content.split(search).join(replace);
					} else {
						const idx = content.indexOf(search);
						if (idx === -1) { return text(`Search text not found in ${filePath}`); }
						content = content.slice(0, idx) + replace + content.slice(idx + search.length);
					}
					await ctx.fileService.writeFile(fileUri, VSBuffer.fromString(content));
					return text(`Patched ${filePath} (${replaceAll ? 'all occurrences' : 'first occurrence'})`);
				} catch (e) {
					return text(`Error patching ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
				}
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
			description: 'Execute a shell command or script (e.g. a python3/node CLI) and return stdout, stderr and the real exit code. Non-interactive single-shot execution with timeout kill — use THIS (not the interactive terminal) to run one-off CLI scripts such as the anysearch search service: `python3 scripts/anysearch_cli.py search "your query"`. Requires the interpreter (python3/node) to be installed on PATH.' +
				(isWindows ? ' On Windows the command runs via Git Bash (POSIX) when installed — head/tail/grep/sed/awk available with forward-slash paths (C:/dir/file); otherwise cmd.exe where Unix-only commands are rejected with the PowerShell equivalent.' : ''),
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to execute, e.g. "python3 scripts/anysearch_cli.py search \\"your query\\""' },
					cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
					timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' },
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
			const timeoutSec = Math.min(Math.max(Number(args['timeout']) || 30, 1), 120);
			// Hermes 环境归一（2026-08-18）：Git Bash 可用时经主进程以 bash -c 执行
			// （PATH 前缀注入 <gitRoot>\usr\bin → coreutils 可用），跳过 Unix 拦截；
			// 不可用回退 cmd.exe（shell:true）+ 拦截护栏。
			const gitBash = isWindows ? await detectGitBash(ctx.fileService, ctx.logService) : undefined;
			// Windows 护栏：仅【无 Git Bash 回退模式】下拦截 Unix-only 命令（head/grep/sed…
			// 在 cmd.exe 下必败 exit 255），提前抛出带 PowerShell 等价写法的不可重试错误。
			if (isWindows && !gitBash) {
				const unixCmd = detectUnixOnlyCommand(command);
				if (unixCmd) {
					throw new NonRetryableToolError(
						`execute_code: Unix-only command '${unixCmd}' is not available on Windows (cmd.exe, Git Bash not installed) — it would fail with exit 255. ` +
						`Rewrite the pipeline with a PowerShell equivalent: ... | ${UNIX_ONLY_COMMAND_HINTS[unixCmd] ?? unixCmd} ` +
						`(e.g. powershell -NoProfile -Command "<your cmd> | Select-Object -First 60"), then reissue execute_code with the corrected command.`
					);
				}
			}
			const rawCwd = typeof args['cwd'] === 'string' && args['cwd'].trim() ? args['cwd'].trim() : undefined;
			// cwd 不为空时走沙箱校验；否则默认使用工作区根目录（不传 cwd 时
			// Node.js spawn 默认 process.cwd() = Electron app dir，不是 workspace root）。
			// 技能 CLI 不在此做自动解析——绝对路径由技能注入/read_skill 直接给出。
			const cwd: string | undefined = rawCwd
				? await ctx.resolveAndCheckWorkspacePath(undefined, rawCwd, false)
				: ctx.workspaceRoot;
		// Windows cmd 不支持 heredoc（`python3 << 'EOF' ... EOF` 报 "此时不应有 <<", exit 1）。
		// 检测 heredoc：提取解释器 + 脚本，改经 stdin 传给解释器执行（跨平台）。
		const heredoc = _extractHeredoc(command);
		if (heredoc) {
			ctx.logService.info(`[CompatTools] execute_code: heredoc detected, running ${heredoc.interpreter} via stdin`);
		}
		// Git Bash 模式：传 shell 路径 + coreutils PATH 前缀给主进程（Hermes
		// _prepend_git_bash_dirs 同款思路——非登录 bash 不 source /etc/profile，
		// 必须显式把 usr\bin 前置到 PATH，head/tail/grep 等才可用）。
		const result = await _execCodeSandbox(
			command, cwd, timeoutSec * 1000, ctx.logService, heredoc,
			gitBash ? { shell: gitBash.bashPath, pathPrefix: coreutilsDir(gitBash) } : undefined,
		);
			const out = _truncateExecOutput(result.stdout);
			const err = _truncateExecOutput(result.stderr);
			const parts = [`$ ${command}`, ''];
			if (out) { parts.push(out); }
			if (err) { parts.push(`[stderr]\n${err}`); }
			parts.push(`(exit code: ${result.exitCode})`);
			const body = parts.join('\n');
			// 失败（非 0 exit / 启动失败 / 超时）→ 抛错触发失败熔断，避免子代理对失败命令反复重试
			if (!result.success) {
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
			let stdout = ''; let stderr = ''; let settled = false;
			const t = setTimeout(() => {
				if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ success: false, stdout, stderr: stderr + `\n[timeout: process killed after ${Math.round(timeoutMs / 1000)}s]`, exitCode: -1 }); }
			}, timeoutMs);
			child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(t); resolve({ success: false, stdout, stderr: err.message, exitCode: -1 }); } });
			child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(t); resolve({ success: code === 0, stdout, stderr, exitCode: code ?? -1 }); } });
		} catch (err) {
			resolve({ success: false, stdout: '', stderr: String(err), exitCode: -1 });
		}
	});
}

/**
 * 检测 shell heredoc 命令（`python3 << 'EOF'\n<script>\nEOF`），提取解释器与脚本内容。
 * Windows cmd 不支持 heredoc 语法（报 "此时不应有 <<"），需改为经 stdin 传脚本执行。
 * 支持 `<< TAG` / `<<- TAG` / `<< 'TAG'` / `<< "TAG"`，解释器限 python/python3/py/node/deno/bash/sh。
 */
function _extractHeredoc(command: string): { interpreter: string; script: string } | undefined {
	const m = command.match(/^\s*(python3?|py|node|deno|bash|sh)\s*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\r?\n([\s\S]*?)\r?\n\2\s*;?\s*$/);
	if (!m) { return undefined; }
	return { interpreter: m[1], script: m[3] };
}

const EXEC_OUTPUT_MAX = 65536; // 64KB，与 terminal 输出截断一致
function _truncateExecOutput(s: string): string {
	if (!s || s.length <= EXEC_OUTPUT_MAX) { return s; }
	const half = EXEC_OUTPUT_MAX >> 1;
	return s.slice(0, half) + `\n... (${s.length - EXEC_OUTPUT_MAX} chars omitted) ...\n` + s.slice(-half);
}
