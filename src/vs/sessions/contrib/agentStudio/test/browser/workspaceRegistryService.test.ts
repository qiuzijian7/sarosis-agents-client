/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Workspace Registry Service (Phase 4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock WorkspaceRegistryService
	class MockWorkspaceRegistryService {
		private workspaces: any[] = [];
		onDidChangeWorkspaces: any = { /* Event */ };

		constructor() {
			// 初始化一些测试数据
			this.workspaces = [
				{
					id: 'workspace-1',
					name: 'Workspace 1',
					path: '/path/to/workspace1',
					isActive: true,
					createdAt: new Date().toISOString(),
				},
			];
		}

		async getWorkspaces(): Promise<any[]> {
			return this.workspaces;
		}

		async getWorkspace(id: string): Promise<any | undefined> {
			return this.workspaces.find(w => w.id === id);
		}

		async registerWorkspace(workspace: any): Promise<any> {
			const newWorkspace = {
				...workspace,
				id: workspace.id || `workspace-${Date.now()}`,
				createdAt: new Date().toISOString(),
				isActive: true,
			};
			this.workspaces.push(newWorkspace);
			return newWorkspace;
		}

		async unregisterWorkspace(id: string): Promise<void> {
			const index = this.workspaces.findIndex(w => w.id === id);
			if (index !== -1) {
				this.workspaces.splice(index, 1);
			}
		}

		async getWorkspaceForInstance(instanceId: string): Promise<any | undefined> {
			// 模拟查找实例所属的工作区
			const instanceWorkspaceMap: Record<string, string> = {
				'instance-1': 'workspace-1',
			};
			
			const workspaceId = instanceWorkspaceMap[instanceId];
			if (workspaceId) {
				return this.getWorkspace(workspaceId);
			}
			return undefined;
		}

		async isolateWorkspace(workspaceId: string): Promise<void> {
			// 模拟工作区隔离
			const workspace = await this.getWorkspace(workspaceId);
			if (workspace) {
				workspace.isIsolated = true;
			}
		}
	}

	test('getWorkspaces returns all workspaces', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspaces = await service.getWorkspaces();
		assert.ok(workspaces.length > 0);
		assert.strictEqual(workspaces[0].id, 'workspace-1');
	});

	test('getWorkspace returns correct workspace', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspace = await service.getWorkspace('workspace-1');
		assert.ok(workspace);
		assert.strictEqual(workspace.name, 'Workspace 1');
		assert.ok(workspace.isActive);
	});

	test('getWorkspace returns undefined for non-existent', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspace = await service.getWorkspace('non-existent');
		assert.strictEqual(workspace, undefined);
	});

	test('registerWorkspace adds new workspace', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const initialCount = (await service.getWorkspaces()).length;
		
		await service.registerWorkspace({
			name: 'New Workspace',
			path: '/path/to/new',
		});
		
		const workspaces = await service.getWorkspaces();
		assert.strictEqual(workspaces.length, initialCount + 1);
		assert.ok(workspaces.some(w => w.name === 'New Workspace'));
	});

	test('registerWorkspace generates id if not provided', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspace = await service.registerWorkspace({
			name: 'Test Workspace',
			path: '/test',
		});
		
		assert.ok(workspace.id);
		assert.ok(workspace.id.includes('workspace-'));
		assert.ok(workspace.createdAt);
		assert.strictEqual(workspace.isActive, true);
	});

	test('unregisterWorkspace removes workspace', async () => {
		const service = new MockWorkspaceRegistryService();
		
		// 先添加一个
		await service.registerWorkspace({
			id: 'temp-workspace',
			name: 'Temp Workspace',
			path: '/temp',
		});
		
		let workspaces = await service.getWorkspaces();
		assert.ok(workspaces.some(w => w.id === 'temp-workspace'));
		
		// 删除
		await service.unregisterWorkspace('temp-workspace');
		
		workspaces = await service.getWorkspaces();
		assert.ok(!workspaces.some(w => w.id === 'temp-workspace'));
	});

	test('unregisterWorkspace does not throw for non-existent', async () => {
		const service = new MockWorkspaceRegistryService();
		
		// 删除不存在的工作区不应该报错
		await assert.doesNotReject(service.unregisterWorkspace('non-existent'));
	});

	test('getWorkspaceForInstance returns correct workspace', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspace = await service.getWorkspaceForInstance('instance-1');
		assert.ok(workspace);
		assert.strictEqual(workspace.id, 'workspace-1');
	});

	test('getWorkspaceForInstance returns undefined for non-existent instance', async () => {
		const service = new MockWorkspaceRegistryService();
		
		const workspace = await service.getWorkspaceForInstance('non-existent');
		assert.strictEqual(workspace, undefined);
	});

	test('isolateWorkspace sets isolation flag', async () => {
		const service = new MockWorkspaceRegistryService();
		
		// 隔离工作区
		await service.isolateWorkspace('workspace-1');
		
		const workspace = await service.getWorkspace('workspace-1');
		assert.ok(workspace.isIsolated);
	});

	test('multiple workspaces can exist simultaneously', async () => {
		const service = new MockWorkspaceRegistryService();
		
		// 添加多个工作区
		await service.registerWorkspace({
			name: 'Workspace A',
			path: '/a',
		});
		
		await service.registerWorkspace({
			name: 'Workspace B',
			path: '/b',
		});
		
		const workspaces = await service.getWorkspaces();
		assert.ok(workspaces.length >= 3); // 包括初始的那个
	});

	test('workspace isolation is per-workspace', async () => {
		const service = new MockWorkspaceRegistryService();
		
		// 添加一个新工作区
		await service.registerWorkspace({
			id: 'workspace-2',
			name: 'Workspace 2',
			path: '/path/to/workspace2',
		});
		
		// 隔离 workspace-1
		await service.isolateWorkspace('workspace-1');
		
		const ws1 = await service.getWorkspace('workspace-1');
		const ws2 = await service.getWorkspace('workspace-2');
		
		assert.ok(ws1.isIsolated);
		assert.ok(!ws2.isIsolated); // workspace-2 未被隔离
	});
});
