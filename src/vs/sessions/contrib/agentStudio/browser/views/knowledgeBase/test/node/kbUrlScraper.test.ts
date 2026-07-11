/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	detectPlatform,
	parseMetaTags,
	guessMediaExt,
	isDownloadableMedia,
	formatDuration,
	composeArticleMarkdown,
	composeVideoMarkdown,
	findMarkdownImageUrls,
	rewriteMarkdownImageUrls,
	type IKbMetaTags,
} from '../../kbUrlScraper.js';

suite('KB URL Scraper (pure functions)', () => {



	// ---- 平台识别 T1 / T2 ----
	test('T1 detectPlatform douyin → video', () => {
		const p = detectPlatform('https://www.douyin.com/video/7300000000000000000');
		assert.strictEqual(p.id, 'douyin');
		assert.strictEqual(p.type, 'video');
	});

	test('T1 detectPlatform youtube / bilibili → video', () => {
		assert.strictEqual(detectPlatform('https://www.youtube.com/watch?v=abc').type, 'video');
		assert.strictEqual(detectPlatform('https://www.bilibili.com/video/BV1xx').type, 'video');
	});

	test('T1 detectPlatform xiaohongshu → mixed', () => {
		const p = detectPlatform('https://www.xiaohongshu.com/explore/abc123');
		assert.strictEqual(p.id, 'xiaohongshu');
		assert.strictEqual(p.type, 'mixed');
	});

	test('T2 detectPlatform unknown → generic article', () => {
		const p = detectPlatform('https://example.com/some-article');
		assert.strictEqual(p.id, 'generic');
		assert.strictEqual(p.type, 'article');
	});

	test('detectPlatform invalid url → 回退 generic', () => {
		const p = detectPlatform('not-a-url');
		assert.strictEqual(p.id, 'generic');
	});

	// ---- OG 解析 T3 ----
	test('T3 parseMetaTags 抽取 og:title/og:image/og:description/author', () => {
		const html = `<!doctype html><html><head>
			<meta property="og:title" content="测试标题">
			<meta property="og:image" content="https://cdn.example.com/cover.jpg">
			<meta property="og:description" content="这是摘要">
			<meta name="author" content="张三">
			<meta property="og:site_name" content="示例站">
		</head><body></body></html>`;
		const meta = parseMetaTags(html);
		assert.strictEqual(meta.title, '测试标题');
		assert.strictEqual(meta.cover, 'https://cdn.example.com/cover.jpg');
		assert.strictEqual(meta.description, '这是摘要');
		assert.strictEqual(meta.author, '张三');
		assert.strictEqual(meta.siteName, '示例站');
	});

	test('T3 parseMetaTags 视频时长 / 直链', () => {
		const html = `<html><head>
			<meta property="og:video:duration" content="201">
			<meta property="og:video" content="https://cdn.example.com/clip.mp4">
		</head></html>`;
		const meta = parseMetaTags(html);
		assert.strictEqual(meta.durationSec, 201);
		assert.strictEqual(meta.videoUrl, 'https://cdn.example.com/clip.mp4');
	});

	// ---- 实体解码 T12 ----
	test('T12 实体解码 &amp; &nbsp;', () => {
		const html = `<html><head>
			<meta property="og:title" content="A &amp; B &nbsp; C &lt;x&gt;">
		</head></html>`;
		const meta = parseMetaTags(html);
		assert.strictEqual(meta.title, 'A & B C <x>');
	});

	// ---- guessMediaExt T6 ----
	test('T6 guessMediaExt 忽略 query string / 识别 mime', () => {
		assert.strictEqual(guessMediaExt('https://x.com/a.mp4?token=1'), 'mp4');
		assert.strictEqual(guessMediaExt('https://x.com/a', 'video/webm'), 'webm');
		assert.strictEqual(guessMediaExt('https://x.com/a.jpg'), 'jpg');
		assert.strictEqual(guessMediaExt('https://x.com/page.html'), 'bin'); // 不把 html 当媒体
	});

	// ---- isDownloadableMedia T7 ----
	test('T7 isDownloadableMedia 直链 vs m3u8', () => {
		assert.strictEqual(isDownloadableMedia('https://x.com/a.mp4'), true);
		assert.strictEqual(isDownloadableMedia('https://x.com/a.m3u8'), false);
		assert.strictEqual(isDownloadableMedia('https://x.com/a', 'video/mp4'), true);
		assert.strictEqual(isDownloadableMedia('https://x.com/a', 'application/vnd.apple.mpegurl'), false);
	});

	// ---- formatDuration T8 ----
	test('T8 formatDuration mm:ss / h:mm:ss', () => {
		assert.strictEqual(formatDuration(201), '3:21');
		assert.strictEqual(formatDuration(3661), '1:01:01');
		assert.strictEqual(formatDuration(0), undefined);
		assert.strictEqual(formatDuration(-5), undefined);
		assert.strictEqual(formatDuration(undefined), undefined);
	});

	// ---- composeArticleMarkdown T9 ----
	test('T9 composeArticleMarkdown 标题/来源/封面/正文齐全', () => {
		const meta: IKbMetaTags = {
			title: '示例文章',
			author: '李四',
			siteName: '知乎',
			date: '2026-07-10',
			cover: 'https://x.com/c.jpg',
			description: '摘要内容',
			tags: ['AI', '测试'],
		};
		const md = composeArticleMarkdown({
			url: 'https://zhihu.com/p/123',
			platformName: '知乎',
			meta,
			body: '正文第一段。\n\n正文第二段。',
			coverLocalPath: 'media/import_cover.jpg',
		});
		assert.match(md, /^# 示例文章/);
		assert.match(md, /作者：李四/);
		assert.match(md, /来源：知乎/);
		assert.match(md, /发布：2026-07-10/);
		assert.match(md, /平台：知乎/);
		assert.match(md, /!\[封面\]\(media\/import_cover\.jpg\)/);
		assert.match(md, /摘要内容/);
		assert.match(md, /正文第一段/);
		assert.match(md, /标签：AI \/ 测试/);
	});

	test('composeArticleMarkdown 无封面/元信息也不报错', () => {
		const md = composeArticleMarkdown({
			url: 'https://example.com/a',
			platformName: '网页',
			meta: {},
			body: '内容',
		});
		assert.match(md, /^# https:\/\/example\.com\/a/);
		assert.match(md, /内容/);
	});

	// ---- composeVideoMarkdown T10 ----
	test('T10 composeVideoMarkdown 已下载 → 含本地路径', () => {
		const meta: IKbMetaTags = { title: '视频A', author: 'up主', durationSec: 121 };
		const md = composeVideoMarkdown({
			url: 'https://bilibili.com/BV1',
			platformName: 'B站',
			meta,
			mediaLocalPath: 'media/import.mp4',
			downloaded: true,
		});
		assert.match(md, /^# 视频A/);
		assert.match(md, /时长：2:01/);
		assert.match(md, /已抓取视频文件/);
		assert.match(md, /\(media\/import\.mp4\)/);
	});

	test('T10 composeVideoMarkdown 未下载 → ⚠️ 提示', () => {
		const md = composeVideoMarkdown({
			url: 'https://douyin.com/x/1',
			platformName: '抖音',
			meta: { title: '视频B' },
			downloaded: false,
		});
		assert.match(md, /⚠️/);
		assert.doesNotMatch(md, /已抓取视频文件/);
	});

	// ---- 正文图片本地化 T11（纯函数级）----
	test('T11 findMarkdownImageUrls 抽取远程图片，去重', () => {
		const md = '![a](https://x.com/1.jpg) 文本 ![b](https://x.com/1.jpg) ![c](https://x.com/2.png)';
		const urls = findMarkdownImageUrls(md);
		assert.deepStrictEqual(urls, ['https://x.com/1.jpg', 'https://x.com/2.png']);
	});

	test('T11 findMarkdownImageUrls 忽略本地路径与裸链接', () => {
		const md = '![a](media/local.jpg) [链接](https://x.com) ![b](https://x.com/r.png)';
		const urls = findMarkdownImageUrls(md);
		assert.deepStrictEqual(urls, ['https://x.com/r.png']);
	});

	test('T11 rewriteMarkdownImageUrls 改写远程 URL 为本地的', () => {
		const md = '![a](https://x.com/1.jpg)\n\n![b](https://x.com/2.png)';
		const map = new Map<string, string>([
			['https://x.com/1.jpg', 'media/p_0.jpg'],
			['https://x.com/2.png', 'media/p_1.png'],
		]);
		const out = rewriteMarkdownImageUrls(md, map);
		assert.match(out, /!\[a\]\(media\/p_0\.jpg\)/);
		assert.match(out, /!\[b\]\(media\/p_1\.png\)/);
		assert.doesNotMatch(out, /https:\/\/x\.com/);
	});

	test('T11 rewriteMarkdownImageUrls 未命中保持原样', () => {
		const md = '![a](https://x.com/1.jpg)';
		const out = rewriteMarkdownImageUrls(md, new Map());
		assert.strictEqual(out, md);
	});
});

// ===========================================================================
// 组装管线（fixtures 驱动，确定性、无网络）
// 对应设计文档 §5.2 的 E1（SSR 文章）/ E2（视频 OG 兜底）/ E4（封面+正文图本地化）
// 真实渲染抓取（WebContentExtractor）属主进程 + 外网集成测试，见 tests/web/kb-url-import.spec.ts。
// ===========================================================================
suite('KB URL 抓取组装管线（fixtures）', () => {

	// E1：SSR 文章 —— OG meta 抽出标题/作者/封面 → 落盘 Markdown 结构
	test('E1 文章管线 parseMetaTags + composeArticleMarkdown', () => {
		const html = `<html><head>
			<meta property="og:title" content="从零实现向量检索">
			<meta property="og:image" content="https://pica.zhimg.com/cover.jpg">
			<meta property="og:description" content="一篇关于 RAG 的实践文">
			<meta name="author" content="知乎用户A">
			<meta property="og:site_name" content="知乎">
		</head></html>`;
		const meta = parseMetaTags(html);
		const body = '## 背景\n\n检索的核心是相似度。\n\n## 实现\n\n用 FAISS 建索引。';
		const md = composeArticleMarkdown({
			url: 'https://zhihu.com/p/10086',
			platformName: detectPlatform('https://zhihu.com/p/10086').name,
			meta,
			body,
			coverLocalPath: 'media/import_cover.jpg', // 封面已本地化
		});
		assert.match(md, /^# 从零实现向量检索/);
		assert.match(md, /作者：知乎用户A/);
		assert.match(md, /来源：知乎/);
		assert.match(md, /!\[封面\]\(media\/import_cover\.jpg\)/);
		assert.match(md, /## 背景/);
		assert.match(md, /用 FAISS 建索引/);
	});

	// E2：视频 OG 兜底 —— 无直链可下载时，composeVideoMarkdown 给 ⚠️ 提示
	test('E2 视频 OG 兜底 未下载 → ⚠️ 提示 + 元信息保留', () => {
		const html = `<html><head>
			<meta property="og:title" content="十分钟看懂 Transformer">
			<meta property="og:video:duration" content="612">
			<meta property="og:image" content="https://cover.douyin.com/x.jpg">
		</head></html>`;
		const meta = parseMetaTags(html);
		const md = composeVideoMarkdown({
			url: 'https://v.douyin.com/abc',
			platformName: detectPlatform('https://v.douyin.com/abc').name,
			meta,
			downloaded: false,
		});
		assert.match(md, /^# 十分钟看懂 Transformer/);
		assert.match(md, /时长：10:12/);
		assert.match(md, /⚠️/);
		assert.doesNotMatch(md, /已抓取视频文件/);
	});

	// E4：封面 + 正文图本地化 —— 先抽取正文图片 URL，改写后全部指向本地 media/
	test('E4 封面 + 正文图本地化 全本地引用', () => {
		const html = `<html><head>
			<meta property="og:title" content="穿搭笔记">
			<meta property="og:image" content="https://xhs.com/cover.jpg">
		</head></html>`;
		const meta = parseMetaTags(html);
		// 模拟 WebContentExtractor 产出的正文（含远程图片）
		const body = '今天分享一套穿搭：\n\n![图1](https://xhs.com/p1.jpg)\n\n中间说明。\n\n![图2](https://xhs.com/p1.jpg)\n\n![图3](https://xhs.com/p3.png)';
		const imgUrls = findMarkdownImageUrls(body);
		assert.strictEqual(imgUrls.length, 2); // p1 去重
		// 模拟下载成功 → 本地路径映射
		const map = new Map<string, string>([
			['https://xhs.com/p1.jpg', 'media/import_img0.jpg'],
			['https://xhs.com/p3.png', 'media/import_img1.png'],
		]);
		const localized = rewriteMarkdownImageUrls(body, map);
		const md = composeArticleMarkdown({
			url: 'https://xiaohongshu.com/explore/xyz',
			platformName: detectPlatform('https://xiaohongshu.com/explore/xyz').name,
			meta,
			body: localized,
			coverLocalPath: 'media/import_cover.jpg',
		});
		assert.match(md, /!\[封面\]\(media\/import_cover\.jpg\)/);
		assert.match(md, /!\[图1\]\(media\/import_img0\.jpg\)/);
		assert.match(md, /!\[图3\]\(media\/import_img1\.png\)/);
		assert.doesNotMatch(md, /https:\/\/xhs\.com/); // 全部改写为本地
	});
});
