/*---------------------------------------------------------------------------------------------
 *  Plan Mode Optimization — pure logic unit tests
 *
 *  Tests the MiMo-aligned plan mode components:
 *  1. planFile — plan file path generation + path matching
 *  2. filterToolsByChatMode — plan mode no longer filters (schema stable)
 *  3. hardPermission runtime interception — isToolCallDeniedByHardPermission
 *  4. buildPlanSystemReminder — 5-phase <system-reminder> builder
 *  5. buildBuildSwitchReminder — plan→craft transition reminder
 *
 *  All modules are dependency-free → no live model / provider needed.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	filterToolsByChatMode,
	buildPlanSystemReminder,
	buildBuildSwitchReminder,
	buildCraftSystemReminder,
} from '../../common/chatModeConfig.js';
import {
	isToolHardDenied,
	applyHardPermission,
	planModeHardPermission,
	isToolCallDeniedByHardPermission,
} from '../../common/toolPermission.js';
import {
	generatePlanPath,
	slugify,
	isPlanFilePath,
	isPlanFilePathInRoot,
	PLAN_FILE_GLOB,
} from '../../common/planFile.js';
import { ToolSecurityLevel } from '../../common/providers.js';
import {
	createInitialWorkState,
	parsePlanDocument,
	planExitRequiresApproval,
	reduceWorkState,
} from '../../common/workMode.js';

import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. planFile — plan file path generation
// ─────────────────────────────────────────────────────────────────────────────
suite('planFile (plan file path generation)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('generatePlanPath produces valid path', () => {
		const p = generatePlanPath('/home/.vssaros', '分析 GC 性能瓶颈', 1721376000000);
		// On Windows, path.join uses backslashes; normalize for assertion
		const normalized = p.replace(/\\/g, '/');
		assert.ok(normalized.includes('plans/'));
		assert.ok(normalized.endsWith('.md'));
		assert.ok(normalized.includes('2024-07-19'));  // timestamp ISO date
	});

	test('slugify preserves CJK characters', () => {
		const slug = slugify('分析GC性能');
		assert.ok(slug.includes('分析gc性能') || slug.includes('分析gc'));
	});

	test('slugify returns "plan" for empty input', () => {
		assert.strictEqual(slugify(''), 'plan');
		assert.strictEqual(slugify('   '), 'plan');
	});

	test('slugify truncates to 40 chars', () => {
		const slug = slugify('a'.repeat(200));
		assert.ok(slug.length <= 40);
	});

	test('isPlanFilePath matches plans/*.md', () => {
		assert.strictEqual(isPlanFilePath('/home/.vssaros/plans/2026-07-19-refactor.md'), true);
		assert.strictEqual(isPlanFilePath('plans/plan.md'), true);
		assert.strictEqual(isPlanFilePath('~/.vssaros/saros/plans/test.md'), true);
	});

	test('isPlanFilePath rejects non-plan paths', () => {
		assert.strictEqual(isPlanFilePath('/home/.vssaros/agents/my-agent/.agent.md'), false);
		assert.strictEqual(isPlanFilePath('src/main.ts'), false);
		assert.strictEqual(isPlanFilePath(''), false);
	});

	test('isPlanFilePath handles Windows backslash paths', () => {
		assert.strictEqual(isPlanFilePath('C:\\Users\\test\\.vssaros\\plans\\plan.md'), true);
	});

	test('PLAN_FILE_GLOB is plans/*.md', () => {
		assert.strictEqual(PLAN_FILE_GLOB, 'plans/*.md');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. filterToolsByChatMode — plan mode no longer filters
// ─────────────────────────────────────────────────────────────────────────────
suite('filterToolsByChatMode — plan mode schema stability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const allTools = [
		{ name: 'file_read', securityLevel: ToolSecurityLevel.Safe },
		{ name: 'file_write', securityLevel: ToolSecurityLevel.Dangerous },
		{ name: 'terminal', securityLevel: ToolSecurityLevel.Dangerous },
		{ name: 'search_graph', securityLevel: ToolSecurityLevel.Safe },
		{ name: 'exit_plan_mode', securityLevel: ToolSecurityLevel.Safe }, // removed from registry, kept for test compat
		{ name: 'plan_enter', securityLevel: ToolSecurityLevel.Safe },
		{ name: 'plan_exit', securityLevel: ToolSecurityLevel.Safe },
	] as any[];

	test('plan mode returns ALL tools (no filtering — MiMo alignment)', () => {
		const result = filterToolsByChatMode(allTools, 'plan');
		assert.strictEqual(result.length, allTools.length);
		// Write tools remain in schema (blocked at runtime, not schema)
		assert.ok(result.some(t => t.name === 'file_write'));
		assert.ok(result.some(t => t.name === 'terminal'));
	});

	test('craft mode returns all tools', () => {
		const result = filterToolsByChatMode(allTools, 'craft');
		assert.strictEqual(result.length, allTools.length);
	});

	test('workflow mode returns all tools', () => {
		const result = filterToolsByChatMode(allTools, 'workflow');
		assert.strictEqual(result.length, allTools.length);
	});

	test('ask mode still filters dangerous tools', () => {
		const result = filterToolsByChatMode(allTools, 'ask');
		assert.ok(!result.some(t => t.name === 'file_write'));
		assert.ok(!result.some(t => t.name === 'terminal'));
		assert.ok(result.some(t => t.name === 'file_read'));
	});

	test('plan and craft produce identical tool lists (prefix-cache stable)', () => {
		const planResult = filterToolsByChatMode(allTools, 'plan');
		const craftResult = filterToolsByChatMode(allTools, 'craft');
		assert.deepStrictEqual(
			planResult.map(t => t.name).sort(),
			craftResult.map(t => t.name).sort(),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. hardPermission runtime interception
// ─────────────────────────────────────────────────────────────────────────────
suite('hardPermission runtime interception (isToolCallDeniedByHardPermission)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const policy = planModeHardPermission();

	test('file_write is denied', () => {
		const result = isToolCallDeniedByHardPermission('file_write', policy);
		assert.strictEqual(result.denied, true);
		assert.ok(result.reason?.includes('plan mode'));
	});

	test('terminal is denied (added in optimization)', () => {
		const result = isToolCallDeniedByHardPermission('terminal', policy);
		assert.strictEqual(result.denied, true);
	});

	test('terminal_cmd is denied', () => {
		const result = isToolCallDeniedByHardPermission('terminal_cmd', policy);
		assert.strictEqual(result.denied, true);
	});

	test('file_read is NOT denied', () => {
		const result = isToolCallDeniedByHardPermission('file_read', policy);
		assert.strictEqual(result.denied, false);
	});

	test('search_graph is NOT denied', () => {
		const result = isToolCallDeniedByHardPermission('search_graph', policy);
		assert.strictEqual(result.denied, false);
	});

	test('plan_enter is NOT denied', () => {
		const result = isToolCallDeniedByHardPermission('plan_enter', policy);
		assert.strictEqual(result.denied, false);
	});

	test('plan_exit is NOT denied', () => {
		const result = isToolCallDeniedByHardPermission('plan_exit', policy);
		assert.strictEqual(result.denied, false);
	});

	test('undefined policy → not denied', () => {
		const result = isToolCallDeniedByHardPermission('file_write', undefined);
		assert.strictEqual(result.denied, false);
	});

	test('empty policy → not denied', () => {
		const result = isToolCallDeniedByHardPermission('file_write', { deniedToolPatterns: [] });
		assert.strictEqual(result.denied, false);
	});

	test('bash is denied (added in optimization)', () => {
		const result = isToolCallDeniedByHardPermission('bash', policy);
		assert.strictEqual(result.denied, true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildPlanSystemReminder — 5-phase <system-reminder>
// ─────────────────────────────────────────────────────────────────────────────
suite('buildPlanSystemReminder (5-phase system reminder)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('contains <system-reminder> tags', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.startsWith('<system-reminder>'));
		assert.ok(reminder.trim().endsWith('</system-reminder>'));
	});

	test('contains "Plan mode is active"', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('Plan mode is active'));
	});

	test('contains "supersedes any other instructions"', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('supersedes any other instructions'));
	});

	test('contains 5 phases', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('Phase 1'));
		assert.ok(reminder.includes('Phase 2'));
		assert.ok(reminder.includes('Phase 3'));
		assert.ok(reminder.includes('Phase 4'));
		assert.ok(reminder.includes('Phase 5'));
	});

	test('mentions plan_explore for parallel exploration', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('plan_explore'));
	});

	test('mentions plan_exit as mandatory final step', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('plan_exit'));
	});

	test('includes plan file path when provided', () => {
		const reminder = buildPlanSystemReminder('/home/.vssaros/plans/test.md');
		assert.ok(reminder.includes('/home/.vssaros/plans/test.md'));
		assert.ok(reminder.includes('plan file exists'));
	});

	test('indicates no plan file when path omitted', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('No plan file exists'));
	});

	test('contains MUST NOT directives (command language)', () => {
		const reminder = buildPlanSystemReminder();
		assert.ok(reminder.includes('MUST NOT'));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildCraftSystemReminder — craft mode plan_explore guidance
// ─────────────────────────────────────────────────────────────────────────────
suite('buildCraftSystemReminder (craft mode plan_explore guidance)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('contains <system-reminder> tags', () => {
		const reminder = buildCraftSystemReminder();
		assert.ok(reminder.startsWith('<system-reminder>'));
		assert.ok(reminder.trim().endsWith('</system-reminder>'));
	});

	test('mentions plan_explore', () => {
		const reminder = buildCraftSystemReminder();
		assert.ok(reminder.includes('plan_explore'));
	});

	test('mentions PARALLEL exploration', () => {
		const reminder = buildCraftSystemReminder();
		assert.ok(reminder.includes('PARALLEL'));
	});

	test('warns against manual sequential research', () => {
		const reminder = buildCraftSystemReminder();
		assert.ok(reminder.includes('Do NOT manually loop'));
	});

	test('mentions when to skip plan_explore', () => {
		const reminder = buildCraftSystemReminder();
		assert.ok(reminder.includes('Skip plan_explore'));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. buildBuildSwitchReminder — plan→craft transition
// ─────────────────────────────────────────────────────────────────────────────
suite('buildBuildSwitchReminder (plan→craft transition)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('contains <system-reminder> tags', () => {
		const reminder = buildBuildSwitchReminder();
		assert.ok(reminder.startsWith('<system-reminder>'));
		assert.ok(reminder.trim().endsWith('</system-reminder>'));
	});

	test('mentions internal work-mode change without changing ChatMode', () => {
		const reminder = buildBuildSwitchReminder();
		assert.ok(reminder.includes('plan to work'));
		assert.ok(reminder.includes('chat mode has not changed'));
	});

	test('states "no longer in read-only mode"', () => {
		const reminder = buildBuildSwitchReminder();
		assert.ok(reminder.includes('no longer in read-only mode'));
	});

	test('includes plan file path when provided', () => {
		const reminder = buildBuildSwitchReminder('/home/.vssaros/plans/test.md');
		assert.ok(reminder.includes('/home/.vssaros/plans/test.md'));
		assert.ok(reminder.includes('execute'));
	});

	test('provides fallback message when no plan file path', () => {
		const reminder = buildBuildSwitchReminder();
		assert.ok(reminder.includes('plan was previously created'));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. planModeHardPermission expanded coverage (P0 security)
// ─────────────────────────────────────────────────────────────────────────────
suite('planModeHardPermission expanded coverage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const policy = planModeHardPermission();

	test('blocks bridge tools', () => {
		assert.strictEqual(isToolHardDenied('tool_call', policy), true);
	});

	test('blocks browser interact tools', () => {
		assert.strictEqual(isToolHardDenied('browser_click', policy), true);
		assert.strictEqual(isToolHardDenied('browser_navigate', policy), true);
	});

	test('blocks codebase write tools', () => {
		assert.strictEqual(isToolHardDenied('index_repository', policy), true);
		assert.strictEqual(isToolHardDenied('delete_project', policy), true);
		assert.strictEqual(isToolHardDenied('ingest_traces', policy), true);
	});

	test('blocks skill mutation tools', () => {
		assert.strictEqual(isToolHardDenied('skill_manage', policy), true);
	});

	test('blocks process execution tools', () => {
		assert.strictEqual(isToolHardDenied('process', policy), true);
		assert.strictEqual(isToolHardDenied('execute_code', policy), true);
	});

	test('blocks deployment tools', () => {
		assert.strictEqual(isToolHardDenied('deploy', policy), true);
		assert.strictEqual(isToolHardDenied('publish', policy), true);
	});

	test('blocks file mutation aliases', () => {
		assert.strictEqual(isToolHardDenied('write_file', policy), true);
		assert.strictEqual(isToolHardDenied('file_delete', policy), true);
		assert.strictEqual(isToolHardDenied('patch', policy), true);
	});

	test('allows read tools through', () => {
		assert.strictEqual(isToolHardDenied('file_read', policy), false);
		assert.strictEqual(isToolHardDenied('search_files', policy), false);
		assert.strictEqual(isToolHardDenied('search_graph', policy), false);
		assert.strictEqual(isToolHardDenied('plan_explore', policy), false);
		assert.strictEqual(isToolHardDenied('plan_enter', policy), false);
		assert.strictEqual(isToolHardDenied('plan_exit', policy), false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. isPlanFilePathInRoot — path traversal defense
// ─────────────────────────────────────────────────────────────────────────────
suite('isPlanFilePathInRoot (path traversal defense)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const planRoot = 'users/test/.vssaros/saros/plans';

	test('validates path within plan root', () => {
		assert.strictEqual(
			isPlanFilePathInRoot('users/test/.vssaros/saros/plans/2026-plan.md', 'users/test/.vssaros/saros/plans'),
			true
		);
	});

	test('rejects path traversal with ../', () => {
		assert.strictEqual(
			isPlanFilePathInRoot('plans/../../../etc/malicious.md', planRoot),
			false
		);
	});

	test('rejects path not under plan root', () => {
		assert.strictEqual(
			isPlanFilePathInRoot('src/plans/test.md', planRoot),
			false
		);
		assert.strictEqual(
			isPlanFilePathInRoot('/tmp/plans/test.md', planRoot),
			false
		);
	});

	test('handles empty inputs', () => {
		assert.strictEqual(isPlanFilePathInRoot('', planRoot), false);
		assert.strictEqual(isPlanFilePathInRoot('plans/test.md', ''), false);
	});

	test('handles Windows backslash paths', () => {
		assert.strictEqual(
			isPlanFilePathInRoot('users\\test\\.vssaros\\saros\\plans\\plan.md', 'users/test/.vssaros/saros/plans'),
			true
		);
	});
});

suite('ChatMode policy / WorkMode runtime separation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Plan ChatMode starts in plan WorkMode', () => {
		assert.strictEqual(createInitialWorkState('plan').mode, 'plan');
	});

	test('Craft ChatMode starts in work WorkMode', () => {
		assert.strictEqual(createInitialWorkState('craft').mode, 'work');
	});

	test('only Plan ChatMode requires plan_exit approval', () => {
		assert.strictEqual(planExitRequiresApproval('plan'), true);
		assert.strictEqual(planExitRequiresApproval('craft'), false);
	});

	test('Craft can enter planning and return to work without changing policy', () => {
		let state = createInitialWorkState('craft');
		state = reduceWorkState(state, { type: 'ENTER_PLAN' });
		assert.strictEqual(state.mode, 'plan');
		state = reduceWorkState(state, { type: 'START_DISPATCH' });
		assert.strictEqual(state.mode, 'work');
		assert.strictEqual(state.executionStatus, 'dispatching');
	});

	test('rejected Plan approval remains in plan WorkMode', () => {
		let state = createInitialWorkState('plan');
		state = reduceWorkState(state, { type: 'REQUEST_APPROVAL' });
		assert.strictEqual(state.approvalStatus, 'pending');
		state = reduceWorkState(state, { type: 'REJECT_PLAN' });
		assert.strictEqual(state.mode, 'plan');
		assert.strictEqual(state.approvalStatus, 'rejected');
	});
});

suite('Plan document parser (DAG fan-out contract)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses structured tasks, files, dependencies and roles', () => {
		const parsed = parsePlanDocument(`# Plan\n\n## Goal\nRefactor agent loop safely.\n\n## Tasks\n\n### Task 1: Add state model\n- Description: Implement immutable work state.\n- Files: common/workMode.ts, common/agentRunState.ts\n- Dependencies: none\n- Role: Core Agent\n- Complexity: high\n\n### Task 2: Wire executor\n- Description: Use work mode in permissions.\n- Files: browser/agentTurnExecutor.ts\n- Dependencies: Task 1\n- Complexity: medium\n\n## Verification\nRun tests.`);
		assert.strictEqual(parsed.summary, 'Refactor agent loop safely.');
		assert.strictEqual(parsed.tasks.length, 2);
		assert.deepStrictEqual(parsed.tasks[0].files, ['common/workMode.ts', 'common/agentRunState.ts']);
		assert.deepStrictEqual(parsed.tasks[1].dependencies, ['Task 1']);
		assert.strictEqual(parsed.tasks[0].suggestedRole, 'Core Agent');
		assert.strictEqual(parsed.tasks[0].complexity, 'high');
	});

	test('parses checklist fallback as independent tasks', () => {
		const parsed = parsePlanDocument(`## Goal\nShip feature\n\n## Tasks\n- [ ] Implement API — Add endpoint\n- [ ] Add tests — Cover edge cases\n\n## Verification\nRun tests`);
		assert.strictEqual(parsed.tasks.length, 2);
		assert.strictEqual(parsed.tasks[0].title, 'Implement API');
		assert.strictEqual(parsed.tasks[0].description, 'Add endpoint');
	});

	test('returns no executable tasks for an empty Tasks section', () => {
		const parsed = parsePlanDocument('## Goal\nExplore only\n\n## Tasks\n\n## Verification\nNone');
		assert.deepStrictEqual(parsed.tasks, []);
	});

	test('parses analysis tasks with Deliverable field', () => {
		const parsed = parsePlanDocument(`## Goal\nDiagnose GC jank root cause.\n\n## Tasks\n\n### Task 1: Analyze allocation hotspots\n- Description: Inspect GC trace for large allocations.\n- Files: none\n- Dependencies: none\n- Deliverable: findings report\n- Complexity: medium\n\n### Task 2: Review pause distribution\n- Description: Correlate pauses with frame drops.\n- Dependencies: none\n- Deliverable: recommendation\n- Complexity: high\n\n## Verification\nCross-check hypotheses.`);
		assert.strictEqual(parsed.tasks.length, 2);
		assert.strictEqual(parsed.tasks[0].deliverable, 'findings report');
		assert.strictEqual(parsed.tasks[1].deliverable, 'recommendation');
		assert.deepStrictEqual(parsed.tasks[0].dependencies, undefined);
	});
});

