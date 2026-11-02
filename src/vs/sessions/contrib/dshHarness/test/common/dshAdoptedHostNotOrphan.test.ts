/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「被接管的 Host 不许被父进程看护当成孤儿杀掉」守卫（2026-11-02）。
 *
 * 真机（`20261102T204521`）：F5 新 app 按 keepAlive 接管了上一个 app 拉起的 Host；
 * `vssaros-agents/lib/hostSelfWatch.js` 只认 spawn 时的 `process.ppid` ⇒ 旧 app 一退就 `exit(0)`
 * ⇒ 新 app 页面连接重试 20s、建会话失败，46s 后才重起 Host（端到端 51.5s）。
 *
 * 修法：vssaros-bridge 把"当前拥有者"（握手给的 owner 记录 + IDE 客户端数）发布到
 * `globalThis[Symbol.for('vssaros.hostOwnership')]`；看护在父进程看不见时先问它：
 * 被接管 ⇒ 改看护新 app；仍有客户端 ⇒ 不退；都不是 ⇒ 照旧计失败退出（孤儿治理不变）。
 * 行为（11 个场景）已用注入假 isAlive/exit/ownership 实测；这里钉源码，防回归。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAdoptedHostNotOrphan
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const WATCH = 'dsh-plugins/vssaros-agents/lib/hostSelfWatch.js';
const BRIDGE = 'dsh-plugins/vssaros-bridge/lib/index.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 去整行 `//` 与以 ` *` 开头的块注释行（注释里会提到旧行为） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
}

suite('被接管的 Host 不是孤儿', () => {

	test('1) 两边用同一把共享钥匙', () => {
		assert.match(code(WATCH), /Symbol\.for\('vssaros\.hostOwnership'\)/, '看护必须读 Symbol.for(\'vssaros.hostOwnership\')');
		assert.match(code(BRIDGE), /globalThis\[Symbol\.for\('vssaros\.hostOwnership'\)\] = \{/, '桥插件必须发布到同一把钥匙');
	});

	test('2) 桥插件：客户端数变化与握手换 owner 时都要发布', () => {
		const src = code(BRIDGE);
		const at = src.indexOf('const noteClients = () => {');
		assert.ok(at > 0, '找不到 noteClients');
		assert.match(src.slice(at, at + 200), /connectedClients = clients\.size;\s*\n\s*publishHostOwnership\(\);/,
			'noteClients 一进来就要发布（握手、断开、出错三条路都经过它）');
		const iOwner = src.indexOf('ownerRecordPath = req.params.ownerRecord;');
		const iNote = src.indexOf('noteClients();', iOwner);
		assert.ok(iOwner > 0 && iNote > iOwner && iNote - iOwner < 200,
			'握手里更新 ownerRecordPath 之后必须紧接着 noteClients()（⇒ 发布的是新 owner）');
		assert.match(src, /ownerRecordPath: ownerRecordPath \|\| '',\s*\n\s*clientCount: clients\.size,/, '发布内容必须含 owner 记录路径与客户端数');
	});

	test('3) 看护：父进程不可见时先问拥有者；被接管 ⇒ 改看护；有客户端 ⇒ 不退', () => {
		const src = code(WATCH);
		const at = src.indexOf('const tick = () => {');
		assert.ok(at > 0, '找不到 tick');
		const body = src.slice(at, at + 2600);
		const iAlive = body.indexOf('if (isAlive(parent)) {');
		const iOwner = body.indexOf('owner = ownership();');
		const iMiss = body.indexOf('misses += 1;');
		assert.ok(iAlive >= 0 && iOwner > iAlive && iMiss > iOwner, '顺序必须是：父进程活着 → 问拥有者 → 才计失败');
		assert.match(body, /owner\.appPid !== parent && isAlive\(owner\.appPid\)\) \{[\s\S]{0,260}parent = owner\.appPid;\s*\n\s*misses = 0;/,
			'被接管（拥有者 appPid 活着且不是旧父进程）⇒ 必须改看护它并清零失败计数');
		assert.match(body, /if \(owner && owner\.inUse\) \{[\s\S]{0,260}misses = 0;\s*\n\s*return;/, '仍有 IDE 客户端连着 ⇒ 不计失败');
		assert.match(src, /let parent = Number\(appPid\);/, 'parent 必须可改（接管后要换目标）');
	});

	test('4) 读拥有者记录要防 pid 复用：心跳新鲜 + 记录属于本 Host', () => {
		const src = code(WATCH);
		const at = src.indexOf('export function readHostOwnership(');
		assert.ok(at > 0, '找不到 readHostOwnership');
		const body = src.slice(at, at + 1600);
		assert.match(body, /now - statSync\(file\)\.mtimeMs <= OWNER_RECORD_STALE_MS/, '必须检查心跳（mtime）新鲜度');
		assert.match(body, /Number\(record\?\.hostPid\) === Number\(selfPid\)/, '必须确认记录是本 Host 的');
		assert.match(body, /if \(fresh && forSelf && Number\.isFinite\(pid\) && pid > 1\) \{/, '三个条件缺一不可');
	});
});
