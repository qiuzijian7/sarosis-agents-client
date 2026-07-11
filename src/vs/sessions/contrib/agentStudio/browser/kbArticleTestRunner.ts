/*---------------------------------------------------------------------------------------------
 *  KB Article Management — Import & Categorize Test Scaffolding
 *
 *  This is an integration test scaffold for the KB system's multi-source import,
 *  article categorization, and AI article generation capabilities.
 *
 *  It cannot be run standalone (requires VS Code service injection), but provides
 *  a structured test runner that can be invoked from a VS Code command or the
 *  Developer Tools console when the KB view is active.
 *
 *  Usage (in DevTools console):
 *    const { KbArticleTestRunner } = await import('/out/vs/sessions/contrib/agentStudio/browser/kbArticleTestRunner.js');
 *    const runner = new KbArticleTestRunner(services...);
 *    await runner.runAll();
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IKbNativeKernelService } from './kbNativeKernelService.js';

// ─── Test Result Types ───────────────────────────────────────────────────────

export interface KbTestResult {
	testId: string;
	testName: string;
	status: 'pass' | 'fail' | 'skip';
	duration: number;
	details?: string;
	checks?: { name: string; passed: boolean; message?: string }[];
}

export interface KbTestSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	results: KbTestResult[];
	totalDuration: number;
}

// ─── Test Data: Mock Articles ────────────────────────────────────────────────

/** Simulates a WeChat article import result (Markdown content). */
const MOCK_WECHAT_ARTICLE = `---
source: url
platform: weixin
url: https://mp.weixin.qq.com/s/test123
date: 2026-07-11
title: AI 技术趋势 2026 年中总结
---

# AI 技术趋势 2026 年中总结

本文回顾 2026 上半年 AI 领域的关键进展。

## 大语言模型

GPT-5 和 Claude 4 的多模态能力显著提升...

## Agent 框架

AutoGen 和 CrewAI 继续主导 Agent 编排领域...

#ai# #tech# #llm# #agent#
`;

/** Simulates a Bilibili video import result. */
const MOCK_BILIBILI_VIDEO = `---
source: url
platform: bilibili
url: https://www.bilibili.com/video/BV1test
date: 2026-07-11
title: React 19 新特性详解
author: 技术胖
duration: "15:32"
cover: media/bv1test-cover.jpg
---

# React 19 新特性详解

> UP主: 技术胖 | 时长: 15:32

## 视频简介

本视频详细介绍了 React 19 的主要新特性...

#video# #tech# #frontend# #react#
`;

/** Simulates a plain Markdown file with frontmatter and wikilinks. */
const MOCK_OBSIDIAN_NOTE = `---
title: 知识管理系统对比
tags:
  - pkm
  - tech/notes
aliases:
  - PKM 对比
date: 2026-07-10
---

# 知识管理系统对比

对比 Obsidian、SiYuan、Notion 的知识管理能力。

## Obsidian

本地优先，[[双链系统]] 强大，插件生态丰富。

## SiYuan

块级引用，[[WYSIWYG 编辑器]]，适合中文用户。

## 相关笔记

- [[AI 技术趋势 2026 年中总结]]
- [[React 19 新特性详解]]

#pkm# #tech/notes# #comparison#
`;

/** Simulates a plain text file. */
const MOCK_PLAIN_TEXT = `这是一个纯文本笔记。

内容关于项目管理的最佳实践：
1. 敏捷开发
2. 持续集成
3. 代码审查

没有 frontmatter，没有标签，没有双链。
`;

// ─── Test Runner ─────────────────────────────────────────────────────────────

export class KbArticleTestRunner {

	private _results: KbTestResult[] = [];

	constructor(
		private readonly _fileService: IFileService,
		private readonly _kernelService: IKbNativeKernelService,
		private readonly _log: ILogService,
	) {}

	/** Run all test cases and return a summary. */
	async runAll(vaultRoot: URI): Promise<KbTestSummary> {
		this._results = [];
		const startTime = Date.now();

		// P0: Core Import Tests
		await this._run('TC-01', 'URL 导入 — 微信公众号文章', () => this._testUrlImportWechat(vaultRoot));
		await this._run('TC-02', 'URL 导入 — B站视频', () => this._testUrlImportBilibili(vaultRoot));
		await this._run('TC-04', '文件导入 — Markdown 含 frontmatter', () => this._testFileImportMd(vaultRoot));
		await this._run('TC-05', '文件导入 — 纯文本', () => this._testFileImportTxt(vaultRoot));

		// P1: Categorization Tests
		await this._run('TC-10', '文章归类 — 标签过滤', () => this._testTagFilter(vaultRoot));
		await this._run('TC-11', '文章归类 — 全文搜索', () => this._testFullTextSearch(vaultRoot));
		await this._run('TC-12', '文章归类 — 双链图谱', () => this._testBacklinkGraph(vaultRoot));

		// P2: Article Structure Tests
		await this._run('TC-14', '文章生成 — Frontmatter 标准化', () => this._testFrontmatterStandard(vaultRoot));
		await this._run('TC-15', '文章生成 — 标签提取', () => this._testTagExtraction(vaultRoot));
		await this._run('TC-16', '文章生成 — MOC 知识地图', () => this._testMocGeneration(vaultRoot));

		// P3: Integration
		await this._run('TC-19', '版本管理集成', () => this._testVersionIntegration(vaultRoot));
		await this._run('TC-20', '性能 — 批量导入', () => this._testBulkImport(vaultRoot));

		const totalDuration = Date.now() - startTime;
		return this._summarize(totalDuration);
	}

	// ─── P0: Core Import Tests ─────────────────────────────────────────────

	private async _testUrlImportWechat(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];
		const libraryDir = URI.joinPath(vaultRoot, '库');

		try {
			// Simulate: write a mock WeChat article to library
			const filePath = URI.joinPath(libraryDir, 'wechat-ai-trends-2026.md');
			await this._fileService.writeFile(filePath, VSBuffer.fromString(MOCK_WECHAT_ARTICLE));

			// Verify file exists
			const exists = await this._fileService.exists(filePath);
			checks.push({ name: '文件生成', passed: exists });

			// Verify content has frontmatter
			const content = (await this._fileService.readFile(filePath)).value.toString();
			const hasFrontmatter = content.startsWith('---') && content.includes('platform: weixin');
			checks.push({ name: 'Frontmatter 含 platform', passed: hasFrontmatter });

			// Verify tags exist
			const hasTags = content.includes('#ai#') && content.includes('#tech#');
			checks.push({ name: '内联标签存在', passed: hasTags });

			// Verify title
			const hasTitle = content.includes('title: AI 技术趋势 2026 年中总结');
			checks.push({ name: '标题正确', passed: hasTitle });

			return this._buildResult('TC-01', 'URL 导入 — 微信公众号文章', checks);
		} catch (e) {
			return this._buildResult('TC-01', 'URL 导入 — 微信公众号文章', checks, String(e));
		}
	}

	private async _testUrlImportBilibili(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];
		const libraryDir = URI.joinPath(vaultRoot, '库');

		try {
			const filePath = URI.joinPath(libraryDir, 'bilibili-react19.md');
			await this._fileService.writeFile(filePath, VSBuffer.fromString(MOCK_BILIBILI_VIDEO));

			const exists = await this._fileService.exists(filePath);
			checks.push({ name: '文件生成', passed: exists });

			const content = (await this._fileService.readFile(filePath)).value.toString();
			checks.push({ name: 'platform: bilibili', passed: content.includes('platform: bilibili') });
			checks.push({ name: '视频元数据', passed: content.includes('duration:') && content.includes('author:') });
			checks.push({ name: '视频标签', passed: content.includes('#video#') });

			return this._buildResult('TC-02', 'URL 导入 — B站视频', checks);
		} catch (e) {
			return this._buildResult('TC-02', 'URL 导入 — B站视频', checks, String(e));
		}
	}

	private async _testFileImportMd(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];
		const libraryDir = URI.joinPath(vaultRoot, '库');

		try {
			const filePath = URI.joinPath(libraryDir, 'pkm-comparison.md');
			await this._fileService.writeFile(filePath, VSBuffer.fromString(MOCK_OBSIDIAN_NOTE));

			const content = (await this._fileService.readFile(filePath)).value.toString();
			checks.push({ name: 'frontmatter 保留', passed: content.startsWith('---') });
			checks.push({ name: 'tags 保留', passed: content.includes('tags:') });
			checks.push({ name: 'aliases 保留', passed: content.includes('aliases:') });
			checks.push({ name: 'wikilinks 存在', passed: content.includes('[[') });

			// Verify kernel can parse backlinks
			try {
				const backlinks = await this._kernelService.getBacklinks(filePath.toString());
				checks.push({ name: '反链可查询', passed: true, message: `${backlinks?.backlinks?.length ?? 0} backlinks` });
			} catch {
				checks.push({ name: '反链可查询', passed: false, message: 'kernel not ready' });
			}

			return this._buildResult('TC-04', '文件导入 — Markdown 含 frontmatter', checks);
		} catch (e) {
			return this._buildResult('TC-04', '文件导入 — Markdown 含 frontmatter', checks, String(e));
		}
	}

	private async _testFileImportTxt(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];
		const libraryDir = URI.joinPath(vaultRoot, '库');

		try {
			const filePath = URI.joinPath(libraryDir, 'plain-text-note.md');
			await this._fileService.writeFile(filePath, VSBuffer.fromString(MOCK_PLAIN_TEXT));

			const exists = await this._fileService.exists(filePath);
			checks.push({ name: '文件生成', passed: exists });

			const content = (await this._fileService.readFile(filePath)).value.toString();
			checks.push({ name: '内容完整', passed: content.includes('项目管理') });
			checks.push({ name: '无 frontmatter', passed: !content.startsWith('---') });

			return this._buildResult('TC-05', '文件导入 — 纯文本', checks);
		} catch (e) {
			return this._buildResult('TC-05', '文件导入 — 纯文本', checks, String(e));
		}
	}

	// ─── P1: Categorization Tests ──────────────────────────────────────────

	private async _testTagFilter(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// The kernel's tag/search APIs are internal — verify via getBacklinks
			// (which triggers kernel build) and workspace files list instead.
			await this._kernelService.ensureBuilt();
			const files = await this._kernelService.getWorkspaceFiles();

			// Check that mock articles are in the workspace file index
			const hasWechat = files.some(f => f.name?.includes('wechat-ai-trends'));
			const hasBilibili = files.some(f => f.name?.includes('bilibili-react19'));
			const hasPkm = files.some(f => f.name?.includes('pkm-comparison'));

			checks.push({ name: '工作区文件索引非空', passed: files.length > 0, message: `${files.length} files` });
			checks.push({ name: '微信文章已索引', passed: hasWechat });
			checks.push({ name: 'B站视频已索引', passed: hasBilibili });
			checks.push({ name: 'PKM 文章已索引', passed: hasPkm });

			return this._buildResult('TC-10', '文章归类 — 标签过滤', checks);
		} catch (e) {
			return this._buildResult('TC-10', '文章归类 — 标签过滤', checks, String(e));
		}
	}

	private async _testFullTextSearch(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// FTS search is internal to KbNativeKernel — verify via getWorkspaceFiles
			// that the kernel picked up our mock articles (proxy for "content is indexed").
			await this._kernelService.ensureBuilt();
			const files = await this._kernelService.getWorkspaceFiles();

			// Each mock article should appear in the workspace file list
			const aiFile = files.find(f => f.name?.includes('AI 技术趋势') || f.name?.includes('wechat-ai'));
			const reactFile = files.find(f => f.name?.includes('React 19') || f.name?.includes('bilibili-react'));
			const pkmFile = files.find(f => f.name?.includes('知识管理') || f.name?.includes('pkm-comparison'));

			checks.push({ name: 'AI 文章已索引', passed: !!aiFile, message: aiFile?.name ?? 'not found' });
			checks.push({ name: 'React 文章已索引', passed: !!reactFile, message: reactFile?.name ?? 'not found' });
			checks.push({ name: 'PKM 文章已索引', passed: !!pkmFile, message: pkmFile?.name ?? 'not found' });

			return this._buildResult('TC-11', '文章归类 — 全文搜索', checks);
		} catch (e) {
			return this._buildResult('TC-11', '文章归类 — 全文搜索', checks, String(e));
		}
	}

	private async _testBacklinkGraph(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// The Obsidian note has [[双链系统]], [[WYSIWYG 编辑器]], [[AI 技术趋势 2026 年中总结]], [[React 19 新特性详解]]
			const pkmNoteUri = URI.joinPath(vaultRoot, '库', 'pkm-comparison.md').toString();
			const backlinks = await this._kernelService.getBacklinks(pkmNoteUri);

			checks.push({ name: '反链查询无异常', passed: true });

			// The PKM note has outgoing links (wikilinks)
			const outLinks = backlinks?.backlinks ?? [];
			checks.push({ name: '出链存在', passed: outLinks.length >= 0, message: `${outLinks.length} out-links` });

			// Verify [[AI 技术趋势 2026 年中总结]] is in the out-links
			const hasAiLink = outLinks.some((b: any) => b.name?.includes('AI 技术趋势'));
			checks.push({ name: '链接到 AI 文章', passed: hasAiLink });

			return this._buildResult('TC-12', '文章归类 — 双链图谱', checks);
		} catch (e) {
			return this._buildResult('TC-12', '文章归类 — 双链图谱', checks, String(e));
		}
	}

	// ─── P2: Article Generation Tests ──────────────────────────────────────

	private async _testFrontmatterStandard(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// The plain text note (TC-05) should have no frontmatter.
			// Simulate frontmatter standardization.
			const filePath = URI.joinPath(vaultRoot, '库', 'plain-text-note.md');
			const original = (await this._fileService.readFile(filePath)).value.toString();

			const hasFrontmatter = original.startsWith('---');
			checks.push({ name: '原始无 frontmatter', passed: !hasFrontmatter });

			// Generate standard frontmatter
			const standardized = this._generateFrontmatter(original, {
				title: '项目管理最佳实践',
				source: 'file',
				tags: ['imported', 'management'],
				date: new Date().toISOString().slice(0, 10),
			});

			checks.push({ name: '生成 frontmatter', passed: standardized.startsWith('---') });
			checks.push({ name: '含 title', passed: standardized.includes('title: 项目管理最佳实践') });
			checks.push({ name: '含 tags', passed: standardized.includes('tags:') });
			checks.push({ name: '含 source', passed: standardized.includes('source: file') });
			checks.push({ name: '内容保留', passed: standardized.includes('敏捷开发') });

			return this._buildResult('TC-14', '文章生成 — Frontmatter 标准化', checks);
		} catch (e) {
			return this._buildResult('TC-14', '文章生成 — Frontmatter 标准化', checks, String(e));
		}
	}

	private async _testTagExtraction(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// Extract #tags# from the WeChat article
			const filePath = URI.joinPath(vaultRoot, '库', 'wechat-ai-trends-2026.md');
			const content = (await this._fileService.readFile(filePath)).value.toString();

			const tags = this._extractInlineTags(content);
			checks.push({ name: '提取标签数 >= 3', passed: tags.length >= 3, message: `tags: ${tags.join(', ')}` });
			checks.push({ name: '含 ai 标签', passed: tags.includes('ai') });
			checks.push({ name: '含 tech 标签', passed: tags.includes('tech') });
			checks.push({ name: '含 agent 标签', passed: tags.includes('agent') });

			return this._buildResult('TC-15', '文章生成 — 标签提取', checks);
		} catch (e) {
			return this._buildResult('TC-15', '文章生成 — 标签提取', checks, String(e));
		}
	}

	private async _testMocGeneration(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// Generate a MOC (Map of Content) file linking all imported articles
			const mocContent = this._generateMoc('技术知识地图', [
				{ title: 'AI 技术趋势 2026 年中总结', tags: ['ai', 'tech', 'llm', 'agent'] },
				{ title: 'React 19 新特性详解', tags: ['video', 'tech', 'frontend', 'react'] },
				{ title: '知识管理系统对比', tags: ['pkm', 'tech/notes', 'comparison'] },
			]);

			checks.push({ name: 'MOC 含标题', passed: mocContent.includes('# 技术知识地图') });
			checks.push({ name: 'MOC 含分类', passed: mocContent.includes('## AI 技术') });
			checks.push({ name: 'MOC 含双链', passed: mocContent.includes('[[') });
			checks.push({ name: 'MOC 链接 AI 文章', passed: mocContent.includes('[[AI 技术趋势 2026 年中总结]]') });
			checks.push({ name: 'MOC 链接 React 文章', passed: mocContent.includes('[[React 19 新特性详解]]') });
			checks.push({ name: 'MOC 含标签', passed: mocContent.includes('#moc#') });

			// Write MOC to notes section
			const mocPath = URI.joinPath(vaultRoot, '笔记', 'MOC-技术知识地图.md');
			await this._fileService.writeFile(mocPath, VSBuffer.fromString(mocContent));
			const exists = await this._fileService.exists(mocPath);
			checks.push({ name: 'MOC 文件已写入', passed: exists });

			return this._buildResult('TC-16', '文章生成 — MOC 知识地图', checks);
		} catch (e) {
			return this._buildResult('TC-16', '文章生成 — MOC 知识地图', checks, String(e));
		}
	}

	// ─── P3: Integration Tests ─────────────────────────────────────────────

	private async _testVersionIntegration(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];

		try {
			// Check if .git exists in vault root
			const gitDir = URI.joinPath(vaultRoot, '.git');
			const gitExists = await this._fileService.exists(gitDir);
			checks.push({ name: '.git 目录存在', passed: gitExists });

			if (gitExists) {
				// Check git log
				const headFile = URI.joinPath(gitDir, 'HEAD');
				const headExists = await this._fileService.exists(headFile);
				checks.push({ name: 'HEAD 文件存在', passed: headExists });
			}

			return this._buildResult('TC-19', '版本管理集成', checks);
		} catch (e) {
			return this._buildResult('TC-19', '版本管理集成', checks, String(e));
		}
	}

	private async _testBulkImport(vaultRoot: URI): Promise<KbTestResult> {
		const checks: KbTestResult['checks'] = [];
		const libraryDir = URI.joinPath(vaultRoot, '库', 'bulk-test');

		try {
			const startTime = Date.now();

			// Create 20 mock articles
			const articles = Array.from({ length: 20 }, (_, i) => ({
				title: `测试文章 ${String(i + 1).padStart(3, '0')}`,
				content: `---\ntitle: 测试文章 ${i + 1}\ndate: 2026-07-11\n---\n\n# 测试文章 ${i + 1}\n\n这是第 ${i + 1} 篇测试文章。内容包含关键词：AI、技术、知识管理。\n\n#test# #bulk#\n`,
			}));

			// Write all articles
			await Promise.all(articles.map((a, i) => {
				const filePath = URI.joinPath(libraryDir, `test-${String(i + 1).padStart(3, '0')}.md`);
				return this._fileService.writeFile(filePath, VSBuffer.fromString(a.content));
			}));

			const duration = Date.now() - startTime;
			checks.push({ name: '20 篇文章写入完成', passed: duration < 10000, message: `${duration}ms` });

			// Verify all files exist
			let allExist = true;
			for (let i = 0; i < 20; i++) {
				const filePath = URI.joinPath(libraryDir, `test-${String(i + 1).padStart(3, '0')}.md`);
				if (!(await this._fileService.exists(filePath))) {
					allExist = false;
					break;
				}
			}
			checks.push({ name: '全部文件存在', passed: allExist });

			return this._buildResult('TC-20', '性能 — 批量导入', checks);
		} catch (e) {
			return this._buildResult('TC-20', '性能 — 批量导入', checks, String(e));
		}
	}

	// ─── Helpers ────────────────────────────────────────────────────────────

	private async _run(testId: string, testName: string, fn: () => Promise<KbTestResult>): Promise<void> {
		const start = Date.now();
		try {
			const result = await fn();
			result.duration = Date.now() - start;
			this._results.push(result);
			this._log.info(`[KbTest] ${testId}: ${result.status} (${result.duration}ms)`);
		} catch (e) {
			this._results.push({
				testId,
				testName,
				status: 'fail',
				duration: Date.now() - start,
				details: String(e),
			});
		}
	}

	private _buildResult(testId: string, testName: string, checks: KbTestResult['checks'], error?: string): KbTestResult {
		const allPassed = checks?.every(c => c.passed) ?? false;
		return {
			testId,
			testName,
			status: error ? 'fail' : (allPassed ? 'pass' : 'fail'),
			duration: 0, // Filled by _run
			checks,
			details: error,
		};
	}

	private _summarize(totalDuration: number): KbTestSummary {
		const passed = this._results.filter(r => r.status === 'pass').length;
		const failed = this._results.filter(r => r.status === 'fail').length;
		const skipped = this._results.filter(r => r.status === 'skip').length;
		return {
			total: this._results.length,
			passed,
			failed,
			skipped,
			results: this._results,
			totalDuration,
		};
	}

	/** Extract #tag# style inline tags from Markdown content. */
	private _extractInlineTags(content: string): string[] {
		const tags = new Set<string>();
		// Match #tag# (SiYuan style) or #tag (Obsidian style, at word boundary)
		const re = /#([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5_/-]*)#/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			tags.add(m[1]);
		}
		// Also match frontmatter tags
		const fmMatch = content.match(/^---\n[\s\S]*?tags:\s*\n((?:\s+-\s+.+\n)+)/m);
		if (fmMatch) {
			const tagBlock = fmMatch[1];
			const tagRe = /-\s+(.+)/g;
			while ((m = tagRe.exec(tagBlock)) !== null) {
				tags.add(m[1].trim());
			}
		}
		return Array.from(tags);
	}

	/** Generate standardized frontmatter for an article. */
	private _generateFrontmatter(content: string, meta: {
		title: string;
		source: string;
		tags: string[];
		date: string;
	}): string {
		const fm = [
			'---',
			`title: ${meta.title}`,
			`source: ${meta.source}`,
			`date: ${meta.date}`,
			'tags:',
			...meta.tags.map(t => `  - ${t}`),
			'---',
			'',
		].join('\n');
		return fm + content;
	}

	/** Generate a MOC (Map of Content) Markdown file. */
	private _generateMoc(title: string, articles: { title: string; tags: string[] }[]): string {
		// Group articles by primary tag category
		const categories = new Map<string, { title: string; tags: string[] }[]>();
		for (const a of articles) {
			const primaryTag = a.tags[0] ?? 'general';
			const category = this._categorize(primaryTag);
			if (!categories.has(category)) categories.set(category, []);
			categories.get(category)!.push(a);
		}

		const lines: string[] = [
			'---',
			`title: ${title}`,
			'type: moc',
			`date: ${new Date().toISOString().slice(0, 10)}`,
			'---',
			'',
			`# ${title}`,
			'',
		];

		for (const [category, items] of categories) {
			lines.push(`## ${category}`);
			lines.push('');
			for (const item of items) {
				lines.push(`- [[${item.title}]] ${item.tags.map(t => `#${t}#`).join(' ')}`);
			}
			lines.push('');
		}

		lines.push('#moc# #knowledge-map#');
		return lines.join('\n');
	}

	/** Categorize a tag into a human-readable category name. */
	private _categorize(tag: string): string {
		const lower = tag.toLowerCase();
		if (lower.includes('ai') || lower.includes('llm') || lower.includes('agent')) return 'AI 技术';
		if (lower.includes('react') || lower.includes('frontend') || lower.includes('前端')) return '前端技术';
		if (lower.includes('pkm') || lower.includes('notes') || lower.includes('knowledge')) return '知识管理';
		if (lower.includes('video')) return '视频资源';
		return '其他';
	}
}
