/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「Host 未运行」占位页的守卫（2026-10-20）。
 *
 * 两件事必须钉住：
 *   ① **纯逻辑**：生成的 `data:` 页面里有"谁不在 / 怎么恢复 / 不是插件报错"三句话，且路由做
 *      HTML 转义（`route` 是外部输入，未来可能来自配置）；
 *   ② **接线**：`dshViewHost._load` 在 `!conn` 时**不能**再静默 `return`（那是"整片纯白 +
 *      IDE 日志零痕迹"的病根），必须走 `_showHostUnavailable`；`setConnection` 的断线分支也不许
 *      各自复制一份 `about:blank`。electron-main 文件跑不了单测 ⇒ 用源码扫描钉住接线。
 *
 * 反向突变：把 `_load` 的 `!conn` 分支改回 `return`，第 ① 条接线断言必须变红。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { unavailablePageHtml, unavailablePageUrl } from '../../common/dshViewHostUnavailable.js';

suite('dshHarness / Host 未运行占位页', () => {

	test('页面说清三件事：谁不在、怎么恢复、不是插件报错', () => {
		const html = unavailablePageHtml({ route: '/x/memory/' });
		assert.ok(html.includes('dsh Host 没有在运行'), '必须点明是 Host 不在（别让人以为插件坏了）');
		assert.ok(html.includes('自动重新加载'), '必须说明会自愈，否则用户只会去重启 IDE');
		assert.ok(html.includes('不是插件页面报的错'), '必须澄清插件与数据都没问题');
		assert.ok(html.includes('/x/memory/'), '要带上路由，页面与日志能对上号');
	});

	test('标题可覆盖；空白标题回落默认（不出现空 h1）', () => {
		assert.ok(unavailablePageHtml({ title: '记忆库暂时不可用' }).includes('<h1>记忆库暂时不可用</h1>'));
		assert.ok(unavailablePageHtml({ title: '   ' }).includes('<h1>页面暂时不可用</h1>'));
	});

	test('★ 路由必须 HTML 转义（不拼未转义的外部字符串）', () => {
		const html = unavailablePageHtml({ route: '</code><script>alert(1)</script>' });
		assert.ok(!html.includes('<script>'), '不能出现原样标签');
		assert.ok(html.includes('&lt;script&gt;'), '应转义成实体');
	});

	test('data: URL 前缀固定、整段编码、可逆', () => {
		const url = unavailablePageUrl({ route: '/x/memory/' });
		const prefix = 'data:text/html;charset=utf-8,';
		assert.ok(url.startsWith(prefix), 'Electron 认这个前缀');
		const encoded = url.slice(prefix.length);
		assert.ok(!encoded.includes('<'), 'HTML 必须整段编码（否则 #/& 会被当成 URL 结构）');
		assert.strictEqual(decodeURIComponent(encoded), unavailablePageHtml({ route: '/x/memory/' }));
	});

	suite('dshViewHost 接线', () => {
		const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
		const REL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
		const source = (() => {
			const abs = join(REPO, REL);
			return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
		})();

		test('★ 接线守卫：_load 在没有连接时必须走占位（不许静默 return）', () => {
			assert.ok(source.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）——守卫不能空跑`);
			assert.ok(
				/if \(!conn\) \{\s*\n\s*this\._showHostUnavailable\(slot\);\s*\n\s*return;/.test(source),
				'_load 的 !conn 分支必须调 _showHostUnavailable 再 return（改回 return 就是退回"整片纯白"）',
			);
		});

		test('★ 接线守卫：插件页用占位页；非插件页仍 about:blank', () => {
			assert.ok(
				/if \(!slot\.pageSurface\) \{[\s\S]{0,200}about:blank/.test(source),
				'没有 pageSurface 的视图要保持 about:blank（聊天页有自己的看门狗与 REBIND 状态机）',
			);
			assert.ok(
				/unavailablePageUrl\(\{ route: slot\.route \}\)/.test(source),
				'插件页必须加载占位页 URL',
			);
		});

		test('setConnection 断线分支委托同一出口（不各复制一份 about:blank）', () => {
			assert.ok(
				!/else if \(!slot\.view\.webContents\.isDestroyed\(\)\) \{[\s\S]{0,240}about:blank/.test(source),
				'setConnection 的断线分支应调用 _showHostUnavailable',
			);
		});
	});
});
