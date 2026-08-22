/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	shellPlatformGuidance,
	windowsDualShellGuidance,
	type ShellDialect,
} from '../../browser/providers/tool/shellPlatformPrompt.js';
import { GLOBAL_SYSTEM_PREFIX, GLOBAL_SYSTEM_PREFIX_SUBAGENT } from '../../common/chatModeConfig.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('shellPlatformPrompt — per-platform 工具映射表', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const dialects: ShellDialect[] = ['posix', 'powershell', 'cmd'];

	test('三种方言都给出「用本产品工具替代 shell」的映射', () => {
		for (const d of dialects) {
			const g = shellPlatformGuidance(d, 'terminal');
			assert.ok(g.includes('search_code'), `${d}: 应引导 search_code`);
			assert.ok(g.includes('search_files'), `${d}: 应引导 search_files`);
			assert.ok(g.includes('search_graph'), `${d}: 应引导 search_graph`);
			assert.ok(g.includes('file_read'), `${d}: 应引导 file_read`);
			assert.ok(g.includes('patch'), `${d}: 应引导 patch`);
			assert.ok(g.includes('NOT '), `${d}: 应明确指出不要用的 shell 写法`);
			assert.ok(!g.includes('undefined'), `${d}: 不应泄漏 undefined`);
		}
	});

	test('方言特有的「避免写法」正确分化', () => {
		const posix = shellPlatformGuidance('posix', 'terminal');
		assert.ok(posix.includes('grep'), 'posix 应提及 grep');
		assert.ok(posix.includes('sed -i'), 'posix 应提及 sed -i');

		const ps = shellPlatformGuidance('powershell', 'terminal');
		assert.ok(ps.includes('Select-String'), 'powershell 应提及 Select-String');
		assert.ok(ps.includes('Get-ChildItem'), 'powershell 应提及 Get-ChildItem');

		const cmd = shellPlatformGuidance('cmd', 'terminal');
		assert.ok(cmd.includes('findstr'), 'cmd 应提及 findstr');
		assert.ok(cmd.includes('dir /s'), 'cmd 应提及 dir /s');
	});

	test('Windows 方言声明 Unix 命令会被执行前拒绝', () => {
		for (const d of ['powershell', 'cmd'] as ShellDialect[]) {
			const g = shellPlatformGuidance(d, 'terminal');
			assert.ok(g.includes('rejected before execution'), `${d}: 应声明执行前拒绝`);
			assert.ok(/head\/tail\/grep\/sed\/awk/.test(g), `${d}: 应列出被拒的 Unix 命令`);
		}
	});

	test('Windows 方言给出 PowerShell cmdlet 的正确包裹写法（防 exit 255）', () => {
		for (const d of ['powershell', 'cmd'] as ShellDialect[]) {
			const g = shellPlatformGuidance(d, 'terminal');
			assert.ok(g.includes('powershell -NoProfile -Command'), `${d}: 应给出包裹写法`);
			assert.ok(g.includes('exit 255'), `${d}: 应说明裸用 cmdlet 的后果`);
		}
	});

	test('Windows 方言劝阻为截断输出而加 Select-Object/more（掐掉 Out-String 动机）', () => {
		for (const d of ['powershell', 'cmd'] as ShellDialect[]) {
			const g = shellPlatformGuidance(d, 'terminal');
			assert.ok(g.includes('truncated automatically'), `${d}: 应说明输出已自动截断`);
			assert.ok(g.includes('do NOT add'), `${d}: 应劝阻手动截断`);
		}
	});

	test('保留 shell 的正当用途（避免过度劝退）', () => {
		for (const d of dialects) {
			const g = shellPlatformGuidance(d, 'terminal');
			assert.ok(/builds, tests, package managers, git/.test(g), `${d}: 应说明 shell 的正当用途`);
			assert.ok(g.includes('terminal'), `${d}: 应自指工具名`);
		}
	});

	test('工具名自指正确（terminal / execute_code 各自渲染）', () => {
		assert.ok(shellPlatformGuidance('posix', 'execute_code').includes('Reserve execute_code'));
		assert.ok(shellPlatformGuidance('posix', 'terminal').includes('Reserve terminal'));
	});

	test('windowsDualShellGuidance 覆盖 Git Bash 存在与缺失两种情况', () => {
		const g = windowsDualShellGuidance('terminal');
		assert.ok(g.includes('Git Bash (POSIX) when installed'), '应声明装了 Git Bash 时走 POSIX');
		assert.ok(g.includes('If Git Bash is NOT installed'), '应覆盖未安装的回退路径');
		assert.ok(g.includes('C:/dir/file'), '应给出正斜杠路径示例');
		assert.ok(g.includes('cmd /c'), '应给出 Windows 原生命令的包裹方式');
		assert.ok(g.includes('exit 255'), '应说明裸用 cmdlet 的后果');
		assert.ok(g.includes('search_code'), '应包含工具映射表');
		assert.ok(!g.includes('undefined'), '不应泄漏 undefined');
	});
});

suite('chatModeConfig — 批量工具调用常驻段', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('主代理与子代理前缀都包含批量引导段', () => {
		for (const [label, prefix] of [['main', GLOBAL_SYSTEM_PREFIX], ['subagent', GLOBAL_SYSTEM_PREFIX_SUBAGENT]] as const) {
			assert.ok(prefix.includes('Batch independent tool calls'), `${label}: 应包含批量引导段标题`);
			assert.ok(prefix.includes('ONE response'), `${label}: 应要求合并到一个响应`);
			assert.ok(prefix.includes('round-trip'), `${label}: 应解释真实成本`);
			assert.ok(prefix.includes('3–5'), `${label}: 应给出具体批量规模`);
			assert.ok(prefix.includes('genuinely depends'), `${label}: 应保留串行逃生舱`);
		}
	});

	test('批量段列出的都是只读工具（不诱导并行写操作）', () => {
		const idx = GLOBAL_SYSTEM_PREFIX.indexOf('Batch independent tool calls');
		assert.ok(idx >= 0);
		const end = GLOBAL_SYSTEM_PREFIX.indexOf('When in doubt and the calls are independent', idx);
		assert.ok(end > idx, '应能定位批量段结尾');
		const section = GLOBAL_SYSTEM_PREFIX.slice(idx, end);
		for (const t of ['search_code', 'search_files', 'search_graph', 'file_read', 'file_list']) {
			assert.ok(section.includes(t), `批量段应列出只读工具 ${t}`);
		}
		// 写工具不应出现在批量段（避免诱导并行写操作）
		assert.ok(!section.includes('file_write'), '不应把 file_write 列为可批量');
	});

	test('子代理前缀仍不含委派诱导段（避免递归委派事故）', () => {
		assert.ok(!GLOBAL_SYSTEM_PREFIX_SUBAGENT.includes('PARALLEL WORK GOES THROUGH SUB-AGENTS'),
			'子代理不应看到委派段');
		assert.ok(!GLOBAL_SYSTEM_PREFIX_SUBAGENT.includes('code_explorer_subagent_usage'),
			'子代理不应看到 code-explorer 委派用法');
		assert.ok(GLOBAL_SYSTEM_PREFIX.includes('PARALLEL WORK GOES THROUGH SUB-AGENTS'),
			'主代理应保留委派段');
	});

	test('委派段与批量段不再自相矛盾（旧括号附注已收敛为交叉引用）', () => {
		assert.ok(GLOBAL_SYSTEM_PREFIX.includes('see "Batch independent tool calls" below'),
			'委派段应交叉引用批量段而非重复其内容');
	});
});
