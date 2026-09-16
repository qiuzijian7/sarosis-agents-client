/*---------------------------------------------------------------------------------------------
 *  MediaStore（主进程媒体资产库）测试。
 *
 *  better-sqlite3 原生绑定面向 Electron 编译（普通 Node ABI 不匹配），因此通过
 *  MediaStore 的 `dbFactory` 注入参数注入 Node 内置的 `node:sqlite`（真实 SQL 引擎）
 *  —— 绕开 ABI，同时验证全部 SQL/文件逻辑（import/list/软删/配额等）。
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'assert';
import { MediaStore, type SqliteDatabase } from '../../node/mediaStore.js';

function makeStore(): { store: MediaStore; db: SqliteDatabase; root: string } {
	const root = mkdtempSync(path.join(tmpdir(), 'media-store-test-'));
	const db = new DatabaseSync(':memory:') as unknown as SqliteDatabase;
	const store = new MediaStore({ rootDir: root }, () => db);
	return { store, db, root };
}

suite('mediaStore (SQL via node:sqlite)', () => {

	test('importAsset: URL 引用仅索引，不落盘', async () => {
		const { store, root } = makeStore();
		try {
			const a = await store.importAsset({ ref: 'http://localhost:8188/view?filename=a.png', kind: 'image', workflowId: 'wf1', nodeId: 'n1', provider: 'comfyui' });
			assert.strictEqual(a.ref, 'http://localhost:8188/view?filename=a.png');
			assert.strictEqual(a.kind, 'image');
			assert.strictEqual(a.workflowId, 'wf1');
			assert.strictEqual(a.nodeId, 'n1');
			assert.strictEqual(a.provider, 'comfyui');
			assert.strictEqual(a.filePath, undefined);
			assert.strictEqual(a.isDeleted, false);
			assert.strictEqual(await store.getFilePath(a.id), null);
			assert.strictEqual(readdirSync(root).length, 0, 'URL 引用不应产生任何文件');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('importAsset: base64 落盘 + 元数据', async () => {
		const { store, root } = makeStore();
		try {
			const payload = Buffer.from('PNG payload 123');
			const a = await store.importAsset({ base64: payload.toString('base64'), ext: 'png', kind: 'image', workflowId: 'wf1', nodeId: 'n2', provider: 'upload' });
			assert.ok(a.filePath, 'get 返回应含 filePath（画廊据此走 mediaGetUrl）');
			const fp = await store.getFilePath(a.id);
			assert.ok(fp && existsSync(fp), '文件应存在');
			assert.strictEqual(Buffer.from(readFileSync(fp)).toString(), payload.toString());
			assert.strictEqual(a.sizeBytes, payload.byteLength);
			assert.ok(a.ref.length > 0 && a.ref.endsWith(`${a.id}.png`), `ref 应为相对路径（实际：${a.ref}）`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('list: workflowId / provider / query / favorite / board 过滤', async () => {
		const { store } = makeStore();
		await store.importAsset({ ref: 'http://h/view?f=a.png', kind: 'image', workflowId: 'wf1', provider: 'comfyui', metaJson: '{"tag":"cat"}' });
		await store.importAsset({ ref: 'http://h/view?f=b.mp4', kind: 'video', workflowId: 'wf1', provider: 'comfyui' });
		await store.importAsset({ ref: 'http://h/view?f=c.png', kind: 'image', workflowId: 'wf2', provider: 'byok:x' });
		const all = await store.list({});
		assert.strictEqual(all.total, 3);

		const wf1 = await store.list({ workflowId: 'wf1' });
		assert.strictEqual(wf1.total, 2);
		const vid = await store.list({ kind: 'video' });
		assert.strictEqual(vid.total, 1);
		const q = await store.list({ query: 'cat' });
		assert.strictEqual(q.total, 1);
		assert.strictEqual(q.items[0].ref, 'http://h/view?f=a.png');
		const prov = await store.list({ provider: 'byok:x' });
		assert.strictEqual(prov.total, 1);
	});

	test('软删除 + 恢复 + includeDeleted', async () => {
		const { store } = makeStore();
		const a = await store.importAsset({ ref: 'http://h/a.png' });
		const b = await store.importAsset({ ref: 'http://h/b.png' });
		await store.remove(a.id);
		assert.strictEqual((await store.list({})).total, 1, '默认列表隐藏已删');
		assert.strictEqual((await store.list({ includeDeleted: true })).total, 2);
		assert.strictEqual((await store.get(a.id))!.isDeleted, true);
		await store.restore(a.id);
		assert.strictEqual((await store.list({})).total, 2);
		assert.strictEqual((await store.get(a.id))!.isDeleted, false);
		assert.notStrictEqual(a.id, b.id);
	});

	test('favorite / board 过滤', async () => {
		const { store } = makeStore();
		const a = await store.importAsset({ ref: 'http://h/a.png' });
		const b = await store.importAsset({ ref: 'http://h/b.png' });
		await store.setFavorite(b.id, true);
		await store.setBoard(a.id, 'refs');
		const fav = await store.list({ favorite: true });
		assert.strictEqual(fav.total, 1);
		assert.strictEqual(fav.items[0].id, b.id);
		const board = await store.list({ board: 'refs' });
		assert.strictEqual(board.total, 1);
		assert.strictEqual(board.items[0].id, a.id);
		const noBoard = await store.list({ board: null as any, includeDeleted: true });
		assert.strictEqual(noBoard.total, 1, 'board=null → 仅无分组（b）');
	});

	test('stats 统计', async () => {
		const { store } = makeStore();
		await store.importAsset({ ref: 'http://h/a.png', provider: 'comfyui' });
		const b = await store.importAsset({ base64: Buffer.from('hello').toString('base64'), ext: 'png' });
		const before = await store.stats();
		assert.strictEqual(before.assetCount, 2);
		assert.strictEqual(before.totalBytes, 5);
		assert.ok(before.dirSizeBytes >= 5, '目录占用应包含落盘文件');
		await store.remove(b.id);
		const after = await store.stats();
		assert.strictEqual(after.assetCount, 1);
		assert.strictEqual(after.deletedCount, 1);
		assert.strictEqual(after.totalBytes, 0, '已删资产不计入未删体积');
	});

	test('purgeDeleted 物理删除（行 + 文件）', async () => {
		const { store } = makeStore();
		const b = await store.importAsset({ base64: Buffer.from('purge me').toString('base64'), ext: 'png' });
		const fp = await store.getFilePath(b.id);
		assert.ok(fp && existsSync(fp));
		await store.remove(b.id);
		const r = await store.purgeDeleted();
		assert.strictEqual(r.count, 1);
		assert.ok(r.freedBytes >= 'purge me'.length);
		assert.ok(!existsSync(fp!), '文件应被删除');
		assert.strictEqual((await store.list({ includeDeleted: true })).total, 0);
	});

	test('enforceQuota: maxDays 淘汰未收藏/未分组最旧资产', async () => {
		const { store, db } = makeStore();
		const old = await store.importAsset({ ref: 'http://h/old.png', metaJson: '{}' });
		const recent = await store.importAsset({ ref: 'http://h/recent.png' });
		// 把 old 资产 backdate 到 100 天前
		db.prepare('UPDATE media_asset SET created_at = ? WHERE id = ?').run(Date.now() - 100 * 86400 * 1000, old.id);
		const r = await store.enforceQuota({ maxDays: 90 });
		assert.strictEqual(r.removed, 1, '仅淘汰 old');
		const list = await store.list({});
		assert.strictEqual(list.total, 1);
		assert.strictEqual(list.items[0].id, recent.id);
	});

	test('enforceQuota: maxTotalBytes 淘汰最旧直至低于阈值；收藏/分组豁免', async () => {
		const { store, db } = makeStore();
		const a = await store.importAsset({ base64: Buffer.alloc(100, 'x').toString('base64'), ext: 'png' });
		const b = await store.importAsset({ base64: Buffer.alloc(100, 'y').toString('base64'), ext: 'png' });
		await store.setFavorite(b.id, true); // 豁免
		await db.prepare('UPDATE media_asset SET created_at = ? WHERE id = ?').run(Date.now() - 200 * 86400 * 1000, a.id);
		const r = await store.enforceQuota({ maxTotalBytes: 50 });
		assert.strictEqual(r.removed, 1, '仅淘汰未收藏的 a');
		const list = await store.list({});
		assert.strictEqual(list.items[0].id, b.id, '收藏资产保留');
	});

	test('分页 limit/offset', async () => {
		const { store } = makeStore();
		// ⚠ 必须用**立即失败**的地址：`importAsset` 对 `http(s)://` ref 会真的发起下载
		// （`_downloadRemoteToFile`，见 `mediaStore.ts` 内说明）。原先用 `http://h/...`
		// （主机不可解析）⇒ DNS/连接悬挂 ⇒ 本用例 10s 超时。该文件此前连模块加载都失败
		// （`betterSqlite3` 顶层 `createRequire(import.meta.url)`），所以这个坏死用例一直没被发现。
		// `127.0.0.1:1` 无服务监听 ⇒ 立即 ECONNREFUSED ✓，下载失败后按设计保留 ref 原值 ✓
		// ⇒ 断言不依赖网络状态、也不再可能挂住。
		const REF = 'http://127.0.0.1:1';
		for (let i = 0; i < 5; i++) {
			await store.importAsset({ ref: `${REF}/${i}.png` });
		}
		const page = await store.list({ limit: 2, offset: 1 });
		assert.strictEqual(page.items.length, 2);
		assert.strictEqual(page.total, 5);
		assert.strictEqual(page.items[0].ref, `${REF}/3.png`, 'created_at DESC：offset=1 应为第 4 新');
	});

	test('dbFactory 注入可用；工厂抛错应冒泡', async () => {
		const root = makeStore().root;
		try {
			let threw = false;
			try {
				new MediaStore({ rootDir: root }, () => { throw new Error('db factory boom'); });
			} catch (e: any) {
				threw = true;
				assert.ok(String(e.message).includes('db factory boom'), `应拿到工厂错误（实际：${String(e.message)}）`);
			}
			assert.strictEqual(threw, true, '工厂抛错应冒泡');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('★★★ 打开时必须启用 WAL + busy_timeout（每窗口一个连接 ⇒ 与进程模型无关）', () => {
		// 背景（2026-09-15）：`kb.db` / `graph.db` 早已补 WAL + busy_timeout，**`media.db` 漏了**
		// ⇒ 并发写会立即抛 `SQLITE_BUSY`（甚至有损坏库风险）。
		// 关键：**每个窗口是独立 renderer** ⇒ 同一个 media.db 永远存在多个连接
		// （切回「单实例多窗口」也如此）⇒ 这两条 PRAGMA 是结构性必需，不是多实例专属。
		//
		// ⚠ 必须用**文件库**：内存库（`:memory:`）不支持 WAL（会静默保持 memory）⇒ 断言会假失败。
		const root = mkdtempSync(path.join(tmpdir(), 'media-pragma-'));
		const raw = new DatabaseSync(path.join(root, 'media.db'));
		try {
			const store = new MediaStore({ rootDir: root }, () => raw as unknown as SqliteDatabase);
			assert.ok(store, '构造不应抛错（PRAGMA 失败也不应阻塞打开）');

			const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
			assert.strictEqual(String(mode.journal_mode).toLowerCase(), 'wal', 'journal_mode 必须是 WAL');
			const busy = raw.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
			assert.strictEqual(Number(busy.timeout), 5000, 'busy_timeout 必须是 5000ms（与 kb/graph 一致）');
		} finally {
			raw.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
