/*---------------------------------------------------------------------------------------------
 *  多 Agent 并发测试 — 使用 ConcurrentLock + MeshCoordinator 验证多 Agent 场景。
 *  编译后: node out/__tests__/concurrency.test.js
 *--------------------------------------------------------------------------------------------*/
import { ConcurrentLock } from '../concurrentLock.js';
import { MeshCoordinator } from '../meshCoord.js';
import { describe, it, assert, assertEqual, itAsync, printSummary } from './testRunner.js';

export async function runConcurrencyTests(): Promise<void> {

describe('ConcurrentLock', () => {
	it('acquire and release', () => {
		const lock = new ConcurrentLock();
		const release = lock.tryAcquire('agent-1');
		assert(release !== null, 'acquired');
		assert(lock.isLocked('agent-1'), 'is locked');
		release!();
		assert(!lock.isLocked('agent-1'), 'released');
	});

	it('tryAcquire fails when locked', () => {
		const lock = new ConcurrentLock();
		const r1 = lock.tryAcquire('key');
		const r2 = lock.tryAcquire('key');
		assert(r1 !== null, 'first acquires');
		assertEqual(r2, null, 'second fails');
		r1!();
	});

	it('withLock serializes concurrent access', async () => {
		const lock = new ConcurrentLock();
		const order: string[] = [];

		const p1 = lock.withLock('agent', async () => {
			order.push('p1-start');
			await new Promise(r => setTimeout(r, 50));
			order.push('p1-end');
		});
		const p2 = lock.withLock('agent', async () => {
			order.push('p2-start');
			await new Promise(r => setTimeout(r, 10));
			order.push('p2-end');
		});

		await Promise.all([p1, p2]);
		// p1 should complete before p2 starts
		assertEqual(order[0], 'p1-start', 'p1 starts first');
		assertEqual(order[1], 'p1-end', 'p1 ends before p2 starts');
		assertEqual(order[2], 'p2-start', 'p2 starts after p1');
		assertEqual(order[3], 'p2-end', 'p2 ends last');
	});

	it('different keys run in parallel', async () => {
		const lock = new ConcurrentLock();
		let count = 0;
		let maxCount = 0;

		const task = (key: string) => lock.withLock(key, async () => {
			count++;
			maxCount = Math.max(maxCount, count);
			await new Promise(r => setTimeout(r, 30));
			count--;
		});

		await Promise.all([task('a'), task('b'), task('c')]);
		assert(maxCount >= 2, 'at least 2 ran in parallel');
	});

	it('timeout rejects', async () => {
		const lock = new ConcurrentLock();
		const r1 = lock.tryAcquire('key');
		assert(r1 !== null, 'first acquired');

		let timedOut = false;
		try {
			await lock.acquire('key', 50); // 50ms timeout
		} catch {
			timedOut = true;
		}
		assert(timedOut, 'second timed out');
		r1!();
	});

	it('stats track correctly', async () => {
		const lock = new ConcurrentLock();
		await lock.withLock('s', async () => { /* noop */ });
		await lock.withLock('s', async () => { /* noop */ });
		const stats = lock.getStats();
		assert(stats.totalAcquired >= 2, 'acquired >= 2');
		assert(stats.totalReleased >= 2, 'released >= 2');
	});

	it('forceRelease rejects waiters', async () => {
		const lock = new ConcurrentLock();
		const r1 = lock.tryAcquire('key');
		assert(r1 !== null, 'acquired');

		let rejected = false;
		lock.acquire('key', 5000).catch(() => { rejected = true; });

		// Give the acquire time to queue
		await new Promise(r => setTimeout(r, 10));
		lock.forceRelease('key');
		await new Promise(r => setTimeout(r, 10));
		assert(rejected, 'waiter was rejected');
	});

	it('clear rejects all waiters', async () => {
		const lock = new ConcurrentLock();
		lock.tryAcquire('a');
		lock.tryAcquire('b');

		let rejections = 0;
		lock.acquire('a', 5000).catch(() => rejections++);
		lock.acquire('b', 5000).catch(() => rejections++);

		await new Promise(r => setTimeout(r, 10));
		lock.clear();
		await new Promise(r => setTimeout(r, 10));
		assertEqual(rejections, 2, 'both rejected');
	});
});

describe('ConcurrentLock — Multi-Agent Simulation', () => {
	itAsync('10 agents writing concurrently — no data race', async () => {
		const lock = new ConcurrentLock();
		const results: number[] = [];
		const counters: number[] = new Array(10).fill(0);

		// Each agent has its OWN lock key → runs in parallel.
		// The test verifies: (1) no deadlock, (2) all agents complete.
		// Each agent writes to its own slot (no shared mutable state → no race).
		// A shared read-modify-write counter would race because these are
		// truly parallel (different lock keys); we avoid that by design.
		const agents = Array.from({ length: 10 }, (_, i) =>
			lock.withLock(`agent-${i}`, async () => {
				await new Promise(r => setTimeout(r, Math.random() * 20));
				counters[i] = i + 1;
				results.push(i);
			})
		);

		await Promise.all(agents);
		assertEqual(results.length, 10, 'all agents completed');
		// Each slot was written exactly once
		let total = 0;
		for (let i = 0; i < 10; i++) {
			assertEqual(counters[i], i + 1, `agent ${i} slot correct`);
			total += counters[i];
		}
		assertEqual(total, 55, 'all slots sum to 55 (1+2+...+10)');
	});

	itAsync('same agent — writes serialized', async () => {
		const lock = new ConcurrentLock();
		const writeOrder: number[] = [];

		// 5 concurrent writes to same agent — must be serialized
		const writes = Array.from({ length: 5 }, (_, i) =>
			lock.withLock('same-agent', async () => {
				writeOrder.push(i);
				await new Promise(r => setTimeout(r, 10));
			})
		);

		await Promise.all(writes);
		assertEqual(writeOrder.length, 5, 'all writes completed');
		// Serialized: order should be sequential (0,1,2,3,4)
		for (let i = 0; i < 5; i++) {
			assertEqual(writeOrder[i], i, `write ${i} in order`);
		}
	});
});

// ─── MeshCoordinator Tests ──────────────────────────────────────────────

describe('MeshCoordinator', () => {
	it('register and discover nodes', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('node-1', ['memory']);
		mesh.registerNode('node-2', ['search']);
		const nodes = mesh.discoverNodes();
		assertEqual(nodes.length, 2, '2 nodes discovered');
	});

	it('unregister node', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('node-1', []);
		mesh.unregisterNode('node-1');
		assertEqual(mesh.discoverNodes().length, 0, 'node removed');
	});

	it('heartbeat updates status', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('node-1', []);
		const ok = mesh.heartbeat('node-1');
		assert(ok, 'heartbeat returned true');
		const nodes = mesh.discoverNodes();
		const node = nodes.find(n => n.agentId === 'node-1');
		assert(node !== undefined, 'node exists');
	});

	it('distributeTask round-robin', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('n1', ['compute']);
		mesh.registerNode('n2', ['compute']);
		mesh.registerNode('n3', ['compute']);

		const dist1 = mesh.distributeTask('task-1', 'compute', 'round-robin');
		const dist2 = mesh.distributeTask('task-2', 'compute', 'round-robin');
		const dist3 = mesh.distributeTask('task-3', 'compute', 'round-robin');

		assert(dist1 !== null, 'dist1 assigned');
		assert(dist2 !== null, 'dist2 assigned');
		assert(dist3 !== null, 'dist3 assigned');
		// Round-robin should distribute to different nodes
		const assigned = new Set([dist1!.assignedTo, dist2!.assignedTo, dist3!.assignedTo]);
		assert(assigned.size >= 2, 'round-robin distributes to different nodes');
	});

	it('routeMessage', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('n1', []);
		const msg = mesh.routeMessage('external', 'n1', 'test data');
		assert(msg !== null, 'message routed');
		const messages = mesh.getMessages('n1');
		assert(messages.length > 0, 'message received');
	});

	it('getStats', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('n1', []);
		mesh.registerNode('n2', []);
		const stats = mesh.getStats();
		assert(stats.totalNodes === 2, 'stats show 2 nodes');
	});

	it('clear', () => {
		const mesh = new MeshCoordinator();
		mesh.registerNode('n1', []);
		mesh.clear();
		assertEqual(mesh.discoverNodes().length, 0, 'cleared');
	});
});

}

// Run if executed directly
if (require.main === module) {
	runConcurrencyTests().then(() => printSummary());
}
