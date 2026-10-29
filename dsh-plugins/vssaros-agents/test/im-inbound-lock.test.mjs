/**
 * 入站长连接互斥锁（`lib/imInboundLock.js`）单测。
 *
 * 背景（2026-10-29 真机定案）：飞书对同一应用只让一条长连接收到事件，而机器上可能
 * 同时有几个 Host（旧 Host 未回收 / dev 版与正式版是两个 dataRoot）。没有这把锁时，
 * 症状是「日志全绿 + 心跳正常 + 零事件」—— 这组断言就钉住"抢不到就别连"。
 *
 * ⚠ 每个用例用**不同的平台名**（= 不同锁文件），否则前一条用例写的锁会污染后一条
 *   （第一版就是这么红的：三个用例互相踩，看着像逻辑错）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	IM_LOCK_STALE_MS, imLockPath, isPidAlive,
	releaseImLock, startImLockHeartbeat, touchImLock, tryAcquireImLock,
} from '../lib/imInboundLock.js';

const home = mkdtempSync(join(tmpdir(), 'vssaros-lock-'));
const alivePid = process.ppid; // 父进程一定活着，且不是自己
let pass = 0;
const fails = [];
const check = async (name, fn) => {
	try { await fn(); pass += 1; console.log('  ok   ' + name); }
	catch (e) { fails.push(name + ' / ' + (e && e.message)); console.log('  FAIL ' + name + ' / ' + (e && e.message)); }
};

await check('锁文件放在 home 下（跨 dataRoot 才能互斥）', async () => {
	const p = imLockPath('p_path', home);
	assert.equal(p, join(home, '.vssaros-im-p_path.lock'));
	assert.ok(!p.includes('dataRoot'), '锁路径不能依赖 dataRoot');
});

await check('非法平台名直接拒绝（防路径注入）', async () => {
	assert.throws(() => imLockPath('../evil', home));
	assert.throws(() => imLockPath('', home));
});

await check('首次抢锁成功并落盘（记下 pid 与 dataRoot）', async () => {
	const r = await tryAcquireImLock('p_first', { dataRoot: '/data/dev', home, pid: process.pid });
	assert.equal(r.ok, true);
	const j = JSON.parse(readFileSync(imLockPath('p_first', home), 'utf8'));
	assert.equal(j.pid, process.pid);
	assert.equal(j.dataRoot, '/data/dev');
	assert.equal(j.platform, 'p_first');
	assert.ok(j.heartbeatAt > 0);
});

await check('★ 另一个活进程占着 / 抢不到，并回报 holder', async () => {
	await tryAcquireImLock('p_busy', { dataRoot: '/data/dev', home, pid: process.pid });
	const r = await tryAcquireImLock('p_busy', { dataRoot: '/data/formal', home, pid: alivePid });
	assert.equal(r.ok, false, '不同 pid 且都活着 / 不许抢');
	assert.equal(r.holder.pid, process.pid, 'holder 应指向先拿到锁的那个');
	assert.equal(r.holder.dataRoot, '/data/dev');
});

await check('★ 同一个 pid 重复抢 / 视为自己（幂等，不报冲突）', async () => {
	await tryAcquireImLock('p_same', { dataRoot: '/d', home, pid: process.pid });
	const r = await tryAcquireImLock('p_same', { dataRoot: '/d2', home, pid: process.pid });
	assert.equal(r.ok, true, '自己已经持有 / 可重复拿');
	assert.equal(JSON.parse(readFileSync(imLockPath('p_same', home), 'utf8')).dataRoot, '/d2');
});

await check('持有者进程已死 / 陈旧锁可以抢', async () => {
	writeFileSync(imLockPath('p_dead', home), JSON.stringify({
		format: 1, platform: 'p_dead', pid: 999999, dataRoot: '/old', acquiredAt: 1, heartbeatAt: Date.now(),
	}), 'utf8');
	const r = await tryAcquireImLock('p_dead', { dataRoot: '/new', home, pid: process.pid });
	assert.equal(r.ok, true, 'pid 不存在 / 陈旧锁');
});

await check('心跳过期（超过 staleMs）/ 即使 pid 活着也能抢', async () => {
	writeFileSync(imLockPath('p_stale', home), JSON.stringify({
		format: 1, platform: 'p_stale', pid: alivePid, dataRoot: '/stale',
		acquiredAt: 1, heartbeatAt: Date.now() - IM_LOCK_STALE_MS - 1000,
	}), 'utf8');
	const r = await tryAcquireImLock('p_stale', { dataRoot: '/mine', home, pid: process.pid });
	assert.equal(r.ok, true, '心跳过期 / 认为持有者已经不干活了');
});

await check('touch 只续自己的锁（别人持有时不覆盖）', async () => {
	writeFileSync(imLockPath('p_touch', home), JSON.stringify({
		format: 1, platform: 'p_touch', pid: alivePid, dataRoot: '/other', acquiredAt: 1, heartbeatAt: 100,
	}), 'utf8');
	const ok = await touchImLock('p_touch', { pid: process.pid, home });
	assert.equal(ok, false);
	assert.equal(JSON.parse(readFileSync(imLockPath('p_touch', home), 'utf8')).heartbeatAt, 100);
});

await check('release 只删自己的锁；别人的锁不动', async () => {
	writeFileSync(imLockPath('p_rel', home), JSON.stringify({
		format: 1, platform: 'p_rel', pid: alivePid, acquiredAt: 1, heartbeatAt: Date.now(),
	}), 'utf8');
	assert.equal(await releaseImLock('p_rel', { pid: process.pid, home }), false, '别人的锁不能删');
	assert.ok(existsSync(imLockPath('p_rel', home)), '别人的锁必须留着');

	// 清掉换成自己持有，再释放
	rmSync(imLockPath('p_rel', home), { force: true });
	await tryAcquireImLock('p_rel', { dataRoot: '/x', home, pid: process.pid });
	assert.equal(await releaseImLock('p_rel', { pid: process.pid, home }), true);
	assert.ok(!existsSync(imLockPath('p_rel', home)));
});

await check('心跳定时器会真的续期（可停止）', async () => {
	await tryAcquireImLock('p_hb', { dataRoot: '/hb', home, pid: process.pid, now: 1000 });
	const stop = startImLockHeartbeat('p_hb', { pid: process.pid, home, intervalMs: 20 });
	await new Promise((r) => setTimeout(r, 90));
	stop();
	const j = JSON.parse(readFileSync(imLockPath('p_hb', home), 'utf8'));
	assert.ok(j.heartbeatAt > 1000, `心跳应已续期，实际 ${j.heartbeatAt}`);
});

await check('isPidAlive：自己 true；不存在的 pid false', async () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(999999), false);
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive('abc'), false);
});

rmSync(home, { recursive: true, force: true });
if (fails.length) {
	console.log(`\nX ${fails.length}/${pass + fails.length} failed:`);
	for (const f of fails) { console.log('   - ' + f); }
	process.exitCode = 1;
} else {
	console.log(`\nOK lock tests ${pass}/${pass} all passed`);
}
