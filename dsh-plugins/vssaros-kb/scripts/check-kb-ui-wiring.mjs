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
// 组件源码：**中文在构建产物里是 \u 转义**的 ⇒ 文案类断言只能读源码（读不到就跳过，不误报）
let KB_TSX = '';
try { KB_TSX = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', 'utf8'); } catch { /* 独立包里没有源码 */ }
// 插件页（/x/kb/）的宿主脚本：它的动作必须是**真的**（2026-10-25 真机：点 ⚙ 只 console.warn）
// ★ 2026-10-26（P4）：页面脚本已外置到 page-boot.js ⇒ "页面实现了什么动作"要看那份文件。
const PAGE_HTML = readFileSync(HERE + '../lib/web/sideview.html', 'utf8')
	+ (() => { try { return readFileSync(HERE + '../lib/web/page-boot.js', 'utf8'); } catch { return ''; } })();

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
// ★ 2026-10-28 口径变更：图谱不再用"父相对 + 子绝对"的整页浮层（会盖住树与正文、
//   且 fixed 曾被宿主 transform 钉在下半屏），改为**右侧栏的兄弟分支**。
//   ⇒ 这条断言改成守"树容器常驻"——它才是当初那段相对/绝对定位想保住的真实目的：
//     挂载视图不能被卸载（effect 只跑一次，卸载后再回来是空白）。
check('树容器常驻（kbShell 只含 treePane，不随 pane 卸载）',
	/\}, treePane\);/.test(CLIENT) && !/pane === 'graph' \? h\('div', \{\s*'data-kb-graph-overlay'/.test(CLIENT));
check('助手栏仍是独立的层叠上下文（图谱/设置/对话都在它内部）',
	/position: 'relative'/.test(CLIENT) && /position: 'absolute'/.test(CLIENT));
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
check('视图的导图走中栏页签（无覆盖层状态）',
	KB_TSX.includes("activeView === 'canvas'") && !KB_TSX.includes('canvasOpen'));
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

// ── 面板右栏渲染（2026-10-26 真机：md 没渲染，显示"按纯文本显示"）──────
// 服务端 `/api/doc` 早就回了 html，但面板 `loadDoc` 的 fetchDoc 只取了 text
// ⇒ 视图拿不到 html ⇒ 走纯文本降级。这条断言锁住"必须透传"。
check('面板 loadDoc 透传服务端 html（否则右栏退化成纯文本）',
	CLIENT.includes("typeof payload.html === 'string'") && CLIENT.includes('math: !!(payload && payload.math)'));

// ── 普通链接（2026-10-26 真机：超链接点了没反应）──────────────
// 双链走 data-wiki；普通 `[文字](https://…)` 在 webview 里导航会被拦掉 ⇒
// 必须有 openUrl 动作把它交给宿主，否则表现为"点了没反应"。
check('视图把普通链接交给 openUrl（不再让 webview 自己导航）', BUNDLE.includes('openUrl'));
check('面板提供 openUrl（被拦时复制链接并提示）', /openUrl:\s*\(?u/.test(CLIENT) || CLIENT.includes('openUrl:'));
check('插件页提供 openUrl', PAGE_HTML.includes('openUrl:'));

// ── 长文档渲染（2026-10-26，P1）──────────────────────────────
// 屏外块跳过布局：视图（面板/页面）与独立文档页两处样式都要有，缺一处就有一端白慢。
check('视图样式启用 content-visibility（长文档首屏优化）', BUNDLE.includes('content-visibility'));
check('独立文档页样式同样启用 content-visibility', INDEX.includes('content-visibility'));

// ── ETag / 304（2026-10-26，P2）──────────────────────────────
// 服务端回 etag 只是第一步：两个宿主都必须**带着它再请求**并按 304 复用旧对象，
// 否则 304 分支永远不会被走到（等于白加一条机制）。
check('服务端支持 If-None-Match（304 空体）', INDEX.includes('if-none-match') && INDEX.includes('304'));
check('面板 loadDoc 带 docEtagCache + If-None-Match', CLIENT.includes('docEtagCache') && CLIENT.includes('if-none-match'));
check('插件页 loadDoc 同样支持（304 复用旧对象）', PAGE_HTML.includes('docEtagCache') && PAGE_HTML.includes('if-none-match'));

// ── 搜索结果高亮（2026-10-26，P3）────────────────────────────
// 高亮在前端做（字符串切片 + <mark>），不走 innerHTML ⇒ 不新增注入口。
// ⚠ esbuild 会重命名局部函数 ⇒ 不能按 `highlightMatch` 断言，改盯**高亮的样式字面量**
check('搜索结果高亮已接线（<mark> 样式字面量在 bundle 里）', BUNDLE.includes('rgba(255,204,0,.30)'));
check('高亮不引入 innerHTML（仍走 React 文本节点）',
	!/rgba\(255,204,0,\.30\)[\s\S]{0,400}?innerHTML/.test(BUNDLE));

// ── 编辑器（2026-10-26）：独立 bundle + 失败降级 ─────────────
// 侧栏常驻，编辑是偶发动作 ⇒ 编辑器必须**按需加载**；拉不到（IDE webview 没这条路由）
// 时要**静默退回 textarea**，否则用户会对着空白框发呆。
check('视图按需加载编辑器（/x/kb/web/kbEditor.js）', BUNDLE.includes('/x/kb/web/kbEditor.js'));
check('编辑器拉不到时退回 textarea（__KB_EDITOR_MOUNT__ 检测）', BUNDLE.includes('__KB_EDITOR_MOUNT__'));
check('编辑器 bundle 已随包（lib/web/kbEditor.js）',  (() => { try { return readFileSync(HERE + '../lib/web/kbEditor.js', 'utf8').length > 1000; } catch { return false; } })());
check('主 bundle 不含 CodeMirror（没有把编辑器塞进侧栏）', !BUNDLE.includes('cm-content') && !BUNDLE.includes('cm-scroller'));

// ── 三项真机修复（2026-10-26）──────────────────────────────
// ① mermaid 渲染：服务端只出源码，客户端按需拉 3.4MB 后转 SVG
	// 2026-10-26：mermaid 改由**服务端 pele** 渲染（同步、零 DOM）⇒ 客户端零脚本
	check('视图不再加载 mermaid 引擎（改为服务端出 SVG）',
		!BUNDLE.includes('mermaid.min.js') && !BUNDLE.includes('loadMermaid'));
	check('mermaid 的样式钩子是服务端产出的 kb-mermaid-block', BUNDLE.includes('kb-mermaid-block'));
// ② 切笔记卡顿：命中缓存先上屏 + 后台 ETag 校验 + 载入态提示
// ⚠ 局部变量与中文串在压缩后都不可靠 ⇒ 直接看**视图源码**（这一条守的是实现存在，不是产物形态）
check('正文缓存（切回已读笔记应瞬时）', (() => {
	try {
		const src = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', 'utf8');
		return src.includes('docCacheRef') && src.includes('docLoading');
	} catch { return false; }
})());
// ③ 超链接没反应：被拦时必须给反馈（不能静默）
check('外链被拦时有明确反馈（复制 + 提示）', CLIENT.includes('宿主没有打开新窗口') && PAGE_HTML.includes('宿主没有打开新窗口'));


// ── 右键菜单 · 缺失双链（2026-10-26）────────────────────────
// ⚠ 中文标签在压缩产物里会被转义，不能直接搜字符串 ⇒ 看**视图源码**
const VIEW_SRC = (() => { try { return readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', 'utf8'); } catch { return ''; } })();
check('右键菜单有「复制绝对路径」', VIEW_SRC.includes('复制绝对路径') && VIEW_SRC.includes('copyText'));
check('右键菜单有「在资源管理器中打开」（宿主声明 reveal 才显示）',
	VIEW_SRC.includes('在资源管理器中打开') && VIEW_SRC.includes('actions?.reveal'));
check('面板/页面都实现了 reveal（POST /api/reveal）',
	CLIENT.includes('/x/kb/api/reveal') && PAGE_HTML.includes('/x/kb/api/reveal'));
check('缺失双链可点击并给出反馈（不再静默）',
	BUNDLE.includes('data-wiki-missing') || BUNDLE.includes('找不到这篇笔记'));


// ── 窄面板布局 · 文档内跳转（2026-10-26 真机）────────────────
// ① 排序条原来 9 个按钮平铺，340px 面板里被压成竖排单字（"名 称 ↑"）⇒ 改成 select + 单字图标。
// ② 2026-10-26 方案 B：节头**一行**收纳（排序 + ＋ + ⋯），不再有第二行按钮条。
//    这条同时守住"别再把一排按钮塞回去"（那正是 340px 面板里被压成竖排的成因）。
check('笔记节改为单行收纳（⋯ 菜单在，第二行已删除）',
	VIEW_SRC.includes('notesMenu') && VIEW_SRC.includes('data-kb-notes-menu') && !VIEW_SRC.includes('kb-sortbar'));
check('⋯ 菜单里含体检/查重/审核/导图（按能力显示）',
	['体检', '查重', '审核', '思维导图'].every(k => VIEW_SRC.includes("label: \"" + k + "\"")));
check('节头控件不缩不断行（nowrap）',
	/setNotesMenu\(\{ x:/.test(VIEW_SRC) && VIEW_SRC.includes('whiteSpace: "nowrap"'));
// ② 文档内双链原来交给宿主 openLink，而宿主只改了自己的状态 ⇒ 界面没反应。
check('文档内双链由视图自己打开（loadIntoView）',
	VIEW_SRC.includes('loadIntoView') && VIEW_SRC.includes('if (!loadIntoView(p))'));


// ── 右栏 C+D（2026-10-26）：多文档 Tab + 极简细条 ──────────────
// 动机：点树就覆盖当前正文（丢滚动位置、丢掉对照）；标题行随正文滚走（中段不知道在看哪篇）。
check('右栏有文档 Tab 条（开关 + 切换）',
	VIEW_SRC.includes('data-kb-tabs') && VIEW_SRC.includes('switchTab') && VIEW_SRC.includes('closeTab'));
check('Tab 切换保留现场（滚动位置 + 草稿）',
	VIEW_SRC.includes('tabSnapRef') && VIEW_SRC.includes('pendingScrollRef'));
check('关掉有未保存改动的 Tab 会二次确认',
	/确定关闭/.test(VIEW_SRC) && VIEW_SRC.includes('closeTab'));
check('细条常驻：折叠面包屑 + 预览/编辑分段 + ⋯',
	VIEW_SRC.includes('data-kb-docbar') && VIEW_SRC.includes('data-kb-mode') && VIEW_SRC.includes('fileNameOf'));
check('阅读进度条 + 回到顶部',
	VIEW_SRC.includes('docProgress') && VIEW_SRC.includes('回到顶部'));

// ══════════════════════════════════════════════════════════════════════════
// ★ 2026-10-28：两份**曾丢失**的断言在这里重建（工作副本曾被回退到 HEAD，
//   旧断言随之消失；现在按当前实现重新钉住，别再依赖"当时加过"）。
// ══════════════════════════════════════════════════════════════════════════

// ── ① 知识库助手必须绑「知识库专家」（当前实现的真实形态：包 newSession）──
//   ⚠ 2026-10-28 记录：这份 client.js 曾被回退到更早的版本（1745 行），
//     当时那套 `applyKbPresetAsync + 回读校验 + MutationObserver` **已不在此文件中**；
//     现行实现是"包 `desktopWorkbenches.newSession`，新会话建好后 select 预设"。
//     ⇒ 断言按**现存的实现**写，不按"我记得加过什么"写（否则守卫永远红）。
check('新会话默认用知识库专家（newSession 补丁 + preset id）',
	CLIENT.includes('__vssarosKbPreset') && CLIENT.includes("'vssaros-knowledge-base-expert'")
		&& /presets\.select\(sid, 'vssaros-knowledge-base-expert'\)/.test(CLIENT));
check('只有本工作台在前台时才改 preset（不带走别的工作台会话）',
	CLIENT.includes('__vssarosKbActive'));

// ── ② 聊天框与文档**不许重叠**（按商城工作台的分栏口径）─────────────────
check('业务区基准 0%（助手栏出现时必定收缩）',
	/flex: '1 1 0%'/.test(CLIENT));
check('业务区裁剪溢出（overflow: hidden）',
	/data-vssaros-kb-panel[\s\S]{0,1800}?overflow: 'hidden'/.test(CLIENT));
check('助手栏自建层叠与裁剪（position:relative + overflow:hidden + maxWidth）',
	/'data-vssaros-kb-conv'[\s\S]{0,800}?position: 'relative'[\s\S]{0,400}?overflow: 'hidden'[\s\S]{0,400}?maxWidth: '70%'/.test(CLIENT));
check('对话有自己的滚动容器（minHeight:0 + overflow:auto）',
	/flexDirection: 'column'[\s\S]{0,500}?flex: '1 1 auto'[\s\S]{0,300}?overflow: 'auto'/.test(CLIENT));

// ── ③ 设置 / 关系图谱改在**右侧栏**渲染（2026-10-28 用户要求）─────────────
//   以前是业务区的整页浮层（`data-kb-*-overlay`）⇒ 盖住树与正文，且"返回"会丢上下文。
// ★ 2026-10-28（真机：点设置后**整块空白**）：`data-kb-host-settings` 是个 absolute 全屏、带背景的
//   空容器；portal 没渲染进去时它就是"一块空板"，盖住正文 ⇒ 看起来像白屏。
//   ⇒ ⚙ 必须走**视图内页签**（同一 React 树），不依赖 portal。
// ★★ 2026-10-28 最终口径（三次失败后定论）：
//   bundle 自带另一份 React ⇒ **跨实例渲染面板富设置不可靠**（会被不透明空容器盖成"空白"）。
//   ⇒ 设置页签只渲染 bundle 自己的设置页（同一 React 树，必定可见）；
//     完整设置（飞书/映射/CLI）由页内的「完整设置…」按钮开在右栏。
check('⚙ 始终用视图内页签（不再跨 React 实例渲染）',
	/preferInlineSettings:\s*true/.test(CLIENT));
check('设置页内不再有宿主空容器（它曾把设置页盖成空白）',
	!KB_TSX.includes('data-kb-host-settings'));
// ★ 2026-10-28：完整设置（飞书 / 映射 / CLI）**用 bundle 自己的 React 重写**，
//   走同一组插件端点 ⇒ 与文档页签同树渲染，不存在跨实例问题。
// ★ 2026-10-28（真机：「我的知识库」仍在库里）：注入用的 roots overlay 是**按内容哈希缓存复用**的，
//   只改 IDE 注入侧会"看起来没生效" ⇒ 规则必须落在**服务端**（按名字 + 0 篇剔除、并在同一目录只留一条）。
check('服务端剔除默认「我的知识库」并按目录去重',
	INDEX.includes('我的知识库') && /nm === '我的知识库'/.test(INDEX) && INDEX.includes('const byDir = new Map()'));

// ★ 2026-10-28（真机：设置页水平方向没占满）：IDE 编辑器被拆成 4 个窄组（220/220/220/450）时，
//   页面可用宽度只有 ~220px ⇒ ① 树列不能固定 340px（会挤没正文列）；② 面板层宽度要逐层传下来。
check('窄容器下不把正文列压没（树列按比例 + 正文保底 + 横向滚动）',
	KB_TSX.includes("clamp(200px, 34%, 340px)") && KB_TSX.includes('minWidth: 260') && KB_TSX.includes('overflowX'));
check('面板层宽度逐层铺满（kbShell / treePane / hostRef 都带 width:100%）',
	/width: '100%'/.test(CLIENT) && (CLIENT.match(/width: '100%'/g) || []).length >= 3);

// ★ 2026-10-29（用户：点设置 / 关系图谱要显示成**带页签**的页面，与文档页签并列）
check('设置 / 图谱都是中栏页签（与文档页签同一排、可点击切换）',
	KB_TSX.includes('data-kb-settings-tab="1"') && KB_TSX.includes('data-kb-graph-tab="1"')
	&& /aria-selected=\{activeView === 'settings'\}/.test(KB_TSX) && /aria-selected=\{activeView === 'graph'\}/.test(KB_TSX));
check('图谱页签用 bundle 自己的 React 实现（走 /x/kb/api/graph）',
	KB_TSX.includes('function KbGraphTab(') && KB_TSX.includes('/x/kb/api/graph'));

// ★ 2026-10-29（用户：设置页面右侧太贴边）：内容必须留出内边距，且输入框不能顶出右缘。
check('设置页有内边距与最大宽度（不再贴右边缘）',
	KB_TSX.includes("padding: '14px 20px 28px'") && KB_TSX.includes("maxWidth: '1180px'"));
check('设置页里的行可换行、输入框可收缩（不再被裁切）',
	KB_TSX.includes("flexWrap: 'wrap'") && KB_TSX.includes('minWidth: 0'));

// ★ 2026-10-29（用户：文档页签和设置页签会同时高亮）：
//   文档页签的激活态必须**同时**满足「当前在看文档」+「路径匹配」；
//   而且循环变量不能把页签状态变量遮蔽（`tabs.map(tab => …)` vs 状态 `tab`）。
check('文档页签激活态包含"正在看文档"（切到设置/图谱时不高亮）',
	KB_TSX.includes("activeView === 'doc' && t.path === activePath"));
check('页签状态与循环变量不重名（无遮蔽）',
	KB_TSX.includes("const [activeView, setTab] = useState<'doc' | 'settings' | 'graph' | 'canvas'>") &&
	KB_TSX.includes('tabs.map(t => {'));

// ★ 2026-10-29（用户：设置 / 图谱页签**只有点击对应按钮**才会打开）：
//   这两个页签不许常驻 ⇒ 必须由 ⚙ / 🕸 按钮把 openViews 置位后才出现在页签条上。
check('设置 / 图谱页签按需出现（只有点对应按钮才打开）',
	KB_TSX.includes('openViews.settings ? (') && KB_TSX.includes('openViews.graph ? (')
	&& KB_TSX.includes("setOpenViews(o => ({ ...o, settings: true }))")
	&& KB_TSX.includes("setOpenViews(o => ({ ...o, graph: true }))"));
check('回到文档时收起这两个页签',
	KB_TSX.includes("setOpenViews({ settings: false, graph: false, canvas: false })"));

// ★ 2026-10-29（用户：思维导图按钮显示的页面要和设置页同样效果）：
//   导图必须是**中栏页签**（和 ⚙ 设置 / 🕸 图谱同一套），不再用整页覆盖层。
check('思维导图也是中栏页签（与设置/图谱同一套）',
	KB_TSX.includes('data-kb-canvas-tab="1"') && KB_TSX.includes("activeView === 'canvas'")
	&& KB_TSX.includes("setOpenViews(o => ({ ...o, canvas: true }))"));
check('导图不再用整页覆盖层（旧的 canvasOpen 状态已移除）',
	!KB_TSX.includes('data-kb-canvas-overlay') && !KB_TSX.includes('canvasOpen'));

check('完整设置（飞书）在 bundle 内实现并挂进设置页',
	KB_TSX.includes('function KbFeishuSettings(') && KB_TSX.includes('<KbFeishuSettings />'));
check('完整设置走插件端点（kb-settings / feishu-cli / feishu-sync / feishu-spaces）',
	['kb-settings', 'feishu-cli', 'feishu-sync', 'feishu-spaces', 'feishu-log'].every((p) => KB_TSX.includes(p)));

check('设置与图谱在右侧栏渲染（aside 内两个分支）',
	CLIENT.includes("'data-kb-graph-aside'") && CLIENT.includes("'data-kb-settings-aside'"));
check('业务区不再有整页浮层（overlay 已移除）',
	!CLIENT.includes('data-kb-graph-overlay') && !CLIENT.includes('data-kb-settings-overlay'));
check('图谱/设置时助手栏强制展开（点了必须有反应）',
	CLIENT.includes("!kbCollapsed || pane !== 'tree'"));
check('助手聊天切走后不卸载（只切 display）',
	/display: pane === 'tree' \? 'flex' : 'none'/.test(CLIENT));

// ── ⑤ 设置 / 图谱的**落位**（2026-10-28 用户口径，两次修正后的最终形态）────
//   dsh 侧：设置是**中栏的独立页签**（与文档页签并列），不是居中弹窗、也不是右栏；
//          富设置（飞书/映射/CLI）由面板层渲染进 bundle 给的容器。
//   IDE 侧：设置/图谱开成 editorpane（见上面两条）。
check('设置/图谱在右侧栏（dsh 的图谱分支）',
	CLIENT.includes("'data-kb-graph-aside'"));

// ── ④ IDE 侧：设置 / 图谱必须开在 **editorpane**（2026-10-28 用户要求）────────
//   侧栏只发动作，具体 UI 由命令服务开成编辑器输入（视图里不许自绘面板）。
// ★ 2026-10-28（真机：载入的库显示成 `ext-f0e1f1cee`）：视图数据必须优先用**记录自带的 name**，
//   否则外挂库（.extra-vaults.json）在 IDE 注入清单里查不到 ⇒ 回退成 id。
// ── ⑥ 库下拉的「从列表移除」按钮（2026-10-28 用户要求）──────────────────────
// ★ 2026-10-28（用户要求：不要「我的知识库」默认库）：没有库时下拉必须**明说要用户自己选文件夹**。
check('没有知识库时给出"自己选文件夹"的提示（不再展示默认库）',
	KB_TSX.includes('还没有知识库') && KB_TSX.includes('本地载入文件夹'));

check('库下拉每项有移除入口（组件接 removeVault）',
	BUNDLE.includes('removeVault') && KB_TSX.includes('removeVault?(vaultId: string)'));
check('移除是**两级确认**（第一次只变问句）',
	KB_TSX.includes('确认移除?') && KB_TSX.includes('vaultRemoveAsk'));
check('面板移除走 /api/vault-remove（只摘登记，不删磁盘）',
	CLIENT.includes('/x/kb/api/vault-remove'));
// ★ 2026-10-28（真机：移除报「vaultId 形态不合法：ext-f0e1fcee」）：校验必须认外部库 id，
//   同时**不许**放宽成路径穿越（仍是字母数字 + `-`）。
let extIdOk = false;
try {
	const core = await import('../lib/core/kb.js');
	extIdOk = core.isVaultId('ext-f0e1fcee')
		&& core.isVaultId('20240101120000-abc')
		&& !core.isVaultId('ext-../x')
		&& !core.isVaultId('../etc/passwd')
		&& !core.isVaultId('ext-zzzz');
} catch { /* 独立包里跑不到就跳过 */ }
check('外部库 id（ext-…）通过校验，且仍拒绝路径穿越', extIdOk);
check('库名优先用记录自带 name（view-data 两处都改）',
	/name: \(v\.name && String\(v\.name\)\.trim\(\)\)/.test(INDEX)
	&& INDEX.includes('nameOf(vault.id, vault.name)'));

check('服务端 vault-remove 只改 .extra-vaults.json（不 rm 目录）',
	INDEX.includes('/api/vault-remove')
	&& /vault-remove[\s\S]{0,2600}?\.extra-vaults\.json/.test(INDEX)
	&& !/vault-remove[\s\S]{0,2600}?await rm\(/.test(INDEX));

// ★ 2026-10-28（真机：点设置整页黑屏）：`require('react-dom/client')` **不许写在模块顶层** ——
//   宿主没这个模块 id 时会同步抛 ⇒ 整个面板模块加载失败 ⇒ 连左边树都没了的空白页。
check('面板不在顶层 require(react-dom/client)（缺失会白屏）',
	!/\nconst\s+reactDom\s*=\s*require\(['"]react-dom\/client['"]\)/.test(CLIENT)
	&& CLIENT.includes('ensureReactDom'));

check('库名优先用记录自带 name（外挂库不显示 ext-xxx）',
	INDEX.includes('nameOf(vault.id, vault.name)')
	&& /nameOf = \(id, ownName\)/.test(INDEX));

check('dsh 设置是**中栏页签**（页签标记 + 设置面板都在 bundle 里）',
	BUNDLE.includes('data-kb-settings-tab') && KB_TSX.includes('data-kb-settings="1"'));
check('面板提供 openHostSettings（富设置渲染进中栏）',
	CLIENT.includes('openHostSettings') && CLIENT.includes('react-dom/client'));
// ⚠ 中文在**构建产物里是 \u 转义**的 ⇒ 这条读源码 TSX（见文件头 KB_TSX），不读 bundle
// ★ 2026-10-28（用户要求）：中栏空态**不再显示任何文案**（只保留整块底色）。
check('中栏空态不再显示「点左边的笔记看正文」',
	!KB_TSX.includes('点左边的笔记看正文'));

let IDE_PANE = '';
let IDE_CMD = '';
try {
	IDE_PANE = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/browser/views/kbSideviewReactViewPane.ts', 'utf8');
	IDE_CMD = readFileSync(HERE + '../../../src/vs/sessions/contrib/agentStudio/browser/knowledge/kbCommandService.ts', 'utf8');
} catch { /* 在独立插件包里跑时读不到源码 ⇒ 下面两条会红，属预期 */ }
check('IDE 侧「设置/图谱」走命令服务（不在视图里自绘）',
	/case 'openGraph':[\s\S]{0,120}?openGraph\(\)/.test(IDE_PANE)
	&& /case 'openSettings':[\s\S]{0,120}?openSettings\(\)/.test(IDE_PANE));
check('IDE 侧设置与图谱开成编辑器输入（KbSettings / KbGraph EditorInput）',
	IDE_CMD.includes('new KbSettingsEditorInput(') && IDE_CMD.includes('new KbGraphEditorInput('));

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项通过（交互接线完整）`);
}
