/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
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
