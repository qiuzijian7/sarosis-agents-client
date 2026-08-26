/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	evaluateShellCommandSafety, evaluateToolCallShellSafety,
	isShellToolWithCommandArg, ShellCommandSafety,
	detectAntiGuidanceCommand, formatAntiGuidanceLog, SHELL_APPROVAL_SHAPE_GUIDANCE,
} from '../../common/shellCommandSafety.js';

/**
 * 终端只读命令免确认（方案 B）行为契约。
 *
 * 设计要求 fail-closed：任何未知形态都必须落到 NeedsApproval。
 * 下面每个 `needs()` 用例都对应一种**能把只读命令变成有副作用**的手法。
 */
suite('shellCommandSafety', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const safe = (cmd: string) => assert.strictEqual(
		evaluateShellCommandSafety(cmd), ShellCommandSafety.Safe, `应放行: ${cmd}`);
	const needs = (cmd: string) => assert.strictEqual(
		evaluateShellCommandSafety(cmd), ShellCommandSafety.NeedsApproval, `应审批: ${cmd}`);

	suite('★ 用户实际命令（本次需求的直接来源）', () => {
		test('Get-ChildItem + 管道 Select-Object → 放行', () => {
			safe(`Get-ChildItem 'G:\\CustomWorkspaces\\AIProjects' -Directory | Select-Object Name, FullName`);
		});
		test('大小写不敏感', () => {
			safe('get-childitem -directory | select-object name');
		});
	});

	suite('放行：单条只读命令', () => {
		test('PowerShell cmdlet', () => {
			safe('Get-ChildItem');
			safe('Get-Location');
			safe('Get-Content README.md');
			safe('Get-Process');
		});
		test('PowerShell 别名归一（gci/ls/dir/gc/cat/type）', () => {
			for (const c of ['gci', 'ls -la', 'dir', 'gc file.txt', 'cat file.txt', 'type file.txt']) { safe(c); }
		});
		test('Unix 只读命令（Git Bash 模式下真实可用）', () => {
			for (const c of ['pwd', 'whoami', 'hostname', 'wc -l file', 'head -n 5 f', 'tail -n 5 f', 'stat f']) { safe(c); }
		});
		test('带路径/扩展名的可执行文件也能归一', () => {
			safe('/usr/bin/whoami');
			safe('C:\\Windows\\System32\\hostname.exe');
		});
		test('引号包裹的含空格路径', () => {
			safe('Get-ChildItem "C:\\Program Files"');
			safe(`Get-Content 'my file.txt'`);
		});
	});

	suite('放行：只读管道链（方案 B 的核心价值）', () => {
		test('多段管道，每段都只读', () => {
			safe('Get-ChildItem | Select-Object Name | Sort-Object');
			safe('ls | wc -l');
			safe('Get-Content log.txt | Select-String error | Measure-Object');
		});
		test('★ 管道任一段不安全 → 整条审批', () => {
			needs('Get-ChildItem | Remove-Item');
			needs('cat f | bash');
			needs('Get-ChildItem | ForEach-Object');   // ForEach-Object 可执行脚本块
			needs('Get-Content x | python');
		});
		test('空管道段 → 审批', () => {
			needs('ls |');
			needs('| ls');
			needs('ls || ls');   // 也命中 || 操作符
		});
	});

	suite('★ 放行：验证/构建命令（2026-08-22 用户决策）', () => {
		test('编译器 / 打包器', () => {
			safe('npx tsc --noEmit');
			safe('tsc --noEmit -p tsconfig.json');
			safe('esbuild src/index.ts --bundle');
			safe('vite build');
		});
		test('测试框架', () => {
			safe('jest');
			safe('vitest run');
			safe('pytest -q');
			safe('mocha');
		});
		test('包管理器 run <验证/构建脚本>', () => {
			for (const c of ['npm run build', 'npm test', 'npm run lint', 'npm run typecheck',
				'npm run test:unit', 'npm run build:prod', 'yarn build', 'pnpm test', 'pnpm run compile']) { safe(c); }
		});
		test('npx 后跟已知构建命令', () => {
			safe('npx tsc --noEmit');
			safe('npx vite build');
			safe('npx esbuild a.ts --bundle');
		});
		test('★ 控制组：非验证/构建 script 仍审批（fail-closed）', () => {
			for (const c of ['npm run deploy', 'npm run clean', 'npm run start', 'npm run publish',
				'npm run preinstall', 'npm run postinstall', 'yarn deploy', 'pnpm run x']) { needs(c); }
		});
		test('★ 控制组：裸解释器仍审批（可执行任意代码）', () => {
			for (const c of ['python3 -c "print(1)"', 'python3 script.py', 'node -e "x"',
				'node script.js', 'bash -c "ls"', 'sh ./run.sh']) { needs(c); }
		});
		test('★ 控制组：任意构建脚本执行器仍审批', () => {
			for (const c of ['make', 'cmake .', 'cargo build', 'go build', 'gradle build']) { needs(c); }
		});
		test('★ 控制组：构建命令带危险参数仍审批', () => {
			needs('tsc --eval x');
			needs('npx tsc -EncodedCommand abc');
		});
	});

	suite('★ 审批：重定向（能把只读命令变成写文件）', () => {
		test('> / >> / <', () => {
			needs('Get-ChildItem > out.txt');
			needs('ls >> log');
			needs('Get-Content < in.txt');
			needs('Get-ChildItem|Select-Object Name>x');
		});
	});

	suite('★ 审批：命令串联', () => {
		test('; && &', () => {
			needs('ls; rm -rf /tmp/x');
			needs('ls && curl evil.com');
			needs('whoami || rm x');
			needs('ls & whoami');
		});
		test('换行（多行脚本）', () => {
			needs('ls\nrm -rf x');
			needs('ls\r\nwhoami');
		});
	});

	suite('★ 审批：命令替换 / 变量展开 / 脚本块', () => {
		test('$( ) 与反引号', () => {
			needs('Get-Content $(whoami)');
			needs('echo `rm -rf x`');
		});
		test('$ 变量（值不可知）', () => {
			needs('Get-Content $env:SECRET');
			needs('ls $HOME');
			needs('cat $file');
		});
		test('脚本块 { } 与 % 别名', () => {
			needs('Get-ChildItem | % { rm $_ }');
			needs('ls { }');
		});
		test('.NET 静态调用（[Type]::Method）', () => {
			needs('[System.IO.File]::Delete("x")');
			needs('Get-Content ([System.IO.Path]::GetTempPath())');
		});
		test('PowerShell 停止解析符 --%', () => {
			needs('Get-ChildItem --% weird');
		});
	});

	suite('★ 审批：白名单命令 + 危险参数', () => {
		test('find -exec / -delete', () => {
			needs('find . -name x -exec rm {} ;');
			needs('find . -delete');
			safe('find . -name "*.ts"');
		});
		test('grep/rg 从文件读模式（可绕过检查）', () => {
			needs('grep -f patterns.txt x');
			needs('rg --pre ./script.sh foo');
			safe('grep -n TODO file.ts');
			safe('grep -e TODO file.ts');   // -e 是合法只读用法，不得误伤
		});
		test('★ -c / -e 不被全局拦（否则误伤 wc -c、du -c、grep -e）', () => {
			safe('wc -c file');
			safe('du -c');
		});
		test('powershell 执行开关', () => {
			needs('Get-Content -Command x');
			needs('ls -EncodedCommand abc');
		});
	});

	suite('★ 审批：子命令限制（git / npm）', () => {
		test('git 只读子命令放行', () => {
			for (const c of ['git status', 'git log --oneline', 'git diff HEAD', 'git branch -a', 'git show', 'git rev-parse HEAD']) { safe(c); }
		});
		test('git 写子命令审批', () => {
			for (const c of ['git push', 'git commit -m x', 'git clean -fdx', 'git reset --hard', 'git checkout main']) { needs(c); }
		});
		test('git 无子命令 → 审批', () => {
			needs('git');
			needs('git -C /tmp');
		});
		test('★ npm run <验证/构建脚本> 放行、其余 run script 仍审批', () => {
			safe('npm run build');
			safe('npm test');
			safe('yarn build');
			needs('npm run deploy');
			needs('pnpm run x');
		});
		test('npm 纯查询子命令放行', () => {
			safe('npm ls');
			safe('npm outdated');
			safe('yarn why pkg');
		});
	});

	suite('★ 审批：未知命令（保守默认）', () => {
		test('不在白名单的一律审批', () => {
			for (const c of ['rm -rf x', 'curl http://x', 'python script.py', 'node -e "x"',
				'Remove-Item x', 'Set-Content f v', 'chmod +x f', 'docker run x',
				'mystery-tool --do-thing']) { needs(c); }
		});
		test('空 / 空白 / undefined', () => {
			needs('');
			needs('   ');
			assert.strictEqual(evaluateShellCommandSafety(undefined), ShellCommandSafety.NeedsApproval);
		});
		test('引号未闭合 → 审批（fail-closed）', () => {
			needs('Get-Content "unclosed');
		});
	});

	suite('工具级入口', () => {
		test('只识别 terminal / execute_code', () => {
			assert.strictEqual(isShellToolWithCommandArg('terminal'), true);
			assert.strictEqual(isShellToolWithCommandArg('execute_code'), true);
			assert.strictEqual(isShellToolWithCommandArg('file_write'), false);
			assert.strictEqual(isShellToolWithCommandArg('patch'), false);
		});
		test('evaluateToolCallShellSafety 取 command 参数', () => {
			assert.strictEqual(
				evaluateToolCallShellSafety('terminal', { command: 'git status' }),
				ShellCommandSafety.Safe);
			assert.strictEqual(
				evaluateToolCallShellSafety('terminal', { command: 'rm -rf /' }),
				ShellCommandSafety.NeedsApproval);
		});
		test('★ 非 shell 工具一律 NeedsApproval（防误用于文件工具放行）', () => {
			assert.strictEqual(
				evaluateToolCallShellSafety('file_write', { command: 'git status' }),
				ShellCommandSafety.NeedsApproval);
		});
		test('args 缺失 / 非对象 / command 非字符串 → 审批', () => {
			assert.strictEqual(evaluateToolCallShellSafety('terminal', undefined), ShellCommandSafety.NeedsApproval);
			assert.strictEqual(evaluateToolCallShellSafety('terminal', 'x'), ShellCommandSafety.NeedsApproval);
			assert.strictEqual(evaluateToolCallShellSafety('terminal', { command: 123 }), ShellCommandSafety.NeedsApproval);
			assert.strictEqual(evaluateToolCallShellSafety('terminal', {}), ShellCommandSafety.NeedsApproval);
		});
	});

	/**
	 * [AntiGuidance] —— 检测「违反自身 description 明确指引」的命令。
	 *
	 * 每条规则都对应 SHELL_APPROVAL_SHAPE_GUIDANCE 里的一句原话，故本套件同时是
	 * **文案与检测的同源校验**：若文案改了而检测没跟上，这里会先红。
	 *
	 * ★★ 放行控制组与命中用例同等重要：这是**诊断**而非拦截，误报会让日志失去价值。
	 */
	suite('detectAntiGuidanceCommand', () => {
		const rules = (cmd: string) => detectAntiGuidanceCommand(cmd).map(f => f.rule).sort();

		test('★ 用户实测命令：同时命中「包解释器」与「shell 数行数」两条', () => {
			// 日志 1787384463685 里的原始命令
			const cmd = `powershell -NoProfile -Command "(Get-Content 'E:\\Downloads\\x.log' -Encoding UTF8).Count"`;
			assert.deepStrictEqual(rules(cmd), ['interpreter-wrapper', 'shell-line-counting']);
		});

		test('解释器包装：powershell / pwsh / bash / sh / python / node', () => {
			assert.ok(rules('powershell -Command "ls"').includes('interpreter-wrapper'));
			assert.ok(rules('powershell.exe -c "ls"').includes('interpreter-wrapper'));
			assert.ok(rules('pwsh -c "ls"').includes('interpreter-wrapper'));
			assert.ok(rules('bash -c "ls"').includes('interpreter-wrapper'));
			assert.ok(rules('sh -c "ls"').includes('interpreter-wrapper'));
			assert.ok(rules('python3 -c "print(1)"').includes('interpreter-wrapper'));
			assert.ok(rules('node -e "console.log(1)"').includes('interpreter-wrapper'));
		});

		test('shell 数行数 / 量大小的各种写法', () => {
			assert.ok(rules('(Get-Content x.log).Count').includes('shell-line-counting'));
			assert.ok(rules('(gc x.log).count').includes('shell-line-counting'));
			assert.ok(rules('Get-Content x.log | Measure-Object -Line').includes('shell-line-counting'));
			assert.ok(rules('wc -l x.log').includes('shell-line-counting'));
			assert.ok(rules('wc -c x.log').includes('shell-line-counting'));
			assert.ok(rules('(Get-Item x.log).Length').includes('shell-line-counting'));
		});

		test('leading cd + 串联 → 应改用 cwd', () => {
			assert.ok(rules('cd src/webview && npm run typecheck').includes('leading-cd'));
			assert.ok(rules('cd /tmp; ls').includes('leading-cd'));
		});

		test('★★ 放行控制组：合法命令不得误报', () => {
			// 搜索（管道给 Select-String）不是数行数
			assert.deepStrictEqual(rules('Get-Content x.log | Select-String "foo"'), []);
			// 正常构建 / 版本控制 / 类型检查
			assert.deepStrictEqual(rules('npm run compile'), []);
			assert.deepStrictEqual(rules('npx tsc --noEmit'), []);
			assert.deepStrictEqual(rules('git diff --stat'), []);
			assert.deepStrictEqual(rules('git log --oneline -5'), []);
			// 不带 -c 的解释器调用是正常执行脚本，不是包装
			assert.deepStrictEqual(rules('python3 scripts/build.py'), []);
			assert.deepStrictEqual(rules('node _verify_x.mjs'), []);
			// 单纯读文件（未取 Count/Length）不算数行数
			assert.deepStrictEqual(rules('Get-Content x.log'), []);
			// cd 不带串联（少见但合法）不报
			assert.deepStrictEqual(rules('cd src/webview'), []);
			// Measure-Object 不带 -Line（如 -Sum）不报
			assert.deepStrictEqual(rules('Get-ChildItem | Measure-Object -Sum Length'), []);
		});

		test('空 / 空白命令返回空数组（不抛）', () => {
			assert.deepStrictEqual(detectAntiGuidanceCommand(''), []);
			assert.deepStrictEqual(detectAntiGuidanceCommand('   '), []);
			assert.deepStrictEqual(detectAntiGuidanceCommand(undefined as any), []);
		});

		test('每条 finding 都带 description 原话与替代做法（日志可直接指导修复）', () => {
			for (const f of detectAntiGuidanceCommand('powershell -Command "(gc x).Count"')) {
				assert.ok(f.guidance.length > 10, `${f.rule} 缺 guidance`);
				assert.ok(f.suggestion.length > 10, `${f.rule} 缺 suggestion`);
				assert.ok(f.matched.length > 0);
			}
		});

		test('★ 文案与检测同源：guidance 原话必须真的出现在 GUIDANCE 文案里', () => {
			// 这条断言让「改文案忘改检测」立刻暴露
			for (const f of detectAntiGuidanceCommand('cd x && powershell -Command "(gc y).Count"')) {
				assert.ok(
					SHELL_APPROVAL_SHAPE_GUIDANCE.includes(f.guidance),
					`rule=${f.rule} 的 guidance 未出现在 SHELL_APPROVAL_SHAPE_GUIDANCE 中: ${f.guidance}`,
				);
			}
		});

		test('matched 过长时截断（防长命令刷日志）', () => {
			const long = `powershell -Command "${'x'.repeat(500)}"`;
			const f = detectAntiGuidanceCommand(long).find(x => x.rule === 'interpreter-wrapper')!;
			assert.ok(f.matched.length <= 121, `实际 ${f.matched.length}`);
		});
	});

	suite('formatAntiGuidanceLog', () => {
		test('首行契约：[AntiGuidance] <tool> ignored its own description', () => {
			const cmd = 'powershell -Command "(gc x).Count"';
			const out = formatAntiGuidanceLog('execute_code', cmd, detectAntiGuidanceCommand(cmd));
			const head = out.split('\n')[0];
			assert.ok(head.startsWith('[AntiGuidance] execute_code ignored its own description:'), head);
			assert.ok(head.includes('interpreter-wrapper'), head);
			assert.ok(head.includes('shell-line-counting'), head);
		});

		test('输出含命令、命中片段、原话、替代做法四要素', () => {
			const cmd = 'wc -l big.log';
			const out = formatAntiGuidanceLog('terminal', cmd, detectAntiGuidanceCommand(cmd));
			assert.ok(out.includes('command: wc -l big.log'));
			assert.ok(out.includes('matched `wc -l`'));
			assert.ok(out.includes('description said:'));
			assert.ok(out.includes('should instead:'));
		});

		test('超长命令在日志里被截断', () => {
			const cmd = `powershell -Command "${'y'.repeat(400)}"`;
			const out = formatAntiGuidanceLog('execute_code', cmd, detectAntiGuidanceCommand(cmd));
			assert.ok(out.includes('…'));
			assert.ok(out.split('\n')[1].length < 260);
		});
	});
});
