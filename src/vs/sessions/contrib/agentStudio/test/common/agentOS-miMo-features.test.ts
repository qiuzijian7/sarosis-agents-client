/*---------------------------------------------------------------------------------------------
 *  MiMo-Code-inspired features — pure logic unit tests
 *
 *  Covers the 5 landing features ported from MiMo-Code's sub-agent architecture:
 *  1. hardPermission (invariant tool lock, e.g. plan mode) — toolPermission
 *  2. Completion Gate + structured output contract — completionGate
 *  3. Stall watchdog (idle timeout) — stallWatchdog
 *  4. preStop/postStop ReAct hook (bounded self-verification) — subAgentHooks
 *  5. Fork prefix cache (frozen system+tools fingerprint) — forkContext
 *
 *  All modules are dependency-free → no live model / provider needed.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	isToolHardDenied,
	applyHardPermission,
	planModeHardPermission,
} from '../../common/toolPermission.js';
import {
	gateResult,
	parseStructuredResultMarker,
	extractAcceptanceCriteria,
} from '../../common/completionGate.js';
import { StallWatchdog } from '../../common/stallWatchdog.js';
import {
	defaultPostStopDecision,
	DEFAULT_VERIFY_PROMPT,
} from '../../common/subAgentHooks.js';
import {
	buildForkContext,
	prefixCacheAligned,
} from '../../common/forkContext.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. hardPermission
// ─────────────────────────────────────────────────────────────────────────────
suite('hardPermission (MiMo invariant tool lock)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tools = [
		{ name: 'read', description: 'r' },
		{ name: 'write', description: 'w' },
		{ name: 'edit_file', description: 'e' },
		{ name: 'terminal_cmd', description: 't' },
		{ name: 'search_code', description: 's' },
	];

	test('isToolHardDenied matches exact + prefix patterns', () => {
		const p = planModeHardPermission();
		assert.strictEqual(isToolHardDenied('write', p), true);
		assert.strictEqual(isToolHardDenied('edit_file', p), true);
		assert.strictEqual(isToolHardDenied('terminal_cmd', p), true);
		assert.strictEqual(isToolHardDenied('read', p), false);
		assert.strictEqual(isToolHardDenied('search_code', p), false);
	});

	test('isToolHardDenied returns false when no policy', () => {
		assert.strictEqual(isToolHardDenied('write', undefined), false);
		assert.strictEqual(isToolHardDenied('write', { deniedToolPatterns: [] }), false);
	});

	test('applyHardPermission strips denied tools after other filtering', () => {
		const p = planModeHardPermission();
		const kept = applyHardPermission(tools, p);
		assert.deepStrictEqual(kept.map((t) => t.name), ['read', 'search_code']);
	});

	test('applyHardPermission never mutates input', () => {
		const p = planModeHardPermission();
		const before = tools.map((t) => t.name);
		applyHardPermission(tools, p);
		assert.deepStrictEqual(tools.map((t) => t.name), before);
	});

	test('applyHardPermission is a no-op without policy', () => {
		assert.strictEqual(applyHardPermission(tools, undefined).length, tools.length);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Completion Gate + structured output contract
// ─────────────────────────────────────────────────────────────────────────────
suite('Completion Gate (MiMo TaskGate)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseStructuredResultMarker reads status + summary', () => {
		assert.deepStrictEqual(parseStructuredResultMarker('<result status="success" summary="all good">'), {
			status: 'success',
			summary: 'all good',
		});
		assert.deepStrictEqual(parseStructuredResultMarker('<result status="failed">'), {
			status: 'failed',
			summary: undefined,
		});
		assert.strictEqual(parseStructuredResultMarker('just plain text'), undefined);
	});

	test('extractAcceptanceCriteria pulls the ACCEPTANCE bullet list', () => {
		const task = 'GOAL: fix bug\nACCEPTANCE: - verifies the login flow\n- writes the migration file\nCONTEXT:';
		assert.deepStrictEqual(extractAcceptanceCriteria(task), ['verifies the login flow', 'writes the migration file']);
	});

	test('extractAcceptanceCriteria returns [] when no clause', () => {
		assert.deepStrictEqual(extractAcceptanceCriteria('just do it'), []);
	});

	test('clean completion with no error/truncation → success', () => {
		const r = gateResult('done', { filesTouched: [], errored: false, truncated: false });
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.acceptanceMet, true);
	});

	test('errored → failed regardless of self-report', () => {
		const r = gateResult('<result status="success">', { filesTouched: [], errored: true, truncated: false });
		assert.strictEqual(r.status, 'failed');
		assert.strictEqual(r.acceptanceMet, false);
	});

	test('truncation downgrades success → partial', () => {
		const r = gateResult('<result status="success">', { filesTouched: [], errored: false, truncated: true });
		assert.strictEqual(r.status, 'partial');
	});

	test('no marker + truncation → partial', () => {
		const r = gateResult('ran out of budget', { filesTouched: [], errored: false, truncated: true });
		assert.strictEqual(r.status, 'partial');
	});

	test('acceptance implies file change but none touched → partial', () => {
		const r = gateResult('finished', {
			filesTouched: [],
			errored: false,
			truncated: false,
			acceptanceCriteria: ['writes the migration file'],
		});
		assert.strictEqual(r.status, 'partial');
	});

	test('acceptance implies file change and files touched → success', () => {
		const r = gateResult('finished', {
			filesTouched: ['a.ts'],
			errored: false,
			truncated: false,
			acceptanceCriteria: ['writes a.ts'],
		});
		assert.strictEqual(r.status, 'success');
	});

	test('model self-report partial is preserved', () => {
		const r = gateResult('<result status="partial" summary="mostly">', { filesTouched: [], errored: false, truncated: false });
		assert.strictEqual(r.status, 'partial');
		assert.strictEqual(r.summary, 'mostly');
	});

	test('marker failed → failed', () => {
		const r = gateResult('<result status="failed">', { filesTouched: [], errored: false, truncated: false });
		assert.strictEqual(r.status, 'failed');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stall watchdog
// ─────────────────────────────────────────────────────────────────────────────
suite('Stall watchdog (MiMo T40)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fires onStall once idle exceeds threshold, then re-arms', () => {
		let now = 1000;
		let fired = 0;
		const w = new StallWatchdog({ idleTimeoutMs: 1000, now: () => now, onStall: () => { fired++; } });
		try {
			now = 1500; w.pump();            // idle 500 < 1000 → no fire
			assert.strictEqual(fired, 0);
			now = 2500; w.pump();            // idle 1500 ≥ 1000 → fire (re-arms lastActivity=2500)
			assert.strictEqual(fired, 1);
			now = 2600; w.pump();            // idle 100 < 1000 → no fire
			assert.strictEqual(fired, 1);
		} finally {
			w.dispose();
		}
	});

	test('tick resets the idle clock', () => {
		let now = 1000;
		let fired = 0;
		const w = new StallWatchdog({ idleTimeoutMs: 1000, now: () => now, onStall: () => { fired++; } });
		try {
			now = 1500; w.tick();            // reset lastActivity → 1500
			now = 2000; w.pump();            // idle 500 < 1000 → no fire
			assert.strictEqual(fired, 0);
			now = 2600; w.pump();            // idle 1100 ≥ 1000 → fire
			assert.strictEqual(fired, 1);
		} finally {
			w.dispose();
		}
	});

	test('dispose stops further firing', () => {
		let now = 1000;
		let fired = 0;
		const w = new StallWatchdog({ idleTimeoutMs: 1000, now: () => now, onStall: () => { fired++; } });
		w.dispose();
		now = 5000; w.pump();
		assert.strictEqual(fired, 0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. postStop ReAct hook (bounded self-verification)
// ─────────────────────────────────────────────────────────────────────────────
suite('postStop ReAct hook (MiMo preStop/postStop)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('clean success-with-acceptance never re-verifies', () => {
		const d = defaultPostStopDecision({ structured: { status: 'success', acceptanceMet: true } as any }, 0, 1);
		assert.strictEqual(d.kind, 'return');
	});

	test('non-success at round 0 → retry with verify prompt', () => {
		const d = defaultPostStopDecision({ structured: { status: 'partial', acceptanceMet: false } as any }, 0, 1);
		assert.strictEqual(d.kind, 'retry');
		assert.strictEqual((d as any).followUpMessage, DEFAULT_VERIFY_PROMPT);
	});

	test('round >= maxRounds → return (bounded, no infinite loop)', () => {
		const d = defaultPostStopDecision({ structured: { status: 'partial', acceptanceMet: false } as any }, 1, 1);
		assert.strictEqual(d.kind, 'return');
	});

	test('undefined structured → retry', () => {
		const d = defaultPostStopDecision({}, 0, 1);
		assert.strictEqual(d.kind, 'retry');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fork prefix cache
// ─────────────────────────────────────────────────────────────────────────────
suite('Fork prefix cache (MiMo ForkContext)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const toolsA = [
		{ name: 'read', description: 'read file', inputSchema: { type: 'object' } },
		{ name: 'write', description: 'write file', inputSchema: { type: 'object' } },
	];
	const system = 'You are a coder.';

	test('buildForkContext is order-independent (sorting)', () => {
		const a = buildForkContext(system, toolsA);
		const b = buildForkContext(system, [...toolsA].reverse());
		assert.strictEqual(a.toolsFingerprint, b.toolsFingerprint);
		assert.strictEqual(a.tools[0].name, 'read');
	});

	test('different system prompt → different fingerprint', () => {
		const a = buildForkContext('prompt one', toolsA);
		const b = buildForkContext('prompt two', toolsA);
		assert.notStrictEqual(a.toolsFingerprint, b.toolsFingerprint);
	});

	test('prefixCacheAligned true when child reuses parent frozen prefix', () => {
		const parent = buildForkContext(system, toolsA);
		const child = buildForkContext(system, toolsA);
		assert.strictEqual(prefixCacheAligned(parent, child.systemPrompt, child.tools), true);
	});

	test('prefixCacheAligned false when no parent', () => {
		const child = buildForkContext(system, toolsA);
		assert.strictEqual(prefixCacheAligned(undefined, child.systemPrompt, child.tools), false);
	});

	test('prefixCacheAligned false when child system differs', () => {
		const parent = buildForkContext(system, toolsA);
		const child = buildForkContext('different', toolsA);
		assert.strictEqual(prefixCacheAligned(parent, child.systemPrompt, child.tools), false);
	});
});
