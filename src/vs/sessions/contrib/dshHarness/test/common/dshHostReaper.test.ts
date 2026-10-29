/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 孤儿 Host 治理（2026-10-29）—— 三个面：
 *   ① 纯函数：从 instanceId 反解宿主 pid（租约里没有 appPid 字段 ⇒ 只能从 instanceId 拿 ✓）；
 *   ② 回收器行为：**杀不掉就不能删记录**（★ 本次修的真 bug）；
 *   ③ 主进程接线：把"明确不复用、且宿主已退出"的租约 Host 也纳入回收候选。
 *
 * ★ 真机事故（2026-10-29）：同一台机器上三个 Host 并存（打包版 5745、dev 7965、dev 1974）⇒
 *   下次启动被迫 `--port 0` 换端口 ⇒ dsh 把端口写进**每条 system 提示** ⇒ provider 的
 *   prompt 前缀缓存整段失效（真机：命中率 6.4% vs 98.6%）。
 *   根因之二：回收器原来"taskkill 一返回就删 owner 记录"，哪怕进程还活着 ⇒ 记录一丢
 *   ⇒ 这个 Host 再也没人能认出来 ⇒ 永远回收不掉 ✓（本文件②钉的就是这条）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshHostReaper
 */

import assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { appPidOfInstanceId, hostRunOwnershipFileName, orphanLeaseCandidates } from '../../common/dshHostRunOwnership.js';
import { reapOrphanHosts } from '../../electron-main/dshHostReaper.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

/** 造一份拥有者记录 + 若干覆盖层文件（覆盖层内容无所谓）。 */
function makeRun(dir: string, runId: string, files: string[], appPid = 999_001, hostPid = 999_002): void {
	writeFileSync(join(dir, hostRunOwnershipFileName(runId)), JSON.stringify({
		format: 1,
		runId,
		appPid,
		hostPid,
		instanceId: 'vssaros-' + appPid + '-abcd1234',
		profile: 'vssaros',
		startedAt: Date.now() - 60_000,
		files,
	}), 'utf8');
	for (const f of files) {
		writeFileSync(join(dir, f), 'x', 'utf8');
	}
}

suite('dshHarness / 孤儿 Host 治理', () => {

	test('① instanceId ⇒ 宿主 pid（认不出就别认）', () => {
		assert.strictEqual(appPidOfInstanceId('vssaros-48424-f0a536ff'), 48424);
		assert.strictEqual(appPidOfInstanceId('vssaros-1-a'), 1);
		// 认不出 ⇒ undefined（调用方据此判"保守：不动" ✓）
		assert.strictEqual(appPidOfInstanceId('other-48424-x'), undefined);
		assert.strictEqual(appPidOfInstanceId('vssaros--x'), undefined);
		assert.strictEqual(appPidOfInstanceId(''), undefined);
	});

	test('①b 租约候选：宿主还活着 ⇒ 一律不动（多实例不能误杀）；宿主死了且明确不复用 ⇒ 才算候选', () => {
		const lease = { pid: 13536, instanceId: 'vssaros-48424-f0a536ff' };
		const alive = (pid: number) => pid === 48424;   // 宿主还活着
		// 宿主活着 ⇒ 不动（哪怕我们"不复用"它）
		assert.deepStrictEqual(orphanLeaseCandidates(lease, {
			notReusableReason: '插件已变更', selfAppPid: 999, isAlive: alive,
		}), [], '宿主还活着 ⇒ 绝不能动（另一个窗口正接在上面 ✗）');
		// 宿主死了 + 明确不复用 ⇒ 才是候选
		const candidates = orphanLeaseCandidates(lease, {
			notReusableReason: '插件已变更', selfAppPid: 999, isAlive: () => false,
		});
		assert.strictEqual(candidates.length, 1, '宿主已退出 ⇒ 应当成为回收候选 ✓');
		assert.strictEqual(candidates[0].pid, 13536);
		// 没有"明确不复用"的理由 ⇒ 不动（可能只是探活失败 ⇒ 误杀风险 ✗）
		assert.deepStrictEqual(orphanLeaseCandidates(lease, {
			notReusableReason: undefined, selfAppPid: 999, isAlive: () => false,
		}), [], '没有明确理由 ⇒ 不当候选 ✓');
		// 认不出宿主 ⇒ 不动
		assert.deepStrictEqual(orphanLeaseCandidates({ pid: 13536, instanceId: 'weird' }, {
			notReusableReason: '插件已变更', selfAppPid: 999, isAlive: () => false,
		}), [], '认不出宿主 ⇒ 保守：不动 ✓');
		// 租约本身没有 ⇒ 不动
		assert.deepStrictEqual(orphanLeaseCandidates(undefined, {
			notReusableReason: '插件已变更', selfAppPid: 999, isAlive: () => false,
		}), []);
	});

	test('② 杀掉了 ⇒ 拥有者记录与覆盖层一起清掉', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-reap-'));
		try {
			makeRun(dir, 'aaaa1111bbbb', ['bridge-aaaa1111bbbb.yml']);
			const killed: number[] = [];
			const report = await reapOrphanHosts({
				runDir: dir,
				selfAppPid: 1,
				log: () => undefined,
				isAlive: pid => pid === 999_002,   // 只有 Host 活着；宿主（appPid）已退出 ⇒ 可回收 ✓
				killTree: async pid => { killed.push(pid); },
				waitExit: async () => true,
			});
			assert.strictEqual(report.reaped.length, 1);
			assert.deepStrictEqual(killed, [999_002]);
			assert.ok(!existsSync(join(dir, hostRunOwnershipFileName('aaaa1111bbbb'))), '记录必须清掉 ✓');
			assert.ok(!existsSync(join(dir, 'bridge-aaaa1111bbbb.yml')), '覆盖层必须清掉 ✓');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('③ ★ 杀不掉 ⇒ 记录与覆盖层必须保留（删了就永远认不出来 ⇒ 僵尸）', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-reap-'));
		try {
			makeRun(dir, 'cccc2222dddd', ['bridge-cccc2222dddd.yml']);
			const report = await reapOrphanHosts({
				runDir: dir,
				selfAppPid: 1,
				log: () => undefined,
				isAlive: pid => pid === 999_002,   // 只有 Host 活着；宿主（appPid）已退出 ⇒ 可回收 ✓
				killTree: async () => undefined,
				waitExit: async () => false,   // ★ 进程还活着（taskkill 失败 / 正在优雅退出）
			});
			assert.strictEqual(report.reaped.length, 1, '判"可回收"没错');
			assert.ok(existsSync(join(dir, hostRunOwnershipFileName('cccc2222dddd'))),
				'★ 杀不掉时**必须保留**拥有者记录（否则它再也没人能认出来 ⇒ 永远占着端口 ✗）');
			assert.ok(existsSync(join(dir, 'bridge-cccc2222dddd.yml')),
				'★ 杀不掉时覆盖层也要保留（下一轮才清）');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('④ extraCandidates：租约里那个"宿主已退出"的 Host 也会被结束', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dsh-reap-'));
		try {
			const killed: number[] = [];
			await reapOrphanHosts({
				runDir: dir,
				selfAppPid: 1,
				log: () => undefined,
				isAlive: () => true,   // 候选 pid 4242 活着 ⇒ 会被结束 ✓
				killTree: async pid => { killed.push(pid); },
				waitExit: async () => true,
				extraCandidates: [{ pid: 4242, reason: '租约里的 Host 宿主已退出' }],
			});
			assert.deepStrictEqual(killed, [4242], '额外候选必须被结束 ✓');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('⑤ 接线：主进程必须把"明确不复用"的租约 Host 交给回收器', () => {
		const src = readFileSync(SUPERVISOR, 'utf8');
		assert.ok(/extraCandidates:\s*orphanLeaseCandidates\(existing,/.test(src),
			'回收器必须收到租约候选（否则 keepAlive 留下的旧 Host 永远没人管 ✗）');
		assert.ok(/notReusableReason:/.test(src),
			'必须显式给出"为什么不复用"（探活失败不该当候选 ✗）');
		assert.ok(/isAlive:\s*pidAlive/.test(src),
			'存活判定要走真实的 pidAlive（宿主活着就不动 ✗）');
	});
});
