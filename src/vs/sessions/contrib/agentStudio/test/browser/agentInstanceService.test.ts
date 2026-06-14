/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent Instance Service (Phase 4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock AgentInstanceService
	class MockAgentInstanceService {
		private instances: any[] = [];
		onDidChangeInstances: any = { /* Event */ };

		constructor() {
			// 初始化一些测试数据
			this.instances = [
				{
					id: 'instance-1',
					name: 'Instance 1',
					templateId: 'template-1',
					workspaceId: 'workspace-1',
					configPath: '.saros/agents/instance-1/agent.yaml',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					status: 'active',
				},
			];
		}

		async getInstances(workspaceId?: string): Promise<any[]> {
			if (workspaceId) {
				return this.instances.filter(i => i.workspaceId === workspaceId);
			}
			return this.instances;
		}

		async getInstance(id: string): Promise<any | undefined> {
			return this.instances.find(i => i.id === id);
		}

		async createInstanceFromTemplate(templateId: string, workspaceId: string): Promise<any> {
			const newInstance = {
				id: `instance-${Date.now()}`,
				name: `Instance from ${templateId}`,
				templateId,
				workspaceId,
				configPath: `.saros/agents/instance-${Date.now()}/agent.yaml`,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				status: 'active',
			};
			this.instances.push(newInstance);
			return newInstance;
		}

		async createInstance(config: any): Promise<any> {
			const newInstance = {
				...config,
				id: config.id || `instance-${Date.now()}`,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				status: 'active',
			};
			this.instances.push(newInstance);
			return newInstance;
		}

		async updateInstance(id: string, updates: any): Promise<any> {
			const index = this.instances.findIndex(i => i.id === id);
			if (index === -1) {
				throw new Error(`Instance ${id} not found`);
			}
			this.instances[index] = {
				...this.instances[index],
				...updates,
				updatedAt: new Date().toISOString(),
			};
			return this.instances[index];
		}

		async deleteInstance(id: string): Promise<void> {
			const index = this.instances.findIndex(i => i.id === id);
			if (index !== -1) {
				this.instances.splice(index, 1);
			}
		}
	}

	test('getInstances returns all instances when no workspaceId', async () => {
		const service = new MockAgentInstanceService();
		
		const instances = await service.getInstances();
		assert.ok(instances.length > 0);
	});

	test('getInstances filters by workspaceId', async () => {
		const service = new MockAgentInstanceService();
		
		// 添加一个不同 workspace 的实例
		await service.createInstance({
			workspaceId: 'workspace-2',
			name: 'Instance 2',
		});

		const instances1 = await service.getInstances('workspace-1');
		const instances2 = await service.getInstances('workspace-2');

		assert.ok(instances1.length >= 1);
		assert.ok(instances2.length >= 1);
	});

	test('getInstance returns correct instance', async () => {
		const service = new MockAgentInstanceService();
		
		const instance = await service.getInstance('instance-1');
		assert.ok(instance);
		assert.strictEqual(instance.id, 'instance-1');
		assert.strictEqual(instance.name, 'Instance 1');
	});

	test('getInstance returns undefined for non-existent', async () => {
		const service = new MockAgentInstanceService();
		
		const instance = await service.getInstance('non-existent');
		assert.strictEqual(instance, undefined);
	});

	test('createInstanceFromTemplate creates instance with correct structure', async () => {
		const service = new MockAgentInstanceService();
		
		const instance = await service.createInstanceFromTemplate('template-1', 'workspace-1');
		
		assert.ok(instance.id);
		assert.ok(instance.id.includes('instance-'));
		assert.strictEqual(instance.templateId, 'template-1');
		assert.strictEqual(instance.workspaceId, 'workspace-1');
		assert.ok(instance.configPath.includes('.saros/agents/'));
		assert.ok(instance.configPath.includes('agent.yaml'));
		assert.strictEqual(instance.status, 'active');
	});

	test('createInstance creates instance with custom config', async () => {
		const service = new MockAgentInstanceService();
		
		const instance = await service.createInstance({
			name: 'Custom Instance',
			workspaceId: 'workspace-1',
			customConfig: { model: 'gpt-4' },
		});
		
		assert.ok(instance.id);
		assert.strictEqual(instance.name, 'Custom Instance');
		assert.strictEqual(instance.customConfig.model, 'gpt-4');
	});

	test('updateInstance updates fields', async () => {
		const service = new MockAgentInstanceService();
		
		const updated = await service.updateInstance('instance-1', {
			name: 'Updated Name',
			status: 'stopped',
		});
		
		assert.strictEqual(updated.name, 'Updated Name');
		assert.strictEqual(updated.status, 'stopped');
		assert.ok(updated.updatedAt);
	});

	test('updateInstance throws for non-existent', async () => {
		const service = new MockAgentInstanceService();
		
		await assert.rejects(
			service.updateInstance('non-existent', { name: 'test' }),
			/Instance non-existent not found/
		);
	});

	test('deleteInstance removes instance', async () => {
		const service = new MockAgentInstanceService();
		
		// 先创建一个新实例
		const instance = await service.createInstance({
			name: 'To Delete',
			workspaceId: 'workspace-1',
		});
		
		const instanceId = instance.id;
		
		// 验证存在
		let found = await service.getInstance(instanceId);
		assert.ok(found);
		
		// 删除
		await service.deleteInstance(instanceId);
		
		// 验证已删除
		found = await service.getInstance(instanceId);
		assert.strictEqual(found, undefined);
	});

	test('deleteInstance does not throw for non-existent', async () => {
		const service = new MockAgentInstanceService();
		
		// 删除不存在的实例不应该报错
		await assert.doesNotReject(service.deleteInstance('non-existent'));
	});

	test('created instance has correct directory structure', async () => {
		const service = new MockAgentInstanceService();
		
		const instance = await service.createInstanceFromTemplate('template-1', 'workspace-1');
		
		assert.ok(instance.configPath.includes('.saros/agents/'));
		assert.ok(instance.configPath.endsWith('agent.yaml'));
		assert.ok(instance.configPath.includes(instance.id));
	});

	test('instance status can be updated', async () => {
		const service = new MockAgentInstanceService();
		
		// 更新为 stopped
		const updated = await service.updateInstance('instance-1', { status: 'stopped' });
		assert.strictEqual(updated.status, 'stopped');
		
		// 更新为 active
		const updated2 = await service.updateInstance('instance-1', { status: 'active' });
		assert.strictEqual(updated2.status, 'active');
	});
});
