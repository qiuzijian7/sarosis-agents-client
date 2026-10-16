/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作区注册同步（方案第 8.2 节）：各窗口上报自己的工作区目录（主根、各根、worktree），
 * 控制桥连上后经 `workspace.ensure` 幂等注册为 dsh 工作区。
 *
 * - VsSaros 不维护 id 映射、不比较路径：规范化（盘符大小写、junction、符号链接）全部交给 dsh。
 * - 注册时机：每次连上控制桥（含 Host 重启、升级切换）先全量注册，再让视图加载页面——
 *   注册表非空后 dsh 不会再自动创建 default-workspace。
 * - 只增不删：窗口关闭或工作区移除时不删除 dsh 登记（dsh 的删除本来也保留会话）。
 *
 * 只依赖 vs/base 与本目录 common，不 import electron。
 */

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { IBridgeWorkspace } from '../common/dshBridgeProtocol.js';
import { IDshWorkspaceSyncState } from '../common/dshHarness.js';

export type EnsureWorkspaces = (paths: readonly string[]) => Promise<readonly IBridgeWorkspace[]>;

/** 单个窗口最多上报的目录数；超出部分丢弃（防止渲染进程异常时一次性塞入大量路径）。 */
export const MAX_PATHS_PER_WINDOW = 64;
const MAX_PATH_LENGTH = 4096;

/** 校验并去重（按原始字符串；同一目录的不同写法交给 dsh 合并）。 */
export function sanitizeWorkspacePaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: string[] = [];
	for (const p of raw) {
		if (typeof p !== 'string') {
			continue;
		}
		const v = p.trim();
		if (!v || v.length > MAX_PATH_LENGTH || v.includes('\0') || !isAbsolute(v) || out.includes(v)) {
			continue;
		}
		out.push(v);
		if (out.length >= MAX_PATHS_PER_WINDOW) {
			break;
		}
	}
	return out;
}

export class DshWorkspaceSync extends Disposable {
	private readonly _byWindow = new Map<number, string[]>();
	/** 当前连接上已注册（成功或失败都记录）的结果，按上报的原始路径索引。 */
	private readonly _results = new Map<string, IBridgeWorkspace>();
	private _ensure: EnsureWorkspaces | undefined;
	private _generation = 0;
	/** 串行化：同一时刻只有一个 ensure 在途，避免全量与增量交错。 */
	private _queue: Promise<unknown> = Promise.resolve();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** 注册结果或上报内容变化：渲染进程据此刷新显示（经通道事件转发）。 */
	private readonly _onDidSync = this._register(new Emitter<void>());
	readonly onDidSync = this._onDidSync.event;

	constructor(private readonly _log: (line: string) => void) {
		super();
	}

	/**
	 * 渲染进程上报某窗口的工作区目录（整体替换）。已连接时只注册新增（或上次被拒）的目录；
	 * 返回该窗口全部目录在当前连接上的注册结果（未连接时为空）。
	 */
	async setWindowWorkspaces(windowId: number, rawPaths: unknown): Promise<readonly IBridgeWorkspace[]> {
		const paths = sanitizeWorkspacePaths(rawPaths);
		if (paths.length) {
			this._byWindow.set(windowId, paths);
		} else {
			this._byWindow.delete(windowId);
		}
		this._onDidSync.fire();
		const pending = paths.filter(p => !this._results.has(p) || this._results.get(p)?.error);
		if (pending.length && this._ensure) {
			await this._run(pending);
		}
		return paths.map(p => this._results.get(p)).filter((r): r is IBridgeWorkspace => !!r);
	}

	removeWindow(windowId: number): void {
		this._byWindow.delete(windowId);
	}

	/**
	 * 新连接（控制桥握手成功）：清空上一连接的结果并全量注册。调用方应等它完成后再让视图加载页面。
	 * 传 undefined 表示断开。
	 */
	async connect(ensure: EnsureWorkspaces | undefined): Promise<void> {
		this._generation++;
		this._ensure = ensure;
		this._results.clear();
		if (!ensure) {
			this._onDidChange.fire();
			this._onDidSync.fire();
			return;
		}
		const all = this._allPaths();
		if (all.length) {
			await this._run(all);
		}
	}

	get state(): IDshWorkspaceSyncState {
		return {
			connected: !!this._ensure,
			windows: [...this._byWindow].map(([windowId, paths]) => ({ windowId, paths: [...paths] })),
			results: [...this._results.values()],
		};
	}

	private _allPaths(): string[] {
		const set = new Set<string>();
		for (const paths of this._byWindow.values()) {
			paths.forEach(p => set.add(p));
		}
		return [...set];
	}

	private _run(paths: readonly string[]): Promise<readonly IBridgeWorkspace[]> {
		const gen = this._generation;
		const ensure = this._ensure!;
		const task = this._queue.then(async () => {
			if (gen !== this._generation) {
				return [];
			}
			let result: readonly IBridgeWorkspace[];
			try {
				result = await ensure(paths);
			} catch (e) {
				// 整体失败（桥超时、插件不支持）：不记录结果，下次上报或下次连接时重试。
				this._log(`workspace.ensure failed for ${paths.length} path(s): ${String((e as Error)?.message ?? e)}`);
				return [];
			}
			if (gen !== this._generation) {
				return [];
			}
			// 按位置对应（插件按输入顺序返回）；返回的 path 是 dsh 规范化后的路径。
			paths.forEach((p, i) => {
				const r = result[i];
				if (r) {
					this._results.set(p, r);
				}
			});
			const failed = result.filter(r => r.error);
			this._log(`workspace.ensure: ${result.length - failed.length} ok, ${failed.length} rejected${failed.length ? ` (${failed.map(f => `${f.path}: ${f.error}`).join('; ').slice(0, 300)})` : ''}`);
			this._onDidChange.fire();
			this._onDidSync.fire();
			return result;
		});
		this._queue = task.catch(() => undefined);
		return task;
	}
}
