/*---------------------------------------------------------------------------------------------
 *  codebaseGraphWatcher.test.ts — 代码图谱 watcher 单元测试（tdd）。
 *
 *  覆盖 2026-07-22 新增/修复能力：
 *  - _checkFiles：stat-only 变更判定（mtime/size 变化 → modified；新增/删除分类）
 *  - 既有 bug 修复：added/deleted 相对/绝对路径集合比较（不再误报全量增删）
 *  - 脏状态签名去重：同一变更组合只触发一次；状态干净后可再次触发
 *  - root prune：根目录连续缺失 3 轮自动停止监听
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphWatcher.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CodebaseGraphWatcher } from '../../browser/codebaseGraphWatcher.js';

const ROOT = '/proj';
const EXTS = new Set(['.ts']);

interface IFileSpec { mtime: number; size: number }

/** 由 "相对路径 → {mtime,size}" 构建虚拟文件系统（fileService mock）。 */
function makeFs(files: Record<string, IFileSpec>, opts: { rootMissing?: boolean } = {}) {
	const norm = (p: string): string => p.replace(/\\/g, '/');
	const abs = (rel: string): string => `${ROOT}/${rel}`;

	// 目录 → 直接子项（文件或子目录名）
	function childrenOf(dir: string): { name: string; isDir: boolean; rel?: string }[] {
		const prefix = dir === ROOT ? '' : dir.slice(ROOT.length + 1) + '/';
		const seen = new Map<string, { name: string; isDir: boolean; rel?: string }>();
		for (const rel of Object.keys(files)) {
			if (!rel.startsWith(prefix)) { continue; }
			const rest = rel.slice(prefix.length);
			const slash = rest.indexOf('/');
			if (slash === -1) {
				seen.set(rest, { name: rest, isDir: false, rel });
			} else {
				const d = rest.slice(0, slash);
				if (!seen.has(d)) { seen.set(d, { name: d, isDir: true }); }
			}
		}
		return [...seen.values()];
	}

	const fileService = {
		async resolve(uri: any): Promise<any> {
			const p = norm(String(uri.fsPath ?? uri.path ?? uri));
			const spec = Object.entries(files).find(([rel]) => abs(rel) === p);
			if (spec) {
				// 文件本身
				return { isFile: true, isDirectory: false, name: p.split('/').pop(), mtime: spec[1].mtime, size: spec[1].size, resource: { fsPath: p } };
			}
			// 目录？
			const isDir = p === ROOT || Object.keys(files).some(rel => rel.startsWith(p.slice(ROOT.length + 1) + '/'));
			if (isDir) {
				const children = childrenOf(p).map(c => {
					const childAbs = `${p}/${c.name}`;
					if (c.isDir) {
						return { isFile: false, isDirectory: true, name: c.name, mtime: 1, size: 0, resource: { fsPath: childAbs } };
					}
					const f = files[c.rel!];
					return { isFile: true, isDirectory: false, name: c.name, mtime: f.mtime, size: f.size, resource: { fsPath: childAbs } };
				});
				return { isFile: false, isDirectory: true, name: p.split('/').pop(), mtime: 1, size: 0, resource: { fsPath: p }, children };
			}
			throw new Error(`ENOENT: ${p}`);
		},
		async stat(uri: any): Promise<any> {
			if (opts.rootMissing) { throw new Error('ENOENT: root missing'); }
			return { isFile: false, isDirectory: true, mtime: 1, size: 0 };
		},
		async readFile(): Promise<any> { throw new Error('ENOENT'); }, // .git/HEAD 不存在 → head=undefined
	};
	return fileService;
}

function makeLog() {
	return { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
}

function makeStore(hashes: { relPath: string; mtimeNs: number; size: number }[]) {
	// 动态映射：测试中可中途 push（模拟重索引完成）使后续调用可见
	const map = () => hashes.map(h => ({ project: 'P', relPath: h.relPath, sha256: 'x', mtimeNs: h.mtimeNs, size: h.size }));
	return {
		getAllFileHashes: (_project: string) => map(),
		getFileHash: (_project: string, rel: string) => map().find(h => h.relPath === rel),
	};
}

function setup(files: Record<string, IFileSpec>, hashes: { relPath: string; mtimeNs: number; size: number }[], fsOpts: { rootMissing?: boolean } = {}) {
	const events: any[] = [];
	const watcher = new CodebaseGraphWatcher(makeFs(files, fsOpts) as any, makeLog() as any);
	watcher.onDidChange(e => events.push(e));
	watcher.start(ROOT, makeStore(hashes) as any, 'P', EXTS);
	const root = (watcher as any)._roots[0];
	return { watcher, events, root, poll: () => (watcher as any)._poll(root) as Promise<void> };
}

suite('CodebaseGraphWatcher stat-only change detection (2026-07-22)', () => {

	test('added: file on disk but not in store hashes', async () => {
		const { watcher, events, poll } = setup({ 'src/a.ts': { mtime: 100, size: 10 } }, []);
		await poll();
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].added, ['src/a.ts']);
		assert.deepStrictEqual(events[0].deleted, []);
		watcher.dispose();
	});

	test('deleted: hash in store but file gone from disk', async () => {
		const { watcher, events, poll } = setup({}, [{ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 }]);
		await poll();
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].deleted, ['src/a.ts']);
		assert.deepStrictEqual(events[0].added, []);
		watcher.dispose();
	});

	test('modified by mtime change (same size)', async () => {
		const { watcher, events, poll } = setup(
			{ 'src/a.ts': { mtime: 200, size: 10 } },
			[{ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 }],
		);
		await poll();
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].modified, ['src/a.ts']);
		assert.deepStrictEqual(events[0].added, []);
		assert.deepStrictEqual(events[0].deleted, []);
		watcher.dispose();
	});

	test('modified by size change (same mtime)', async () => {
		const { watcher, events, poll } = setup(
			{ 'src/a.ts': { mtime: 100, size: 99 } },
			[{ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 }],
		);
		await poll();
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].modified, ['src/a.ts']);
		watcher.dispose();
	});

	test('unchanged (same mtime+size) → no event', async () => {
		const { watcher, events, poll } = setup(
			{ 'src/a.ts': { mtime: 100, size: 10 } },
			[{ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 }],
		);
		await poll();
		assert.strictEqual(events.length, 0, 'no changes expected');
		watcher.dispose();
	});

	test('regression: rel/abs path comparison no longer reports everything added+deleted', async () => {
		// 既有 bug：added/deleted 用绝对路径 Set 对相对路径 Set（不相交 → 每轮全量误报）
		const { watcher, events, poll } = setup(
			{ 'src/a.ts': { mtime: 100, size: 10 }, 'src/sub/b.ts': { mtime: 100, size: 20 } },
			[{ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 }, { relPath: 'src/sub/b.ts', mtimeNs: 100e6, size: 20 }],
		);
		await poll();
		assert.strictEqual(events.length, 0, `expected no changes, got ${JSON.stringify(events)}`);
		watcher.dispose();
	});
});

suite('CodebaseGraphWatcher dirty-signature dedup & root prune (2026-07-22)', () => {

	test('same dirty state fires only once; clean state resets; change fires again', async () => {
		const files: Record<string, IFileSpec> = { 'src/a.ts': { mtime: 100, size: 10 } };
		const storeHashes: { relPath: string; mtimeNs: number; size: number }[] = [];
		const { watcher, events, poll } = setup(files, storeHashes);

		await poll();  // 新增 → fire #1
		assert.strictEqual(events.length, 1);

		await poll();  // 同一脏状态（未重索引，store 仍为空）→ 去重不 fire
		assert.strictEqual(events.length, 1, 'dirty-signature dedup should suppress re-fire');

		// 模拟重索引完成：store 记录与磁盘一致
		storeHashes.push({ relPath: 'src/a.ts', mtimeNs: 100e6, size: 10 });
		await poll();  // 干净 → 不 fire，签名重置
		assert.strictEqual(events.length, 1);

		files['src/a.ts'] = { mtime: 300, size: 10 };
		await poll();  // 变更 → fire #2
		assert.strictEqual(events.length, 2, 'should fire again after clean reset');
		assert.deepStrictEqual(events[1].modified, ['src/a.ts']);
		watcher.dispose();
	});

	test('root pruned after 3 consecutive missing polls', async () => {
		const { watcher, events, poll } = setup({}, [], { rootMissing: true });
		const roots = () => (watcher as any)._roots.length;

		assert.strictEqual(roots(), 1);
		await poll();
		assert.strictEqual(roots(), 1, 'still watching after 1st miss');
		await poll();
		assert.strictEqual(roots(), 1, 'still watching after 2nd miss');
		await poll();
		assert.strictEqual(roots(), 0, 'pruned after 3rd consecutive miss');
		assert.strictEqual(events.length, 0, 'no change events on missing root');
		watcher.dispose();
	});
});

suite('CodebaseGraphWatcher keepDirs exception (2026-08-03)', () => {
	// 背景：全量索引支持 keepDirs（exclude 内例外，如 Content 排除但保留 content/script），
	// watcher 此前不支持 → 全量索引扫入的保留文件在 watcher 扫描中消失 → 幻影 deleted。

	test('excluded dir skipped; keepDirs exception keeps ancestor open', async () => {
		// 语义对齐 graphService._scanDir：排除按目录名匹配。Content 因是 keep 目标
		// 'content/script' 的祖先被保开；保开后其子目录（UI/Script）按名字正常判定——
		// 'UI' 不在排除表 → 同样被扫到。即 keepDirs 的真实语义 = 打开被排除的祖先目录，
		// 而非"只扫 keep 目标子树"。
		const files: Record<string, IFileSpec> = {
			'Content/Script/a.ts': { mtime: 100, size: 10 },
			'Content/UI/b.ts': { mtime: 100, size: 20 },
			'src/c.ts': { mtime: 100, size: 30 },
		};
		const events: any[] = [];
		const watcher = new CodebaseGraphWatcher(makeFs(files) as any, makeLog() as any);
		watcher.onDidChange(e => events.push(e));
		watcher.start(ROOT, makeStore([]) as any, 'P', EXTS, new Set(['content']), ['content/script']);
		const root = (watcher as any)._roots[0];
		await (watcher as any)._poll(root);
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(
			[...events[0].added].sort(),
			['Content/Script/a.ts', 'Content/UI/b.ts', 'src/c.ts'].sort(),
		);
		watcher.dispose();
	});

	test('excluded name under kept ancestor is still skipped', async () => {
		// 保开的 Content 之下，名字命中排除表的子目录仍被跳过（node_modules 为例）
		const files: Record<string, IFileSpec> = {
			'Content/Script/a.ts': { mtime: 100, size: 10 },
			'Content/node_modules/x.ts': { mtime: 100, size: 20 },
		};
		const events: any[] = [];
		const watcher = new CodebaseGraphWatcher(makeFs(files) as any, makeLog() as any);
		watcher.onDidChange(e => events.push(e));
		watcher.start(ROOT, makeStore([]) as any, 'P', EXTS, new Set(['content', 'node_modules']), ['content/script']);
		const root = (watcher as any)._roots[0];
		await (watcher as any)._poll(root);
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].added, ['Content/Script/a.ts']);
		watcher.dispose();
	});

	test('no keepDirs → excluded dir fully skipped', async () => {
		const files: Record<string, IFileSpec> = {
			'Content/Script/a.ts': { mtime: 100, size: 10 },
			'src/c.ts': { mtime: 100, size: 30 },
		};
		const events: any[] = [];
		const watcher = new CodebaseGraphWatcher(makeFs(files) as any, makeLog() as any);
		watcher.onDidChange(e => events.push(e));
		watcher.start(ROOT, makeStore([]) as any, 'P', EXTS, new Set(['content']));
		const root = (watcher as any)._roots[0];
		await (watcher as any)._poll(root);
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].added, ['src/c.ts']);
		watcher.dispose();
	});

	test('keepDirs normalization: backslash + case + trailing slash', async () => {
		const files: Record<string, IFileSpec> = {
			'Content/Script/a.ts': { mtime: 100, size: 10 },
		};
		const events: any[] = [];
		const watcher = new CodebaseGraphWatcher(makeFs(files) as any, makeLog() as any);
		watcher.onDidChange(e => events.push(e));
		watcher.start(ROOT, makeStore([]) as any, 'P', EXTS, new Set(['Content']), ['Content\\Script\\']);
		const root = (watcher as any)._roots[0];
		await (watcher as any)._poll(root);
		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0].added, ['Content/Script/a.ts']);
		watcher.dispose();
	});
});

export {};
