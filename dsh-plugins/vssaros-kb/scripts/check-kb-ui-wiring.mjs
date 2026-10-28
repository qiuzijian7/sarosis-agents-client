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

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项通过（交互接线完整）`);
}
