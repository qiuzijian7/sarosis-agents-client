/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * terminal 输出诊断回归测试（2026-08-21，日志 1787324352413）。
 *
 * 事故：8 次 terminal 调用全部只拿到「提示符 + 命令回显」却都记为 OK，模型被迫
 * 连烧 8 轮 37s 做无效规避。这里用**日志里的真实输出形态**做断言，并配足控制组
 * 确保正常输出不被误清成空。
 */

import assert from 'assert';
import {
	stripShellNoise, diagnoseTerminalOutput, isSlowStartCommand, emptyTerminalOutputMessage,
	createShellNoiseStripper,
} from '../../browser/providers/tool/terminalOutputDiagnosis.js';

suite('terminalOutputDiagnosis — stripShellNoise', () => {

	test('★ 清掉 Git Bash 的【两行】提示符（原大正则对此形态完全无效）', () => {
		// 逐字取自日志 L8164
		const raw = [
			'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/CustomWorkspaces/AIProjects/sarosis-agents-client(main)',
			'$ cd g:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client\\src\\vs\\sessions\\contrib\\agentStudio\\webview && npx tsc --noEmit',
		].join('\n');
		const command = 'cd g:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client\\src\\vs\\sessions\\contrib\\agentStudio\\webview && npx tsc --noEmit';
		assert.strictEqual(stripShellNoise(raw, { command }), '',
			'提示符行 + 命令回显应被完全清掉');
	});

	test('★ 验证旧正则确实漏掉该形态（防「测试自欺」）', () => {
		const firstLine = 'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/CustomWorkspaces/AIProjects/sarosis-agents-client(main)';
		const oldRegex = /^[^\n]*@+[^\n]*MINGW[0-9]+[^\n]*\$\s*$/gm;
		assert.strictEqual(oldRegex.test(firstLine), false,
			'旧正则要求同行以 $ 结尾，真实提示符以 ) 结尾 —— 这正是漏清的原因');
	});

	test('清掉 PowerShell 提示符与版本/升级横幅', () => {
		const raw = [
			'PowerShell 7.4.1',
			'A new PowerShell stable release is available: v7.4.6',
			'Upgrade now, or check out the release page at:',
			'  https://aka.ms/PowerShell-Release?tag=v7.4.6',
			'PS G:\\work> npm run compile',
		].join('\n');
		assert.strictEqual(stripShellNoise(raw, { command: 'npm run compile' }), '');
	});

	test('清掉 cmd.exe 提示符与 Windows 横幅', () => {
		const raw = [
			'Microsoft Windows [Version 10.0.22631.4317]',
			'Copyright (C) Microsoft Corporation. All rights reserved.',
			'G:\\work>git status',
		].join('\n');
		assert.strictEqual(stripShellNoise(raw, { command: 'git status' }), '');
	});

	test('清掉 Last login 横幅', () => {
		assert.strictEqual(stripShellNoise('Last login: Fri Aug 21 10:00:00 on ttys001', {}), '');
	});

	test('★ 命令回显被 pty 折行（只回显了前缀）时同样清掉', () => {
		// 日志里回显被截断成 `$cd g:\Cu`，即命令的前缀片段
		const raw = ['user@host MINGW64 /g/x(main)', '$ cd g:\\Cu'].join('\n');
		assert.strictEqual(stripShellNoise(raw, { command: 'cd g:\\CustomWorkspaces\\AIProjects && npx tsc' }), '');
	});

	// ── 控制组：真实输出绝不能被清掉 ──────────────────────────────────

	test('★ 保留真实命令输出（提示符夹着结果的典型形态）', () => {
		const raw = [
			'user@host MINGW64 /g/x(main)',
			'$ npx tsc --noEmit',
			'src/a.ts(10,5): error TS2322: Type mismatch.',
			'src/b.ts(20,1): error TS2304: Cannot find name.',
			'user@host MINGW64 /g/x(main)',
			'$',
		].join('\n');
		const out = stripShellNoise(raw, { command: 'npx tsc --noEmit' });
		assert.match(out, /error TS2322/);
		assert.match(out, /error TS2304/);
		assert.ok(!/MINGW/.test(out), '提示符不应残留');
		assert.ok(!/npx tsc --noEmit/.test(out), '命令回显不应残留');
	});

	test('保留 git status 之类的正常多行输出', () => {
		const raw = [
			'PS G:\\work> git status',
			'On branch main',
			'nothing to commit, working tree clean',
		].join('\n');
		const out = stripShellNoise(raw, { command: 'git status' });
		assert.strictEqual(out, 'On branch main\nnothing to commit, working tree clean');
	});

	test('不误清与命令同名但含额外内容的输出行', () => {
		// 输出里出现 `npm run compile failed` —— 不是纯回显，必须保留
		const out = stripShellNoise('$ npm run compile\nnpm run compile failed with exit 1', { command: 'npm run compile' });
		assert.match(out, /failed with exit 1/);
	});

	test('无 command 上下文时仍能清提示符（回显不清，宁可保留也不误删）', () => {
		const out = stripShellNoise('user@host MINGW64 /g/x(main)\n$ echo hi\nhi', {});
		assert.match(out, /hi/);
		assert.ok(!/MINGW/.test(out));
	});

	test('空输入 → 空串', () => {
		assert.strictEqual(stripShellNoise('', {}), '');
		assert.strictEqual(stripShellNoise('   \n\n  ', {}), '');
	});
});

suite('terminalOutputDiagnosis — createShellNoiseStripper（有状态流式）', () => {

	/** 便捷封装：按给定分块喂入，返回拼好的清理结果。 */
	const runChunks = (chunks: string[], command?: string) => {
		const s = createShellNoiseStripper({ command });
		const parts: string[] = [];
		for (const c of chunks) { const r = s.push(c); if (r) { parts.push(r); } }
		const t = s.flush(); if (t) { parts.push(t); }
		return { text: parts.join('\n'), sawRealOutput: s.sawRealOutput };
	};

	test('★ 见到真实输出后不再剥回显：构建日志中间原样打印命令行也保留', () => {
		// 这是有状态剥离相对「一次性整体清理」的结构性优势：一次性版本无论怎么收窄
		// 判据，都得为「输出中间恰好出现命令原文」这一形态额外打补丁。
		const r = runChunks([
			'$ npm run compile\n',
			'> vssaros@1.0.0 compile\n',
			'npm run compile\n',          // 构建脚本原样回显了命令 —— 必须保留
			'Done.\n',
		], 'npm run compile');
		assert.match(r.text, /vssaros@1\.0\.0 compile/);
		assert.match(r.text, /^npm run compile$/m, '真实输出中的命令原文必须保留');
		assert.match(r.text, /Done\./);
		assert.strictEqual(r.sawRealOutput, true);
	});

	test('★ 跨 chunk 截断的行被正确重组（pty 按任意字节切分）', () => {
		const r = runChunks(['src/a.ts(10,5): err', 'or TS2322: bad\n'], 'npx tsc');
		assert.strictEqual(r.text, 'src/a.ts(10,5): error TS2322: bad');
	});

	test('★ 仅提示符+回显 → sawRealOutput 保持 false（供「命令是否开始产出」判定）', () => {
		const r = runChunks([
			'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/x(main)\n',
			'$ cd g:\\Cu',
		], 'cd g:\\CustomWorkspaces && npx tsc --noEmit');
		assert.strictEqual(r.sawRealOutput, false);
		assert.strictEqual(r.text, '');
	});

	test('提示符在任意位置都剥（尾部提示符必须清，否则空产出判不出来）', () => {
		const r = runChunks([
			'user@host MINGW64 /g/x(main)\n$ git status\n',
			'On branch main\n',
			'user@host MINGW64 /g/x(main)\n$ \n',
		], 'git status');
		assert.strictEqual(r.text.trim(), 'On branch main');
		assert.ok(!/MINGW/.test(r.text));
	});

	test('flush 处理未以换行结尾的尾行', () => {
		const r = runChunks(['partial line without newline'], 'git status');
		assert.strictEqual(r.text, 'partial line without newline');
	});

	test('空 chunk / 全空输入不产出内容', () => {
		const r = runChunks(['', ''], 'x');
		assert.strictEqual(r.text, '');
		assert.strictEqual(r.sawRealOutput, false);
	});
});

suite('terminalOutputDiagnosis — diagnoseTerminalOutput', () => {

	test('★ 日志实测形态 → isEmpty=true（必须能被识别为「结果没拿到」）', () => {
		const raw = 'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/CustomWorkspaces/AIProjects/sarosis-agents-client(main)\n$cd g:\\Cu';
		const d = diagnoseTerminalOutput(raw, 'cd g:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client\\src\\vs\\sessions\\contrib\\agentStudio\\webview && npx tsc --noEmit');
		assert.strictEqual(d.isEmpty, true);
		assert.strictEqual(d.substantive, '');
	});

	test('有真实输出 → isEmpty=false 且保留实质内容', () => {
		const raw = 'PS G:\\work> git status\nOn branch main';
		const d = diagnoseTerminalOutput(raw, 'git status');
		assert.strictEqual(d.isEmpty, false);
		assert.strictEqual(d.substantive, 'On branch main');
	});
});

suite('terminalOutputDiagnosis — isSlowStartCommand', () => {

	test('构建 / 测试 / 安装类识别为慢启动', () => {
		for (const c of [
			'npx tsc --noEmit', 'npm run compile', 'pnpm build', 'yarn test',
			'npx esbuild src/a.ts', 'tsgo --project ./src/tsconfig.json',
			'jest --runInBand', 'pytest -q', 'cargo build', 'go build ./...',
			'mvn package', 'docker build .', 'pip install -r req.txt',
		]) {
			assert.strictEqual(isSlowStartCommand(c), true, c);
		}
	});

	test('★ 轻量命令不算慢启动（避免所有命令都拖满等待窗口）', () => {
		for (const c of ['git status', 'ls -la', 'cat /tmp/x.txt', 'echo hi', 'pwd', 'wc -l a.txt']) {
			assert.strictEqual(isSlowStartCommand(c), false, c);
		}
	});

	test('空命令 → false', () => {
		assert.strictEqual(isSlowStartCommand(''), false);
	});
});

suite('terminalOutputDiagnosis — emptyTerminalOutputMessage', () => {

	test('★ 明确否掉日志里那三种无效规避，并指向 execute_code', () => {
		const msg = emptyTerminalOutputMessage('npx tsc --noEmit', 30_000);
		assert.match(msg, /NO OUTPUT CAPTURED/);
		assert.match(msg, /execute_code/, '必须给出可执行的替代动作');
		assert.match(msg, /redirecting/i, '否掉「重定向到临时文件再 cat」');
		assert.match(msg, /sleep/i, '否掉「加 sleep」');
		assert.match(msg, /Do NOT retry the same command/i, '否掉「原样重试」');
		assert.match(msg, /does NOT mean the command produced no output/i,
			'不得让模型把「没捕获到」误读为「命令确实无输出」');
	});

	test('慢启动命令附加针对性说明', () => {
		assert.match(emptyTerminalOutputMessage('npm run build', 30_000), /build\/test\/install/i);
		assert.ok(!/build\/test\/install/i.test(emptyTerminalOutputMessage('pwd', 6_000)));
	});
});
