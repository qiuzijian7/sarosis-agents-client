/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbOrganizeTools.test.ts — `kb_organize` 工具的 handler 级单测（tdd 风格）。
 *
 *  覆盖：
 *   1. 正常 move（checkpoint + vault 外备份 + 结构化结果 KB_ORGANIZE_RESULT）
 *   2. 安全闸：越出笔记区 / `..` 穿越 / from 不存在 / to 已存在 / from===to
 *   3. deletes = 移入备份目录（回收站，非真删）
 *   4. creates = 建目录
 *   5. 备份失败 ⇒ 跳过该项（没有还原点就不动手）
 *   6. 操作总数超限 / 空操作
 *   7. 链式移动（同一批里 A→B 又 B→C）：按顺序串行处理，两条都成立
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/providers/tool/kbOrganizeTools.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { registerKbOrganizeTools } from './kbOrganizeTools.js';

// ---------------------------------------------------------------------------
// 树形内存 mock：IFileService（resolve 对**不存在**的路径**抛错** —— 这正是
// kb_organize 的 `exists()` 判定依据，所以不能用「缺省返回目录」的宽松 mock）
// ---------------------------------------------------------------------------

function createFsMock(seed: Record<string, string>) {
	const files = new Map<string, string>();
	const dirs = new Set<string>(['/']);
	const keyOf = (uri: URI) => uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const addDir = (k: string) => {
		const segs = k.split('/').filter(Boolean);
		let acc = '';
		for (const s of segs) { acc += '/' + s; dirs.add(acc); }
	};
	for (const [p, c] of Object.entries(seed)) {
		const k = URI.file(p).fsPath.replace(/\\/g, '/');
		files.set(k, c);
		addDir(k.split('/').slice(0, -1).join('/'));
	}
	const service: any = {
		async resolve(uri: URI): Promise<any> {
			const k = keyOf(uri);
			if (files.has(k)) { const c = files.get(k)!; return { resource: uri, name: k.split('/').pop(), isDirectory: false, mtime: 1000, size: c.length }; }
			if (dirs.has(k) || k === '') { return { resource: uri, name: k.split('/').pop(), isDirectory: true, children: [] }; }
			throw new Error('not found: ' + k);
		},
		async copy(from: URI, to: URI): Promise<void> {
			const c = files.get(keyOf(from));
			if (c === undefined) { throw new Error('copy: not found'); }
			files.set(keyOf(to), c);
			addDir(keyOf(to).split('/').slice(0, -1).join('/'));
		},
		async move(from: URI, to: URI): Promise<void> {
			const c = files.get(keyOf(from));
			if (c === undefined) { throw new Error('move: not found'); }
			files.delete(keyOf(from));
			files.set(keyOf(to), c);
			addDir(keyOf(to).split('/').slice(0, -1).join('/'));
		},
		async createFolder(uri: URI): Promise<void> { addDir(keyOf(uri)); },
	};
	return {
		service: service as any,
		has(path: string) { return files.has(keyOf(URI.file(path))); },
		hasDir(path: string) { return dirs.has(keyOf(URI.file(path))); },
		content(path: string) { return files.get(keyOf(URI.file(path))); },
		backupPaths() { return [...files.keys()].filter(k => k.includes('-backup-kborganize-')); },
	};
}

const quietLog: any = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
const VAULT = '/vault';

function createHarness(seed: Record<string, string>) {
	const fs = createFsMock(seed);
	const captured: { agentId: string; fileUri: string }[] = [];
	const registered: any[] = [];
	registerKbOrganizeTools({
		register: (r: any) => { registered.push(r); },
		fileService: fs.service,
		storageService: { get: (k: string) => (k === 'agentStudio.kb.kbDir' ? VAULT : undefined) } as any,
		environmentService: { userHome: URI.file('/home/user') } as any,
		checkpointService: {
			async captureBeforeToolEdit(agentId: string, fileUri: string) { captured.push({ agentId, fileUri }); },
		} as any,
		logService: quietLog,
	});
	assert.strictEqual(registered.length, 1, '应注册且仅注册一个工具');
	const handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<any> = registered[0].handler;
	return { fs, captured, handler };
}

const SEED = {
	'/vault/库/raw/UI优化篇.md': '# 素材',
	'/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md': '# UI优化技巧\n\n内容原文',
	'/vault/笔记/01_学习/UnrealEngine/08_音频系统/音频管线.md': '# 音频',
	'/vault/笔记/01_学习/UnrealEngine/已有.md': '# 已有',
};

suite('kb_organize（笔记区目录整理工具）', () => {

	test('正常 move：笔记被搬走 + checkpoint 记录 + vault 外有备份 + 结果带 KB_ORGANIZE_RESULT', async () => {
		const { fs, captured, handler } = createHarness(SEED);
		const out = await handler({
			moves: [{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md' }],
			reason: '归入 UI 主题目录',
		}, undefined, 'knowledge-base-expert');

		assert.ok(!fs.has('/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md'), '原位置已移走');
		assert.strictEqual(fs.content('/vault/笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md'), '# UI优化技巧\n\n内容原文', '内容随迁');
		assert.strictEqual(captured.length, 1, '执行前写了 checkpoint');
		// URI.toString() 对中文是百分号编码的 ⇒ 先解码再断言
		assert.ok(decodeURIComponent(captured[0].fileUri).includes('UI优化技巧.md'), 'checkpoint 记的是被移动的文件');
		const backups = fs.backupPaths();
		assert.strictEqual(backups.length, 1, 'vault 外有一份备份');
		assert.ok(backups[0].endsWith('笔记/01_学习/UnrealEngine/UI优化技巧.md'), '备份保留原相对路径');
		assert.ok(backups[0].startsWith('/vault-backup-kborganize-'), '备份在 vault **之外**');

		const text: string = out.content[0].text;
		assert.ok(text.includes('KB_ORGANIZE_RESULT'), '结果带机器可读行');
		assert.strictEqual(out.details.moved.length, 1, 'details.moved 有 1 条');
		assert.strictEqual(out.details.skipped.length, 0, '没有跳过项');
	});

	test('安全闸：越出笔记区 / 路径穿越 / from 不存在 / to 已存在 / from===to 全部被拒', async () => {
		const { fs, captured, handler } = createHarness(SEED);
		const out = await handler({
			moves: [
				{ from: '库/raw/UI优化篇.md', to: '笔记/某处.md' },                                              // 越出笔记区（from 在库）
				{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/../库/raw/偷渡.md' },        // `..` 穿越
				{ from: '笔记/不存在.md', to: '笔记/某处.md' },                                                // from 不存在
				{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/已有.md' },    // to 已存在
				{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/UI优化技巧.md' }, // from===to
			],
		}, undefined, 'knowledge-base-expert');

		assert.strictEqual(out.details.moved.length, 0, '没有一项被执行');
		assert.strictEqual(out.details.skipped.length, 5, '5 项全部跳过并报告原因');
		assert.strictEqual(captured.length, 0, '全部拒绝 ⇒ 不写 checkpoint');
		assert.strictEqual(fs.backupPaths().length, 0, '全部拒绝 ⇒ 不产生备份');
		assert.ok(fs.has('/vault/库/raw/UI优化篇.md'), '库里的文件原样不动');
		assert.ok(fs.has('/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md'), '笔记原样不动');
		assert.strictEqual(fs.content('/vault/笔记/01_学习/UnrealEngine/已有.md'), '# 已有', '已有文件没被覆盖');
	});

	test('deletes = 移入备份目录（回收站语义，非真删）', async () => {
		const { fs, captured, handler } = createHarness(SEED);
		const out = await handler({ deletes: ['笔记/01_学习/UnrealEngine/UI优化技巧.md'] }, undefined, 'knowledge-base-expert');

		assert.ok(!fs.has('/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md'), '笔记区内已移除');
		const backups = fs.backupPaths();
		assert.strictEqual(backups.length, 1, '备份目录里收到了它');
		assert.strictEqual(fs.content(backups[0]), '# UI优化技巧\n\n内容原文', '备份内容完整');
		assert.strictEqual(captured.length, 1, '「删除」前也写了 checkpoint');
		assert.strictEqual(out.details.deletedToBackup.length, 1);
	});

	test('creates = 新建目录（越界同样被拒）', async () => {
		const { fs, handler } = createHarness(SEED);
		const out = await handler({ creates: ['笔记/01_学习/UnrealEngine/09_UI与Slate', '库/raw/不该建的目录'] }, undefined, 'knowledge-base-expert');

		assert.ok(fs.hasDir('/vault/笔记/01_学习/UnrealEngine/09_UI与Slate'), '笔记区内目录建成');
		assert.ok(!fs.hasDir('/vault/库/raw/不该建的目录'), '越界目录被拒');
		assert.strictEqual(out.details.created.length, 1);
		assert.strictEqual(out.details.skipped.length, 1);
	});

	test('备份失败 ⇒ 跳过该项（没有还原点就不动手）', async () => {
		const { fs, handler } = createHarness(SEED);
		fs.service.copy = async () => { throw new Error('disk full'); };
		const out = await handler({
			moves: [{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md' }],
		}, undefined, 'knowledge-base-expert');

		assert.strictEqual(out.details.moved.length, 0, '没搬');
		assert.strictEqual(out.details.skipped.length, 1, '报告了跳过');
		assert.ok(out.details.skipped[0].why.includes('备份失败'), '原因是备份失败');
		assert.ok(fs.has('/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md'), '原文件完好');
	});

	test('操作总数超限 ⇒ 整体拒绝（分批或走 KB_REORG）', async () => {
		const { fs, handler } = createHarness(SEED);
		const moves = Array.from({ length: 51 }, (_, i) => ({ from: `笔记/a${i}.md`, to: `笔记/b${i}.md` }));
		const out = await handler({ moves }, undefined, 'knowledge-base-expert');
		// 早退分支返回的是裸数组（无 details）⇒ 归一化取文本
		const text: string = (Array.isArray(out) ? out[0] : out.content[0]).text;

		assert.ok(text.includes('一次最多'), '说明上限');
		assert.strictEqual(fs.backupPaths().length, 0, '什么都没动');
	});

	test('空操作 ⇒ 提示没有任何操作项', async () => {
		const { handler } = createHarness(SEED);
		const out = await handler({}, undefined, 'knowledge-base-expert');
		const text: string = (Array.isArray(out) ? out[0] : out.content[0]).text;
		assert.ok(text.includes('没有任何操作项'), '');
	});

	test('链式移动（同一批里 A→B 又 B→C）：按顺序串行处理，两条都成立', async () => {
		const { fs, captured, handler } = createHarness(SEED);
		const out = await handler({
			moves: [
				{ from: '笔记/01_学习/UnrealEngine/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md' },
				{ from: '笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md', to: '笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化/UI优化技巧.md' },
			],
		}, undefined, 'knowledge-base-expert');

		assert.strictEqual(out.details.moved.length, 2, '两条移动都成立（第二条执行时，第一条的中间落点已经存在）');
		assert.strictEqual(captured.length, 2, '每步都写了 checkpoint');
		assert.strictEqual(fs.backupPaths().length, 2, '每步都有备份');
		assert.ok(!fs.has('/vault/笔记/01_学习/UnrealEngine/UI优化技巧.md'), '起点已移走');
		assert.ok(!fs.has('/vault/笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md'), '中间点也已移走');
		assert.strictEqual(fs.content('/vault/笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化/UI优化技巧.md'), '# UI优化技巧\n\n内容原文', '终点拿到内容');
	});
});
