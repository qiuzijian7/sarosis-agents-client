// 工作台**视觉/结构统一**守卫（2026-10-22 起；2026-10-24 扩到 8 条）。
//
// 为什么需要：7 个自有工作台曾经各写一套 CSS（7 套类前缀 + 大量裸色值）⇒ 7 种视觉语言，而且裸色值
// 不随 dsh 主题切换（令牌在 `body` / `body[data-ds-dark-theme]` 下各有一套值，裸色只有一套）✗。
//
// 判据（只查**已统一**的包 —— 见 UNIFIED；逐个迁移、逐个入列，绝不空转）：
//   S6  组件里 ≥10 个不同的 `wb-*` 类（证明真在用共享层）
//   S7  不出现裸色值（`#hex` / `rgba()` / `hsl()`），除非在 `var(--…, <兜底>)` 里
//   S8  根节点带 `data-vssaros-surface="workbench"`
//   --  恰好 1 个 `data-dsh-workbench-toolbar`（宿主据此吸顶）
//   S9  有 `@container`（会被塞进 320–420px 的 sideview / 右栏 ⇒ 必须按**容器**响应）
//   S11 ≥3 个不同的 `data-*` 锚点（探针只认锚点；类名属视觉层）
//   S12 零 iframe（宿主渲染的 React，不是嵌页面）
//   S15 包内有自检（`test/*.mjs`）—— 家族探针 `poc/dsh-p0/scripts/p3-*` 不算：装出去就没了
//
// ★ 2026-10-28 新增「**原生承载型**」分支（scheduler 0.3.0 起）：
//   有些工作台不画 UI，而是把**官方现成页面**搬进来（scheduler = 官方 `dsh-client-ui-schedule`
//   的 chunk 副本，只把 apply() 换成 desktopWorkbenches.register）。UI 不是我们写的 ⇒
//   S6（wb-* 用量）/ TOOLBAR（工具条锚点）/ S9（@container）三条**不适用**（官方页自带 h1、
//   自带 CSS）。改用三条专用断言，防止"搬运"变成绕开统一约定的口子：
//   N1 出处 + 许可必须写明（`@deepseek-ai/dsh-client-ui-schedule` + MIT）
//   N3 子块必须真的被入口 `require.async` 装载并调 `install(`（否则装了等于没装）
//   N4 `customFrame: false` 时 `headerLayout` 必须是 `default`（否则宿主 warn 一次并回退）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGINS = 'g:/SarosWorkspace/sarosis-agents-client/dsh-plugins';
/** 已迁到共享层的工作台（每迁完一个就把包名加进来）。 */
// ⚠ 2026-10-23：**vssaros-dashboard 暂时移出白名单** —— 另一条会话正在重写它
//   （`exports['./client']` 指向的 `lib/client.js` 曾一度不存在）⇒ 入列会让本守卫对别人的半成品报红。
//   等它重写落地、重新有工作台组件后**再加回来**。
const UNIFIED = ['vssaros-workflow', 'vssaros-kanban', 'vssaros-memory', 'vssaros-codebase', 'vssaros-kb', 'vssaros-agents', 'vssaros-scheduler'];

/**
 * 欠账清单：**按条款**登记（不是整包放水 —— 只有列出的条款失败才不计入退出码）。
 * 每条必须写「为什么 + 何时摘除」；修好后删掉对应行/键。
 */
const PENDING = {
	'vssaros-kb': {
		rules: ['S7', 'S8', 'TOOLBAR', 'S9'],
		// 2026-10-24 21:20 查明：`client.kb.js`（47KB）已被整段并进 `client.js`（文件头第 3 行明写"不再用子块"）
		//   ⇒ 那是**死文件**，旧的"全部达标"是查死代码得出的。活组件（client.js 的 KbWorkbenchPanel）缺：
		//   surface 标记、toolbar 锚点、@container，外加 21 行内联 style 裸色（rgba(127,127,127,.25) 一类）。
		//   这四处都在**另一条会话正在重构的文件里**（66KB），我不代改；等它收尾后按下面四处补齐并删掉本条。
		reason: 'kb 把面板合并进 client.js 后丢了 surface 标记 / toolbar 锚点 / @container，'
			+ '且 21 行内联 style 是裸色 ⇒ 待其重构收尾后补齐（顺带删掉死文件 client.kb.js）',
	},
	// 2026-10-24：workflow / memory / codebase / agents 已各自补上 `test/run-*.mjs` ⇒ 欠账清零（别再登记回来）。
};

// `--strict`：把 PENDING 也当失败（收尾/CI 用；平时让"别人正在改的包"不阻塞其他人）
const STRICT = process.argv.includes('--strict');
const debts = [];
const MIN_WB_CLASSES = 10;
/** 机器锚点下限：少于这个数，探针就只能靠类名（类名会被 UI 统一换掉）。 */
const MIN_ANCHORS = 3;
let problems = 0;
const ok = (msg) => console.log('  ✓ ' + msg);

const walk = (dir, out = []) => {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'test' || name === 'vendor') { continue; }
		const p = join(dir, name);
		if (statSync(p).isDirectory()) { walk(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
};
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('[check-workbench-style] 工作台视觉/结构统一守卫');
for (const dirName of UNIFIED) {
	const allowed = new Set(PENDING[dirName]?.rules || []);
	const pkgFails = [];
	const fail = (rule, msg) => {
		const downgraded = allowed.has(rule);
		pkgFails.push({ rule, downgraded });
		console.log(`  ${downgraded ? '⚠' : '✗'} ${msg}`);
	};

	const libDir = join(PLUGINS, dirName, 'lib');
	const files = walk(libDir);
	// 组件文件怎么选（2026-10-24 修，**别再退回"wb-* 最多"这种启发式**）：
	//   ① 入口自己就 `register(` ⇒ 组件就是入口（kb 把面板整段并进 client.js 后属这种）；
	//   ② 否则看入口 `require.async('./client.X.js')` 装载的那个子块；
	//   ③ 都没有才退回「候选里 wb-* 最多」。
	// 为什么：kb 合并后 `client.kb.js` 成了**死文件**（47KB，没人 require），
	//   而"wb-* 最多"会选中死文件 ⇒ 守卫对着死代码给结论（既漏了活文件的 21 处裸色，也漏了它的 @container 缺失）。
	const entryPath = join(PLUGINS, dirName, 'lib', 'client.js');
	const entryText = existsSync(entryPath) ? stripComments(readFileSync(entryPath, 'utf8')) : '';
	const loadedChunks = [...entryText.matchAll(/require\.async\(\s*['"]\.\/(client\.[\w-]+\.js)['"]\s*\)/g)].map((m) => m[1]);
	const candidates = files.map((p) => ({ p, text: stripComments(readFileSync(p, 'utf8')) }))
		.filter((x) => /desktopWorkbenches\.register\(/.test(x.text));
	const byName = (name) => candidates.find((x) => x.p.split(/[\\/]/).pop() === name);
	const component = (entryText && /desktopWorkbenches\.register\(/.test(entryText)
		? { p: entryPath, text: entryText }
		: null)
		|| loadedChunks.map(byName).find(Boolean)
		|| candidates.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
	if (!component) { fail('S5', `${dirName}: 找不到工作台组件（含 desktopWorkbenches.register）`); }
	else {
		const src = component.text;
		const name = component.p.slice(PLUGINS.length + 1);
		/**
		 * 原生承载型：UI 是官方页面副本（不是我们画的）。判据 = 文件里有搬运 region 标记
		 * （`//#region vssaros: native workbench adapter`）—— 自绘组件不会写这行。
		 * ⚠ 必须用**原文**判：`src` 是 stripComments 之后的，region 标记与 MIT 说明都是 `//` 注释 ⇒ 被删掉了。
		 */
		const raw = readFileSync(component.p, 'utf8');
		const nativeHost = /#region\s+vssaros:\s*native workbench adapter/.test(raw);

		if (nativeHost) {
			// N1 出处 + 许可（否则"搬运"无法核实来源，也无法判断升级时该跟哪份）
			if (!/@deepseek-ai\/dsh-client-ui-schedule/.test(raw) || !/\bMIT\b/.test(raw)) {
				fail('N1', `${name}: 原生承载型缺出处/许可说明（要写 @deepseek-ai/dsh-client-ui-schedule + MIT）`);
			} else { ok(`${name}: 原生承载型，出处与许可已写明 ✓`); }
			// N3 子块真被入口装载（否则插件装了、工作台永远不出现，且宿主不报错）
			const chunkName = component.p.split(/[\\/]/).pop();
			const wired = loadedChunks.includes(chunkName) && /\.install\(/.test(entryText);
			if (!wired) { fail('N3', `${dirName}: 原生承载子块 ${chunkName} 没有被入口 require.async 装载并调 install() ⇒ 装了等于没装`); }
			else { ok(`${dirName}: 入口装载原生子块并调 install() ✓`); }
			// N4 外壳契约：customFrame=false 却声明 compact ⇒ 宿主 warn 一次并回退默认布局
			try {
				const wb = JSON.parse(readFileSync(join(PLUGINS, dirName, 'package.json'), 'utf8')).vssaros?.workbench || {};
				const layout = wb.headerLayout || 'default';
				if (wb.customFrame !== true && layout === 'compact') { fail('N4', `${dirName}: customFrame=false 但 headerLayout=compact ⇒ 宿主会 warn 并回退`); }
				else { ok(`${dirName}: customFrame/headerLayout 契约一致 ✓`); }
			} catch (error) { fail('N4', `${dirName}: 读不到 package.json 的 vssaros.workbench（${String(error && error.message || error)}）`); }
			// 原生承载型不做 S6/S9/TOOLBAR（官方页自带标题与 CSS）；S7/S8/S11/S12 照旧在下面跑。
			ok(`${name}: 原生承载型 ⇒ S6/S9/TOOLBAR 不适用（官方页自带标题与样式）`);
		} else {
			// S6 共享原语用量
			// ⚠ 统计口径：**扫 token**，不是扫「独立成串」的类名。
			//   2026-10-24 踩过：scheduler 改用 `className: 'vss wb wb-toolbar'`（多类名串）后，
			//   旧正则 `'wb-xxx'` 只数得到 8 个 ⇒ 误判「没在用共享层」✗（真实是 11 个）。
			const wbClasses = new Set(src.match(/\bwb(?:-[a-z0-9]+)*\b/g) ?? []);
			if (wbClasses.size < MIN_WB_CLASSES) { fail('S6', `${name}: 只用到 ${wbClasses.size} 个 wb-* 类（<${MIN_WB_CLASSES}）⇒ 没在用共享层`); }
			else { ok(`${name}: 用了 ${wbClasses.size} 个 wb-* 原语 ✓`); }
		}

		// S7 裸色值：允许 `var(--x, #hex)` 兜底 —— 判据 = 该行有 `var(--` 就不算裸
		const bare = [];
		for (const line of src.split('\n')) {
			if (/var\(--/.test(line)) { continue; }
			if (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(line) || /\b(rgba?|hsla?)\(/.test(line)) { bare.push(line.trim().slice(0, 80)); }
		}
		if (bare.length) { fail('S7', `${name}: ${bare.length} 行裸色值（颜色必须走 --dsw-alias-* 令牌）\n      ` + bare.slice(0, 3).join('\n      ')); }
		else { ok(`${name}: 无裸色值 ✓`); }

		// S8 宿主渲染标记
		if (!/data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src)) { fail('S8', `${name}: 缺 data-vssaros-surface="workbench"`); }
		else { ok(`${name}: 有 data-vssaros-surface="workbench" ✓`); }

		// 工具条锚点恰好 1 个（原生承载型由官方页自带 <h1>，外壳走 default 布局 ⇒ 不要求）
		if (!nativeHost) {
			const toolbar = (src.match(/data-dsh-workbench-toolbar/g) ?? []).length;
			if (toolbar !== 1) { fail('TOOLBAR', `${name}: data-dsh-workbench-toolbar 应恰好 1 个，实际 ${toolbar}`); }
			else { ok(`${name}: 工具条锚点唯一 ✓`); }

			// S9 容器查询：工作台不只跑在全窗里，还会被塞进 IDE 侧栏 / dsh 右栏（320–420px）
			if (!/@container/.test(src)) { fail('S9', `${name}: 没有 @container（窄栏里不会重排 ⇒ 横向溢出 / 字竖排）`); }
			else { ok(`${name}: 有容器查询 @container ✓`); }
		}

		// S11 机器锚点
		const anchors = new Set(src.match(/data-[a-z0-9-]{3,30}/g) ?? []);
		if (anchors.size < MIN_ANCHORS) { fail('S11', `${name}: 只有 ${anchors.size} 个 data-* 锚点（<${MIN_ANCHORS}）⇒ 探针只能靠类名`); }
		else { ok(`${name}: ${anchors.size} 个 data-* 锚点 ✓`); }

		// S12 零 iframe（唯一例外是「承载外部站点」，那种包不进本白名单）
		if (/<iframe|createElement\(['"]iframe/.test(src)) { fail('S12', `${name}: 组件里有 iframe（工作台应是宿主渲染，不是嵌页面）`); }
		else { ok(`${name}: 零 iframe ✓`); }
	}

	// S15 包内自检：`test/*.mjs` **或** `scripts/check-*.mjs`（kb 的自检一直在 scripts/ 下，也算）
	const hasTest = walk2(join(PLUGINS, dirName, 'test')).some((f) => f.endsWith('.mjs'))
		|| walk2(join(PLUGINS, dirName, 'scripts')).some((f) => /check[-.]/.test(f.split(/[\\/]/).pop() || '') && f.endsWith('.mjs'));
	if (!hasTest) { fail('S15', `${dirName}: 没有包内自检（test/*.mjs）⇒ 装出去的包没有可跑的验收`); }
	else { ok(`${dirName}: 有包内自检 ✓`); }

	const blocking = pkgFails.filter((f) => !f.downgraded).length;
	const downgraded = pkgFails.filter((f) => f.downgraded).length;
	problems += STRICT ? blocking + downgraded : blocking;
	if (downgraded) { debts.push({ dirName, count: downgraded, rules: [...allowed] }); }
	if (pkgFails.length && allowed.size) {
		console.log(`  ⚠ ${dirName}: ${pkgFails.length} 项未达标，其中 ${downgraded} 项已登记欠账 ⇒ ${STRICT ? '**--strict 下仍计入失败**' : '不计入退出码'} —— ${PENDING[dirName].reason}`);
	}
}

// 欠账要**一直可见**：不然"已登记"会慢慢变成"没人管"。
if (debts.length) {
	const total = debts.reduce((sum, d) => sum + d.count, 0);
	console.log(`\n[check-workbench-style] ⚠ 欠账合计 ${total} 项：` + debts.map((d) => `${d.dirName}(${d.rules.join('/')}×${d.count})`).join('，'));
}

/** 列目录下所有文件（用于 test/ 目录；不递归进 node_modules）。 */
function walk2(dir, out = []) {
	if (!existsSync(dir)) { return out; }
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules') { continue; }
		const p = join(dir, name);
		if (statSync(p).isDirectory()) { walk2(p, out); } else { out.push(p); }
	}
	return out;
}

console.log(problems ? `\n[check-workbench-style] ✗ ${problems} 项问题` : '\n[check-workbench-style] ✓ 共享层 / 结构约定通过');
process.exit(problems ? 1 : 0);
