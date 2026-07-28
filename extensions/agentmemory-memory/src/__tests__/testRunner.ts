/*---------------------------------------------------------------------------------------------
 *  轻量测试运行器 — 零外部依赖，适用于 agentmemory-memory 扩展。
 *  用法: node out/__tests__/testRunner.js
 *--------------------------------------------------------------------------------------------*/

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	durationMs: number;
}

const _results: TestResult[] = [];
let _suiteName = '';

export function describe(name: string, fn: () => void): void {
	_suiteName = name;
	console.log(`\n── ${name} ──`);
	fn();
	_suiteName = '';
}

const _pending: Promise<void>[] = [];

export function it(name: string, fn: () => void | Promise<void>): void {
	const fullName = _suiteName ? `${_suiteName} > ${name}` : name;
	const start = Date.now();
	let result: void | Promise<void>;
	try {
		result = fn();
	} catch (err) {
		_results.push({ name: fullName, passed: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (result instanceof Promise) {
		// async test：不再乐观标记 passed——登记 promise，落定后记录真实结果，
		// 由 drainAsync() 统一等待（否则 rejection 会以 unhandledRejection 随机爆进程）。
		_pending.push(result.then(() => {
			_results.push({ name: fullName, passed: true, durationMs: Date.now() - start });
			console.log(`  ✓ ${name}`);
		}).catch((err) => {
			_results.push({ name: fullName, passed: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
			console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
		}));
		return;
	}
	_results.push({ name: fullName, passed: true, durationMs: Date.now() - start });
	console.log(`  ✓ ${name}`);
}

/** 等待所有 async it 落定。runAllTests 须在 printSummary() 之前调用，否则异步结果不计入且进程可能被浮动 rejection 打断。 */
export async function drainAsync(): Promise<void> {
	while (_pending.length > 0) {
		await Promise.all(_pending.splice(0));
	}
}

export async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
	const fullName = _suiteName ? `${_suiteName} > ${name}` : name;
	const start = Date.now();
	try {
		await fn();
		_results.push({ name: fullName, passed: true, durationMs: Date.now() - start });
		console.log(`  ✓ ${name}`);
	} catch (err) {
		_results.push({ name: fullName, passed: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function assert(condition: boolean, message: string = 'assertion failed'): void {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string = 'assertEqual failed'): void {
	if (actual !== expected) {
		throw new Error(`Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
	}
}

export function assertApprox(actual: number, expected: number, tolerance: number, message: string): void {
	if (Math.abs(actual - expected) > tolerance) {
		throw new Error(`Assertion failed: ${message}\n  expected: ${expected} (±${tolerance})\n  actual:   ${actual}`);
	}
}

export function getResults(): TestResult[] { return _results; }

export function printSummary(): void {
	const passed = _results.filter(r => r.passed).length;
	const failed = _results.filter(r => !r.passed).length;
	const totalMs = _results.reduce((sum, r) => sum + r.durationMs, 0);
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`  Results: ${passed} passed, ${failed} failed, ${_results.length} total (${totalMs}ms)`);
	if (failed > 0) {
		console.log(`\n  Failed tests:`);
		for (const r of _results.filter(r => !r.passed)) {
			console.log(`    ✗ ${r.name}: ${r.error}`);
		}
	}
	console.log(`${'═'.repeat(60)}`);
	process.exit(failed > 0 ? 1 : 0);
}
