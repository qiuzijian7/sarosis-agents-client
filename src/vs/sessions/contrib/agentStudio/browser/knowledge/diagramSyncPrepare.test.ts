/*---------------------------------------------------------------------------------------------
 *  同步前「图表准备」编排（prepareDiagramsForSync）单元测试 —— 2026-09-24
 *
 *  这一步是「知识库视图 → 同步飞书」按钮与 agent 工具 `kb_feishu_sync` **共用**的编排
 *  （2026-09-24 从视图私有方法抽出，就是为了让工具路径也触发它）。钉住三件最容易错的事：
 *
 *   ① dry-run **零副作用**：只统计、不渲染、不写盘 —— 预览绝不能改写用户笔记；
 *   ② 真渲染必须**两条管线都跑到**（围栏代码块 + 图表文件嵌入）并正确聚合；
 *   ③ 单篇异常**不中断整批**（其余笔记照常处理），且无图表的笔记不打扰调用方。
 *
 *  依赖全 mock（fileService / 渲染器 / 栅格化）⇒ 不需要 DOM、不需要网络、不需要飞书。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/knowledge/diagramSyncPrepare.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as path from 'path';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { prepareDiagramsForSync } from './diagramSyncPrepare.js';

const VAULT = URI.file(path.join('C:', 'tmp', 'vault'));
const NOTES = URI.joinPath(VAULT, '笔记');
const LIB = URI.joinPath(VAULT, '库');

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };

const md = (...lines: string[]) => lines.join('\n');
const isSep = (s: string) => s.includes('/') || s.includes('\\');

/** 内存 IFileService（只实现编排用到的那几个面；`resolve` 做单层目录列举）。 */
class MemFs {
	readonly files = new Map<string, VSBuffer>();
	writes = 0;
	/** 读这些路径（子串匹配）时抛错 —— 用于「单篇异常不中断整批」。 */
	readonly throwOnRead = new Set<string>();

	async exists(uri: URI): Promise<boolean> { return this.files.has(uri.fsPath); }
	async createFolder(): Promise<void> { /* 目录隐式存在 */ }
	async writeFile(uri: URI, buf: VSBuffer): Promise<void> { this.writes++; this.files.set(uri.fsPath, buf); }
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		for (const needle of this.throwOnRead) {
			if (uri.fsPath.includes(needle)) { throw new Error(`EIO: ${uri.fsPath}`); }
		}
		const v = this.files.get(uri.fsPath);
		if (!v) { throw new Error(`ENOENT: ${uri.fsPath}`); }
		return { value: v };
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async resolve(uri: URI): Promise<any> {
		const prefix = uri.fsPath.endsWith(path.sep) ? uri.fsPath : uri.fsPath + path.sep;
		const children: Array<{ name: string; isDirectory: boolean; resource: URI }> = [];
		const seenDirs = new Set<string>();
		for (const f of this.files.keys()) {
			if (!f.startsWith(prefix)) { continue; }
			const rest = f.slice(prefix.length);
			const seg = rest.split(/[\\/]/)[0];
			if (!seg) { continue; }
			if (isSep(rest)) {
				if (seenDirs.has(seg)) { continue; }
				seenDirs.add(seg);
				children.push({ name: seg, isDirectory: true, resource: URI.joinPath(uri, seg) });
			} else {
				children.push({ name: seg, isDirectory: false, resource: URI.joinPath(uri, seg) });
			}
		}
		return { children };
	}
	text(uri: URI): string { return this.files.get(uri.fsPath)?.toString() ?? ''; }
	put(uri: URI, content: string): URI { this.files.set(uri.fsPath, VSBuffer.fromString(content)); return uri; }
}

interface IStubOptions {
	/** 渲染器抛错（测「失败记入 failures」） */
	failRender?: boolean;
}

function stubs(o: IStubOptions = {}) {
	const calls = { mermaid: 0, drawio: 0, raster: 0 };
	const boom = (): never => { throw new Error('渲染引擎不可用'); };
	return {
		calls,
		renderMermaid: async (src: string): Promise<string> => {
			calls.mermaid++;
			if (o.failRender) { return boom(); }
			return `<svg width="100" height="50"><text>${src.length}</text></svg>`;
		},
		renderDrawio: async (src: string): Promise<string> => {
			calls.drawio++;
			if (o.failRender) { return boom(); }
			return `<svg width="100" height="50"><text>${src.length}</text></svg>`;
		},
		rasterize: async (): Promise<Uint8Array> => {
			calls.raster++;
			return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		},
	};
}

function run(fs: MemFs, srcDirs: readonly string[], o: IStubOptions & { dryRun?: boolean } = {}) {
	const s = stubs(o);
	return {
		fs, s,
		promise: prepareDiagramsForSync({
			vaultRoot: VAULT,
			srcDirs,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any,
			renderMermaid: s.renderMermaid, renderDrawio: s.renderDrawio, rasterize: s.rasterize,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			logService: quietLog as any,
			dryRun: o.dryRun,
		}),
	};
}

const NOTE_A = URI.joinPath(NOTES, '设计.md');
const NOTE_B = URI.joinPath(NOTES, '纯文字.md');
const NOTE_C = URI.joinPath(NOTES, '子目录', '时序.md');

suite('同步前图表准备（prepareDiagramsForSync）', () => {

	test('★ dry-run：只统计、**不渲染不写盘**（预览不能改写用户笔记）', async () => {
		const fs = new MemFs();
		const original = md(
			'# 设计', '',
			'```mermaid', 'graph TD', '  A-->B', '```', '',
			'![[流程.mermaid]]', '',
			'![[拓扑.canvas]]', '',
			'![[live-demo.html]]', '',
		);
		fs.put(NOTE_A, original);
		fs.put(NOTE_B, md('# 纯文字', '', '没有图表。'));
		fs.put(URI.joinPath(NOTES, 'live-demo.html'), '<html/>');

		const t = run(fs, ['笔记'], { dryRun: true });
		const r = await t.promise;

		assert.strictEqual(r.dryRun, true);
		assert.strictEqual(r.scanned, 2, '两篇都被扫到');
		assert.strictEqual(r.charts, 1, 'canvas 嵌入算一张 PNG 目标');
		assert.strictEqual(r.inlined, 1, 'mermaid 嵌入算一个「内联转画板」目标');
		assert.strictEqual(r.attachments, 1, 'html 嵌入算一个附件目标');
		assert.strictEqual(r.touched, 0, 'dry-run 不该「改动」任何笔记');
		assert.strictEqual(r.notes.length, 1, '只有含图表/附件的笔记列入 notes');
		assert.strictEqual(r.notes[0].name, '设计.md');
		assert.strictEqual(r.notes[0].changed, false);

		assert.strictEqual(t.s.calls.mermaid + t.s.calls.drawio + t.s.calls.raster, 0, 'dry-run 不得触发任何渲染');
		assert.strictEqual(fs.writes, 0, 'dry-run 不得发生任何写操作');
		assert.strictEqual(fs.text(NOTE_A), original, '笔记内容必须逐字不动');
	});

	test('★ 真渲染：三条链路都跑到（PNG / 内联围栏 / 附件复制）并正确聚合', async () => {
		const fs = new MemFs();
		fs.put(NOTE_A, md(
			'# 设计', '',
			'```mermaid', 'graph TD', '  A-->B', '```', '',
			'![[流程.mermaid]]', '',
			'![[拓扑.canvas]]', '',
			'![[live-demo.html]]', '',
		));
		// ⚠ canvas 必须是**非空节点**的 JSON Canvas：canvasToSvg 对空节点主动抛错（记为失败、保留原文）
		fs.put(URI.joinPath(NOTES, '拓扑.canvas'), JSON.stringify({
			nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: '拓扑' }],
			edges: [],
		}));
		fs.put(URI.joinPath(NOTES, '流程.mermaid'), md('graph LR', '  X-->Y'));
		fs.put(URI.joinPath(NOTES, 'live-demo.html'), '<html><body>hi</body></html>');

		const t = run(fs, ['笔记']);
		const r = await t.promise;

		assert.strictEqual(r.dryRun, false);
		assert.strictEqual(r.charts, 1, 'canvas → PNG');
		assert.strictEqual(r.inlined, 1, 'mermaid 嵌入 → 内联围栏（不落 PNG）');
		assert.strictEqual(r.attachments, 1, 'html → 附件复制');
		assert.strictEqual(r.failures, 0);
		assert.strictEqual(r.touched, 1, '同一篇笔记多处改动只算一篇');
		assert.strictEqual(t.s.calls.mermaid, 0, 'mermaid 不再走渲染器（飞书转画板）');

		const note = fs.text(NOTE_A);
		assert.ok(note.includes('![[设计.attachments/embed-1.png]]'), 'canvas 应被替换为图片引用');
		assert.ok(note.includes('```mermaid\ngraph LR\n  X-->Y\n```'), 'mermaid 嵌入应内联为围栏');
		assert.ok(note.includes('![[设计.attachments/live-demo.html]]'), 'html 引用应改写为附件目录相对路径');
		assert.ok(fs.files.has(URI.joinPath(NOTES, '设计.attachments', 'live-demo.html').fsPath), 'html 已复制进附件目录');
		assert.ok(!note.includes('![[拓扑.canvas]]') && !note.includes('![[流程.mermaid]]'), '原 embed 都已消失');
		assert.ok(note.includes('# 设计'), '其余内容逐字保留');
	});

	test('★ 单篇读失败：整批不中断，其余笔记照常统计', async () => {
		const fs = new MemFs();
		// 用 drawio 围栏（mermaid 已不参与转换 ⇒ 不再计入 charts）
		fs.put(NOTE_A, md('```drawio', '<mxfile><diagram name="a">x</diagram></mxfile>', '```'));
		fs.put(NOTE_C, md('```drawio', '<mxfile><diagram name="b">y</diagram></mxfile>', '```'));
		fs.throwOnRead.add('设计.md');

		const t = run(fs, ['笔记'], { dryRun: true });
		const r = await t.promise;   // 不得抛出

		assert.strictEqual(r.scanned, 2);
		assert.strictEqual(r.charts, 1, '坏掉那篇按 0 计，好的那篇照常统计');
		assert.deepStrictEqual(r.notes.map(n => n.name), ['时序.md'], '含坏文件时其余笔记仍被处理');
	});

	test('★ 递归与过滤：子目录笔记被发现、非 md 文件被忽略、无图表的笔记不列入 notes', async () => {
		const fs = new MemFs();
		fs.put(NOTE_C, md('```drawio', '<mxfile><diagram name="c">z</diagram></mxfile>', '```'));
		fs.put(NOTE_B, md('# 纯文字', '', '没有图表。'));
		fs.put(URI.joinPath(NOTES, '附件.png.txt'), 'not markdown');

		const t = run(fs, ['笔记'], { dryRun: true });
		const r = await t.promise;

		assert.strictEqual(r.scanned, 2, '只统计 .md / .markdown');
		assert.deepStrictEqual(r.notes.map(n => n.name), ['时序.md'], '子目录笔记被发现，纯文字笔记不打扰');
	});

	test('srcDirs 留空 ⇒ 兜底只扫「笔记」区（★ 2026-09-24：库是素材层，永不参与同步）', async () => {
		const fs = new MemFs();
		fs.put(URI.joinPath(NOTES, '笔记A.md'), md('```drawio', '<mxfile><diagram name="a">x</diagram></mxfile>', '```'));
		fs.put(URI.joinPath(LIB, '素材B.md'), md('```drawio', '<mxfile><diagram name="b">y</diagram></mxfile>', '```'));

		const r = await run(fs, [], { dryRun: true }).promise;

		assert.strictEqual(r.scanned, 1, '兜底范围只有「笔记」——「库」里的素材不进同步计划');
		assert.strictEqual(r.charts, 1);
	});

	test('渲染引擎整体不可用 ⇒ 记为失败但不抛（同步流程不该被图表拖死）', async () => {
		const fs = new MemFs();
		fs.put(NOTE_A, md('```drawio', '<mxfile><diagram name="a">x</diagram></mxfile>', '```'));

		const r = await run(fs, ['笔记'], { failRender: true }).promise;

		assert.strictEqual(r.charts, 0);
		assert.ok(r.failures >= 1, '失败必须如实计数（工具据此告诉用户「已保留源码」）');
		assert.ok(fs.text(NOTE_A).includes('```drawio'), '失败时源码必须保留');
	});
});
