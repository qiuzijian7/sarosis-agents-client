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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGINS = 'g:/SarosWorkspace/sarosis-agents-client/dsh-plugins';
/** 已迁到共享层的工作台（每迁完一个就把包名加进来）。 */
// ⚠ 2026-10-23：**vssaros-dashboard 暂时移出白名单** —— 另一条会话正在重写它
//   （`exports['./client']` 指向的 `lib/client.js` 曾一度不存在）⇒ 入列会让本守卫对别人的半成品报红。
//   等它重写落地、重新有工作台组件后**再加回来**。
const UNIFIED = ['vssaros-workflow', 'vssaros-kanban', 'vssaros-memory', 'vssaros-codebase', 'vssaros-kb', 'vssaros-agents', 'vssaros-scheduler', 'vssaros-xhs-note'];

/**
 * 欠账清单：**按条款**登记（不是整包放水 —— 只有列出的条款失败才不计入退出码）。
 * 每条必须写「为什么 + 何时摘除」；修好后删掉对应行/键。
 */
const PENDING = {
	'vssaros-kb': {
		rules: ['S9'],
		reason: '2026-10-24 20:33 另一条会话正在重构 kb（面板合并进 lib/client.js：KbWorkbenchPanel），'
			+ '组件文件在 client.js / client.kb.js 之间漂移 ⇒ 本轮只差 @container，等它落地后一起补并删掉本条',
	},
	// 2026-10-24：workflow / memory / codebase / agents 已各自补上 `test/run-*.mjs` ⇒ 欠账清零（别再登记回来）。
};

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
	// 组件文件 = 「含 register」的候选里 **wb-* 用得最多**的那个
	//   （2026-10-24：kb 把面板合并进 client.js 后入口也含 register ⇒ 取第一个会查错文件）
	const component = files.map((p) => ({ p, text: stripComments(readFileSync(p, 'utf8')) }))
		.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
		.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
	if (!component) { fail('S5', `${dirName}: 找不到工作台组件（含 desktopWorkbenches.register）`); }
	else {
		const src = component.text;
		const name = component.p.slice(PLUGINS.length + 1);

		// S6 共享原语用量
		// ⚠ 统计口径：**扫 token**，不是扫「独立成串」的类名。
		//   2026-10-24 踩过：scheduler 改用 `className: 'vss wb wb-toolbar'`（多类名串）后，
		//   旧正则 `'wb-xxx'` 只数得到 8 个 ⇒ 误判「没在用共享层」✗（真实是 11 个）。
		const wbClasses = new Set(src.match(/\bwb(?:-[a-z0-9]+)*\b/g) ?? []);
		if (wbClasses.size < MIN_WB_CLASSES) { fail('S6', `${name}: 只用到 ${wbClasses.size} 个 wb-* 类（<${MIN_WB_CLASSES}）⇒ 没在用共享层`); }
		else { ok(`${name}: 用了 ${wbClasses.size} 个 wb-* 原语 ✓`); }

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

		// 工具条锚点恰好 1 个
		const toolbar = (src.match(/data-dsh-workbench-toolbar/g) ?? []).length;
		if (toolbar !== 1) { fail('TOOLBAR', `${name}: data-dsh-workbench-toolbar 应恰好 1 个，实际 ${toolbar}`); }
		else { ok(`${name}: 工具条锚点唯一 ✓`); }

		// S9 容器查询：工作台不只跑在全窗里，还会被塞进 IDE 侧栏 / dsh 右栏（320–420px）
		if (!/@container/.test(src)) { fail('S9', `${name}: 没有 @container（窄栏里不会重排 ⇒ 横向溢出 / 字竖排）`); }
		else { ok(`${name}: 有容器查询 @container ✓`); }

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
	problems += blocking;
	if (pkgFails.length && allowed.size) {
		console.log(`  ⚠ ${dirName}: ${pkgFails.length} 项未达标，其中 ${allowed.size} 类已登记欠账 ⇒ 不计入退出码 —— ${PENDING[dirName].reason}`);
	}
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
