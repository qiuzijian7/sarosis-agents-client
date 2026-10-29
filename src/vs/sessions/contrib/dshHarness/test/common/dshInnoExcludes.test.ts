/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「安装包不许把我们运行时真正用到的包排除掉」的守卫（2026-10-29）。
 *
 * 真机（别人机器装完我们的 exe）：每次启动两条错误
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid' imported from …/out/main.js
 *     Failed to import @vscode/policy-watcher: Cannot find package '@vscode/policy-watcher' …
 *
 * 排查过程（都排除了才找到）：
 *   · `strip-before-pack` **跑了**，自愈日志里 `@vscode/deviceid` 是 ✅（存在）；
 *   · `generate-exe.ps1` 的打包源 `$vsOutRoot` 就是 strip 改过的那个目录；
 *   · 安装后 `resources/` 下是**解开的 `app/`**（不是 asar）⇒ 检查有效。
 * ⇒ 最后在 `build/win32/code.iss` 的 `[Files]` 里找到：**Excludes 明确排除了这两个包**
 *   （上游 VS Code 把它们当遥测件剥掉，但**我们的 `out/main.js` 在 import 它们**）：
 *
 *     \resources\app\node_modules\@vscode\deviceid,\resources\app\node_modules\@vscode\deviceid\**,
 *     \resources\app\node_modules\@vscode\policy-watcher,\resources\app\node_modules\@vscode\policy-watcher\**,
 *
 * ⇒ 已从 Excludes 里删除（它们会正常进包）。
 *
 * 另外：升级安装会撞 `koffi.node` 被占用（`DeleteFile 失败；错误代码 5。拒绝访问`）——
 * 因为我们的 dsh Host 是 **detached 常驻**的，IDE 关了它还活着、还加载着 native 模块。
 * `[Files]` 主行已加 `restartreplace`（被锁的文件安排重启后替换）⇒ 安装不再中断。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshInnoExcludes
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const ISS = 'build/win32/code.iss';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 取 `[Files]` 段（到下一个 `[` 段头为止）。 */
function filesSection(src: string): string {
	const at = src.indexOf('[Files]');
	assert.ok(at > 0, '找不到 [Files] 段');
	const end = src.indexOf('\n[', at + 1);
	return src.slice(at, end > at ? end : src.length);
}

suite('安装包不许排除运行时真正用到的包', () => {

	test('1) @vscode/deviceid 与 @vscode/policy-watcher 不许出现在 Excludes 里', () => {
		const files = filesSection(read(ISS));

		// 只在 Excludes 那一行里查（这些包名可能出现在别处，比如 [Code] 的注释）
		const excl = files.split('\n').filter(l => /Excludes:/.test(l)).join('\n');
		assert.ok(excl.length > 0, '找不到 Excludes 行');

		assert.ok(!/resources\\app\\node_modules\\@vscode\\deviceid/.test(excl),
			'Excludes 里不许排除 @vscode/deviceid（`out/main.js` 在 import 它 ⇒ 排除掉就是 ERR_MODULE_NOT_FOUND ✗）');
		assert.ok(!/resources\\app\\node_modules\\@vscode\\policy-watcher/.test(excl),
			'Excludes 里不许排除 @vscode/policy-watcher（同上，真机报 Failed to import ✗）');
	});

	test('2) 主 Files 行必须有 restartreplace（升级时 native 模块被占用）', () => {
		const files = filesSection(read(ISS));
		const main = files.split('\n').filter(l => /Source:\s*"\*"/.test(l)).join('\n');
		assert.ok(main.length > 0, '找不到主 Files 行（Source: "*"）');
		assert.match(main, /restartreplace/,
			'主 Files 行必须带 restartreplace —— dsh Host 是 detached 常驻的，'
			+ '升级时会锁住 dsh-runtime 里的 *.node ⇒ 不带它就是「DeleteFile 失败；错误代码 5」✗');
	});
});
