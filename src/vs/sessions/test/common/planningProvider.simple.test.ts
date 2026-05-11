/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PlanningProvider } from '../../contrib/agentStudio/browser/providers/planning/planningProvider.js';
import { ILogService } from '../../../platform/log/common/log.js';

// Mock LogService
class MockLogService {
	public logs: string[] = [];

	debug(message: string): void {
		this.logs.push(message);
	}

	info(message: string): void {
		this.logs.push(message);
	}

	warn(message: string): void {
		this.logs.push(message);
	}

	error(message: string): void {
		this.logs.push(message);
	}

	reset(): void {
		this.logs = [];
	}
}

suite('PlanningProvider Simple Tests', () => {
	let planningProvider: PlanningProvider;
	let mockLogService: MockLogService;

	setup(() => {
		mockLogService = new MockLogService();
		planningProvider = new PlanningProvider(mockLogService as unknown as ILogService);
	});

	test('should have correct id', () => {
		assert.strictEqual(planningProvider.id, 'default-planning-provider');
	});

	test('should have correct name', () => {
		assert.strictEqual(planningProvider.name, 'Default Planning Provider');
	});

	test('analyzeIntent should return a valid IPlan object', async () => {
		const message = 'Create a new feature';
		const plan = await planningProvider.analyzeIntent(message);

		assert.strictEqual(typeof plan.id, 'string');
		assert.ok(plan.id.startsWith('plan-'));
		assert.strictEqual(typeof plan.intent, 'string');
		assert.ok(Array.isArray(plan.steps));
	});

	test('analyzeIntent should detect low complexity for fix keyword', async () => {
		const message = 'Fix the bug';
		const plan = await planningProvider.analyzeIntent(message);

		assert.strictEqual(plan.estimatedComplexity, 'low');
	});

	test('analyzeIntent should detect high complexity for refactor keyword', async () => {
		const message = 'Refactor the entire system';
		const plan = await planningProvider.analyzeIntent(message);

		assert.strictEqual(plan.estimatedComplexity, 'high');
	});

	test('decomposeTasks should return tasks', async () => {
		const plan = {
			id: 'test-plan',
			intent: 'Test intent',
			steps: [{ id: 'step-0', description: 'Step 1' }],
			estimatedComplexity: 'low' as const,
		};

		const tasks = await planningProvider.decomposeTasks(plan);
		assert.ok(Array.isArray(tasks));
		assert.ok(tasks.length > 0);
	});
});
