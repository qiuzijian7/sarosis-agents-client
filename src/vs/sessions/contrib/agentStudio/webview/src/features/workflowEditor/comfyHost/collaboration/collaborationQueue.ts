/**
 * 协同任务队列 —— 事件驱动就绪集 + 级联终态 + 环检测。
 *
 * ## 与画布现有执行模型的关系
 *
 * 现有 `runGraphExecution`（serial）按 Kahn 拓扑序**一次性铺开**执行：
 *   - 上游失败 → **整图立即停止**（`workflowRun.ts` 首失败即停），下游节点既不执行
 *     也不标记，停留在「未执行」——用户看到的是「图跑了一半就断了」；
 *   - 无法在运行期插入新任务（动态委派的产物无处安放）。
 *
 * 本队列（设计来源：open-multi-agent `task/queue.ts` + `orchestrator/scheduler.ts`）把
 * 执行变成**就绪事件驱动**：
 *   - 依赖全部 completed 的任务自动进入就绪集并发 `task:ready`；
 *   - 上游失败/跳过 → **递归级联**把下游标为 failed/skipped 并发事件（不再悬挂）；
 *   - 运行期可 `add()` 新任务（委派产物），依赖满足即自动就绪。
 *
 * ## 为什么「级联终态」重要
 *
 * 多 agent 协同里「下游永久悬挂」是最难排查的故障形态：父节点等一个永远不来的
 * 结果，超时后报「未知错误」。显式级联让每个节点都有明确终态与失败原因
 * （`Cancelled: dependency "X" failed.`），与 open-multi-agent 的 `cascadeFailure`
 * 语义一致。
 */

export type CollabTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface CollabTask {
	id: string;
	title: string;
	/** 依赖的任务 id（DAG 的边）。 */
	dependsOn?: readonly string[];
	status: CollabTaskStatus;
	/** 执行者标识（agentId / 节点 id），供调度策略使用。 */
	assignee?: string;
	/** 成功产物（文本或 JSON 串）。 */
	result?: string;
	/** 失败原因（级联失败会写明是哪个上游导致）。 */
	error?: string;
	/** 任务级重试配置（由调用方消费，队列只透传）。 */
	maxRetries?: number;
	retryDelayMs?: number;
	retryBackoff?: number;
	/** 业务透传字段。 */
	metadata?: Record<string, unknown>;
}

export type CollabQueueEvent = 'task:ready' | 'task:completed' | 'task:failed' | 'task:skipped' | 'task:added';

export interface CollaborationQueue {
	add(task: Omit<CollabTask, 'status'> & { status?: CollabTaskStatus }): CollabTask;
	get(id: string): CollabTask | undefined;
	list(): CollabTask[];
	update(id: string, patch: Partial<Omit<CollabTask, 'id'>>): CollabTask;
	/** 就绪任务：pending 且全部依赖已 completed。 */
	ready(): CollabTask[];
	/**
	 * 广播当前就绪任务（幂等：同一任务只广播一次）。
	 *
	 * ★ 为什么是公开方法：`ready` 事件是**派发信号**，但「初始就绪」发生在
	 *   `createCollaborationQueue(initial)` 返回**之前**——若在构造函数里广播，
	 *   调用方还没注册监听，事件直接丢失（调度器会永远不派发初始任务）。
	 *   因此约定：**注册监听后调用一次 `announceReady()`** 建立基线；
	 *   之后每次 `complete()` 内部会自动调用。`add()` 不再广播 ready。
	 */
	announceReady(): void;
	start(id: string): CollabTask;
	complete(id: string, result?: string): CollabTask;
	fail(id: string, error: string): CollabTask;
	skip(id: string, reason?: string): CollabTask;
	on(event: CollabQueueEvent, cb: (task: CollabTask) => void): () => void;
	/** 全部任务进入终态（completed / failed / skipped）。 */
	isDone(): boolean;
	summary(): Record<CollabTaskStatus, number>;
}

/** 环检测 / 未知依赖校验（DFS 着色）。返回问题列表，空数组表示合法。 */
export function validateDependencies(tasks: ReadonlyArray<Pick<CollabTask, 'id' | 'title' | 'dependsOn'>>): string[] {
	const issues: string[] = [];
	const byId = new Map(tasks.map(t => [t.id, t]));
	for (const t of tasks) {
		for (const dep of t.dependsOn ?? []) {
			// 自依赖只报一次（否则会同时触发「依赖自身」与「成环」两条，噪音）
			if (dep === t.id) { issues.push(`任务 "${t.id}" 依赖自身`); continue; }
			if (!byId.has(dep)) { issues.push(`任务 "${t.id}" 依赖未知任务 "${dep}"`); }
		}
	}
	// DFS 三色着色找环（0=未访问 1=访问中 2=已完成）
	const color = new Map<string, 0 | 1 | 2>();
	const visit = (id: string, path: string[]): void => {
		const c = color.get(id) ?? 0;
		if (c === 2) { return; }
		if (c === 1) {
			issues.push(`依赖成环：${[...path, id].join(' → ')}`);
			return;
		}
		color.set(id, 1);
		const t = byId.get(id);
		for (const dep of t?.dependsOn ?? []) {
			if (dep === id) { continue; }   // 自依赖已在上面单独报告
			if (byId.has(dep)) { visit(dep, [...path, id]); }
		}
		color.set(id, 2);
	};
	for (const t of tasks) { visit(t.id, []); }
	return issues;
}

export function createCollaborationQueue(initial: ReadonlyArray<Omit<CollabTask, 'status'> & { status?: CollabTaskStatus }> = []): CollaborationQueue {
	const tasks = new Map<string, CollabTask>();
	const listeners = new Map<CollabQueueEvent, Set<(t: CollabTask) => void>>();

	const emit = (event: CollabQueueEvent, task: CollabTask): void => {
		for (const cb of listeners.get(event) ?? []) { cb(task); }
	};

	/**
	 * 已广播过 `task:ready` 的任务 id。
	 *
	 * ★ 为什么必须去重：调度方（画布执行器）以 `task:ready` 事件作为**派发信号**——
	 *   同一任务重复广播会让它被重复派发（重复调 LLM / 重复写快照）。
	 *   `announceReady()` 会遍历**所有**满足依赖的 pending 任务，若不记已广播，
	 *   每完成一个任务都会把「无依赖任务」再广播一遍。
	 */
	const announcedReady = new Set<string>();

	const get = (id: string): CollabTask | undefined => tasks.get(id);

	const isTerminal = (s: CollabTaskStatus): boolean => s === 'completed' || s === 'failed' || s === 'skipped';

	/** 依赖是否全部完成（空依赖 = 立即就绪）。 */
	const depsSatisfied = (task: CollabTask): boolean =>
		(task.dependsOn ?? []).every((d) => get(d)?.status === 'completed');

	/**
	 * 级联终态：把「直接依赖 failedTaskId 且尚未终态」的下游递归标记为 failed。
	 * 与 open-multi-agent `queue.ts:514 cascadeFailure` 同构——递归传递依赖。
	 */
	const cascade = (failedTaskId: string, status: 'failed' | 'skipped', makeError: (depTitle: string) => string): void => {
		for (const task of tasks.values()) {
			if (isTerminal(task.status) || task.status === 'in_progress') { continue; }
			if (!(task.dependsOn ?? []).includes(failedTaskId)) { continue; }
			const depTitle = get(failedTaskId)?.title ?? failedTaskId;
			task.status = status;
			task.error = makeError(depTitle);
			emit(status === 'failed' ? 'task:failed' : 'task:skipped', task);
			cascade(task.id, status, makeError);   // 递归传递
		}
	};

	/** 完成一个任务后，把「依赖已全部满足」且**尚未广播过**的 pending 任务标记就绪并广播。 */
	const announceReady = (): void => {
		for (const task of tasks.values()) {
			if (task.status !== 'pending') { continue; }
			if (!depsSatisfied(task)) { continue; }
			if (announcedReady.has(task.id)) { continue; }   // 去重：ready 是派发信号
			announcedReady.add(task.id);
			emit('task:ready', task);
		}
	};

	const queue: CollaborationQueue = {
		add(task) {
			if (tasks.has(task.id)) { throw new Error(`任务 id 重复：${task.id}`); }
			const created: CollabTask = { ...task, status: task.status ?? 'pending' };
			tasks.set(created.id, created);
			emit('task:added', created);
			// 不发 ready：就绪广播统一由 announceReady() 负责（幂等、订阅后调用）
			return created;
		},
		get,
		list: () => [...tasks.values()],
		update(id, patch) {
			const cur = get(id);
			if (!cur) { throw new Error(`任务不存在：${id}`); }
			Object.assign(cur, patch, { id });
			return cur;
		},
		ready: () => [...tasks.values()].filter(t => t.status === 'pending' && depsSatisfied(t)),
		announceReady,
		start(id) {
			const t = queue.update(id, { status: 'in_progress' });
			return t;
		},
		complete(id, result) {
			const t = queue.update(id, { status: 'completed', ...(result !== undefined ? { result } : {}), error: undefined });
			emit('task:completed', t);
			announceReady();
			return t;
		},
		fail(id, error) {
			const t = queue.update(id, { status: 'failed', error });
			emit('task:failed', t);
			cascade(id, 'failed', (depTitle) => `Cancelled: dependency "${depTitle}" failed.`);
			return t;
		},
		skip(id, reason) {
			const t = queue.update(id, { status: 'skipped', ...(reason ? { error: reason } : {}) });
			emit('task:skipped', t);
			cascade(id, 'skipped', (depTitle) => `Skipped: dependency "${depTitle}" was skipped.`);
			return t;
		},
		on(event, cb) {
			let set = listeners.get(event);
			if (!set) { set = new Set(); listeners.set(event, set); }
			set.add(cb);
			return () => { set?.delete(cb); };
		},
		isDone: () => [...tasks.values()].every(t => isTerminal(t.status)),
		summary() {
			const out: Record<CollabTaskStatus, number> = { pending: 0, in_progress: 0, completed: 0, failed: 0, skipped: 0 };
			for (const t of tasks.values()) { out[t.status]++; }
			return out;
		},
	};

	for (const t of initial) { queue.add(t); }
	return queue;
}
