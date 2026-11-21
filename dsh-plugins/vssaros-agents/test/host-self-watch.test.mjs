/**
 * 父进程看护（`lib/hostSelfWatch.js`）单测。
 *
 * 背景（2026-10-29 真机）：每次重启 app 都会 spawn 新 Host，旧 Host 不死 ⇒ 攒出 3 个 Host
 * ⇒ 同一飞书应用多条长连接互相抢事件。判据是"我的父进程（app）还在不在"。
 *
 * ⚠ 这条用例组里有一半是异步的（要等巡检定时器）⇒ `check` 必须 await，
 *   否则断言失败只是 reject 一个没人管的 Promise（静默通过，最坑的一种"假绿"）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_OWNERSHIP_KEY, pidAlive, readHostOwnership, startAppParentWatch } from '../lib/hostSelfWatch.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => {
	try { await fn(); pass += 1; console.log('  ok   ' + name); }
	catch (e) { fails.push(name + ' / ' + (e && e.message)); console.log('  FAIL ' + name + ' / ' + (e && e.message)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check('pidAlive：自己 true；不存在 false；<=1 false；非数字 false', async () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(999999), false);
	assert.equal(pidAlive(1), false);
	assert.equal(pidAlive(0), false);
	assert.equal(pidAlive('abc'), false);
});

await check('ppid <= 1 ⇒ 不启用看护（没有可跟踪的父进程，不该被自动杀）', async () => {
	let logged = '';
	const stop = startAppParentWatch({
		appPid: 1, log: (m) => { logged = m; },
		isAlive: () => false,
		exit: () => { throw new Error('不该 exit'); },
	});
	assert.match(logged, /未启用父进程看护/);
	stop();
});

await check('★ 父进程活着 ⇒ 不退出', async () => {
	let exited = false;
	let calls = 0;
	const stop = startAppParentWatch({
		appPid: process.ppid, intervalMs: 200, log: () => { },
		exit: () => { exited = true; },
		isAlive: () => { calls += 1; return true; },
	});
	await sleep(520);
	stop();
	assert.equal(exited, false, '父进程活着时绝不能退出');
	assert.ok(calls >= 2, `应至少巡检 2 次，实际 ${calls}`);
});

await check('★ 父进程死一次 ⇒ 只观望（app 可能正在重启），不退出', async () => {
	let exited = false;
	const logs = [];
	const stop = startAppParentWatch({
		appPid: 424242, intervalMs: 200, log: (m) => logs.push(m),
		exit: () => { exited = true; },
		isAlive: () => false,
	});
	await sleep(260);
	stop();
	assert.equal(exited, false, '第 1 次判定死亡只观望');
	assert.ok(logs.some((m) => /暂不可见/.test(m)), '应记一条观望日志');
});

await check('★ 父进程连续两次死亡 ⇒ 主动退出（exit 0）', async () => {
	let code = null;
	const logs = [];
	const stop = startAppParentWatch({
		appPid: 424242, intervalMs: 120, log: (m) => logs.push(m),
		exit: (c) => { code = c; },
		isAlive: () => false,
	});
	await sleep(420);
	stop();
	assert.equal(code, 0, '连续两次死亡后应 exit(0)');
	assert.ok(logs.some((m) => /孤儿/.test(m)), '日志要点明"孤儿"与后果');
});

await check('中途恢复（父进程又可见）⇒ 计数清零，不退出', async () => {
	let exited = false;
	let n = 0;
	const stop = startAppParentWatch({
		appPid: 424242, intervalMs: 120, log: () => { },
		exit: () => { exited = true; },
		isAlive: () => { n += 1; return n !== 2; },
	});
	await sleep(480);
	stop();
	assert.equal(exited, false, '中间恢复过一次 ⇒ 不该退出');
});

await check('★ 未来 mtime 属于本 Host ⇒ 识别为优雅分离；过去/mismatch 不认', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-host-self-watch-'));
	const file = join(dir, 'owner.json');
	const previous = globalThis[HOST_OWNERSHIP_KEY];
	try {
		writeFileSync(file, JSON.stringify({ format: 1, hostPid: 424242, appPid: 999999, instanceId: 'x', profile: 'p', startedAt: 1, files: [] }));
		globalThis[HOST_OWNERSHIP_KEY] = { clientCount: 0, ownerRecordPath: file };
		const future = new Date(Date.now() + 12 * 60 * 60 * 1000);
		utimesSync(file, future, future);
		const detached = readHostOwnership({ selfPid: 424242 });
		assert.ok(detached?.detachedUntil && detached.detachedUntil > Date.now(), '未来 mtime 必须返回 detachedUntil');
		assert.equal(detached?.appPid, undefined, 'appPid 已死时不应凭 pid 复用误判');
		const past = new Date(Date.now() - 60_000);
		utimesSync(file, past, past);
		assert.equal(readHostOwnership({ selfPid: 424242 })?.detachedUntil, undefined, '过去 mtime 不是优雅分离');
		writeFileSync(file, JSON.stringify({ format: 1, hostPid: 999, appPid: 999999, instanceId: 'x', profile: 'p', startedAt: 1, files: [] }));
		utimesSync(file, future, future);
		assert.equal(readHostOwnership({ selfPid: 424242 })?.detachedUntil, undefined, '别的 Host 的未来 mtime 不许认');
	} finally {
		if (previous === undefined) { delete globalThis[HOST_OWNERSHIP_KEY]; }
		else { globalThis[HOST_OWNERSHIP_KEY] = previous; }
		rmSync(dir, { recursive: true, force: true });
	}
});

await check('★ keepAlive 优雅分离期间 ⇒ 父进程死了也不自退', async () => {
	let exited = false;
	const logs = [];
	const stop = startAppParentWatch({
		appPid: 424242, intervalMs: 120, log: (m) => logs.push(m),
		exit: () => { exited = true; },
		isAlive: () => false,
		ownership: () => ({ inUse: false, detachedUntil: Date.now() + 60_000 }),
	});
	await sleep(420);
	stop();
	assert.equal(exited, false, 'detachedUntil 未过期时必须保住 Host');
	assert.ok(logs.some((m) => /优雅分离/.test(m)), '应留一行 keepAlive 不自退的日志');
});

await check('★ detachedUntil 过期后 ⇒ 恢复真孤儿回收', async () => {
	let code = null;
	const stop = startAppParentWatch({
		appPid: 424242, intervalMs: 120, log: () => { },
		exit: (c) => { code = c; },
		isAlive: () => false,
		ownership: () => ({ inUse: false, detachedUntil: Date.now() - 1 }),
	});
	await sleep(420);
	stop();
	assert.equal(code, 0, '标记过期后仍要 exit(0)');
});

if (fails.length) {
	console.log(`\nX ${fails.length}/${pass + fails.length} failed:`);
	for (const f of fails) { console.log('   - ' + f); }
	process.exitCode = 1;
} else {
	console.log(`\nOK host self watch tests ${pass}/${pass} all passed`);
}
