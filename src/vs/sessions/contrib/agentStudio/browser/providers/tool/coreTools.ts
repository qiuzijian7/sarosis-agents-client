/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core Tools — clarify / file_read / file_write / search_files / terminal，及其文件系统读取守卫
 * (redact / read-dedup / repeat / similar-files / levenshtein / terminal 执行)。
 *
 * 从 builtinToolProvider.ts 的 _registerCoreTools + 一组私有 helper 抽出，降低主文件体积。
 *
 * 共享依赖经 ctx 传入：
 *  - `resolveAndCheckWorkspacePath`：仍被 compat / knowledge 等工具复用，留在主文件。
 *  - `searchHelpers`：SearchHelpers 实例（主文件持有，核心工具独占使用）。
 *  - 文件读取去重/重复 Map 保存在本函数的闭包中（随 tool handler 生命周期存活）。
 */

import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import { SearchHelpers, redactSecrets } from './searchHelpers.js';
import { detectTerminalSearchCommand, terminalSearchCommandHint } from './terminalCommandGuards.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface CoreToolContext {
	register(reg: IBuiltinToolRegistration): IDisposable;
	logService: ILogService;
	id: string;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, requestedPath: string, checkSandbox?: boolean) => Promise<string>;
	fileService: IFileService;
	searchHelpers: SearchHelpers;
	checkpointService: ICheckpointService;
	terminalService: ITerminalService;
	workspaceService: IWorkspaceContextService;
}

// ── 静态常量（原 BuiltinToolProvider 静态成员）────────────────────────
const READ_MAX_LIMIT = 2000;
const READ_LINE_MAX_CHARS = 2000;
const READ_MAX_CHARS = 100_000;
const LARGE_FILE_HINT_BYTES = 512 * 1024;
const LARGE_FILE_HINT_MIN_LIMIT = 200;
/** 上下文窗口大小（2026-07-26 P2 动态上下文保护）：全读大文件时按占比警告 */
const CONTEXT_WINDOW_TOKENS = 128_000;
// P1: 写文件敏感路径拒绝列表（对齐 Hermes file_safety.py）
const WRITE_DENIED_PREFIXES = ['.ssh/', '.aws/', '.kube/', '.config/gcloud/', '.git-credentials'];
const WRITE_DENIED_EXACT = ['.env', '.env.local', '.env.production', '.env.development', 'auth.json', '.npmrc', '.pypirc'];
// P2: 读文件设备/敏感路径拒绝（对齐 Hermes _is_blocked_device + get_read_block_error）
const READ_BLOCKED_PREFIXES = ['/dev/', '/proc/', '/sys/'];
const READ_BLOCKED_EXACT = ['auth.json', '.env', '.anthropic_oauth.json'];
const READ_REPEAT_WARN = 3;
const READ_REPEAT_BLOCK = 4;
const READ_DEDUP_BLOCK = 2;
const READ_DEDUP_CAP = 500;
const READ_REPEAT_CAP = 1000;

/** 计算两个字符串的 Levenshtein 编辑距离（Wagner-Fischer 算法）。 */
function _levenshtein(a: string, b: string): number {
	const m = a.length, n = b.length;
	// 优化：一维滚动数组（O(min(m,n)) 空间）
	if (m < n) { return _levenshtein(b, a); }
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			curr[j] = a[i - 1] === b[j - 1]
				? prev[j - 1]
				: 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

export function registerCoreTools(ctx: CoreToolContext): { resetPerTurn(): void } {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	// 文件读取去重 Map / 重复检测 Map / 读 mtime Map：随 provider 生命周期存活（闭包）。
	const _readDedupMap = new Map<string, { mtime: number; stubCount: number }>();
	const _readRepeatMap = new Map<string, { key: string; count: number }>();
	const _fileReadMtimeMap = new Map<string, number>();

	async function executeTerminalCommand(
		command: string,
		cwd: string | undefined,
		timeoutSec: number,
		signal?: AbortSignal,
	): Promise<IToolResultContent[]> {
		// 如果已被取消，直接返回
		if (signal?.aborted) {
			return [{ type: 'text', text: 'Command execution was cancelled before it started.' }];
		}

		try {
			// 工作目录：调用方已通过 resolveAndCheckWorkspacePath 校验为允许根内的绝对路径。
			// 仅在异常缺失时回退到 VS Code 工作区文件夹（不应发生）。
			const workspaceFolders = ctx.workspaceService.getWorkspace().folders;
			const effectiveCwd = cwd ?? (workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined);

			// 创建临时终端实例
			const instance = await ctx.terminalService.createTerminal({
				config: {
					type: 'Task',
					name: `Agent: ${command.slice(0, 40)}`,
					cwd: effectiveCwd,
					isFeatureTerminal: true,
					hideFromUser: false,
				},
			});

			if (!instance) {
				return [{ type: 'text', text: `Error: Failed to create terminal instance for command execution.` }];
			}

			// 收集输出数据
			const outputChunks: string[] = [];
			let dataListener: IDisposable | undefined;
			let exitListener: IDisposable | undefined;

			const IDLE_TIMEOUT_MS = 1500; // 1.5s 无新输出视为命令完成

			const outputPromise = new Promise<string>((resolve) => {
				let idleTimer: ReturnType<typeof setTimeout>;

				const markIdle = () => {
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
				};

				// 监听数据输出
				dataListener = instance.onData((data: string) => {
					// 去除 ANSI 转义序列和终端垃圾信息
					const clean = data
						// ANSI SGR (颜色、样式)
						.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '')
						// ANSI OSC (窗口标题等)
						.replace(/\x1b\][^\x07]*\x07/g, '')
						.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
						// 其他控制字符
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
						.replace(/\r\n/g, '\n')
						.replace(/\r/g, '\n');
					outputChunks.push(clean);
					markIdle();
				});

				// 监听退出（非交互式 shell 可能触发）
				exitListener = instance.onExit((e) => {
					clearTimeout(idleTimer);
					const code = typeof e === 'number' ? e : (e as any).exitCode;
					resolve(`Exit code: ${code}\n`);
				});

				// 初始 idle 计时器（处理无输出命令）
				idleTimer = setTimeout(() => resolve(''), IDLE_TIMEOUT_MS);
			});

			// v27: hard cap timeout at 60s regardless of user input.
			const hardCapMs = 60_000;
			const timeoutMs = Math.min(timeoutSec * 1000, hardCapMs);

			// v27: log the actual command at the start of execution.
			ctx.logService.info(
				`[BuiltinTools] terminal: command="${redactSecrets(command).slice(0, 200)}" cwd=${effectiveCwd ?? '(none)'} ` +
				`timeout=${timeoutSec}s hardCap=${hardCapMs}ms`,
			);

			// v27: defensive `await instance.sendText(command, true)`.
			const sendTextTimeoutMs = hardCapMs + 5_000;
			const sendTextTimeout = new Promise<void>((resolve) => {
				setTimeout(() => resolve(), sendTextTimeoutMs);
			});
			await Promise.race([instance.sendText(command, true), sendTextTimeout]);

			// 等待输出或超时
			let result = '';

			const abortPromise = signal
				? new Promise<string>((resolve) => {
					const onAbort = () => resolve('[CANCELLED] Command execution was cancelled by user.\n');
					signal.addEventListener('abort', onAbort, { once: true });
				})
				: new Promise<string>(() => { /* never resolves */ });

			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve(`[TIMEOUT] Command timed out after ${timeoutMs / 1000}s\n`), timeoutMs);
			});

			result = await Promise.race([outputPromise, timeoutPromise, abortPromise]);

			// 等待一小段时间让剩余数据到达
			await new Promise<void>(resolve => setTimeout(resolve, 300));

			// 清理监听器
			dataListener?.dispose();
			exitListener?.dispose();

			// 合并输出
			let fullOutput = outputChunks.join('') + result;

			// 后处理：去除 PowerShell 欢迎信息、提示符重复等多余内容
			fullOutput = fullOutput
				// PowerShell 版本提示行
				.replace(/PowerShell\s+\d+\.\d+\.\d+.*\n?/gi, '')
				// 升级通知
				.replace(/A new PowerShell stable release is available:.*\n?/gi, '')
				.replace(/Upgrade now, or check out the release page at:.*\n?/gi, '')
				.replace(/https:\/\/aka\.ms\/PowerShell-Release\?tag=.*\n?/gi, '')
				// 多余的空行压缩
				.replace(/\n{3,}/g, '\n\n')
				.trim();

			// 尝试销毁终端实例
			try {
				if (instance) {
					instance.dispose();
				}
			} catch { /* ignore */ }

			// 密钥脱敏 — 防止命令回显的密钥泄露到 LLM 上下文（对齐 Hermes/Claude Code）
			const sanitizedOutput = redactSecrets(fullOutput);

			// 截断过长输出 — head-tail 策略（对齐 Hermes）
			const maxLen = 65536;
			const truncated = sanitizedOutput.length > maxLen;
			const finalOutput = truncated
				? sanitizedOutput.slice(0, maxLen / 2)
					+ `\n... (${sanitizedOutput.length - maxLen} chars omitted from the middle) ...\n`
					+ sanitizedOutput.slice(sanitizedOutput.length - maxLen / 2)
				: sanitizedOutput;

			return [{ type: 'text', text: finalOutput || '(no output)' }];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return [{ type: 'text', text: `Error executing command: ${msg}` }];
		}
	}

	/** 参数别名归一化：filePath/file_path/file/uri → path。 */
	function resolvePathArg(args: Record<string, unknown>): string {
		return String(args['path'] || args['filePath'] || args['file_path'] || args['file'] || args['uri'] || '');
	}

	/** 二进制文件扩展名守护。 */
	function isBinaryPath(p: string): boolean {
		return /\.(?:exe|dll|so|dylib|node|pak|asar|wasm|bin|obj|lib|a|o|class|jar|pyc|pyo|whl|zip|tar|gz|tgz|bz2|7z|rar|xz|zst|png|jpe?g|gif|bmp|ico|webp|tif|tiff|svg|psd|mp3|wav|ogg|flac|mp4|mov|avi|mkv|webm|pdf|docx?|xlsx?|pptx?|sqlite|db|map|woff2?|ttf|eot|otf)$/i.test(p);
	}

	/** 按行读取 [offset, offset+limit) 行，对齐 Hermes sed -n 语义。 */
	async function readFileLines(resolvedPath: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ page: string[]; hasMore: boolean; totalLines: number; fileSize: number; mtime: number }> {
		const normalizedUri = URI.file(resolvedPath);
		const content = await ctx.fileService.readFile(normalizedUri);
		const textContent = typeof content.value === 'string' ? content.value : content.value.toString();
		const rawLines = textContent.split(/\r?\n/);
		const fileSize = (content as any).size ?? textContent.length;
		const mtime = (content as any).mtime ?? 0;
		_fileReadMtimeMap.set(resolvedPath, mtime);

		const startIndex = offset - 1;
		const endIndex = startIndex + limit;

		// BOM 处理（仅 offset==1 时去除）
		if (startIndex === 0 && rawLines.length > 0 && rawLines[0].startsWith('\uFEFF')) {
			rawLines[0] = rawLines[0].slice(1);
		}

		const page: string[] = [];
		for (let i = startIndex; i < Math.min(endIndex, rawLines.length); i++) {
			const line = rawLines[i];
			page.push(line.length > READ_LINE_MAX_CHARS ? line.slice(0, READ_LINE_MAX_CHARS) : line);
		}

		const hasMore = rawLines.length > endIndex;
		const totalLines = rawLines.length;

		// signal abort 支持
		if (signal?.aborted) {
			throw new Error('aborted');
		}

		return { page, hasMore, totalLines, fileSize, mtime };
	}

	/** mtime-based 去重 stub（对齐 Hermes _dedup_read_file）。 */
	function checkReadDedup(agentKey: string, readKey: string, mtime: number): { unchanged: boolean; blocked: boolean; stubCount: number } {
		const fullKey = `${agentKey}:${readKey}`;
		const prev = _readDedupMap.get(fullKey);

		if (!prev) {
			_readDedupMap.set(fullKey, { mtime, stubCount: 0 });
			if (_readDedupMap.size > READ_DEDUP_CAP) { _readDedupMap.delete(_readDedupMap.keys().next().value!); }
			return { unchanged: false, blocked: false, stubCount: 0 };
		}

		if (prev.mtime === mtime) {
			prev.stubCount++;
			if (prev.stubCount >= READ_DEDUP_BLOCK) {
				return { unchanged: true, blocked: true, stubCount: prev.stubCount };
			}
			return { unchanged: true, blocked: false, stubCount: prev.stubCount };
		}

		// mtime 变化 → 重置
		_readDedupMap.set(fullKey, { mtime, stubCount: 0 });
		if (_readDedupMap.size > READ_DEDUP_CAP) { _readDedupMap.delete(_readDedupMap.keys().next().value!); }
		return { unchanged: false, blocked: false, stubCount: 0 };
	}

	/** 连续重复读取检测（对齐 Hermes _REPEATED_READ_WARNING_COUNT / _REPEATED_READ_BLOCK_COUNT）。 */
	function checkReadRepeat(agentKey: string, readKey: string): { count: number; warning: boolean; blocked: boolean } {
		const fullKey = `${agentKey}:${readKey}`;
		const prev = _readRepeatMap.get(fullKey);

		if (!prev || prev.key !== readKey) {
			_readRepeatMap.set(fullKey, { key: readKey, count: 1 });
			if (_readRepeatMap.size > READ_REPEAT_CAP) { _readRepeatMap.delete(_readRepeatMap.keys().next().value!); }
			return { count: 1, warning: false, blocked: false };
		}

		prev.count++;
		if (prev.count >= READ_REPEAT_BLOCK) {
			return { count: prev.count, warning: true, blocked: true };
		}
		if (prev.count >= READ_REPEAT_WARN) {
			return { count: prev.count, warning: true, blocked: false };
		}
		return { count: prev.count, warning: false, blocked: false };
	}

	/** 文件不存在时建议相似文件名（对齐 Hermes _suggest_similar_files）。 */
	async function suggestSimilarFiles(resolvedPath: string): Promise<string[]> {
		const uri = URI.file(resolvedPath);
		const dirUri = URI.joinPath(uri, '..');
		const fileName = uri.path.split('/').pop() ?? '';

		try {
			const stat = await ctx.fileService.resolve(dirUri);
			if (!stat.children || stat.children.length === 0) { return []; }

			const candidates = stat.children
				.filter(c => !c.isDirectory)
				.map(c => c.name);
			if (candidates.length === 0) { return []; }

			const lowerName = fileName.toLowerCase();
			const scored = candidates.map(name => ({
				name,
				dist: _levenshtein(lowerName, name.toLowerCase()),
			}));

			const threshold = Math.max(fileName.length / 2, 3);
			return scored
				.filter(s => s.dist <= threshold)
				.sort((a, b) => a.dist - b.dist)
				.slice(0, 5)
				.map(s => s.name);
		} catch {
			return [];
		}
	}

	ctx.logService.info('[BuiltinTools] _registerCoreTools: starting to register core tools');

	// ── clarify: 向用户提问（支持单问题 / 多问题表单） ──────────
	ctx.register({
		definition: {
			name: 'clarify',
			description: [
				'Ask the user clarifying questions. Supports single-question mode (question + options)',
				'or multi-question form mode (questions array). Use multi-question mode when you have',
				'several independent points to clarify at once, saving round-trips.',
				'Each question can have optional multiple-choice options (1-4 items).',
				'The user\'s answers will arrive as a new message.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'Single question (use this OR questions[], not both)' },
					options: {
						type: 'array',
						items: { type: 'string' },
						description: 'Multiple-choice options for single-question mode (1-4 items).',
						maxItems: 4,
					},
					questions: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								question: { type: 'string', description: 'The question text' },
								options: {
									type: 'array',
									items: { type: 'string' },
									description: 'Multiple-choice options for this question (optional, 1-4 items).',
									maxItems: 4,
								},
								id: { type: 'string', description: 'Short identifier for this question (optional, auto-generated if omitted).' },
							},
							required: ['question'],
						},
						description: 'Batch of questions (2-8 items). Each question may have its own options.',
						maxItems: 8,
					},
				},
				required: [],
			},
			category: 'clarify',
			source: ctx.id,
		},
		handler: async args => {
			// ── 多问题模式 ──────────────────────────────
			const questionsArr = Array.isArray(args['questions']) ? (args['questions'] as unknown[]) : undefined;
			if (questionsArr && questionsArr.length > 0) {
				const items = questionsArr
					.filter((q: any) => q && typeof q.question === 'string' && q.question.trim())
					.map((q: any, i: number) => ({
						id: q.id || `q${i}`,
						question: String(q.question).trim(),
						options: Array.isArray(q.options) ? (q.options as unknown[]).map(String) : undefined,
					}));
				if (items.length === 0) {
					return text('Error: at least one valid question is required');
				}
				return [{
					type: 'text' as const,
					text: JSON.stringify({ __clarify__: true, questions: items }),
				}];
			}

			// ── 单问题模式（向后兼容） ─────────────────
			const question = String(args['question'] ?? '').trim();
			if (!question) {
				return text('Error: question or questions[] parameter is required');
			}
			const options = Array.isArray(args['options']) ? (args['options'] as unknown[]).map(String) : undefined;
			return [{
				type: 'text' as const,
				text: JSON.stringify({ __clarify__: true, question, options }),
			}];
		},
	});

	// ── filesystem ─────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'file_read',
			description: 'Read a UTF-8 text file with line numbers and pagination. Output format: LINE_NUM|CONTENT (e.g. 34|foo). Use offset/limit for large files. Binary files are rejected by extension.',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Absolute path or workspace-relative path' },
					offset: { type: 'integer', description: 'Line number to start reading from (1-indexed, default: 1)', default: 1, minimum: 1 },
					limit: { type: 'integer', description: 'Maximum number of lines to read (default: 500, max: 2000)', default: 500, maximum: 2000 },
				},
				required: ['path'],
			},
			category: 'filesystem',
			source: ctx.id,
		},
		handler: async (args, signal, agentId) => {
			const requestedPath = resolvePathArg(args);
			if (!requestedPath) {
				throw new Error('path is required');
			}

			const offset = Math.max(1, Number(args['offset'] ?? 1));
			const limit = Math.min(Math.max(Number(args['limit'] ?? 500), 1), READ_MAX_LIMIT);

			// 读操作：仅解析相对路径为绝对路径，不触发沙箱判定
			const resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, requestedPath, false);

			// 二进制守护
			if (isBinaryPath(resolvedPath)) {
				throw new Error(`Cannot read binary file '${requestedPath}'. Use a different tool for binary files.\nFor supported structured documents, consider converting to text first (e.g., .docx → pandoc, .xlsx → csv, .ipynb → python script).`);
			}

			// P2: 设备路径守卫（对齐 Hermes _is_blocked_device + get_read_block_error）
			const normalizedReadPath = resolvedPath.replace(/\\/g, '/').toLowerCase();
			for (const prefix of READ_BLOCKED_PREFIXES) {
				if (normalizedReadPath.startsWith(prefix)) {
					throw new Error(`Cannot read from ${prefix}... Device and system paths are blocked for security.`);
				}
			}
			const readFileName = normalizedReadPath.split('/').pop() ?? '';
			for (const exact of READ_BLOCKED_EXACT) {
				if (readFileName === exact) {
					throw new Error(`Reading "${exact}" files is not allowed. This file contains sensitive credentials.`);
				}
			}

			// 连续重复读取检测
			const agentKey = agentId ?? '';
			const readKey = `${resolvedPath}:${offset}:${limit}`;
			const repeatResult = checkReadRepeat(agentKey, readKey);
			if (repeatResult.blocked) {
				throw new Error(`BLOCKED: You have read this exact file region ${repeatResult.count} times consecutively. Review the content already returned. If the file has been modified, use a different offset or a different tool.`);
			}

			// 读取文件（带 FileNotFound → 相似文件建议）
			let page: string[];
			let hasMore: boolean;
			let totalLines: number;
			let fileSize: number;
			let mtime: number;

			try {
				const result = await readFileLines(resolvedPath, offset, limit, signal);
				page = result.page;
				hasMore = result.hasMore;
				totalLines = result.totalLines;
				fileSize = result.fileSize;
				mtime = result.mtime;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('FILE_NOT_FOUND') || msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not exist')) {
					const suggestions = await suggestSimilarFiles(resolvedPath);
					if (suggestions.length > 0) {
						throw new Error(`File not found: ${requestedPath}\nDid you mean one of these?\n${suggestions.map(s => `  - ${s}`).join('\n')}`);
					}
				}
				throw err;
			}

			// 去重 stub
			const dedupResult = checkReadDedup(agentKey, readKey, mtime);
			if (dedupResult.blocked) {
				throw new Error(`BLOCKED: This file region has not changed since your last ${dedupResult.stubCount} reads. The content is unchanged — review what you already have.`);
			}
			if (dedupResult.unchanged) {
				const status = dedupResult.stubCount >= 1
					? `unchanged (previously read ${dedupResult.stubCount} time(s), content identical)`
					: 'unchanged';
				return text(`(file ${status})`);
			}

			// 空结果
			if (page.length === 0) {
				return text(`(empty or beyond end of file: offset=${offset})`);
			}

			// 行号格式：紧凑 `LINE_NUM|CONTENT`
			const out = page.map((line, i) => `${offset + i}|${line}`).join('\n');
			const lastLine = offset + page.length - 1;

			// P0: 总字符上限检查（对齐 Hermes 100K）
			if (out.length > READ_MAX_CHARS) {
				const truncated = out.slice(0, READ_MAX_CHARS);
				const truncatedTail = `\n\n[截断: 输出 ${out.length} 字符，超过安全上限 ${READ_MAX_CHARS}。已截取前 ${READ_MAX_CHARS} 字符。建议用更小的 limit 或 offset 分段读取。]`;
				return text(redactSecrets(truncated + truncatedTail));
			}

			const tailParts: string[] = [];

			// 分页提示
			if (hasMore) {
				tailParts.push(`[Hint: 已显示第 ${offset}-${lastLine}/${totalLines} 行。使用 offset=${lastLine + 1} 读取后续内容。]`);
			} else {
				tailParts.push(`[已显示第 ${offset}-${lastLine} 行，文件结束 (${totalLines} 行总计)]`);
			}

		// 大文件提示
		if (fileSize > LARGE_FILE_HINT_BYTES && limit > LARGE_FILE_HINT_MIN_LIMIT) {
			tailParts.push(`[Hint: 这是一个大文件 (${(fileSize / 1024).toFixed(0)}KB)。考虑用更小的 limit 值分段读以加快速度。]`);
		}

		// 2026-07-26（P2，Continue FileTooLarge 思路）：动态上下文保护——
		// 一次性吞下整个文件时，按估算 token 与上下文窗口占比警告。
		// Continue 超上下文 50% 直接抛错；我们选择「警告不阻止」：
		// 让模型量化感知（约占上下文 P%），引导探索场景改用局部读取。
		if (offset === 1 && !hasMore && totalLines >= 500) {
			const estimatedTokens = Math.ceil(out.length / 4);
			if (estimatedTokens >= 8_000) {
				const pct = (estimatedTokens / CONTEXT_WINDOW_TOKENS * 100).toFixed(1);
				tailParts.push(`[Warning: 一次读取了整个文件（${totalLines} 行 ≈ ${estimatedTokens} tokens，约占上下文窗口的 ${pct}%）。探索代码时优先用 offset/limit 读取相关片段，或用 search_code/get_code_snippet 精准定位符号，避免大量无关内容占用上下文。]`);
			}
		}

		// 重复读取警告
		if (repeatResult.warning) {
			tailParts.push(`[Warning: 你已连续 ${repeatResult.count} 次读取完全相同的文件区域。]`);
		}

			const tail = tailParts.length > 0 ? '\n\n' + tailParts.join('\n') : '';

			// 密钥脱敏
			const sanitized = redactSecrets(out + tail);
			return text(sanitized);
		},
	});

	ctx.register({
		definition: {
			name: 'file_write',
			description: 'Write a UTF-8 text file (overwrites). Creates parent directories as needed. For large files (>8KB), prefer writing in multiple smaller steps rather than one big call: a single very large write may hit the model output limit and get truncated, leaving the file incomplete or corrupted. Write an initial portion with this tool, then append the remaining sections with follow-up `patch` calls (use the tail of the already-written content as the search anchor).',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
			},
			category: 'filesystem',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args, _signal, agentId) => {
			const requestedPath = resolvePathArg(args);
			if (!requestedPath) {
				throw new Error('path is required');
			}

			// 路径遍历保护
			const resolvedPath = await ctx.resolveAndCheckWorkspacePath(agentId, requestedPath);
			const normalizedUri = URI.file(resolvedPath);
			let content = String(args['content'] ?? '');

			// ── P1: 敏感路径拒绝（对齐 Hermes file_safety.py）──────────
			const normalizedLower = resolvedPath.toLowerCase().replace(/\\/g, '/');
			const fileName = normalizedLower.split('/').pop() ?? '';
			for (const denied of WRITE_DENIED_EXACT) {
				if (fileName === denied) {
					ctx.logService.warn(`[coreTools] file_write BLOCKED: ${requestedPath} matches denied exact "${denied}"`);
					throw new Error(`Cannot write to "${denied}" files. This path is protected for security reasons.`);
				}
			}
			for (const prefix of WRITE_DENIED_PREFIXES) {
				if (normalizedLower.includes('/' + prefix)) {
					ctx.logService.warn(`[coreTools] file_write BLOCKED: ${requestedPath} matches denied prefix "${prefix}"`);
					throw new Error(`Cannot write to files under "${prefix}". This path is protected for security reasons.`);
				}
			}

			// ── P1: 行尾保持（对齐 Hermes）──────────────────────────
			let existingLineEnding: string | undefined;
			let existingMtime: number | undefined;
			try {
				const existing = await ctx.fileService.readFile(normalizedUri);
				const existingText = typeof existing.value === 'string' ? existing.value : existing.value.toString();
				existingMtime = (existing as any).mtime as number | undefined;
				if (existingText.includes('\r\n')) {
					existingLineEnding = '\r\n';
				}
			} catch {
				// 文件不存在 → OK（首次创建）
			}
			if (existingLineEnding) {
				content = content.replace(/\r?\n/g, existingLineEnding);
			}

			// ── P1: 文件过期检查（对齐 Hermes _check_file_staleness）───
			const lastReadMtime = _fileReadMtimeMap.get(resolvedPath);
			if (lastReadMtime !== undefined && existingMtime !== undefined && existingMtime > lastReadMtime) {
				ctx.logService.warn(`[coreTools] file_write: ${resolvedPath} was modified externally since last read (mtime ${lastReadMtime} → ${existingMtime}). Proceeding with caution.`);
			}

			// Checkpoint (Void-inspired): snapshot before overwriting.
			if (agentId) {
				await ctx.checkpointService.captureBeforeToolEdit(agentId, normalizedUri.toString(), content);
			}

			// ── P0: 原子写（对齐 Hermes temp→mv）──────────────────────
			const tmpPath = resolvedPath + '.tmp.' + Date.now();
			const tmpUri = URI.file(tmpPath);
			await ctx.fileService.writeFile(tmpUri, VSBuffer.fromString(content));
			try {
				await ctx.fileService.move(tmpUri, normalizedUri, true);
			} catch (renameErr) {
				// move 失败时尝试删除临时文件并重抛
				try { await ctx.fileService.del(tmpUri); } catch { /* best effort */ }
				throw renameErr;
			}
			return text(`wrote ${content.length} chars to ${normalizedUri.fsPath}`);
		},
	});

	// ── terminal ────────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: 'terminal',
			description: 'Execute a shell command and return the output. Works on desktop only. Returns stdout, stderr, and exit code.',
			inputSchema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to execute' },
					cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
					timeout: { type: 'number', description: 'Command timeout in seconds (default: 30)' },
				},
				required: ['command'],
			},
			category: 'terminal',
			source: ctx.id,
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		available: () => typeof process !== 'undefined' || typeof navigator !== 'undefined',
		handler: async (args, signal, agentId) => {
			const command = String(args['command'] ?? '').trim();
			if (!command) { throw new Error('command is required'); }
			const requestedCwd = args['cwd'] ? String(args['cwd']) : '.';
			const resolvedCwd = await ctx.resolveAndCheckWorkspacePath(agentId, requestedCwd);
			const timeoutSec = Math.min(Math.max(Number(args['timeout'] ?? 30), 1), 300);

			const result = await executeTerminalCommand(command, resolvedCwd, timeoutSec, signal);
			// ── 搜索类命令护栏（不阻断执行，仅提示）──────────────────────
			// find/grep -r/Get-ChildItem -Recurse 等纯搜索命令是 search_files/
			// search_code 的本职工作（索引快路径 + 结构化结果 + 无 shell 可移植性
			// 问题）。命中模式时在输出末尾追加 tool-hint 引导下次改用专用工具。
			// 模式表数据驱动，见 terminalCommandGuards.ts。
			const searchGuardHit = detectTerminalSearchCommand(command);
			if (searchGuardHit) {
				ctx.logService.info(`[coreTools] terminal search-like command detected (${searchGuardHit.id}) — appending tool hint`);
				result.push({ type: 'text', text: terminalSearchCommandHint(searchGuardHit) });
			}
			return result;
		},
	});

	return {
		resetPerTurn() {
			_readRepeatMap.clear();
			_readDedupMap.clear();
		},
	};
}
