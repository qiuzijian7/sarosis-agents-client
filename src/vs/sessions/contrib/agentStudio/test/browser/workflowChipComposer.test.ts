/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	serializeWorkflowMark,
	parseWorkflowMarks,
	filterWorkflowItems,
	buildWorkflowTrigger,
	extractTextAfterWorkflowMark,
	escapeRegExp,
	type IWorkflowChipItem,
} from '../../../../browser/agentChat/agentChatPanel.workflowChip.js';
import { parseSlashCommands } from '../../webview/src/utils/slashCommands.js';

const WF = (id: string, name = id): IWorkflowChipItem => ({ id, name });

suite('workflowChip composer helpers', () => {

	suite('serializeWorkflowMark', () => {
		test('prefixes id with /workflow', () => {
			assert.strictEqual(serializeWorkflowMark('wf-abc'), '/workflow wf-abc');
		});
		test('handles id with dashes/numbers', () => {
			assert.strictEqual(serializeWorkflowMark('wf-2024-report-v2'), '/workflow wf-2024-report-v2');
		});
	});

	suite('parseWorkflowMarks', () => {
		test('extracts a single mark', () => {
			assert.deepStrictEqual(parseWorkflowMarks('/workflow wf-abc'), ['wf-abc']);
		});
		test('extracts mark embedded in text', () => {
			assert.deepStrictEqual(
				parseWorkflowMarks('请 /workflow wf-main 帮我分析'),
				['wf-main'],
			);
		});
		test('ignores non-workflow slash commands', () => {
			assert.deepStrictEqual(parseWorkflowMarks('/skill foo /workflow wf-x'), ['wf-x']);
		});
		test('returns empty for plain text', () => {
			assert.deepStrictEqual(parseWorkflowMarks('hello world'), []);
		});
		test('does not match bare /wf-xxx', () => {
			assert.deepStrictEqual(parseWorkflowMarks('/wf-abc'), []);
		});
	});

	suite('filterWorkflowItems', () => {
		const items = [WF('wf-report'), WF('wf-deploy', '生产部署'), WF('wf-test')];
		test('returns all when filter empty', () => {
			assert.strictEqual(filterWorkflowItems(items, '').length, 3);
		});
		test('filters by id (case-insensitive)', () => {
			assert.deepStrictEqual(
				filterWorkflowItems(items, 'REPORT').map(w => w.id),
				['wf-report'],
			);
		});
		test('filters by name', () => {
			assert.deepStrictEqual(
				filterWorkflowItems(items, '部署').map(w => w.id),
				['wf-deploy'],
			);
		});
		test('returns empty on no match', () => {
			assert.strictEqual(filterWorkflowItems(items, 'zzz').length, 0);
		});
	});

	suite('buildWorkflowTrigger', () => {
		test('undefined when no workflow id', () => {
			assert.strictEqual(buildWorkflowTrigger(undefined, 'hi'), undefined);
		});
		test('input omitted when empty/whitespace', () => {
			const t = buildWorkflowTrigger('wf-x', '  ');
			assert.ok(t);
			assert.strictEqual(t.workflowId, 'wf-x');
			assert.strictEqual(t.input, undefined);
		});
		test('input trimmed', () => {
			assert.deepStrictEqual(
				buildWorkflowTrigger('wf-x', ' 分析代码 '),
				{ workflowId: 'wf-x', input: '分析代码' },
			);
		});
	});

	suite('extractTextAfterWorkflowMark', () => {
		test('strips leading /workflow <id> prefix', () => {
			assert.strictEqual(
				extractTextAfterWorkflowMark('/workflow wf-main 生成报告', 'wf-main'),
				'生成报告',
			);
		});
		test('returns empty when only the mark is present', () => {
			assert.strictEqual(extractTextAfterWorkflowMark('/workflow wf-main', 'wf-main'), '');
		});
		test('returns text unchanged when id does not match', () => {
			assert.strictEqual(
				extractTextAfterWorkflowMark('/workflow wf-other hi', 'wf-main'),
				'/workflow wf-other hi',
			);
		});
	});

	suite('escapeRegExp', () => {
		test('escapes regex metacharacters', () => {
			assert.strictEqual(escapeRegExp('a.b'), 'a\\.b');
			assert.strictEqual(escapeRegExp('wf-[x]'), 'wf-\\[x\\]');
		});
	});

	suite('cross-check with parseSlashCommands', () => {
		test('serializeWorkflowMark output is parseable to the same workflowId', () => {
			const mark = serializeWorkflowMark('wf-main');
			assert.strictEqual(parseSlashCommands(mark).workflowTrigger?.workflowId, 'wf-main');
		});
		test('serialized mark + trailing text yields matching input', () => {
			const mark = serializeWorkflowMark('wf-main') + ' 生成报告';
			const parsed = parseSlashCommands(mark).workflowTrigger;
			assert.deepStrictEqual(parsed, { workflowId: 'wf-main', input: '生成报告' });
		});
	});
});
