/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	KNOWN_BACKEND_KINDS,
	WEB_PLATFORM_ROUTES,
	genericRoute,
	routeForUrl,
} from '../../common/webPlatformRoutes.js';
import { KB_URL_PLATFORMS, detectPlatform } from '../../browser/views/knowledgeBase/kbUrlScraper.js';

/**
 * 平台路由**真源**的守卫（2026-10-13，P1-1）。
 *
 * 钉四件事：
 * 1. **结构契约**：每条路由的 backends 非空且 kind 已登记；id 唯一；`generic` 必须恰好最后（兜底）；
 *    除兜底外**不许**有"全能匹配"正则（那会静默截胡它后面的所有平台）。
 * 2. **顺序即语义**：逐条写死"首选通道"期望表 —— 调换排序是**换了一条主路径**，必须红。
 * 3. **宿主与真源一致**：`KB_URL_PLATFORMS` / `detectPlatform` 由真源派生，行为必须逐字不变
 *    （把原先那份**孤儿** BDD 测试 `kbUrlScraper.test.ts` 的代表用例带过来 —— 它用 `describe/it`
 *    且不在任何 runner 的发现范围里，等于没有回归网）。
 * 4. **skill 对账**：`web-content-import/SKILL.md` 必须覆盖每个平台，且每个平台那行要写出它的**首选通道**；
 *    同时**不许**再出现已退役的 `browser_*` 工具名（它们已合并成单个 `browser` 工具的 `op`）。
 */

const REPO_ROOT = process.cwd();
const SKILL_PATH = 'resources/.agents/skills/web-content-import/SKILL.md';

/** 通道 kind → agent 侧真正的工具名（守卫自己维护：真源不该为"文案"反向依赖工具命名）。 */
const TOOL_NAME_OF_KIND: Record<string, string> = {
	'web-extract': 'web_extract',
	'browser': 'browser',
	'video-analyze': 'video_analyze',
	'ytdlp': 'yt-dlp',
	'vision-analyze': 'vision_analyze',
};

/**
 * 每个平台的**首选**通道 —— 逐条写死的期望表（不是从真源反推，否则等于没测）。
 * 新增平台若不补这张表，下面的"每条路由都必须在这张表里"会红。
 */
const EXPECTED_PRIMARY_BACKEND: Record<string, string> = {
	xiaohongshu: 'browser',
	douyin: 'video-analyze',
	tiktok: 'video-analyze',
	kuaishou: 'video-analyze',
	bilibili: 'video-analyze',
	youtube: 'video-analyze',
	weibo: 'video-analyze',
	weixin: 'web-extract',
	zhihu: 'web-extract',
	juejin: 'web-extract',
	csdn: 'web-extract',
	feishu: 'web-extract',
	generic: 'web-extract',
};

/** 已退役的 IDE 侧浏览器工具名（Host 侧合并成单个 `browser` 工具的 op）。 */
const RETIRED_BROWSER_TOOL_NAMES = [
	'browser_navigate', 'browser_snapshot', 'browser_click',
	'browser_type', 'browser_scroll', 'browser_back', 'browser_get_images',
];

suite('webPlatformRoutes — 多平台抓取路由真源', () => {

	test('★ 结构契约：backend kind 已登记 / id 唯一 / hostPatterns 非空 / 兜底恰好最后', () => {
		const ids = new Set<string>();
		for (const route of WEB_PLATFORM_ROUTES) {
			assert.ok(route.id.length > 0, 'id 不能为空');
			assert.ok(!ids.has(route.id), `id 重复：${route.id}`);
			ids.add(route.id);
			assert.ok(route.name.length > 0, `${route.id} 缺展示名`);
			assert.ok(route.hostPatterns.length > 0, `${route.id} 没有任何 hostPattern`);
			assert.ok(route.backends.length > 0, `${route.id} 的 backends 为空 ⇒ 模型不知道从哪条路开始`);
			assert.ok(Array.isArray(route.risks), `${route.id} 的 risks 必须是数组（没有坑就给空数组）`);
			for (const backend of route.backends) {
				assert.ok((KNOWN_BACKEND_KINDS as readonly string[]).includes(backend.kind),
					`${route.id} 用了未登记的 backend kind：${backend.kind}（要么登记，要么别写）`);
				assert.ok(backend.note.length > 0, `${route.id}.${backend.kind} 缺 note（模型需要知道为什么选它）`);
			}
			// 同一平台内不许重复同一个通道（重复 = 有人复制粘贴时忘了改）
			const kinds = route.backends.map(b => b.kind);
			assert.strictEqual(new Set(kinds).size, kinds.length, `${route.id} 的 backends 出现重复 kind：${kinds.join(',')}`);
		}

		const last = WEB_PLATFORM_ROUTES[WEB_PLATFORM_ROUTES.length - 1];
		assert.strictEqual(last.id, 'generic', '兜底必须**恰好**最后 —— 挪到前面会让所有站点静默降级成 HTTP 抓取');
		assert.strictEqual(genericRoute(), last, 'genericRoute() 必须就是最后那条');
		assert.strictEqual(WEB_PLATFORM_ROUTES.filter(r => r.id === 'generic').length, 1, 'generic 只允许一条');
	});

	test('★★ 除兜底外不许有"全能匹配"正则 —— 否则它后面的平台全被静默截胡', () => {
		const unrelatedHost = 'example.invalid';
		for (const route of WEB_PLATFORM_ROUTES) {
			if (route.id === 'generic') { continue; }
			for (const rx of route.hostPatterns) {
				assert.ok(!rx.test(unrelatedHost),
					`${route.id} 的正则 ${String(rx)} 命中了无关主机名 ⇒ 顺序即优先级，它会截胡后面所有平台`);
			}
		}
	});

	test('★★ 顺序即语义：每个平台的首选通道（逐条写死）+ 期望表不许腐烂', () => {
		for (const route of WEB_PLATFORM_ROUTES) {
			const expected = EXPECTED_PRIMARY_BACKEND[route.id];
			assert.ok(expected !== undefined,
				`${route.id} 不在期望表里 —— 新增平台必须同时更新这张表（否则"顺序"没人守）`);
			assert.strictEqual(route.backends[0].kind, expected,
				`${route.id} 的首选通道被改成了 ${route.backends[0].kind}（期望 ${expected}）—— 调换排序 = 换了一条主路径`);
		}
		for (const id of Object.keys(EXPECTED_PRIMARY_BACKEND)) {
			assert.ok(WEB_PLATFORM_ROUTES.some(r => r.id === id),
				`期望表里的 ${id} 已不在真源里 ⇒ 表腐烂了（删平台要一起删）`);
		}
	});

	test('★ 登录态标注：小红书 / 知乎必须标 needsLogin（游客态拿到的是占位页），其余视频站不必', () => {
		const byId = new Map(WEB_PLATFORM_ROUTES.map(r => [r.id, r]));
		assert.strictEqual(byId.get('xiaohongshu')?.needsLogin, true, '小红书游客态只给占位页，必须标 needsLogin');
		assert.strictEqual(byId.get('zhihu')?.needsLogin, true, '知乎问答页常要求登录');
		for (const id of ['douyin', 'bilibili', 'youtube', 'weixin']) {
			assert.strictEqual(byId.get(id)?.needsLogin, false, `${id} 正常抓取不需要登录态，标 true 会误导模型先去要登录`);
		}
	});

	test('★★ 宿主派生一致：KB_URL_PLATFORMS 逐条等于真源（不许再出现"宿主自己一份表"）', () => {
		assert.strictEqual(KB_URL_PLATFORMS.length, WEB_PLATFORM_ROUTES.length, '两边条数不一致 ⇒ 有一边在自己维护');
		for (let i = 0; i < WEB_PLATFORM_ROUTES.length; i++) {
			const route = WEB_PLATFORM_ROUTES[i];
			const def = KB_URL_PLATFORMS[i];
			assert.strictEqual(def.id, route.id, `第 ${i} 条 id 不一致`);
			assert.strictEqual(def.name, route.name, `${route.id} 展示名不一致`);
			assert.strictEqual(def.type, route.type, `${route.id} 内容类型不一致`);
			assert.deepStrictEqual(def.hostPatterns, [...route.hostPatterns], `${route.id} 的 hostPatterns 不一致`);
		}
	});

	test('★ 宿主行为回归（带自原孤儿测试 `kbUrlScraper.test.ts` 的代表用例）', () => {
		const cases: Array<[string, string, string]> = [
			['https://www.xiaohongshu.com/explore/abc123', 'xiaohongshu', 'mixed'],
			['https://xhslink.com/abc', 'xiaohongshu', 'mixed'],
			['https://www.douyin.com/video/123456', 'douyin', 'video'],
			['https://www.bilibili.com/video/BV1xx', 'bilibili', 'video'],
			['https://b23.tv/abc', 'bilibili', 'video'],
			['https://www.youtube.com/watch?v=abc', 'youtube', 'video'],
			['https://youtu.be/abc', 'youtube', 'video'],
			['https://mp.weixin.qq.com/s/abc', 'weixin', 'article'],
			['https://www.zhihu.com/question/123', 'zhihu', 'article'],
			['https://weibo.com/u/123', 'weibo', 'mixed'],
			['https://weibo.cn/abc', 'weibo', 'mixed'],
			['https://juejin.cn/post/123', 'juejin', 'article'],
			['https://blog.csdn.net/abc/article/123', 'csdn', 'article'],
			['https://www.feishu.cn/docx/abc', 'feishu', 'article'],
			['https://github.com/user/repo', 'generic', 'article'],
			['not a valid url at all !!!', 'generic', 'article'],
			['', 'generic', 'article'],
		];
		for (const [url, id, type] of cases) {
			const def = detectPlatform(url);
			assert.strictEqual(def.id, id, `detectPlatform(${JSON.stringify(url)}) 期望 ${id}，实际 ${def.id}`);
			assert.strictEqual(def.type, type, `${url} 的类型期望 ${type}，实际 ${def.type}`);
		}
		assert.strictEqual(detectPlatform('https://github.com/user/repo').name, '网页', '兜底的展示名');
		assert.strictEqual(routeForUrl('https://www.zhihu.com/question/1').id, 'zhihu');
		assert.strictEqual(routeForUrl('').id, 'generic', '空串必须落到兜底而不是抛错');
	});

	test('★★ skill 对账：每个平台在 SKILL.md 里都有一行，且该行写出了它的**首选通道**', () => {
		const skillPath = path.join(REPO_ROOT, SKILL_PATH);
		assert.ok(fs.existsSync(skillPath), `读不到技能文件：${SKILL_PATH}`);
		const lines = fs.readFileSync(skillPath, 'utf8').split(/\r?\n/);

		const tableLines = lines.filter(line => line.startsWith('|'));
		assert.ok(tableLines.length >= 5, `SKILL.md 的平台表格看起来被删了（只有 ${tableLines.length} 行以 | 开头）`);

		const platforms = WEB_PLATFORM_ROUTES.filter(r => r.id !== 'generic');
		let matched = 0;
		for (const route of platforms) {
			// 平台行 = 含平台展示名的那一行（`| 小红书 ... |`）
			const row = tableLines.find(line => line.includes(route.name));
			if (!row) { continue; }   // 下面统一报缺哪些，避免一条断言报一堆
			matched++;
			const primaryTool = TOOL_NAME_OF_KIND[route.backends[0].kind];
			assert.ok(primaryTool !== undefined, `${route.id} 的首选 kind ${route.backends[0].kind} 没有工具名映射`);
			assert.ok(row.includes(primaryTool),
				`SKILL.md 里「${route.name}」那一行没写出首选通道 ${primaryTool}（那行是：${row.slice(0, 120)}）`);
		}
		const missing = platforms.filter(r => !tableLines.some(line => line.includes(r.name))).map(r => `${r.id}(${r.name})`);
		assert.strictEqual(matched, platforms.length,
			`SKILL.md 缺少这些平台的行：${missing.join(', ')} —— 新增平台必须同时更新技能表格`);
	});

	test('★★ SKILL.md 不许再出现已退役的 `browser_*` 工具名（它们已合并成单个 `browser` 的 op）', () => {
		const skill = fs.readFileSync(path.join(REPO_ROOT, SKILL_PATH), 'utf8');
		for (const retired of RETIRED_BROWSER_TOOL_NAMES) {
			assert.ok(!skill.includes(retired),
				`SKILL.md 仍在教模型调用 ${retired} —— 那个工具已退役（Host 侧只剩单个 browser 工具，用 op 参数）`);
		}
		// 反向保护：不能靠"把浏览器那段整段删掉"来过这条
		assert.ok(skill.includes('browser'), 'SKILL.md 必须仍然讲浏览器通道');
		assert.ok(skill.includes('op:'), 'SKILL.md 必须写出 browser 的 op 用法（否则模型不知道该怎么调）');
	});
});
