/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { SessionStatus, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsTasksService } from './sessionsTasksService.js';

const LOG_PREFIX = '[WorktreeCreatedTaskDispatcher]';

/**
 * Setting that controls whether `runOptions.runOn === 'worktreeCreated'`
 * tasks are auto-dispatched for agent host sessions when a new worktree is
 * created. Defaults to `true`. Manual `Run Task` invocations are unaffected.
 */
export const AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING = 'chat.agentHost.runWorktreeCreatedTasks';

/**
 * Provider ID regex for agent host providers (local + remote).
 * Used to decide whether the {@link AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING}
 * config gate applies to a given session.
 */
const ANY_AGENT_HOST_PROVIDER_RE = /^(local-agent-host|saros-local-agent-host|agenthost-)/;

/**
 * Workbench contribution that runs all tasks tagged with
 * `runOptions.runOn === 'worktreeCreated'` once per newly-added session,
 * when the session first reports an actual git worktree.
 *
 * A "real worktree" is detected when a repository's `workingDirectory`
 * differs from its `uri` — mirroring upstream's `workTreeUri` semantics
 * where `workTreeUri = workingDirectory !== project.uri ? workingDirectory
 * : undefined`. This prevents false-positive dispatch for sessions whose
 * `workingDirectory` simply points to the main repository checkout.
 *
 * Sessions whose runtime already runs these tasks server-side (signalled via
 * {@link ISessionCapabilities.runsWorktreeCreatedTasks}) are skipped to avoid
 * double-execution.
 *
 * The stop handles returned by the dispatched tasks are tracked per session and
 * disposed when the session is archived or removed, so the long-running
 * setup/build processes don't leak.
 *
 * We deliberately ignore sessions that predate this contribution so restored
 * sessions don't re-run setup tasks when the agents window opens.
 */
export class WorktreeCreatedTaskDispatcher extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.worktreeCreatedTaskDispatcher';

	// Track per-session disposables (one per in-flight session subscription) so
	// we tear them down when the session is removed.
	private readonly _sessionDisposables = this._register(new DisposableMap<string>());

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsTasksService private readonly _sessionsTasksService: ISessionsTasksService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._sessionsManagementService.onDidChangeSessions(e => {
			for (const session of e.added) {
				this._trackSession(session);
			}
			this._onDidRemoveSessions(e.removed);
		}));
	}

	private _onDidRemoveSessions(removed: readonly ISession[]): void {
		for (const session of removed) {
			this._sessionDisposables.deleteAndDispose(session.sessionId);
		}
	}

	private _trackSession(session: ISession): void {
		if (session.capabilities.runsWorktreeCreatedTasks) {
			// The session's runtime already runs these tasks itself.
			return;
		}
		if (this._sessionDisposables.get(session.sessionId)) {
			return;
		}

		const store = new DisposableStore();
		this._sessionDisposables.set(session.sessionId, store);

		const taskHandles = store.add(new DisposableStore());

		// Watch the session's workspace observable until a repository with a
		// real worktree (workingDirectory differs from uri) becomes available,
		// then dispatch once and stop watching. We use a local "dispatched"
		// flag because the fork's observable reader does not expose
		// `reader.dispose()` like upstream.
		//
		// ★★ 2026-09-15 修 TDZ（**这是个真 bug，曾让本模块完全失效**）：
		// 原写法是 `const autorunDisposable = autorun(reader => { … autorunDisposable.dispose(); })`
		// —— 但 `autorun()` 的回调是**同步执行**的（`AutorunObserver` 构造函数里立刻 `_run()`），
		// 那一刻 `autorunDisposable` 还在 TDZ（`const` 尚未初始化）
		// ⇒ `ReferenceError: Cannot access 'autorunDisposable' before initialization`。
		//
		// 更隐蔽的是**报错被吞**：`_run()` 把回调异常交给 `onBugIndicatingError`（仅记日志），
		// 于是表现为「派发静默不发生」而不是崩溃 —— 单元测试里 20 个用例全挂，
		// 真机上只会看到任务没被创建。
		//
		// 修法：把「停止观察」的载体换成**在 autorun 之前就已初始化**的 `DisposableStore`。
		// 回调里 `watchStore.clear()` 即安全地停掉自己 —— 该实现支持运行中 dispose
		// （`AutorunObserver.dispose()` 幂等、无「运行中禁止」守卫，`_run` 的 finally
		// 也显式检查 `_disposed`）。
		let dispatched = false;
		const watchStore = store.add(new DisposableStore());
		watchStore.add(autorun(reader => {
			if (dispatched) {
				return;
			}
			if (session.loading.read(reader)) {
				return;
			}
			if (session.status.read(reader) === SessionStatus.Untitled) {
				return;
			}
			const workspace = session.workspace.read(reader);
			// Only dispatch when a repository has a workingDirectory that
			// differs from its uri — this means the session is operating in
			// a git worktree, not just the main checkout. Mirrors upstream's
			// `workTreeUri` semantics.
			if (!workspace?.repositories.some(repo => this._isWorktree(repo))) {
				return;
			}
			dispatched = true;
			// Stop watching for further workspace changes now that we've dispatched.
			// （`watchStore` 在 autorun 之前已初始化 ⇒ 无 TDZ，同步/异步派发都成立。）
			watchStore.clear();
			this._dispatchWorktreeCreatedTasks(session, taskHandles);
		}));

		// When the session is archived, stop any long-running tasks that were
		// started by the dispatcher (e.g. `npm run watch`).
		store.add(autorun(reader => {
			if (session.isArchived.read(reader)) {
				taskHandles.clear();
			}
		}));
	}

	/**
	 * Returns true when the repository represents a real git worktree — i.e.
	 * its `workingDirectory` is set **and** differs from the repository `uri`.
	 * When they are equal the session is just using the main checkout, not a
	 * worktree, so `worktreeCreated` tasks should not auto-fire.
	 */
	private _isWorktree(repo: { readonly uri: import('../../../../base/common/uri.js').URI; readonly workingDirectory: import('../../../../base/common/uri.js').URI | undefined }): boolean {
		if (!repo.workingDirectory) {
			return false;
		}
		// When workingDirectory === uri, the session operates on the main
		// repository checkout, not a worktree.
		return !isEqual(repo.workingDirectory, repo.uri);
	}

	private async _dispatchWorktreeCreatedTasks(session: ISession, taskHandles: DisposableStore): Promise<void> {
		// Allow users to disable auto-dispatch for agent-host sessions via
		// configuration. Non-agent-host sessions always dispatch.
		if (ANY_AGENT_HOST_PROVIDER_RE.test(session.providerId) &&
			!this._configurationService.getValue<boolean>(AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING)) {
			this._logService.trace(`${LOG_PREFIX} Skipping worktreeCreated tasks for agent host session '${session.sessionId}' — '${AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING}' is disabled.`);
			return;
		}

		let tasks;
		try {
			tasks = await this._sessionsTasksService.getSessionTasksOnce(session);
		} catch (err) {
			this._logService.warn(`${LOG_PREFIX} Failed to read tasks for session '${session.sessionId}': ${err}`);
			return;
		}

		for (const { task } of tasks) {
			if (task.runOptions?.runOn !== 'worktreeCreated') {
				continue;
			}
			this._logService.trace(`${LOG_PREFIX} Running worktreeCreated task '${task.label}' for session '${session.sessionId}'`);
			try {
				const handle = await this._sessionsTasksService.runTask(task, session);
				if (handle) {
					if (session.isArchived.get()) {
						handle.dispose();
					} else {
						taskHandles.add(handle);
					}
				}
			} catch (err) {
				this._logService.warn(`${LOG_PREFIX} Failed to run task '${task.label}' for session '${session.sessionId}': ${err}`);
			}
		}
	}
}
