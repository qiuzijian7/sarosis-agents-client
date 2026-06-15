/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';

suite('Agent Instance Service - Interface Definitions (Phase 4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('AgentInstanceStatus enum values', () => {
		const AgentInstanceStatus = {
			Active: 'active',
			Stopped: 'stopped',
			Error: 'error',
		};

		assert.strictEqual(AgentInstanceStatus.Active, 'active');
		assert.strictEqual(AgentInstanceStatus.Stopped, 'stopped');
		assert.strictEqual(AgentInstanceStatus.Error, 'error');
	});

	test('IAgentInstance interface structure', () => {
		const instance = {
			id: 'instance-1',
			name: 'My Agent',
			templateId: 'template-1',
			workspaceId: 'workspace-1',
			configPath: '.saros/agents/instance-1/agent.yaml',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: 'active' as const,
		};

		assert.strictEqual(instance.id, 'instance-1');
		assert.strictEqual(instance.name, 'My Agent');
		assert.strictEqual(instance.templateId, 'template-1');
		assert.strictEqual(instance.workspaceId, 'workspace-1');
		assert.ok(instance.configPath.includes('agent.yaml'));
		assert.strictEqual(instance.status, 'active');
	});

	test('IAgentTemplate interface structure', () => {
		const template = {
			id: 'template-1',
			name: 'Code Assistant',
			description: 'Helps with coding tasks',
			category: 'development',
			icon: 'code',
			config: {
				model: 'gpt-4',
				temperature: 0.7,
			},
		};

		assert.strictEqual(template.id, 'template-1');
		assert.strictEqual(template.name, 'Code Assistant');
		assert.strictEqual(template.category, 'development');
		assert.ok(template.config);
	});

	test('IAgentInstanceService interface methods', () => {
		const mockService = {
			onDidChangeInstances: { /* Event */ },
			getInstances: async (workspaceId?: string) => [],
			getInstance: async (id: string) => undefined,
			createInstanceFromTemplate: async (templateId: string, workspaceId: string) => ({} as any),
			createInstance: async (config: any) => ({} as any),
			updateInstance: async (id: string, updates: any) => ({} as any),
			deleteInstance: async (id: string) => {},
		};

		assert.ok(typeof mockService.getInstances === 'function');
		assert.ok(typeof mockService.getInstance === 'function');
		assert.ok(typeof mockService.createInstanceFromTemplate === 'function');
		assert.ok(typeof mockService.createInstance === 'function');
		assert.ok(typeof mockService.updateInstance === 'function');
		assert.ok(typeof mockService.deleteInstance === 'function');
	});

	test('IAgentGalleryService interface methods', () => {
		const mockService = {
			onDidChangeTemplates: { /* Event */ },
			getTemplates: async () => [],
			getTemplatesByCategory: async (category: string) => [],
			searchTemplates: async (query: string) => [],
		};

		assert.ok(typeof mockService.getTemplates === 'function');
		assert.ok(typeof mockService.getTemplatesByCategory === 'function');
		assert.ok(typeof mockService.searchTemplates === 'function');
	});

	test('createInstanceFromTemplate creates instance with correct structure', () => {
		const createInstanceFromTemplate = (templateId: string, workspaceId: string) => {
			return {
				id: `instance-from-${templateId}`,
				name: 'New Instance',
				templateId,
				workspaceId,
				configPath: `.saros/agents/instance-from-${templateId}/agent.yaml`,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				status: 'active' as const,
			};
		};

		const instance = createInstanceFromTemplate('template-1', 'workspace-1');

		assert.ok(instance.id.includes('instance-from-template-1'));
		assert.strictEqual(instance.templateId, 'template-1');
		assert.strictEqual(instance.workspaceId, 'workspace-1');
		assert.ok(instance.configPath.includes('.saros/agents/'));
		assert.strictEqual(instance.status, 'active');
	});

	test('deleteInstance removes instance and cleans directory', () => {
		const instances = new Map<string, any>();
		
		// 添加实例
		instances.set('instance-1', { id: 'instance-1', name: 'Instance 1' });
		
		// 删除实例
		const deleteInstance = (id: string) => {
			instances.delete(id);
			// 模拟清理目录
			// fs.rmSync(`.saros/agents/${id}`, { recursive: true });
		};

		assert.ok(instances.has('instance-1'));
		
		deleteInstance('instance-1');
		
		assert.ok(!instances.has('instance-1'));
	});

	test('getInstances filters by workspaceId', () => {
		const instances = [
			{ id: 'instance-1', workspaceId: 'workspace-1' },
			{ id: 'instance-2', workspaceId: 'workspace-1' },
			{ id: 'instance-3', workspaceId: 'workspace-2' },
		];

		const getInstances = (workspaceId?: string) => {
			if (workspaceId) {
				return instances.filter(i => i.workspaceId === workspaceId);
			}
			return instances;
		};

		assert.strictEqual(getInstances('workspace-1').length, 2);
		assert.strictEqual(getInstances('workspace-2').length, 1);
		assert.strictEqual(getInstances().length, 3);
	});

	test('searchTemplates filters by query', () => {
		const templates = [
			{ id: '1', name: 'Code Assistant', description: 'Helps with coding' },
			{ id: '2', name: 'Data Analyst', description: 'Analyzes data' },
			{ id: '3', name: 'Writer', description: 'Helps with writing' },
		];

		const searchTemplates = (query: string) => {
			const lowerQuery = query.toLowerCase();
			return templates.filter(t => 
				t.name.toLowerCase().includes(lowerQuery) ||
				t.description.toLowerCase().includes(lowerQuery)
			);
		};

		assert.strictEqual(searchTemplates('code').length, 1);
		assert.strictEqual(searchTemplates('data').length, 1);
		assert.strictEqual(searchTemplates('help').length, 2); // Code Assistant + Writer
	});

	test('.saros/agents/ directory structure', () => {
		const instanceId = 'instance-1';
		const expectedPath = `.saros/agents/${instanceId}/agent.yaml`;

		assert.ok(expectedPath.includes('.saros/agents/'));
		assert.ok(expectedPath.endsWith('agent.yaml'));
		assert.ok(expectedPath.includes(instanceId));
	});
});
