/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface CompatToolContext {
	register: (d: IBuiltinToolRegistration) => void;
	agentOS: IAgentOSService;
	fileService: IFileService;
	logService: ILogService;
	id: string;
	resolveAndCheckWorkspacePath: (agentId: string | undefined, p: string, requireInWorkspace?: boolean) => Promise<string>;
}

/**
 * _registerCompatibilityTools — 从 builtinToolProvider 抽取（source 硬编码 'saros.builtin-tools'）。
 */
export function registerCompatibilityTools(ctx: CompatToolContext): void {
		const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

		// skills_list 和 skill_view 已在 _registerSkillTools 中注册（含 Hermes 兼容格式）

		// ── 别名: memory → memory_remember (Hermes 旧名) ───────────
		const memStore = new Map<string, string>();
		ctx.register({
			definition: {
				name: 'memory',
				description: 'Save or recall persistent memory. Action "save" stores content; "recall" retrieves by key.',
				inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['save', 'recall', 'search', 'clear'], description: 'Action to perform' }, key: { type: 'string' }, content: { type: 'string' }, query: { type: 'string' } }, required: ['action'] },
				category: 'memory', source: ctx.id,
			},
			handler: async (args, _signal, agentId) => {
				const action = String(args['action'] ?? 'save');
				if (action === 'save') {
					const content = String(args['content'] ?? '');
					const key = String(args['key'] ?? 'default');
					if (!content) { return text('Error: content is required for save action'); }
					const provider = ctx.agentOS?.getActiveMemoryProvider?.();
					if (provider) {
						try {
							await provider.writeMemory(agentId ?? '', { id: `mem_${key}`, type: 'episodic', content, timestamp: Date.now() });
							return text(`Memory saved under key "${key}" (${content.length} chars).`);
						} catch { /* fallback */ }
					}
					memStore.set(key, content);
					return text(`Memory saved under key "${key}" (local only, ${content.length} chars).`);
				}
				if (action === 'search' || action === 'recall') {
					const query = String(args['query'] ?? args['key'] ?? '');
					if (!query) { return text('Error: query is required for search/recall action'); }
					const provider = ctx.agentOS?.getActiveMemoryProvider?.();
					if (provider) {
						try {
							const results = await provider.searchMemory(agentId ?? '', query);
							if (results.length) { return text(results.map(r => `- [${r.type}] ${r.content}`).join('\n')); }
						} catch { /* fallback */ }
					}
					// local fallback
					const found = memStore.get(query);
					return found ? text(`Found: ${found}`) : text('No memories found.');
				}
				return text(`Unknown action: ${action}`);
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

		// ── process / session_search / execute_code ─────────────────
		// 平台不适用 — 返回友好提示（web_search/web_extract 已有真实 handler，不在此注册 stub）
		for (const [name, desc, msg] of [
			['process', 'Manage background processes.', 'Process management is not natively available. Use the terminal tool to launch commands. For long-running processes, use the timeout parameter to control execution duration.'],
			['session_search', 'Search past conversation sessions.', 'Session search is not yet available. Past conversations are stored in ~/.saros/sessions/.'],
			['execute_code', 'Execute a Python script in a sandbox.', 'Code execution sandbox is not available. Use the terminal tool to run scripts.'],
		] as const) {
			ctx.register({
				definition: { name, description: desc, inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } }, category: 'utility', source: ctx.id },
				handler: async () => text(msg),
			});
		}

		ctx.logService.info('[BuiltinTools] _registerCompatibilityTools: registered aliases + missing core tools');
}
