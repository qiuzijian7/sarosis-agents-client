/*---------------------------------------------------------------------------------------------
 *  Plan task field contract — prompt template ↔ parser agreement
 *
 *  The plan flow is a two-party contract:
 *      buildPlanSystemReminder()  — tells the LLM which fields to emit
 *      parsePlanDocument()        — reads those fields back
 *
 *  A field that the parser accepts but the template never mentions is
 *  SILENTLY LOST at runtime: the LLM never emits it, so `suggestedRole`
 *  stays undefined and agent matching falls back to a neutral score
 *  (agentFactory.ts `_calcCapabilityScore`: empty role → 0.5).
 *
 *  This suite pins the agreement so neither side can drift alone.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildPlanSystemReminder } from '../../common/chatModeConfig.js';
import { parsePlanDocument } from '../../common/workMode.js';

/**
 * Fields the parser recognises inside a `### Task N` block.
 * Keep in sync with the metadata regexes in `common/workMode.ts`
 * (`parseTaskBlock` / the checklist fallback).
 */
const PARSER_ACCEPTED_FIELDS = [
	'description',
	'files',
	'dependencies',
	'role',
	'deliverable',
	'complexity',
] as const;

/** Extract `- Key:` labels from the template's fenced `## Tasks` example. */
function extractTemplateFields(reminder: string): string[] {
	const fenced = /```([\s\S]*?)```/.exec(reminder);
	assert.ok(fenced, 'plan reminder must contain a fenced example block');

	return fenced[1]
		.split('\n')
		.map(line => /^\s*-\s*([A-Za-z]+)\s*:/.exec(line)?.[1]?.toLowerCase())
		.filter((field): field is string => Boolean(field));
}

suite('Plan task field contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('template declares every field the parser accepts', () => {
		const declared = extractTemplateFields(buildPlanSystemReminder('/tmp/plan.md'));

		for (const field of PARSER_ACCEPTED_FIELDS) {
			assert.ok(
				declared.includes(field),
				`parser accepts "${field}" but the plan template never tells the LLM to emit it — it would be silently lost`,
			);
		}
	});

	test('template declares no field the parser would ignore', () => {
		const declared = extractTemplateFields(buildPlanSystemReminder('/tmp/plan.md'));

		for (const field of declared) {
			assert.ok(
				(PARSER_ACCEPTED_FIELDS as readonly string[]).includes(field),
				`template asks the LLM for "${field}" but the parser does not read it — wasted tokens and a misleading contract`,
			);
		}
	});

	test('Role is emitted in the documented `- Role: <value>` form and round-trips', () => {
		const reminder = buildPlanSystemReminder('/tmp/plan.md');
		assert.ok(/^\s*-\s*Role\s*:/m.test(reminder), 'template must show the exact `- Role:` label');

		// End-to-end: a plan written exactly in the template's shape parses to a role.
		const { tasks } = parsePlanDocument([
			'## Tasks',
			'### Task 1: Implement login',
			'- Role: Developer',
			'- Description: add login endpoint',
			'- Files: src/auth.ts',
			'- Dependencies: none',
			'- Deliverable: code change',
			'- Complexity: medium',
		].join('\n'));

		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0].suggestedRole, 'Developer');
	});

	test('Role guidance steers toward a SHORT label (scoring is word-by-word)', () => {
		const reminder = buildPlanSystemReminder('/tmp/plan.md');

		// agentFactory._calcCapabilityScore splits the role on whitespace/commas
		// and scores `matched / keywords.length`, so a longer phrase dilutes the
		// score. The template must warn the LLM about this.
		assert.ok(
			/shorter|short label|one or two words/i.test(reminder),
			'template should tell the LLM to keep Role short — long phrases dilute the match score',
		);
	});
});
