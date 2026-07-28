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
import {
	decideTaskGate,
	buildTaskGateReentryText,
	MAX_TASK_GATE_SUBAGENT_REACT,
	MAX_TASK_GATE_MAIN_REACT,
} from '../../common/taskGate.js';
import { StallWatchdog } from '../../common/stallWatchdog.js';
import {
	defaultPostStopDecision,
	DEFAULT_VERIFY_PROMPT,
} from '../../common/subAgentHooks.js';
import {
	buildForkContext,
	prefixCacheAligned,
} from '../../common/forkContext.js';
import { coerceToolArgs, coerceOrReject } from '../../browser/toolCallUtils.js';
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
// 2b. Completion Gate — DB-truth downgrade (P2d, MiMo TaskGate alignment)
// ─────────────────────────────────────────────────────────────────────────────
suite('Completion Gate — incompleteTasks DB-truth downgrade (P2d)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('self-reported success with incomplete tasks → partial (DB truth wins)', () => {
		const r = gateResult('<result status="success">', {
			filesTouched: ['a.ts'],
			errored: false,
			truncated: false,
			incompleteTasks: ['T1', 'T2'],
		});
		assert.strictEqual(r.status, 'partial');
		assert.strictEqual(r.acceptanceMet, false);
		assert.ok(r.reason.includes('2 incomplete task(s)'), 'reason must cite the DB-truth downgrade');
	});

	test('marker-less clean success with incomplete tasks → partial', () => {
		const r = gateResult('done', {
			filesTouched: ['a.ts'],
			errored: false,
			truncated: false,
			incompleteTasks: ['T1'],
		});
		assert.strictEqual(r.status, 'partial', 'DB truth must downgrade even a marker-less clean success');
	});

	test('partial with incomplete tasks stays partial (no double-downgrade to blocked)', () => {
		const r = gateResult('<result status="partial">', {
			filesTouched: [],
			errored: false,
			truncated: false,
			incompleteTasks: ['T1'],
		});
		assert.strictEqual(r.status, 'partial', 'incompleteTasks must not push partial → blocked');
	});

	test('failed with incomplete tasks stays failed (no upgrade)', () => {
		const r = gateResult('<result status="failed">', {
			filesTouched: [],
			errored: false,
			truncated: false,
			incompleteTasks: ['T1'],
		});
		assert.strictEqual(r.status, 'failed', 'DB truth must never upgrade a failed status');
	});

	test('empty incompleteTasks does not downgrade a clean success', () => {
		const r = gateResult('<result status="success">', {
			filesTouched: ['a.ts'],
			errored: false,
			truncated: false,
			incompleteTasks: [],
		});
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.acceptanceMet, true);
	});

	test('undefined incompleteTasks (caller did not query DB) preserves current behavior', () => {
		const r = gateResult('<result status="success">', {
			filesTouched: ['a.ts'],
			errored: false,
			truncated: false,
		});
		assert.strictEqual(r.status, 'success', 'absence of DB query must not change the verdict');
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. TaskGate — DB-truth completion gate (P2d, MiMo-Code task/gate.ts port)
// ─────────────────────────────────────────────────────────────────────────────
// Pure decision: incomplete task list + reactCount + maxReact + mode → one of
// three branches (empty / nudge / cap-exceeded). Mirrors MiMo-Code's
// TaskGate.decide but without Effect/DB so it is fully unit-testable.
suite('TaskGate — DB-truth decide (P2d, MiMo port)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tasks = [
		{ id: 'T1', status: 'running', summary: 'wire up the gate' },
		{ id: 'T2', status: 'todo', summary: 'add tests' },
	];

	test('empty incomplete list → clean stop, no re-entry, no cap', () => {
		const d = decideTaskGate({ incompleteTasks: [], reactCount: 0, maxReact: 2, mode: 'subagent' });
		assert.strictEqual(d.needReentry, false);
		assert.strictEqual(d.capExceeded, false);
		assert.deepStrictEqual(d.incompleteTasks, []);
	});

	test('non-empty under cap → re-entry with reminder text', () => {
		const d = decideTaskGate({ incompleteTasks: tasks, reactCount: 0, maxReact: 2, mode: 'subagent' });
		assert.strictEqual(d.needReentry, true);
		assert.strictEqual(d.capExceeded, false);
		assert.deepStrictEqual(d.incompleteTasks, ['T1', 'T2']);
		assert.ok((d as any).reentryText.includes('<system-reminder>'), 're-entry text must be a system-reminder');
		assert.ok((d as any).reentryText.includes('T1'), 're-entry text must list the incomplete task ids');
	});

	test('reactCount === maxReact → cap exceeded, forced stop', () => {
		const d = decideTaskGate({ incompleteTasks: tasks, reactCount: 2, maxReact: 2, mode: 'subagent' });
		assert.strictEqual(d.needReentry, false);
		assert.strictEqual(d.capExceeded, true);
		assert.deepStrictEqual(d.incompleteTasks, ['T1', 'T2']);
	});

	test('reactCount > maxReact → cap exceeded (defense-in-depth)', () => {
		const d = decideTaskGate({ incompleteTasks: tasks, reactCount: 5, maxReact: 2, mode: 'subagent' });
		assert.strictEqual(d.capExceeded, true);
	});

	test('subagent mode headline says "you own"', () => {
		const text = buildTaskGateReentryText(tasks, 'subagent');
		assert.ok(text.includes('you own are still unfinished'), 'subagent mode must say "you own"');
		assert.ok(text.includes('**Status**/**Summary** header'), 'subagent mode must reference the structured header');
	});

	test('main mode headline says "in this session"', () => {
		const text = buildTaskGateReentryText(tasks, 'main');
		assert.ok(text.includes('in this session are still unfinished'), 'main mode must say "in this session"');
		assert.ok(!text.includes('you own'), 'main mode must NOT say "you own" (list may span orphaned tasks)');
	});

	test('caps match MiMo-Code constants', () => {
		assert.strictEqual(MAX_TASK_GATE_SUBAGENT_REACT, 2);
		assert.strictEqual(MAX_TASK_GATE_MAIN_REACT, 3);
		assert.ok(MAX_TASK_GATE_MAIN_REACT > MAX_TASK_GATE_SUBAGENT_REACT, 'main cap must exceed subagent cap');
	});

	test('decision is pure (same input → same output, no mutation)', () => {
		const input = { incompleteTasks: tasks, reactCount: 0, maxReact: 2, mode: 'subagent' as const };
		const d1 = decideTaskGate(input);
		const d2 = decideTaskGate(input);
		assert.deepStrictEqual(d1, d2, 'decideTaskGate must be deterministic');
		// input not mutated
		assert.strictEqual(input.incompleteTasks.length, 2, 'input must not be mutated');
		assert.strictEqual(input.reactCount, 0, 'input must not be mutated');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Argument coercion & repair (P2a, zero-dependency self-heal)
// ─────────────────────────────────────────────────────────────────────────────
// 对齐 MiMo-Code task.ts 的 recoverTaskArgs（zod discriminatedUnion + 自愈），
// 但零依赖：coerceToolArgs 增强 enum/oneOf/嵌套递归 + coerceOrReject 统一入口。
suite('Argument coercion & repair (P2a zero-dependency)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('enum: out-of-range value downgrades to first legal value', () => {
		const schema = { properties: { mode: { type: 'string', enum: ['read', 'write'] } } };
		const result = coerceToolArgs({ mode: 'execute' }, schema);
		assert.strictEqual(result.mode, 'read', 'out-of-range enum value must downgrade to enum[0]');
	});

	test('enum: legal value is preserved', () => {
		const schema = { properties: { mode: { type: 'string', enum: ['read', 'write'] } } };
		const result = coerceToolArgs({ mode: 'write' }, schema);
		assert.strictEqual(result.mode, 'write');
	});

	test('enum: empty enum array does not downgrade', () => {
		const schema = { properties: { mode: { type: 'string', enum: [] } } };
		const result = coerceToolArgs({ mode: 'execute' }, schema);
		assert.strictEqual(result.mode, 'execute', 'empty enum must not trigger downgrade');
	});

	test('oneOf: takes first branch schema for coercion', () => {
		const schema = {
			properties: {
				count: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
			},
		};
		const result = coerceToolArgs({ count: '42' }, schema);
		assert.strictEqual(result.count, 42, 'oneOf first branch (integer) must coerce "42" -> 42');
	});

	test('anyOf: takes first branch schema for coercion', () => {
		const schema = {
			properties: {
				flag: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
			},
		};
		const result = coerceToolArgs({ flag: 'true' }, schema);
		assert.strictEqual(result.flag, true, 'anyOf first branch (boolean) must coerce "true" -> true');
	});

	test('nested object: recursively coerces child fields', () => {
		const schema = {
			properties: {
				config: {
					type: 'object',
					properties: {
						timeout: { type: 'integer' },
						enabled: { type: 'boolean' },
					},
				},
			},
		};
		const result = coerceToolArgs({ config: { timeout: '30', enabled: 'true' } }, schema);
		assert.strictEqual((result.config as any).timeout, 30, 'nested timeout must coerce "30" -> 30');
		assert.strictEqual((result.config as any).enabled, true, 'nested enabled must coerce "true" -> true');
	});

	test('nested object: non-object value is left untouched (no crash)', () => {
		const schema = {
			properties: {
				config: { type: 'object', properties: { x: { type: 'integer' } } },
			},
		};
		const result = coerceToolArgs({ config: 'not-an-object' }, schema);
		assert.strictEqual(result.config, 'not-an-object', 'non-object value with nested schema must not crash');
	});

	test('coerceOrReject: missing required -> reject result', () => {
		const schema = { required: ['path'], properties: { path: { type: 'string' } } };
		const logs: string[] = [];
		const r = coerceOrReject({}, schema, 'read_file', { warn: (m) => logs.push(m), info: (m) => logs.push(m) });
		assert.ok(r.reject, 'missing required must produce a reject');
		assert.ok(r.reject!.content.error.includes('path'), 'reject error must name the missing field');
		assert.ok(logs.some((l) => l.includes('rejected early')), 'must log the early rejection');
	});

	test('coerceOrReject: no schema -> passthrough, no reject', () => {
		const r = coerceOrReject({ foo: 'bar' }, undefined, 'any', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined);
		assert.strictEqual(r.args.foo, 'bar');
	});

	test('coerceOrReject: valid args with coercion -> coerced, no reject', () => {
		const schema = { properties: { count: { type: 'integer' } } };
		const r = coerceOrReject({ count: '42' }, schema, 'tool', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined);
		assert.strictEqual(r.args.count, 42, 'coercion must still apply when no reject');
	});

	test('coerceOrReject: required satisfied by documented alias -> no reject', () => {
		// search_code-style: `query` required, `pattern` documented as its alias.
		const schema = {
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Search pattern.' },
				pattern: { type: 'string', description: 'Alias for query.' },
			},
		};
		const r = coerceOrReject({ pattern: 'FooBar' }, schema, 'search_code', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined, 'supplying the documented alias must satisfy the required field');
	});

	test('coerceOrReject: required satisfied by backtick-wrapped alias -> no reject', () => {
		// search_files-style: `pattern` required, `query` documents "Alias for `pattern`".
		const schema = {
			required: ['pattern'],
			properties: {
				pattern: { type: 'string', description: 'REQUIRED. The actual text to find.' },
				query: { type: 'string', description: 'Alias for `pattern` — the search term.' },
			},
		};
		const r = coerceOrReject({ query: 'parseConfig' }, schema, 'search_files', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined, 'backtick-wrapped alias must also satisfy the required field');
	});

	test('coerceOrReject: required missing with neither canonical nor alias -> reject', () => {
		const schema = {
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Search pattern.' },
				pattern: { type: 'string', description: 'Alias for query.' },
			},
		};
		const r = coerceOrReject({ mode: 'files' }, schema, 'search_code', { warn: () => {}, info: () => {} });
		assert.ok(r.reject, 'missing both canonical and alias must still reject');
		assert.ok(r.reject!.content.error.includes('query'), 'reject must name the canonical required field');
	});

	test('coerceOrReject: canonical-side alias doc satisfies required (P2 — alias property removed)', () => {
		// New schema shape after P2: the standalone `pattern` property is removed;
		// the alias is documented ON the canonical `query` property instead. The
		// direction-B parser must still map pattern→query so a pattern-only call
		// is not rejected before the handler's silent normalization runs.
		const schema = {
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Search pattern. Also accepts alias: pattern.' },
			},
		};
		const r = coerceOrReject({ pattern: 'FooBar' }, schema, 'search_code', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined, 'canonical-side "accepts alias" doc must satisfy the required field');
	});

	test('coerceOrReject: canonical-side plural aliases doc, stops at parenthesis', () => {
		// filePattern-style plural list + a mode-style value-mapping hint in parens
		// that must NOT be swallowed into the alias identifier list.
		const schema = {
			required: ['pattern'],
			properties: {
				pattern: { type: 'string', description: 'The search term. Also accepts alias: query.' },
				filePattern: { type: 'string', description: 'Glob filter (e.g. *.go). Also accepts aliases: file_glob, glob.' },
				mode: { type: 'string', description: 'Output mode. Also accepts alias: output_mode (content→full, files_with_matches→files).' },
			},
		};
		const r = coerceOrReject({ query: 'parseConfig', file_glob: '*.ts', output_mode: 'files_with_matches' }, schema, 'search_files', { warn: () => {}, info: () => {} });
		assert.strictEqual(r.reject, undefined, 'query alias satisfies required `pattern`; file_glob/output_mode are recognized aliases (warn-free)');
	});

	test('coerceOrReject: documented aliases must NOT be flagged as unknown arguments', () => {
		// Regression for the log-noise bug: after P2 removed the standalone alias
		// properties, the "unknown argument … may be ignored" check kept firing for
		// documented aliases (pattern/path/output_mode/file_glob) even though they
		// are recognized and recovered by the handler. The warning was both noisy
		// (a full stack trace per call) and factually wrong. The unknown-arg check
		// must consult the same alias map the required check uses.
		const schema = {
			required: ['query'],
			properties: {
				query: { type: 'string', description: 'Search pattern. Also accepts alias: pattern.' },
				mode: { type: 'string', description: 'Output mode. Also accepts alias: output_mode (content→full).' },
				filePattern: { type: 'string', description: 'Glob filter. Also accepts aliases: file_glob, glob.' },
				path_filter: { type: 'string', description: 'Path glob. Also accepts alias: path.' },
			},
		};
		const warnings: string[] = [];
		const r = coerceOrReject(
			{ pattern: 'FGCInfo', path: 'Runtime/CoreUObject', file_glob: '*.cpp', output_mode: 'content' },
			schema, 'search_code', { warn: (m) => warnings.push(m), info: () => {} },
		);
		assert.strictEqual(r.reject, undefined, 'pattern alias satisfies required `query`');
		const unknownWarns = warnings.filter((w) => w.includes('unknown argument'));
		assert.deepStrictEqual(unknownWarns, [], `documented aliases must not warn unknown; got: ${unknownWarns.join(' | ')}`);
	});

	test('coerceOrReject: a genuinely unknown argument still warns', () => {
		// Guardrail: the alias exemption must be narrow — a key that is neither a
		// declared property nor a documented alias must still be flagged.
		const schema = {
			properties: {
				query: { type: 'string', description: 'Search pattern. Also accepts alias: pattern.' },
			},
		};
		const warnings: string[] = [];
		coerceOrReject({ query: 'x', bogusField: 1 }, schema, 'search_code', { warn: (m) => warnings.push(m), info: () => {} });
		assert.ok(warnings.some((w) => w.includes('unknown argument') && w.includes('bogusField')), 'a non-alias, non-property key must still warn');
	});

	test('coerceOrReject: search_code `offset` must NOT warn unknown (it is a declared pagination param)', () => {
		// Regression for log 1785204849282: the model passes `offset` to search_code
		// (it mirrors search_graph, which paginates with offset/limit). search_code
		// used to hard-code offset=0 AND not declare `offset` in its schema, so the
		// coerce check fired "unknown argument: offset — may be ignored" on every
		// paginated call — both noisy AND a lie (offset is now honored end-to-end).
		// Declaring offset in the schema must silence the warning.
		const schema = {
			properties: {
				query: { type: 'string', description: 'Regex search pattern. Also accepts alias: pattern.' },
				filePattern: { type: 'string', description: 'File glob. Also accepts aliases: file_glob, glob.' },
				limit: { type: 'number', description: 'Max results.' },
				offset: { type: 'number', description: 'Skip first N results (pagination).' },
			},
		};
		const warnings: string[] = [];
		const r = coerceOrReject(
			{ query: 'gc\\.CreateGCClusters', filePattern: '**/CoreUObject/**/*.cpp', limit: 30, offset: 60 },
			schema, 'search_code', { warn: (m) => warnings.push(m), info: () => {} },
		);
		assert.strictEqual(r.reject, undefined, 'offset is a legit pagination param, not a rejection');
		const unknownWarns = warnings.filter((w) => w.includes('unknown argument'));
		assert.deepStrictEqual(unknownWarns, [], `search_code offset must not warn unknown; got: ${unknownWarns.join(' | ')}`);
	});
});
