/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWindows, isWeb } from '../../../../../base/common/platform.js';
import { resolveShellDialect, isWindowsPlatform, type ShellDialect } from '../../common/shellDialect.js';
import { buildEnvironmentDirective } from '../../common/environmentDirective.js';

/**
 * shell 方言真源的行为契约（2026-08-30，日志 20260829T232635）。
 *
 * 事故根因：方言在三处各自判定，判出三个冲突答案 —— 描述侧说 PowerShell、
 * 执行侧走 Git Bash → 模型照描述写 `Select-Object` → exit 127。
 *
 * ⚠ 平台常量（`isWindows`）是模块级 const，无法在测试里 mock，故分支断言按当前
 * 平台条件化。真正关键的保证（「有 Git Bash 就绝不判成 cmd」）是**平台无关**的，
 * 见下面的用例 —— 它在任何平台上都必须成立，且正是事故的修复点。
 */
suite('shellDialect — 方言单一真源', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const VALID_DIALECTS: readonly ShellDialect[] = ['posix', 'powershell', 'cmd'];

	test('返回值始终是合法方言（任何输入都不产出意外值）', () => {
		for (const input of [true, false, undefined]) {
			assert.ok(VALID_DIALECTS.includes(resolveShellDialect(input)), `输入 ${String(input)} 产出非法方言`);
		}
	});

	test('★★ 平台无关的核心保证：有 Git Bash 就绝不判成 cmd', () => {
		// 这条在任何平台都必须成立，也是本次事故的修复点 ——
		// 修复前 Windows 上即便装了 Git Bash，描述侧仍静态声称 PowerShell/cmd。
		assert.notStrictEqual(resolveShellDialect(true), 'cmd');
	});

	test('幂等：同一输入重复调用结果一致', () => {
		for (const input of [true, false, undefined]) {
			assert.strictEqual(resolveShellDialect(input), resolveShellDialect(input));
		}
	});

	test('Windows 分支：按 Git Bash 探测结果二选一', () => {
		if (!isWindows) { return; } // 非 Windows 平台不适用
		assert.strictEqual(resolveShellDialect(true), 'posix', 'Windows + Git Bash → 必须是 posix');
		assert.strictEqual(resolveShellDialect(false), 'cmd', 'Windows 无 Git Bash → 回退 cmd');
		assert.strictEqual(resolveShellDialect(undefined), 'cmd', '未探测 → 保守回退 cmd（fail-closed）');
	});

	test('非 Windows 分支：探测值不影响结果（恒为 posix）', () => {
		if (isWindows) { return; } // Windows 平台不适用
		assert.strictEqual(resolveShellDialect(true), 'posix');
		assert.strictEqual(resolveShellDialect(false), 'posix');
		assert.strictEqual(resolveShellDialect(undefined), 'posix');
	});

	test('isWindowsPlatform 与平台常量一致（Web 环境不算 Windows 原生 shell）', () => {
		assert.strictEqual(isWindowsPlatform(), isWindows && !isWeb);
	});
});

suite('shellDialect — 与 environmentDirective 同源', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('传入 resolveShellDialect 的结果不抛错，且输出非空', () => {
		for (const input of [true, false, undefined]) {
			const out = buildEnvironmentDirective({ dialect: resolveShellDialect(input) });
			assert.ok(out.includes('## Operating Environment'), '必须有段落标题');
			assert.ok(!out.includes('undefined'), '不得把 undefined 泄漏进提示词');
		}
	});

	test('未探测（undefined 方言）时 Windows 段不得断言单一方言', () => {
		if (!isWindows) { return; }
		const out = buildEnvironmentDirective({});
		// 探测失败时说错方言比不说更贵 —— 必须两段并列，而非断言某一种
		assert.ok(out.includes('Git Bash'), '应说明可能走 Git Bash');
		assert.ok(out.includes('PowerShell/cmd.exe'), '也应说明可能回退 PowerShell/cmd');
		assert.ok(out.includes('Do not assume either dialect'), '应明确要求模型不要假定方言');
	});

	test('★ 事故回归：Windows + Git Bash 时必须下发 POSIX 段、且点名 cmdlet 不存在', () => {
		if (!isWindows) { return; }
		const out = buildEnvironmentDirective({ dialect: resolveShellDialect(true) });
		assert.ok(out.includes('Git Bash'), '应声明实际走 Git Bash');
		assert.ok(out.includes('ARE available'), '应声明 POSIX 命令可用');
		assert.ok(out.includes('are NOT'), '应声明 PowerShell cmdlet 不可用');
		assert.ok(out.includes('exit 127'), '应说明失败码是 127（而非 cmd 的 255）');
		// 修复前这里是「Use PowerShell equivalents: Select-Object …」，正是模型被带偏的地方
		assert.ok(!out.includes('Use PowerShell equivalents'), '不得再下发静态的 PowerShell 等价表');
	});
});
