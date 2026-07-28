/*---------------------------------------------------------------------------------------------
 *  Tests for subAgentReturnFormat（MiMo RETURN_FORMAT 契约）与 completionGate 集成：
 *  Status 头解析 + 自报通道优先级（Status 头 > XML 标记 > 推断）+ 真相降级。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	RETURN_FORMAT_INSTRUCTION,
	parseReturnHeader,
	injectReturnFormatIntoTask,
} from '../../common/subAgentReturnFormat.js';
import { gateResult, type ICompletionGateContext } from '../../common/completionGate.js';

const baseCtx: ICompletionGateContext = { errored: false, truncated: false, filesTouched: [] };

suite('subAgentReturnFormat — parseReturnHeader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('standard **Status**: success header', () => {
		const h = parseReturnHeader('**Status**: success\n**Summary**: done the thing\n\nBody...');
		assert.strictEqual(h?.status, 'success');
		assert.strictEqual(h?.summary, 'done the thing');
	});

	test('all four statuses parse', () => {
		for (const s of ['success', 'partial', 'failed', 'blocked'] as const) {
			const h = parseReturnHeader(`**Status**: ${s}\n`);
			assert.strictEqual(h?.status, s, `${s} must parse`);
		}
	});

	test('case-insensitive status word and header', () => {
		const h = parseReturnHeader('**STATUS**: Partial\n');
		assert.strictEqual(h?.status, 'partial');
	});

	test('plain Status: header (no asterisks, line start) as fallback', () => {
		const h = parseReturnHeader('Status: blocked\nThe task hit a wall.');
		assert.strictEqual(h?.status, 'blocked');
	});

	test('multiple headers → last occurrence wins (final self-report)', () => {
		const text = '**Status**: partial\n\n...more work...\n\n**Status**: success\n**Summary**: finished after all';
		const h = parseReturnHeader(text);
		assert.strictEqual(h?.status, 'success');
		assert.strictEqual(h?.summary, 'finished after all');
	});

	test('no header → undefined (caller falls back to inference)', () => {
		assert.strictEqual(parseReturnHeader('Just some findings, no status here.'), undefined);
		assert.strictEqual(parseReturnHeader(''), undefined);
	});

	test('header without summary → status only', () => {
		const h = parseReturnHeader('**Status**: failed\nCould not find the file.');
		assert.strictEqual(h?.status, 'failed');
		assert.strictEqual(h?.summary, undefined);
	});

	test('injectReturnFormatIntoTask appends the contract', () => {
		const out = injectReturnFormatIntoTask('Do the task');
		assert.ok(out.startsWith('Do the task'));
		assert.ok(out.includes('**Status**'), 'instruction must mention the Status line');
		assert.ok(out.includes('success | partial | failed | blocked'), 'instruction must carry the status vocabulary');
		assert.ok(RETURN_FORMAT_INSTRUCTION.includes('Be honest'), 'instruction must demand honesty');
	});
});

suite('completionGate — Status header as primary self-report channel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Status header success + clean run → success (source noted)', () => {
		const r = gateResult('**Status**: success\n**Summary**: all done', baseCtx);
		assert.strictEqual(r.status, 'success');
		assert.ok(r.reason.includes('Status header'), 'reason must note the Status header source');
		assert.strictEqual(r.acceptanceMet, true);
	});

	test('Status header partial → partial verbatim', () => {
		const r = gateResult('**Status**: partial\n**Summary**: missing one file', baseCtx);
		assert.strictEqual(r.status, 'partial');
		assert.strictEqual(r.acceptanceMet, false);
	});

	test('Status header success but errored → DOWNGRADE to failed (truth wins)', () => {
		const r = gateResult('**Status**: success\n', { ...baseCtx, errored: true });
		assert.strictEqual(r.status, 'failed');
		assert.ok(r.reason.includes('claimed success'));
	});

	test('Status header success but truncated → DOWNGRADE to partial', () => {
		const r = gateResult('**Status**: success\n', { ...baseCtx, truncated: true });
		assert.strictEqual(r.status, 'partial');
		assert.ok(r.reason.includes('downgraded'));
	});

	test('Status header wins over conflicting XML marker', () => {
		const r = gateResult('**Status**: success\n\n<result status="failed" summary="x"/>', baseCtx);
		assert.strictEqual(r.status, 'success', '注入式 Status 头必须优先于历史 XML 标记');
	});

	test('XML marker still honored when no Status header (backward compatible)', () => {
		const r = gateResult('<result status="partial" summary="half done"/>', baseCtx);
		assert.strictEqual(r.status, 'partial');
	});

	test('no header, no marker, truncated → inference (partial)', () => {
		const r = gateResult('some partial output...', { ...baseCtx, truncated: true });
		assert.strictEqual(r.status, 'partial');
		assert.ok(r.reason.includes('no explicit status marker'));
	});

	test('header summary preferred in result.summary', () => {
		const r = gateResult('**Status**: success\n**Summary**: concise one-liner\n\nLong body text...', baseCtx);
		assert.strictEqual(r.summary, 'concise one-liner');
	});

	test('DB-truth downgrade still applies on top of Status header success', () => {
		const r = gateResult('**Status**: success\n', {
			...baseCtx,
			incompleteTasks: [{ id: 't1', title: 'leftover' }],
		});
		assert.strictEqual(r.status, 'partial');
		assert.ok(r.reason.includes('DB truth'));
	});
});
