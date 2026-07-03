/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionTaskRunner, SessionTaskRunnerRegistry } from '../../browser/sessionTaskRunner.js';
import { ITaskEntry } from '../../browser/sessionsTasksService.js';

function makeMockRunner(id: string, priority: number, canRun: boolean, ran: string[]): ISessionTaskRunner {
	return {
		id,
		priority,
		canRun: () => canRun,
		runTask: async (task: ITaskEntry) => {
			ran.push(`${id}:${task.label}`);
			return undefined;
		}
	};
}

function makeMockSession(): ISession {
	return new class extends mock<ISession>() { };
}

suite('SessionTaskRunnerRegistry', () => {

	const store = new DisposableStore();

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('getRunner returns undefined when no runners registered', () => {
		const registry = new SessionTaskRunnerRegistry();
		const session = makeMockSession();
		assert.strictEqual(registry.getRunner(session), undefined);
	});

	test('getRunner returns the single registered runner', () => {
		const registry = new SessionTaskRunnerRegistry();
		const ran: string[] = [];
		const runner = makeMockRunner('a', 0, true, ran);
		store.add(registry.register(runner));

		const session = makeMockSession();
		assert.strictEqual(registry.getRunner(session), runner);
	});

	test('getRunner returns the highest-priority runner', () => {
		const registry = new SessionTaskRunnerRegistry();
		const ran: string[] = [];
		const low = makeMockRunner('low', 0, true, ran);
		const high = makeMockRunner('high', 100, true, ran);
		store.add(registry.register(low));
		store.add(registry.register(high));

		const session = makeMockSession();
		assert.strictEqual(registry.getRunner(session), high);
	});

	test('getRunner prefers later registration at equal priority', () => {
		const registry = new SessionTaskRunnerRegistry();
		const ran: string[] = [];
		const first = makeMockRunner('first', 0, true, ran);
		const second = makeMockRunner('second', 0, true, ran);
		store.add(registry.register(first));
		store.add(registry.register(second));

		const session = makeMockSession();
		assert.strictEqual(registry.getRunner(session), second);
	});

	test('getRunner skips runners whose canRun returns false', () => {
		const registry = new SessionTaskRunnerRegistry();
		const ran: string[] = [];
		const noRun = makeMockRunner('no', 100, false, ran);
		const yes = makeMockRunner('yes', 0, true, ran);
		store.add(registry.register(noRun));
		store.add(registry.register(yes));

		const session = makeMockSession();
		assert.strictEqual(registry.getRunner(session), yes);
	});

	test('register returns a disposable that removes the runner', () => {
		const registry = new SessionTaskRunnerRegistry();
		const ran: string[] = [];
		const runner = makeMockRunner('a', 0, true, ran);
		const disposable = registry.register(runner);

		const session = makeMockSession();
		assert.ok(registry.getRunner(session));

		disposable.dispose();
		assert.strictEqual(registry.getRunner(session), undefined);
	});
});
