/*---------------------------------------------------------------------------------------------
 *  diagramEmbedPipeline.test.ts — 图表文件嵌入（![[x.drawio|.mermaid|.canvas]]）→ PNG 管线的测试。
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/knowledge/diagramEmbedPipeline.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { extractDiagramEmbeds, renderNoteDiagramEmbeds, resolveEmbedTarget } from './diagramEmbedPipeline.js';
import { canvasToSvg } from './canvasToSvg.js';

// ---------------------------------------------------------------------------
// 内存 FS mock（resolve 缺失抛错；writeFile/createFolder 记录）
// ---------------------------------------------------------------------------

function createFs(seed: Record<string, string>) {
	const files = new Map<string, string>();
	const dirs = new Set<string>(['/']);
	const keyOf = (uri: URI) => uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const addDir = (k: string) => {
		const segs = k.split('/').filter(Boolean);
		let acc = '';
		for (const s of segs) { acc += '/' + s; dirs.add(acc); }
	};
	for (const [p, v] of Object.entries(seed)) {
		const k = URI.file(p).fsPath.replace(/\\/g, '/');
		files.set(k, v);
		addDir(k.split('/').slice(0, -1).join('/'));
	}
	const service: any = {
		async resolve(uri: URI): Promise<any> {
			const k = keyOf(uri);
			if (files.has(k)) { return { resource: uri, isDirectory: false }; }
			if (dirs.has(k)) {
				const prefix = k + '/';
				const children: any[] = [];
				const seen = new Set<string>();
				for (const d of dirs) {
					if (d === k || !d.startsWith(prefix)) { continue; }
					const seg = d.slice(prefix.length);
					if (!seg.includes('/') && !seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
				}
				for (const [p] of files) {
					if (!p.startsWith(prefix)) { continue; }
					const rest = p.slice(prefix.length);
					const seg = rest.split('/')[0];
					if (rest.includes('/')) {
						if (!seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
					} else if (!seen.has(seg)) {
						seen.add(seg); children.push({ resource: URI.file(p), name: seg, isDirectory: false });
					}
				}
				return { resource: uri, isDirectory: true, children };
			}
			throw new Error('not found: ' + k);
		},
		async readFile(uri: URI) {
			const c = files.get(keyOf(uri));
			if (c === undefined) { throw new Error('not found'); }
			return { value: { toString: () => c } };
		},
		async writeFile(uri: URI, value: { toString(): string } | { toString(): string }) {
			const k = keyOf(uri);
			files.set(k, typeof value === 'string' ? value : value.toString());
			addDir(k.split('/').slice(0, -1).join('/'));
		},
		async createFolder(uri: URI) { addDir(keyOf(uri)); },
	};
	return {
		service: service as any,
		content(path: string): string | undefined { return files.get(keyOf(URI.file(path))); },
		has(path: string) { return files.has(keyOf(URI.file(path))); },
	};
}

const quietLog: any = { info() { }, warn() { }, error() { } };
const VAULT = URI.file('/vault');
const NOTE = URI.file('/vault/笔记/架构笔记.md');

const okRenderers = {
	renderMermaid: async () => '<svg>mermaid</svg>',
	renderDrawio: async () => '<svg>drawio</svg>',
	rasterize: async () => new Uint8Array([1, 2, 3]),
	logService: quietLog,
};

// ---------------------------------------------------------------------------

suite('extractDiagramEmbeds（抽取：独占段落 + 跳过围栏 + 只收三类图表）', () => {

	test('三类 embed 独占段落 ⇒ 全部抽出（含区间）', () => {
		const md = [
			'# 标题', '',
			'![[流程.mermaid]]', '',
			'![[arch.drawio]]', '',
			'![[导图.canvas]]', '',
		].join('\n');
		const embeds = extractDiagramEmbeds(md);
		assert.deepStrictEqual(embeds.map(e => e.kind), ['mermaid', 'drawio', 'canvas']);
		assert.deepStrictEqual(embeds.map(e => e.target), ['流程.mermaid', 'arch.drawio', '导图.canvas']);
		// 区间指向整行（含行尾换行）
		assert.strictEqual(md.slice(embeds[0].start, embeds[0].end), '![[流程.mermaid]]\n');
	});

	test('行内 embed / 围栏内 embed / 图片与 html embed ⇒ 一律不收', () => {
		const md = [
			'见 ![[行内.drawio]] 这段话',          // 行内 ⇒ 跳过
			'```',
			'![[代码块里.drawio]]',                  // 围栏内 ⇒ 跳过
			'```',
			'![[图片.png]]',                          // 图片 ⇒ 已有图片链路
			'![[页面.html]]',                         // html ⇒ 活页面链路
			'![[普通笔记]]',                          // 无扩展名 ⇒ 笔记 embed
			'![[别名.drawio|显示名]]',                // 带别名 ⇒ 收（target 含别名原文）
		].join('\n');
		const embeds = extractDiagramEmbeds(md);
		assert.strictEqual(embeds.length, 1);
		assert.strictEqual(embeds[0].target, '别名.drawio|显示名');
		assert.strictEqual(embeds[0].kind, 'drawio');
	});
});

suite('resolveEmbedTarget（解析：相对笔记 → 相对 vault → 全库按文件名）', () => {

	test('三级解析顺序', async () => {
		const fs = createFs({
			'/vault/笔记/同目录.drawio': 'x',
			'/vault/库/raw/库里的.mermaid': 'y',
			'/vault/笔记/子目录/深层.canvas': 'z',
		});
		// ① 相对笔记目录
		assert.strictEqual(
			(await resolveEmbedTarget(fs.service, VAULT, NOTE, '同目录.drawio'))?.fsPath.replace(/\\/g, '/'),
			'/vault/笔记/同目录.drawio',
		);
		// ② 相对 vault 根
		assert.strictEqual(
			(await resolveEmbedTarget(fs.service, VAULT, NOTE, '库/raw/库里的.mermaid'))?.fsPath.replace(/\\/g, '/'),
			'/vault/库/raw/库里的.mermaid',
		);
		// ③ 全库按文件名搜（裸文件名）
		assert.strictEqual(
			(await resolveEmbedTarget(fs.service, VAULT, NOTE, '深层.canvas'))?.fsPath.replace(/\\/g, '/'),
			'/vault/笔记/子目录/深层.canvas',
		);
		// 找不到 ⇒ undefined
		assert.strictEqual(await resolveEmbedTarget(fs.service, VAULT, NOTE, '不存在.drawio'), undefined);
	});
});

suite('canvasToSvg（纯函数：JSON Canvas → SVG）', () => {

	test('节点/连线/文本/转义', () => {
		const svg = canvasToSvg(JSON.stringify({
			nodes: [
				{ id: 'a', x: 0, y: 0, width: 100, height: 50, content: '中心 <标题>' },
				{ id: 'b', x: 200, y: 100, width: 100, height: 50, text: '子节点' },
			],
			edges: [{ fromNode: 'a', toNode: 'b', label: '关联' }],
		}));
		assert.ok(svg.startsWith('<svg'), '产出 SVG');
		assert.ok(svg.includes('中心 &lt;标题&gt;'), '文本转义');
		assert.ok(svg.includes('<line'), '有连线');
		assert.ok(svg.includes('关联'), '边标签');
		assert.ok(svg.includes('</svg>'));
	});

	test('非法 JSON / 空节点 ⇒ 抛错（调用方按失败处理）', () => {
		assert.throws(() => canvasToSvg('not json'), /JSON/);
		assert.throws(() => canvasToSvg('{"nodes":[]}'), /无有效节点/);
	});
});

suite('renderNoteDiagramEmbeds（编排：渲染 → 落盘 → 改写 → 写回）', () => {

	test('★ mermaid 内联为围栏（不落 PNG），canvas 仍转 PNG', async () => {
		const fs = createFs({
			'/vault/笔记/架构笔记.md': ['# 架构', '', '![[同目录.mermaid]]', '', '![[导图.canvas]]', ''].join('\n'),
			'/vault/笔记/同目录.mermaid': 'graph TD; A-->B',
			'/vault/库/raw/导图.canvas': JSON.stringify({ nodes: [{ id: 'a', x: 0, y: 0, width: 100, height: 50, text: '节点' }], edges: [] }),
		});
		const r = await renderNoteDiagramEmbeds({ vaultRoot: VAULT, noteUri: NOTE, fileService: fs.service, ...okRenderers });
		assert.strictEqual(r.inlined.length, 1, `mermaid 内联：${r.message}`);
		assert.strictEqual(r.inlined[0].kind, 'mermaid');
		assert.strictEqual(r.rendered.length, 1, 'canvas 转 PNG');
		assert.strictEqual(r.failures.length, 0);
		assert.strictEqual(r.changed, true);
		// 只有 canvas 落 PNG（mermaid 不落）
		assert.ok(fs.has('/vault/笔记/架构笔记.attachments/embed-1.png'), 'canvas 的 PNG');
		assert.ok(!fs.has('/vault/笔记/架构笔记.attachments/embed-2.png'), 'mermaid 不应产生 PNG');
		const out = fs.content('/vault/笔记/架构笔记.md')!;
		assert.ok(out.includes('```mermaid\ngraph TD; A-->B\n```'), 'mermaid 已内联为围栏');
		assert.ok(out.includes('![[架构笔记.attachments/embed-1.png]]'), 'canvas 已改写为 PNG 引用');
		assert.ok(!out.includes('![[同目录.mermaid]]'), 'mermaid 原 embed 不再存在');
	});

	test('目标找不到 ⇒ 保留原文、不影响其它 embed', async () => {
		const fs = createFs({
			'/vault/笔记/n.md': ['![[丢失.drawio]]', '', '![[ok.mermaid]]', ''].join('\n'),
			'/vault/笔记/ok.mermaid': 'graph TD; A-->B',
		});
		const note = URI.file('/vault/笔记/n.md');
		const r = await renderNoteDiagramEmbeds({ vaultRoot: VAULT, noteUri: note, fileService: fs.service, ...okRenderers });
		assert.strictEqual(r.rendered.length, 0, 'drawio 失败 ⇒ 无 PNG');
		assert.strictEqual(r.inlined.length, 1, 'mermaid 照常内联');
		assert.strictEqual(r.failures.length, 1);
		assert.ok(r.failures[0].reason.includes('找不到目标文件'));
		const out = fs.content('/vault/笔记/n.md')!;
		assert.ok(out.includes('![[丢失.drawio]]'), '失败的 embed 原文保留');
		assert.ok(out.includes('```mermaid'), 'mermaid 内联成功');
	});

	test('drawio 渲染失败 ⇒ 原文保留（笔记只保留那一处）', async () => {
		const fs = createFs({
			'/vault/笔记/n.md': '![[bad.drawio]]\n',
			'/vault/笔记/bad.drawio': '<mxfile>bad</mxfile>',
		});
		const before = fs.content('/vault/笔记/n.md')!;
		const r = await renderNoteDiagramEmbeds({
			vaultRoot: VAULT, noteUri: URI.file('/vault/笔记/n.md'), fileService: fs.service,
			renderDrawio: async () => { throw new Error('渲染引擎挂了'); },
			rasterize: okRenderers.rasterize, logService: quietLog,
		});
		assert.strictEqual(r.changed, false);
		assert.strictEqual(r.failures.length, 1);
		assert.strictEqual(r.rendered.length, 0);
		assert.strictEqual(fs.content('/vault/笔记/n.md'), before, '笔记一个字节都没动');
	});

	test('无 embed ⇒ 不写盘；演练模式 ⇒ 不落盘不写回', async () => {
		const fs = createFs({ '/vault/笔记/n.md': '# 没有图表\n' });
		const note = URI.file('/vault/笔记/n.md');
		const r = await renderNoteDiagramEmbeds({ vaultRoot: VAULT, noteUri: note, fileService: fs.service, ...okRenderers });
		assert.strictEqual(r.changed, false);
		assert.ok(!fs.has('/vault/笔记/n.attachments/embed-1.png'));

		// 演练：mermaid 内联同样不写回；canvas 的 PNG 也不落盘
		const fs2 = createFs({
			'/vault/笔记/n.md': ['![[ok.mermaid]]', '', '![[map.canvas]]', ''].join('\n'),
			'/vault/笔记/ok.mermaid': 'graph TD; A-->B',
			'/vault/笔记/map.canvas': JSON.stringify({ nodes: [{ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'n' }], edges: [] }),
		});
		const r2 = await renderNoteDiagramEmbeds({ vaultRoot: VAULT, noteUri: note, fileService: fs2.service, writeBack: false, ...okRenderers });
		assert.strictEqual(r2.inlined.length, 1, '演练也内联');
		assert.strictEqual(r2.rendered.length, 1, '演练也渲染');
		assert.ok(fs2.has('/vault/笔记/n.attachments/embed-1.png'),
			'演练仍落盘图片（与 renderNoteDiagrams 同语义：writeBack 只控制**笔记是否写回**，图片照产）');
		assert.ok(fs2.content('/vault/笔记/n.md')!.includes('![[ok.mermaid]]'), '演练不写回（笔记原文保留）');
		assert.ok(!fs2.content('/vault/笔记/n.md')!.includes('```mermaid'), '演练未把 mermaid 内联写进笔记');
	});
});
