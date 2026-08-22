/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	annotateCommandFailure,
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
