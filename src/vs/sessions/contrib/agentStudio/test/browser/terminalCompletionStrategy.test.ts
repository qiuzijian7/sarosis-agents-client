/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 终端完成判定策略回归测试（2026-08-22，横向对标五家开源实现后的重构）。
 *
 * 钉住两件事：
 *  1. 分档语义 —— 有 shell integration 就绝不该落回「靠计时器猜」的 none 档；
 *  2. `none` 档的提示符启发式 —— 「没回到提示符就继续等」是替代「按命令名猜慢启动」
 *     的核心判据，一旦退回「idle 到点即收工」，日志 1787324352413 的输出全丢会复现。
 */

import assert from 'assert';
import {
	pickTerminalStrategy, detectsCommonPromptPattern, lastNonEmptyLine, decideIdleWaitAction,
} from '../../browser/providers/tool/terminalCompletionStrategy.js';

suite('terminalCompletionStrategy — pickTerminalStrategy', () => {

	test('rich command detection → rich 档（事件驱动 + 真实 exitCode）', () => {
		assert.strictEqual(
			pickTerminalStrategy({ hasCommandDetection: true, hasRichCommandDetection: true }), 'rich');
	});

	test('有 CommandDetection 但非 rich → basic 档（仍事件驱动）', () => {
		assert.strictEqual(
			pickTerminalStrategy({ hasCommandDetection: true, hasRichCommandDetection: false }), 'basic');
	});

	test('★ 无 CommandDetection → none 档（唯一允许靠计时器推断的情形）', () => {
		assert.strictEqual(
			pickTerminalStrategy({ hasCommandDetection: false, hasRichCommandDetection: false }), 'none');
	});

	test('★ hasRich 为真但能力缺失 → 仍是 none（能力对象才是权威）', () => {
		// 防御矛盾输入：不能因为一个布尔标志就假装有事件源
		assert.strictEqual(
			pickTerminalStrategy({ hasCommandDetection: false, hasRichCommandDetection: true }), 'none');
	});
});

suite('terminalCompletionStrategy — detectsCommonPromptPattern', () => {

	test('识别各家 shell 的提示符', () => {
		const cases: [string, string][] = [
			['PS G:\\work>', 'PowerShell'],
			['PS G:\\work> ', 'PowerShell 带尾空格'],
			['G:\\work>', 'cmd.exe'],
			['qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/x(main)\n$ ', 'Git Bash 第二行'],
			['user@host:~/project$', 'POSIX'],
			['root@host:/#', 'root'],
			['>>>', 'Python REPL'],
			['\u276f', 'starship'],
			['some-prompt%', 'zsh 百分号'],
		];
		for (const [line, label] of cases) {
			const tail = line.includes('\n') ? line.split('\n').pop()! : line;
			assert.strictEqual(detectsCommonPromptPattern(tail).detected, true, label);
		}
	});

	test('★ 命令输出行不被误判为提示符（否则会提前收工丢输出）', () => {
		for (const line of [
			'src/a.ts(10,5): error TS2322: Type mismatch.',
			'Found 3 errors in 2 files.',
			'  12 passing (7ms)',
			'On branch main',
			'Compiling...',
		]) {
			assert.strictEqual(detectsCommonPromptPattern(line).detected, false, line);
		}
	});

	test('空行 / 纯空白 → 未检测到（不能当成命令已结束）', () => {
		assert.strictEqual(detectsCommonPromptPattern('').detected, false);
		assert.strictEqual(detectsCommonPromptPattern('    ').detected, false);
	});

	test('reason 始终有值（供日志复盘判定过程）', () => {
		assert.ok(detectsCommonPromptPattern('PS G:\\x>').reason.length > 0);
		assert.ok(detectsCommonPromptPattern('building...').reason.length > 0);
	});
});

suite('terminalCompletionStrategy — lastNonEmptyLine', () => {

	test('跳过尾部空行取最后一个非空行', () => {
		assert.strictEqual(lastNonEmptyLine('a\nb\n\n\n'), 'b');
	});

	test('★ 保留提示符行的尾随空格（`$ ` 的空格是判据的一部分）', () => {
		assert.strictEqual(lastNonEmptyLine('out\n$ '), '$ ');
	});

	test('空输入 → 空串', () => {
		assert.strictEqual(lastNonEmptyLine(''), '');
		assert.strictEqual(lastNonEmptyLine('\n\n'), '');
	});
});

suite('terminalCompletionStrategy — decideIdleWaitAction', () => {

	test('★ 日志场景：只有提示符+回显、命令还没产出 → extend（不能收工）', () => {
		// 逐字取自日志 1787324352413 L8164：这正是原实现 resolve('') 收工的时刻
		const collected = [
			'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/CustomWorkspaces/AIProjects/sarosis-agents-client(main)',
			'$ cd g:\\Cu',
		].join('\n');
		// 末行是被折断的命令回显 `$ cd g:\Cu` —— 不以 $ 结尾，故不是提示符
		const action = decideIdleWaitAction({ collectedOutput: collected, elapsedMs: 1500, maxWaitMs: 30_000 });
		assert.strictEqual(action.kind, 'extend', '命令尚未回到提示符，必须继续等');
	});

	test('★ 输出结束并回到提示符 → done', () => {
		const collected = [
			'$ npx tsc --noEmit',
			'src/a.ts(1,1): error TS1005',
			'qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/x(main)',
			'$ ',
		].join('\n');
		const action = decideIdleWaitAction({ collectedOutput: collected, elapsedMs: 5_000, maxWaitMs: 30_000 });
		assert.strictEqual(action.kind, 'done');
	});

	test('★ 达到最长等待 → 无条件 done（防无限等待）', () => {
		const action = decideIdleWaitAction({
			collectedOutput: 'still building...', elapsedMs: 30_000, maxWaitMs: 30_000,
		});
		assert.strictEqual(action.kind, 'done');
		assert.match(action.reason, /max wait/);
	});

	test('超过最长等待也 done', () => {
		const action = decideIdleWaitAction({
			collectedOutput: 'building', elapsedMs: 45_000, maxWaitMs: 30_000,
		});
		assert.strictEqual(action.kind, 'done');
	});

	test('★ 完全无输出（启动期静默）→ extend，这是慢启动命令的关键路径', () => {
		const action = decideIdleWaitAction({ collectedOutput: '', elapsedMs: 1_500, maxWaitMs: 15_000 });
		assert.strictEqual(action.kind, 'extend');
	});

	test('reason 用于日志复盘，两种分支都必须有', () => {
		const a = decideIdleWaitAction({ collectedOutput: '$ ', elapsedMs: 1, maxWaitMs: 9 });
		const b = decideIdleWaitAction({ collectedOutput: 'x', elapsedMs: 1, maxWaitMs: 9 });
		assert.ok(a.reason.length > 0);
		assert.ok(b.reason.length > 0);
	});
});
