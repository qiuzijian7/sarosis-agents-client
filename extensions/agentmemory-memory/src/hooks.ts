/*---------------------------------------------------------------------------------------------
 *  Hook 系统 — 进程内生命周期钩子，自动化记忆捕获。
 *  参考 agentmemory src/hooks/（15 个外部 shell 钩子）
 *
 *  agentmemory 通过 Claude Code 的 hook 机制（stdin/stdout JSON）在关键节点
 *  自动捕获记忆。我们的进程内方案改为注册回调函数。
 *
 *  钩子类型：
 *    1. session_start    — 会话开始：注册会话 + 注入项目上下文
 *    2. session_end      — 会话结束：生成会话摘要 + 触发固化
 *    3. prompt_submit    — 用户提交提示：记录用户意图 + 更新 pendingUser
 *    4. pre_tool_use     — 工具调用前：文件富化（注入文件记忆）
 *    5. post_tool_use    — 工具调用后：捕获工具结果 + 文件访问记录
 *    6. post_tool_failure — 工具失败后：记录错误教训
 *    7. stop             — 对话停止：工作记忆持久化（session_end 链压缩/反思由 triggerHook 另行触发）
 *    8. task_completed   — 任务完成：结晶化 + 技能提取
 *
 *  与现有方法的集成：
 *    - loadContext() 内部触发 session_start
 *    - writeMemory() 内部触发 post_tool_use / post_tool_failure
 *    - dispose() 触发 session_end
 *--------------------------------------------------------------------------------------------*/

export type HookType =
	| 'session_start'
	| 'session_end'
	| 'prompt_submit'
	| 'pre_tool_use'
	| 'post_tool_use'
	| 'post_tool_failure'
	| 'pre_compact'
	| 'stop'
	| 'task_completed'
	| 'notification';

export interface HookContext {
	agentId: string;
	sessionId: string;
	timestamp: number;
	cwd?: string;
	project?: string;
	[key: string]: unknown;
}

export interface HookResult {
	action: 'inject' | 'observe' | 'skip' | 'persist';
	injectContext?: string;       // 注入到模型上下文的文本
	observeEntry?: {               // 写入记忆的条目
		content: string;
		type: 'working' | 'episodic' | 'semantic' | 'procedural';
		metadata?: Record<string, unknown>;
	};
	persist?: boolean;             // 是否触发持久化
}

export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult> | null;

export interface HookRegistration {
	id: string;
	type: HookType;
	handler: HookHandler;
	priority: number;  // 高优先级先执行
	enabled: boolean;
}

const HOOK_ORDER: HookType[] = [
	'session_start',
	'prompt_submit',
	'pre_tool_use',
	'post_tool_use',
	'post_tool_failure',
	'pre_compact',
	'task_completed',
	'notification',
	'stop',
	'session_end',
];

export class HookSystem {
	private _hooks = new Map<HookType, HookRegistration[]>();
	private _hookCallCount = new Map<HookType, number>();
	private _maxHooksPerType = 10;

	/**
	 * 注册钩子
	 */
	register(type: HookType, handler: HookHandler, priority: number = 50): string {
		let list = this._hooks.get(type);
		if (!list) {
			list = [];
			this._hooks.set(type, list);
		}
		if (list.length >= this._maxHooksPerType) {
			// 移除优先级最低的
			list.sort((a, b) => b.priority - a.priority);
			list.pop();
		}
		const id = `hook-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		list.push({ id, type, handler, priority, enabled: true });
		list.sort((a, b) => b.priority - a.priority);
		return id;
	}

	/**
	 * 注销钩子
	 */
	unregister(id: string): boolean {
		for (const [type, list] of this._hooks) {
			const idx = list.findIndex(h => h.id === id);
			if (idx >= 0) {
				list.splice(idx, 1);
				return true;
			}
		}
		return false;
	}

	/**
	 * 触发钩子（按优先级顺序执行所有处理器）
	 * 收集所有结果，合并 injectContext
	 */
	async trigger(type: HookType, ctx: HookContext): Promise<HookResult[]> {
		const list = this._hooks.get(type);
		if (!list || list.length === 0) return [];

		this._hookCallCount.set(type, (this._hookCallCount.get(type) ?? 0) + 1);

		const results: HookResult[] = [];
		for (const reg of list) {
			if (!reg.enabled) continue;
			try {
				const result = await reg.handler(ctx);
				if (result) {
					results.push(result);
				}
			} catch (err) {
				// 钩子失败不应阻断主流程
				console.warn(`[AgentMemory] hook ${reg.id} failed:`, err);
			}
		}
		return results;
	}

	/**
	 * 触发钩子并合并注入上下文
	 */
	async triggerAndCollect(type: HookType, ctx: HookContext): Promise<{
		injectContext: string;
		observeEntries: Array<{ content: string; type: 'working' | 'episodic' | 'semantic' | 'procedural'; metadata?: Record<string, unknown> }>;
		shouldPersist: boolean;
	}> {
		const results = await this.trigger(type, ctx);
		const injectParts: string[] = [];
		const observeEntries: Array<{ content: string; type: 'working' | 'episodic' | 'semantic' | 'procedural'; metadata?: Record<string, unknown> }> = [];
		let shouldPersist = false;

		for (const r of results) {
			if (r.injectContext) {
				injectParts.push(r.injectContext);
			}
			if (r.observeEntry) {
				observeEntries.push(r.observeEntry);
			}
			if (r.persist) {
				shouldPersist = true;
			}
		}

		return {
			injectContext: injectParts.join('\n\n'),
			observeEntries,
			shouldPersist,
		};
	}

	/**
	 * 启用/禁用钩子
	 */
	setEnabled(id: string, enabled: boolean): boolean {
		for (const list of this._hooks.values()) {
			const hook = list.find(h => h.id === id);
			if (hook) {
				hook.enabled = enabled;
				return true;
			}
		}
		return false;
	}

	/**
	 * 获取钩子统计
	 */
	getStats(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } {
		const hooksByType: Record<string, number> = {};
		const callCounts: Record<string, number> = {};
		let totalHooks = 0;
		for (const [type, list] of this._hooks) {
			hooksByType[type] = list.length;
			totalHooks += list.length;
			callCounts[type] = this._hookCallCount.get(type) ?? 0;
		}
		return { totalHooks, hooksByType, callCounts };
	}

	/**
	 * 列出已注册的钩子
	 */
	list(type?: HookType): HookRegistration[] {
		if (type) {
			return [...(this._hooks.get(type) ?? [])];
		}
		const all: HookRegistration[] = [];
		for (const t of HOOK_ORDER) {
			all.push(...(this._hooks.get(t) ?? []));
		}
		return all;
	}

	/**
	 * 清除所有钩子
	 */
	clear(): void {
		this._hooks.clear();
		this._hookCallCount.clear();
	}
}

// ─── 默认钩子处理器 ─────────────────────────────────────────────────────────

/**
 * 创建默认的 session_start 钩子
 */
export function createSessionStartHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'session_start',
		priority: 100,
		handler: (ctx: HookContext): HookResult => {
			return {
				action: 'observe',
				observeEntry: {
					content: `Session started: ${ctx.sessionId}`,
					type: 'working',
					metadata: { event: 'session_start', project: ctx.project },
				},
			};
		},
	};
}

/**
 * 创建默认的 post_tool_use 钩子
 */
export function createPostToolUseHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'post_tool_use',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			const toolName = ctx['toolName'] as string ?? '';
			const toolResult = ctx['toolResult'] as string ?? '';
			const truncated = toolResult.slice(0, 2000);
			return {
				action: 'observe',
				observeEntry: {
					content: `[Tool: ${toolName}] ${truncated}`,
					type: 'working',
					metadata: {
						toolName,
						success: true,
						resultLength: toolResult.length,
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 post_tool_failure 钩子
 */
export function createPostToolFailureHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'post_tool_failure',
		priority: 80,
		handler: (ctx: HookContext): HookResult => {
			const toolName = ctx['toolName'] as string ?? '';
			// Robust error serialization — handles string, Error, and plain object
			const errorRaw = ctx['error'];
			const error: string = typeof errorRaw === 'string'
				? errorRaw
				: errorRaw instanceof Error
					? errorRaw.message
					: (() => { try { return JSON.stringify(errorRaw ?? ''); } catch { return String(errorRaw ?? ''); } })();
			return {
				action: 'observe',
				observeEntry: {
					content: `[Tool Failed: ${toolName}] ${error.slice(0, 500)}`,
					type: 'episodic',
					metadata: {
						toolName,
						success: false,
						error: error.slice(0, 200),
						event: 'tool_failure',
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 task_completed 钩子
 */
export function createTaskCompletedHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'task_completed',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			const taskSubject = ctx['taskSubject'] as string ?? '';
			return {
				action: 'observe',
				observeEntry: {
					content: `Task completed: ${taskSubject}`,
					type: 'episodic',
					metadata: {
						event: 'task_completed',
						taskId: ctx['taskId'],
						taskSubject,
					},
				},
				persist: true,
			};
		},
	};
}

/**
 * 创建默认的 prompt_submit 钩子
 * 用户提交 prompt 时：记录用户意图 + 更新 pendingUser
 */
export function createUserPromptSubmitHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'prompt_submit',
		priority: 90,
		handler: (ctx: HookContext): HookResult => {
			const prompt = ctx['prompt'] as string ?? ctx['userPrompt'] as string ?? '';
			if (!prompt.trim()) return { action: 'skip' };
			const truncated = prompt.slice(0, 2000);
			return {
				action: 'observe',
				observeEntry: {
					content: `[User Prompt] ${truncated}`,
					type: 'working',
					metadata: {
						event: 'prompt_submit',
						promptLength: prompt.length,
						project: ctx.project,
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 pre_tool_use 钩子
 * 工具调用前：注入文件相关记忆上下文（enrichment）
 * 默认关闭注入（避免 token 消耗），仅记录文件访问模式
 */
export function createPreToolUseHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'pre_tool_use',
		priority: 70,
		handler: (ctx: HookContext): HookResult => {
			const toolName = (ctx['toolName'] as string ?? '').toLowerCase();
			const toolInput = ctx['toolInput'] as Record<string, unknown> ?? {};
			const files: string[] = [];

			// 从工具参数中提取文件路径
			const fileKeys = toolName === 'grep'
				? ['path', 'file']
				: ['file_path', 'path', 'file', 'pattern'];
			for (const key of fileKeys) {
				const val = toolInput[key];
				if (typeof val === 'string' && val.length > 0) files.push(val);
			}

			if (files.length === 0) return { action: 'skip' };

			return {
				action: 'observe',
				observeEntry: {
					content: `[Pre-Tool: ${toolName}] files: ${files.join(', ')}`,
					type: 'working',
					metadata: {
						event: 'pre_tool_use',
						toolName,
						files,
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 notification 钩子
 * 通知事件（如权限请求）捕获
 */
export function createNotificationHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'notification',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			const notificationType = ctx['notificationType'] as string ?? ctx['notification_type'] as string ?? '';
			const title = ctx['title'] as string ?? '';
			const message = ctx['message'] as string ?? '';

			return {
				action: 'observe',
				observeEntry: {
					content: `[Notification: ${notificationType}] ${title}: ${message}`.slice(0, 1000),
					type: 'working',
					metadata: {
						event: 'notification',
						notificationType,
						title,
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 pre_compact 钩子
 * 压缩上下文前：捕捉当前工作记忆快照
 */
export function createPreCompactHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'pre_compact',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			const summary = ctx['workingSummary'] as string ?? ctx['summary'] as string ?? '';
			return {
				action: 'observe',
				observeEntry: {
					content: `[Pre-Compact] ${summary || 'context compaction triggered'}`.slice(0, 1000),
					type: 'working',
					metadata: {
						event: 'pre_compact',
						project: ctx.project,
					},
				},
			};
		},
	};
}

/**
 * 创建默认的 stop 钩子
 * 对话停止：工作记忆持久化（记录最近 turn）；session_end 链（压缩/反思/图提取）由 triggerHook('session_end') 另行触发。
 */
export function createStopHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'stop',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			return {
				action: 'observe',
				observeEntry: {
					content: `[Stop] conversation turn ended for ${ctx.sessionId}`,
					type: 'working',
					metadata: {
						event: 'stop',
						sessionId: ctx.sessionId,
						project: ctx.project,
					},
				},
				persist: true,
			};
		},
	};
}

/**
 * 创建默认的 session_end 钩子
 * 会话结束：生成会话摘要 + 触发固化
 */
export function createSessionEndHook(): { type: HookType; handler: HookHandler; priority: number } {
	return {
		type: 'session_end',
		priority: 50,
		handler: (ctx: HookContext): HookResult => {
			const summary = ctx['summary'] as string ?? ctx['sessionSummary'] as string ?? '';
			return {
				action: 'observe',
				observeEntry: {
					content: `[Session End] ${summary || 'session terminated'}`.slice(0, 1000),
					type: 'episodic',
					metadata: {
						event: 'session_end',
						sessionId: ctx.sessionId,
						project: ctx.project,
					},
				},
				persist: true,
			};
		},
	};
}
