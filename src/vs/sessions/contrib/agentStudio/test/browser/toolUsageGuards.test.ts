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
	allBlockedWrapUpReminder,
	textSearchLoopWrapUpReminder,
	budgetLowWarning,
	preferGraphSearchReminder,
	advanceSingleToolStreak,
	batchReadOnlyToolsReminder,
} from '../../common/loopReminders.js';
import {
	normalizeFileGlobForSearch,
	searchQueryFingerprint,
	searchOutcomeHint,
} from '../../browser/providers/tool/pathFilterNormalize.js';
import {
	detectStaleWorktreeAccess,
	staleWorktreeWarning,
} from '../../common/worktreeBinding.js';
import {
	rewriteUnixPipelineToPowerShell,
	powerShellEncodedCommand,
} from '../../browser/providers/tool/executeCodeGuards.js';
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
	// 输出要求对齐 MiMo-Code session/prompt/max-steps.txt 的四项必需内容。

	test('hardLimitWrapUpReminder declares tools disabled and demands final answer', () => {
		const msg = hardLimitWrapUpReminder(100);
		assert.ok(msg.includes('<system-reminder>') && msg.includes('</system-reminder>'));
		assert.ok(msg.includes('100/100'), 'should cite the iteration limit');
		assert.ok(msg.includes('DISABLED'), 'should declare tools disabled');
		assert.ok(msg.includes('FINAL ANSWER'), 'should demand a final answer');
		assert.ok(!msg.includes('undefined'), 'should not leak undefined');
	});

	test('hardLimitWrapUpReminder enumerates all four required sections', () => {
		const msg = hardLimitWrapUpReminder(100);
		// ① 预算已达上限的声明 ② 已完成 ③ 未完成/未验证 ④ 下一步建议
		assert.ok(msg.includes('ALL FOUR'), 'should state that four sections are mandatory');
		assert.ok(msg.includes('ACCOMPLISHED'), 'should require what was accomplished');
		assert.ok(msg.includes('UNFINISHED') || msg.includes('UNVERIFIED'), 'should require unfinished items');
		assert.ok(msg.includes('RECOMMENDED NEXT STEPS'), 'should require next-step recommendations');
		assert.ok(msg.includes('overrides ALL other instructions'), 'should assert priority over other instructions');
		// 不能反过来把控制权交回用户（收尾轮之后没有下一轮可用）
		assert.ok(msg.includes('Do not ask the user whether to continue'), 'should forbid asking to continue');
		});

		test('hardLimitWrapUpReminder 封死「把调用写成文本」的退路（XML 泄漏根因）', () => {
		// 成因链（日志 1788006127437 实证）：stable 层每轮下发「需要工具时 emit a NATIVE
		// function call」，而收尾轮 tools 已被置空 + toolChoice='none' → 结构化通道关闭，
		// 模型两难之下**把调用写成文本**当作唯一可行解（iteration 7–9 输出 3230c 伪 XML
		// 标签 `tool_calls:` / `arg_key:` / `tool_sep:`）。
		// 若提醒只说"不要调用工具"，模型会理解成"不能真调，但可以先把调用记下来"——
		// 故必须逐一点名各种文本形式，并声明**任何语法都不执行**。
		const msg = hardLimitWrapUpReminder(100);
		assert.ok(/XML-style tags/.test(msg), 'should explicitly reject XML-style tags');
		assert.ok(/JSON/.test(msg), 'should explicitly reject JSON');
		assert.ok(/code block/.test(msg), 'should explicitly reject markdown code blocks');
		assert.ok(/prose description/.test(msg), 'should explicitly reject prose descriptions');
		assert.ok(/NOT execute either|no syntax works/i.test(msg), 'should state that no textual syntax executes');
		// 同时必须点明「不要当作占位符/备忘写下来」——这正是模型当时的实际行为
		assert.ok(/placeholder|note-to-self/i.test(msg), 'should forbid writing a call as a placeholder');
		});

	// ─── 每一条收尾提醒都必须封死文本退路（日志 1788016519843 实证）────────
	//
	// 收尾轮有**多条**触发路径（迭代上限 / 预算耗尽 / 零进展空转 / 文本搜索连击），
	// 每条注入的 reminder 不同，但都会关掉工具通道。只要有一条漏掉「任何语法都
	// 不执行」这句，模型就会在那条路径上把调用写成文本。
	//
	// 实证：1788016519843 由 `textSearchStreak 8/8` 护栏触发，走的是
	// textSearchLoopWrapUpReminder（当时缺这段）；而 hardLimitWrapUpReminder
	// 因「reason-specific reminder already injected」不再叠加 → 缺口无人补，
	// 模型随即写下 712c 伪 XML。
	//
	// 故此处**逐条枚举**所有收尾提醒，用同一组断言卡住 —— 以后新增收尾路径时，
	// 忘记带上这段会直接测试失败，而不是等到线上泄漏才被发现。

	const ALL_WRAPUP_REMINDERS: ReadonlyArray<readonly [string, string]> = [
		['hardLimitWrapUpReminder', hardLimitWrapUpReminder(100)],
		['allBlockedWrapUpReminder', allBlockedWrapUpReminder(5)],
		['textSearchLoopWrapUpReminder', textSearchLoopWrapUpReminder(8)],
	];

	for (const [name, msg] of ALL_WRAPUP_REMINDERS) {
		test(`★ ${name} 必须封死「把调用写成文本」的退路`, () => {
			assert.ok(/XML-style tags/.test(msg), `${name}: must reject XML-style tags`);
			assert.ok(/JSON/.test(msg), `${name}: must reject JSON`);
			assert.ok(/code block/.test(msg), `${name}: must reject markdown code blocks`);
			assert.ok(/prose description/.test(msg), `${name}: must reject prose descriptions`);
			assert.ok(/NOT execute either|no syntax works/i.test(msg), `${name}: must state no syntax works`);
			assert.ok(/placeholder|note-to-self/i.test(msg), `${name}: must forbid placeholder calls`);
			// 前提：这些提醒确实关掉了工具通道，否则无需封死退路
			assert.ok(/DISABLED|disabled|cannot call/i.test(msg), `${name}: must declare tools disabled`);
		});
	}

	// ─── 单只读工具连击 → 批量并行引导（log 1787302409958：17 轮单工具串行）──

	test('advanceSingleToolStreak: 单只读工具递增；非单只读重置为 0', () => {
		let cur = 0;
		cur = advanceSingleToolStreak(cur, true, 4).streak;   // 1
		cur = advanceSingleToolStreak(cur, true, 4).streak;   // 2
		cur = advanceSingleToolStreak(cur, true, 4).streak;   // 3
		assert.strictEqual(cur, 3);
		cur = advanceSingleToolStreak(cur, false, 4).streak;  // 批量/写工具 → 重置
		assert.strictEqual(cur, 0);
	});

	test('advanceSingleToolStreak: shouldGuide 仅在阈值倍数（4/8…）为 true', () => {
		let cur = 0;
		const seen: boolean[] = [];
		for (let i = 0; i < 8; i++) {
			const r = advanceSingleToolStreak(cur, true, 4);
			cur = r.streak; seen.push(r.shouldGuide);
		}
		assert.deepStrictEqual(seen, [false, false, false, true, false, false, false, true]);
	});

	test('advanceSingleToolStreak: threshold<=0 永不引导（防御）', () => {
		const r = advanceSingleToolStreak(3, true, 0);
		assert.strictEqual(r.streak, 4);
		assert.strictEqual(r.shouldGuide, false);
	});

	test('batchReadOnlyToolsReminder cites streak/tools and demands batching', () => {
		const msg = batchReadOnlyToolsReminder(4, 'search_code, file_read');
		assert.ok(msg.includes('<system-reminder>') && msg.includes('</system-reminder>'));
		assert.ok(msg.includes('4 consecutive rounds'), 'should cite the streak');
		assert.ok(msg.includes('search_code, file_read'), 'should cite the tools actually used');
		assert.ok(msg.includes('round-trip'), 'should explain the real cost');
		assert.ok(msg.includes('SINGLE round'), 'should demand batching');
		assert.ok(msg.includes('depend'), 'should keep the sequential escape hatch');
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

	// ─── 临近预算预警（log 1787214724132：第 50/50 轮起 delegate_task，成果丢弃）──

	test('budgetLowWarning cites remaining rounds and forbids delegating work', () => {
		const msg = budgetLowWarning(1, 50);
		assert.ok(msg.includes('<system-reminder>') && msg.includes('</system-reminder>'));
		assert.ok(msg.includes('1 tool-calling round(s) remain'), 'should cite remaining rounds');
		assert.ok(msg.includes('50'), 'should cite the total budget');
		assert.ok(msg.includes('delegate_task'), 'should name the expensive operation to avoid');
		assert.ok(msg.includes('DISCARDED'), 'should explain why: the result would be discarded');
		assert.ok(!msg.includes('undefined'), 'should not leak undefined');
	});

	// ─── filePattern `|` → `{a,b}` 归一化（log 1787209228496：include 恒 0 命中）──
	// ripgrep / VS Code glob 的 alternation 是 `{a,b}`，`|` 是字面字符 → 不拆则永不命中。

	test('normalizeFileGlobForSearch converts pipe alternation to brace alternation', () => {
		// 公共 **/ 前缀须提升到组前，否则 b.ts / c.ts 丢掉「任意深度」语义
		assert.strictEqual(
			normalizeFileGlobForSearch('**/comfyNodeStyle.ts|schemaLiteGraphNodes.ts|registry.ts'),
			'**/{comfyNodeStyle.ts,schemaLiteGraphNodes.ts,registry.ts}',
		);
		// 裸文件名（无 globstar、无 '/'）整体补 **/
		assert.strictEqual(normalizeFileGlobForSearch('a.ts|b.ts'), '**/{a.ts,b.ts}');
		// 含 '/' 的分支保留相对路径，不补 **/
		assert.strictEqual(normalizeFileGlobForSearch('src/a.ts|src/b.ts'), '{src/a.ts,src/b.ts}');
	});

	test('normalizeFileGlobForSearch keeps single globs unchanged (bare name gets **/)', () => {
		assert.strictEqual(normalizeFileGlobForSearch('*.cpp'), '**/*.cpp');
		assert.strictEqual(normalizeFileGlobForSearch('src/**/*.ts'), 'src/**/*.ts');
		assert.strictEqual(normalizeFileGlobForSearch(''), '');
	});

	// ─── 搜索意图指纹（log 1787211923566 / 1787214724132：换写法重搜绕过熔断）──

	test('searchQueryFingerprint collapses semantically equivalent regex variants', () => {
		const variants = [
			'LoadImage', '\\bLoadImage\\b', 'LoadImage\\s*=',
			'loadimage', '.*LoadImage.*', '(LoadImage)',
		];
		const fps = variants.map(v => searchQueryFingerprint(v));
		for (const fp of fps) {
			assert.strictEqual(fp, fps[0], `all variants must share one fingerprint, got "${fp}" vs "${fps[0]}"`);
		}
		assert.strictEqual(fps[0], 'loadimage');
	});

	test('searchQueryFingerprint keeps distinct targets distinct', () => {
		assert.notStrictEqual(searchQueryFingerprint('LoadImage'), searchQueryFingerprint('SaveImage'));
	});

	// ─── 搜索范围透明化（log 1787217670299：搜主仓 / 读 worktree，模型无从察觉）──

	test('searchOutcomeHint discloses the actual search roots and the .worktrees exclusion', () => {
		const msg = searchOutcomeHint('**/nodeCard.tsx', 1, false, false, ['sarosis-agents-client']);
		assert.ok(msg.includes('Search roots actually used: [sarosis-agents-client]'), 'must echo the roots');
		assert.ok(msg.includes('.worktrees/**'), 'must name the excluded worktree glob');
		assert.ok(msg.includes('STALE'), 'must warn that the worktree copy is stale');
		assert.ok(!msg.includes('undefined'));
	});

	test('searchOutcomeHint omits the roots block when no roots are supplied', () => {
		const msg = searchOutcomeHint('**/x.ts', 1, false);
		assert.ok(!msg.includes('Search roots actually used'), 'no roots → no roots block');
		assert.ok(msg.includes('0 matches with include filter'), 'original guidance preserved');
	});

	// ─── 越界访问未绑定 worktree 副本（log 1787217670299）─────────────────────

	test('detectStaleWorktreeAccess flags an unbound worktree path and maps it back to the main repo', () => {
		const hit = detectStaleWorktreeAccess(
			'g:/repo/.worktrees/feat-chat/src/vs/sessions/a.ts', undefined,
		);
		assert.ok(hit, 'unbound worktree access must be detected');
		assert.strictEqual(hit.branchName, 'feat-chat');
		assert.strictEqual(hit.worktreeRoot, 'g:/repo/.worktrees/feat-chat');
		assert.strictEqual(hit.mainRepoEquivalent, 'g:/repo/src/vs/sessions/a.ts');
	});

	test('detectStaleWorktreeAccess stays silent when the agent IS bound to that worktree', () => {
		assert.strictEqual(
			detectStaleWorktreeAccess(
				'g:/repo/.worktrees/feat-chat/src/a.ts',
				'g:\\repo\\.worktrees\\feat-chat',   // 反斜杠 + 不同大小写也必须视为同一根
			),
			undefined,
		);
		assert.strictEqual(
			detectStaleWorktreeAccess('G:/REPO/.worktrees/Feat-Chat/src/a.ts', 'g:/repo/.worktrees/feat-chat'),
			undefined,
		);
	});

	test('detectStaleWorktreeAccess flags a DIFFERENT worktree than the bound one', () => {
		const hit = detectStaleWorktreeAccess(
			'g:/repo/.worktrees/feat-workflow/src/a.ts', 'g:/repo/.worktrees/feat-chat',
		);
		assert.ok(hit, 'a different worktree is still out of bounds');
		assert.strictEqual(hit.branchName, 'feat-workflow');
	});

	test('detectStaleWorktreeAccess ignores non-worktree paths and the bare container dir', () => {
		assert.strictEqual(detectStaleWorktreeAccess('g:/repo/src/vs/a.ts', undefined), undefined);
		// `.worktrees` 本身（无分支段）不算访问某个 worktree
		assert.strictEqual(detectStaleWorktreeAccess('g:/repo/.worktrees', undefined), undefined);
		assert.strictEqual(detectStaleWorktreeAccess('', undefined), undefined);
		assert.strictEqual(detectStaleWorktreeAccess(undefined, undefined), undefined);
	});

	test('staleWorktreeWarning names the action, the branch and the main-repo path', () => {
		const hit = detectStaleWorktreeAccess('g:/repo/.worktrees/feat-chat/src/a.ts', undefined)!;
		const msg = staleWorktreeWarning(hit, 'shell command');
		assert.ok(msg.includes('shell command'));
		assert.ok(msg.includes('feat-chat'));
		assert.ok(msg.includes('g:/repo/src/a.ts'), 'must offer the main-repo equivalent');
		assert.ok(msg.includes('search_code'), 'must explain search cannot see it');
	});

	// ─── Unix 管道 → PowerShell 自动改写（log 1787217670299：模型连发 3 次 grep）──

	test('rewriteUnixPipelineToPowerShell maps head/tail to Select-Object', () => {
		assert.strictEqual(
			rewriteUnixPipelineToPowerShell('git log --oneline | head -20')?.script,
			'git log --oneline | Select-Object -First 20',
		);
		assert.strictEqual(
			rewriteUnixPipelineToPowerShell('git log | head -n 5')?.script,
			'git log | Select-Object -First 5',
		);
		// 裸 head 默认 10 行（与 coreutils 一致）
		assert.strictEqual(
			rewriteUnixPipelineToPowerShell('git log | head')?.script,
			'git log | Select-Object -First 10',
		);
		assert.strictEqual(
			rewriteUnixPipelineToPowerShell('git log | tail -3')?.script,
			'git log | Select-Object -Last 3',
		);
	});

	test('rewriteUnixPipelineToPowerShell maps grep to Select-String with correct case semantics', () => {
		// grep 默认区分大小写，Select-String 默认不区分 → 必须补 -CaseSensitive
		const plain = rewriteUnixPipelineToPowerShell('type a.ts | grep LoadImage');
		assert.strictEqual(plain?.script, "type a.ts | Select-String -CaseSensitive -Pattern 'LoadImage'");
		// -i 则相反：不加 -CaseSensitive
		const ci = rewriteUnixPipelineToPowerShell('type a.ts | grep -i loadimage');
		assert.strictEqual(ci?.script, "type a.ts | Select-String -Pattern 'loadimage'");
		// -v → -NotMatch；-n 被忽略（Select-String 自带行号）
		const inv = rewriteUnixPipelineToPowerShell('type a.ts | grep -vn foo');
		assert.strictEqual(inv?.script, "type a.ts | Select-String -CaseSensitive -NotMatch -Pattern 'foo'");
		// -F → -SimpleMatch
		assert.ok(rewriteUnixPipelineToPowerShell('type a.ts | grep -F "a.b"')?.script.includes('-SimpleMatch'));
	});

	test('rewriteUnixPipelineToPowerShell escapes single quotes inside the pattern', () => {
		const r = rewriteUnixPipelineToPowerShell("type a.ts | grep \"it's\"");
		assert.strictEqual(r?.script, "type a.ts | Select-String -CaseSensitive -Pattern 'it''s'");
	});

	test('rewriteUnixPipelineToPowerShell chains multiple unix stages', () => {
		const r = rewriteUnixPipelineToPowerShell('git log | grep fix | head -5');
		assert.strictEqual(r?.script, "git log | Select-String -CaseSensitive -Pattern 'fix' | Select-Object -First 5");
		assert.strictEqual(r?.notes.length, 2, 'both rewritten stages must be reported');
	});

	test('rewriteUnixPipelineToPowerShell refuses anything it cannot map safely', () => {
		// sed / awk 语义无法一一对应
		assert.strictEqual(rewriteUnixPipelineToPowerShell("type a | sed 's/x/y/'"), undefined);
		assert.strictEqual(rewriteUnixPipelineToPowerShell('type a | awk \'{print $1}\''), undefined);
		// grep -r（递归 + 目录操作数）应交给 search_code，不猜
		assert.strictEqual(rewriteUnixPipelineToPowerShell('grep -r LoadImage src/'), undefined);
		// 未知短选项 / 长选项
		assert.strictEqual(rewriteUnixPipelineToPowerShell('type a | grep -A3 foo'), undefined);
		assert.strictEqual(rewriteUnixPipelineToPowerShell('type a | grep --color foo'), undefined);
		// head -c 字节模式
		assert.strictEqual(rewriteUnixPipelineToPowerShell('type a | head -c 100'), undefined);
		// 串联（&&/;）不改写：PowerShell 5 不支持 &&
		assert.strictEqual(rewriteUnixPipelineToPowerShell('cd x && type a | head -5'), undefined);
		// 无 Unix 段
		assert.strictEqual(rewriteUnixPipelineToPowerShell('git status'), undefined);
	});

	test('rewriteUnixPipelineToPowerShell does not split a pipe inside quotes', () => {
		const r = rewriteUnixPipelineToPowerShell('type a.ts | grep "foo|bar"');
		assert.strictEqual(r?.script, "type a.ts | Select-String -CaseSensitive -Pattern 'foo|bar'");
	});

	test('powerShellEncodedCommand emits UTF-16LE base64 with no shell metacharacters', () => {
		// 用可预测的编码器验证字节序（真实调用注入 encodeBase64(VSBuffer)）
		const captured: number[][] = [];
		const cmd = powerShellEncodedCommand('AB', bytes => { captured.push([...bytes]); return 'BASE64'; });
		assert.deepStrictEqual(captured[0], [0x41, 0x00, 0x42, 0x00], 'UTF-16LE little-endian');
		assert.strictEqual(cmd, 'powershell -NoProfile -NonInteractive -EncodedCommand BASE64');
		// 载荷位置不得含 cmd.exe / PowerShell 会解释的字符
		assert.ok(!/["'|&^%<>]/.test(cmd), 'encoded form must be shell-metacharacter free');
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
