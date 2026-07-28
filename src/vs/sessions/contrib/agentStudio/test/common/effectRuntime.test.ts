/*---------------------------------------------------------------------------------------------
 *  Tests for the Effect-TS-model runtime primitives (effectRuntime.ts):
 *  Deferred settle-once, Scope structured cleanup, InterruptSignal cooperative
 *  cancellation, Fiber lifecycle (join/exit/interrupt, sticky interruption,
 *  supervision), and the timeout / sleep / retry / forEachPar combinators.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	Deferred,
	Scope,
	InterruptSignal,
	FiberInterrupt,
	isFiberInterrupt,
	fork,
	sleep,
	timeout,
	retry,
	forEachPar,
} from '../../common/effectRuntime.js';

suite('effectRuntime — Deferred', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('succeed settles exactly once (settle-once semantics)', async () => {
		const d = new Deferred<number>();
		assert.strictEqual(d.isSettled, false);
		assert.strictEqual(d.succeed(42), true, 'first settle must win');
		assert.strictEqual(d.succeed(99), false, 'second succeed must be rejected');
		assert.strictEqual(d.fail(new Error('late')), false, 'fail after succeed must be rejected');
		assert.strictEqual(d.isSettled, true);
		assert.strictEqual(await d.promise, 42);
	});

	test('fail rejects the promise with the error', async () => {
		const d = new Deferred<number>();
		const boom = new Error('boom');
		assert.strictEqual(d.fail(boom), true);
		await assert.rejects(d.promise, (e: Error) => e === boom);
	});
});

suite('effectRuntime — Scope', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('finalizers run LIFO on close', async () => {
		const scope = new Scope();
		const order: string[] = [];
		scope.addFinalizer(() => { order.push('first'); });
		scope.addFinalizer(() => { order.push('second'); });
		scope.addFinalizer(() => { order.push('third'); });
		await scope.close();
		assert.deepStrictEqual(order, ['third', 'second', 'first'], 'finalizers must run in reverse registration order');
	});

	test('close is idempotent and swallows finalizer errors', async () => {
		const scope = new Scope();
		let ran = 0;
		scope.addFinalizer(() => { ran++; throw new Error('finalizer boom'); });
		await scope.close();
		await scope.close();
		assert.strictEqual(ran, 1, 'finalizer must run exactly once despite double close');
		assert.strictEqual(scope.isClosed, true);
	});

	test('addFinalizer after close throws', async () => {
		const scope = new Scope();
		await scope.close();
		assert.throws(() => scope.addFinalizer(() => { }), /closed scope/);
	});

	test('child scopes close before the parent (cascade)', async () => {
		const parent = new Scope();
		const child = parent.child();
		const order: string[] = [];
		child.addFinalizer(() => { order.push('child'); });
		parent.addFinalizer(() => { order.push('parent'); });
		await parent.close();
		assert.deepStrictEqual(order, ['child', 'parent'], 'child finalizers must run before the parent\'s');
		assert.strictEqual(child.isClosed, true);
	});

	test('child() of a closed scope throws', async () => {
		const scope = new Scope();
		await scope.close();
		assert.throws(() => scope.child(), /closed scope/);
	});

	test('use() closes the child scope on success AND on error', async () => {
		const parent = new Scope();
		let closedOnSuccess = false;
		await parent.use(async (child) => {
			child.addFinalizer(() => { closedOnSuccess = true; });
		});
		assert.strictEqual(closedOnSuccess, true);

		let closedOnError = false;
		await assert.rejects(
			parent.use(async (child) => {
				child.addFinalizer(() => { closedOnError = true; });
				throw new Error('use boom');
			}),
			/use boom/,
		);
		assert.strictEqual(closedOnError, true, 'child scope must close even when fn throws');
	});
});

suite('effectRuntime — InterruptSignal', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('first interrupt wins; listeners receive the reason', () => {
		const sig = new InterruptSignal();
		const seen: string[] = [];
		sig.onInterrupt((r) => seen.push(r));
		assert.strictEqual(sig.interrupt('user'), true);
		assert.strictEqual(sig.interrupt('parent'), false, 'second interrupt must be a no-op');
		assert.strictEqual(sig.interrupted, true);
		assert.strictEqual(sig.reason, 'user');
		assert.deepStrictEqual(seen, ['user']);
	});

	test('throwIfInterrupted throws FiberInterrupt with the reason', () => {
		const sig = new InterruptSignal();
		sig.throwIfInterrupted(); // must not throw before interruption
		sig.interrupt('stall');
		assert.throws(() => sig.throwIfInterrupted(), (e: unknown) => isFiberInterrupt(e) && e.reason === 'stall');
	});

	test('listener registered after interruption fires immediately', () => {
		const sig = new InterruptSignal();
		sig.interrupt('user');
		const seen: string[] = [];
		const unlink = sig.onInterrupt((r) => seen.push(r));
		assert.deepStrictEqual(seen, ['user'], 'late listener must fire immediately (sticky interruption)');
		assert.doesNotThrow(() => unlink());
	});

	test('linkAbortSignal bridges a pre-aborted signal immediately', () => {
		const sig = new InterruptSignal();
		const controller = new AbortController();
		controller.abort();
		sig.linkAbortSignal(controller.signal, 'parent');
		assert.strictEqual(sig.interrupted, true);
		assert.strictEqual(sig.reason, 'parent');
	});

	test('linkAbortSignal bridges live abort; unlink stops propagation', () => {
		const sig = new InterruptSignal();
		const controller = new AbortController();
		const unlink = sig.linkAbortSignal(controller.signal, 'parent');
		controller.abort();
		assert.strictEqual(sig.interrupted, true);
		assert.strictEqual(sig.reason, 'parent');

		// Unlinked signals must not propagate.
		const sig2 = new InterruptSignal();
		const controller2 = new AbortController();
		const unlink2 = sig2.linkAbortSignal(controller2.signal, 'parent');
		unlink2();
		controller2.abort();
		assert.strictEqual(sig2.interrupted, false);
		assert.strictEqual(typeof unlink, 'function');
	});
});

suite('effectRuntime — Fiber', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('join returns the task value; status transitions to done', async () => {
		const fiber = fork(async () => 7);
		assert.strictEqual(await fiber.join(), 7);
		const exit = await fiber.exit;
		assert.strictEqual(exit._tag, 'success');
		assert.strictEqual(fiber.status, 'done');
	});

	test('task failure propagates via join and exit', async () => {
		const boom = new Error('task boom');
		const fiber = fork(async () => { throw boom; });
		await assert.rejects(fiber.join(), (e: Error) => e === boom);
		const exit = await fiber.exit;
		assert.strictEqual(exit._tag, 'failure');
		assert.strictEqual(fiber.status, 'failed');
	});

	test('interrupt unwinds at an interruption point; finalizers run before exit settles', async () => {
		const order: string[] = [];
		const fiber = fork(async (ctx) => {
			ctx.scope.addFinalizer(() => { order.push('finalizer'); });
			while (!ctx.signal.interrupted) {
				await sleep(5);
			}
			ctx.signal.throwIfInterrupted();
			return 'unreachable';
		});
		setTimeout(() => { order.push('interrupt-call'); void fiber.interrupt('user'); }, 10);
		const exit = await fiber.exit;
		assert.strictEqual(exit._tag, 'interrupt');
		if (exit._tag === 'interrupt') {
			assert.strictEqual(exit.reason, 'user');
		}
		assert.deepStrictEqual(order, ['interrupt-call', 'finalizer'], 'scope finalizer must run before the exit settles');
		assert.strictEqual(fiber.status, 'interrupted');
		await assert.rejects(fiber.join(), (e: unknown) => isFiberInterrupt(e));
	});

	test('sticky interruption wins over a normally produced value', async () => {
		const fiber = fork(async (ctx) => {
			ctx.signal.interrupt('user'); // interrupt lands while the task is finishing
			return 'late value';
		});
		const exit = await fiber.exit;
		assert.strictEqual(exit._tag, 'interrupt', 'interruption must win over a produced value (Effect semantics)');
	});

	test('pre-interrupted external signal: task still starts, unwinds at first interruption point', async () => {
		const sig = new InterruptSignal();
		sig.interrupt('user');
		let started = false;
		const fiber = fork(async (ctx) => {
			started = true;
			ctx.signal.throwIfInterrupted();
			return 'unreachable';
		}, { signal: sig });
		const exit = await fiber.exit;
		assert.strictEqual(started, true, 'task must start even when pre-interrupted (start-then-cancel order)');
		assert.strictEqual(exit._tag, 'interrupt');
	});

	test('closing the parent scope interrupts the child fiber (supervision)', async () => {
		const parent = new Scope();
		const fiber = fork(async (ctx) => {
			while (!ctx.signal.interrupted) {
				await sleep(5);
			}
			ctx.signal.throwIfInterrupted();
			return 'unreachable';
		}, { parentScope: parent });
		setTimeout(() => { void parent.close(); }, 10);
		const exit = await fiber.exit;
		assert.strictEqual(exit._tag, 'interrupt');
		if (exit._tag === 'interrupt') {
			assert.strictEqual(exit.reason, 'parent');
		}
	});
});

suite('effectRuntime — combinators (sleep / timeout / retry / forEachPar)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sleep resolves after the delay', async () => {
		const t0 = Date.now();
		await sleep(20);
		assert.ok(Date.now() - t0 >= 15, 'sleep must wait roughly the requested delay');
	});

	test('sleep rejects with FiberInterrupt when the signal fires', async () => {
		const sig = new InterruptSignal();
		setTimeout(() => sig.interrupt('user'), 5);
		await assert.rejects(sleep(5000, sig), (e: unknown) => isFiberInterrupt(e) && e.reason === 'user');
	});

	test('timeout passes through a fast promise and clears the timer', async () => {
		const result = await timeout(Promise.resolve('fast'), 1000, () => new Error('must not fire'));
		assert.strictEqual(result, 'fast');
		// A cleared timer keeps no event-loop handle — if it leaked, the mocha
		// process would stay alive past the run (the runner force-exits anyway,
		// but the 1s timer would delay it noticeably).
	});

	test('timeout rejects with the timeout error on a slow promise', async () => {
		await assert.rejects(
			timeout(sleep(5000), 20, () => new Error('too slow')),
			/too slow/,
		);
	});

	test('timeout rejects with FiberInterrupt when the signal fires mid-wait', async () => {
		const sig = new InterruptSignal();
		setTimeout(() => sig.interrupt('parent'), 5);
		await assert.rejects(
			timeout(sleep(5000), 60_000, () => new Error('must not fire'), sig),
			(e: unknown) => isFiberInterrupt(e) && e.reason === 'parent',
		);
	});

	test('retry succeeds after a transient failure', async () => {
		let calls = 0;
		const result = await retry(async () => {
			calls++;
			if (calls === 1) { throw new Error('transient'); }
			return 'ok';
		}, { times: 1 });
		assert.strictEqual(result, 'ok');
		assert.strictEqual(calls, 2);
	});

	test('retry respects shouldRetry=false (no re-invocation)', async () => {
		let calls = 0;
		await assert.rejects(
			retry(async () => { calls++; throw new Error('fatal'); }, { times: 3, shouldRetry: () => false }),
			/fatal/,
		);
		assert.strictEqual(calls, 1, 'shouldRetry=false must prevent any re-invocation');
	});

	test('retry exhausts attempts and throws the last error; onRetry sees attempt numbers', async () => {
		let calls = 0;
		const retryAttempts: number[] = [];
		await assert.rejects(
			retry(async () => { calls++; throw new Error(`boom-${calls}`); }, { times: 2, onRetry: (_e, attempt) => retryAttempts.push(attempt) }),
			/boom-3/,
		);
		assert.strictEqual(calls, 3, '1 initial + 2 retries');
		assert.deepStrictEqual(retryAttempts, [1, 2]);
	});

	test('forEachPar preserves order and isolates failures (allSettled semantics)', async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await forEachPar(items, 2, async (n) => {
			await sleep(5);
			if (n === 3) { throw new Error('three boom'); }
			return n * 10;
		});
		assert.strictEqual(results.length, 5);
		assert.deepStrictEqual(
			results.map(r => (r.status === 'fulfilled' ? r.value : `rejected:${(r.reason as Error).message}`)),
			[10, 20, 'rejected:three boom', 40, 50],
			'results must preserve input order; one failure must not abort the rest',
		);
	});

	test('forEachPar never exceeds the concurrency bound (rolling window)', async () => {
		let active = 0;
		let maxActive = 0;
		const items = Array.from({ length: 10 }, (_, i) => i);
		await forEachPar(items, 3, async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		});
		assert.ok(maxActive <= 3, `concurrency must be capped at 3 (observed ${maxActive})`);
		assert.ok(maxActive >= 2, 'tasks must actually run in parallel');
	});

	test('forEachPar on an empty array resolves to an empty result set', async () => {
		const results = await forEachPar([], 3, async () => 'never');
		assert.deepStrictEqual(results, []);
	});

	test('FiberInterrupt carries _tag for structural checks', () => {
		const e = new FiberInterrupt('timeout');
		assert.strictEqual(e._tag, 'FiberInterrupt');
		assert.strictEqual(e.reason, 'timeout');
		assert.ok(isFiberInterrupt(e));
		assert.ok(!isFiberInterrupt(new Error('plain')));
	});
});
