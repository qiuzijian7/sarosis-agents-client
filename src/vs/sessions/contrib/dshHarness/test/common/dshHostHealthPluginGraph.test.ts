/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级闸门的健康检查**必须看插件图**（2026-10-28）。
 *
 * 现场（真机 `~/.vssaros/logs/20261028T140852/main.log` 那类）：Host 明明 `ready`、首页 200、
 * `__DSH_BOOT__` 也在，但 `@vssaros/dsh-agents` 等插件 `never started` ⇒ 新建会话被
 * `agent-preset/invalid` 直接拒掉、桌面窗口停在 hero。
 *
 * 而升级闸门（`DshUpgradeGate`）的健康检查原来只查：host running / bridge handshake / auth exchange /
 * page boot graph / companion client —— **全绿**。也就是说这类"半新半坏"会被判"升级成功"，不回退 ✗✗。
 *
 * 本守卫钉住：
 *   ① `healthCheck` 必须把插件图算进去（`phase === 'failed'` 即不健康）；
 *   ② **桥不可用 ≠ 不健康**（无从判断时不许记这一项，否则会白回退一次）；
 *   ③ 插件行的口径只有一处（启动自检与健康检查共用 `_failedPluginRows`）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshHostHealthPluginGraph
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了 plugin graph"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** 取一个方法体（从签名到下一个 `\n\tprivate ` / `\n\tasync `）。 */
function fnBody(src: string, signature: string): string {
	const at = src.indexOf(signature);
	assert.ok(at > 0, `找不到 ${signature} ✗`);
	const rest = src.slice(at + signature.length);
	const next = rest.search(/\n\t(?:private|async|protected|public)\s/);
	return rest.slice(0, next > 0 ? next : 4000);
}

suite('升级健康检查：插件图必须算进去', () => {

	test('① healthCheck 必须在 summarizeHealth 之前检查插件图', () => {
		const src = stripComments(read(SUPERVISOR));
		const body = fnBody(src, 'async healthCheck(): Promise<IDshHealthReport> {');
		const iProbe = body.indexOf('this._failedPluginRows()');
		// ⚠ 用**最后**一次 summarizeHealth：函数里有一条早退（`if (!conn) return summarizeHealth(checks)`），
		//   拿第一次当锚点会得到"插件图检查排在结果之后"的假红（实测）。
		const iSum = body.lastIndexOf('summarizeHealth(checks)');
		assert.ok(iProbe > 0, 'healthCheck 必须查插件图（`_failedPluginRows()`）—— 只看 ready/首页会把"半新半坏"判成功 ✗');
		assert.ok(iSum > iProbe, '插件图检查必须排在 summarizeHealth **之前**（之后等于没算进结果 ✗）');
		assert.ok(body.includes("name: 'plugin graph'"), '这一项要有稳定的名字（回退报告里要看得见是哪项不过 ✗）');
	});

	test('② 桥不可用 ⇒ 不记这一项（不许把"无从判断"当成不健康）', () => {
		const src = stripComments(read(SUPERVISOR));
		const body = fnBody(src, 'async healthCheck(): Promise<IDshHealthReport> {');
		// 必须是 `if (failedPlugins) { … }` 这种"有值才记"的结构；写成 `if (!failedPlugins || failedPlugins.length)` 就会白回退
		assert.match(body, /if \(failedPlugins\) \{/, '必须"拿到插件行才记这一项"（undefined = 桥不可用 ⇒ 无从判断，不该触发回退 ✗）');
		assert.ok(!/if \(!failedPlugins\) \{\s*checks\.push/.test(body),
			'不许把"桥不可用"写成不健康（会白回退一次，用户白等一轮 ✗）');
	});

	test('③ 插件行口径只有一处：启动自检与健康检查共用 `_failedPluginRows`', () => {
		const src = stripComments(read(SUPERVISOR));
		assert.ok(src.includes('private async _failedPluginRows('), '必须有 `_failedPluginRows`（口径单点）✗');
		const probe = fnBody(src, 'private async _failedPluginRows(');
		assert.ok(probe.includes("r.phase === 'failed'"), '判据必须是 `phase === failed`（与启动自检同一口径 ✗）');
		assert.match(probe, /if \(!bridge\) \{\s*return undefined;/, '桥不可用必须返回 undefined（调用方据此"不判断"）✗');
		assert.match(probe, /catch \{\s*return undefined;/, '查询失败也必须返回 undefined（自检/体检不许变成新的故障源 ✗）');

		// 启动自检不许再自己列一遍 PluginsList（否则两处口径会漂移）
		const audit = fnBody(src, 'private async _auditPluginGraph(');
		assert.ok(audit.includes('this._failedPluginRows()'), '启动自检必须复用 `_failedPluginRows`（两份口径必漂移 ✗）');
		assert.ok(!audit.includes('PluginsList'), '启动自检不许直接调 PluginsList（口径只留一处 ✗）');
	});
});
