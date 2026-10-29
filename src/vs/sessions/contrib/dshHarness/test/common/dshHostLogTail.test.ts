/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * keepAlive 模式下 ready 之后**继续**读 Host 日志（2026-10-29）。
 *
 * 事故：ready 时 `clearInterval(filePoll)` 后就再也不读 `dsh-run/host-*.log` ⇒ ready 之后的 Host 输出
 * 既不进 harness 日志也不进 IDE main.log ⇒ lazy 注册的补齐（发生在 ready 之后）在日志里"不存在"
 * ⇒ 误判为"补齐从不执行"，白修三轮。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshHostLogTail
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { supportsCompileCache } from '../../electron-main/dshHostSupervisor.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

function awaitReadyBody(): string {
	const src = stripComments(fs.readFileSync(path.join(process.cwd(), SUPERVISOR), 'utf8'));
	const at = src.indexOf('private _awaitReady(');
	assert.ok(at > 0, '找不到 _awaitReady');
	const end = src.indexOf('\n\tprivate ', at + 10);
	return src.slice(at, end > 0 ? end : undefined);
}

suite('keepAlive：ready 之后继续读 Host 日志', () => {

	test('① 三条成功路径都必须以 ok=true 收尾（否则 ready 后不再读日志）', () => {
		const body = awaitReadyBody();
		const okFinishes = body.match(/,\s*true\)/g) ?? [];
		assert.ok(okFinishes.length >= 3,
			`成功路径（URL 行无桥 / 桥握手超时回落 / 桥握手成功）都要 finish(..., true)，实际 ${okFinishes.length} 处`);
		// 失败路径不许带 true（Host 已退出还去轮询没有意义）
		assert.match(body, /child\.once\('exit', code => finish\(\(\) => reject\(/);
		assert.ok(!/reject\([^;]*\)\)\s*,\s*true\)/.test(body), '失败路径不能以 ok=true 收尾');
	});

	test('② ready 后的轮询必须可停：Host 退出 / 换代 / run 被清理', () => {
		const body = awaitReadyBody();
		const at = body.indexOf('const startPostReadyTail');
		assert.ok(at > 0, '必须有 startPostReadyTail');
		const fn = body.slice(at, body.indexOf('const finish', at));
		assert.match(fn, /POST_READY_LOG_POLL_MS/, '降频间隔要用常量');
		assert.match(fn, /generation !== this\._generation/, 'Host 换代后要停');
		assert.match(fn, /child\.exitCode !== null/, 'Host 退出后要停');
		assert.match(fn, /this\._runDisposables\.add\(toDisposable\(\(\) => clearInterval\(timer\)\)\)/,
			'必须挂到 _runDisposables（stop / 意外退出时一起清掉）');
	});

	test('③ 读文件必须防重入（否则同一段日志会读两遍）', () => {
		const body = awaitReadyBody();
		assert.match(body, /if \(reading\) \{\s*return;\s*\}/);
		assert.match(body, /finally \{\s*reading = false;\s*\}/);
	});

	test('④ NODE_COMPILE_CACHE：只在 Node ≥ 22.1 开，且不覆盖用户自己的设置', () => {
		assert.strictEqual(supportsCompileCache('v22.22.1'), true);
		assert.strictEqual(supportsCompileCache('22.1.0'), true);
		assert.strictEqual(supportsCompileCache('v23.0.0'), true);
		assert.strictEqual(supportsCompileCache('v22.0.9'), false);
		assert.strictEqual(supportsCompileCache('v20.18.0'), false);
		assert.strictEqual(supportsCompileCache(''), false);
		assert.strictEqual(supportsCompileCache(undefined), false);
		const src = stripComments(fs.readFileSync(path.join(process.cwd(), SUPERVISOR), 'utf8'));
		assert.match(src, /if \(!env\.NODE_COMPILE_CACHE && supportsCompileCache\(node\.version\)/,
			'用户已设 NODE_COMPILE_CACHE 时不能覆盖');
	});
});
