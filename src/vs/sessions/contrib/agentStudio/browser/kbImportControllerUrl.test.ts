/*---------------------------------------------------------------------------------------------
 *  kbImportController.importUrl —— 「平台 URL → 抓取 → 落盘到库」编排单元测试（2026-09-23）
 *
 *  为什么补这一层：`importUrl` 是全链路（URL → 库 → 笔记 → 飞书）的**第一段**，
 *  却完全没有测试 —— 而它恰好是「平台分流 / 图片本地化 / 防覆盖 / yt-dlp 降级」这些
 *  最容易回归的地方。它是 `static` + 依赖全注入 ⇒ 可以用内存 FileService 全量 mock。
 *
 *  覆盖：
 *   · 平台分流：知乎(article) vs B站/YouTube/抖音(video) vs 小红书(mixed)
 *   · 正文/元信息组装（标题、`> 原文：`、`> 平台：`）
 *   · 图片本地化：下载到 `库/raw/assets/<slug>/` 并**改写正文远程引用**为相对路径
 *   · 落盘：`库/raw/<slug>.md` + 同名防覆盖 `-2`
 *   · yt-dlp 不可用 ⇒ 降级不中断，且字幕临时目录不留垃圾
 *   · 错误路径：非法 URL / 提取器报错 / 无可读内容
 *
 *  ⚠ 不覆盖（只能真机 E2E）：真实网络抓取、平台反爬、真实 yt-dlp 元信息与字幕下载。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/kbImportControllerUrl.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as path from 'path';

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, bufferToStream } from '../../../../base/common/buffer.js';
import { KbImportController } from './kbImportController.js';
import { slugifyTitle } from './views/knowledgeBase/kbUrlScraper.js';

const VAULT = URI.file(path.join('C:', 'tmp', 'vault'));

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };

/** 内存 IFileService：只实现 importUrl 用到的那几个面（exists/createFolder/writeFile/readFile/resolve/del）。 */
class MemFs {
	readonly files = new Map<string, VSBuffer>();
	readonly dirs = new Set<string>();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async exists(uri: URI): Promise<boolean> { return this.files.has(uri.fsPath) || this.dirs.has(uri.fsPath); }
	async createFolder(uri: URI): Promise<void> { this.dirs.add(uri.fsPath); }
	async writeFile(uri: URI, buf: VSBuffer): Promise<void> { this.files.set(uri.fsPath, buf); }
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		return { value: this.files.get(uri.fsPath) ?? VSBuffer.fromString('') };
	}
	async del(uri: URI): Promise<void> {
		this.files.delete(uri.fsPath);
		this.dirs.delete(uri.fsPath);
	}
	async resolve(uri: URI): Promise<{ resource: URI; children: unknown[] }> {
		const prefix = uri.fsPath.replace(/[\\/]+$/, '') + path.sep;
		const children: unknown[] = [];
		for (const f of this.files.keys()) {
			if (f.startsWith(prefix) && !f.slice(prefix.length).includes(path.sep)) {
				children.push({ resource: URI.file(f), name: path.basename(f), isDirectory: false });
			}
		}
		return { resource: uri, children };
	}
	/** 便于断言：知识库内所有文件路径（相对 vault） */
	relPaths(): string[] {
		const base = VAULT.fsPath + path.sep;
		return [...this.files.keys()].filter(f => f.startsWith(base)).map(f => f.slice(base.length).replace(/\\/g, '/'));
	}
	textOf(rel: string): string {
		const buf = this.files.get(path.join(VAULT.fsPath, ...rel.split('/')));
		return buf ? buf.toString() : '';
	}
}

/** mock「主进程 reader-mode 提取器」。 */
function makeExtractor(out: { body: string; title?: string } | { error: string; statusCode?: number }) {
	return {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		extract: async (_uris: URI[]): Promise<any[]> => [
			'error' in out
				? { status: 'error', error: out.error, statusCode: out.statusCode }
				: { status: 'ok', result: out.body, title: out.title },
		],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

/**
 * 取知识库内的**正文文件**内容（`库/raw/*.md`）。
 *
 * ⚠ 不要用 `relPaths()[0]`：图片文件也在该列表里，而且**先于正文写入**
 *   （先落 `assets/<slug>/<i>-x.png`，最后才写 `<slug>.md`）⇒ 直接取 `[0]` 会读到
 *   PNG 二进制，断言全变成「内容里没有 assets/ 字样」这种莫名其妙的失败（2026-09-23 踩过）。
 */
function noteText(fs: MemFs): string {
	const notes = fs.relPaths().filter(p => p.endsWith('.md'));
	assert.strictEqual(notes.length, 1, `应恰好一个正文文件，实际：${notes.join(', ')}`);
	return fs.textOf(notes[0]);
}

/**
 * mock `IRequestService`：`importUrl` 的**第二条正文来源**（提取器拿不到正文时的 HTML 兜底）。
 * 上层走 `asText(ctx)` ⇒ 必须是 `{ res, stream }` 形状，stream 用 `bufferToStream` 造。
 */
function makeRequestService(html: string) {
	return {
		request: async () => ({
			res: { statusCode: 200, headers: {} },
			stream: bufferToStream(VSBuffer.fromString(html)),
		}),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

/** mock 图片读取器：返回固定 4 字节「PNG」。 */
function makeImageReader(seen: string[]) {
	return {
		readImage: async (uri: URI): Promise<VSBuffer> => {
			seen.push(uri.toString());
			return VSBuffer.wrap(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(fs: MemFs, url: string, extractor: any, opts: { images?: any } = {}) {
	return KbImportController.importUrl({
		url, vaultRoot: VAULT,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		fileService: fs as any,
		logService: quietLog as never,
		extractor,
		imageReader: opts.images,
		// 刻意不传 requestService：extractor 成功时不需要 HTML 兜底
	});
}

suite('KB importUrl —— 平台 URL 抓取与落盘', () => {

	test('知乎（article）：正文落盘到 库/raw/<slug>.md，并写入平台与原文元信息', async () => {
		const fs = new MemFs();
		const url = 'https://zhuanlan.zhihu.com/p/123456';
		const body = '这是知乎专栏的正文第一段。\n\n第二段。';
		const r = await run(fs, url, makeExtractor({ body, title: '知乎：如何理解 Agent' }));

		assert.strictEqual(r.ok, true);
		const slug = slugifyTitle('知乎：如何理解 Agent', url);
		assert.deepStrictEqual(fs.relPaths(), [`库/raw/${slug}.md`], '应只落一个文件到 库/raw/');

		const md = fs.textOf(`库/raw/${slug}.md`);
		assert.ok(md.startsWith('# 知乎：如何理解 Agent'), '应以标题起头');
		assert.ok(md.includes(`原文：${url}`), '应保留原文链接（溯源）');
		assert.ok(md.includes('这是知乎专栏的正文第一段'), '正文应写入');
		assert.ok(!md.includes('未能直接下载视频文件'), 'article 平台不应走视频模板');
	});

	test('B站 / YouTube / 抖音（video）：走视频模板（不下载本体 + 原文链接 + 降级说明）', async () => {
		for (const url of [
			'https://www.bilibili.com/video/BV1xx411c7mD',
			'https://www.youtube.com/watch?v=abc12345678',
			'https://www.douyin.com/video/7123456789',
		]) {
			const fs = new MemFs();
			const r = await run(fs, url, makeExtractor({ body: '', title: `视频 ${url.slice(-6)}` }));
			assert.strictEqual(r.ok, true, `${url} 应导入成功（yt-dlp 缺失也要降级成功）→ 实际：${r.message}`);
			const md = fs.textOf(fs.relPaths()[0]);
			assert.ok(md.includes(`原文：${url}`), `${url} 应保留原文链接`);
			assert.ok(md.includes('未能直接下载视频文件'), `${url} 应说明未下载视频本体（避免误导）`);
			assert.ok(!md.includes('## 正文'), `${url} 无正文时不应硬塞空正文段`);
		}
	});

	test('小红书（mixed）⇒ 视频/混合模板；正文足够长时才附「## 正文」', async () => {
		const fs = new MemFs();
		const url = 'https://www.xiaohongshu.com/explore/abcdef123456';
		// ⚠ 实现刻意只在正文 > 80 字符时才附「## 正文」（视频页的短正文多是导航碎片噪声）
		const longBody = '这是一条小红书的图文正文，用来验证视频/混合平台在正文足够长时会把它附在视频块之后，'
			+ '而不是直接丢弃；同时也保证短正文不会污染笔记内容。'
			+ '再补一段文字确保长度稳定超过八十个字符，避免将来改动这里的文案时把断言弄坏掉。';
		assert.ok(longBody.length > 80);
		const r = await run(fs, url, makeExtractor({ body: longBody, title: '小红书笔记' }));
		assert.strictEqual(r.ok, true);
		const md = fs.textOf(fs.relPaths()[0]);
		assert.ok(md.includes('未能直接下载视频文件'), 'mixed 平台按视频模板（含媒体说明）');
		assert.ok(md.includes('## 正文'), '正文足够长时应附在视频块之后');

		// 反向：短正文（噪声）不附
		const fs2 = new MemFs();
		const r2 = await run(fs2, url, makeExtractor({ body: '短正文', title: '小红书笔记' }));
		assert.strictEqual(r2.ok, true);
		assert.ok(!fs2.textOf(fs2.relPaths()[0]).includes('## 正文'), '短正文不应被当作正文写入');
	});

	test('★ 图片本地化：下载到 库/raw/assets/<slug>/ 且正文远程引用被改写为相对路径', async () => {
		const fs = new MemFs();
		const url = 'https://example.com/blog/posts/hello';
		const imgRemote = 'https://cdn.example.com/images/pic-one.png';
		const body = [
			'# Hello',
			`正文里有一张图：![图示](${imgRemote})`,
			'还有一段文字。',
		].join('\n\n');
		const seen: string[] = [];
		const r = await run(fs, url, makeExtractor({ body, title: '示例博客文章' }), { images: makeImageReader(seen) });
		assert.strictEqual(r.ok, true);

		const slug = slugifyTitle('示例博客文章', url);
		const rel = fs.relPaths();
		assert.ok(rel.includes(`库/raw/${slug}.md`), '正文应落盘');
		assert.strictEqual(r.images > 0, true, '应统计到已下载图片数');
		assert.ok(r.message.includes('图片'), '结果消息应包含图片数量');

		// 图片落进 assets/<slug>/，文件名带序号且保留扩展名
		const assetFiles = rel.filter(p => p.startsWith(`库/raw/assets/${slug}/`));
		assert.strictEqual(assetFiles.length, r.images, '图片文件数应与统计一致');
		assert.ok(assetFiles.some(p => /\/1-pic-one\.png$/.test(p)), `应含 1-pic-one.png，实际 ${assetFiles.join(', ')}`);

		// ★ 关键：正文里的远程 URL 必须被替换为**相对路径**（否则飞书同步/笔记预览都拿不到本地图）
		const md = fs.textOf(`库/raw/${slug}.md`);
		assert.ok(!md.includes(imgRemote), '正文中的远程图片 URL 应被改写掉');
		assert.ok(md.includes(`assets/${slug}/1-pic-one.png`), '应改为 assets/<slug>/ 相对路径');
	});

	test('★ 同名防覆盖：已有同名文件 ⇒ 落盘为 <slug>-2.md（不覆盖既有素材）', async () => {
		const fs = new MemFs();
		const url = 'https://example.com/a';
		const slug = slugifyTitle('重复标题', url);
		const first = await run(fs, url, makeExtractor({ body: '第一次', title: '重复标题' }));
		assert.strictEqual(first.ok, true);
		const second = await run(fs, url, makeExtractor({ body: '第二次', title: '重复标题' }));
		assert.strictEqual(second.ok, true);

		assert.deepStrictEqual(fs.relPaths().sort(), [`库/raw/${slug}-2.md`, `库/raw/${slug}.md`].sort());
		assert.ok(fs.textOf(`库/raw/${slug}.md`).includes('第一次'), '既有文件内容不得被覆盖');
		assert.ok(fs.textOf(`库/raw/${slug}-2.md`).includes('第二次'), '第二次应写进 -2 文件');
	});

	test('yt-dlp 不可用（视频平台）⇒ 降级不中断，且字幕临时目录不留垃圾', async () => {
		const fs = new MemFs();
		const url = 'https://www.bilibili.com/video/BV1yy411c7mE';
		const r = await run(fs, url, makeExtractor({ body: '', title: '无字幕的视频' }));
		assert.strictEqual(r.ok, true, 'yt-dlp 缺失必须降级成功（否则用户以为整条链路坏了）');

		// 临时字幕目录可能被创建，但**不得残留任何文件**（否则会污染知识库/飞书同步范围）
		const leftovers = fs.relPaths().filter(p => p.includes('subs') || p.includes('tmp'));
		assert.deepStrictEqual(leftovers, [], `字幕临时目录不应残留文件，实际：${leftovers.join(', ')}`);
	});

	test('错误路径：非法 URL / 提取器报错 / 无可读内容', async () => {
		const fs = new MemFs();
		const bad = await run(fs, 'ftp://example.com/x', makeExtractor({ body: 'x' }));
		assert.strictEqual(bad.ok, false);
		assert.ok(bad.message.includes('http(s)://'), '应提示需要 http(s) 链接');

		const errored = await run(fs, 'https://example.com/e', makeExtractor({ error: 'blocked by robots', statusCode: 403 }));
		assert.strictEqual(errored.ok, false);
		assert.ok(errored.message.includes('blocked by robots'), '应透传提取器错误原因');
		assert.ok(errored.message.includes('403'), '应带上 HTTP 状态码');

		const empty = await run(fs, 'https://example.com/empty', makeExtractor({ body: '   ', title: '' }));
		assert.strictEqual(empty.ok, false);
		assert.ok(/未能获取正文|未能获取内容/.test(empty.message), '应给出可执行的失败原因');
		assert.deepStrictEqual(fs.relPaths(), [], '失败时不应落盘任何文件');
	});

	// ── 降级 / 容错路径（2026-09-23 补齐）────────────────────────────────────
	// 这些分支平时不跑，一旦被改坏就是「导入静默失败 / 图片静默丢失 / 标题退化成 URL」。

	test('★ HTML 兜底：提取器无正文 ⇒ 走 requestService 取 HTML，并从 meta 补齐标题', async () => {
		const fs = new MemFs();
		const html = '<html><head><meta property="og:title" content="兜底标题"></head>'
			+ '<body><h1>页面大标题</h1><p>这是 HTML 兜底解析出来的正文段落。</p></body></html>';
		const r = await KbImportController.importUrl({
			url: 'https://example.com/fallback',
			vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any,
			logService: quietLog as never,
			// 提取器「成功但无正文、无标题」⇒ 必须落到 HTML 兜底，且标题从 og:title 补回来
			extractor: makeExtractor({ body: '' }),
			requestService: makeRequestService(html),
		});
		assert.strictEqual(r.ok, true, `HTML 兜底应成功 → 实际：${r.message}`);
		const md = fs.textOf(fs.relPaths()[0]);
		assert.ok(md.startsWith('# 兜底标题'),
			`标题应从 og:title 补齐（否则 H1 退化成 URL），实际首行：${md.split('\n')[0]}`);
		assert.ok(md.includes('这是 HTML 兜底解析出来的正文段落'), '正文应来自 HTML 去标签兜底');
	});

	test('★ 重定向：提取器返回 redirect ⇒ 跟随一次再抓（否则整条导入失败）', async () => {
		const fs = new MemFs();
		const seen: string[] = [];
		const extractor = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			extract: async (uris: URI[]): Promise<any[]> => {
				seen.push(uris[0].toString());
				return seen.length === 1
					? [{ status: 'redirect', toURI: URI.parse('https://example.com/final') }]
					: [{ status: 'ok', result: '重定向之后的正文', title: '最终标题' }];
			},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const r = await KbImportController.importUrl({
			url: 'https://example.com/start', vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any, logService: quietLog as never, extractor,
		});
		assert.strictEqual(r.ok, true, `重定向应被跟随 → 实际：${r.message}`);
		assert.strictEqual(seen.length, 2, '应再抓一次重定向目标');
		assert.ok(seen[1].endsWith('/final'), `第二次应抓重定向目标，实际：${seen[1]}`);
		assert.ok(fs.textOf(fs.relPaths()[0]).includes('重定向之后的正文'));
	});

	test('图片读取器不可用 ⇒ 不报错、保留远程引用（不静默丢图）', async () => {
		const fs = new MemFs();
		const img = 'https://cdn.example.com/keep.png';
		const r = await run(fs, 'https://example.com/no-reader', makeExtractor({ body: `正文\n\n![图](${img})`, title: '无读取器' }));
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.images, 0, '没有读取器 ⇒ 不应统计到图片');
		assert.ok(fs.textOf(fs.relPaths()[0]).includes(img), '读取器缺失时必须保留远程引用');
	});

	test('★ 单张图片下载失败 ⇒ 其余继续，且只统计成功的', async () => {
		const fs = new MemFs();
		const ok1 = 'https://cdn.example.com/ok-1.png';
		const bad = 'https://cdn.example.com/bad.png';
		const ok2 = 'https://cdn.example.com/ok-2.png';
		const reader = {
			readImage: async (uri: URI): Promise<VSBuffer> => {
				if (uri.path.includes('bad')) { throw new Error('404'); }
				return VSBuffer.wrap(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
			},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const r = await KbImportController.importUrl({
			url: 'https://example.com/partial', vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any, logService: quietLog as never,
			extractor: makeExtractor({ body: `![a](${ok1})\n\n![b](${bad})\n\n![c](${ok2})`, title: '部分失败' }),
			imageReader: reader,
		});
		assert.strictEqual(r.ok, true, '单图失败不能拖垮整条导入');
		assert.strictEqual(r.images, 2, '只统计成功的两张');
		const md = noteText(fs);
		assert.ok(md.includes('assets/') && !md.includes(ok1), '成功的图应被改写为本地相对路径');
		assert.ok(md.includes(bad), '失败的图必须保留远程引用（不能凭空消失）');
	});

	test('★ 封面（og:image）也本地化，并写入 `![封面](assets/…)`', async () => {
		const fs = new MemFs();
		const cover = 'https://cdn.example.com/cover.png';
		const html = '<html><head>'
			+ '<meta property="og:title" content="带封面的文章">'
			+ `<meta property="og:image" content="${cover}">`
			+ '</head><body><p>正文够长的一段内容，用来保证走的是文章路径。</p></body></html>';
		const seen: string[] = [];
		const r = await KbImportController.importUrl({
			url: 'https://example.com/with-cover', vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any, logService: quietLog as never,
			extractor: makeExtractor({ body: '' }),        // 无正文 ⇒ 触发 HTML（meta 才拿得到封面）
			requestService: makeRequestService(html),
			imageReader: makeImageReader(seen),
		});
		assert.strictEqual(r.ok, true, `应成功 → 实际：${r.message}`);
		assert.ok(seen.some(u => u.includes('cover.png')), 'og:image 应作为图片候选被下载');
		const md = noteText(fs);
		assert.ok(!md.includes(`](${cover})`), '封面远程引用应被改写为本地');
		assert.ok(/!\[封面\]\(assets\//.test(md), `封面应写成本地相对路径，实际正文：\n${md}`);
	});

	test('同一图片 URL 出现两次 ⇒ 只下载一次（候选去重）', async () => {
		const fs = new MemFs();
		const img = 'https://cdn.example.com/same.png';
		const seen: string[] = [];
		const r = await KbImportController.importUrl({
			url: 'https://example.com/dedup', vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any, logService: quietLog as never,
			extractor: makeExtractor({ body: `![a](${img})\n\n![b](${img})`, title: '重复图' }),
			imageReader: makeImageReader(seen),
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.images, 1, '同一 URL 只应下载一次');
		assert.strictEqual(seen.length, 1);
	});

	test('http:// 链接会升级为 https（渲染进程 CSP 只允许 https）', async () => {
		const fs = new MemFs();
		const seen: string[] = [];
		const extractor = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			extract: async (uris: URI[]): Promise<any[]> => {
				seen.push(uris[0].toString());
				return [{ status: 'ok', result: '正文', title: 'http 页面' }];
			},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
		const r = await KbImportController.importUrl({
			url: 'http://example.com/plain', vaultRoot: VAULT,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: fs as any, logService: quietLog as never, extractor,
		});
		assert.strictEqual(r.ok, true);
		assert.ok(seen[0].startsWith('https://'), `抓取必须用 https（否则被 CSP 拦截），实际：${seen[0]}`);
		assert.ok(fs.textOf(fs.relPaths()[0]).includes('https://example.com/plain'), '原文链接应记录升级后的 https');
	});

	test('连续同名 ⇒ 依次落 -2 / -3（不止 -2）', async () => {
		const fs = new MemFs();
		const url = 'https://example.com/same-title';
		const slug = slugifyTitle('三连标题', url);
		for (let i = 0; i < 3; i++) {
			const r = await run(fs, url, makeExtractor({ body: `第 ${i + 1} 次`, title: '三连标题' }));
			assert.strictEqual(r.ok, true);
		}
		assert.deepStrictEqual(
			fs.relPaths().sort(),
			[`库/raw/${slug}.md`, `库/raw/${slug}-2.md`, `库/raw/${slug}-3.md`].sort(),
		);
		assert.ok(fs.textOf(`库/raw/${slug}.md`).includes('第 1 次'), '首次内容不得被覆盖');
		assert.ok(fs.textOf(`库/raw/${slug}-3.md`).includes('第 3 次'), '第三次应进 -3');
	});

	test('slugifyTitle 边界：非法字符折叠 / 超长截断 / 空标题兜底', () => {
		assert.strictEqual(slugifyTitle('a/b:c*d?e"f<g>h|i', 'https://x/y'), 'a-b-c-d-e-f-g-h-i', '文件系统非法字符应折叠为 -');
		assert.strictEqual(slugifyTitle('', 'https://example.com/posts/hello-world'), 'hello-world', '无标题时应退化为 URL 末段');
		assert.strictEqual(slugifyTitle('   ', 'not-a-url'), 'untitled', '标题与 URL 都不可用时兜底 untitled');
		assert.strictEqual(slugifyTitle('---', 'https://x'), 'untitled', '纯连字符不应产生空 slug');
		assert.strictEqual(slugifyTitle('x'.repeat(200), 'https://x').length, 60, '超长应截断到 60');
	});

	test('★ 视频附正文的阈值边界：恰好 80 字符不附、81 字符才附', async () => {
		const url = 'https://www.bilibili.com/video/BV1threshold';
		// 实现是 `rewrittenBody.trim().length > 80`（严格大于）
		const fs80 = new MemFs();
		const fs81 = new MemFs();
		const r80 = await run(fs80, url, makeExtractor({ body: 'a'.repeat(80), title: '阈值80' }));
		const r81 = await run(fs81, url, makeExtractor({ body: 'a'.repeat(81), title: '阈值81' }));
		assert.strictEqual(r80.ok, true);
		assert.strictEqual(r81.ok, true);
		assert.ok(!fs80.textOf(fs80.relPaths()[0]).includes('## 正文'), '恰好 80 字符不应附正文（视频页短正文多是导航噪声）');
		assert.ok(fs81.textOf(fs81.relPaths()[0]).includes('## 正文'), '81 字符应附正文');
	});
});
