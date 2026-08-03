/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectUnixOnlyCommand,
	skillScriptAbsolutePaths,
	UNIX_ONLY_COMMAND_HINTS,
} from '../../browser/providers/tool/executeCodeGuards.js';

suite('executeCodeGuards — Windows Unix 命令护栏', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects head in pipeline (log 1785744765714 exit 255 case)', () => {
		assert.strictEqual(detectUnixOnlyCommand('python3 scripts/anysearch_cli.py doc 2>&1 | head -60'), 'head');
	});

	test('detects grep / tail / sed / awk at command position', () => {
		assert.strictEqual(detectUnixOnlyCommand('grep -r "foo" src/'), 'grep');
		assert.strictEqual(detectUnixOnlyCommand('cat log.txt | tail -20'), 'tail');
		assert.strictEqual(detectUnixOnlyCommand("cat f | sed 's/a/b/'"), 'sed');
		assert.strictEqual(detectUnixOnlyCommand("ls | awk '{print $1}'"), 'awk');
	});

	test('detects after && / ; separators', () => {
		assert.strictEqual(detectUnixOnlyCommand('cd src && grep foo bar.txt'), 'grep');
		assert.strictEqual(detectUnixOnlyCommand('echo hi; head -5 f.txt'), 'head');
	});

	test('PowerShell / cmd commands are NOT flagged', () => {
		assert.strictEqual(detectUnixOnlyCommand('python3 scripts/x.py doc'), undefined);
		assert.strictEqual(detectUnixOnlyCommand('Get-Content f.txt | Select-Object -First 60'), undefined);
		assert.strictEqual(detectUnixOnlyCommand('node scripts/build.js'), undefined);
		assert.strictEqual(detectUnixOnlyCommand('dir /s'), undefined);
	});

	test('word inside argument string is NOT flagged (no command position)', () => {
		// "head" 出现在引号参数内而非命令段起始 → 不应命中
		assert.strictEqual(detectUnixOnlyCommand('python3 app.py --title "head of page"'), undefined);
	});

	test('hints table covers all guarded commands', () => {
		for (const cmd of ['head', 'tail', 'grep', 'sed', 'awk']) {
			assert.ok(UNIX_ONLY_COMMAND_HINTS[cmd], `missing hint for ${cmd}`);
		}
	});
});

suite('executeCodeGuards — skillScriptAbsolutePaths（绝对路径呈现）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SUPPORT = ['SKILL.md', 'scripts/anysearch_cli.py', 'scripts/anysearch_cli.js', 'scripts/anysearch_cli.ps1', 'scripts/shared/doc_spec.md', 'references/notes.txt'];

	test('posix skillDir → posix absolute script paths', () => {
		const out = skillScriptAbsolutePaths('/home/user/.vssaros/skills/anysearch', SUPPORT);
		assert.deepStrictEqual(out, [
			'/home/user/.vssaros/skills/anysearch/scripts/anysearch_cli.py',
			'/home/user/.vssaros/skills/anysearch/scripts/anysearch_cli.js',
			'/home/user/.vssaros/skills/anysearch/scripts/anysearch_cli.ps1',
		]);
	});

	test('windows skillDir → backslash absolute script paths', () => {
		const out = skillScriptAbsolutePaths('G:\\CustomWorkspaces\\proj\\resources\\.agents\\skills\\anysearch', SUPPORT);
		assert.deepStrictEqual(out, [
			'G:\\CustomWorkspaces\\proj\\resources\\.agents\\skills\\anysearch\\scripts\\anysearch_cli.py',
			'G:\\CustomWorkspaces\\proj\\resources\\.agents\\skills\\anysearch\\scripts\\anysearch_cli.js',
			'G:\\CustomWorkspaces\\proj\\resources\\.agents\\skills\\anysearch\\scripts\\anysearch_cli.ps1',
		]);
	});

	test('only scripts/ dir + script extensions included (md/txt 排除)', () => {
		const out = skillScriptAbsolutePaths('/s', ['scripts/a.py', 'scripts/b.md', 'docs/c.py', 'scripts/d.json']);
		assert.deepStrictEqual(out, ['/s/scripts/a.py']);
	});

	test('trailing separator on skillDir is normalized', () => {
		assert.deepStrictEqual(skillScriptAbsolutePaths('/s/anysearch/', ['scripts/x.py']), ['/s/anysearch/scripts/x.py']);
	});

	test('empty supportFiles → empty', () => {
		assert.deepStrictEqual(skillScriptAbsolutePaths('/s', []), []);
	});
});
