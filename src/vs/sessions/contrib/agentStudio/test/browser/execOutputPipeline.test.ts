/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 命令输出 token 效率管道回归测试（2026-08-22，对标 MiMo-Code bash_token_efficient_*）。
 *
 * 三条工程契约各自都有专门断言 —— 它们是「优化永不为负」的保证：
 *  - passthrough：命令已在做机器可读投影 → 一字节不动
 *  - never-worse：任何没让字节变小的步骤一律丢弃
 *  - opt-out：`# nofilter` / `# raw` → 整体跳过
 */

import assert from 'assert';
import {
	runExecOutputPipeline, collapseProgressFrames, stripAnsiSequences,
	redactSecretsInOutput, foldLongLines, foldDependencyStackFrames,
	aggregateTscDiagnostics, foldNpmNoise, LONG_LINE_MAX,
} from '../../browser/providers/tool/execOutputPipeline.js';

suite('execOutputPipeline — 公共链各步', () => {

	test('★ collapseProgressFrames 只留最后一帧（进度条是纯浪费）', () => {
		const raw = 'Building 10%\rBuilding 50%\rBuilding 100%\nDone.';
		assert.strictEqual(collapseProgressFrames(raw), 'Building 100%\nDone.');
	});

	test('collapseProgressFrames 跳过末尾空帧', () => {
		assert.strictEqual(collapseProgressFrames('final state\r'), 'final state');
	});

	test('无 \\r 时原样返回（零开销快路径）', () => {
		const s = 'a\nb\nc';
		assert.strictEqual(collapseProgressFrames(s), s);
	});

	test('stripAnsiSequences 剥 SGR / OSC / 裸控制字节', () => {
		assert.strictEqual(stripAnsiSequences('\x1b[31merror\x1b[0m'), 'error');
		assert.strictEqual(stripAnsiSequences('\x1b]0;title\x07out'), 'out');
		assert.strictEqual(stripAnsiSequences('a\x00\x01b'), 'ab');
	});

	test('★ stripAnsiSequences 保留 \\n 与 \\t（结构信息不能丢）', () => {
		assert.strictEqual(stripAnsiSequences('a\n\tb'), 'a\n\tb');
	});

	test('stripAnsiSequences 处理 backspace overstrike（man page 加粗）', () => {
		assert.strictEqual(stripAnsiSequences('a\bab\bb'), 'ab');
	});

	test('★ redactSecretsInOutput 覆盖各类凭据', () => {
		assert.match(redactSecretsInOutput('Authorization: Bearer abcdefghijklmnopqrst'), /<redacted:Bearer>/);
		assert.match(redactSecretsInOutput('tok=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.SflKxwRJSMeKK'), /<redacted:JWT>/);
		assert.match(redactSecretsInOutput('id AKIAIOSFODNN7EXAMPLE'), /<redacted:AWS>/);
		assert.match(redactSecretsInOutput('ghp_1234567890abcdefghij'), /<redacted:GitHub>/);
		assert.match(redactSecretsInOutput('sk-ant-abcdefghijklmnopqrstuv'), /<redacted:APIKey>/);
	});

	test('★ KEY=VALUE 形态保留 key 名（便于定位是哪个配置泄露）', () => {
		assert.strictEqual(redactSecretsInOutput('MY_API_TOKEN=supersecretvalue'), 'MY_API_TOKEN=<redacted>');
	});

	test('普通输出不被脱敏误伤', () => {
		const s = 'compiled 42 files in 1.2s';
		assert.strictEqual(redactSecretsInOutput(s), s);
	});

	test('foldLongLines 折叠超长行并标注省略量', () => {
		const long = 'x'.repeat(2000);
		const out = foldLongLines(long);
		assert.ok(out.length < long.length);
		assert.match(out, /chars elided/);
	});

	test('★ 恰好等于阈值的行不折叠（边界含等号）', () => {
		const line = 'y'.repeat(LONG_LINE_MAX);
		assert.strictEqual(foldLongLines(line), line);
	});
});

suite('execOutputPipeline — Shape 层', () => {

	test('★ foldDependencyStackFrames 折叠依赖帧、保留自己的帧', () => {
		const raw = [
			'Error: boom',
			'    at myFn (g:/repo/src/app.ts:10:5)',
			'    at wrap (g:/repo/node_modules/express/lib/router.js:1:1)',
			'    at next (g:/repo/node_modules/express/lib/router.js:2:2)',
			'    at other (g:/repo/node_modules/body-parser/index.js:3:3)',
			'    at myOther (g:/repo/src/svc.ts:20:1)',
		].join('\n');
		const out = foldDependencyStackFrames(raw);
		assert.match(out, /myFn \(g:\/repo\/src\/app\.ts/, '自己的帧必须保留');
		assert.match(out, /myOther \(g:\/repo\/src\/svc\.ts/, '自己的帧必须保留');
		assert.match(out, /\[3 dependency frame\(s\) suppressed\]/);
		assert.ok(!/express\/lib\/router/.test(out));
	});

	test('折叠 Python site-packages 帧', () => {
		const raw = [
			'Traceback (most recent call last):',
			'  File "/app/main.py", line 3, in <module>',
			'  File "/usr/lib/python3/site-packages/requests/api.py", line 9, in get',
			'ValueError: bad',
		].join('\n');
		const out = foldDependencyStackFrames(raw);
		assert.match(out, /main\.py/);
		assert.match(out, /\[1 dependency frame\(s\) suppressed\]/);
	});

	test('★ 不连续的依赖帧分段计数（保留调用顺序可读性）', () => {
		const raw = [
			'    at a (/r/node_modules/x/i.js:1:1)',
			'    at mine (/r/src/a.ts:1:1)',
			'    at b (/r/node_modules/y/i.js:1:1)',
		].join('\n');
		const out = foldDependencyStackFrames(raw);
		assert.strictEqual((out.match(/dependency frame\(s\) suppressed/g) ?? []).length, 2);
	});

	test('★ aggregateTscDiagnostics 按错误码与文件聚合', () => {
		const lines: string[] = [];
		for (let i = 0; i < 20; i++) { lines.push(`src/a.ts(${i},5): error TS2322: Type mismatch here.`); }
		for (let i = 0; i < 5; i++) { lines.push(`src/b.ts(${i},1): error TS2304: Cannot find name 'x'.`); }
		const out = aggregateTscDiagnostics(lines.join('\n'));
		assert.match(out, /25 diagnostics \(25 error\(s\)\) across 2 file\(s\)/);
		assert.match(out, /TS2322 ×20/);
		assert.match(out, /TS2304 ×5/);
		assert.match(out, /src\/a\.ts ×20/);
		assert.match(out, /First diagnostics verbatim:/, '必须保留原始样例供定位');
		assert.ok(out.length < lines.join('\n').length, '聚合后必须更短');
	});

	test('★ 诊断条数少时原样返回（聚合反而更长）', () => {
		const raw = 'src/a.ts(1,1): error TS2322: Bad.\nsrc/b.ts(2,2): error TS2304: Nope.';
		assert.strictEqual(aggregateTscDiagnostics(raw), raw);
	});

	test('foldNpmNoise 折叠 deprecation 警告', () => {
		const raw = [
			'npm warn deprecated inflight@1.0.6: This module is not supported',
			'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
			'added 120 packages in 3s',
		].join('\n');
		const out = foldNpmNoise(raw);
		assert.match(out, /×2\] npm deprecation warning\(s\) suppressed/);
		assert.match(out, /added 120 packages/, '有效输出必须保留');
	});

	test('无 npm 噪音时原样返回', () => {
		const raw = 'added 120 packages in 3s';
		assert.strictEqual(foldNpmNoise(raw), raw);
	});
});

suite('execOutputPipeline — 三条工程契约', () => {

	test('★★ passthrough：命令已做 JSON 投影 → 一字节不动', () => {
		const raw = '{"a":\t"\\u001b[31m"}';
		for (const cmd of ['npm ls --json', 'kubectl get pods -o json', 'gh pr list --json number']) {
			const r = runExecOutputPipeline(raw, cmd);
			assert.strictEqual(r.skipped, true, cmd);
			assert.strictEqual(r.text, raw, cmd);
		}
	});

	test('★★ passthrough：管道到 tee / xxd / base64 → 不动', () => {
		const raw = 'x'.repeat(2000);
		assert.strictEqual(runExecOutputPipeline(raw, 'cat f | xxd').text, raw);
		assert.strictEqual(runExecOutputPipeline(raw, 'make 2>&1 | tee build.log').text, raw);
	});

	test('★★ opt-out：# nofilter / # raw → 整体跳过', () => {
		const raw = 'Building 1%\rBuilding 2%\n\x1b[31mred\x1b[0m';
		for (const cmd of ['npm run build # nofilter', 'npm run build  # raw']) {
			const r = runExecOutputPipeline(raw, cmd);
			assert.strictEqual(r.skipped, true, cmd);
			assert.strictEqual(r.text, raw, cmd);
		}
	});

	test('★★ never-worse：任何步骤都不会让输出变长', () => {
		const samples = [
			'plain short output',
			'a\nb\nc',
			'src/a.ts(1,1): error TS2322: Bad.',
			'added 120 packages',
			'',
			'Error: boom\n    at mine (/r/src/a.ts:1:1)',
		];
		for (const s of samples) {
			for (const cmd of ['npx tsc --noEmit', 'npm install', 'node x.js', 'git status']) {
				const r = runExecOutputPipeline(s, cmd);
				assert.ok(r.text.length <= s.length,
					`"${s.slice(0, 30)}" via "${cmd}": ${s.length} → ${r.text.length} 变长了`);
			}
		}
	});

	test('★ 组合场景：ANSI + 进度帧 + 超长行 + tsc 诊断一起处理', () => {
		const lines = ['\x1b[2mBuilding 10%\rBuilding 100%\x1b[0m'];
		for (let i = 0; i < 15; i++) { lines.push(`src/x.ts(${i},1): error TS2345: Argument type wrong.`); }
		lines.push('data: ' + 'z'.repeat(1200));
		const raw = lines.join('\n');
		const r = runExecOutputPipeline(raw, 'npx tsc --noEmit');
		assert.strictEqual(r.skipped, false);
		assert.ok(r.text.length < raw.length);
		assert.ok(!/\x1b\[/.test(r.text), 'ANSI 必须剥净');
		assert.ok(!/Building 10%/.test(r.text), '中间进度帧必须折叠');
		assert.match(r.text, /TS2345 ×15/, 'tsc 必须聚合');
		assert.match(r.text, /chars elided/, '超长行必须折叠');
		assert.ok(r.appliedStages.includes('tsc'), 'appliedStages 应记录 tsc');
	});

	test('空输入 → 空输出，无异常', () => {
		const r = runExecOutputPipeline('', 'npx tsc');
		assert.strictEqual(r.text, '');
		assert.strictEqual(r.skipped, false);
	});

	test('★ appliedStages 只记录真正生效的步骤', () => {
		// 纯净短输出：任何步骤都不会让它变小 → appliedStages 应为空
        const r = runExecOutputPipeline('ok', 'git status');
		assert.deepStrictEqual(r.appliedStages, []);
	});
});
