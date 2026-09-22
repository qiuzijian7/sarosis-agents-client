/*---------------------------------------------------------------------------------------------
 *  SessionLockStore 专属行为基线（2026-09-22 阶段④-g P1/D-5 ✓）
 *
 *  为什么需要它 ✗✓：`sessionLockStore.ts`（138 行 ✓）承载**跨窗口会话互斥**，三条约定**全部来自事故** ✓：
 *   ① **fail-visible** ✗✓：加锁异常仍保留可用性，但必须返回 `degraded: true`（旧实现 fail-open **且不告诉任何人**
 *      ⇒ 两窗口同写同一份历史 ⇒ 用户看到"消息莫名回退"且无从归因 ✓）；
 *   ② **心跳失败也必须可见** ✗✓：连续 2min 不刷新对方即可接管，而本窗口**仍在编辑** ⇒ 只提示一次（不刷屏 ✓）；
 *   ③ **只删自己的锁** ✗✓：释放前比对 token（被接管后误删会让第三方以为无人持锁 ✓）。
 *  原本这些只经「服务级端到端基线」间接覆盖 ✗ ⇒ 改动判据可能**静默不红** ✗✓。
 *
 *  ⚠ 断言全部**先读实现再写** ✓；假件**照抄真件判据** ✓（锁文件内容用真 `serializeIndexLock` 生成 ✓，
 *  过期判据用真 `isIndexLockStale` 的语义 ✓ —— 绝不自己编格式 ✗）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SessionLockStore } from '../../browser/sessionLockStore.js';
import { parseIndexLock, serializeIndexLock, createIndexLockToken } from '../../browser/codebaseIndexLock.js';

const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);
const sessionsDir = URI.file('/tmp/fake-sessions');

interface IFakeFs {
	/** ⚠ 必须显式声明并**返回** ✓ —— 首跑漏了它 ✗，而 `compile-check-ts-native` **不检查 test/** ✓ ⇒ 没拦住 ✓✗
	 *  （由此暴露一个覆盖缺口 ✓：测试文件只有 esbuild 转译、**没有类型闸** ⇒ 假件字段漏写会静默变 undefined ✓）。 */
	api: any;
	files: Map<string, { content: string; mtime: number }>;
	writes: string[];
	deletes: string[];
	/** 让下一次 writeFile 抛错（模拟权限/抖动 ✓） */
	failNextWrite(): void;
}

function makeFs(seed: Record<string, { content: string; mtime: number }> = {}): IFakeFs {
	const files = new Map(Object.entries(seed));
	const writes: string[] = [];
	const deletes: string[] = [];
	let failWrite = false;
	const api: any = {
		readFile: async (uri: any) => {
			const f = files.get(pathOf(uri));
			if (!f) { throw new Error('ENOENT ' + pathOf(uri)); }
			return { value: { toString: () => f.content } };
		},
		stat: async (uri: any) => {
			const f = files.get(pathOf(uri));
			if (!f) { throw new Error('ENOENT ' + pathOf(uri)); }
			return { mtime: f.mtime };
		},
		writeFile: async (uri: any, buf: any) => {
			if (failWrite) { failWrite = false; throw new Error('EACCES fake'); }
			const p = pathOf(uri);
			writes.push(p);
			files.set(p, { content: buf.toString(), mtime: Date.now() });
		},
		del: async (uri: any) => { deletes.push(pathOf(uri)); files.delete(pathOf(uri)); },
	};
	return { api, files, writes, deletes, failNextWrite: () => { failWrite = true; } };
}

/** 拦截全局定时器 ⇒ 能手动触发"心跳到点"，也能数出**泄漏的 interval** ✓✓（必须 await 回调 ✓，否则会在异步体完成前就还原 ✓✗）。 */
async function withFakeTimers(fn: (hooks: { tickAll(): void; live(): number }) => Promise<void> | void): Promise<void> {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const cbs = new Map<number, () => void>();
	let nextId = 1;
	(globalThis as any).setInterval = ((cb: () => void) => { const id = nextId++; cbs.set(id, cb); return id; }) as any;
	(globalThis as any).clearInterval = ((id: any) => { cbs.delete(Number(id)); }) as any;
	const hooks = {
		tickAll: () => { for (const cb of [...cbs.values()]) { cb(); } },
		live: () => cbs.size,
	};
	try { await fn(hooks); }
	finally { (globalThis as any).setInterval = realSet; (globalThis as any).clearInterval = realClear; }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

function makeStore(fs: IFakeFs, warns: string[], instanceId = 'win-A') {
	const log: any = { info() { }, warn(...a: unknown[]) { warns.push(a.map(String).join(' ')); }, error() { }, debug() { }, trace() { } };
	// ⚠ 构造顺序照抄真件 ✗✓：`(fileService, logService, getInstanceId, resolveSessionsDir)` ✓
	return new SessionLockStore(fs.api, log, () => instanceId, async () => sessionsDir);
}

/** ⚠ 必须用**真 `URI.joinPath`** 生成期望键 ✗✓（手写 `dir + '/' + id + '.lock'` 在 Windows 上 fsPath 用反斜杠 ⇒ 假件键对不上 ✗）。 */
const lockPath = (sessionId: string) => URI.joinPath(sessionsDir, `${sessionId}.lock`).fsPath;

suite('SessionLockStore — 跨窗口会话锁三条事故约定 ✓', () => {

	test('★ 首次获取：写锁文件、返回 acquired ✓（锁内容归属本窗口 ✓）', async () => {
		const fs = makeFs();
		const warns: string[] = [];
		const store = makeStore(fs, warns);
		await withFakeTimers(async () => {
			const r = await store.tryAcquire('agent1', 's1');
			assert.strictEqual(r.acquired, true);
			assert.strictEqual(r.degraded, undefined,
				'正常路径**不得**标 degraded（标了会让 UI 误报降级 ✗）—— 日志尾部: ' + String(warns[0] ?? '').slice(-90));
			const written = fs.files.get(lockPath('s1'));
			assert.ok(written, `必须写出 ${lockPath('s1')}（实际写了 ${JSON.stringify(fs.writes)} ✗）`);
			assert.strictEqual(parseIndexLock(written!.content)?.instanceId, 'win-A', '锁必须记录持有者实例 ✓');
			await store.release();
		});
	});

	test('★★★ 他人持**新鲜**锁 ⇒ 拒绝，且**绝不覆盖**别人的锁 ✓✓', async () => {
		const otherToken = createIndexLockToken('win-B');
		const seeded = serializeIndexLock({ token: otherToken, instanceId: 'win-B', acquiredAt: Date.now() });
		const fs = makeFs({ [lockPath('s1')]: { content: seeded, mtime: Date.now() } });
		const store = makeStore(fs, []);
		const r = await store.tryAcquire('agent1', 's1');
		assert.strictEqual(r.acquired, false, '他人持新鲜锁时必须拒绝 ✓（放行 ⇒ 两窗口同写历史 ✗✓）');
		assert.strictEqual(r.holderInstanceId, 'win-B', '必须回报**持锁者**（UI 要提示"谁在编辑" ✓）');
		assert.strictEqual(fs.files.get(lockPath('s1'))!.content, seeded,
			'★ 被拒绝时**绝不能**改写别人的锁 ✗✓（改写 ⇒ 持锁方心跳对不上 ⇒ 双方都以为持锁 ✓）');
	});

	test('★★★ 他人持**过期**锁（> 2min 未心跳）⇒ 自动接管 ✓（崩溃恢复 ✓）', async () => {
		const otherToken = createIndexLockToken('win-B');
		const seeded = serializeIndexLock({ token: otherToken, instanceId: 'win-B', acquiredAt: Date.now() - 5 * 60_000 });
		const fs = makeFs({ [lockPath('s1')]: { content: seeded, mtime: Date.now() - 3 * 60_000 } });  // 3min 前 ⇒ 超过 2min ✓
		const store = makeStore(fs, []);
		await withFakeTimers(async () => {
			const r = await store.tryAcquire('agent1', 's1');
			assert.strictEqual(r.acquired, true, '过期锁必须可接管（否则崩溃方永久占锁 ⇒ 会话打不开 ✗✓）');
			assert.strictEqual(parseIndexLock(fs.files.get(lockPath('s1'))!.content)?.instanceId, 'win-A',
				'接管后锁必须归属本窗口 ✓');
			await store.release();
		});
	});

	test('★★★ **fail-visible**：加锁异常仍返回 acquired=true，但必须带 `degraded: true` 并留可见日志 ✓✓', async () => {
		const fs = makeFs();
		const warns: string[] = [];
		const store = makeStore(fs, warns);
		// 让首次写入失败 ⇒ 走 catch 分支 ✓
		fs.failNextWrite();
		const r = await store.tryAcquire('agent1', 's1');
		assert.strictEqual(r.acquired, true, '必须保留可用性（文件系统抖动不该把用户锁死在只读里 ✓）');
		assert.strictEqual(r.degraded, true,
			'★ 未加锁这个事实**必须显式返回** ✗✓✓（旧实现 fail-open 且不告诉任何人 ⇒ 双写+消息回退且无从归因 ✓）');
		assert.ok(warns.some(w => w.includes('fail-visible')),
			`必须留下 fail-visible 日志（实际 ${JSON.stringify(warns)} ✗ —— 这是事后取证的唯一线索 ✓）`);
	});

	test('★★★ 心跳失败：**只提示一次**（不刷屏 ✓）但必须可见 ✓', async () => {
		const fs = makeFs();
		const warns: string[] = [];
		const store = makeStore(fs, warns);
		await withFakeTimers(async hooks => {
			await store.tryAcquire('agent1', 's1');
			fs.failNextWrite();
			hooks.tickAll();          // 心跳到点 ⇒ 写失败 ⇒ warn（第 1 次 ✓）
			await flush();
			fs.failNextWrite();
			hooks.tickAll();          // 再失败 ⇒ **不得**再 warn ✗✓
			await flush();
			const hb = warns.filter(w => w.includes('session lock heartbeat failed'));
			assert.strictEqual(hb.length, 1,
				`心跳失败必须**只提示一次**（实际 ${hb.length} 次 ✗✓ —— 每 30s 刷一次会淹没真正的问题 ✓）`);
			assert.ok(hb[0].includes('2min'), '提示必须说明后果（2min 后对方可接管 ✓）');
			await store.release();
		});
	});

	test('★★★ **只删自己的锁**：被接管后 release **不得**删掉别人新写的锁 ✓✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await withFakeTimers(async () => {
			await store.tryAcquire('agent1', 's1');
			// 模拟：本窗口卡住被对方接管（对方覆盖锁文件 ✓）
			const hijacked = serializeIndexLock({ token: createIndexLockToken('win-B'), instanceId: 'win-B', acquiredAt: Date.now() });
			fs.files.set(lockPath('s1'), { content: hijacked, mtime: Date.now() });
			await store.release();
			assert.ok(fs.files.has(lockPath('s1')),
				'★ 被接管后 release **必须**留手 ✗✓✓（误删 ⇒ 第三方以为无人持锁 ⇒ 依然双写 ✓）');
			assert.strictEqual(parseIndexLock(fs.files.get(lockPath('s1'))!.content)?.instanceId, 'win-B',
				'且不得改写对方锁内容 ✓');
		});
	});

	test('★ release 删掉自己的锁 ✓ 且停掉心跳 ✓（避免宿主销毁后回调仍在跑 ✗）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await withFakeTimers(async hooks => {
			await store.tryAcquire('agent1', 's1');
			assert.strictEqual(hooks.live(), 1, '获取成功后应有 1 个心跳定时器 ✓');
			await store.release();
			assert.strictEqual(fs.files.has(lockPath('s1')), false, '自己的锁必须被删除 ✓');
			assert.strictEqual(hooks.live(), 0, '心跳必须被清掉（否则 release 后仍在写锁文件 ✗✓）');
		});
	});

	test('★ 心跳到点会**刷新锁文件**（mtime 是"新鲜度"的唯一依据 ✓）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await withFakeTimers(async hooks => {
			await store.tryAcquire('agent1', 's1');
			const before = fs.writes.length;
			hooks.tickAll();
			await flush();
			assert.ok(fs.writes.length > before, '心跳必须重写锁文件（不刷 ⇒ 2min 后别人合法接管 ✓）');
			await store.release();
		});
	});

	test('★★★ 切会话**不得**泄漏心跳，且**不得"复活"已释放的锁** ✓✓（原为实测发现的缺陷，已修复 ✓）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await withFakeTimers(async hooks => {
			await store.tryAcquire('agent1', 's1');
			assert.strictEqual(hooks.live(), 1, '获取后应有 1 个心跳 ✓');
			const s1Lock = lockPath('s1');
			assert.ok(fs.files.has(s1Lock), '前置：s1 锁已落盘 ✓');

			// 切到另一个会话（真实路径：同一窗口打开第二个会话 ✓）—— 旧实现会在这里**泄漏**一个 interval ✗
			await store.tryAcquire('agent1', 's2');
			assert.strictEqual(hooks.live(), 1,
				`★ 切会话后必须仍只有 1 个心跳（实际 ${hooks.live()} ✗✓ —— 修复前会泄漏成 2 个 ✓）`);
			assert.strictEqual(fs.files.has(s1Lock), false, '前置：切会话时旧锁已被释放 ✓');

			// ★ 最强护栏 ✓✓：旧心跳若还活着，tick 一次就会把**已释放的** s1 锁**重新写出来** ✗✓
			const writesBefore = fs.writes.length;
			hooks.tickAll();
			await flush();
			assert.strictEqual(fs.files.has(s1Lock), false,
				'★ tick 之后 s1 锁**仍不得出现** ✗✓✓（修复前会把已释放的锁"复活" ⇒ 别的窗口以为 s1 被本窗口持锁 ✓）');
			assert.ok(fs.writes.length > writesBefore, '而当前会话的心跳必须仍在刷新**自己的**锁 ✓');

			await store.release();
			assert.strictEqual(hooks.live(), 0,
				`★ release 后**不得**留下孤儿心跳（实际 ${hooks.live()} ✗✓ —— 修复前残留 1 个，宿主销毁后仍在写锁 ✓）`);
		});
	});
});
