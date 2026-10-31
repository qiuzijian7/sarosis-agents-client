/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「插件的**生成产物**必须进包」的守卫（2026-10-31）。
 *
 * 背景：CI（Build #253，干净检出）打出的包里，`随包 dsh-plugins 完整性：840 个文件`，
 *   而本机是 **874** ⇒ 差的 **34** 个全是 **被 gitignore 的生成产物**（`dist/` `vendor/` 等）
 *   ⇒ 干净检出根本没有 ⇒ 逐文件门禁比的是"仓库 vs 暂存"，两边都没有 ⇒ **判一致 ⇒ 静默漏掉**。
 *
 * 逐个判定（**都有代码依据**，不是猜的）：
 *   · `vssaros-dashboard/lib/app/dist/*` —— `lib/index.js` 用 `new URL('./app/dist/dashboard-app.js')`
 *     提供页面路由 ⇒ **缺了主页空白**（真机 10-31 就是这个）；
 *   · `vssaros-agents/lib/adapters/vendor/**` —— `lib/adapters/feishuRawWs.js`
 *     `await import('./vendor/deps/ws/index.js')` ⇒ **缺了飞书入站起不来**；
 *     生成脚本头部注释自己写着"发布脚本必须先跑它，否则包里没有 SDK"；
 *   · 其余（LANGUAGES.txt / VERSION.txt / 第三方许可证·说明）—— **运行时不读**，只在交付/合规层面要。
 *
 * 修法：打包时缺就**现跑各自的生成脚本**，再落位；运行时必需的失败 ⇒ `criticalMissing`（禁止带病出包），
 *   非必需的只警告（避免假红）。
 *   ⚠ 完整性门禁必须**挪到生成之后**调用（否则查不出"两边都没有"这类缺失）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPluginArtifactsPackaged
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = 'build/saros/strip-before-pack.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('插件生成产物必须进包', () => {

	test('1) 飞书入站 SDK（agents vendor）必须生成 + 落位，失败要 criticalMissing', () => {
		const src = read(SCRIPT);
		assert.match(src, /scripts\/vendor-lark-sdk\.mjs/, '必须跑 agents 的 vendor 脚本（缺它 ⇒ 飞书入站起不来）');
		assert.match(src, /'deps\/ws\/index\.js'/, '落位 sentinel 必须是 deps/ws/index.js（运行时真正 import 的那个）');
		assert.match(src, /resources\/app\/dsh-plugins\/vssaros-agents\/lib\/adapters\/vendor/, '落位路径要进随包插件目录');
		// 必需项 ⇒ 失败必须报红
		const at = src.indexOf('scripts/vendor-lark-sdk.mjs');
		assert.match(src.slice(at, at + 1600), /criticalMissing\+\+;/, 'vendor 失败必须 criticalMissing（禁止带病出包）');
	});

	test('2) 完整性门禁必须在"生成之后"调用（否则查不出两边都没有的产物）', () => {
		const src = read(SCRIPT);
		assert.match(src, /function verifyDshPluginsComplete\(\) \{/, '门禁必须是函数（便于在生成之后调用）');
		const iCall = src.indexOf('verifyDshPluginsComplete();');
		// ⚠ 用 lastIndexOf：日志文案里也提到这两个脚本名（位置在真正调用**之前**），
		//   用 indexOf 会把"挪到生成前"的突变判成合法（第一版就这么被 M2 骗成假绿）
		const iDash = src.lastIndexOf('vendor/build.mjs');
		const iVendor = src.lastIndexOf('scripts/vendor-lark-sdk.mjs');
		assert.ok(iCall > 0, '必须调用门禁');
		assert.ok(iCall > iDash && iCall > iVendor,
			'门禁调用点必须在 dashboard/agents 生成之后（否则"仓库与暂存都没有"会被判成一致 ⇒ 静默漏掉 ✗）');
	});

	test('3) 交付/合规类文本要有人管（缺了只警告，不许因此报红）', () => {
		const src = read(SCRIPT);
		for (const f of ['LANGUAGES.txt', 'VERSION.txt', 'JetBrainsMono-OFL.txt', 'LICENSE-excalidraw.txt', 'README.txt']) {
			assert.ok(src.includes(f), `打包脚本要处理 ${f}（至少给出"缺失 + 补法"的提示）`);
		}
		assert.match(src, /不影响运行，仅影响交付\/合规/, '非运行时文本缺失时只警告（避免假红挡住出包）');
	});
});
