/*---------------------------------------------------------------------------------------------
 *  taskStore — unified task-progress store for the workflow editor (P3).
 *
 *  One task list for the three long-running operation kinds the editor shows
 *  in the top-right "任务" panel (ComfyUI-style Queue):
 *    - install   ComfyUI 安装 / 依赖准备
 *    - download  模型下载
 *    - generate  出图（单节点 / 全图执行）
 *
 *  The store is a plain class + React hook + module singleton (mirrors
 *  runnerStatusStore.ts / cardState.ts). Pure, DOM-free, unit-testable.
 *  Tasks are keyed by id; producers update progress in place (e.g. the
 *  generation pipeline reports 0→100), and the panel re-renders via the hook.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

export type TaskType = 'install' | 'download' | 'generate';
export type TaskStatus = 'queued' | 'running' | 'success' | 'error';

export interface TaskItem {
	id: string;
	type: TaskType;
	label: string;
	status: TaskStatus;
	/** 0–100；-1 表示「不确定进度」（如未探测到总大小的下载）。 */
	progress: number;
	message?: string;
	createdAt: number;
	updatedAt: number;
	/**
	 * 关联的画布节点 id（仅 generate 单节点任务有）。任务进度面板的「取消」
	 * 按钮据此调用 abortNodeRun(nodeId) 中止对应运行；全图/安装/下载任务无此字段。
	 */
	nodeId?: string;
}

export interface TaskPatch {
	status?: TaskStatus;
	progress?: number;
	message?: string;
	label?: string;
}

const TYPE_LABEL: Record<TaskType, string> = {
	install: '安装',
	download: '下载',
	generate: '出图',
};

export function taskTypeLabel(type: TaskType): string {
	return TYPE_LABEL[type];
}

const MAX_TASKS = 50;

class TaskStore {
	private tasks: TaskItem[] = [];
	private listeners = new Set<() => void>();

	/** All tasks, newest first (most recent update on top). */
	get(): TaskItem[] {
		return this.tasks;
	}

	/** Count of not-yet-finished tasks (queued + running). */
	getActiveCount(): number {
		return this.tasks.filter(t => t.status === 'queued' || t.status === 'running').length;
	}

	hasActive(): boolean {
		return this.getActiveCount() > 0;
	}

	add(type: TaskType, label: string, opts?: { id?: string; progress?: number; message?: string; nodeId?: string }): string {
		const now = Date.now();
		const id = opts?.id ?? `${type}-${now}-${Math.random().toString(36).slice(2, 7)}`;
		// Reuse an existing running/queued task with the same id (idempotent start).
		const existing = this.tasks.find(t => t.id === id);
		if (existing) {
			this.update(id, { status: 'running', progress: opts?.progress ?? existing.progress, message: opts?.message ?? existing.message });
			return id;
		}
		const item: TaskItem = {
			id,
			type,
			label,
			status: 'queued',
			progress: opts?.progress ?? 0,
			message: opts?.message,
			...(opts?.nodeId ? { nodeId: opts.nodeId } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.tasks = [item, ...this.tasks].slice(0, MAX_TASKS);
		this.notify();
		return id;
	}

	update(id: string, patch: TaskPatch): void {
		const idx = this.tasks.findIndex(t => t.id === id);
		if (idx < 0) { return; }
		const cur = this.tasks[idx];
		const next: TaskItem = {
			...cur,
			status: patch.status ?? cur.status,
			progress: patch.progress ?? cur.progress,
			message: patch.message !== undefined ? patch.message : cur.message,
			label: patch.label ?? cur.label,
			updatedAt: Date.now(),
		};
		this.tasks[idx] = next;
		// Keep newest-updated on top.
		if (idx > 0) {
			this.tasks.splice(idx, 1);
			this.tasks.unshift(next);
		}
		this.notify();
	}

	/** Move a queued task to running (convenience for the first update). */
	start(id: string, message?: string): void {
		this.update(id, { status: 'running', ...(message !== undefined ? { message } : {}) });
	}

	/** Mark a task done. */
	finish(id: string, ok: boolean, message?: string): void {
		this.update(id, { status: ok ? 'success' : 'error', progress: ok ? 100 : this.tasks.find(t => t.id === id)?.progress ?? 0, ...(message !== undefined ? { message } : {}) });
	}

	/**
	 * 按 nodeId 结束关联的活跃任务（生成单节点任务 add 时传了 nodeId）。
	 * ★ 取消链路必须走这里：任务 id 是 `generate-<ts>-<rand>`，用 nodeId 冒充
	 *   taskId 的 finish(nodeId) 永远匹配不到行 → 任务面板「进行中」永不结束。
	 */
	finishByNode(nodeId: string, ok: boolean, message?: string): void {
		for (const t of [...this.tasks]) {
			if (t.nodeId === nodeId && (t.status === 'queued' || t.status === 'running')) {
				this.finish(t.id, ok, message);
			}
		}
	}

	remove(id: string): void {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter(t => t.id !== id);
		if (this.tasks.length !== before) { this.notify(); }
	}

	/** Drop finished tasks (success/error), keep queued + running. */
	clearFinished(): void {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter(t => t.status === 'queued' || t.status === 'running');
		if (this.tasks.length !== before) { this.notify(); }
	}

	clearAll(): void {
		this.tasks = [];
		this.notify();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	private notify(): void {
		for (const l of this.listeners) { l(); }
	}
}

let singleton: TaskStore | null = null;

export function getTaskStore(): TaskStore {
	if (!singleton) { singleton = new TaskStore(); }
	return singleton;
}

export function resetTaskStore(): void {
	singleton = null;
}

/** React hook: re-render when the task list changes. */
export function useTasks(): TaskItem[] {
	const store = getTaskStore();
	return React.useSyncExternalStore(
		store.subscribe,
		() => store.get(),
		() => [],
	);
}

/** React hook: re-render when the active (unfinished) task count changes. */
export function useActiveTaskCount(): number {
	const store = getTaskStore();
	return React.useSyncExternalStore(
		store.subscribe,
		() => store.getActiveCount(),
		() => 0,
	);
}
