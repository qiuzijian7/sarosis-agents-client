/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 随包插件暂存目录的落位（`dshPluginStaging.ts`）—— **真文件系统**的行为测试。
 *
 * 为什么要这样测（2026-11-03 真机事故）：
 *   别人机器上 F5 直接起不来，Host 侧报
 *   `EEXIST: mkdir …\.vssaros\plugins\vssaros-dsh-loop-…\docs`
 *   `ENOTEMPTY: rmdir …\.vssaros\plugins\vssaros-dsh-kb-…\lib`
 *   —— 旧实现"先 rm 目标、再 cp 进去"，而同一进程 `Promise.all` 并行装 20 个插件、
 *   那次 3 秒内还起了 3 个窗口（3 个进程）⇒ 互相删对方正在写的目录。
 *   ⇒ 只加"源码断言"抓不住这类问题，必须真的把并发写撞在一起跑一遍。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPluginStaging
 */

import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE = 'src/vs/sessions/contrib/dshHarness/electron-main/dshPluginStaging.ts';

interface IStaging {
	stagePluginDir(o: {
		sourceDir: string;
		destDir: string;
		serialize?: boolean;
		uniqueSuffix?: () => string;
	}): Promise<string>;
}

let staging: IStaging | undefined;

/** 在临时根目录下造一个"随包插件"（`lib/index.js` + 嵌套目录 + node_modules 干扰项）。 */
function makePlugin(root: string, name: string, body: string): string {
	const dir = path.join(root, 'src', name);
	fs.mkdirSync(path.join(dir, 'lib', 'docs'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
	fs.writeFileSync(path.join(dir, 'lib', 'index.js'), body);
	fs.writeFileSync(path.join(dir, 'lib', 'docs', 'a.md'), 'doc-' + body);
	fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'x.js'), 'should be excluded');
	return dir;
}

/** 目录里的相对文件清单（用于比对内容完整性）。 */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) { walk(p); } else { out.push(path.relative(dir, p).split(path.sep).join('/')); }
		}
	};
	walk(dir);
	return out.sort();
}

suite('dshPluginStaging：并发落位', () => {
	let tmpRoot = '';

	suiteSetup(async () => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-'));
		const mod = await import(pathToFileURL(path.join(process.cwd(), MODULE)).href) as IStaging;
		staging = mod;
	});

	suiteTeardown(() => {
		if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
	});

	setup(() => {
		// 每个用例一个干净的子目录（dest 不能共用：有幂等早退）
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-'));
	});

	teardown(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	test('1) 基本落位：内容完整，且排除源里的 node_modules', async () => {
		const src = makePlugin(tmpRoot, 'p1', 'v1');
		const dest = path.join(tmpRoot, 'plugins', 'p1-1.0.0');
		const got = await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.strictEqual(got, dest);
		assert.deepStrictEqual(listFiles(dest), ['lib/docs/a.md', 'lib/index.js', 'package.json']);
		assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/index.js'), 'utf8'), 'v1');
	});

	test('2) ★ 每次都刷新：只改**非入口文件**（指纹不变）也必须落到目标里', async () => {
		// ⚠ 2026-11-03 评审修正：目录名里的指纹只覆盖入口文件（`_entryFingerprint`）⇒
		//   若加"目标已存在就复用"的早退，client 分包 / assets / lib 下其它模块的变更就永远不生效 ✗。
		const src = makePlugin(tmpRoot, 'p2', 'v2');
		const dest = path.join(tmpRoot, 'plugins', 'p2-1.0.0');
		await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/docs/a.md'), 'utf8'), 'doc-v2');
		// 只动非入口文件（入口 lib/index.js 与版本号都不变 ⇒ 指纹不变、目录名不变）
		fs.writeFileSync(path.join(src, 'lib', 'docs', 'a.md'), 'doc-v2-CHANGED');
		await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/docs/a.md'), 'utf8'), 'doc-v2-CHANGED',
			'非入口文件的变更必须生效（不许早退复用旧副本）');
	});

	test('3) 半成品目标（没有 package.json）⇒ 必须被完整替换，而不是"误当已装"', async () => {
		const src = makePlugin(tmpRoot, 'p3', 'v3');
		const dest = path.join(tmpRoot, 'plugins', 'p3-1.0.0');
		fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
		fs.writeFileSync(path.join(dest, 'lib', 'index.js'), 'half-written');
		await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.deepStrictEqual(listFiles(dest), ['lib/docs/a.md', 'lib/index.js', 'package.json']);
		assert.strictEqual(fs.readFileSync(path.join(dest, 'lib/index.js'), 'utf8'), 'v3');
	});

	test('4) ★ 8 个并发写同一个目标（不走进程内锁 = 模拟多进程）⇒ 全部成功、内容完整、无残留', async () => {
		const src = makePlugin(tmpRoot, 'p4', 'v4');
		const dest = path.join(tmpRoot, 'plugins', 'p4-1.0.0');
		const results = await Promise.all(Array.from({ length: 8 }, () =>
			staging!.stagePluginDir({ sourceDir: src, destDir: dest, serialize: false })));
		assert.ok(results.every(r => r === dest), '每个调用都应返回同一个目标路径');
		assert.deepStrictEqual(listFiles(dest), ['lib/docs/a.md', 'lib/index.js', 'package.json'], '最终内容必须是完整的');
		const leftovers = fs.readdirSync(path.join(tmpRoot, 'plugins')).filter(n => /\.(staging|stale)-/.test(n));
		assert.deepStrictEqual(leftovers, [], '不许留下 .staging-* / .stale-* 残留：' + leftovers.join(','));
	});

	test('5) 源就是目标 ⇒ 原样返回（绝不能把自己删掉）', async () => {
		const src = makePlugin(tmpRoot, 'p5', 'v5');
		const got = await staging!.stagePluginDir({ sourceDir: src, destDir: src });
		assert.strictEqual(got, src);
		assert.ok(fs.existsSync(path.join(src, 'package.json')), '源目录必须完好');
		assert.strictEqual(fs.readFileSync(path.join(src, 'lib/index.js'), 'utf8'), 'v5');
	});

	test('7) 源就是目标、且源**没有** package.json ⇒ 也必须原样返回（这句早退是唯一防线）', async () => {
		// ⚠ 「源==目标」有两道保险：① 路径相等早退；② `isUsable(dest)`（源完整时也命中）。
		//   只有源**不完整**（缺 package.json，e2e 探针传错目录那种）时，② 不再命中
		//   ⇒ 若把 ① 删掉，就会走到 `rm(dest)` 把源自己删掉。这条用例专门钉 ①。
		const src = makePlugin(tmpRoot, 'p7', 'v7');
		fs.rmSync(path.join(src, 'package.json'));
		const got = await staging!.stagePluginDir({ sourceDir: src, destDir: src });
		assert.strictEqual(got, src);
		assert.deepStrictEqual(listFiles(src), ['lib/docs/a.md', 'lib/index.js', 'node_modules/junk/x.js'], '源目录必须原样完好（不许被 rm 掉）');
	});

	test('6) 上次崩溃留下的 .staging-* 不影响本次落位', async () => {
		const src = makePlugin(tmpRoot, 'p6', 'v6');
		const dest = path.join(tmpRoot, 'plugins', 'p6-1.0.0');
		fs.mkdirSync(dest + '.staging-999-dead', { recursive: true });
		fs.writeFileSync(path.join(dest + '.staging-999-dead', 'junk.txt'), 'x');
		await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.deepStrictEqual(listFiles(dest), ['lib/docs/a.md', 'lib/index.js', 'package.json']);
	});

	test('8) ★ 开发工作区（dev/ 里有 package.json）不进暂存；没有 package.json 的 dev/ 照常是插件内容', async () => {
		// 2026-11-05（superagent 转正）：vssaros-superagent 的源码、测试、文档与工具链（含几百 MB node_modules）在 dev/
		//   ⇒ 进了暂存就会被装进每台机器的 profile ✗。
		const src = makePlugin(tmpRoot, 'p8', 'v8');
		fs.mkdirSync(path.join(src, 'dev', 'src'), { recursive: true });
		fs.writeFileSync(path.join(src, 'dev', 'package.json'), JSON.stringify({ name: 'p8-dev', private: true }));
		fs.writeFileSync(path.join(src, 'dev', 'src', 'index.ts'), 'source');
		fs.mkdirSync(path.join(src, 'lib', 'dev'), { recursive: true });
		fs.writeFileSync(path.join(src, 'lib', 'dev', 'kept.js'), 'nested dev is runtime');
		const dest = path.join(tmpRoot, 'plugins', 'p8-1.0.0');
		await staging!.stagePluginDir({ sourceDir: src, destDir: dest });
		assert.deepStrictEqual(listFiles(dest), ['lib/dev/kept.js', 'lib/docs/a.md', 'lib/index.js', 'package.json']);
		// 没有 dev/package.json ⇒ dev/ 不是开发工作区 ⇒ 原样进暂存
		const plain = makePlugin(tmpRoot, 'p9', 'v9');
		fs.mkdirSync(path.join(plain, 'dev'), { recursive: true });
		fs.writeFileSync(path.join(plain, 'dev', 'asset.txt'), 'shipped');
		const dest9 = path.join(tmpRoot, 'plugins', 'p9-1.0.0');
		await staging!.stagePluginDir({ sourceDir: plain, destDir: dest9 });
		assert.deepStrictEqual(listFiles(dest9), ['dev/asset.txt', 'lib/docs/a.md', 'lib/index.js', 'package.json']);
	});
});
