/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	annotateCommandFailure,
	annotateMaskedSuccess,
	renderFailureHint,
} from '../../browser/providers/tool/commandFailureHints.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('commandFailureHints — 退出码专项提示', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('126 不可执行 → 引导用解释器或 chmod +x', () => {
		const h = annotateCommandFailure(126, '');
		assert.ok(h, '126 应有提示');
		assert.strictEqual(h.id, 'exit-126');
		assert.ok(h.text.includes('NOT executable'));
		assert.ok(h.text.includes('chmod +x'), '应给出 chmod 方案');
		assert.ok(/python3 <script>|node <script>|bash <script>/.test(h.text), '应给出解释器方案');
		assert.ok(h.text.includes('Do not retry unchanged'), '应明确别原样重试');
	});

	test('137 OOM kill → 引导缩小工作集而非重试', () => {
		const h = annotateCommandFailure(137, '');
		assert.ok(h);
		assert.strictEqual(h.id, 'exit-137');
		assert.ok(h.text.includes('out-of-memory'));
		assert.ok(h.text.includes('chunks'), '应引导分块处理');
		assert.ok(h.text.includes('same limit'), '应说明重试无效');
	});

	test('124 超时 → 引导缩小范围/调 timeout/后台运行', () => {
		const h = annotateCommandFailure(124, '');
		assert.ok(h);
		assert.strictEqual(h.id, 'exit-124');
		assert.ok(h.text.includes('timeout'));
		assert.ok(h.text.includes('120s'), '应给出 timeout 上限');
		assert.ok(h.text.includes('background'), '应提到后台方案');
	});

	test('127 / 139 亦有专项提示', () => {
		assert.strictEqual(annotateCommandFailure(127, '')?.id, 'exit-127');
		assert.strictEqual(annotateCommandFailure(139, '')?.id, 'exit-139');
	});

	test('未收录的退出码不产出提示（宁缺毋滥）', () => {
		assert.strictEqual(annotateCommandFailure(1, ''), undefined);
		assert.strictEqual(annotateCommandFailure(2, ''), undefined);
		assert.strictEqual(annotateCommandFailure(undefined, ''), undefined);
	});
});

suite('commandFailureHints — 错误文本模式（确定性 vs 瞬时）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('确定性失败明确告知「别重试」', () => {
		const cases: Array<[string, string]> = [
			['CONFLICT (content): Merge conflict in src/a.ts', 'git-merge-conflict'],
			['nothing to commit, working tree clean', 'git-nothing-to-commit'],
			['fatal: The current branch feat has no upstream branch', 'git-no-upstream'],
			['mkdir: cannot create directory: File exists', 'already-exists'],
			['cat: /tmp/x.txt: No such file or directory', 'no-such-file'],
			['open /etc/hosts: Permission denied', 'permission-denied'],
			["ModuleNotFoundError: No module named 'requests'", 'python-no-module'],
			['npm ERR! Missing script: "buildx"', 'npm-missing-script'],
			['Error: listen EADDRINUSE: address already in use :::3000', 'port-in-use'],
		];
		for (const [output, expectedId] of cases) {
			const h = annotateCommandFailure(1, output);
			assert.ok(h, `应命中: ${output}`);
			assert.strictEqual(h.id, expectedId, `id 应为 ${expectedId}`);
			assert.ok(
				/Do not retry|will keep failing|retrying/i.test(h.text),
				`${expectedId}: 应表态重试无用`,
			);
		}
	});

	test('瞬时失败明确告知「稍后/可重试」', () => {
		const rate = annotateCommandFailure(1, 'API rate limit exceeded for user');
		assert.strictEqual(rate?.id, 'rate-limited');
		assert.ok(rate.text.includes('retry this operation later'), '限流应引导稍后重试');

		const net = annotateCommandFailure(1, 'curl: (7) Failed to connect: ECONNREFUSED');
		assert.strictEqual(net?.id, 'network-transient');
		assert.ok(net.text.includes('Retrying once is reasonable'), '网络应允许一次重试');
		assert.ok(net.text.includes('rather than looping'), '应防止死循环重试');

		const busy = annotateCommandFailure(1, 'EBUSY: resource busy or locked');
		assert.strictEqual(busy?.id, 'resource-busy');
		assert.ok(busy.text.includes('single retry'), '占用应允许单次重试');
	});

	test('中文本地化措辞同样命中（Windows 中文 shell）', () => {
		const h = annotateCommandFailure(1, '系统找不到指定的路径。');
		assert.strictEqual(h?.id, 'no-such-file');
		const h2 = annotateCommandFailure(1, '拒绝访问。');
		assert.strictEqual(h2?.id, 'permission-denied');
	});

	test('裸 python（Windows）有专项提示', () => {
		const h = annotateCommandFailure(1, "'python' 不是内部或外部命令，也不是可运行的程序");
		assert.strictEqual(h?.id, 'bare-python-windows');
		assert.ok(h.text.includes('python3'), '应引导用 python3');
	});

	test('文本模式优先于退出码（更具体者胜出）', () => {
		// 同时满足 exit 124 与 rate limit 文本 → 应取文本模式
		const h = annotateCommandFailure(124, 'API rate limit exceeded');
		assert.strictEqual(h?.id, 'rate-limited');
	});

	test('首个匹配胜出（每次最多一条，不堆叠）', () => {
		// 同时含 merge conflict 与 permission denied → 取更靠前的 merge conflict
		const h = annotateCommandFailure(1, 'CONFLICT (content): Merge conflict\nPermission denied');
		assert.strictEqual(h?.id, 'git-merge-conflict');
	});

	test('普通失败输出不产出提示', () => {
		assert.strictEqual(annotateCommandFailure(1, 'TypeError: cannot read property x'), undefined);
		assert.strictEqual(annotateCommandFailure(1, ''), undefined);
	});
});

suite('commandFailureHints — 渲染', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('renderFailureHint 统一加 [next-step] 前缀', () => {
		const h = annotateCommandFailure(137, '')!;
		const rendered = renderFailureHint(h);
		assert.ok(rendered.startsWith('[next-step] '), '应有统一前缀便于模型识别');
		assert.ok(rendered.includes('out-of-memory'));
		assert.ok(!rendered.includes('undefined'));
	});
});

// ── ★ 点名缺失的具体命令（2026-08-30，日志 20260829T232635 事故）────────────
//
// 事故：模型写 `... | Select-Object -Last 30; Write-Host "EXIT:$LASTEXITCODE"`，
// 在 Git Bash 里得到 `Select-Object: command not found`。原提示只有通用文案
// 「verify the executable name…try `which <cmd>`」，模型要多花一轮才能自己
// 认出是哪个命令不存在。点名后一轮即懂。

suite('commandFailureHints — command-not-found 点名', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ 事故原样：bash 的 `X: command not found` 点名 X', () => {
		const h = annotateCommandFailure(127, 'Select-Object: command not found; Write-Host: command not found');
		assert.ok(h);
		assert.strictEqual(h.id, 'command-not-found');
		assert.ok(h.text.includes('`Select-Object`'), '应点名缺失的命令');
		assert.ok(h.text.includes('do not retry unchanged'));
		assert.ok(!h.text.includes('undefined'));
	});

	test('bash 带 `line N:` 前缀也能抓到', () => {
		const h = annotateCommandFailure(127, 'bash: line 1: foo: command not found');
		assert.ok(h);
		assert.ok(h!.text.includes('`foo`'), `实际: ${h!.text}`);
	});

	test('zsh 语序相反（`command not found: X`）也能抓到', () => {
		const h = annotateCommandFailure(127, 'zsh: command not found: rg');
		assert.ok(h);
		assert.ok(h!.text.includes('`rg`'), `实际: ${h!.text}`);
	});

	test('cmd.exe / PowerShell / 中文三种措辞都能抓到', () => {
		assert.ok(annotateCommandFailure(255, "'Out-String' is not recognized as an internal or external command")
			?.text.includes('`Out-String`'));
		assert.ok(annotateCommandFailure(1, "The term 'Get-Content' is not recognized as a name of a cmdlet")
			?.text.includes('`Get-Content`'));
		assert.ok(annotateCommandFailure(255, "'foo' 不是内部或外部命令，也不是可运行的程序")
			?.text.includes('`foo`'));
	});

	test('★ 控制组：`python` 缺失仍归更精准的 bare-python-windows', () => {
		// 排序很重要：通用 command-not-found 若排在前面，会把 python 的特化建议
		// 「用 python3 / 虚拟环境」挤掉。
		const h = annotateCommandFailure(255, "'python' is not recognized as an internal or external command");
		assert.ok(h);
		assert.strictEqual(h!.id, 'bare-python-windows');
		assert.ok(h!.text.includes('python3'));
	});
});

// ── ★ 假成功检测（exit 0 但其实是失败）─────────────────────────────────────
//
// `cargo build 2>&1 | tail -20` 退出码是 tail 的、不是 cargo 的（bash 无 pipefail）。
// Hermes 注释里点名了这件事：opencode 只有描述侧禁令（"do NOT pipe through
// head/tail"），Hermes 额外加了结果侧兜底。我们此前正是缺这一环。

suite('commandFailureHints — annotateMaskedSuccess', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★ `cmd | tail` 掩盖了上游失败', () => {
		const h = annotateMaskedSuccess('cargo build 2>&1 | tail -20', 'error[E0308]: mismatched types\n  expected i32');
		assert.ok(h, '应识别出假成功');
		assert.strictEqual(h!.id, 'masked-success-pipe');
		assert.ok(h!.text.includes('LAST pipeline command'));
		assert.ok(h!.text.includes('Treat this run as FAILED'), '必须让模型改判为失败');
		assert.ok(!h!.text.includes('undefined'));
	});

	test('★ `cmd || echo fallback` 掩盖了上游失败', () => {
		const h = annotateMaskedSuccess('npm run build || echo "BUILD FAILED"', 'npm ERR! missing script: build');
		assert.ok(h);
		assert.strictEqual(h!.id, 'masked-success-or');
		assert.ok(h!.text.includes('`||` fallback'));
	});

	test('pytest 汇总行（`3 failed`）也算强失败特征', () => {
		const h = annotateMaskedSuccess('pytest 2>&1 | tail -30', '===== 3 failed, 12 passed in 4.02s =====');
		assert.ok(h);
		assert.strictEqual(h!.id, 'masked-success-pipe');
	});

	test('env 赋值前缀不影响首个 token 判定', () => {
		// firstToken 必须跳过 `FOO=bar`，否则整个函数会因误判成只读头而漏报
		const h = annotateMaskedSuccess('CI=1 cargo build | tail -5', 'error: could not compile `foo`');
		assert.ok(h, '`CI=1` 应被跳过，首个真实 token 是 cargo');
		assert.strictEqual(h!.id, 'masked-success-pipe');
	});

	test('★★ 控制组 1：只读管道不误报（输出合法地含 error 文本）', () => {
		assert.strictEqual(
			annotateMaskedSuccess('grep -rn "npm ERR" logs/ | head -20', 'npm ERR! whatever'),
			undefined,
			'`grep | head` 上游谈不上失败，不得报假成功',
		);
	});

	test('★★ 控制组 2：输出无强失败特征 → 不报', () => {
		assert.strictEqual(
			annotateMaskedSuccess('cargo build | tail -20', '   Compiling foo v0.1.0\n    Finished dev [unoptimized]'),
			undefined,
			'光有掩盖形态、没有失败特征，不得报假成功',
		);
	});

	test('★★ 控制组 3：没有掩盖形态（裸命令）→ 不报', () => {
		assert.strictEqual(
			annotateMaskedSuccess('cargo build', 'npm ERR! something'),
			undefined,
			'裸命令的 exit 0 就是真实退出码，不能无端怀疑',
		);
	});
});
