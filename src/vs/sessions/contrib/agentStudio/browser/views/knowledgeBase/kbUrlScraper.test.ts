/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbUrlScraper.test.ts — 知识库 URL 导入纯函数单元测试（无网络、无 DOM）。
 *
 *  覆盖：
 *   1. detectPlatform — URL → 平台识别（14 个主要平台 + 未知兜底）
 *   2. parseMetaTags — HTML meta 解析（OG / Twitter Card / article）
 *   3. guessMediaExt — URL / MIME → 媒体扩展名
 *   4. isDownloadableMedia — 视频直链可下载判断
 *   5. formatDuration — 秒 → mm:ss / h:mm:ss
 *   6. findMarkdownImageUrls — 从 Markdown 提取图片 URL
 *   7. rewriteMarkdownImageUrls — 图片路径本地化改写
 *   8. composeArticleMarkdown — 图文组装 → Markdown
 *   9. composeVideoMarkdown — 视频组装 → Markdown
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	detectPlatform,
	parseMetaTags,
	guessMediaExt,
	isDownloadableMedia,
	formatDuration,
	findMarkdownImageUrls,
	rewriteMarkdownImageUrls,
	composeArticleMarkdown,
	composeVideoMarkdown,
} from './kbUrlScraper.js';

// ═══════════════════════════════════════════════════════════════════════
// detectPlatform
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - detectPlatform', () => {

	it('小红书链接 → xiaohongshu / mixed', () => {
		const p = detectPlatform('https://www.xiaohongshu.com/explore/abc123');
		assert.strictEqual(p.id, 'xiaohongshu');
		assert.strictEqual(p.type, 'mixed');
	});

	it('小红书短链 → xiaohongshu', () => {
		const p = detectPlatform('https://xhslink.com/abc');
		assert.strictEqual(p.id, 'xiaohongshu');
	});

	it('抖音 → douyin / video', () => {
		const p = detectPlatform('https://www.douyin.com/video/123456');
		assert.strictEqual(p.id, 'douyin');
		assert.strictEqual(p.type, 'video');
	});

	it('B站 → bilibili / video', () => {
		assert.strictEqual(detectPlatform('https://www.bilibili.com/video/BV1xx').id, 'bilibili');
		assert.strictEqual(detectPlatform('https://b23.tv/abc').id, 'bilibili');
	});

	it('YouTube → youtube / video', () => {
		assert.strictEqual(detectPlatform('https://www.youtube.com/watch?v=abc').id, 'youtube');
		assert.strictEqual(detectPlatform('https://youtu.be/abc').id, 'youtube');
	});

	it('微信公众号 → weixin / article', () => {
		const p = detectPlatform('https://mp.weixin.qq.com/s/abc');
		assert.strictEqual(p.id, 'weixin');
		assert.strictEqual(p.type, 'article');
	});

	it('知乎 → zhihu / article', () => {
		assert.strictEqual(detectPlatform('https://www.zhihu.com/question/123').id, 'zhihu');
	});

	it('微博 → weibo / mixed', () => {
		assert.strictEqual(detectPlatform('https://weibo.com/u/123').id, 'weibo');
		assert.strictEqual(detectPlatform('https://weibo.cn/abc').id, 'weibo');
	});

	it('掘金 → juejin', () => {
		assert.strictEqual(detectPlatform('https://juejin.cn/post/123').id, 'juejin');
	});

	it('CSDN → csdn', () => {
		assert.strictEqual(detectPlatform('https://blog.csdn.net/abc/article/123').id, 'csdn');
	});

	it('飞书 → feishu', () => {
		assert.strictEqual(detectPlatform('https://www.feishu.cn/docx/abc').id, 'feishu');
	});

	it('GitHub → generic（未知平台兜底）', () => {
		const p = detectPlatform('https://github.com/user/repo');
		assert.strictEqual(p.id, 'generic');
		assert.strictEqual(p.type, 'article');
	});

	it('无效 URL → generic 兜底不抛异常', () => {
		const p = detectPlatform('not a valid url at all !!!');
		assert.strictEqual(p.id, 'generic');
		assert.strictEqual(p.name, '网页');
	});

	it('空字符串 → generic', () => {
		assert.strictEqual(detectPlatform('').id, 'generic');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// parseMetaTags
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - parseMetaTags', () => {

	it('解析 OG 标准 meta → 返回所有字段', () => {
		const html = `<html><head>
<meta property="og:title" content="Test Title" />
<meta property="og:description" content="A test description" />
<meta property="og:image" content="https://example.com/cover.jpg" />
<meta property="og:site_name" content="Example Site" />
<meta property="article:published_time" content="2024-01-15" />
<meta property="article:author" content="John Doe" />
<meta property="article:tag" content="ai,ml" />
</head></html>`;
		const meta = parseMetaTags(html);
		assert.strictEqual(meta.title, 'Test Title');
		assert.strictEqual(meta.description, 'A test description');
		assert.strictEqual(meta.cover, 'https://example.com/cover.jpg');
		assert.strictEqual(meta.siteName, 'Example Site');
		assert.strictEqual(meta.date, '2024-01-15');
		assert.strictEqual(meta.author, 'John Doe');
		assert.deepStrictEqual(meta.tags, ['ai', 'ml']);
	});

	it('解析 Twitter Card meta', () => {
		const html = `<head><meta name="twitter:title" content="Tweet Title" />
<meta name="twitter:description" content="Tweet desc" />
<meta name="twitter:image" content="https://x.com/img.jpg" /></head>`;
		const meta = parseMetaTags(html);
		assert.strictEqual(meta.title, 'Tweet Title');
		assert.strictEqual(meta.description, 'Tweet desc');
		assert.strictEqual(meta.cover, 'https://x.com/img.jpg');
	});

	it('OG 优先级高于 Twitter Card（先匹配优先）', () => {
		const html = `<head>
<meta property="og:title" content="OG Title" />
<meta name="twitter:title" content="Tweet Title" /></head>`;
		assert.strictEqual(parseMetaTags(html).title, 'OG Title');
	});

	it('空 HTML → 全部字段 undefined', () => {
		const meta = parseMetaTags('');
		assert.strictEqual(meta.title, undefined);
		assert.strictEqual(meta.cover, undefined);
		assert.strictEqual(meta.tags, undefined);
	});

	it('无 meta 标签的 HTML → 全部字段 undefined', () => {
		assert.strictEqual(parseMetaTags('<html><body>hello</body></html>').title, undefined);
	});

	it('HTML 实体解码（&amp; → & 等）', () => {
		const html = `<head><meta property="og:title" content="A &amp; B &mdash; test" /></head>`;
		assert.strictEqual(parseMetaTags(html).title, 'A & B — test');
	});

	it('视频 duration 解析（秒数）', () => {
		const html = `<head><meta property="og:video:duration" content="3661" /></head>`;
		assert.strictEqual(parseMetaTags(html).durationSec, 3661);
	});

	it('非数字 duration → undefined', () => {
		const html = `<head><meta property="og:video:duration" content="unknown" /></head>`;
		assert.strictEqual(parseMetaTags(html).durationSec, undefined);
	});

	it('videoUrl 从 og:video 解析', () => {
		const html = `<head><meta property="og:video" content="https://video.example.com/v.mp4" /></head>`;
		assert.strictEqual(parseMetaTags(html).videoUrl, 'https://video.example.com/v.mp4');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// guessMediaExt
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - guessMediaExt', () => {

	it('URL 中有有效扩展 → 直接返回', () => {
		assert.strictEqual(guessMediaExt('https://cdn.example.com/video.mp4'), 'mp4');
		assert.strictEqual(guessMediaExt('https://example.com/image.PNG?w=200'), 'png');
	});

	it('URL 无扩展 → 从 MIME 推断', () => {
		assert.strictEqual(guessMediaExt('https://example.com/media', 'video/mp4'), 'mp4');
		assert.strictEqual(guessMediaExt('https://example.com/stream', 'image/jpeg'), 'jpg');
		assert.strictEqual(guessMediaExt('https://example.com/audio', 'audio/mpeg'), 'mp3');
	});

	it('URL 扩展为网页后缀 → 降级到 MIME（不返回 html）', () => {
		assert.strictEqual(guessMediaExt('https://example.com/page.html', 'image/png'), 'png');
	});

	it('URL 和 MIME 都无法推断 → bin', () => {
		assert.strictEqual(guessMediaExt('https://example.com/media'), 'bin');
	});

	it('查询参数和 hash 不影响扩展名提取', () => {
		assert.strictEqual(guessMediaExt('https://cdn.example.com/video.mp4?token=abc&t=123#t=60'), 'mp4');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isDownloadableMedia
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - isDownloadableMedia', () => {

	it('mp4 / webm / ogg → 可下载', () => {
		assert.strictEqual(isDownloadableMedia('https://example.com/video.mp4'), true);
		assert.strictEqual(isDownloadableMedia('https://example.com/video.webm'), true);
		assert.strictEqual(isDownloadableMedia('https://example.com/video.ogg'), true);
	});

	it('m3u8 → 不可下载（流）', () => {
		assert.strictEqual(isDownloadableMedia('https://example.com/playlist.m3u8'), false);
	});

	it('无扩展 → 依靠 MIME 判断', () => {
		assert.strictEqual(isDownloadableMedia('https://example.com/stream', 'video/mp4'), true);
		assert.strictEqual(isDownloadableMedia('https://example.com/stream', 'application/x-mpegURL'), false);
	});

	it('非视频 MIME → 不可下载', () => {
		assert.strictEqual(isDownloadableMedia('https://example.com/file.bin', 'image/png'), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// formatDuration
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - formatDuration', () => {

	it('0 秒 → undefined', () => {
		assert.strictEqual(formatDuration(0), undefined);
	});

	it('负数 → undefined', () => {
		assert.strictEqual(formatDuration(-10), undefined);
	});

	it('< 60 秒 → m:ss', () => {
		assert.strictEqual(formatDuration(5), '0:05');
		assert.strictEqual(formatDuration(59), '0:59');
	});

	it('60 秒 → 1:00', () => {
		assert.strictEqual(formatDuration(60), '1:00');
	});

	it('> 1h → h:mm:ss', () => {
		assert.strictEqual(formatDuration(3661), '1:01:01');
		assert.strictEqual(formatDuration(7322), '2:02:02'); // 2h2m2s
	});

	it('undefined → undefined', () => {
		assert.strictEqual(formatDuration(undefined), undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// findMarkdownImageUrls
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - findMarkdownImageUrls', () => {

	it('单个图片 → 提取 URL', () => {
		const md = 'hello ![alt text](https://cdn.example.com/img.jpg) world';
		const urls = findMarkdownImageUrls(md);
		assert.deepStrictEqual(urls, ['https://cdn.example.com/img.jpg']);
	});

	it('多个图片（含重复）→ 去重返回', () => {
		const md = `![a](https://cdn.example.com/a.png)
![b](https://cdn.example.com/b.png)
![also a](https://cdn.example.com/a.png)`;
		const urls = findMarkdownImageUrls(md);
		assert.deepStrictEqual(urls, ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png']);
	});

	it('无图片的 Markdown → 空数组', () => {
		assert.deepStrictEqual(findMarkdownImageUrls('# Hello\n\nNo images here.'), []);
	});

	it('只匹配远程 URL（http/https），本地路径忽略', () => {
		const md = '![local](./local.jpg) ![remote](https://cdn.example.com/img.jpg)';
		assert.deepStrictEqual(findMarkdownImageUrls(md), ['https://cdn.example.com/img.jpg']);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// rewriteMarkdownImageUrls
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - rewriteMarkdownImageUrls', () => {

	it('单个远程 URL → 本地路径改写', () => {
		const md = '![alt](https://cdn.example.com/img.jpg)';
		const map = new Map([['https://cdn.example.com/img.jpg', 'media/img_0.jpg']]);
		const out = rewriteMarkdownImageUrls(md, map);
		assert.strictEqual(out, '![alt](media/img_0.jpg)');
	});

	it('多个 URL 批量改写', () => {
		const md = '![a](https://cdn.example.com/a.png) ![b](https://cdn.example.com/b.png)';
		const map = new Map([
			['https://cdn.example.com/a.png', 'media/a_0.jpg'],
			['https://cdn.example.com/b.png', 'media/b_0.jpg'],
		]);
		const out = rewriteMarkdownImageUrls(md, map);
		assert.ok(out.includes('media/a_0.jpg'));
		assert.ok(out.includes('media/b_0.jpg'));
		assert.ok(!out.includes('cdn.example.com'));
	});

	it('未在 map 中的 URL 保持原样', () => {
		const md = '![alt](https://cdn.example.com/untracked.jpg)';
		const map = new Map([['https://other.com/img.jpg', 'media/x.jpg']]);
		assert.strictEqual(rewriteMarkdownImageUrls(md, map), md);
	});

	it('空 map → 原样返回', () => {
		const md = '![alt](https://cdn.example.com/img.jpg)';
		assert.strictEqual(rewriteMarkdownImageUrls(md, new Map()), md);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// composeArticleMarkdown
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - composeArticleMarkdown', () => {

	it('完整 meta + body → 含标题/作者/来源/封面/摘要/正文/标签', () => {
		const md = composeArticleMarkdown({
			url: 'https://example.com/article',
			platformName: '知乎',
			meta: {
				title: 'How to Test',
				author: 'Alice',
				siteName: '知乎',
				date: '2024-01-15',
				cover: 'https://example.com/cover.jpg',
				description: 'Testing guide',
				tags: ['test', 'guide'],
			},
			body: 'Lorem ipsum dolor sit amet.',
		});
		assert.ok(md.startsWith('# How to Test'));
		assert.ok(md.includes('作者：Alice'));
		assert.ok(md.includes('来源：知乎'));
		assert.ok(md.includes('发布：2024-01-15'));
		assert.ok(md.includes('平台：知乎'));
		assert.ok(md.includes('https://example.com/article'));
		assert.ok(md.includes('https://example.com/cover.jpg'));
		assert.ok(md.includes('**摘要**：Testing guide'));
		assert.ok(md.includes('Lorem ipsum dolor sit amet'));
		assert.ok(md.includes('test / guide'));
	});

	it('无 title → 以 URL 为标题', () => {
		const md = composeArticleMarkdown({
			url: 'https://no-title.com/post', platformName: '网页',
			meta: {}, body: 'content',
		});
		assert.ok(md.startsWith('# https://no-title.com/post'));
	});

	it('空 body 不出错（至少标题、原文链接存在）', () => {
		const md = composeArticleMarkdown({
			url: 'https://example.com/no-body', platformName: '网页',
			meta: { title: 'Just Title' }, body: '',
		});
		assert.ok(md.includes('# Just Title'));
		assert.ok(md.includes('https://example.com/no-body'));
	});

	it('连续多余空行被压缩（最多保留一个空行）', () => {
		const md = composeArticleMarkdown({
			url: 'https://x.com', platformName: 'X',
			meta: {}, body: 'a\n\n\n\n\nb',
		});
		const lines = md.split('\n');
		// 不应该有连续 2+ 空行
		for (let i = 1; i < lines.length; i++) {
			assert.ok(!(lines[i - 1] === '' && lines[i] === ''), '不应出现连续空行');
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// composeVideoMarkdown
// ═══════════════════════════════════════════════════════════════════════

describe('kbUrlScraper - composeVideoMarkdown', () => {

	it('视频已下载 → 含本地媒体引用', () => {
		const md = composeVideoMarkdown({
			url: 'https://www.bilibili.com/video/BV1xx',
			platformName: 'B站',
			meta: {
				title: 'Learn Rust',
				author: 'Rustacean',
				siteName: 'bilibili',
				durationSec: 600,
				description: 'A guide to Rust',
			},
			mediaLocalPath: 'media/learn_rust.mp4',
			downloaded: true,
		});
		assert.ok(md.startsWith('# Learn Rust'));
		assert.ok(md.includes('作者：Rustacean'));
		assert.ok(md.includes('平台：B站'));
		assert.ok(md.includes('时长：10:00'));
		assert.ok(md.includes('media/learn_rust.mp4'));
		assert.ok(md.includes('已抓取视频文件'));
		assert.ok(!md.includes('⚠️'));
	});

	it('视频未下载 → ⚠️ 提示', () => {
		const md = composeVideoMarkdown({
			url: 'https://www.douyin.com/video/123',
			platformName: '抖音',
			meta: { title: 'Viral Clip' },
			downloaded: false,
		});
		assert.ok(md.includes('⚠️ 未能直接下载视频文件'));
		assert.ok(md.includes('平台反爬'));
	});

	it('无 title → 以 URL 为标题', () => {
		const md = composeVideoMarkdown({
			url: 'https://no-title.com/video', platformName: 'B站',
			meta: {}, downloaded: false,
		});
		assert.ok(md.startsWith('# https://no-title.com/video'));
	});

	it('有封面图 → 显示封面 ![](cover)', () => {
		const md = composeVideoMarkdown({
			url: 'https://example.com/v', platformName: 'YouTube',
			meta: { title: 'Test', cover: 'https://img.youtube.com/vi/abc/maxresdefault.jpg' },
			downloaded: false,
		});
		assert.ok(md.includes('https://img.youtube.com/vi/abc/maxresdefault.jpg'));
	});
});
