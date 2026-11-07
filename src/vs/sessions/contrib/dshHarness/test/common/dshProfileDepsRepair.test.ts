/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * profile 依赖自愈（2026-10-29）—— 纯逻辑 + 真实目录行为。
 *
 * 真机事故：装插件后 pnpm 把 `compression/node_modules/negotiator` 装成缺 `lib/accept.js` 的残次品
 * ⇒ dsh 的四个插件 import 全挂 ⇒ Host exit code 1 ⇒ 桌面窗口只报「控制桥不可用」，
 * 而且**每次装插件都会复现** ⇒ 必须自愈，不能手工补一次了事。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshProfileDepsRepair
 */

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { missingFilesInNestedCopy, repairProfileDeps } from '../../electron-main/dshProfileDepsRepair.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function write(base: string, rel: string, content = 'x'): void {
	const full = join(base, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, content, 'utf8');
}

suite('dshHarness / profile 依赖自愈', () => {

	test('① 差集：只补"顶层有、嵌套缺"的文件', () => {
		assert.deepStrictEqual(
			missingFilesInNestedCopy(['index.js', 'lib/a.js'], ['index.js', 'lib/a.js', 'lib/accept.js']),
			['lib/accept.js']);
		// 顶层没有的 ⇒ 不补（补过去也跑不起来）
		assert.deepStrictEqual(missingFilesInNestedCopy(['index.js'], ['index.js']), []);
		assert.deepStrictEqual(missingFilesInNestedCopy([], ['lib/accept.js']), ['lib/accept.js']);
	});

	test('② ★ 真实目录：嵌套副本缺的文件会被补齐（否则 Host 必起不来）', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-deps-'));
		try {
			const nm = join(dir, 'node_modules');
			// 顶层：完整的 negotiator
			write(nm, 'negotiator/lib/accept.js', 'ACCEPT');
			write(nm, 'negotiator/lib/charset.js', 'CHARSET');
			write(nm, 'negotiator/package.json', '{"name":"negotiator"}');
			// 嵌套副本（compression 里的）：缺 accept.js
			write(nm, 'compression/package.json', '{"name":"compression"}');
			write(nm, 'compression/node_modules/negotiator/lib/charset.js', 'CHARSET');
			write(nm, 'compression/node_modules/negotiator/package.json', '{"name":"negotiator"}');

			const logs: string[] = [];
			const report = await repairProfileDeps(nm, line => logs.push(line));
			assert.strictEqual(report.repaired.length, 1, '必须补齐 1 个文件 ✓');
			assert.ok(existsSync(join(nm, 'compression/node_modules/negotiator/lib/accept.js')),
				'★ 缺失的 accept.js 必须被补上（少了它 Host 的四个插件 import 全挂 ✗）');
			assert.ok(logs.some(l => l.includes('accept.js')), '必须留一行日志（真机要能看出修了什么）✓');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('③ 负对照：顶层没有同名包 ⇒ 不动（无从对照）', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-deps-'));
		try {
			const nm = join(dir, 'node_modules');
			write(nm, 'compression/package.json', '{}');
			write(nm, 'compression/node_modules/onlyhere/lib/x.js', 'x');
			const report = await repairProfileDeps(nm, () => undefined);
			assert.strictEqual(report.repaired.length, 0, '顶层没有 ⇒ 不该补 ✓');
			assert.ok(!existsSync(join(nm, 'compression/node_modules/onlyhere/lib/x.js')) === false, '原文件不动 ✓');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('⑤ ★ 顶层自己也残：完整副本在 @scope 包内 ⇒ 顶层与另一嵌套副本都要被补齐', async () => {
		// ★★ 2026-11-07 真机（F5 崩溃）：pnpm 把 `node_modules/negotiator`（顶层）和
		//   `compression/node_modules/negotiator` **都**装成缺 `lib/accept.js`；
		//   只有 `@deepseek-ai/dsh-host-webserver/node_modules/negotiator` 是完整的。
		//   旧实现拿顶层当基准 ⇒ 差集里根本没有 accept.js ⇒ 自愈静默失效 ⇒ Host 四个插件 import 全挂 ✗✗。
		const dir = mkdtempSync(join(tmpdir(), 'dsh-deps-'));
		try {
			const nm = join(dir, 'node_modules');
			const pkgJson = '{"name":"negotiator","version":"1.1.0"}';
			// 顶层：残
			write(nm, 'negotiator/lib/charset.js', 'CHARSET');
			write(nm, 'negotiator/package.json', pkgJson);
			// compression 内嵌：残
			write(nm, 'compression/package.json', '{"name":"compression"}');
			write(nm, 'compression/node_modules/negotiator/lib/charset.js', 'CHARSET');
			write(nm, 'compression/node_modules/negotiator/package.json', pkgJson);
			// scoped 包内嵌：完整（唯一可信基准）
			const best = '@deepseek-ai/dsh-host-webserver/node_modules/negotiator';
			write(nm, best + '/lib/accept.js', 'ACCEPT');
			write(nm, best + '/lib/charset.js', 'CHARSET');
			write(nm, best + '/package.json', pkgJson);
			write(nm, '@deepseek-ai/dsh-host-webserver/package.json', '{"name":"@deepseek-ai/dsh-host-webserver"}');

			const logs: string[] = [];
			const report = await repairProfileDeps(nm, line => logs.push(line));
			assert.strictEqual(report.repaired.length, 2, '顶层 + 另一嵌套副本共缺 2 个文件，都要补 ✓');
			assert.ok(existsSync(join(nm, 'negotiator/lib/accept.js')), '★ 顶层残缺也必须被补回来（旧实现做不到）');
			assert.ok(existsSync(join(nm, 'compression/node_modules/negotiator/lib/accept.js')), '嵌套副本也要补');
			assert.ok(logs.some(l => l.includes('accept.js')), '留日志 ✓');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('⑥ 不同版本的同名包不许互相当基准（避免补进错版本的文件）', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-deps-'));
		try {
			const nm = join(dir, 'node_modules');
			write(nm, 'negotiator/lib/accept.js', 'V1-ACCEPT');
			write(nm, 'negotiator/package.json', '{"name":"negotiator","version":"1.1.0"}');
			write(nm, 'compression/package.json', '{"name":"compression"}');
			write(nm, 'compression/node_modules/negotiator/lib/charset.js', 'V2-CHARSET');
			write(nm, 'compression/node_modules/negotiator/package.json', '{"name":"negotiator","version":"2.0.0"}');

			const report = await repairProfileDeps(nm, () => undefined);
			assert.strictEqual(report.repaired.length, 0, '版本不同 ⇒ 不对照 ✓');
			assert.ok(!existsSync(join(nm, 'compression/node_modules/negotiator/lib/accept.js')), '不许补进 v1 的文件');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('④ 接线：装完插件必须立刻自愈（否则每次装插件后 Host 必失败）', () => {
		const src = require('fs').readFileSync(SUPERVISOR, 'utf8');
		assert.ok(/repairProfileDeps\(/.test(src), '必须调用依赖自愈 ✓');
		const iInstall = src.indexOf('one-shot install of');
		const iRepair = src.indexOf('repairProfileDeps(');
		assert.ok(iInstall > 0 && iRepair > iInstall, '自愈必须**在装插件之后**（否则体检的是旧树 ✗）');
	});
});
