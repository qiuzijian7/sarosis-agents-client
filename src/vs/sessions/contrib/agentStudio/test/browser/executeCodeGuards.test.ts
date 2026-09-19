/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectUnixOnlyCommand,
	recordFileReadSuccess, recordFileReadFailure, describeReadGap, hasEverReadSuccessfully, markFileModified,
	detectExternalModification, describeExternalModification,
	detectLongRunningCommand, parseTimeoutSecondsFromStderr, timeoutGuidanceMessage,
	skillScriptAbsolutePaths,
	UNIX_ONLY_COMMAND_HINTS,
	detectPowerShellOnlyCmdlet,
	powerShellCmdletGuardMessage,
	isCommandNotFoundFailure,
	detectBareSourceCode,
	bareSourceCodeGuardMessage,
	isDeterministicScriptFailure,
	deterministicScriptFailureMessage,
	detectBenignSearchExit,
	detectScriptSourceWrite,
	scriptSourceWriteGuardMessage,
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

suite('read-state 跟踪（2026-09-07，patch 连败根因的解药）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 从未读过 → 点破「search 是猜的」并要求先 file_read', () => {
		const gap = describeReadGap('g:\\repo\\src\\a.ts');
		assert.ok(gap.includes('NEVER successfully read'), gap);
		assert.ok(gap.includes('GUESSED'), gap);
		assert.ok(gap.includes('file_read'), gap);
	});

	test('★ 上次读取失败（幻觉路径）→ 反馈携带失败原因', () => {
		recordFileReadFailure('g:\\repo\\src\\webidx\\b.ts', 'Unable to resolve nonexistent file');
		const gap = describeReadGap('g:/repo/src/webidx/b.ts');
		assert.ok(gap.includes('FAILED'), gap);
		assert.ok(gap.includes('nonexistent file'), gap);
		assert.ok(gap.includes('correct absolute path'), gap);
	});

	test('★ 读过 → 提示文件可能已变化', () => {
		recordFileReadSuccess('g:\\repo\\src\\c.ts');
		const gap = describeReadGap('g:/Repo/SRC/c.ts');
		assert.ok(gap.includes('may have changed'), gap);
		assert.ok(gap.includes('Re-read'), gap);
	});

	test('★ 路径归一化：正斜杠/反斜杠/大小写等价', () => {
		recordFileReadSuccess('g:\\repo\\src\\d.ts');
		assert.ok(!describeReadGap('g:/repo/src/d.ts').includes('NEVER'), '同文件不同斜杠应视为已读');
		recordFileReadFailure('G:/REPO/SRC/E.TS', 'x');
		assert.ok(describeReadGap('g:\\repo\\src\\e.ts').includes('FAILED'));
	});

	test('★ P0+P1 写后视为已读：patch 过的文件可直接再 patch，不必重读（2026-09-12 改语义）', () => {
		recordFileReadSuccess('g:\\repo\\src\\MiniImageEditor.tsx');
		assert.strictEqual(hasEverReadSuccessfully('g:\\repo\\src\\MiniImageEditor.tsx'), true);
		markFileModified('g:\\repo\\src\\MiniImageEditor.tsx');
		// P1（2026-09-12）：patch 成功 = 内容已知 = 视为已读 —— 不再强制重读。
		// 依据 patch 返回值现在回传「Updated region」（见 patchMatcher 的
		// buildEditedRegionContext），模型手里已是最新文本。
		assert.strictEqual(hasEverReadSuccessfully('g:\\repo\\src\\MiniImageEditor.tsx'), true,
			'patch 后仍视为已读（不再强制重读）');
		// 但失败路径仍要给出定向纠偏：点破「patch 过但未重读」，并提示可复用 Updated region
		const gap = describeReadGap('g:\\repo\\src\\MiniImageEditor.tsx');
		assert.ok(gap.includes('NOT re-read'), `应点破「patch 过但未重读」，实际：${gap}`);
		assert.ok(gap.includes('Updated region'), '应提示可复用上次回传的 Updated region');
		// 重读后 patchedSinceRead 被清除，纠偏文案随之消失
		recordFileReadSuccess('g:\\repo\\src\\MiniImageEditor.tsx');
		assert.ok(!describeReadGap('g:\\repo\\src\\MiniImageEditor.tsx').includes('NOT re-read'),
			'重读后不再提示「patch 过但未重读」');
	});

	test('★ P3 read-before-edit：hasEverReadSuccessfully 三态', () => {
		assert.strictEqual(hasEverReadSuccessfully('g:\\repo\\src\\never.ts'), false, '从未读过');
		recordFileReadFailure('g:/repo/src/failed.ts', 'nonexistent');
		assert.strictEqual(hasEverReadSuccessfully('g:\\REPO\\src\\failed.ts'), false, '读过但失败 ≠ 读过');
		recordFileReadSuccess('g:/repo/src/ok.ts');
		assert.strictEqual(hasEverReadSuccessfully('g:\\repo\\SRC\\ok.ts'), true, '成功读过（大小写/斜杠归一化）');
	});

	test('★ P3 外部修改检测：mtime 变大才判定（对齐 file_write 的 > 语义）', () => {
		recordFileReadSuccess('g:\\repo\\src\\ext.ts', 1000);
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\ext.ts', 1000), false, '同 mtime → 未改动');
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\ext.ts', 2000), true, 'mtime 变大 → 外部改动');
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\ext.ts', 500), false,
			'mtime 变小（时钟回拨）→ 不判定，避免误报');
	});

	test('★ P3：基线缺失时不判定（宁可漏报不误报）', () => {
		recordFileReadSuccess('g:\\repo\\src\\noMtime.ts');
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\noMtime.ts', 2000), false, '无 mtime 基线 → 不判定');
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\neverRead2.ts', 2000), false, '从未读过 → 不判定');
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\noMtime.ts', 0), false, '拿不到当前 mtime → 不判定');
	});

	test('★ P3：重读后基线刷新，旧的外部改动不再报', () => {
		recordFileReadSuccess('g:\\repo\\src\\ext3.ts', 1000);
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\ext3.ts', 2000), true);
		recordFileReadSuccess('g:\\repo\\src\\ext3.ts', 2000);
		assert.strictEqual(detectExternalModification('g:\\repo\\src\\ext3.ts', 2000), false, '重读后基线已更新');
	});

	test('★ P3 提示文案：点破「外部改动」并指向 file_read', () => {
		recordFileReadSuccess('g:\\repo\\src\\ext4.ts', 1000);
		const msg = describeExternalModification('g:\\repo\\src\\ext4.ts', 6000);
		assert.ok(msg.includes('EXTERNAL CHANGE'), msg);
		assert.ok(msg.includes('file_read'), msg);
		assert.ok(msg.includes('ext4.ts'), '应含具体文件路径');
	});

	test('★ P3：路径归一化对检测同样生效', () => {
		recordFileReadSuccess('g:\\repo\\src\\NormExt.ts', 1000);
		assert.strictEqual(detectExternalModification('g:/REPO/SRC/normext.ts', 2000), true,
			'不同斜杠/大小写应识别为同一文件');
	});

	test('★ P0 超时解析：兼容主进程与回退两种文案', () => {
		assert.strictEqual(parseTimeoutSecondsFromStderr('[timeout: process tree killed after 20s]'), 20);
		assert.strictEqual(parseTimeoutSecondsFromStderr('[timeout: process killed after 30s]'), 30);
		assert.strictEqual(parseTimeoutSecondsFromStderr('out\n[timeout: process tree killed after 300s]\ntail'), 300);
		assert.strictEqual(parseTimeoutSecondsFromStderr('no timeout here'), undefined);
		assert.strictEqual(parseTimeoutSecondsFromStderr(''), undefined);
	});

	test('★ P3 长任务识别：包管理器 + 长动词', () => {
		assert.strictEqual(detectLongRunningCommand('npm install'), 'npm install');
		assert.strictEqual(detectLongRunningCommand('pnpm i'), 'pnpm i');
		assert.strictEqual(detectLongRunningCommand('yarn add react'), 'yarn add');
		assert.strictEqual(detectLongRunningCommand('cargo build --release'), 'cargo build');
		assert.strictEqual(detectLongRunningCommand('docker compose up -d'), 'docker compose up');
		assert.strictEqual(detectLongRunningCommand('npm run dev'), 'npm run');
	});

	test('★ P3 长任务识别：裸构建 / 测试 / 服务', () => {
		assert.strictEqual(detectLongRunningCommand('make -j8'), 'make');
		assert.strictEqual(detectLongRunningCommand('tsc --noEmit'), 'tsc');
		assert.strictEqual(detectLongRunningCommand('vitest run'), 'vitest');
		assert.strictEqual(detectLongRunningCommand('pytest -q'), 'pytest');
	});

	test('★ P3 长任务识别：watch 模式与「打开外部程序」（日志根因）', () => {
		assert.strictEqual(detectLongRunningCommand('tsc --watch'), 'tsc');
		assert.strictEqual(detectLongRunningCommand('start "" "docs/index.html"'), 'opening an external app');
		assert.strictEqual(detectLongRunningCommand('cmd //c start "" "x.html"'), 'opening an external app');
		assert.strictEqual(detectLongRunningCommand('open ./x.html'), 'opening an external app');
	});

	test('★ P3 宁缺毋滥：普通命令不得误报为长任务', () => {
		assert.strictEqual(detectLongRunningCommand('git status'), undefined);
		assert.strictEqual(detectLongRunningCommand('ls -la'), undefined);
		assert.strictEqual(detectLongRunningCommand('grep -rn foo src'), undefined);
		assert.strictEqual(detectLongRunningCommand('node script.mjs'), undefined);
		assert.strictEqual(detectLongRunningCommand(''), undefined);
	});

	test('★ P3 只看首条语句（管道/串联之后不参与判定）', () => {
		assert.strictEqual(detectLongRunningCommand('npm ls | grep foo'), undefined,
			'首段 npm ls 不是长动词 → 不判定');
		assert.strictEqual(detectLongRunningCommand('npm install && npm run build'), 'npm install');
	});

	test('★ P0 引导文案：定性 + 两条出路 + 劝阻原样重发 + 带上形态', () => {
		const msg = timeoutGuidanceMessage(20, 'npm install');
		assert.ok(msg.includes('TIMEOUT'), msg);
		assert.ok(msg.includes('20s'), '应带上实际超时秒数');
		assert.ok(msg.includes('background:true'), '应给出 background 出路');
		assert.ok(msg.includes('taskId'), '应说明返回 taskId');
		assert.ok(msg.includes('action:"poll"'), '应给出 poll 用法');
		assert.ok(msg.includes('timeout: 300'), '应给出加大 timeout 的示例');
		assert.ok(msg.includes('0 for no limit'), '应说明 0 = 不限时');
		assert.ok(msg.includes('Do NOT re-send the same command'), '应劝阻原样重发');
		assert.ok(msg.includes('npm install'), '应带上识别到的形态');
	});

	test('★ P0 引导文案：未识别形态时不编造，但仍给通用出路', () => {
		const msg = timeoutGuidanceMessage(30, 'my-custom-tool --serve');
		assert.ok(msg.includes('TIMEOUT'), msg);
		assert.ok(!msg.includes('Detected long-running shape'), '无命中不得编造形态');
		assert.ok(msg.includes('background:true'), '仍应给出通用出路');
	});
});

suite('检索类良性非零退出码（2026-09-09，exit 123 假失败）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 日志原案：find|xargs grep → exit 123 判为良性', () => {
		const cmd = 'echo "=== CSS ===" ; grep -n "context-usage-tooltip" -A 30 a.css | head -45 ; '
			+ 'find src/vs/sessions -name "*.css" | xargs grep -ln "context-usage-tooltip"';
		const note = detectBenignSearchExit(cmd, 123, '');
		assert.ok(note, 'exit 123 + xargs 应判良性');
		assert.ok(note!.includes('xargs'), note);
		assert.ok(note!.includes('do not re-run') || note!.includes('not a failure') || note!.includes('NOT a failure'), note);
	});

	test('★ grep 无匹配 exit 1 判为良性（POSIX 语义）', () => {
		const note = detectBenignSearchExit('cat a.ts | grep -n "nope"', 1, '');
		assert.ok(note, 'exit 1 + 末段 grep + 无 stderr 应判良性');
		assert.ok(note!.includes('no match'), note);
	});

	test('★ 反例：exit 1 但有 stderr → 不判良性（可能是真错误）', () => {
		assert.strictEqual(detectBenignSearchExit('grep -n x missing.ts', 1, 'grep: missing.ts: No such file'), undefined);
	});

	test('★ 反例：exit 1 末段非检索命令 → 不判良性', () => {
		assert.strictEqual(detectBenignSearchExit('npm run build', 1, ''), undefined);
		assert.strictEqual(detectBenignSearchExit('grep -n x a.ts | node process.js', 1, ''), undefined,
			'末段是 node，退出码归 node');
	});

	test('★ 反例：其它退出码不放行（2/127/255 等真失败）', () => {
		for (const code of [2, 126, 127, 255, 124]) {
			assert.strictEqual(detectBenignSearchExit('grep -n x a.ts', code, ''), undefined, `exit ${code} 不应放行`);
		}
	});

	test('★ 反例：exit 123 但语句里没有 xargs → 不判良性', () => {
		assert.strictEqual(detectBenignSearchExit('python3 script.py', 123, ''), undefined);
	});

	test('★ 取末条语句判定：xargs 在前段、末段是别的命令', () => {
		// `;` 后另起 python，退出码归 python → 123 不能算 xargs 的良性码
		assert.strictEqual(detectBenignSearchExit('find . | xargs grep -l x ; python3 t.py', 123, ''), undefined);
	});

	test('Select-String / rg / findstr 同样适用无匹配语义', () => {
		assert.ok(detectBenignSearchExit('rg "nope" src', 1, ''));
		assert.ok(detectBenignSearchExit('findstr /n "nope" a.txt', 1, ''));
		assert.ok(detectBenignSearchExit('Get-Content a.txt | Select-String "nope"', 1, ''));
	});
});

/**
 * 源码写入护栏 —— 「下划线前缀产物」例外（2026-09-13）。
 *
 * 项目约定（`.gitignore:151` 原文注释「underscore-prefixed = throwaway debug scripts」，
 * 且 `_*.ts`/`_*.js`/`_*.py` 等模式**无前导斜杠 → 任意深度生效**）：路径中**任一段**
 * 以 `_` 开头即视为产物，脚本可直接写，不再被护栏拦下。
 *
 * 起因：模型按项目习惯写 `_render.url.json` / `docs/_draft.md` 每次都被拦，只能改用
 * `file_write` 逐个创建 —— 生成多个 mockup 时摩擦显著。首版只放行「工作区根」，
 * 与 `.gitignore` 的任意深度口径自相矛盾，故本次放开。
 */
suite('executeCodeGuards — 源码写入护栏：下划线产物例外', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 放行：工作区根的下划线产物（原能力回归）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('_render.url.json', '{}')"`),
			undefined, '_render.url.json 应放行');
		assert.strictEqual(
			detectScriptSourceWrite(`python3 -c "open('_mockup.html','w').write('x')"`),
			undefined, '_mockup.html 应放行');
	});

	test('★ 放行：任意深度的下划线前缀（本次修订的核心）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('docs/_draft.md','x')"`),
			undefined, 'docs/_draft.md 应放行（与 .gitignore 同口径）');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/_scratch.ts','x')"`),
			undefined, 'src/_scratch.ts 应放行');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('_kb-mockups/a.html','x')"`),
			undefined, '目录段带下划线也应放行');
	});

	test('★ 仍拦：普通源码（例外不得外溢）', () => {
		const hit = detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/real.ts','x')"`);
		assert.ok(hit, 'src/real.ts 仍应被拦');
		assert.ok(hit.target.includes('src/real.ts'), `target 应指向该文件，实际 ${hit.target}`);
	});

	test('★ 仍拦：段内（非段首）的下划线不算产物', () => {
		// `_` 不在段首 → 不属产物约定，不得被例外放行
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/my_file.ts','x')"`),
			'src/my_file.ts 的 _ 在段内，仍应被拦');
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('my_file.ts','x')"`),
			'工作区根的 my_file.ts 仍应被拦');
	});

	test('★ 仍拦：既无下划线前缀段、也不是 mockup 目录', () => {
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('docs/research/a.md','x')"`),
			'docs/research/ 两条例外都不满足，仍应被拦');
	});

	test('变量绑定形式同样适用（放行与拦截都不漏）', () => {
		assert.strictEqual(
			detectScriptSourceWrite('p = "_render.url.json"\nopen(p, "w").write("x")'),
			undefined, '绑定到产物路径的变量应放行');
		assert.ok(
			detectScriptSourceWrite('p = "src/real.ts"\nopen(p, "w").write("x")'),
			'绑定到源码路径的变量仍应被拦');
	});

	test('构建产物目录仍放行（回归）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('out/x.js','x')"`), undefined);
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('dist/a.css','x')"`), undefined);
	});

	test('★ 护栏文案给出新的逃生舱（不再只说「工作区根」）', () => {
		const hit = detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/real.ts','x')"`);
		assert.ok(hit);
		const msg = scriptSourceWriteGuardMessage(hit, 'execute_code');
		assert.ok(msg.includes('"_"-prefixed segment'), `应说明「任一下划线前缀段」: ${msg}`);
		assert.ok(msg.includes('docs/_draft.md'), '应给出源码树内的产物示例');
	});
});

/**
 * 源码写入护栏 —— 「mockup」原型目录例外（2026-09-13）。
 *
 * 模型按项目习惯把原型 HTML 写进 `docs/kb-mockups/*.html`，但 `docs/` 不在
 * `GENERATED_PATH_MARKER` 的目录名单里 → 被拦。仓库实测 4 个 mockup 目录，内容全是
 * 可弃原型产物（无源码），故把「段名 = `mockup(s)`，或以 `-mockup(s)` 结尾」纳入产物目标。
 */
suite('executeCodeGuards — 源码写入护栏：mockup 原型目录例外', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 放行：仓库实测的 4 个 mockup 目录', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('docs/kb-mockups/index.html','x')"`),
			undefined, 'docs/kb-mockups/（日志原案）');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('docs/design-mockups/planA.html','x')"`),
			undefined, 'docs/design-mockups/');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('doc/layout-mockup/layout-mockup.html','x')"`),
			undefined, 'doc/layout-mockup/（单数）');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('mockups/a.html','x')"`),
			undefined, '裸 mockups/');
	});

	test('★ 仍拦：mockup 只作定语 / 前缀的目录（例外不得外溢）', () => {
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/mockupRenderer/a.ts','x')"`),
			'mockupRenderer/ 是真源码目录（mockup 仅作定语）');
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('src/mockup-utils/a.ts','x')"`),
			'mockup-utils/ 是前缀式命名，不属产物目录');
	});

	test('★ 仍拦：docs/ 下的普通文档目录（回归）', () => {
		assert.ok(
			detectScriptSourceWrite(`node -e "require('fs').writeFileSync('docs/research/a.md','x')"`),
			'docs/research/ 无 mockup 段，仍拦');
	});
});

// ─── ★★★ execute_code 运行期直播（2026-09-19 用户报「terminal 卡片执行中没有输出」）───────────

/**
 * 背景（真机截图 ✓）：execute_code 卡片跑了 **28m57s**，直播区**只有一个光标** ✗。
 * 根因：execute_code 主进程 spawn 是**单次缓冲**（invoke 一把梭 ✗）⇒ 卡片订阅的旁路
 * （`terminalLiveOutput` ✓）**只有 terminal(PTY) 工具会写** ✓ ⇒ execute_code 永远空 ✗。
 *
 * 修法（本 suite 钉住的**接线不变量** ✓）：
 * ① handler 必须接收 `toolCallId`（dispatch 本来就传第 5 参 ✓）；
 * ② 两个 `_execCodeSandbox` 调用点都必须**往下传**；
 * ③ 前台执行必须改走「**后台 spawn + 轮询**」并 `appendTerminalLiveOutput`；
 * ④ 增量切片必须有多字节边界保护（`0xFFFD` ✓）；
 * ⑤ 主进程不回 taskId 时**必须降级为原前台路径**（行为与改造前一致 ✓）。
 */
suite('execute_code 运行期直播（后台 spawn + 轮询接线）', () => {

	const REL = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/compatibilityTools.ts';

	const readSrc = (): string => {
		const abs = path.join(process.cwd(), REL);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	test('★★★ handler 必须接收 toolCallId 并**两处都**传进 _execCodeSandbox（漏传 ⇒ 直播空转 ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes("handler: async (args, _signal, _agentId, _sessionId, toolCallId) => {"),
			'execute_code handler 必须接收第 5 参 toolCallId（dispatch 本来就传 ✓）');
		const forwards = src.split('background, toolCallId,').length - 1;
		assert.ok(forwards >= 2, `_execCodeSandbox 的两个调用点（主路径 + shell 降级重跑）都要传（实际 ${forwards} 处 ✗）`);
	});

	test('★★★ 前台执行必须走「后台 spawn + 轮询」并喂旁路（单次缓冲 ⇒ 结构上不可能直播 ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('_execCodeForegroundWithLiveOutput('), '必须有直播前台实现 ✓');
		assert.ok(src.includes('background: true'), '后台 spawn（复用主进程 background 原语 ✓）');
		assert.ok(src.includes("_execCodeControl(taskId, 'poll')"), '轮询（复用主进程 poll 原语 ✓）');
		assert.ok(src.includes('appendTerminalLiveOutput(toolCallId, delta)'),
			'增量必须喂给 terminalLiveOutput 旁路（否则卡片还是空 ✗）');
		assert.ok(src.includes('LIVE_POLL_MS'), '必须有轮询间隔常量 ✓');
	});

	test('★★ 增量切片必须有多字节边界保护（半个字符 ⇒ 直播区孤立 � ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes('_liveDelta('), '必须有增量切片函数 ✓');
		assert.ok(src.includes('0xFFFD'), '必须处理 U+FFFD 边界（累计字节重解码会切半个多字节字符 ✗）');
	});

	test('★★ 主进程不回 taskId 必须降级为原前台路径（热更新期行为不变 ✓）', () => {
		const src = readSrc();
		assert.ok(src.includes('if (!started.taskId)'), '必须有 taskId 缺失的降级分支 ✓');
		// 降级分支里的调用**不带** background ⇒ 即原前台语义 ✓
		assert.ok(src.includes('降级为原前台路径') || src.includes('原前台单次调用'),
			'降级必须回到原前台单次调用（行为与改造前逐字节一致 ✓）');
	});

	test('★ 轮询异常必须杀掉后台任务（不让它变孤儿 ✗）', () => {
		const src = readSrc();
		assert.ok(src.includes("await _execCodeControl(taskId, 'kill')"),
			'catch 分支必须先 kill（后台任务没有前台超时兜底 ✗）');
	});

	test('★★★ 轮询中途失败必须「返回失败结果」而非向上抛（否则触发整命令重跑 ✗✗）', () => {
		// 2026-09-19 自查发现的隐患：`_execCodeSandbox` 的 catch 把任何异常当成「主进程通道
		// 不可用」⇒ 走 child_process fallback **重跑整条命令** ✗ —— background spawn 已成功
		// 之后的轮询失败若也抛 ⇒ 7 分钟的构建会被从头再跑 ✗。⇒ helper 必须返回失败结果 ✓。
		const src = readSrc();
		assert.ok(src.includes('[live-poll] execute_code 直播轮询失败'),
			'catch 分支必须返回失败结果（[live-poll] …），而不是 throw ✗');
	});

	test('★★ 必须有有界心跳（否则「命令安静」与「直播死了」无法区分 ✗ —— 用户报「卡片卡住」时无法自证）', () => {
		const src = readSrc();
		assert.ok(src.includes('LIVE_HEARTBEAT_MS'), '必须有心跳间隔常量 ✓');
		assert.ok(src.includes('execute_code live: taskId='), '必须有 start/done/heartbeat 日志行（[CompatTools] execute_code live: ✓）');
	});
});
