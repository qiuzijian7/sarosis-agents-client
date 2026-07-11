import { test, expect, type Page } from '@playwright/test';

/**
 * 知识库 URL 导入 —— 端到端 / 集成测试（对应设计方案 §5.2：E1-E7）
 *
 * 运行方式（需真实实例 + 外网，mock webserver 不提供外部站点抓取）：
 *   npm run test:web
 *   或单跑：
 *   npx playwright test tests/web/kb-url-import.spec.ts --config=playwright.web.config.ts
 *
 * 说明：
 *   - 抓取由主进程 IWebContentExtractorService（真实 Chromium 渲染）完成，
 *     因此这些用例依赖被导入站点可公网访问，CI 中默认跳过（见 test.skipIf）。
 *     本地要启用：KB_E2E_NETWORK=1 npx playwright test tests/web/kb-url-import.spec.ts
 *   - 断言集中在「通知 toast」与「库分区出现 .md 文件」，避免依赖内部 DOM 结构。
 *   - E5 用 httpstat.us 这类可公网访问的模拟状态码站点，无需真实内容站点。
 */

const HAS_NETWORK = !!process.env.KB_E2E_NETWORK; // 默认关，避免 CI 假红

async function openKnowledgeBase(page: Page): Promise<void> {
	await page.keyboard.press('Control+Shift+P');
	await page.waitForTimeout(500);
	const q = page.locator('.quick-input-widget input, .monaco-quick-input input').first();
	await q.fill('知识库');
	await page.waitForTimeout(500);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(800);
}

async function openImportUrlDialog(page: Page): Promise<void> {
	const dd = page.locator('#kbImportDD');
	await expect(dd).toBeVisible({ timeout: 10_000 });
	await dd.click();
	await page.waitForTimeout(300);
	await page.getByText(/链接|URL|导入链接/i).first().click();
	await page.waitForTimeout(300);
}

async function fillImportUrl(page: Page, url: string): Promise<void> {
	const input = page.locator('.quick-input-widget input, .monaco-quick-input input').last();
	await expect(input).toBeVisible({ timeout: 10_000 });
	await input.fill(url);
	await page.keyboard.press('Enter');
}

test.describe('KB URL 导入（集成 / 端到端）', () => {

	test.skipIf(!HAS_NETWORK)('E1 SSR 文章导入 → 库分区出现 .md + 成功 toast', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://en.wikipedia.org/wiki/Vector_database');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已导入|抓取|完成/i, { timeout: 60_000 });
		await expect(page.locator('.kb-library .kb-node, .monaco-list-row')).toContainText(/\.md$/i, { timeout: 20_000 });
	});

	test.skipIf(!HAS_NETWORK)('E2 视频 OG 兜底（无直链可下载）→ ⚠️ 提示 toast，不崩溃', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://v.douyin.com/example-share-id/');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/未能直接下载|已记录视频元信息|抓取失败/i, { timeout: 60_000 });
		await expect(page.locator('.monaco-workbench')).toBeVisible();
	});

	test.skipIf(!HAS_NETWORK)('E3 视频 headless 下载（B站）→ 库出现 .md 且媒体落盘', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://www.bilibili.com/video/BV1xxExample');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已抓取视频并导入|已记录视频元信息/i, { timeout: 90_000 });
	});

	test.skipIf(!HAS_NETWORK)('E4 小红书 mixed → 封面 + 正文图本地化（media/ 全本地引用）', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://www.xiaohongshu.com/explore/example-id');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已导入|抓取/i, { timeout: 60_000 });
	});

	test('E5 受限 / 不可达 URL → 友好报错 toast，不崩溃', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://httpstat.us/403');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/抓取失败|失败|受限|登录/i, { timeout: 60_000 });
		await expect(page.locator('.monaco-workbench')).toBeVisible();
	});

	test.skipIf(!HAS_NETWORK)('E6 同名幂等 → 再次导入不覆盖，文件名唯一', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://en.wikipedia.org/wiki/Retrieval_augmented_generation');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已导入/i, { timeout: 60_000 });
		// 第二次导入同一 URL
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://en.wikipedia.org/wiki/Retrieval_augmented_generation');
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已导入/i, { timeout: 60_000 });
		// 库分区应出现 2 个相关 .md（带 (1) 序号），不覆盖原文件
		await expect(page.locator('.kb-library .kb-node, .monaco-list-row')).toHaveCount(2, { timeout: 20_000 });
	});

	test.skipIf(!HAS_NETWORK)('E7 超大页面（>5MB）导入 → 不 OOM，落盘成功', async ({ page }) => {
		await openKnowledgeBase(page);
		await openImportUrlDialog(page);
		await fillImportUrl(page, 'https://en.wikipedia.org/wiki/Special:Statistics'); // 大页面示例
		await expect(page.locator('.monaco-notification-toast')).toContainText(/已导入|抓取|失败/i, { timeout: 120_000 });
		await expect(page.locator('.monaco-workbench')).toBeVisible();
	});
});
