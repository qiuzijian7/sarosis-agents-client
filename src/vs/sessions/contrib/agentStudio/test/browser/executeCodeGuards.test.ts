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
	detectPowerShellOnlyCmdlet,
	powerShellCmdletGuardMessage,
	isCommandNotFoundFailure,
	detectBareSourceCode,
	bareSourceCodeGuardMessage,
	isDeterministicScriptFailure,
	deterministicScriptFailureMessage,
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

// ── 反向护栏：PowerShell cmdlet 裸用在 cmd.exe（日志 1787292837471 exit 255）──

suite('executeCodeGuards — PowerShell cmdlet 反向护栏', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects Out-String piped in cmd.exe (real incident case)', () => {
		// 实测失败命令：模型读了 Unix 护栏提示却漏掉 powershell 外壳
		assert.strictEqual(
			detectPowerShellOnlyCmdlet('python3 -c "print(1)" 2>&1 | Out-String -Width 500'),
			'Out-String',
		);
	});

	test('detects other common cmdlets at command position', () => {
		assert.strictEqual(detectPowerShellOnlyCmdlet('dir | Select-Object -First 5'), 'Select-Object');
		assert.strictEqual(detectPowerShellOnlyCmdlet('type f.txt | Select-String foo'), 'Select-String');
		assert.strictEqual(detectPowerShellOnlyCmdlet('Get-ChildItem -Recurse'), 'Get-ChildItem');
	});

	test('already wrapped in powershell/pwsh → NOT flagged', () => {
		assert.strictEqual(
			detectPowerShellOnlyCmdlet('powershell -NoProfile -Command "dir | Select-Object -First 5"'),
			undefined,
		);
		assert.strictEqual(
			detectPowerShellOnlyCmdlet('pwsh -c "Get-ChildItem | Out-String"'),
			undefined,
		);
		assert.strictEqual(
			detectPowerShellOnlyCmdlet('powershell.exe -Command "Get-Content f"'),
			undefined,
		);
	});

	test('plain cmd / posix commands are NOT flagged', () => {
		assert.strictEqual(detectPowerShellOnlyCmdlet('python3 app.py'), undefined);
		assert.strictEqual(detectPowerShellOnlyCmdlet('node build.js && dir'), undefined);
	});

	test('cmdlet name inside an argument string is NOT flagged', () => {
		// 非命令段起始位置 → 不命中
		assert.strictEqual(detectPowerShellOnlyCmdlet('python3 app.py --mode Select-Object'), undefined);
	});

	test('guard message gives the correct powershell wrapping (cmd dialect)', () => {
		const msg = powerShellCmdletGuardMessage('Out-String', 'execute_code');
		assert.ok(msg.includes('Out-String'));
		assert.ok(msg.includes('powershell -NoProfile -Command'), 'should show the wrapper');
		assert.ok(msg.includes('exit 255'));
		assert.ok(!msg.includes('undefined'));
	});
});

// ── ★ posix 方言下的 cmdlet 护栏（日志 20260829T232635 事故缺口）──────────
//
// 事故：本机 Git Bash 可用 → 护栏整体门控在 `isWindows && !gitBash` 内被跳过 →
// 模型照 environmentDirective 的静态 PowerShell 提示写 `... | Select-Object -Last 30`
// → bash 里 `Select-Object: command not found`（exit 127），白烧一轮 LLM 往返。
// detectPowerShellOnlyCmdlet 名单里第一个就是 Select-Object，它只是从未获得执行机会。

suite('executeCodeGuards — PowerShell cmdlet 护栏（posix 方言 / Git Bash）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('posix 方言仍要拦 —— 这正是 2026-08-30 前漏掉的那一格', () => {
		// 检测本身与方言无关（cmdlet 在 bash 里同样不存在）
		assert.strictEqual(detectPowerShellOnlyCmdlet('ls -la | Select-Object -Last 30'), 'Select-Object');
		assert.strictEqual(detectPowerShellOnlyCmdlet('Write-Host "EXIT:0"'), 'Write-Host');
	});

	test('posix 下的提示改用 POSIX 命令，且**不**建议包 powershell 外壳', () => {
		const msg = powerShellCmdletGuardMessage('Select-Object', 'execute_code', 'posix');
		assert.ok(msg.includes('Select-Object'));
		assert.ok(msg.includes('exit 127'), 'posix 下失败码是 127 而非 255');
		assert.ok(msg.includes('POSIX shell'));
		// 逆映射：Select-Object → head（UNIX_ONLY_COMMAND_HINTS 的反向查表，不另建映射）
		assert.ok(msg.includes('head'), 'should suggest the POSIX equivalent');
		// ★ 关键：不能再建议包 powershell —— 与 SHELL_APPROVAL_SHAPE_GUIDANCE 冲突，
		// 且命令已经在 shell 里，包一层救不了「bash 里没有 Select-Object」。
		assert.ok(msg.includes('Do NOT wrap it in powershell -Command'));
		assert.ok(!msg.includes('-NoProfile -Command "<your command>'));
	});

	test('posix 下的提示对 Select-String → grep', () => {
		const msg = powerShellCmdletGuardMessage('Select-String', 'terminal', 'posix');
		assert.ok(msg.includes('grep'), 'Select-String → grep');
		assert.ok(msg.includes('terminal'), 'tool name is echoed');
	});

	test('无 POSIX 等价写法的 cmdlet（Get-Content）退化为通用文案，不输出 undefined', () => {
		// UNIX_ONLY_COMMAND_HINTS 里没有 Get-Content 的 POSIX 对应项
		const msg = powerShellCmdletGuardMessage('Get-Content', 'execute_code', 'posix');
		assert.ok(!msg.includes('undefined'));
		assert.ok(msg.includes('head / tail / grep / sed / awk'));
	});
});

// ── 确定性失败识别（command-not-found → 不重试）──────────────────────────────

suite('executeCodeGuards — isCommandNotFoundFailure', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects cmd.exe zh/en command-not-found', () => {
		assert.ok(isCommandNotFoundFailure("'Out-String' 不是内部或外部命令，也不是可运行的程序"));
		assert.ok(isCommandNotFoundFailure("'import' 不是内部或外部命令"));
		assert.ok(isCommandNotFoundFailure("'foo' is not recognized as an internal or external command"));
	});

	test('detects PowerShell / POSIX variants', () => {
		assert.ok(isCommandNotFoundFailure('Get-Foo : is not recognized as the name of a cmdlet'));
		assert.ok(isCommandNotFoundFailure('CommandNotFoundException'));
		assert.ok(isCommandNotFoundFailure('bash: grep2: command not found'));
	});

	test('genuine runtime errors are NOT classified as command-not-found', () => {
		assert.ok(!isCommandNotFoundFailure('Traceback (most recent call last):\n  KeyError: x'));
		assert.ok(!isCommandNotFoundFailure('npm ERR! network timeout'));
		assert.ok(!isCommandNotFoundFailure(''));
	});
});

// ── 裸源码护栏（日志 1787292837471 exit 1：'import' 不是内部或外部命令）──────

suite('executeCodeGuards — 裸源码护栏', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects multi-line python source passed as command (real incident case)', () => {
		const cmd = [
			'import os, json',
			'base = "G:/CustomWorkspaces/AIProjects/ComfyUI"',
			'for root, dirs, files in os.walk(base):',
			'    print(root)',
		].join('\n');
		assert.strictEqual(detectBareSourceCode(cmd), 'import os, json');
	});

	test('detects def / class / const / function starts', () => {
		assert.ok(detectBareSourceCode('def main():\n    pass'));
		assert.ok(detectBareSourceCode('class Foo:\n    x = 1'));
		assert.ok(detectBareSourceCode('const a = 1;\nconsole.log(a)'));
		assert.ok(detectBareSourceCode('function go() {\n  return 1\n}'));
	});

	test('command already using an interpreter → NOT flagged', () => {
		assert.strictEqual(detectBareSourceCode('python3 -c "import os\nprint(os.getcwd())"'), undefined);
		assert.strictEqual(detectBareSourceCode('node -e "const a=1\nconsole.log(a)"'), undefined);
	});

	test('heredoc form → NOT flagged (handled by _extractHeredoc)', () => {
		assert.strictEqual(detectBareSourceCode("python3 << 'EOF'\nimport os\nprint(1)\nEOF"), undefined);
	});

	test('single line is NOT flagged (conservative)', () => {
		assert.strictEqual(detectBareSourceCode('import os'), undefined);
	});

	test('normal multi-line shell script → NOT flagged', () => {
		assert.strictEqual(detectBareSourceCode('cd src\ndir\necho done'), undefined);
	});

	test('guard message lists the three correct forms', () => {
		const msg = bareSourceCodeGuardMessage('import os, json', 'execute_code');
		assert.ok(msg.includes('raw source code'));
		assert.ok(msg.includes('python3 -c'), 'should show inline interpreter form');
		assert.ok(msg.includes('Heredoc'), 'should show heredoc form');
		assert.ok(msg.includes('file_write'), 'should show write-then-run form');
		assert.ok(!msg.includes('undefined'));
	});
});

// ── 脚本确定性失败（log 1787302409958 ITER 50：heredoc assert 失败被重试 3 次）──

suite('executeCodeGuards — isDeterministicScriptFailure', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects python AssertionError (real incident case)', () => {
		const out = [
			'Traceback (most recent call last):',
			'  File "<stdin>", line 12, in <module>',
			'AssertionError: start not found',
		].join('\n');
		assert.ok(isDeterministicScriptFailure(out));
	});

	test('detects python syntax / name / import errors', () => {
		assert.ok(isDeterministicScriptFailure('Traceback (most recent call last):\n  NameError: name \'foo\' is not defined'));
		assert.ok(isDeterministicScriptFailure('Traceback (most recent call last):\n  ModuleNotFoundError: No module named \'foo\''));
		// 编译期语法错误可能不带 Traceback 头
		assert.ok(isDeterministicScriptFailure('  File "<stdin>", line 3\nSyntaxError: invalid syntax'));
		assert.ok(isDeterministicScriptFailure('IndentationError: unexpected indent'));
	});

	test('detects node syntax / module errors', () => {
		assert.ok(isDeterministicScriptFailure("Error: Cannot find module 'lodash'"));
		assert.ok(isDeterministicScriptFailure('ERR_MODULE_NOT_FOUND'));
		assert.ok(isDeterministicScriptFailure('SyntaxError: Unexpected token }'));
	});

	test('TRANSIENT failures are NOT classified as deterministic (conservative)', () => {
		// 网络类：重试可能成功 → 必须保留重试
		assert.ok(!isDeterministicScriptFailure('Traceback (most recent call last):\n  requests.exceptions.Timeout: timed out'));
		assert.ok(!isDeterministicScriptFailure('Traceback (most recent call last):\n  ConnectionResetError: [Errno 104]'));
		// 编译失败、进程占用等
		assert.ok(!isDeterministicScriptFailure('error: linker command failed with exit code 1'));
		assert.ok(!isDeterministicScriptFailure('EBUSY: resource busy or locked'));
		assert.ok(!isDeterministicScriptFailure(''));
	});

	test('message tells the model not to retry and steers to patch', () => {
		const msg = deterministicScriptFailureMessage(1, '[stderr]\nAssertionError: x');
		assert.ok(msg.includes('NOT retried'), 'should state it was not retried');
		assert.ok(msg.includes('fail identically'), 'should explain determinism');
		assert.ok(msg.includes('patch tool'), 'should steer to patch for code edits');
		assert.ok(!msg.includes('undefined'));
	});
});
