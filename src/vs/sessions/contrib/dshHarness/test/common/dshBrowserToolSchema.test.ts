/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「工具 schema 不许用 `anyOf`」守卫（2026-11-07）。
 *
 * 真机：dsh runtime 0.2.1-rc.2 的 schemastery 只支持
 * `type/oneOf/properties/required/additionalProperties/items/enum/const`（+注解）。
 * `vssaros-browser` 给 `output.schema` 写了 `anyOf` ⇒ `tools.register` 抛
 * `JsonSchemaError: schema.anyOf is not a supported keyword` ⇒ browser 插件 apply 失败
 * ⇒ webserver 等 12 个服务卡住 ⇒ Host `code 1` ⇒ `start failed` ⇒ 桌面窗口开不出来
 * ⇒ 启动看门狗退出应用（用户看到「F5 后 app 自动关闭」）✗✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshBrowserToolSchema
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PLUGINS = 'dsh-plugins';
const BROWSER = 'dsh-plugins/vssaros-browser/lib/index.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去整行 `//` 注释（注释里会解释这个坑，别被它骗过去） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('dsh 工具 schema 的 JSON Schema 子集', () => {

	test('1) browser 的 output.schema 必须用 oneOf（string / object 两分支互斥）', () => {
		const src = code(BROWSER);
		const at = src.indexOf('output: {');
		assert.ok(at > 0, '找不到工具的 output 段');
		const body = src.slice(at, at + 900);
		assert.match(body, /schema:\s*\{\s*oneOf:\s*\[/, 'output.schema 必须是 oneOf');
		assert.ok(!/schema:\s*\{\s*anyOf\s*:/.test(body), 'anyOf 不被 rc.2 的 schemastery 支持 ✗');
	});

	test('2) 任何插件的 lib/*.js 里都不许再出现 `schema: { anyOf`', () => {
		const root = path.join(process.cwd(), PLUGINS);
		const offenders: string[] = [];
		for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory() || !dir.name.startsWith('vssaros-')) { continue; }
			const lib = path.join(root, dir.name, 'lib');
			if (!fs.existsSync(lib)) { continue; }
			for (const f of fs.readdirSync(lib)) {
				if (!/\.(js|mjs|cjs)$/.test(f)) { continue; }
				// vendor / 打包产物（archify 的 ajv 校验器、superagent 的 zod 产物）不是 cordis 工具 schema
				if (/generated-validators|poll-|bundle|vendor/i.test(f)) { continue; }
				const src = code(path.join(PLUGINS, dir.name, 'lib', f));
				if (/schema:\s*\{\s*anyOf\s*:/.test(src)) { offenders.push(dir.name + '/lib/' + f); }
			}
		}
		assert.deepStrictEqual(offenders, [], '这些文件的工具 schema 用了 anyOf（rc.2 会抛 JsonSchemaError）：' + offenders.join(', '));
	});
});
