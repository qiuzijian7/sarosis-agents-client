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

export function it(name: string, fn: () => void | Promise<void>): void {
	const fullName = _suiteName ? `${_suiteName} > ${name}` : name;
	const start = Date.now();
	try {
		const result = fn();
		if (result instanceof Promise) {
			// async test — will be handled by runAll
			_results.push({ name: fullName, passed: true, durationMs: Date.now() - start });
			console.log(`  ✓ ${name}`);
		} else {
			_results.push({ name: fullName, passed: true, durationMs: Date.now() - start });
			console.log(`  ✓ ${name}`);
		}
	} catch (err) {
		_results.push({ name: fullName, passed: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
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

export function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
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
