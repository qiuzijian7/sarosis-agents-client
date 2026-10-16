/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **跨进程写锁的互通测试**（README 5.61）。
 *
 * IDE 侧 `agentStudio/common/fileWriteLock.ts` 与 dsh 插件侧 `dsh-plugins/vssaros-workflow/lib/lock.js`
 * 是**两份实现、一套协议**（没有办法共享代码：一个是 TS/浏览器层，一个是零依赖的 Node ESM 插件）⇒
 * **只有拿真实文件互抢一遍**才能证明协议没漂 ✓。只比对常量不行 ✗：常量一样、行为不同的实现照样能过，
 * 而这类漂移在真机上表现为"两边各抢各的锁、谁也不挡谁"，且**不报错** ✗ —— 正是最坏的那种沉默故障。
 *
 * 另：插件 JS 用 `pathToFileURL` 直接 import（与 `dshPluginPackages.test.ts` 同法 ✓），不需要 dsh 运行时 ✓。
 */

import assert from 'assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { URI } from '../../../../../base/common/uri.js';
import type { IExclusiveFileOps } from '../../../agentStudio/common/fileWriteLock.js';
import {
	FILE_LOCK_POLL_MS,
	FILE_LOCK_STALE_MS,
	FILE_LOCK_SUFFIX,
	FILE_LOCK_WAIT_MS,
	acquireFileLock,
	lockResourceFor,
} from '../../../agentStudio/common/fileWriteLock.js';

/** 从 cwd 往上找仓库根（同 `dshWriteOwnership.test.ts` 的约定）。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) { return dir; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

/** 测试用的 Node fs 版原语（生产走 `fileServiceOps(IFileService)` ✓）。 */
const nodeOps: IExclusiveFileOps = {
	async createExclusive(resource, text) {
		await fs.promises.writeFile(resource.fsPath, text, { flag: 'wx' });
	},
	async readText(resource) {
		try { return await fs.promises.readFile(resource.fsPath, 'utf8'); } catch { return undefined; }
	},
	async mtimeOf(resource) {
		try { return (await fs.promises.stat(resource.fsPath)).mtimeMs; } catch { return undefined; }
	},
	async touchMtime(resource) {
		// 生产实现是"原样重写"（`IFileService` 没有 touch ✓）；测试这份用 `utimes`（同效果、更省 ✓）
		const now = new Date();
		await fs.promises.utimes(resource.fsPath, now, now).catch(() => undefined);
	},
	async deleteFile(resource) {
		await fs.promises.rm(resource.fsPath, { force: true });
	},
};

interface IKanbanLock {
	acquireLock(file: string, options?: { waitMs?: number; staleMs?: number; heartbeatMs?: number }): Promise<() => Promise<void>>;
}

/** 看板插件自建的锁（同一个文件里 `export async function acquireLock` ✓）—— 协议 v2 的第三份实现 ✓。 */
async function loadKanbanLock(): Promise<IKanbanLock | undefined> {
	const root = repoRoot();
	if (!root) { return undefined; }
	const file = path.join(root, 'dsh-plugins', 'vssaros-kanban', 'lib', 'store.js');
	if (!fs.existsSync(file)) { return undefined; }
	return await import(pathToFileURL(file).href) as IKanbanLock;
}

interface IPluginLock {
	readonly FILE_LOCK_SUFFIX: string;
	readonly FILE_LOCK_WAIT_MS: number;
	readonly FILE_LOCK_STALE_MS: number;
	readonly FILE_LOCK_POLL_MS: number;
	readonly ATOMIC_TMP_POSTFIX: string;
	lockFileFor(target: string): string;
	acquireFileLock(lock: string, options?: { waitMs?: number; staleMs?: number; pollMs?: number; label?: string }): Promise<() => Promise<void>>;
}

async function loadPluginLock(): Promise<IPluginLock | undefined> {
	const root = repoRoot();
	if (!root) { return undefined; }
	const file = path.join(root, 'dsh-plugins', 'vssaros-workflow', 'lib', 'lock.js');
	if (!fs.existsSync(file)) { return undefined; }
	return await import(pathToFileURL(file).href) as IPluginLock;
}

test('★ 插件侧的锁实现是**逐字副本**（README 5.114：插件之间不能互相 import ⇒ 只能复制 ⇒ 复制就会漂 ✗）', function () {
	// 为什么单独钉"逐字一致"：协议互通性由本文件下面的**真文件互抢**保证 ✓（那份断言跑的是 workflow 的
	// 实现 ✓）—— 而 kb / skills 用的是**复制过去**的同一份 ✓。**复制品一旦被就地改动**（有人顺手"优化"
	// 了破门规则 ✗），行为断言仍在 workflow 那份上跑 ✓ ⇒ 发现不了 ✗ ⇒ 这一条正是补这个缺口 ✓。
	// 反过来：本断言通过 ⇒ kb / skills 的行为**等价于**上面已被互抢验过的那份 ✓（不需要三份都跑一遍 ✓）。
	const root = repoRoot();
	if (!root) {
		this.skip();
	}
	const files = ['vssaros-workflow', 'vssaros-kb', 'vssaros-skills']
		.map(dir => path.join(root!, 'dsh-plugins', dir, 'lib', 'lock.js'));
	for (const file of files) {
		assert.ok(fs.existsSync(file), `${file} 不存在 ✗（kb / skills 的锁是复制件，删了就得重新引入）`);
	}
	const [first, ...rest] = files.map(file => fs.readFileSync(file, 'utf8'));
	for (let i = 0; i < rest.length; i++) {
		assert.strictEqual(rest[i], first,
			`${files[i + 1]} 与 ${files[0]} **不再逐字一致** ✗ ⇒ 协议可能已漂：要么把改动同步到三份，要么把新行为并进被互抢验证的那份`);
	}
});

suite('dshHarness / cross-process write lock (IDE ⇄ dsh plugin)', () => {

	test('★ 协议常量两端一致（后缀 / 等待 / 破门阈值 / 轮询）', async function () {
		const plugin = await loadPluginLock();
		if (!plugin) { this.skip(); }
		assert.strictEqual(plugin!.FILE_LOCK_SUFFIX, FILE_LOCK_SUFFIX);
		assert.strictEqual(plugin!.FILE_LOCK_WAIT_MS, FILE_LOCK_WAIT_MS);
		assert.strictEqual(plugin!.FILE_LOCK_STALE_MS, FILE_LOCK_STALE_MS);
		assert.strictEqual(plugin!.FILE_LOCK_POLL_MS, FILE_LOCK_POLL_MS);
		// 锁文件命名也要一致（这是"两边抢的是同一个文件"的前提 ✓）
		assert.strictEqual(plugin!.lockFileFor('/x/sessions.json'), `/x/sessions.json${FILE_LOCK_SUFFIX}`);
		assert.strictEqual(lockResourceFor(URI.file(path.join(path.sep, 'x', 'sessions.json'))).fsPath.endsWith(`sessions.json${FILE_LOCK_SUFFIX}`), true);
	});

	test('★ 真互抢：IDE 持锁时插件抢不到（排队到超时）；释放后插件立刻拿到', async function () {
		const plugin = await loadPluginLock();
		if (!plugin) { this.skip(); }
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vssaros-lock-test-'));
		const target = path.join(dir, 'sessions.json');
		const lockFile = plugin!.lockFileFor(target);
		// ⚠ 锁的是**锁文件**资源（生产接线同款 `lockResourceFor(target)` ✓）—— 第一版直接把目标文件传进去，
		// 等于往 `sessions.json` 本身写锁内容 ✗（互通测试立刻抓出来了 ✓，这正是它存在的意义 ✓）。
		const releaseIde = await acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { label: '会话索引' });
		try {
			assert.ok(fs.existsSync(lockFile), 'IDE 侧抢锁后锁文件应存在（插件侧找的就是这个文件名）');
			const written = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: unknown; at?: unknown };
			assert.ok(typeof written.pid === 'number' && typeof written.at === 'string', `锁文件内容应是 {pid, at}：${JSON.stringify(written)}`);

			let blocked = '';
			try {
				await plugin!.acquireFileLock(lockFile, { waitMs: 300, pollMs: 25 });
			} catch (e) {
				blocked = String((e as Error)?.message ?? e);
			}
			assert.ok(/正被另一个写者占用/.test(blocked), `插件侧应当排队到超时并如实报"被占用"，实际：${blocked}`);

			await releaseIde();
			assert.ok(!fs.existsSync(lockFile), '释放后锁文件应被删掉');
			const releasePlugin = await plugin!.acquireFileLock(lockFile, { waitMs: 500, pollMs: 25 });
			assert.ok(fs.existsSync(lockFile), '插件侧抢到锁后锁文件应存在');
			await releasePlugin();
			assert.ok(!fs.existsSync(lockFile), '插件释放后锁文件应被删掉');
		} finally {
			await releaseIde().catch(() => undefined);
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('★ 破门互通（v1 回退路径）：锁文件**读不出 pid**（老格式 / 外部工具）⇒ 只看 mtime 破门', async function () {
		const plugin = await loadPluginLock();
		if (!plugin) { this.skip(); }
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vssaros-lock-stale-'));
		const target = path.join(dir, 'sessions.json');
		const lockFile = plugin!.lockFileFor(target);
		try {
			// ⚠ 这条是 **v1 的回退路径**：老格式 / 外部工具写的锁**读不出 pid** ⇒ 无从判断持有者死活
			// ⇒ 如实退回"只看 mtime" ✓（协议 v2 之前就是这样 ✓）。**不许**把它当成"v2 还允许随便破门" ✗
			// —— "持有者活着就不破门"另有其一整条用例 ✓。
			await fs.promises.writeFile(lockFile, 'locked-by-legacy-tool\n');
			const old = new Date(Date.now() - FILE_LOCK_STALE_MS - 5_000);
			await fs.promises.utimes(lockFile, old, old);
			const releaseIde = await acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { waitMs: 1_000, pollMs: 25 });
			assert.ok(fs.existsSync(lockFile), '破门后 IDE 侧应重新持有锁文件');
			await releaseIde();
			assert.ok(!fs.existsSync(lockFile), '释放后锁文件应消失');

			// 反过来：**新鲜**的"无 pid"锁照样不能被破门（mtime 没过期 ✓），且报错要说"持有者未知" ✓
			await fs.promises.writeFile(lockFile, 'locked-by-legacy-tool\n');
			let blocked = '';
			try {
				await acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { waitMs: 300, pollMs: 25 });
			} catch (e) {
				blocked = String((e as Error)?.message ?? e);
			}
			assert.ok(/正被另一个写者占用/.test(blocked) && /持有者未知/.test(blocked),
				`新鲜的无 pid 锁应拦住竞争者并如实说"持有者未知"，实际：${blocked}`);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('★ 真错误不当"被占用"：锁文件所在目录不存在时，两端都必须**立刻报错**（不是死等到超时）', async function () {
		const plugin = await loadPluginLock();
		if (!plugin) { this.skip(); }
		const missingDir = path.join(os.tmpdir(), 'vssaros-lock-missing-dir-should-not-exist', 'sessions.json');
		await fs.promises.rm(path.dirname(missingDir), { recursive: true, force: true });

		let ideError = '';
		try {
			await acquireFileLock(lockResourceFor(URI.file(missingDir)), nodeOps, { waitMs: 1_000 });
		} catch (e) {
			ideError = String((e as Error)?.message ?? e);
		}
		let pluginError = '';
		try {
			await plugin!.acquireFileLock(plugin!.lockFileFor(missingDir), { waitMs: 1_000 });
		} catch (e) {
			pluginError = String((e as Error)?.message ?? e);
		}
		assert.ok(/写锁创建失败/.test(ideError), `IDE 侧应报"写锁创建失败"，实际：${ideError}`);
		assert.ok(/写锁创建失败/.test(pluginError), `插件侧应报"写锁创建失败"，实际：${pluginError}`);
	});

	test('★ 协议 v2：**持有者还活着 ⇒ 不许破门**（"卡死但仍在跑"不许被抢）', async function () {
		const plugin = await loadPluginLock();
		const kanban = await loadKanbanLock();
		if (!plugin || !kanban) { this.skip(); }
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vssaros-lock-alive-'));
		const target = path.join(dir, 'sessions.json');
		const lockFile = plugin!.lockFileFor(target);
		try {
			// 人为造一把"过期但持有者**还活着**"的锁：pid 用**本进程**（一定活着 ✓），mtime 做旧 ✓
			await fs.promises.writeFile(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			const old = new Date(Date.now() - FILE_LOCK_STALE_MS - 5_000);
			await fs.promises.utimes(lockFile, old, old);
			const contenders: readonly [string, () => Promise<() => Promise<void>>][] = [
				['IDE 侧', () => acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { waitMs: 300, pollMs: 25 })],
				['workflow 插件', () => plugin!.acquireFileLock(lockFile, { waitMs: 300, pollMs: 25 })],
				['看板插件', () => kanban!.acquireLock(lockFile, { waitMs: 300, staleMs: FILE_LOCK_STALE_MS })],
			];
			for (const [name, contender] of contenders) {
				let error = '';
				try { await contender(); } catch (e) { error = String((e as Error)?.message ?? e); }
				assert.ok(/正被另一个写者占用/.test(error) && /仍在运行/.test(error),
					`${name} **不应**破门（持有者还在跑）⇒ 应报"被占用 + 持有者仍在运行"，实际：${error}`);
			}
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('★ 协议 v2：持有者**已死** ⇒ 过期锁可被破门（否则崩一次就永久卡死）', async function () {
		const plugin = await loadPluginLock();
		const kanban = await loadKanbanLock();
		if (!plugin || !kanban) { this.skip(); }
		// 拿一个**真的已死**的 pid：起一个立刻退出的子进程，用它的 pid ✓（比写死一个大数可靠 ✓）
		const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
		assert.ok(Number.isInteger(deadPid), '拿不到已死 pid，这条守卫会变成空转 ✗');
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vssaros-lock-dead-'));
		const target = path.join(dir, 'sessions.json');
		const lockFile = plugin!.lockFileFor(target);
		const acquire = plugin!.acquireFileLock.bind(plugin);
		const contenders: readonly [string, () => Promise<() => Promise<void>>][] = [
			['workflow 插件', () => acquire(lockFile, { waitMs: 500, pollMs: 25 })],
			['看板插件', () => kanban!.acquireLock(lockFile, { waitMs: 500, staleMs: FILE_LOCK_STALE_MS })],
			['IDE 侧', () => acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { waitMs: 500, pollMs: 25 })],
		];
		try {
			for (const [name, contender] of contenders) {
				await fs.promises.writeFile(lockFile, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));
				const old = new Date(Date.now() - FILE_LOCK_STALE_MS - 5_000);
				await fs.promises.utimes(lockFile, old, old);
				const release = await contender();
				await release();
				assert.ok(!fs.existsSync(lockFile), `${name} 释放后锁文件应消失`);
			}
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('★ 协议 v2：**心跳真的在刷 mtime**（否则"卡死但仍活着"照样会被抢）', async function () {
		const plugin = await loadPluginLock();
		if (!plugin) { this.skip(); }
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vssaros-lock-heartbeat-'));
		const target = path.join(dir, 'sessions.json');
		const lockFile = plugin!.lockFileFor(target);
		// 极短 staleMs（400ms）+ 极短心跳（50ms）：跑过 **2 倍 staleMs** 后，竞争者仍**不能**破门 ⇒ 心跳有效 ✓
		const release = await acquireFileLock(lockResourceFor(URI.file(target)), nodeOps, { staleMs: 400, heartbeatMs: 50, waitMs: 1000 });
		try {
			await new Promise(resolve => setTimeout(resolve, 1_000));
			let error = '';
			try {
				await plugin!.acquireFileLock(lockFile, { waitMs: 150, pollMs: 25, staleMs: 400 });
			} catch (e) {
				error = String((e as Error)?.message ?? e);
			}
			assert.ok(/正被另一个写者占用/.test(error),
				`心跳若有效，竞争者不该能破门（过期判定被心跳刷掉）✗；实际：${error}；mtime 年龄=${Date.now() - fs.statSync(lockFile).mtimeMs}ms`);
		} finally {
			await release();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
