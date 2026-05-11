/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PlanningProvider } from '../../contrib/agentStudio/browser/providers/planning/planningProvider.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IPlan } from '../../contrib/agentStudio/common/providers.js';

// Mock LogService
class MockLogService implements Partial<ILogService> {
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

suite('PlanningProvider Tests', () => {
	let planningProvider: PlanningProvider;
	let mockLogService: MockLogService;

	setup(() => {
		mockLogService = new MockLogService();
		planningProvider = new PlanningProvider(mockLogService as unknown as ILogService);
	});

	teardown(() => {
		mockLogService.reset();
	});

	// ==================== analyzeIntent 测试 ====================

	suite('analyzeIntent', () => {
		test('should return a valid IPlan object', async () => {
			const message = 'Create a new feature';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(typeof plan.id, 'string');
			assert.ok(plan.id.startsWith('plan-'));
			assert.strictEqual(plan.intent, 'Create a new feature');
			assert.ok(Array.isArray(plan.steps));
			assert.ok(['low', 'medium', 'high'].includes(plan.estimatedComplexity!));
		});

		test('should extract intent from first sentence', async () => {
			const message = 'Fix the bug. Then add tests. Finally deploy.';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.intent, 'Fix the bug');
		});

		test('should handle Chinese punctuation for intent extraction', async () => {
			const message = '修复这个错误。然后添加测试。';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.intent, '修复这个错误');
		});

		test('should truncate intent longer than 100 characters', async () => {
			const message = 'A'.repeat(150);
			const plan = await planningProvider.analyzeIntent(message);

			assert.ok(plan.intent.endsWith('...'));
			assert.ok(plan.intent.length <= 103); // 100 + '...'
		});

		test('should detect high complexity for refactor keyword', async () => {
			const message = 'We need to refactor the entire authentication system';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'high');
			assert.strictEqual(plan.steps.length, 5); // High complexity has 5 steps
		});

		test('should detect high complexity for restructure keyword', async () => {
			const message = 'Restructure the database schema';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'high');
		});

		test('should detect high complexity for migrate keyword', async () => {
			const message = 'Migrate from v1 to v2 API';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'high');
		});

		test('should detect high complexity for redesign keyword', async () => {
			const message = 'Redesign the user interface';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'high');
		});

		test('should detect high complexity for overhaul keyword', async () => {
			const message = 'Overhaul the payment processing system';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'high');
		});

		test('should detect medium complexity for implement keyword', async () => {
			const message = 'Implement a new dashboard';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
			assert.strictEqual(plan.steps.length, 3); // Medium complexity has 3 steps
		});

		test('should detect medium complexity for create keyword', async () => {
			const message = 'Create a new user profile page';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
		});

		test('should detect medium complexity for build keyword', async () => {
			const message = 'Build a REST API for the service';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
		});

		test('should detect medium complexity for develop keyword', async () => {
			const message = 'Develop a mobile application';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
		});

		test('should detect medium complexity for integrate keyword', async () => {
			const message = 'Integrate with third-party payment gateway';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
		});

		test('should detect low complexity for fix keyword', async () => {
			const message = 'Fix the typo in the README';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
			assert.strictEqual(plan.steps.length, 1); // Low complexity has 1 step
		});

		test('should detect low complexity for update keyword', async () => {
			const message = 'Update the dependencies';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should detect low complexity for add keyword', async () => {
			const message = 'Add a new button to the toolbar';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should detect low complexity for change keyword', async () => {
			const message = 'Change the color scheme';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should detect low complexity for modify keyword', async () => {
			const message = 'Modify the configuration file';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should detect low complexity for remove keyword', async () => {
			const message = 'Remove deprecated code';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should estimate medium complexity for long messages (>200 chars)', async () => {
			const message = 'A'.repeat(201);
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'medium');
		});

		test('should estimate low complexity for short messages (<200 chars) with no keywords', async () => {
			const message = 'Hello world';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should generate correct steps for high complexity', async () => {
			const message = 'Refactor the codebase';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.steps.length, 5);
			assert.strictEqual(plan.steps[0].description, 'Analyze requirements and constraints');
			assert.strictEqual(plan.steps[1].description, 'Design the solution approach');
			assert.strictEqual(plan.steps[2].description, 'Implement core functionality');
			assert.strictEqual(plan.steps[3].description, 'Handle edge cases and error scenarios');
			assert.strictEqual(plan.steps[4].description, 'Test and verify the implementation');
		});

		test('should generate correct steps for medium complexity', async () => {
			const message = 'Implement new feature';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.steps.length, 3);
			assert.strictEqual(plan.steps[0].description, 'Analyze requirements');
			assert.strictEqual(plan.steps[1].description, 'Implement the solution');
			assert.strictEqual(plan.steps[2].description, 'Verify the result');
		});

		test('should generate correct steps for low complexity', async () => {
			const message = 'Fix the bug';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.steps.length, 1);
			assert.ok(plan.steps[0].description.startsWith('Execute:'));
		});

		test('should log debug message when called', async () => {
			const message = 'Test message';
			await planningProvider.analyzeIntent(message);

			assert.ok(mockLogService.logs.some(log => log.includes('[PlanningProvider] analyzeIntent called')));
		});

		test('should handle empty message', async () => {
			const message = '';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.intent, '');
			assert.ok(plan.estimatedComplexity);
		});

		test('should handle message with only whitespace', async () => {
			const message = '   ';
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.intent.trim(), '');
		});

		test('should handle keyword case insensitivity', async () => {
			const message = 'FIX the bug';  // uppercase
			const plan = await planningProvider.analyzeIntent(message);

			assert.strictEqual(plan.estimatedComplexity, 'low');
		});

		test('should prioritize high complexity keywords over medium and low', async () => {
			// Message contains both high and medium keywords
			const message = 'Refactor and implement new feature';
			const plan = await planningProvider.analyzeIntent(message);

			// High complexity keywords are checked first
			assert.strictEqual(plan.estimatedComplexity, 'high');
		});
	});

	// ==================== decomposeTasks 测试 ====================

	suite('decomposeTasks', () => {
		test('should return tasks with correct structure', async () => {
			const plan: IPlan = {
				id: 'test-plan',
				intent: 'Test intent',
				steps: [{ id: 'step-0', description: 'Step 1' }],
				estimatedComplexity: 'low',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.ok(Array.isArray(tasks));
			assert.ok(tasks.length > 0);
			assert.strictEqual(typeof tasks[0].id, 'string');
			assert.strictEqual(typeof tasks[0].description, 'string');
			assert.strictEqual(tasks[0].status, 'pending');
		});

		test('should create one task when plan has no steps', async () => {
			const plan: IPlan = {
				id: 'test-plan',
				intent: 'Test intent',
				steps: [],
				estimatedComplexity: 'low',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks.length, 1);
			assert.strictEqual(tasks[0].description, 'Test intent');
			assert.strictEqual(tasks[0].status, 'pending');
		});

		test('should create task for each step', async () => {
			const plan: IPlan = {
				id: 'test-plan',
				intent: 'Test intent',
				steps: [
					{ id: 'step-0', description: 'Step 1' },
					{ id: 'step-1', description: 'Step 2' },
					{ id: 'step-2', description: 'Step 3' },
				],
				estimatedComplexity: 'medium',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks.length, 3);
		});

		test('should generate correct task IDs based on plan ID', async () => {
			const plan: IPlan = {
				id: 'my-plan',
				intent: 'Test',
				steps: [
					{ id: 'step-0', description: 'Step 1' },
					{ id: 'step-1', description: 'Step 2' },
				],
				estimatedComplexity: 'low',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks[0].id, 'my-plan-task-0');
			assert.strictEqual(tasks[1].id, 'my-plan-task-1');
		});

		test('should set dependencies for tasks after the first', async () => {
			const plan: IPlan = {
				id: 'plan',
				intent: 'Test',
				steps: [
					{ id: 'step-0', description: 'Step 1' },
					{ id: 'step-1', description: 'Step 2' },
					{ id: 'step-2', description: 'Step 3' },
				],
				estimatedComplexity: 'medium',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks[0].dependencies, undefined);
			assert.deepStrictEqual(tasks[1].dependencies, ['plan-task-0']);
			assert.deepStrictEqual(tasks[2].dependencies, ['plan-task-1']);
		});

		test('should set all tasks status to pending', async () => {
			const plan: IPlan = {
				id: 'plan',
				intent: 'Test',
				steps: [
					{ id: 'step-0', description: 'Step 1' },
					{ id: 'step-1', description: 'Step 2' },
				],
				estimatedComplexity: 'low',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks[0].status, 'pending');
			assert.strictEqual(tasks[1].status, 'pending');
		});

		test('should use step descriptions as task descriptions', async () => {
			const plan: IPlan = {
				id: 'plan',
				intent: 'Test',
				steps: [
					{ id: 'step-0', description: 'Analyze requirements' },
					{ id: 'step-1', description: 'Implement solution' },
				],
				estimatedComplexity: 'medium',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks[0].description, 'Analyze requirements');
			assert.strictEqual(tasks[1].description, 'Implement solution');
		});

		test('should log debug message when called', async () => {
			const plan: IPlan = {
				id: 'plan',
				intent: 'Test',
				steps: [],
				estimatedComplexity: 'low',
			};

			await planningProvider.decomposeTasks(plan);

			assert.ok(mockLogService.logs.some(log => log.includes('[PlanningProvider] decomposeTasks called')));
		});

		test('should handle plan with single step', async () => {
			const plan: IPlan = {
				id: 'plan',
				intent: 'Test',
				steps: [{ id: 'step-0', description: 'Only step' }],
				estimatedComplexity: 'low',
			};

			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(tasks.length, 1);
			assert.strictEqual(tasks[0].dependencies, undefined);
		});
	});

	// ==================== Provider 属性测试 ====================

	suite('Provider Properties', () => {
		test('should have correct id', () => {
			assert.strictEqual(planningProvider.id, 'default-planning-provider');
		});

		test('should have correct name', () => {
			assert.strictEqual(planningProvider.name, 'Default Planning Provider');
		});
	});

	// ==================== 集成测试 ====================

	suite('Integration', () => {
		test('should analyze intent and decompose tasks in sequence', async () => {
			const message = 'Fix the login bug';
			const plan = await planningProvider.analyzeIntent(message);
			const tasks = await planningProvider.decomposeTasks(plan);

			assert.ok(plan.id);
			assert.ok(plan.intent);
			assert.ok(plan.steps.length > 0);
			assert.ok(tasks.length > 0);
			assert.strictEqual(tasks[0].status, 'pending');
		});

		test('should handle high complexity workflow', async () => {
			const message = 'Refactor the entire authentication system';
			const plan = await planningProvider.analyzeIntent(message);
			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(plan.estimatedComplexity, 'high');
			assert.strictEqual(plan.steps.length, 5);
			assert.strictEqual(tasks.length, 5);
		});

		test('should handle low complexity workflow', async () => {
			const message = 'Fix typo';
			const plan = await planningProvider.analyzeIntent(message);
			const tasks = await planningProvider.decomposeTasks(plan);

			assert.strictEqual(plan.estimatedComplexity, 'low');
			assert.strictEqual(plan.steps.length, 1);
			assert.strictEqual(tasks.length, 1);
		});
	});
});
