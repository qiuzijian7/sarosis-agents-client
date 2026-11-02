/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「偏好端口被自己的残留 Host 占着时要回收，别人的进程不许动」的守卫（2026-11-02，P0）。
 *
 * 动机（两处实测代价，见 `dshHostPortManager.reclaimLoopbackPort` 的长注释）：
 *   ① dsh 把 `http://127.0.0.1:<port>` 写进每条 system 提示 ⇒ 端口一变，prompt 前缀缓存整段失效
 *      （真机：同一会话 6 次请求，302 行里 299 行逐字相同，唯一差异是端口 ⇒ 命中率 6.4% vs 98.6%）；
 *   ② 前端按 origin 缓存 ⇒ 端口变 ⇒ 每次冷启动重下/重解析 chunk
 *      （对比 `dsh-desktop`：固定 43129 优先，注释写明 "so Chromium can reuse the Harness frontend cache"）。
 *
 * 而 `resolveHostPort` 只在端口**空闲**时复用 ⇒ 上次 Host 没退干净（僵尸 / keepAlive 残留）就回落
 * `--port 0` ⇒ 实测四次启动拿到 4109 / 12637 / 53383 / 54980，稳定性等于没生效。
 *
 * 安全边界（本守卫重点）：**只回收命令行里含本次 dsh `bin.js` 的进程**，别人占端口一律不动。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshHostPortReclaim
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PORT_MANAGER = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostPortManager.ts';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 只去整行 `//` 注释（源文件里可能有含 `/*` 的字符串，块注释正则会吞掉大段） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('偏好端口回收（只回收自己的残留 Host）', () => {

	test('1) 必须先判空闲、再取 owner + 命令行，且归属不匹配时**不许 kill**', () => {
		const src = code(PORT_MANAGER);
		const at = src.indexOf('export async function reclaimLoopbackPort(');
		assert.ok(at > 0, '缺少 reclaimLoopbackPort');
		const body = src.slice(at, at + 2600);
		assert.match(body, /if \(await isLoopbackPortFree\(port\)\) \{\s*\n\s*return 'free';/,
			'必须先判空闲（空闲就不用回收）');
		assert.match(body, /findLoopbackPortOwner\(port\)/, '必须取监听端口的 owner pid');
		assert.match(body, /processCommandLine\(owner\)/, '必须取 owner 的命令行做归属判断');
		// 归属判定：命令行必须含本次 dsh bin 路径；不匹配 ⇒ foreign（不动）
		assert.match(body, /norm\(cmd\)\.includes\(norm\(ownDshBinPath\)\)/, '必须按 dsh bin 路径判定"是不是我们自己的 Host"');
		const iForeign = body.indexOf("return 'foreign';");
		const iKill = body.indexOf('killTree(owner);');
		assert.ok(iForeign > 0 && iKill > iForeign,
			'归属不匹配必须先 return foreign —— 绝不能走到 killTree（杀无关进程是不可接受的副作用）');
	});

	test('2) 回收后要**轮询**等端口真正释放（不是杀完就当成功）', () => {
		const src = code(PORT_MANAGER);
		const at = src.indexOf('export async function reclaimLoopbackPort(');
		const body = src.slice(at, at + 2600);
		assert.match(body, /const deadline = Date\.now\(\) \+ \d+;/, '必须有截止时间（不能无限等）');
		assert.match(body, /while \(Date\.now\(\) < deadline\) \{/, '必须轮询等待端口释放');
		assert.match(body, /if \(await isLoopbackPortFree\(port\)\) \{\s*\n\s*return 'reclaimed';/, '只有真的空闲才返回 reclaimed');
	});

	test('3) supervisor：resolveHostPort 回落 0 时必须尝试回收偏好端口', () => {
		const src = code(SUPERVISOR);
		const iResolve = src.indexOf('let hostPort = await resolveHostPort(hostHome);');
		const iReclaim = src.indexOf('await reclaimLoopbackPort(preferredPort, dsh.bin);');
		assert.ok(iResolve > 0, '找不到 resolveHostPort 调用（变量名变了？）');
		assert.ok(iReclaim > iResolve, '必须在 resolveHostPort 判 0 之后尝试 reclaim');
		// 必须把 dsh.bin 传进去 —— 归属判定靠它，不能凭"端口上有进程"就杀
		assert.match(src, /await reclaimLoopbackPort\(preferredPort, dsh\.bin\);/, '必须把 dsh.bin 传进去做归属判定');
		assert.match(src, /端口会变，前端缓存与 prompt 前缀缓存可能失效/, '回落 0 时必须留下降级日志（否则现场看不出"为什么端口又变了"）');
	});
});
