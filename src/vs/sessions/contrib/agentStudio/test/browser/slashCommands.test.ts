/*---------------------------------------------------------------------------------------------
 *  Unit tests for parseSlashCommands — chat input slash command parsing.
 *
 *  Covers /skill, /workflow, /wf, and bare /{wf-xxx} trigger syntax.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { parseSlashCommands } from '../../webview/src/utils/slashCommands.js';

suite('parseSlashCommands', () => {

	suite('/skill parsing (existing behavior)', () => {

		test('single /skill command', () => {
			const r = parseSlashCommands('/skill my-skill');
			assert.deepStrictEqual(r.explicitSkillIds, ['my-skill']);
			assert.strictEqual(r.workflowTrigger, undefined);
		});

		test('multiple /skill commands are deduplicated and lowercased', () => {
			const r = parseSlashCommands('/skill Foo /skill bar /skill FOO');
			assert.deepStrictEqual(r.explicitSkillIds, ['foo', 'bar']);
		});

		test('/skill with surrounding text', () => {
			const r = parseSlashCommands('请运行 /skill deploy 然后告诉我结果');
			assert.deepStrictEqual(r.explicitSkillIds, ['deploy']);
		});

		test('plain message has no skill ids', () => {
			const r = parseSlashCommands('hello world');
			assert.deepStrictEqual(r.explicitSkillIds, []);
			assert.strictEqual(r.workflowTrigger, undefined);
		});
	});

	suite('/workflow and /wf parsing', () => {

		test('/workflow <id> without input', () => {
			const r = parseSlashCommands('/workflow wf-abc123');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-abc123');
			assert.strictEqual(r.workflowTrigger?.input, undefined);
		});

		test('/workflow <id> with input text', () => {
			const r = parseSlashCommands('/workflow wf-abc123 帮我分析这段代码');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-abc123');
			assert.strictEqual(r.workflowTrigger?.input, '帮我分析这段代码');
		});

		test('/wf alias works', () => {
			const r = parseSlashCommands('/wf wf-deploy 生产环境');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-deploy');
			assert.strictEqual(r.workflowTrigger?.input, '生产环境');
		});

		test('workflow id with dashes and numbers', () => {
			const r = parseSlashCommands('/workflow wf-2024-report-v2');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-2024-report-v2');
		});

		test('input with extra whitespace is trimmed', () => {
			const r = parseSlashCommands('/wf wf-x    spaced input   ');
			assert.strictEqual(r.workflowTrigger?.input, 'spaced input');
		});

		test('multiline input is captured', () => {
			const r = parseSlashCommands('/workflow wf-x line1\nline2');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-x');
			assert.strictEqual(r.workflowTrigger?.input, 'line1\nline2');
		});
	});

	suite('bare /{wf-xxx} parsing', () => {

		test('bare workflow id alone', () => {
			const r = parseSlashCommands('/wf-abc123');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-abc123');
			assert.strictEqual(r.workflowTrigger?.input, undefined);
		});

		test('bare workflow id with input', () => {
			const r = parseSlashCommands('/wf-abc123 处理这些数据');
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-abc123');
			assert.strictEqual(r.workflowTrigger?.input, '处理这些数据');
		});

		test('bare pattern requires whole-line match (not mid-text)', () => {
			const r = parseSlashCommands('请执行 /wf-abc123 谢谢');
			// bare 语法要求整行匹配，中间的 /wf-xxx 不触发 bare；
			// 但 wfCmdPattern 不匹配（缺少 workflow/wf 前缀 + 空格），故无 trigger
			assert.strictEqual(r.workflowTrigger, undefined);
		});

		test('non-wf slash command does not trigger workflow', () => {
			const r = parseSlashCommands('/deploy now');
			assert.strictEqual(r.workflowTrigger, undefined);
		});
	});

	suite('combined commands', () => {

		test('/skill and /workflow in same message', () => {
			const r = parseSlashCommands('/skill prep /workflow wf-main 开始');
			assert.deepStrictEqual(r.explicitSkillIds, ['prep']);
			assert.strictEqual(r.workflowTrigger?.workflowId, 'wf-main');
			assert.strictEqual(r.workflowTrigger?.input, '开始');
		});
	});
});
