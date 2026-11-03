/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「loop / workbenches 的工具必须注册得上」守卫（2026-11-03）。
 *
 * 真机（打包版 Host 日志，两个插件的 apply 都抛错 ⇒ 工具/能力静默缺失）：
 *   ① `error vssaros-loop: TypeError: log is not a function`（runner.js 的 start）
 *      —— index.js 传的是 `ctx.logger(...)` / `console`（**对象**），而 runner 的 deps 约定是
 *        `log(level, msg)`（**函数**）⇒ `runner.start()` 必抛 ⇒ ticker 起不来。
 *   ② `error vssaros-workbenches: Error: cannot get property "tools" without inject`
 *      —— `ctx.inject(['tools'], () => { const tools = ctx.tools; … })` 在 inject 回调里用**父** ctx
 *        取服务 ⇒ cordis 必抛 ⇒ `install_local_workbench` / `check_local_workbench` 注册不上。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshLoopWorkbenchToolBoot
 */

import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOP = 'dsh-plugins/vssaros-loop/lib/index.js';
const WB = 'dsh-plugins/vssaros-workbenches/lib/index.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 去整行 `//` 与以 ` *` 开头的块注释行（注释里会提到旧写法） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
}

suite('loop / workbenches 的工具能注册上', () => {

	test('1) loop：apply 提供 runs 服务时 runner 必须起得来（不许 log is not a function）', async () => {
		const mod = await import(pathToFileURL(path.join(process.cwd(), LOOP)).href) as {
			apply(ctx: unknown, config?: unknown): void;
		};
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-boot-'));
		const errors: string[] = [];
		const registered: string[] = [];
		const logs: string[] = [];
		try {
			// 与真机一致：logger 返回**对象**（info/warn/error），不是 log(level,msg) 函数
			const ctx = {
				logger: () => ({ info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }),
				tools: {
					register: (def: { name: string }) => { registered.push(def.name); return () => { }; },
					get: () => undefined,
				},
				inject(names: string[], cb: (scope: unknown) => void) {
					if (names[0] === 'vssarosRuns') {
						try { cb({ vssarosRuns: { run: async () => ({ ok: true }) } }); } catch (e) {
							errors.push('runs 回调抛错：' + String((e as Error)?.message ?? e));
						}
					}
					return undefined;
				},
				effect(fn: () => void) {
					try { fn(); } catch (e) { errors.push('effect 抛错：' + String((e as Error)?.message ?? e)); }
					return () => { };
				},
				on: () => () => { },
			};
			mod.apply(ctx, { dataRoot: tmp, cwd: tmp });
		} catch (e) {
			errors.push('apply 抛错：' + String((e as Error)?.message ?? e));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
		assert.ok(!errors.some(e => /log is not a function/.test(e)),
			'runner.start() 不许再抛 log is not a function（index.js 必须把对象 log 适配成 log(level,msg)）：' + errors.join(' | '));
		assert.ok(logs.some(l => /runner 已启动/.test(l)), 'runner 必须真的启动（日志里要有 "runner 已启动"）；实际日志：' + JSON.stringify(logs.slice(0, 3)));
		for (const name of ['loop_list', 'loop_show', 'loop_dry_run', 'loop_run', 'loop_answer']) {
			assert.ok(registered.includes(name), '工具没注册上：' + name + '（实际：' + registered.join(',') + '）');
		}
	});

	test('2) workbenches：inject 回调里必须用子 ctx 取 tools（父 ctx.tools 在 cordis 里必抛）', () => {
		const src = code(WB);
		const at = src.indexOf("ctx.inject(['tools'],");
		assert.ok(at > 0, '找不到 workbenches 的 tools 注入');
		const body = src.slice(at, at + 700);
		assert.match(body, /ctx\.inject\(\['tools'\], scope => \{/, 'inject 回调必须接收 scope（子 ctx）');
		assert.match(body, /tools = scope\?\.tools \?\? null;/, 'tools 必须取自 scope（子 ctx）');
		assert.ok(!/const tools = ctx\.tools;/.test(body),
			'不许再用父 `ctx.tools`：cordis 会抛 `cannot get property "tools" without inject` ⇒ 两个 workbench 工具注册不上');
	});
});
