/*---------------------------------------------------------------------------------------------
 *  会话插件页（`dsh-plugins/vssaros-sessions`）的动作面契约
 *
 *  背景（2026-10-19，用户选 B 方案：会话管理收敛到 dsh 插件页）：这页从前是**纯只读**列表
 *  （只有分组 + 搜索 + 配额），点一行没有任何反应 ⇒ 它担当不起"会话管理"。
 *  现在补"点行打开会话"与"＋ 新建会话"，两条都**必须经宿主桥**（页面私自切会让两边分叉）。
 *
 *  这类改动最容易**改了一半**：按钮画了、没绑事件；或者事件绑了、还在自称"只读"。
 *  ⇒ 用源码契约钉住三处，并反向突变验证。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

const PAGE = 'dsh-plugins/vssaros-sessions/lib/index.js';
/** A 侧（IDE 原生侧栏）的视图注册处 —— 消歧断言要看它。 */
const CONTRIB = 'src/vs/sessions/contrib/sessionHistory/browser/sessionHistory.contribution.ts';
/** 配置注册处（默认值决定了 P2 迁移是否真的生效）。 */
const DSH_CONTRIB = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
/** 独立聊天窗口的侧栏（应复用同一个宿主）。 */
const AUX = 'src/vs/sessions/contrib/sessionHistory/browser/auxChatSessionSideView.ts';
/** 分组纯逻辑（多根归并在这里）。 */
const LIST_CORE = 'dsh-plugins/vssaros-sessions/lib/core/sessionList.js';
/** 会话日志读取（多帧 zstd → 用户消息）。 */
const SESSION_LOG = 'dsh-plugins/vssaros-sessions/lib/core/sessionLog.js';
/** 页面偏好（pin / 最近使用）的真源。 */
const PREFS = 'dsh-plugins/vssaros-sessions/lib/core/prefs.js';

/**
 * B 方案 P2：**会话历史的 UI 也迁到 dsh 侧**。
 *
 * 形态：同一个常驻容器 `sessionHistory.view` 里注册两个**互斥**视图，由
 * `sessions.dshHarness.sessionHistoryUi` 选一个（plugin 默认）。
 * 这类接线最容易出的错：`when` 写错 ⇒ 两个都不匹配 ⇒ **容器空白**（用户看到空的侧栏）；
 * 或默认值没注册 ⇒ `config.` 取不到值 ⇒ 同样空白。⇒ 钉住这三点。
 */
suite('会话历史 UI 迁移（定稿：IDE 侧零会话逻辑）', () => {

	test('★★ IDE 侧**不再注册任何容器/视图**（否则活动栏会出现两个「历史会话」图标）', () => {
		const src = read(CONTRIB);
		// ⚠ 只看**代码行**（排除注释）：文件头/回滚说明里会提到这两个 API，按全文匹配会误判 ✗
		const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
		assert.ok(!/registerViewContainer\(/.test(code), 'IDE 侧不许再注册容器 —— 入口只留 dsh 模块容器 ✗');
		assert.ok(!/viewsRegistry\.registerViews/.test(code), 'IDE 侧不许再注册视图 ✗');
		// ⚠ 只查 import 行：注释里允许提到 DshPluginViewPane（回滚说明需要它 ✓）
		assert.ok(!/^\s*import\s+.*DshPluginViewPane/m.test(src), '这里也不该再挂插件页宿主（那是 dsh 模块容器的事）✗');
		assert.ok(/已退役/.test(src), '文件头要写明已退役与回滚方式（否则下一个人会把它加回来 ✗）');
	});

	test('★★ 不再有"用哪个 UI"的开关（没人读的配置 = 假配置 ✗）', () => {
		const cfg = read(DSH_CONTRIB);
		assert.ok(!cfg.includes('SessionHistoryUi'), '配置注册里不该再有该键 ✗');
		const src = read(CONTRIB);
		assert.ok(!src.includes('sessionHistoryUi'), '视图注册里不该再有 when 判据 ✗');
	});

	test('★ aux 窗口侧栏也用同一个宿主（否则两个窗口两套 UI）', () => {
		const aux = read(AUX);
		assert.ok(/createInstance\(DshPluginViewPane, 'vssaros\.dsh\.sessions'/.test(aux),
			'独立聊天窗口的侧栏必须同源 ✗');
		assert.ok(!/^\s*import\s+.*SessionHistoryViewPane/m.test(aux), '不许再在 aux 里用自绘列表 ✗');
	});
});

suite('会话插件页 · 动作面', () => {

	test('★ 点行 / 双击行 = 打开该会话（走桥 openSession，不私自切；必须带上 preset + cwd）', () => {
		const src = read(PAGE);
		assert.ok(src.includes("data-session-id"), '行必须带会话 id（脚本靠它取 id）✗');
		assert.ok(/\.sv-item\[data-session-id\]/.test(src), '必须选中可点的行 ✗');
		// ★ 判别力：`includes('openSession')` 在"注释里提到但没调用"时也为真 ⇒ 断言**调用**形态
		// 2026-10-19（用户报「双击会话 item 后打不开对应的聊天框」）：调用必须把 **preset + cwd** 一起交上去
		// —— 宿主靠 cwd 先 `session.start` 幂等接管历史会话，否则换绑后页面仍卡在「正在打开会话…」。
		assert.ok(/b\.openSession\(id, /.test(src), '必须**真的调用**桥的 openSession ✗');
		assert.ok(/el\.getAttribute\('data-preset'\)/.test(src), 'openSession 必须带 preset ✗');
		assert.ok(/el\.getAttribute\('data-cwd'\)/.test(src), 'openSession 必须带 cwd（历史会话要能被接管）✗');
		// 双击也要能开：dblclick 之前浏览器会先发两次 click ⇒ 必须有去抖，不能发两遍
		assert.ok(src.includes("addEventListener('dblclick'"), '必须绑 dblclick ✗');
		assert.ok(/lastOpenAt/.test(src), '必须有去抖（否则一次双击 = 两次 openSession）✗');
	});

	test('★ 右键「重命名会话」：就地输入 → 桥 renameSession（带 preset/cwd）→ 回读真值确认，失败回滚', () => {
		const page = read(PAGE);
		assert.ok(/item\('重命名会话…', function \(\) \{ startRename\(el\); \}\)/.test(page),
			'右键菜单里必须有「重命名会话」，且真的启动就地改名 ✗');
		assert.ok(/b\.renameSession\(id, next, \{/.test(page), '必须**真的调用**桥的 renameSession ✗');
		assert.ok(/data-sessions-api/.test(page), '必须回读服务端真值（api/sessions）确认改名 ✗');
		assert.ok(/titleEl\.textContent = prevText/.test(page), '失败必须回滚标题（不许假成功 ✗）');
		assert.ok(/\.sv-rename \{/.test(page), '输入框要有样式 ✗');
	});

	test('★ 顶部「＋ 新建会话」按钮存在且走桥 newChat', () => {
		const src = read(PAGE);
		assert.ok(/id="sv-new"/.test(src), '要有新建按钮 ✗');
		assert.ok(/getElementById\('sv-new'\)/.test(src), '按钮必须**绑上事件**（画了不绑 = 点了没反应 ✗）');
		assert.ok(/b\.newChat\(\)/.test(src), '必须**真的调用**桥的 newChat（页面开不了编辑器 ⇒ 交宿主）✗');
	});

	test('★ 桥不在 / 过旧 ⇒ 如实提示，不许静默', () => {
		const src = read(PAGE);
		assert.ok(src.includes('当前宿主不支持从会话页打开会话'), '打开：桥缺失要提示 ✗');
		assert.ok(src.includes('当前宿主不支持从会话页新建会话'), '新建：桥缺失要提示 ✗');
	});

	test('★ 固定（pin）：星由服务端渲染、点击真落盘（prefs）、失败回滚、且不许顺带打开会话', () => {
		const src = read(PAGE);
		assert.ok(/class="sv-pin" role="button" tabindex="0" data-pin=/.test(src),
			'星必须由服务端渲染（初始态来自 prefs，否则另一个窗口看不见 ✗）');
		assert.ok(/pin\.addEventListener\('click', function \(e\) \{ e\.stopPropagation\(\); toggle\(\); \}\)/.test(src),
			'★ 固定按钮必须 stopPropagation —— 否则点一下既固定又打开会话 ✗');
		assert.ok(/postPrefs\(\{ togglePin: id \}\)/.test(src), '必须真的落盘（POST api/prefs）✗');
		assert.ok(/prefsState\.pinned = before/.test(src), '写失败必须回滚（乐观到底 = 假成功 ✗）');
		// 固定项不受 5 条配额折叠（埋起来就失去意义）
		assert.ok(/pinList\.indexOf\(el\.getAttribute\('data-session-id'\)\) >= 0/.test(src),
			'固定项必须免于配额折叠 ✗');
	});

	test('★★ 按工作区分组**支持多根**：主根 + 关联根下的会话归到同一组（从前按 cwd 拆成多块 ✗）', () => {
		const list = read(LIST_CORE);
		assert.ok(list.includes('workspaceRoots'), '分组必须接受工作区根集合 ✗');
		// 前缀边界：`F:\\a` 不能把 `F:\\ab` 也算进去（否则别的项目被吞进这个工作区 ✗）
		assert.ok(/c === n \|\| c\.startsWith\(n \+ '\/'\)/.test(list), '必须按**路径边界**匹配根（不是裸 startsWith）✗');
		// ★ 2026-10-19 口径反转（用户报「工作区 item，鼠标滑过后显示多根内容」）：
		//   组头副文本**只放主根**，整串根不再 join 进去（窄侧栏里会被截成一坨看不懂的省略号，
		//   还一路进 title ⇒ 鼠标一停就弹一大坨）。完整清单走 roots 字段，由渲染层画「+N」徽标。
		assert.ok(/path: primary, roots/.test(list), '组头副文本只放主根；完整根集合走 roots 字段 ✗');
		assert.ok(!/path: roots\.join\(' · '\)/.test(list), '不许再把多根拼进组头副文本 ✗');
		// 不传根集合 ⇒ 行为不变（老调用点/测试不受影响 ✓）
		assert.ok(/options\.workspaceRoots/.test(list), '必须是可选项（不传就走原 cwd 分组）✗');
		// 页面侧（2026-10-19 用户要求「多根要显示根的数量，hover 显示详情」）：
		//   徽标文本 = **根的总数**（不是"多出来的个数"），详情挂在 data-roots 上由脚本弹浮层，
		//   title 只作无脚本兜底 ⇒ 三条都要在。
		const page = read(PAGE);
		assert.ok(/class="sv-group-roots"/.test(page), '多根必须有「N 根」徽标（否则用户完全看不出这是多根工作区）✗');
		assert.ok(/\$\{roots\.length\} 根/.test(page), '徽标文本必须是**根的总数**（从前是 +N = 多出来的个数，用户要的是总数）✗');
		assert.ok(/data-roots="\$\{escapeHtml\(roots\.join\('\\n'\)\)\}"/.test(page), '每个根的完整路径必须落在 data-roots 上（浮层数据源）✗');
		assert.ok(/sv-group-roots" role="note" tabindex="0"/.test(page), '徽标要可聚焦（键盘也能看详情）+ 有语义 ✗');
		assert.ok(/sv-group-roots[^>]*title="\$\{escapeHtml\(rootsTip\)\}"/.test(page), 'title 要保留（无脚本时的兜底）✗');
	});

	test('★★ 页面只画**一个**标题（重复标题是用户报障点，壳已经画了 titile/subtitle）', () => {
		const page = read(PAGE);
		assert.ok(!/class="dsh-header"[\s\S]{0,80}<h1>/.test(page), 'body 里不许再写第二个 h1 ✗');
		// 壳负责唯一那份标题
		// ★ 2026-10-21（磁贴视图）：标题按视图切换（列表/磁贴）⇒ 字面量写法变成三元表达式，
		//   但**唯一来源**这条不变（标题只能来自 renderShell 的参数 ✗）。
		assert.ok(/title: isTiles \? '会话磁贴（仅 dsh）' : '历史会话（仅 dsh）'/.test(page),
			'标题在 renderShell 的参数里（唯一来源）✗');
	});

	test('★★ 会话条目**可展开**：行首 ▶ 展开详情，点行其它位置仍是打开会话（不串味）', () => {
		const page = read(PAGE);
		assert.ok(/class="sv-detail" hidden/.test(page), '每条要有默认收起的详情块 ✗');
		assert.ok(/data-exp="1"/.test(page), '行首箭头要标出自己是"展开"控件 ✗');
		assert.ok(/arrow\.addEventListener\('click', function \(e\) \{ e\.stopPropagation\(\); toggleDetail\(\); \}\)/.test(page),
			'★ 展开必须 stopPropagation —— 否则点箭头会顺带打开会话 ✗');
		assert.ok(/sv-k">工作目录/.test(page), '详情要显示工作目录（多根场景下这是判断归属的关键）✗');
		// 诚实：详情不含消息正文（正文在 zstd 会话日志里，本页读不到）
		assert.ok(page.includes('不含消息正文'), '注释/文案必须说明"看不到消息正文" ✗');
	});

	test('★★ 组头不重叠：组名可压缩、路径必须能省略（flex 子项缺 min-width:0 就会压到组名上 ✗）', () => {
		const page = read(PAGE);
		const css = page.slice(page.indexOf('.sv-group-name {'));
		assert.ok(/\.sv-group-name \{[^}]*min-width: 0/.test(css), '组名必须 min-width:0（允许被压缩）✗');
		assert.ok(/\.sv-group-path \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/.test(css),
			'路径必须 min-width:0 + 省略号（长路径否则溢出压到组名上 ✗）');
	});

	test('★★ 展开能看到**用户消息**（多帧 zstd 逐帧解；只取人类 user/message）', () => {
		const log = read(SESSION_LOG);
		assert.ok(log.includes('zstdDecompressSync'), '要解 zstd ✗');
		assert.ok(log.includes('ZSTD_MAGIC') && log.includes('offsets'), '必须按魔数**切帧**（同步解压只解第一帧 ✗）');
		assert.ok(/evt\.type !== 'user\/message'/.test(log), '只取 user/message ✗');
		assert.ok(/kind !== 'user'/.test(log), '非人类来源（工具/系统）不算用户消息 ✗');
		assert.ok(/slice\(-limit\)/.test(log), '取**最后** N 条（最近的更有用）✗');
		// 读不到要如实返回（不许编造内容）
		assert.ok(log.includes("reason: 'log-missing'"), '缺日志必须给出 reason（页面据此说"暂无"）✗');
	});

	test('★★ pin / 最近使用落 prefs.json（跨窗口一致；localStorage 是分区级的 ✗）', () => {
		const prefs = read(PREFS);
		// 原子写：tmp + rename（否则写一半崩掉会让下次读退化成空偏好 ⇒ 用户的 pin 全丢 ✗）
		assert.ok(/file \+ '\.tmp'/.test(prefs), '必须写临时文件 ✗');
		assert.ok(/renameSync\(tmp, file\)/.test(prefs), '必须 rename 覆盖（原子）✗');
		assert.ok(/catch \{\s*return normalizePrefs\(undefined\)/.test(prefs), '读坏必须降级成空偏好（不抛）✗');
		assert.ok(/MAX_PINNED = 500/.test(prefs) && /MAX_RECENT = 20/.test(prefs), '必须有上限（脏数据不许无限滚）✗');
		// 页面：pin 状态由服务端注入，写入走 POST
		const page = read(PAGE);
		assert.ok(/data-prefs-api=/.test(page), '要把 prefs API 路径交给页面 ✗');
		assert.ok(/data-prefs="\$\{escapeHtml\(JSON\.stringify/.test(page), '要把 pinned/recent 注入首屏（否则又要靠 localStorage ✗）');
		assert.ok(/pathname === `\$\{ROUTE_PREFIX\}\/api\/prefs`/.test(page), '要有写入端点 ✗');
		assert.ok(/writePrefs\(dshHome, cur\)/.test(page), '写入必须走原子写函数 ✗');
		assert.ok(!/localStorage\.setItem\('vssaros-sessions-pinned'/.test(page), '不许再写 localStorage ✗');
	});

	test('★★ 键盘导航 + 右键菜单（↑↓ 选、Enter 打开、Space 展开；右键＝打开/固定/复制 id）', () => {
		const page = read(PAGE);
		assert.ok(/e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/.test(page), '↑↓ 要能选 ✗');
		assert.ok(/e\.key === 'Enter'/.test(page) && /items\[kbdIndex\]\.click\(\)/.test(page), 'Enter 打开 ✗');
		assert.ok(/e\.key === ' '/.test(page) && /querySelector\('\.sv-arrow'\)/.test(page), 'Space 展开详情 ✗');
		assert.ok(/is-kbd/.test(page), '选中项要有高亮类 ✗');
		assert.ok(/addEventListener\('contextmenu'/.test(page), '右键菜单 ✗');
		assert.ok(/复制会话 id/.test(page) && /clipboard\.writeText/.test(page), '右键要能复制会话 id ✗');
		assert.ok(/sv-ctx-item/.test(page) && /\.sv-ctx \{/.test(page), '菜单的 DOM 与样式都要有（只有 DOM 没样式会裸奔 ✗）');
	});

	test('★★ 未命名会话用**首条用户消息**当标题（列表区分度的根因）', () => {
		const list = read(LIST_CORE);
		assert.ok(/session\?\.firstPrompt/.test(list), 'displayTitleOf 必须用 firstPrompt 兜底 ✗');
		const page = read(PAGE);
		assert.ok(/readFirstPrompt/.test(page), '页面要按需读首条消息 ✗');
		// ⚠ 2026-10-20：这段从 `pageHtml` 搬进 `prefillFirstPrompts`（async，读盘/解压不许占主线程），
		//   预算写法从 `let budget = 40;` 变成默认参数 `{ budget = 40 }` ⇒ 断言不能钉死旧形态。
		assert.ok(/budget = 40\b/.test(page), '必须限预算（否则 300 条全读 ⇒ 首屏卡死 ✗）');
		assert.ok(/FIRST_PROMPT_CACHE/.test(page), '必须带进程内缓存（切分组/搜索不该重复解压日志 ✗）');
		assert.ok(/if \(row\.title\) \{ continue; \}/.test(page), '已有标题的会话不该再读日志 ✗');
		// 读法要省：只解前 24 帧，且 firstUserMessageOf 找到第一条就 return
		const log = read(SESSION_LOG);
		assert.ok(/maxFrames = 24/.test(log), 'readFirstPrompt 必须只解前 24 帧 ✗');
		assert.ok(/return text\.length > maxChars/.test(log), 'firstUserMessageOf 必须**提前返回**（不遍历全文）✗');
	});

	test('★★ 稿 B（用户选定）：顶部有**工作区范围**、组头有「等你 N」、行里不再有 cache/live', () => {
		const page = read(PAGE);
		assert.ok(/class="sv-dd"/.test(page), '顶部要有下拉（展示范围 / 分组方式各一个）✗');
		// ★ 2026-10-21（磁贴视图）：链接多了 `view` 参数（列表/磁贴共用同一批 visibleRows ⇒ 切视图不能
		//   丢当前的 scope/groupBy）⇒ 断言要钉住"仍是链接 + 仍带 scope/all&groupBy"。
		assert.ok(/\?view=\$\{view\}&scope=all&groupBy=/.test(page), '范围切换要用链接（服务端渲染，无 JS 也能用）✗');
		assert.ok(/分组：\$\{by === 'bot' \? '按 Bot' : '按工作区'\}/.test(page), '分组方式要收进下拉（别和范围 chip 混一行 ✗）');
		assert.ok(/url\.searchParams\.get\('scope'\) === 'current' \? 'current' : 'all'/.test(page),
			'★ 默认必须是 all —— 默认 current 会让其它工作区的会话消失（用户以为丢数据 ✗）');
		assert.ok(/sv-group-awaiting/.test(page) && /isAwaitingSession/.test(page), '组头要有「等你 N」（必须马上处理的那类）✗');
		assert.ok(!/sv-source/.test(page), '行内 cache/live 是内部术语 ⇒ 必须去掉 ✗');
	});

	test('★★ 展开消息：条数多时默认折叠为「最近 5 条 + 展开全部」，序号按全量计', () => {
		const page = read(PAGE);
		assert.ok(/var FOLD = 5;/.test(page), '折叠阈值必须是 5 ✗');
		assert.ok(/展开全部 ' \+ list\.length \+ ' 条/.test(page), '要有「展开全部 N 条」✗');
		assert.ok(/var start = \(!showAll && list\.length > FOLD\) \? list\.length - FOLD : 0;/.test(page),
			'★ 折叠时从 list.length - FOLD 开始（序号按全量，别让 #1 冒充第一句 ✗）');
		assert.ok(/'#' \+ \(i \+ 1\)/.test(page), '序号用全量下标 ✗');
	});

	test('★★ 展开要看到**每一条**用户输入（默认不截条数，页面也不传 limit）', () => {
		const log = read(SESSION_LOG);
		assert.ok(/limit = 0/.test(log), 'userMessagesOf 默认必须 0 = 全部 ✗');
		assert.ok(/limit > 0 \? out\.slice\(-limit\) : out/.test(log), '只有显式传正数才截断 ✗');
		const page = read(PAGE);
		// ★ 判别力：只匹配 `?id=…` 前缀的话，后面加回 `&limit=5` 仍会通过（假绿 ✗）
		//   ⇒ 必须钉住"`)` 紧接 `, { credentials`"这个完整形态。
		assert.ok(/fetch\(apiBase \+ '\?id=' \+ encodeURIComponent\(id\), \{ credentials/.test(page),
			'★ 页面请求**不许**再带 &limit=（用户要求看到每一条输入 ✗）');
		assert.ok(/'#' \+ \(i \+ 1\)/.test(page), '消息要带序号（好对照第几次输入）✗');
		assert.ok(/共 ' \+ list\.length \+ ' 条用户消息/.test(page), '要显示总条数 ✗');
		// 条数可能很多 ⇒ 容器必须限高滚动，别把侧栏撑爆
		assert.ok(/\.sv-msgs \{[^}]*max-height: 300px[^}]*overflow-y: auto/.test(page), '消息容器要限高滚动 ✗');
	});

	test('★ 消息是**懒加载**的：展开才请求 api/messages，首屏不读日志', () => {
		const page = read(PAGE);
		assert.ok(/api\/messages/.test(page), '必须有消息 API 路径 ✗');
		assert.ok(/readUserMessages/.test(page), '路由必须真的读日志 ✗');
		assert.ok(/function loadMessages\(\)/.test(page), '页面要有懒加载入口 ✗');
		assert.ok(/data-api=/.test(page), 'API 绝对路径要由服务端注入（相对路径在无尾斜杠时会算错 ✗）');
	});

	test('★ 只剩一个入口（定稿）：插件页标题写明"仅 dsh"，IDE 侧不再有"(All)"那套', () => {
		const page = read(PAGE);
		assert.ok(page.includes('历史会话（仅 dsh）'), '标题必须写明范围（现在它是**唯一**入口）✗');
		assert.ok(page.includes('仅 dsh 会话'), '诊断行必须写明范围 ✗');
		// 曾经指向"另一个入口"的文案必须撤掉：那个入口已经不存在 ⇒ 指向它就是假话 ✗
		assert.ok(!page.includes('Session History (All)'), '不许再指向已退休的 IDE 自绘列表 ✗');
		const contrib = read(CONTRIB);
		assert.ok(!contrib.includes('Session History (All)'), 'IDE 侧不再有"全部"视图 ✗');
	});

	test('★ 文案不再自称"只读"（已经有动作了 ⇒ 写只读就是假话）', () => {
		const src = read(PAGE);
		assert.ok(!src.includes('dsh 投影（只读）'), '标题/副标题不许还写"只读" ✗');
		assert.ok(!src.includes('只读 · ${scan.rows.length}'), '诊断行不许还写"只读" ✗');
		assert.ok(src.includes('点一行打开'), '要如实写明能做什么 ✓');
	});
});
