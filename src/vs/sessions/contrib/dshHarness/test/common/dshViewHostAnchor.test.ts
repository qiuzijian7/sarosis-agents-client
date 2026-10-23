/*---------------------------------------------------------------------------------------------
 *  「dsh 视图必须停在客户端根路径」+「看门狗不许把工作台面板判成白屏」的守卫（2026-10-23）。
 *
 *  真机日志（`logs/20261023T102655/main.log`）定案的链路：
 *    桌面视图（surface=chat）的**主 frame** 被同源导航到了 `/x/dashboard/`
 *      → 那个文档里我们的插件不加载（`surface.loaded:false`）、页面里没有 composer
 *      → 白屏看门狗连续 3 次（≈45s）判"空白" → `_load` 把视图重载回客户端
 *      → 页面重新引导、中栏 `activePanelId` 复位成 null（= 会话页），页签条却还按 localStorage 记着「主页」
 *      → 用户看到「主页显示到一半，突然变成会话页」✗
 *
 *  两条必须成立（各自都能单独断掉这条链）：
 *    ① 主 frame 只允许待在 `/`（客户端是 SPA；工作台页一律走 iframe 的 `?surface=editor|sideview`）；
 *    ② 存活探针认得"我们的工作台面板在屏"（那一刻 composer 本来就不在 DOM —— main 槽是单选的）。
 *
 *  ⚠ 探针不能退化成"我们的插件 loaded"那种判据：认证失败页里插件照样加载 ⇒ 会永判活着、看门狗永不触发
 *    （见 `dshViewHost.ts` 里 2026-10-12 的教训）。面板**根标记**要求槽帧真的渲染成功 ⇒ 认证失败页里不存在 ✓。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';

const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';

const read = () => fs.readFileSync(VIEW_HOST, 'utf8');
/** 去掉注释再断言代码（注释里也写着这些关键词 ⇒ 不去掉会假绿 ✗）。 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

suite('dshHarness / 视图必须停在客户端根路径（2026-10-23 主页被切回会话）', () => {

	test('① 存活探针必须认得工作台面板（否则主页在屏 ⇒ 判白屏 ⇒ reload ⇒ 面板复位）', () => {
		const src = read();
		const at = src.indexOf('const PAGE_ALIVE_PROBE');
		assert.ok(at > 0, '找不到 PAGE_ALIVE_PROBE ✗');
		const line = src.slice(at, src.indexOf('\n', at));
		assert.ok(line.includes('[data-composer-card]'), '原有判据不能丢（真白屏还要能判出来）✗');
		assert.ok(line.includes('[data-vssaros-wb-tabs]'),
			'必须认页签面板的根标记（主页 / 工作台在屏时 composer 本来就不在 DOM）✗');
		assert.ok(line.includes('[data-vssaros-wb-full]'), '必须认整页面板的根标记 ✗');
	});

	// ★★ 2026-10-23（真机 3 轮才定位）：插件页在**客户端 iframe** 里渲染 ⇒ iframe 内部换页
	//   （「查看完整记忆」⇒ `/x/memory/detail`）会被 `will-navigate` 当成主 frame 导航拦掉
	//   ⇒ 用户看到"点了没反应" ✗✗ ⇒ 必须用 `will-frame-navigate` 且**只判主 frame** ✓
	test('① 必须用 will-frame-navigate 且**子帧放行**（否则 iframe 里的正常换页被拦）', () => {
		// ⚠ 用 stripComments：我自己在上面写的注释里也提到事件名 ⇒ 不去注释会假绿 ✗
		const src = stripComments(read());
		assert.ok(src.includes(`wc.on('will-frame-navigate'`),
			'必须挂 `will-frame-navigate`（`will-navigate` 会把 iframe 的导航也报上来 ⇒ 误拦 ✗）');
		assert.ok(/if\s*\(\s*!\s*details\.isMainFrame\s*\)\s*\{\s*return;?\s*\}/.test(src),
			'必须先判 `details.isMainFrame` 并放行子帧 —— 少了这一句，插件页 iframe 里点任何链接都没反应 ✗');
		assert.ok(src.includes('details.url'), '`will-frame-navigate` 的地址在 `details.url` 上');
	});
	test('② will-navigate 只做分派：判据必须在纯函数里（同源非根 = block）', () => {
		const src = stripComments(read());
		const at = src.indexOf("wc.on('will-frame-navigate'");
		assert.ok(at > 0, '找不到 will-navigate 接线 ✗');
		const body = src.slice(at, src.indexOf('});', at));
		// 判据已抽进 common/dshViewNavigation.ts（有表驱动单测）⇒ 这里必须**调用**它
		assert.ok(/decideMainFrameNavigation\(\s*url\s*,\s*this\._connection\?\.origin\s*,/.test(body),
			'必须用 decideMainFrameNavigation 决策（判据内联回 handler ⇒ 又变成没法单测 ✗）');
		// allow 最先返回，且**不** preventDefault（否则连根路径都进不去 ✗）
		const iAllow = body.indexOf("if (decision === 'allow')");
		const iPrevent = body.indexOf('event.preventDefault()');
		assert.ok(iAllow > 0, "缺少 'allow' 分支 ✗");
		assert.ok(iPrevent > iAllow, "'allow' 必须**早于** preventDefault（否则正常加载被自己拦死 ✗）");
		assert.ok(/blocked a main-frame navigation to \$\{url\}/.test(body),
			'拦下来必须留现场（日志里要能看到被导航到哪）✗');
		// 负对照：判据不许再内联回 handler
		assert.ok(!body.includes("path !== '/'"),
			"`path !== '/'` 又内联回来了 —— 判据只允许在 common/dshViewNavigation.ts 里（那样才测得到）✗");
	});

	test("③ 'external' 分支必须 preventDefault + 外开 + return（不许掉进 block 那段）", () => {
		const src = stripComments(read());
		const at = src.indexOf("wc.on('will-frame-navigate'");
		const body = src.slice(at, src.indexOf('});', at));
		const iExternal = body.indexOf("if (decision === 'external')");
		assert.ok(iExternal > 0, "缺少 'external' 分支（跨源链接会留在 dsh 视图里 ✗）");
		const branch = body.slice(iExternal, iExternal + 220);
		const iOpen = branch.indexOf('_openExternal');
		assert.ok(iOpen > 0, "external 分支必须 _openExternal ✗");
		assert.ok(/return;/.test(branch.slice(iOpen)),
			"external 分支在 _openExternal 之后必须 return —— 少了它还会继续往 block 的日志走（跨源被记成\"拦截\"）✗");
		// preventDefault 在分派之后、external 之前（跨源同样不许留在视图里）
		assert.ok(body.indexOf('event.preventDefault()') < iExternal,
			'preventDefault 必须在 external 分支之前（否则跨源导航会真的发生在视图里 ✗）');
	});

	test('④ 升级状态必须"记快照 + 重载后补发"（否则重载一次「N 项可用」就变空）', () => {
		const src = stripComments(read());
		const at = src.indexOf('pushUpgrade(viewId: string, state: IDshUpgradeState)');
		assert.ok(at > 0, '找不到 pushUpgrade ✗');
		const body = src.slice(at, src.indexOf('\n\t}', at));
		assert.ok(/slot\.lastUpgrade = state;/.test(body), 'pushUpgrade 必须记快照（补发靠它）✗');
		assert.ok(/send\(DSH_PAGE_IPC_UPGRADE, state\)/.test(body), 'pushUpgrade 必须真的发 IPC ✗');

		const replayAt = src.indexOf('private _replayPushedSnapshots(');
		assert.ok(replayAt > 0, '找不到 _replayPushedSnapshots ✗');
		const replay = src.slice(replayAt, replayAt + 1800);
		assert.ok(/if \(slot\.lastUpgrade\)/.test(replay) && /DSH_PAGE_IPC_UPGRADE/.test(replay),
			'页面就绪补发必须包含升级状态（preload 的 ipcRenderer.on 注册晚于首次推送 ⇒ 不补发页面永远收不到 ✗）');
	});

	test('⑤ 白屏探针**不许**退化成"插件加载过就算活着"（认证失败页会永判活着）', () => {
		const src = read();
		const at = src.indexOf('const PAGE_ALIVE_PROBE');
		assert.ok(at > 0, '找不到 PAGE_ALIVE_PROBE ✗');
		const line = src.slice(at, src.indexOf('\n', at));
		for (const forbidden of ['__vssarosChatSurface', 'vssarosDsh', 'loaded']) {
			assert.ok(!line.includes(forbidden),
				`探针里不许出现 ${forbidden} —— 认证失败页里插件照样加载 ⇒ 看门狗永不触发、真白屏永远修不好 ✗`);
		}
	});
});
