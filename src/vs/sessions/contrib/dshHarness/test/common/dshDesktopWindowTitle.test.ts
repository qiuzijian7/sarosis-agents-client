/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'node:fs';
import { getDshDesktopWindowTitle } from '../../../../common/dshFullWindow.js';

suite('dshHarness / 桌面窗口标题', () => {
	test('开发版与安装版使用指定标题', () => {
		assert.deepStrictEqual(
			[ getDshDesktopWindowTitle(false), getDshDesktopWindowTitle(true) ],
			[ 'vssaros-dev-desktop', 'vssaros - desktop' ]
		);
	});

	test('多窗口保留序号且第一扇窗口不加序号', () => {
		assert.deepStrictEqual(
			[ getDshDesktopWindowTitle(false, 1), getDshDesktopWindowTitle(false, 2), getDshDesktopWindowTitle(true, 1), getDshDesktopWindowTitle(true, 2) ],
			[ 'vssaros-dev-desktop', 'vssaros-dev-desktop 2', 'vssaros - desktop', 'vssaros - desktop 2' ]
		);
	});

	test('窗口标题与自绘标题栏复用同一标题，加载界面后不覆盖为旧标题', () => {
		const source = fs.readFileSync('src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts', 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		assert.match(source, /getDshDesktopWindowTitle\(this\._environmentService\.isBuilt, windowNo\)/);
		assert.match(source, /this\._installTitleBar\(auxWindow, windowTitle\)/);
		assert.match(source, /brand\.textContent = title/);
		assert.strictEqual((source.match(/win\.document\.title = windowTitle;/g) ?? []).length, 3);
		assert.doesNotMatch(source, /VsSaros — (?:Desktop|DeepSeek Harness)/);
	});
});
