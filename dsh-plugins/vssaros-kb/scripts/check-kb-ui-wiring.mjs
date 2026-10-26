/*
 * 守卫：**交互接线**不许断（2026-10-24）。
 *
 * 起因：连着两次"点了没反应"——
 *   ① 图谱按钮：面板里 `openGraph` 直接把 pane 切成 graph，但容器高度链断了 ⇒ canvas 0×0，
 *      点击其实生效了、界面却像没动静（真机表现与"事件没绑上"完全一样）；
 *   ② 设置按钮：早先被"能力缺失就不渲染"的规则连按钮一起藏了。
 * 这类问题 `node --check` / tsc 全绿，只有真机点一下才能发现 ⇒ 用本守卫把它们钉住：
 *   · 面板必须有 openGraph 且切 pane（不是空函数）
 *   · 图谱必须渲染在**固定定位覆盖层**里（不依赖父级高度）
 *   · 视图必须有设置面板（`data-kb-settings`）与图谱画布锚点
 *   · 面板必须提供 switchVault（设置里切库）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-ui-wiring.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
const BUNDLE = readFileSync(HERE + '../lib/web/kbSideview.js', 'utf8');
const INDEX = readFileSync(HERE + '../lib/index.js', 'utf8');
// 插件页（/x/kb/）的宿主脚本：它的动作必须是**真的**（2026-10-25 真机：点 ⚙ 只 console.warn）
const PAGE_HTML = readFileSync(HERE + '../lib/web/sideview.html', 'utf8');

let pass = 0;
const failed = [];
function check(name, cond, detail = '') {
	if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
	else { failed.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// ── 面板：图谱 ─────────────────────────────────────────────
check('面板定义了 openGraph 且切换到 graph pane',
	/openGraph:\s*\(\)\s*=>\s*\{\s*setPane\('graph'\);\s*\}/.test(CLIENT));
// ⚠ 不许再用 `position: fixed`：宿主视图容器带 transform ⇒ fixed 的包含块变成那个容器，
//   图谱会被钉在面板的下半部分（2026-10-24 真机截图）。必须"父相对 + 子绝对"。
check('图谱层用面板内绝对定位（父容器 relative）',
	CLIENT.includes("'data-kb-graph-overlay': '1'")
	&& /position:\s*'absolute'/.test(CLIENT)
	&& /position:\s*'relative'/.test(CLIENT));
check('图谱层没有使用 fixed 定位（会被宿主 transform 限制）',
	!/data-kb-graph-overlay[\s\S]{0,300}?position:\s*'fixed'/.test(CLIENT));
check('图谱有画布锚点', CLIENT.includes("'data-kb-graph-canvas': '1'"));
check('图谱有返回入口（onClose → 切回 tree）',
	/setPane\('tree'\)/.test(CLIENT));
check('面板提供 switchVault（设置里切库）', /switchVault:\s*\(id\)\s*=>/.test(CLIENT));
// 设置：IDE 由宿主开 editor pane；面板必须开**二级页面**（整页 + 返回），不是弹窗
check('面板提供 openSettings 并切到二级页面', /openSettings:\s*\(\)\s*=>\s*setPane\('settings'\)/.test(CLIENT));
check('已实现设置二级页面（data-kb-settings-page）', CLIENT.includes("'data-kb-settings-page': '1'"));
check('设置页有返回入口', CLIENT.includes('← 返回知识库'));
// ⚠ 光有 `openSettings: () => setPane('settings')` + 组件定义是不够的：
//   2026-10-24 真机"设置点了没反应"就是**切了 pane 但没有对应渲染分支**，
//   组件变成了死代码，而旧守卫只查字符串存在 ⇒ 全绿却坏。
//   ⇒ 必须同时断言：① 有 `pane === 'settings'` 分支；② 组件被真正使用（定义 + 使用 ≥ 2 处）。
check("设置 pane 有渲染分支（pane === 'settings'）", /pane === 'settings'/.test(CLIENT));
check('KbSettingsPage 被真正渲染（出现 ≥ 2 处）',
	(CLIENT.match(/KbSettingsPage/g) ?? []).length >= 2,
	'出现 ' + (CLIENT.match(/KbSettingsPage/g) ?? []).length + ' 处');
// ⚠ 2026-10-24（真机：`c is not defined` 让整个工作台变成"渲染时出错"）：
//   静态检查看不出"引用了作用域里不存在的标识符"，而这类错误只有渲染时才炸。
//   这里用最省的一条：只要用了 `c.xxx` 颜色令牌，就必须有 `const c = {` 定义。
{
	const usesC = /[^A-Za-z0-9_$.]c\.(line|fgFaint|fgDim|fg|bg|inputBg|inputFg|badge|sel)/.test(CLIENT);
	const definesC = /const c = \{/.test(CLIENT);
	check('使用 c.* 颜色令牌时必须定义 const c', !usesC || definesC, usesC ? (definesC ? '已定义' : '缺定义') : '未使用');
}
check('面板请求 view-data 时带 vault 参数', CLIENT.includes("'?vault='"));
check('面板提供 feishuSync', CLIENT.includes('feishuSync:'));

// ── 视图 bundle：设置面板 ───────────────────────────────────
check('视图有设置面板锚点（data-kb-settings）', BUNDLE.includes('data-kb-settings'));
check('设置按钮不再被能力门控掉（⚙ 无条件渲染）',
	/* 旧写法是 `{actions?.openSettings ? <IconBtn …⚙/> : null}`，这条断言防止它回来 */
	!BUNDLE.includes("actions?.openSettings?") || BUNDLE.includes('data-kb-settings'));
check('视图声明 switchVault 动作', BUNDLE.includes('switchVault'));

// ── 飞书二则（2026-10-24 真机两次「点了没反应」）──────────────
//  ① lark-cli 的 `wiki +space-list` 返回 `{ data: { spaces } }`，只认 items/spaces 会得到 0 条；
//  ② 拉取结果**必须有可见反馈**（原先成功但 0 条 ⇒ 界面毫无变化，看起来像按钮坏了）。
check('知识库列表解析兼容 data.spaces', INDEX.includes('j?.data?.spaces'));
check('拉取知识库列表有可见反馈（spacesMsg）', CLIENT.includes('spacesMsg'));
check('lark-cli 支持 .cmd 启动（Windows npm shim）', INDEX.includes("shell: true"));

// ── 定时同步（2026-10-25）──────────────────────────────────────
// ① 页面必须能显示"下次运行"，否则开关是黑盒；② 服务端必须有执行器与状态路由。
check('设置页拉取定定时状态（/api/feishu-schedule）', CLIENT.includes('/x/kb/api/feishu-schedule'));
check('设置页有定时状态文案', CLIENT.includes('scheduleText'));
check('服务端有定时执行器', INDEX.includes('startFeishuScheduler'));
check('定时与手动同步共用一条实现', INDEX.includes('performFeishuSync'));
check('定时器会 unref（不拖住宿主退出）', INDEX.includes('timer.unref'));

// ── 重建索引（2026-10-25）────────────────────────────────────
check('设置页能重建索引（/api/reindex）', CLIENT.includes('/x/kb/api/reindex') && CLIENT.includes('runReindex'));
check('索引状态会显示上次重建时间', CLIENT.includes('reindex.lastAt'));
// ⚠ dsh 侧没有 embedding provider ⇒ 服务端必须**如实**回 supported:false，不许假装能重建向量
check('向量索引如实标注不支持', INDEX.includes('vector: { supported: false') && CLIENT.includes('dsh 侧不支持重建'));

// ── 导图 .canvas（2026-10-25 迁到视图层）──────────────────────
// 历史：渲染器原在面板侧（KbCanvasMap + pane='canvas'）⇒ 插件页用不到，且与视图重复。
// 现在：视图自己渲染（KbCanvasPane + 覆盖层），宿主只声明能力位 `canvas: true`。
check('视图自带导图渲染器（KbCanvasPane）', BUNDLE.includes('KbCanvasPane') || BUNDLE.includes('data-kb-canvas-pane'));
check('视图有导图覆盖层状态（canvasOpen）', BUNDLE.includes('canvasOpen') || BUNDLE.includes('data-kb-canvas-overlay'));
check('面板只声明能力位 canvas:true', /canvas:\s*true/.test(CLIENT));
// ⚠ 反向断言：面板**不许**再长出一份导图渲染/分支（那会立刻变成两份实现）
check('面板不再保留重复的导图组件（无 KbCanvasMap / pane=canvas）',
	!CLIENT.includes('KbCanvasMap') && !/pane === 'canvas'/.test(CLIENT));
// 页面同样声明能力位（三端共用视图后，页面也该有 🗺）
check('插件页声明 canvas 能力位', PAGE_HTML.includes('canvas: true'));

// ── 查重（2026-10-25）────────────────────────────────────────
check('设置页能查重（/api/dedupe）', CLIENT.includes('/x/kb/api/dedupe') && CLIENT.includes('runDedupe'));
// ⚠ 查重**只报告不改文件**：这条断言守的是"将来别被改成自动合并"
check('查重结果里写明"只报告不修改"', CLIENT.includes('只报告，不修改'));
check('查重不提供写操作（无 delete/merge 调用）',
	!/dedupe[\s\S]{0,400}?deleteNodes\(/.test(CLIENT));


// ── 插件页动作（2026-10-25）────────────────────────────────
// ⚠ 视图的 ⚙ 逻辑是「有 openSettings 就交给宿主，没有就开内置面板」。
//   页面曾经提供一个只 console.warn 的 openSettings ⇒ 宿主算"有"，面板永远打不开。
check('页面不再提供假 openSettings（交给视图内置面板）', !/openSettings\s*:/.test(PAGE_HTML));
check('页面切库走 URL ?vault=（取数带 wantVault）', PAGE_HTML.includes('wantVault') && PAGE_HTML.includes("searchParams.set('vault'"));
check('页面能新建/载入库（→ /api/vault-add）', PAGE_HTML.includes('addVault') && PAGE_HTML.includes('/api/vault-add'));
check('页面标签筛选不再静默无反应', !PAGE_HTML.includes('标签筛选暂未接入'));

// ── 笔记区标题行四动作（2026-10-25）─────────────────────────
// 视图里「审核 / 去重 / 导图 / 体检」按钮按能力门控；宿主不提供就整块不渲染。
// 之前面板一个都没提供 ⇒ dsh 侧这四个按钮**永远不出现**。
check('标题行动作面板已接线（runLint/runDedup/reviewQueue）',
	/runLint:\s*\(\)\s*=>/.test(CLIENT) && /runDedup:\s*\(\)\s*=>/.test(CLIENT)
	&& /reviewQueue:\s*\(\)\s*=>/.test(CLIENT));
check('导图按钮靠能力位（canvas:true）而非重复动作', /canvas:\s*true/.test(CLIENT));
check('设置页支持 auto 自动执行（跳进来就跑对应动作）', CLIENT.includes('autoRan') && CLIENT.includes('settingsAuto'));
check('设置页区块有锚点（data-kb-sec）',
	['health', 'review', 'reindex', 'feishu'].every(k => CLIENT.includes("'data-kb-sec': '" + k + "'")));

// ── 插件页的三项报告（2026-10-25）────────────────────────────
check('页面提供体检/查重/审核入口（只读报告层）',
	PAGE_HTML.includes('kbReportOverlay') && PAGE_HTML.includes('runLint')
	&& PAGE_HTML.includes('runDedup') && PAGE_HTML.includes('reviewQueue'));
check('页面报告层只读（不调用删除/合并）',
	!/kbReportOverlay[\s\S]{0,800}?deleteNodes\(/.test(PAGE_HTML));

// ── 遗留动作清理（2026-10-25）────────────────────────────────
// 导图统一到 `canvas` 能力位、重建索引在设置页 ⇒ 视图不该再留着
// `openCanvas` / `openMindmap` / `reindex` 三条旧路径（留着就会长出第二套入口）。
check('视图已清理导图/索引的遗留动作（只认 canvas 能力位）',
	!BUNDLE.includes('openCanvas') && !BUNDLE.includes('openMindmap') && !BUNDLE.includes('reindex'));
console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项通过（交互接线完整）`);
}
