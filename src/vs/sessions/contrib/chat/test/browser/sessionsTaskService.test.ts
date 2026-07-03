/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IFileContent, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IJSONEditingService, IJSONValue } from '../../../../../workbench/services/configuration/common/jsonEditing.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { INonSessionTaskEntry, ISessionsTasksService, SessionsTasksService, ITaskEntry } from '../../browser/sessionsTasksService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ISessionTaskRunner, ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry } from '../../browser/sessionTaskRunner.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

function makeSession(opts: { repository?: URI; worktree?: URI } = {}): ISession {
	const workspace = opts.repository ? {
		label: 'test',
		icon: Codicon.folder,
		repositories: [{
			uri: opts.repository,
			workingDirectory: opts.worktree,
			detail: undefined,
			baseBranchName: undefined,
		}],
		requiresWorkspaceTrust: false,
	} : undefined;
	const chat: IChat = {
		resource: URI.parse('file:///session'),
		createdAt: new Date(),
		title: observableValue('title', 'session'),
		updatedAt: observableValue('updatedAt', new Date()),
		status: observableValue('status', SessionStatus.Untitled),
		changesets: observableValue('changesets', []),
		changes: observableValue('changes', []),
		modelId: observableValue('modelId', undefined),
		mode: observableValue('mode', undefined),
		isArchived: observableValue('isArchived', false),
		isRead: observableValue('isRead', true),
		lastTurnEnd: observableValue('lastTurnEnd', undefined),
		description: observableValue('description', undefined),
	};
	const session: ISession = {
		sessionId: 'test:session',
		resource: chat.resource,
		providerId: 'test',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue('workspace', workspace),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changesets: chat.changesets,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('loading', false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		gitHubInfo: observableValue('gitHubInfo', undefined),
		chats: observableValue('chats', [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false },
	};
	return session;
}

function makeTask(label: string, command?: string, inAgents?: boolean): ITaskEntry {
	return { label, type: 'shell', command: command ?? label, inAgents };
}

function makeNpmTask(label: string, script: string, inAgents?: boolean): ITaskEntry {
	return { label, type: 'npm', script, inAgents };
}

function makeUnsupportedTask(label: string, inAgents?: boolean): ITaskEntry {
	return { label, type: 'gulp', command: label, inAgents };
}

function tasksJsonContent(tasks: ITaskEntry[]): string {
	return JSON.stringify({ version: '2.0.0', tasks });
}

suite('SessionsTasksService', () => {

	const store = new DisposableStore();
	let service: ISessionsTasksService;
	let fileContents: Map<string, string>;
	let jsonEdits: { uri: URI; values: IJSONValue[] }[];
	let ranTasks: { label: string }[];
	let storageService: InMemoryStorageService;
	let readFileCalls: URI[];
	let activeSessionObs: ReturnType<typeof observableValue<IActiveSession | undefined>>;
	let preferencesService: IPreferencesService & { userSettingsResource: URI };
	let runnerRegistry: SessionTaskRunnerRegistry;
	let terminateCalls: string[];

	const userSettingsUri = URI.parse('file:///user/settings.json');
	const repoUri = URI.parse('file:///repo');
	const worktreeUri = URI.parse('file:///worktree');

	setup(() => {
		fileContents = new Map();
		jsonEdits = [];
		ranTasks = [];
		readFileCalls = [];
		terminateCalls = [];

		const instantiationService = store.add(new TestInstantiationService());
		activeSessionObs = observableValue('activeSession', undefined);

		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async readFile(resource: URI) {
				readFileCalls.push(resource);
				const content = fileContents.get(resource.toString());
				if (content === undefined) {
					throw new Error('file not found');
				}
				return { value: VSBuffer.fromString(content) } as IFileContent;
			}
			override watch() { return { dispose() { } }; }
			override onDidFilesChange: any = () => ({ dispose() { } });
		});

		instantiationService.stub(IJSONEditingService, new class extends mock<IJSONEditingService>() {
			override async write(resource: URI, values: IJSONValue[], _save: boolean) {
				jsonEdits.push({ uri: resource, values });
			}
		});

		preferencesService = new class extends mock<IPreferencesService>() {
			override userSettingsResource = userSettingsUri;
		};
		instantiationService.stub(IPreferencesService, preferencesService);

		// Register a mock runner that records runs and supports termination.
		runnerRegistry = new SessionTaskRunnerRegistry();
		const mockRunner: ISessionTaskRunner = {
			id: 'test-runner',
			priority: 0,
			canRun: () => true,
			runTask: async (task: ITaskEntry) => {
				ranTasks.push({ label: task.label });
				const handle: IDisposable = { dispose: () => { terminateCalls.push(task.label); } };
				return handle;
			}
		};
		store.add(runnerRegistry.register(mockRunner));
		instantiationService.stub(ISessionTaskRunnerRegistry, runnerRegistry);

		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override activeSession = activeSessionObs;
		});

		storageService = store.add(new InMemoryStorageService());
		instantiationService.stub(IStorageService, storageService);

		service = store.add(instantiationService.createInstance(SessionsTasksService));
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- getSessionTasks ---

	test('getSessionTasks returns tasks with inAgents: true from worktree', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('lint', 'npm run lint', false),
			makeTask('test', 'npm test', true),
			makeNpmTask('watch', 'watch', true),
			makeUnsupportedTask('gulp-task', true),
		]));
		// user tasks.json — empty
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const obs = service.getSessionTasks(session);

		// Let async refresh settle
		await new Promise(r => setTimeout(r, 10));
		const tasks = obs.get();

		assert.deepStrictEqual(tasks.map(t => t.task.label), ['build', 'test', 'watch', 'gulp-task']);
	});

	test('getSessionTasks returns empty array when no worktree', async () => {
		const session = makeSession({ repository: repoUri });
		const obs = service.getSessionTasks(session);

		await new Promise(r => setTimeout(r, 10));
		assert.deepStrictEqual(obs.get(), []);
	});

	test('getSessionTasks reads from repository when no worktree', async () => {
		const repoTasksUri = URI.parse('file:///repo/.vscode/tasks.json');
		fileContents.set(repoTasksUri.toString(), tasksJsonContent([
			makeTask('serve', 'npm run serve', true),
			makeTask('lint', 'npm run lint', false),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ repository: repoUri });
		const obs = service.getSessionTasks(session);

		await new Promise(r => setTimeout(r, 10));
		assert.deepStrictEqual(obs.get().map(t => t.task.label), ['serve']);
	});

	test('getSessionTasks does not re-read files on repeated calls for the same folder', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
		]));
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });

		// Call getSessionTasks multiple times for the same session/folder
		service.getSessionTasks(session);
		service.getSessionTasks(session);
		service.getSessionTasks(session);

		await new Promise(r => setTimeout(r, 10));

		// _refreshSessionTasks reads two files (workspace + user tasks.json).
		// If refresh triggered more than once, we'd see > 2 reads.
		assert.strictEqual(readFileCalls.length, 2, 'should read files only once (no duplicate refresh)');
	});

	test('getSessionTasks skips workspace tasks when repository URI has no path', async () => {
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userTask', 'npm run user', true),
		]));

		const session = makeSession({ repository: URI.parse('unknown://workspace') });
		const obs = service.getSessionTasks(session);

		await new Promise(r => setTimeout(r, 10));
		assert.deepStrictEqual(obs.get(), [{ task: makeTask('userTask', 'npm run user', true), target: 'user' }]);
	});

	// --- getNonSessionTasks ---

	test('getNonSessionTasks returns only tasks without inAgents', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('lint', 'npm run lint', false),
			makeTask('test', 'npm test'),
			makeNpmTask('watch', 'watch', false),
			makeUnsupportedTask('gulp-task', false),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const nonSessionTasks = await service.getNonSessionTasks(session);

		assert.deepStrictEqual(nonSessionTasks.map(t => t.task.label), ['lint', 'test', 'watch', 'gulp-task']);
	});

	test('getNonSessionTasks reads from repository when no worktree', async () => {
		const repoTasksUri = URI.parse('file:///repo/.vscode/tasks.json');
		fileContents.set(repoTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('lint', 'npm run lint', false),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ repository: repoUri });
		const nonSessionTasks = await service.getNonSessionTasks(session);

		assert.deepStrictEqual(nonSessionTasks.map(t => t.task.label), ['lint']);
	});

	test('getNonSessionTasks preserves the source target for workspace and user tasks', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('workspaceTask', 'npm run workspace'),
		]));
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userTask', 'npm run user'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const nonSessionTasks = await service.getNonSessionTasks(session);

		assert.deepStrictEqual(nonSessionTasks, [
			{ task: { label: 'workspaceTask', type: 'shell', command: 'npm run workspace' }, target: 'workspace' },
			{ task: { label: 'userTask', type: 'shell', command: 'npm run user' }, target: 'user' },
		] satisfies INonSessionTaskEntry[]);
	});

	test('getNonSessionTasks skips workspace tasks when repository URI has no path', async () => {
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userTask', 'npm run user'),
		]));

		const session = makeSession({ repository: URI.parse('unknown://workspace') });
		const nonSessionTasks = await service.getNonSessionTasks(session);

		assert.deepStrictEqual(nonSessionTasks, [
			{ task: { label: 'userTask', type: 'shell', command: 'npm run user' }, target: 'user' },
		] satisfies INonSessionTaskEntry[]);
	});

	test('user task operations are skipped when user settings URI has no path', async () => {
		preferencesService.userSettingsResource = URI.parse('test://settings');

		const session = makeSession({ repository: repoUri });
		const task = await service.createAndAddTask(undefined, 'npm run dev', session, 'user');
		const nonSessionTasks = await service.getNonSessionTasks(session);

		assert.deepStrictEqual({ task, nonSessionTasks, jsonEdits }, { task: undefined, nonSessionTasks: [], jsonEdits: [] });
	});

	// --- addTaskToSessions ---

	test('addTaskToSessions writes inAgents: true to the matching task index', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build'),
			makeTask('test', 'npm test'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const task = makeTask('test', 'npm test');
		await service.addTaskToSessions(task, session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		assert.deepStrictEqual(jsonEdits[0].values, [{ path: ['tasks', 1, 'inAgents'], value: true }]);
	});

	test('addTaskToSessions does nothing when task label not found', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.addTaskToSessions(makeTask('nonexistent'), session, 'workspace');

		assert.strictEqual(jsonEdits.length, 0);
	});

	test('addTaskToSessions writes to repository and does not commit when no worktree', async () => {
		const repoTasksUri = URI.parse('file:///repo/.vscode/tasks.json');
		fileContents.set(repoTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build'),
			makeTask('test', 'npm test'),
		]));

		const session = makeSession({ repository: repoUri });
		await service.addTaskToSessions(makeTask('test', 'npm test'), session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		assert.strictEqual(jsonEdits[0].uri.toString(), repoTasksUri.toString());
		assert.deepStrictEqual(jsonEdits[0].values, [{ path: ['tasks', 1, 'inAgents'], value: true }]);
	});

	test('addTaskToSessions updates runOptions when provided', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.addTaskToSessions(makeTask('build', 'npm run build'), session, 'workspace', { runOn: 'worktreeCreated' });

		assert.deepStrictEqual(jsonEdits[0].values, [
			{ path: ['tasks', 0, 'inAgents'], value: true },
			{ path: ['tasks', 0, 'runOptions'], value: { runOn: 'worktreeCreated' } },
		]);
	});

	test('addTaskToSessions clears runOptions when default is requested', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			{ ...makeTask('build', 'npm run build'), runOptions: { runOn: 'worktreeCreated' } },
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.addTaskToSessions(makeTask('build', 'npm run build'), session, 'workspace', { runOn: 'default' });

		assert.deepStrictEqual(jsonEdits[0].values, [
			{ path: ['tasks', 0, 'inAgents'], value: true },
			{ path: ['tasks', 0, 'runOptions'], value: undefined },
		]);
	});

	// --- createAndAddTask ---

	test('createAndAddTask writes new task with inAgents: true', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('existing', 'echo hi'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.createAndAddTask(undefined, 'npm run dev', session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		const edit = jsonEdits[0];
		assert.strictEqual(edit.uri.toString(), worktreeTasksUri.toString());
		const tasksValue = edit.values.find(v => v.path[0] === 'tasks');
		assert.ok(tasksValue);
		const tasks = tasksValue!.value as ITaskEntry[];
		assert.strictEqual(tasks.length, 2);
		assert.strictEqual(tasks[1].label, 'npm run dev');
		assert.strictEqual(tasks[1].inAgents, true);
	});

	test('createAndAddTask writes to repository and does not commit when no worktree', async () => {
		const repoTasksUri = URI.parse('file:///repo/.vscode/tasks.json');
		fileContents.set(repoTasksUri.toString(), tasksJsonContent([
			makeTask('existing', 'echo hi'),
		]));

		const session = makeSession({ repository: repoUri });
		await service.createAndAddTask(undefined, 'npm run dev', session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		assert.strictEqual(jsonEdits[0].uri.toString(), repoTasksUri.toString());
		const tasksValue = jsonEdits[0].values.find(v => v.path[0] === 'tasks');
		assert.ok(tasksValue);
		const tasks = tasksValue!.value as ITaskEntry[];
		assert.strictEqual(tasks.length, 2);
		assert.strictEqual(tasks[1].label, 'npm run dev');
		assert.strictEqual(tasks[1].inAgents, true);
	});

	test('createAndAddTask writes worktreeCreated run option when requested', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.createAndAddTask(undefined, 'npm run dev', session, 'workspace', { runOn: 'worktreeCreated' });

		assert.strictEqual(jsonEdits.length, 1);
		const tasksValue = jsonEdits[0].values.find(v => v.path[0] === 'tasks');
		assert.ok(tasksValue);
		const tasks = tasksValue!.value as ITaskEntry[];
		assert.deepStrictEqual(tasks[0].runOptions, { runOn: 'worktreeCreated' });
	});

	test('createAndAddTask writes a custom label when provided', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.createAndAddTask('Start Dev Server', 'npm run dev', session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		const tasksValue = jsonEdits[0].values.find(v => v.path[0] === 'tasks');
		assert.ok(tasksValue);
		const tasks = tasksValue!.value as ITaskEntry[];
		assert.strictEqual(tasks[0].label, 'Start Dev Server');
		assert.strictEqual(tasks[0].command, 'npm run dev');
	});

	// --- removeTask ---

	test('removeTask deletes the matching task entry', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('test', 'npm test', true),
			makeTask('lint', 'npm run lint'),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.removeTask('test', session, 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		assert.deepStrictEqual(jsonEdits[0].values, [{
			path: ['tasks'],
			value: [
				makeTask('build', 'npm run build', true),
				{ label: 'lint', type: 'shell', command: 'npm run lint' },
			],
		}]);
	});

	// --- updateTask ---

	test('updateTask replaces an existing task in place', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('test', 'npm test', true),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.updateTask('test', {
			label: 'Test Changed',
			type: 'shell',
			command: 'pnpm test',
			inAgents: true,
			runOptions: { runOn: 'worktreeCreated' }
		}, session, 'workspace', 'workspace');

		assert.strictEqual(jsonEdits.length, 1);
		assert.deepStrictEqual(jsonEdits[0].values, [{
			path: ['tasks'],
			value: [
				makeTask('build', 'npm run build', true),
				{
					label: 'Test Changed',
					type: 'shell',
					command: 'pnpm test',
					inAgents: true,
					runOptions: { runOn: 'worktreeCreated' }
				}
			]
		}]);
	});

	test('updateTask moves a task between workspace and user storage', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
		]));
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userExisting', 'npm run user', true),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.updateTask('build', {
			label: 'Build Changed',
			type: 'shell',
			command: 'pnpm build',
			inAgents: true,
		}, session, 'workspace', 'user');

		assert.strictEqual(jsonEdits.length, 2);
		assert.deepStrictEqual(jsonEdits[0], {
			uri: worktreeTasksUri,
			values: [{
				path: ['tasks'],
				value: []
			}]
		});
		assert.deepStrictEqual(jsonEdits[1], {
			uri: userTasksUri,
			values: [
				{ path: ['version'], value: '2.0.0' },
				{
					path: ['tasks'],
					value: [
						makeTask('userExisting', 'npm run user', true),
						{
							label: 'Build Changed',
							type: 'shell',
							command: 'pnpm build',
							inAgents: true,
						}
					]
				}
			]
		});
	});

	// --- pinned task ---

	test('getPinnedTaskLabel returns undefined when no task is pinned', () => {
		const obs = service.getPinnedTaskLabel(repoUri);
		assert.strictEqual(obs.get(), undefined);
	});

	test('setPinnedTaskLabel stores and clears the pinned task label', () => {
		const obs = service.getPinnedTaskLabel(repoUri);

		service.setPinnedTaskLabel(repoUri, 'build');
		assert.strictEqual(obs.get(), 'build');

		service.setPinnedTaskLabel(repoUri, undefined);
		assert.strictEqual(obs.get(), undefined);
	});

	test('updateTask keeps the pinned task in sync when the label changes', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
		]));
		service.setPinnedTaskLabel(repoUri, 'build');

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.updateTask('build', {
			label: 'build:watch',
			type: 'shell',
			command: 'npm run watch',
			inAgents: true,
		}, session, 'workspace', 'workspace');

		assert.strictEqual(service.getPinnedTaskLabel(repoUri).get(), 'build:watch');
	});

	test('removeTask clears the pinned task when deleting the pinned entry', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
		]));
		service.setPinnedTaskLabel(repoUri, 'build');

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		await service.removeTask('build', session, 'workspace');

		assert.strictEqual(service.getPinnedTaskLabel(repoUri).get(), undefined);
	});

	// --- runTask ---

	test('runTask dispatches to the registered runner and fires onDidRunTask', async () => {
		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		let eventFired = false;
		const disposable = service.onDidRunTask(() => { eventFired = true; });

		const handle = await service.runTask(makeTask('build', 'npm run build'), session);
		disposable.dispose();

		assert.strictEqual(ranTasks.length, 1);
		assert.strictEqual(ranTasks[0].label, 'build');
		assert.ok(eventFired, 'onDidRunTask should fire');
		assert.ok(handle, 'runTask should return a stop handle');
		handle!.dispose();
		assert.strictEqual(terminateCalls.length, 1);
		assert.strictEqual(terminateCalls[0], 'build');
	});

	test('runTask returns undefined when no runner is registered', async () => {
		// Create a fresh service with an empty registry
		const emptyRegistry = new SessionTaskRunnerRegistry();
		store.add(emptyRegistry);
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override watch() { return { dispose() { } }; }
			override onDidFilesChange: any = () => ({ dispose() { } });
		});
		instantiationService.stub(IJSONEditingService, new class extends mock<IJSONEditingService>() { });
		instantiationService.stub(IPreferencesService, preferencesService);
		instantiationService.stub(ISessionTaskRunnerRegistry, emptyRegistry);
		instantiationService.stub(IStorageService, storageService);
		const emptyService = store.add(instantiationService.createInstance(SessionsTasksService));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const handle = await emptyService.runTask(makeTask('build', 'npm run build'), session);

		assert.strictEqual(handle, undefined);
		assert.strictEqual(ranTasks.length, 0);
	});

	test('runTask terminates the task when the returned handle is disposed', async () => {
		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const handle = await service.runTask(makeTask('watch', 'npm run watch'), session);

		assert.ok(handle);
		assert.strictEqual(terminateCalls.length, 0);
		handle!.dispose();
		assert.strictEqual(terminateCalls.length, 1);
		assert.strictEqual(terminateCalls[0], 'watch');
	});

	// --- getSessionTasksOnce / getAllTasks ---

	test('getSessionTasksOnce returns inAgents tasks from both workspace and user targets', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('lint', 'npm run lint', false),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userTask', 'npm run user', true),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const tasks = await service.getSessionTasksOnce(session);

		assert.deepStrictEqual(tasks.map(t => ({ label: t.task.label, target: t.target })), [
			{ label: 'build', target: 'workspace' },
			{ label: 'userTask', target: 'user' },
		]);
	});

	test('getSessionTasksOnce does not touch the shared sessionTasks observable', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([]));

		const sessionA = makeSession({ worktree: worktreeUri, repository: repoUri });
		const sessionB = makeSession({ worktree: URI.parse('file:///other-worktree'), repository: URI.parse('file:///other-repo') });

		// Populate the shared observable with session A's tasks
		service.getSessionTasks(sessionA);
		await new Promise(r => setTimeout(r, 10));

		// Call getSessionTasksOnce for session B — should not clobber the shared observable
		await service.getSessionTasksOnce(sessionB);

		assert.deepStrictEqual(service.getSessionTasks(sessionA).get().map(t => t.task.label), ['build']);
	});

	test('getAllTasks returns all tasks regardless of inAgents flag', async () => {
		const worktreeTasksUri = URI.parse('file:///worktree/.vscode/tasks.json');
		fileContents.set(worktreeTasksUri.toString(), tasksJsonContent([
			makeTask('build', 'npm run build', true),
			makeTask('lint', 'npm run lint', false),
		]));
		const userTasksUri = URI.from({ scheme: userSettingsUri.scheme, path: '/user/tasks.json' });
		fileContents.set(userTasksUri.toString(), tasksJsonContent([
			makeTask('userTask', 'npm run user', false),
		]));

		const session = makeSession({ worktree: worktreeUri, repository: repoUri });
		const tasks = await service.getAllTasks(session);

		assert.deepStrictEqual(tasks.map(t => t.task.label), ['build', 'lint', 'userTask']);
	});
});
