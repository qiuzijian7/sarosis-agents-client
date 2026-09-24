/*---------------------------------------------------------------------------------------------
 *  图表渲染编排（renderNoteDiagrams）单元测试 —— 2026-09-23
 *
 *  依赖全 mock（fileService / 渲染器 / 栅格化）⇒ 不需要 DOM、不需要网络、不需要飞书。
 *  钉住三件最容易错的事：
 *   ① 多块替换的**偏移量**（必须倒序替换，否则后面的区间会错位、误删正文）；
 *   ② 图片引用必须**独占段落**（飞书插图走 block_replace 整块替换）；
 *   ③ 失败**不丢内容**（保留源码块）、无图表**不写盘**（避免无意义改 mtime）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/knowledge/diagramRenderPipeline.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as path from 'path';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { renderNoteDiagrams } from './diagramRenderPipeline.js';

const VAULT = URI.file(path.join('C:', 'tmp', 'vault'));
const NOTE = URI.joinPath(VAULT, '笔记', '设计.md');

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };

/** 内存 IFileService（只实现编排用到的那几个面）。 */
class MemFs {
	readonly files = new Map<string, VSBuffer>();
	readonly dirs = new Set<string>();
	writes = 0;
	async exists(uri: URI): Promise<boolean> { return this.files.has(uri.fsPath) || this.dirs.has(uri.fsPath); }
	async createFolder(uri: URI): Promise<void> { this.dirs.add(uri.fsPath); }
	async writeFile(uri: URI, buf: VSBuffer): Promise<void> { this.writes++; this.files.set(uri.fsPath, buf); }
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const v = this.files.get(uri.fsPath);
		if (!v) { throw new Error(`ENOENT: ${uri.fsPath}`); }
		return { value: v };
	}
	text(uri: URI): string { return this.files.get(uri.fsPath)?.toString() ?? ''; }
	relPaths(): string[] {
		const base = VAULT.fsPath + path.sep;
		return [...this.files.keys()].filter(f => f.startsWith(base)).map(f => f.slice(base.length).replace(/\\/g, '/'));
	}
}

const md = (...lines: string[]) => lines.join('\n');

interface IStubOptions {
	/** 渲染器抛错的 kind（用于测失败路径） */
	failRender?: 'mermaid' | 'drawio';
	/** 栅格化返回空（测失败路径） */
	emptyPng?: boolean;
}

function stubs(o: IStubOptions = {}) {
	const calls = { mermaid: 0, drawio: 0, raster: 0 };
	return {
		calls,
		renderMermaid: async (src: string): Promise<string> => {
			calls.mermaid++;
			if (o.failRender === 'mermaid') { throw new Error('mermaid 渲染失败'); }
			return `<svg width="100" height="50"><text>${src.length}</text></svg>`;
		},
		renderDrawio: async (src: string): Promise<string> => {
			calls.drawio++;
			if (o.failRender === 'drawio') { throw new Error('drawio 渲染失败'); }
			return `<svg width="100" height="50"><text>${src.length}</text></svg>`;
		},
		rasterize: async (svg: string): Promise<Uint8Array> => {
			calls.raster++;
			if (o.emptyPng) { return new Uint8Array(0); }
			return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		},
	};
}

function setup(markdown: string, o: IStubOptions & { writeBack?: boolean } = {}) {
	const fs = new MemFs();
	fs.files.set(NOTE.fsPath, VSBuffer.fromString(markdown));
	const s = stubs(o);
	return { fs, ...s, run: () => renderNoteDiagrams({
		vaultRoot: VAULT, noteUri: NOTE,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		fileService: fs as any,
		renderMermaid: s.renderMermaid, renderDrawio: s.renderDrawio, rasterize: s.rasterize,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		logService: quietLog as any,
		writeBack: o.writeBack,
	}) };
}

suite('图表渲染编排（renderNoteDiagrams）', () => {
	test('★ 单块 mermaid：落盘到 <笔记>.attachments/ 并改写为独占段落的图片引用', async () => {
		const t = setup(md('# 设计', '', '```mermaid', 'graph TD', '  A-->B', '```', '', '正文', ''));
		const r = await t.run();

		assert.strictEqual(r.changed, true);
		assert.strictEqual(r.rendered.length, 1);
		assert.deepStrictEqual(r.rendered[0].kind, 'mermaid');
		assert.strictEqual(r.rendered[0].relPath, '设计.attachments/chart-1.png');
		assert.ok(t.fs.relPaths().includes('笔记/设计.attachments/chart-1.png'), 'PNG 应落在笔记同级的附件目录');

		const note = t.fs.text(NOTE);
		assert.ok(note.includes('![[设计.attachments/chart-1.png]]'), '应写入图片引用');
		assert.ok(!note.includes('```mermaid') && !note.includes('A-->B'), '源码块应被替换掉');
		assert.match(note, /\n\n!\[\[设计\.attachments\/chart-1\.png\]\]\n\n/, '引用必须独占段落');
		assert.ok(note.includes('# 设计') && note.includes('正文'), '其余内容逐字保留');
	});

	test('★ 多块（mermaid + drawio）：编号对应原文顺序，且正文不因偏移错位而丢失', async () => {
		const t = setup(md('开头', '', '```mermaid', 'g1', '```', '', '中间文字', '', '```drawio', '<mxfile/>', '```', '', '结尾'));
		const r = await t.run();

		assert.strictEqual(r.rendered.length, 2);
		assert.deepStrictEqual(r.rendered.map(d => d.relPath),
			['设计.attachments/chart-1.png', '设计.attachments/chart-2.png']);
		assert.deepStrictEqual(r.rendered.map(d => d.kind), ['mermaid', 'drawio']);

		const note = t.fs.text(NOTE);
		assert.ok(note.includes('![[设计.attachments/chart-1.png]]') && note.includes('![[设计.attachments/chart-2.png]]'));
		assert.ok(!note.includes('```mermaid') && !note.includes('```drawio'), '两块源码都应消失');
		// ⚠ 偏移量回归：这三段正文必须都还在（倒序替换就是为了这个）
		assert.ok(note.includes('开头') && note.includes('中间文字') && note.includes('结尾'));
		assert.ok(note.indexOf('开头') < note.indexOf('chart-1') && note.indexOf('chart-1') < note.indexOf('中间文字'));
	});

	test('★ 单个图表渲染失败：保留该块源码、其它块照常转换（不丢内容）', async () => {
		const t = setup(
			md('```mermaid', 'ok', '```', '', '```drawio', '<mxfile/>', '```'),
			{ failRender: 'drawio' },
		);
		const r = await t.run();

		assert.strictEqual(r.rendered.length, 1, 'mermaid 应成功');
		assert.strictEqual(r.failures.length, 1);
		assert.strictEqual(r.failures[0].kind, 'drawio');
		assert.ok(r.message.includes('失败'));

		const note = t.fs.text(NOTE);
		assert.ok(note.includes('![[设计.attachments/chart-1.png]]'), '成功的那块应被替换');
		assert.ok(note.includes('<mxfile/>'), '失败的块必须保留源码（内容不能丢）');
	});

	test('全部失败 ⇒ changed=false 且**不写回笔记**（避免把文件改坏）', async () => {
		const original = md('```mermaid', 'g', '```');
		const t = setup(original, { failRender: 'mermaid' });
		const r = await t.run();

		assert.strictEqual(r.changed, false);
		assert.strictEqual(r.rendered.length, 0);
		assert.strictEqual(r.failures.length, 1);
		assert.strictEqual(t.fs.text(NOTE), original, '笔记内容应原样不动');
	});

	test('栅格化返回空 PNG ⇒ 记为失败（不写出 0 字节图片）', async () => {
		const t = setup(md('```mermaid', 'g', '```'), { emptyPng: true });
		const r = await t.run();
		assert.strictEqual(r.rendered.length, 0);
		assert.strictEqual(r.failures.length, 1);
		assert.ok(!t.fs.relPaths().some(p => p.endsWith('.png')), '不应留下空图片文件');
	});

	test('★ 没有图表 ⇒ 完全不写盘（不改 mtime、不产生空附件目录）', async () => {
		const t = setup(md('# 纯文字笔记', '', '没有图表。'));
		const r = await t.run();
		assert.strictEqual(r.changed, false);
		assert.strictEqual(t.fs.writes, 0, '不应发生任何写操作');
		assert.deepStrictEqual(t.fs.relPaths(), ['笔记/设计.md']);
		assert.ok(r.message.includes('没有需要转换的图表'));
	});

	test('演练模式（writeBack=false）⇒ 生成图片但不改笔记', async () => {
		const original = md('```mermaid', 'g', '```');
		const t = setup(original, { writeBack: false });
		const r = await t.run();
		assert.strictEqual(r.rendered.length, 1);
		assert.strictEqual(r.changed, true);
		assert.strictEqual(t.fs.text(NOTE), original, '演练模式不得改动笔记');
		assert.ok(t.fs.relPaths().some(p => p.endsWith('.png')), '图片仍会生成（便于预览）');
	});

	test('笔记读取失败 ⇒ 明确报错且不抛异常', async () => {
		const fs = new MemFs();   // 不预置文件
		const s = stubs();
		const r = await renderNoteDiagrams({
			vaultRoot: VAULT, noteUri: NOTE,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any,
			renderMermaid: s.renderMermaid, renderDrawio: s.renderDrawio, rasterize: s.rasterize,
		});
		assert.strictEqual(r.changed, false);
		assert.ok(r.message.includes('读取笔记失败'));
	});
});
