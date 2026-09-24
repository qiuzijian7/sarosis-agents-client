/*---------------------------------------------------------------------------------------------
 *  htmlAttachmentPrepare.test.ts — 同步前「HTML 附件准备」测试（2026-09-24）。
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/knowledge/htmlAttachmentPrepare.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { extractHtmlEmbeds, prepareHtmlAttachmentsForNote } from './htmlAttachmentPrepare.js';

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
		async writeFile(uri: URI, value: any) {
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
const NOTE = URI.file('/vault/笔记/n.md');

suite('extractHtmlEmbeds（抽取：独占段落 + 跳过围栏 + 只收 html）', () => {

	test('独占段落的 html embed ⇒ 抽出（含区间）', () => {
		const md = ['# t', '', '![[live-demo.html]]', '', '![[a.htm]]', ''].join('\n');
		const embeds = extractHtmlEmbeds(md);
		assert.deepStrictEqual(embeds.map(e => e.ref), ['live-demo.html', 'a.htm']);
		assert.strictEqual(md.slice(embeds[0].start, embeds[0].end), '![[live-demo.html]]\n');
	});

	test('行内 / 围栏内 / 其它扩展名 ⇒ 不收', () => {
		const md = [
			'见 ![[行内.html]] 说明',
			'```',
			'![[代码块里.html]]',
			'```',
			'![[图片.png]]',
			'![[图表.drawio]]',
			'![[普通笔记]]',
		].join('\n');
		assert.deepStrictEqual(extractHtmlEmbeds(md), []);
	});
});

suite('prepareHtmlAttachmentsForNote（复制到 .attachments + 改写引用）', () => {

	test('库内任意位置的 html ⇒ 复制进笔记附件目录并改写为相对引用', async () => {
		const fs = createFs({
			'/vault/笔记/n.md': ['# t', '', '![[live-demo.html]]', ''].join('\n'),
			'/vault/库/raw/live-demo.html': '<html><body>hi</body></html>',
		});
		const r = await prepareHtmlAttachmentsForNote({ vaultRoot: VAULT, noteUri: NOTE, fileService: fs.service, logService: quietLog });
		assert.strictEqual(r.attachments, 1);
		assert.strictEqual(r.missing.length, 0);
		assert.strictEqual(r.changed, true);
		assert.ok(fs.has('/vault/笔记/n.attachments/live-demo.html'), '文件已复制到附件目录');
		assert.strictEqual(fs.content('/vault/笔记/n.md'), ['# t', '', '![[n.attachments/live-demo.html]]', ''].join('\n'));
	});

	test('已在附件目录（幂等） ⇒ 不重复复制、不改写', async () => {
		const md = '![[n.attachments/live-demo.html]]\n';
		const fs = createFs({
			'/vault/笔记/n.md': md,
			'/vault/笔记/n.attachments/live-demo.html': '<html/>',
		});
		const r = await prepareHtmlAttachmentsForNote({ vaultRoot: VAULT, noteUri: NOTE, fileService: fs.service, logService: quietLog });
		assert.strictEqual(r.changed, false);
		assert.strictEqual(fs.content('/vault/笔记/n.md'), md, '内容一个字节都没动');
	});

	test('目标找不到 ⇒ 保留原文并记入 missing', async () => {
		const md = '![[丢失.html]]\n';
		const fs = createFs({ '/vault/笔记/n.md': md });
		const r = await prepareHtmlAttachmentsForNote({ vaultRoot: VAULT, noteUri: NOTE, fileService: fs.service, logService: quietLog });
		assert.deepStrictEqual(r.missing, ['丢失.html']);
		assert.strictEqual(r.changed, false);
		assert.strictEqual(fs.content('/vault/笔记/n.md'), md);
	});

	test('dryRun ⇒ 只统计（不复制、不写回）', async () => {
		const md = '![[live-demo.html]]\n';
		const fs = createFs({
			'/vault/笔记/n.md': md,
			'/vault/库/raw/live-demo.html': '<html/>',
		});
		const r = await prepareHtmlAttachmentsForNote({ vaultRoot: VAULT, noteUri: NOTE, fileService: fs.service, logService: quietLog, dryRun: true });
		assert.strictEqual(r.attachments, 1, 'dryRun 也统计');
		assert.strictEqual(r.changed, false);
		assert.ok(!fs.has('/vault/笔记/n.attachments/live-demo.html'), 'dryRun 不复制');
		assert.strictEqual(fs.content('/vault/笔记/n.md'), md, 'dryRun 不写回');
	});
});
