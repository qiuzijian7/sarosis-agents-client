/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「EXE 打包最后一道闸」的守卫（2026-10-29）。
 *
 * 打包是**蓝盾 CI** 跑的（`.ci/package-win-exe.yml`，14 步全是 `.ci/scripts/*.ps1`）：
 *
 *   设置版本号 → npm ci → kbblocks → compile-build → copy-kbblocks → transpile-plugins
 *   → compile-extensions → **package-vscode.ps1（gulp vscode-win32-x64 + strip-before-pack）**
 *   → bundle-ffmpeg → bundle-whisper → verify-staging
 *   → **generate-exe.ps1（三个 Inno 任务 = iscc）** → 上传 → create-release
 *
 * 真机问题：CI 打出来的包在别人机器上每次启动一条
 *   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid' imported from …/out/main.js`
 * ⇒ 说明**产物里没有 deviceid**。
 *
 * 为什么光靠 `strip-before-pack` 不够：
 *   · 它在 `package-vscode.ps1` 阶段跑（离 iscc 还有 ffmpeg / whisper / verify 三步）；
 *   · `generate-exe.ps1` 自己就有一套 `Copy-ExtIfMissing` 自愈（tree-sitter-wasm / agent-studio /
 *     typescript / dsh-runtime），说明**这个阶段补件是既定做法** —— 但清单里**没有 deviceid**。
 *
 * ⇒ 修法（都在 `generate-exe.ps1`，**紧挨 iscc 的最后一道**）：
 *   ① 加 `Copy-ExtIfMissing "node_modules\@vscode\deviceid" "dist\index.js"` + 缺则 FATAL；
 *   ② 在三个 `Invoke-InnoTask` **之前**跑 `check-pack-contents.mjs $vsOutRoot`（产物内容门禁）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshCiExeGate
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const GEN_EXE = '.ci/scripts/generate-exe.ps1';
const PACK_VSCODE = '.ci/scripts/package-vscode.ps1';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('EXE 打包的最后一道闸（generate-exe.ps1）', () => {

	test('1) deviceid 必须在 iscc 之前补齐，缺则 FATAL', () => {
		const src = read(GEN_EXE);

		assert.match(src, /Copy-ExtIfMissing "node_modules\\@vscode\\deviceid" "dist\\index\.js"/,
			'deviceid 必须用既有的 Copy-ExtIfMissing 模式自愈（与 tree-sitter-wasm/typescript 一致）');
		assert.match(src, /FATAL: @vscode\/deviceid 未进打包产物/,
			'补不到必须 FATAL（否则又是一条"装完每次启动报 ERR_MODULE_NOT_FOUND"的包）');

		// 顺序：自愈必须在 iscc（Invoke-InnoTask）之前
		const iCopy = src.indexOf('deviceid" "dist\\index.js"');
		const iInno = src.indexOf("Invoke-InnoTask 'vscode-win32-x64-inno-updater'");
		assert.ok(iCopy > 0 && iInno > 0, '找不到 deviceid 自愈或 Inno 任务调用');
		assert.ok(iCopy < iInno, 'deviceid 自愈必须在 iscc 之前（打包之后再补就进不了包 ✗）');
	});

	test('2) 产物内容门禁必须在 iscc 之前跑，且失败禁止出包', () => {
		const src = read(GEN_EXE);

		assert.match(src, /node build\/saros\/check-pack-contents\.mjs \$vsOutRoot/,
			'门禁必须跑在 **iscc 的源目录**（$vsOutRoot）上 —— 目录明确、不靠猜');
		assert.match(src, /FATAL: 产物内容门禁未通过 —— 禁止出包/,
			'门禁不过必须 FATAL（否则缺件照样出包 ✗）');

		const iGate = src.indexOf('check-pack-contents.mjs $vsOutRoot');
		const iInno = src.indexOf("Invoke-InnoTask 'vscode-win32-x64-inno-updater'");
		assert.ok(iGate > 0 && iInno > 0, '找不到门禁或 Inno 任务');
		assert.ok(iGate < iInno, '门禁必须在 iscc **之前**（打包后再查就没意义了 ✗）');
	});

	test('3) 上一步（package-vscode.ps1）里的 strip 不许被删弱', () => {
		const src = read(PACK_VSCODE);
		assert.match(src, /node build\/saros\/strip-before-pack\.mjs/,
			'package-vscode.ps1 必须继续跑 strip-before-pack（它负责清理 + 关键构件自愈）');
		assert.match(src, /strip-before-pack failed"; exit 1/,
			'strip 失败必须 exit 1（不许带病继续打包）');
	});
});
