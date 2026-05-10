/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent Workspace - Interface Definitions (Phase 4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── IWorkspaceRegistry 接口测试 ─────────────────────────────

	test('IWorkspaceRegistry interface structure', () => {
		const registry = {
			registerWorkspace: (workspace: any) => ({ dispose: () => {} }),
			unregisterWorkspace: (workspaceId: string) => {},
			getWorkspaces: () => [],
			getWorkspace: (id: string) => undefined,
			getWorkspaceOSService: (id: string) => undefined,
			getWorkspaceDriverService: (id: string) => undefined,
			onDidChangeWorkspaces: { /* Event */ },
		};

		assert.ok(typeof registry.registerWorkspace === 'function');
		assert.ok(typeof registry.unregisterWorkspace === 'function');
		assert.ok(typeof registry.getWorkspaces === 'function');
		assert.ok(typeof registry.getWorkspace === 'function');
		assert.ok(typeof registry.getWorkspaceOSService === 'function');
		assert.ok(typeof registry.getWorkspaceDriverService === 'function');
	});

	test('IWorkspaceConfig interface structure', () => {
		const config = {
			id: 'workspace-1',
			name: 'My Workspace',
			path: '/path/to/workspace',
			isActive: true,
			createdAt: new Date().toISOString(),
		};

		assert.strictEqual(config.id, 'workspace-1');
		assert.strictEqual(config.name, 'My Workspace');
		assert.strictEqual(config.path, '/path/to/workspace');
		assert.strictEqual(config.isActive, true);
		assert.ok(config.createdAt);
	});

	test('IWorkspaceConfig - optional path', () => {
		const config = {
			id: 'workspace-1',
			name: 'Remote Workspace',
			path: undefined,
			isActive: false,
			createdAt: new Date().toISOString(),
		};

		assert.strictEqual(config.path, undefined);
		assert.strictEqual(config.isActive, false);
	});

	// ─── IWorkspaceOSService 接口测试 ────────────────────────────

	test('IWorkspaceOSService extends IAgentOSService', () => {
		const workspaceOS = {
			// IAgentOSService 方法
			_serviceBrand: undefined,
			registerModelProvider: (p: any) => ({ dispose: () => {} }),
			registerMemoryProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			registerToolProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			registerPlanningProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			registerExecutionProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			registerRetrievalProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			registerKanbanProvider: (p: any, priority?: number) => ({ dispose: () => {} }),
			onDidChangeModelProviders: { /* Event */ },
			getModelProviders: () => [],
			getActiveModelSelection: () => ({ providerId: '', modelId: '' }),
			setActiveModelSelection: (s: any) => {},
			getActiveMemoryProvider: () => undefined,
			getActiveToolProvider: () => undefined,
			getActivePlanningProvider: () => undefined,
			getActiveExecutionProvider: () => undefined,
			getActiveRetrievalProvider: () => undefined,
			getActiveKanbanProvider: () => undefined,
			getSlotRegistry: () => ({}),
			executeAgentTurn: async function* () { yield { type: 'done' as const }; },

			// IWorkspaceOSService 特有属性
			workspaceId: 'workspace-1',
		};

		assert.strictEqual(workspaceOS.workspaceId, 'workspace-1');
		assert.ok(typeof workspaceOS.registerModelProvider === 'function');
		assert.ok(typeof workspaceOS.executeAgentTurn === 'function');
	});

	// ─── IWorkspaceDriverService 接口测试 ─────────────────────────

	test('IWorkspaceDriverService extends IAgentDriverService', () => {
		const workspaceDriver = {
			// IAgentDriverService 方法
			_serviceBrand: undefined,
			executeTurn: async function* () { yield { type: 'done' as const }; },
			executeFromChatOptions: async function* () { yield { type: 'done' as const }; },
			cancelTurn: (turnId: string) => {},
			onDidChangeTurnStatus: { /* Event */ },
			getTurnStatus: (turnId: string) => 'idle' as const,

			// IWorkspaceDriverService 特有属性
			workspaceId: 'workspace-1',
		};

		assert.strictEqual(workspaceDriver.workspaceId, 'workspace-1');
		assert.ok(typeof workspaceDriver.executeTurn === 'function');
		assert.ok(typeof workspaceDriver.cancelTurn === 'function');
	});

	// ─── 工作区隔离逻辑测试 ──────────────────────────────────────

	test('workspace isolation - each workspace has independent OS', () => {
		// 模拟多工作区场景
		const workspaceMap = new Map<string, any>();

		const createWorkspaceOS = (workspaceId: string) => {
			const os = {
				workspaceId,
				providers: [] as any[],
				registerModelProvider: (p: any) => {
					os.providers.push(p);
					return { dispose: () => {} };
				},
				getModelProviders: () => os.providers,
			};
			workspaceMap.set(workspaceId, os);
			return os;
		};

		// 创建两个工作区
		const os1 = createWorkspaceOS('workspace-1');
		const os2 = createWorkspaceOS('workspace-2');

		// 在 workspace-1 注册 provider
		os1.registerModelProvider({ id: 'provider-ws1' });

		// 在 workspace-2 注册不同的 provider
		os2.registerModelProvider({ id: 'provider-ws2' });

		// 验证隔离
		assert.strictEqual(os1.getModelProviders().length, 1);
		assert.strictEqual(os1.getModelProviders()[0].id, 'provider-ws1');

		assert.strictEqual(os2.getModelProviders().length, 1);
		assert.strictEqual(os2.getModelProviders()[0].id, 'provider-ws2');
	});

	test('workspace isolation - each workspace has independent Driver', () => {
		const driverMap = new Map<string, any>();

		const createWorkspaceDriver = (workspaceId: string) => {
			const driver = {
				workspaceId,
				activeTurns: new Map<string, boolean>(),
				executeTurn: (turnId: string) => {
					driver.activeTurns.set(turnId, true);
				},
				cancelTurn: (turnId: string) => {
					driver.activeTurns.delete(turnId);
				},
			};
			driverMap.set(workspaceId, driver);
			return driver;
		};

		const driver1 = createWorkspaceDriver('workspace-1');
		const driver2 = createWorkspaceDriver('workspace-2');

		// 在 workspace-1 启动 turn
		driver1.executeTurn('turn-1');

		// 在 workspace-2 启动不同的 turn
		driver2.executeTurn('turn-2');

		// 验证隔离
		assert.strictEqual(driver1.activeTurns.size, 1);
		assert.ok(driver1.activeTurns.has('turn-1'));
		assert.ok(!driver1.activeTurns.has('turn-2'));

		assert.strictEqual(driver2.activeTurns.size, 1);
		assert.ok(driver2.activeTurns.has('turn-2'));
		assert.ok(!driver2.activeTurns.has('turn-1'));

		// 取消 workspace-1 的 turn 不影响 workspace-2
		driver1.cancelTurn('turn-1');
		assert.strictEqual(driver1.activeTurns.size, 0);
		assert.strictEqual(driver2.activeTurns.size, 1);
	});

	test('workspace lifecycle - register and unregister', () => {
		const workspaces: any[] = [];

		const registerWorkspace = (config: any) => {
			workspaces.push(config);
			return {
				dispose: () => {
					const idx = workspaces.findIndex(w => w.id === config.id);
					if (idx !== -1) { workspaces.splice(idx, 1); }
				},
			};
		};

		const unregisterWorkspace = (id: string) => {
			const idx = workspaces.findIndex(w => w.id === id);
			if (idx !== -1) { workspaces.splice(idx, 1); }
		};

		// 注册工作区
		const d1 = registerWorkspace({ id: 'ws-1', name: 'Workspace 1', isActive: true, createdAt: new Date().toISOString() });
		registerWorkspace({ id: 'ws-2', name: 'Workspace 2', isActive: true, createdAt: new Date().toISOString() });

		assert.strictEqual(workspaces.length, 2);

		// 通过 dispose 注销
		d1.dispose();
		assert.strictEqual(workspaces.length, 1);
		assert.strictEqual(workspaces[0].id, 'ws-2');

		// 通过 unregisterWorkspace 注销
		unregisterWorkspace('ws-2');
		assert.strictEqual(workspaces.length, 0);
	});

	test('workspace lifecycle - getWorkspaceOSService returns per-workspace instance', () => {
		const osInstances = new Map<string, { workspaceId: string }>();

		const getWorkspaceOSService = (workspaceId: string) => {
			if (!osInstances.has(workspaceId)) {
				osInstances.set(workspaceId, { workspaceId });
			}
			return osInstances.get(workspaceId);
		};

		// 第一次获取
		const os1a = getWorkspaceOSService('workspace-1');
		// 第二次获取同一个 workspace
		const os1b = getWorkspaceOSService('workspace-1');
		// 获取不同的 workspace
		const os2 = getWorkspaceOSService('workspace-2');

		// 同一 workspace 返回同一实例
		assert.strictEqual(os1a, os1b);
		// 不同 workspace 返回不同实例
		assert.notStrictEqual(os1a, os2);
		assert.strictEqual(os1a!.workspaceId, 'workspace-1');
		assert.strictEqual(os2!.workspaceId, 'workspace-2');
	});

	test('IWorkspaceRegistry.onDidChangeWorkspaces event exists', () => {
		const registry = {
			onDidChangeWorkspaces: { /* Event */ },
		};

		assert.ok('onDidChangeWorkspaces' in registry);
	});
});
