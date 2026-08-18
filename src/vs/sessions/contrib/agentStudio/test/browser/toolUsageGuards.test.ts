/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectTerminalSearchCommand,
	terminalSearchCommandHint,
	TERMINAL_SEARCH_COMMAND_PATTERNS,
} from '../../browser/providers/tool/terminalCommandGuards.js';
import {
	softBudgetWrapUpReminder,
	hardLimitWrapUpReminder,
	preferGraphSearchReminder,
} from '../../common/loopReminders.js';
import {
	STRUCTURAL_SEARCH_TOOL_NAMES,
	TEXT_SEARCH_TOOL_NAMES,
} from '../../common/searchToolGroups.js';

suite('ToolUsageGuards — terminal 搜索命令护栏 / 搜索引导提醒', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── terminal 搜索命令检测：命中场景 ────────────────────────────────────

	test('detects Unix find -iname (log 1785224874547 repro)', () => {
		const hit = detectTerminalSearchCommand(
			'find "f:/gr_qiuzijian_main/ue5ea/Engine/Source/Runtime/CoreUObject" -iname "*garbage*" -o -iname "*gc*cluster*" 2>/dev/null | grep -iE "garbage|gc" | head -40'
		);
		assert.ok(hit, 'should detect find -iname');
		assert.strictEqual(hit!.id, 'posix-find-by-name');
	});

	test('detects Unix find -name with unquoted relative path', () => {
		const hit = detectTerminalSearchCommand('find . -name "*.ts" -type f');
		assert.ok(hit);
		assert.strictEqual(hit!.id, 'posix-find-by-name');
	});

	test('detects grep -r recursive content search', () => {
		const hit = detectTerminalSearchCommand('grep -r "TODO" ./src');
		assert.ok(hit);
		assert.strictEqual(hit!.id, 'grep-recursive');
	});

	test('detects PowerShell Get-ChildItem -Recurse', () => {
		const hit = detectTerminalSearchCommand(
			'Get-ChildItem -Path "f:\\proj\\Engine" -Recurse -Include "GarbageCollection.*","GCCluster.*" | ForEach-Object { $_.FullName }'
		);
		assert.ok(hit);
		assert.strictEqual(hit!.id, 'ps-gci-recurse');
	});

	test('detects gci alias with -Recurse', () => {
		const hit = detectTerminalSearchCommand('gci .\\src -Recurse -Filter *.ts');
		assert.ok(hit);
		assert.strictEqual(hit!.id, 'ps-gci-recurse');
	});

	test('detects Select-String -Path content search', () => {
		const hit = detectTerminalSearchCommand('Select-String -Path .\\src\\*.ts -Pattern "TODO"');
		assert.ok(hit);
		assert.strictEqual(hit!.id, 'ps-select-string');
	});

	test('detects cmd dir /s and findstr /s', () => {
		assert.strictEqual(detectTerminalSearchCommand('dir /s /b *.csproj')!.id, 'cmd-dir-recurse');
		assert.strictEqual(detectTerminalSearchCommand('findstr /s /i "error" *.log')!.id, 'findstr-recurse');
	});

	// ─── terminal 搜索命令检测：不命中场景（避免误伤正常命令）────────────────

	test('does NOT flag build / run / VCS commands', () => {
		const negatives = [
			'npm run build',
			'npm test -- --grep "search"',
			'git status',
			'git log --oneline -10',
			'node out/__tests__/runAllTests.js',
			'dir',
			'dir /b',
			'ls',
			'Get-ChildItem -Path .\\src',
			'tsc --noEmit',
			'echo hello | find "ell"',        // Windows find 非 -name 形态（内容过滤，且非递归）
			'cat package.json | grep version', // 管道内过滤非递归
		];
		for (const cmd of negatives) {
			assert.strictEqual(detectTerminalSearchCommand(cmd), undefined, `should NOT flag: ${cmd}`);
		}
	});

	// ─── hint 文案 ──────────────────────────────────────────────────────────

	test('hint mentions the matched pattern and the search tool advice', () => {
		const hit = detectTerminalSearchCommand('Get-ChildItem . -Recurse -Include *.ts')!;
		const hint = terminalSearchCommandHint(hit);
		assert.ok(hint.includes('tool-hint'), 'should be tagged as tool-hint');
		assert.ok(hint.includes('search_files'), 'filename search should advise search_files');
		assert.ok(hint.includes(hit.label), 'should include the pattern label');
	});

	test('content-search patterns advise content tools', () => {
		const hit = detectTerminalSearchCommand('grep -rn "foo" .')!;
		const hint = terminalSearchCommandHint(hit);
		assert.ok(hint.includes('search_code') || hint.includes('search_files'), 'should advise content search tools');
	});

	test('pattern table is data-driven: every entry has id/pattern/label/advice', () => {
		for (const p of TERMINAL_SEARCH_COMMAND_PATTERNS) {
			assert.ok(p.id && p.label && p.advice, `pattern ${p.id} should be fully described`);
			assert.ok(p.pattern instanceof RegExp, `pattern ${p.id} should be a RegExp`);
		}
	});

	// ─── 软预算收尾提醒 ─────────────────────────────────────────────────────

	test('softBudgetWrapUpReminder contains elapsed/budget and wrap-up instructions', () => {
		const msg = softBudgetWrapUpReminder(310, 300);
		assert.ok(msg.includes('<system-reminder>') && msg.includes('</system-reminder>'));
		assert.ok(msg.includes('310s') && msg.includes('300s'), 'should cite elapsed and budget');
		assert.ok(msg.includes('STOP further exploration'), 'should demand stopping exploration');
		assert.ok(!msg.includes('undefined'), 'should not leak undefined');
	});

	// ─── 硬上限总结轮提醒（log 1787019843599：50 轮硬停截断、无结论）──────

	test('hardLimitWrapUpReminder declares tools disabled and demands final answer', () => {
		const msg = hardLimitWrapUpReminder(50);
		assert.ok(msg.includes('<system-reminder>') && msg.includes('</system-reminder>'));
		assert.ok(msg.includes('50/50'), 'should cite the iteration limit');
		assert.ok(msg.includes('DISABLED'), 'should declare tools disabled');
		assert.ok(msg.includes('FINAL ANSWER'), 'should demand a final answer');
		assert.ok(msg.includes('remains unverified'), 'should ask to list unverified items');
		assert.ok(!msg.includes('undefined'), 'should not leak undefined');
	});

	// ─── search_graph 引导提醒 + 工具分组 ───────────────────────────────────

	test('preferGraphSearchReminder cites streak and available structural tools', () => {
		const msg = preferGraphSearchReminder(4, 'search_graph, query_graph, get_architecture');
		assert.ok(msg.includes('<system-reminder>'));
		assert.ok(msg.includes('4 times'), 'should cite the streak count');
		assert.ok(msg.includes('search_graph, query_graph, get_architecture'), 'should list available structural tools');
		assert.ok(msg.includes('exact string / filename matching'), 'should scope search_files usage');
	});

	test('search tool groups are disjoint and cover the expected tools', () => {
		for (const name of TEXT_SEARCH_TOOL_NAMES) {
			assert.ok(!STRUCTURAL_SEARCH_TOOL_NAMES.has(name), `${name} must not be in both groups`);
		}
		assert.ok(TEXT_SEARCH_TOOL_NAMES.has('search_files'));
		assert.ok(STRUCTURAL_SEARCH_TOOL_NAMES.has('search_graph'));
		assert.ok(STRUCTURAL_SEARCH_TOOL_NAMES.has('get_architecture'));
		assert.ok(STRUCTURAL_SEARCH_TOOL_NAMES.has('search_code'));
	});
});
