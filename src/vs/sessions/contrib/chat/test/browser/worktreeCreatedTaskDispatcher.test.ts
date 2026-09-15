/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IChat, ISession, ISessionCapabilities, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsChangeEvent, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ITaskEntry, ISessionTaskRunEvent, ISessionsTasksService, ISessionTaskWithTarget } from '../../browser/sessionsTasksService.js';
import { WorktreeCreatedTaskDispatcher } from '../../browser/worktreeCreatedTaskDispatcher.js';

function makeSession(opts: {
	sessionId?: string;
	providerId?: string;
	loading?: boolean;
	status?: SessionStatus;
	isArchived?: boolean;
	workingDirectory?: URI;
	repoUri?: URI;
	capabilities?: Partial<ISessionCapabilities>;
}): { session: ISession; workspaceObs: ReturnType<typeof observableValue<ReturnType<typeof makeWorkspace> | undefined>>; isArchivedObs: ReturnType<typeof observableValue<boolean>> } {

	const repoUri = opts.repoUri ?? URI.parse('file:///repo');
	const workspace = opts.workingDirectory ? makeWorkspace(opts.workingDirectory, repoUri) : undefined;
	const workspaceObs = observableValue('workspace', workspace);
	const isArchivedObs = observableValue('isArchived', opts.isArchived ?? false);

	const chat: IChat = {
		resource: URI.parse('file:///session'),
		createdAt: new Date(),
		title: observableValue('title', 'test'),
		updatedAt: observableValue('updatedAt', new Date()),
		status: observableValue('status', opts.status ?? SessionStatus.InProgress),
		changesets: observableValue('changesets', []),
		changes: observableValue('changes', []),
		modelId: observableValue('modelId', undefined),
		mode: observableValue('mode', undefined),
		isArchived: isArchivedObs,
		isRead: observableValue('isRead', true),
		lastTurnEnd: observableValue('lastTurnEnd', undefined),
		description: observableValue('description', undefined),
	};

	const session: ISession = {
		sessionId: opts.sessionId ?? 'test:session',
		resource: chat.resource,
		providerId: opts.providerId ?? 'test',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: workspaceObs,
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changesets: chat.changesets,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('loading', opts.loading ?? false),
		isArchived: isArchivedObs,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		gitHubInfo: observableValue('gitHubInfo', undefined),
		chats: observableValue('chats', [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false, ...opts.capabilities },
	};

	return { session, workspaceObs, isArchivedObs };
}

function makeWorkspace(workingDirectory: URI, repoUri?: URI) {
	const uri = repoUri ?? workingDirectory;
	return {
		label: 'test',
		icon: Codicon.folder,
		repositories: [{
			uri,
			workingDirectory,
			detail: undefined,
			baseBranchName: undefined,
		}],
		requiresWorkspaceTrust: false,
	};
}

function makeWorktreeTask(label: string): ITaskEntry {
	return { label, type: 'shell', command: label, inAgents: true, runOptions: { runOn: 'worktreeCreated' } };
}

function makeDefaultTask(label: string): ITaskEntry {
	return { label, type: 'shell', command: label, inAgents: true, runOptions: { runOn: 'default' } };
}

suite('WorktreeCreatedTaskDispatcher', () => {

	const store = new DisposableStore();
	let onDidChangeSessionsEmitter: Emitter<ISessionsChangeEvent>;
	let tasksService: ISessionsTasksService & {
		getSessionTasksOnceStub: (session: ISession) => Promise<readonly ISessionTaskWithTarget[]>;
		runTaskStub: (task: ITaskEntry, session: ISession) => Promise<IDisposable | undefined>;
	};
	let runTaskCalls: { label: string; sessionId: string }[];
	let disposedHandles: string[];
	let configValue: boolean;

	setup(() => {
		onDidChangeSessionsEmitter = new Emitter<ISessionsChangeEvent>();
		store.add(onDidChangeSessionsEmitter);

		runTaskCalls = [];
		disposedHandles = [];
		configValue = true;

		const sessionsManagementService = new class extends mock<ISessionsManagementService>() {
			override onDidChangeSessions = onDidChangeSessionsEmitter.event;
		};

		tasksService = {
			getSessionTasksOnce: async (session: ISession): Promise<readonly ISessionTaskWithTarget[]> => {
				return tasksService.getSessionTasksOnceStub(session);
			},
			runTask: async (task: ITaskEntry, session: ISession): Promise<IDisposable | undefined> => {
				return tasksService.runTaskStub(task, session);
			},
			onDidRunTask: Event.None as Event<ISessionTaskRunEvent>,
			getSessionTasksOnceStub: async () => [],
			runTaskStub: async (task: ITaskEntry) => {
				runTaskCalls.push({ label: task.label, sessionId: 'test' });
				const handle: IDisposable = { dispose: () => { disposedHandles.push(task.label); } };
				return handle;
			},
		} as unknown as ISessionsTasksService & {
			getSessionTasksOnceStub: (session: ISession) => Promise<readonly ISessionTaskWithTarget[]>;
			runTaskStub: (task: ITaskEntry, session: ISession) => Promise<IDisposable | undefined>;
		};

		const configService = new class extends mock<IConfigurationService>() {
			override getValue<T>(): T { return configValue as unknown as T; }
		};

		const logService = new class extends mock<ILogService>() {
			override trace() { }
			override warn() { }
		};

		store.add(new WorktreeCreatedTaskDispatcher(
			sessionsManagementService,
			tasksService,
			configService,
			logService
		));
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dispatches worktreeCreated tasks when working directory becomes available', async () => {
		const { session, workspaceObs } = makeSession({ loading: false, status: SessionStatus.InProgress });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Install & Watch'), target: 'workspace' },
			{ task: makeDefaultTask('Quick Run'), target: 'workspace' },
		];

		// Fire the session as added (no working directory yet)
		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));
		assert.strictEqual(runTaskCalls.length, 0, 'should not dispatch before working directory is available');

		// Now set the working directory (with a different repo uri → real worktree)
		workspaceObs.set(makeWorkspace(URI.parse('file:///worktree'), URI.parse('file:///repo')), undefined);
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1, 'should dispatch only worktreeCreated task');
		assert.strictEqual(runTaskCalls[0].label, 'Install & Watch');
	});

	test('does not dispatch non-worktreeCreated tasks', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
			{ task: makeDefaultTask('Build'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1);
		assert.strictEqual(runTaskCalls[0].label, 'Watch');
	});

	test('disposes task handles when session is archived', async () => {
		const { session, isArchivedObs } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));
		assert.strictEqual(disposedHandles.length, 0);

		isArchivedObs.set(true, undefined);
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(disposedHandles.length, 1, 'handle should be disposed when session is archived');
	});

	test('cleans up resources when session is removed', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		onDidChangeSessionsEmitter.fire({ added: [], removed: [session], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(disposedHandles.length, 1, 'handle should be disposed when session is removed');
	});

	test('skips sessions with runsWorktreeCreatedTasks capability', async () => {
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: URI.parse('file:///worktree'),
			capabilities: { runsWorktreeCreatedTasks: true },
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 0, 'should skip sessions that run their own worktreeCreated tasks');
	});

	test('does not dispatch while session is loading', async () => {
		const { session, workspaceObs } = makeSession({ loading: true, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));
		assert.strictEqual(runTaskCalls.length, 0, 'should not dispatch while loading');

		// Simulate loading completing — update the loading observable.
		// Since loading is a separate observable, we re-create the autorun effect by
		// changing the workspace observable (which the autorun also reads).
		workspaceObs.set(makeWorkspace(URI.parse('file:///worktree')), undefined);
		await new Promise(r => setTimeout(r, 10));
		// Still loading, so still no dispatch
		assert.strictEqual(runTaskCalls.length, 0);
	});

	test('does not dispatch for sessions with Untitled status', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.Untitled, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 0, 'should not dispatch for untitled sessions');
	});

	test('immediately disposes handle if session is already archived at dispatch time', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree'), isArchived: true });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1, 'task should still be dispatched');
		assert.strictEqual(disposedHandles.length, 1, 'handle should be immediately disposed since session is archived');
	});

	test('handles multiple worktreeCreated tasks', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Install'), target: 'workspace' },
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
			{ task: makeDefaultTask('Build'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 2, 'should dispatch both worktreeCreated tasks');
		assert.deepStrictEqual(runTaskCalls.map(c => c.label), ['Install', 'Watch']);
	});

	test('handles getSessionTasksOnce rejection gracefully', async () => {
		const { session } = makeSession({ loading: false, status: SessionStatus.InProgress, workingDirectory: URI.parse('file:///worktree') });
		tasksService.getSessionTasksOnceStub = async () => {
			throw new Error('read failed');
		};

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 0, 'should not dispatch when tasks read fails');
	});

	test('does NOT dispatch when workingDirectory equals repo uri (main checkout, not a worktree)', async () => {
		// workingDirectory === uri → this is the main repository checkout,
		// not a worktree. The dispatcher must not auto-fire.
		const repoUri = URI.parse('file:///main-repo');
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: repoUri,  // same as uri
			repoUri,
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 0, 'should not dispatch for main checkout (non-worktree)');
	});

	test('dispatches when workingDirectory differs from repo uri (real worktree)', async () => {
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: URI.parse('file:///repo.worktrees/feat-branch'),
			repoUri: URI.parse('file:///repo'),
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Install & Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1, 'should dispatch for real worktree (workingDirectory ≠ uri)');
		assert.strictEqual(runTaskCalls[0].label, 'Install & Watch');
	});

	test('skips agent-host sessions when config is disabled', async () => {
		configValue = false;
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: URI.parse('file:///repo.worktrees/feat'),
			repoUri: URI.parse('file:///repo'),
			providerId: 'local-agent-host',
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 0, 'should skip agent-host session when config is disabled');
	});

	test('dispatches agent-host sessions when config is enabled', async () => {
		configValue = true;
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: URI.parse('file:///repo.worktrees/feat'),
			repoUri: URI.parse('file:///repo'),
			providerId: 'local-agent-host',
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1, 'should dispatch agent-host session when config is enabled');
	});

	test('dispatches non-agent-host sessions regardless of config', async () => {
		configValue = false;  // config disabled, but session is not agent-host
		const { session } = makeSession({
			loading: false,
			status: SessionStatus.InProgress,
			workingDirectory: URI.parse('file:///repo.worktrees/feat'),
			repoUri: URI.parse('file:///repo'),
			providerId: 'copilot-cli',
		});
		tasksService.getSessionTasksOnceStub = async () => [
			{ task: makeWorktreeTask('Watch'), target: 'workspace' },
		];

		onDidChangeSessionsEmitter.fire({ added: [session], removed: [], changed: [] });
		await new Promise(r => setTimeout(r, 10));

		assert.strictEqual(runTaskCalls.length, 1, 'should dispatch non-agent-host session even when config is disabled');
	});
});

/**
 * ★★ 系统性守卫（2026-09-15）：`const X = autorun(...)` 回调里调用 `X.dispose()` 的 **TDZ 反模式**。
 *
 * 为什么放在这里：本文件上面那 15 个用例之所以曾**全挂**，根因就是 `_trackSession` 里的这个写法
 * —— `autorun()` 的回调是**同步执行**的（`AutorunObserver` 构造函数末尾立刻 `_run()`），
 * 那一刻 `const X` 仍在 TDZ ⇒ `ReferenceError: Cannot access 'X' before initialization`。
 *
 * 为什么必须**扫源码**而不是再写个单测：异常被 `_run()` 交给 `onBugIndicatingError`
 * **吞掉**（只记日志），所以真机表现不是崩溃，而是「功能静默不发生」——
 * 单元测试测不到「某条回调路径没被执行」，只有源码级断言能钉住。
 *
 * 正确写法（二选一，见 `base/common/observableInternal/utils/utilsCancellation.ts:35`
 * 的上游范例）：
 *   ① 用一个**在 autorun 之前就已初始化**的 `DisposableStore`，回调里 `store.clear()`；
 *   ② 或保留 `let` 标志位，首次同步执行时置位、之后（异步）再 dispose。
 */
suite('TDZ 反模式守卫 — sessions 层不得自引用 dispose', () => {

	/**
	 * 去注释 —— 源码级扫描必须只看**代码**。
	 *
	 * ⚠ 本断言第一版就被**自己的说明文字**骗了：注释里引用了那个反模式的原写法，
	 * 于是扫出一个"命中"。这与 `guardrailWiring.test.ts` 记过的是同一个坑
	 * （注释让正向断言假通过、让负向断言假失败）。
	 * 实现刻意简单（不求完美）：先剥块注释，再剥行注释（带前导字符守卫，避免把
	 * `https://…` 里的 `//` 当注释起点）。
	 */
	function stripComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
	}

	/** 扫 `src/vs/sessions` 下所有 .ts。 */
	function scanSelfDisposingAutorun(): string[] {
		const root = path.join(process.cwd(), 'src/vs/sessions');
		const hits: string[] = [];

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
					const src = stripComments(fs.readFileSync(full, 'utf8'));
					const declRe = /(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?=\s*autorun\s*\(/g;
					let m: RegExpExecArray | null;
					while ((m = declRe.exec(src)) !== null) {
						const name = m[1];
						// 取「括号配平」的回调体
						let i = declRe.lastIndex - 1;
						let depth = 0;
						let end = -1;
						for (; i < src.length; i++) {
							if (src[i] === '(') { depth++; }
							else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
						}
						if (end < 0) { continue; }
						const body = src.slice(declRe.lastIndex, end);
						if (new RegExp(`\\b${name}\\s*\\.\\s*dispose\\s*\\(`).test(body)) {
							hits.push(`${path.relative(process.cwd(), full)}: const ${name} = autorun(...) 内部调用 ${name}.dispose()`);
						}
					}
				}
			}
		};
		walk(root);
		return hits;
	}

	test('★★★ sessions 层不得出现「autorun 回调自引用 dispose」（TDZ + 异常被吞）', () => {
		const hits = scanSelfDisposingAutorun();
		assert.deepStrictEqual(
			hits,
			[],
			'发现 TDZ 反模式：autorun 首次回调是同步执行的，此时 const 尚未初始化 ⇒ '
			+ 'ReferenceError 且被 onBugIndicatingError 吞掉（功能静默失效）。'
			+ '改用「先建 DisposableStore 再 add autorun」或首次执行置位标志：\n  ' + hits.join('\n  '),
		);
	});
});
