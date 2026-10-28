// check-plugin-files.mjs ★ 插件打包白名单（files）+ 已装完整性 守卫
//
// 为什么必须有（2026-10-22 实锤）：dsh 插件的 package.json 有 files 白名单，
// 走 pnpm file: 安装时**只拷清单里的文件**。新增源文件却忘了加进清单
// ⇒ 文件不进已装副本 ⇒ 插件 import 失败 ⇒ 整个插件加载不起来
// ⇒ 页面**白屏**（空白，不是报错页）✗
// 现场：lib/activity.js 漏了 ⇒ Agents 页签整页白，且 Host 日志里只有一行
//      "failed to import: Cannot find module .../lib/activity.js"。
//
// 判据（通用，不给某个插件开特例）：
//   A 插件得有 files 清单；清单里列的文件必须真实存在（死链）
//   B **拿 profile 里的已装副本做对照**（动态、精确）：版本一致时，
//     已装 lib/ 的文件集合 ⊇ 仓库 lib/ 的文件集合；缺一个就报红并指出该补进 files 的清单。
//     （别的插件 IDE 侧是整目录拷 ⇒ 不会缺 ⇒ 不会误报 ✓）
//
// 跑法：node dsh-plugins/check-plugin-files.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PLUGINS_DIR = join(ROOT, 'dsh-plugins');
// profile 里的已装副本（dev 用 .vssaros-dev；装机版用 .vssaros）
const PROFILES = [
	join(homedir(), '.vssaros-dev', 'dsh-home', 'profiles', 'vssaros', 'node_modules', '@vssaros'),
	join(homedir(), '.vssaros', 'dsh-home', 'profiles', 'vssaros', 'node_modules', '@vssaros'),
];

function pluginDirs() {
	return readdirSync(PLUGINS_DIR, { withFileTypes: true })
		.filter(e => e.isDirectory())
		.map(e => e.name)
		.filter(name => {
			try {
				return statSync(join(PLUGINS_DIR, name)).isDirectory()
					&& existsSync(join(PLUGINS_DIR, name, 'package.json'));
			} catch { return false; }
		});
}

function walk(dir, base = dir, out = []) {
	let ents = [];
	try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of ents) {
		if (e.name === 'node_modules' || e.name === '.vssaros') { continue; }
		const p = join(dir, e.name);
		if (e.isDirectory()) { walk(p, base, out); }
		else if (/\.(js|mjs)$/.test(e.name)) { out.push(relative(base, p).replace(/\\/g, '/')); }
	}
	return out;
}

function installedCopy(pkgName) {
	// 包名 @vssaros/dsh-agents ⇒ 已装目录名是末段 dsh-agents（目录名 ≠ 仓库目录名 vssaros-agents）
	const dirName = String(pkgName).split('/').pop();
	for (const root of PROFILES) {
		const d = join(root, dirName);
		if (existsSync(join(d, 'package.json'))) { return d; }
	}
	return null;
}

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('★ 插件打包白名单（files）+ 已装完整性守卫\n');

// ── ★ 链条完整性（2026-10-22 实锤：这道检查是为了防"链里引用了不存在的脚本"）────────
//
// 事故：`npm run check:dsh-plugins` 的链里引用了 `dsh-plugins/check-agent-tools.mjs`，
//   而那个脚本**从未入库** ⇒ `node` 报 "Cannot find module" ⇒ `&&` 链**当场断掉** ⇒
//   **断点之后的 10 个守卫从未执行过**（它们既不报错也不通过 —— 静默失效）✗✗。
//   ⇒ 这道检查断言：**链上引用的每个脚本都真实存在** ✓。
//
// ⚠ 为什么这道检查放这里：它自己在链的**第 2 位** ⇒ 断点之前的守卫会跑 ⇒ 能报出来 ✓
//   （若放在链尾，断在前面就永远不会执行 ⇒ 又是静默失效 ✗）。
{
	const rootPkgPath = join(ROOT, 'package.json');
	const chain = (() => {
		try { return JSON.parse(readFileSync(rootPkgPath, 'utf8'))?.scripts?.['check:dsh-plugins'] ?? ''; }
		catch { return ''; }
	})();
	const scripts = [...chain.matchAll(/node\s+([^\s&|]+)/g)].map(m => m[1]);
	check('package.json 里 check:dsh-plugins 链存在', scripts.length > 0, '没读到链');
	const missing = scripts.filter(s => !existsSync(join(ROOT, s)));
	if (missing.length === 0) {
		check(`链上 ${scripts.length} 个脚本都真实存在（否则 && 链会断、后面的守卫静默不执行）`, true);
	} else {
		check(
			`链上 ${scripts.length} 个脚本都真实存在（否则 && 链会断、后面的守卫静默不执行）`,
			false,
			`缺失：${missing.join('、')} ⇒ 请从链里移除，或把脚本补入库`,
		);
	}
}

const names = pluginDirs();
check('至少扫到一个插件目录', names.length > 0, `扫到 ${names.length} 个`);

for (const name of names) {
	const dir = join(PLUGINS_DIR, name);
	let pkg;
	try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { continue; }
	const files = Array.isArray(pkg.files) ? pkg.files : null;

	// A files 清单
	if (!files) {
		check(`${name}：有 files 白名单`, false, 'package.json 没有 files 字段');
	} else {
		const ghost = files.filter(f => !f.includes('*') && !existsSync(join(dir, f)));
		check(`${name}：files 里列的文件都真实存在（${files.length} 项）`,
			ghost.length === 0, ghost.length ? `死链：${ghost.join(', ')}` : '');

		/* ★★ 2026-10-26（Bots 白屏）：上面那条只查"**列了的**文件是否存在"（死链），
		   查不到"**该列的没列**"。而后者才是致命方向：
		     · vssaros-agents 漏了 lib/groupFiles.js ⇒ 已装副本缺文件 ⇒ import 失败 ⇒ 白屏
		     · vssaros-imagegen 漏了 lib/canvas/**（29 个）⇒ 画布功能在真机上必然坏
		     · vssaros-xhs-note 漏了 lib/index.js 等 6 个 ⇒ 装上也不可用
		   ⇒ 这里反过来查：files 必须覆盖 `lib/`、`bin/` 下所有 js/mjs + 根目录的 yml。 */
		const runtimeFiles = [
			...walk(join(dir, 'lib')).map((f) => 'lib/' + f),
			...(existsSync(join(dir, 'bin')) ? walk(join(dir, 'bin')).map((f) => 'bin/' + f) : []),
			...readdirSync(dir).filter((f) => /^[^/]+\.ya?ml$/.test(f)),
		].filter((f) => /\.(js|mjs|ya?ml)$/.test(f));
		const listedSet = new Set(files.map((f) => String(f).replace(/\\/g, '/')));
		/* ★ 2026-10-27：`files` 允许**目录级声明**（如 `lib/adapters/vendor` 覆盖其下 600+ 文件）。
		   原来只认逐文件列举 ⇒ 一加 vendor 就红，还提示"没列 623 个"。
		   判据改为：精确命中 **或** 命中某个已声明目录的前缀。 */
		const listedPrefixes = [...listedSet]
			.filter((f) => !/\.[a-z0-9]+$/i.test(f))
			.map((f) => f.replace(/\/+$/, '') + '/');
		const notListed = runtimeFiles.filter((f) => !listedSet.has(f) && !listedPrefixes.some((p) => f.startsWith(p)));
		check(`${name}：files 白名单**覆盖全部运行时文件**（lib/bin/yml 共 ${runtimeFiles.length} 个）`,
			notListed.length === 0,
			notListed.length
				? `没列：${notListed.slice(0, 8).join(', ')}${notListed.length > 8 ? ` 等 ${notListed.length} 个` : ''}`
				+ '（⇒ IDE 按 files 打包 ⇒ 装上缺文件 ⇒ import 失败 ⇒ 整页白屏）'
				: '');
	}

	// B 已装副本对照（**只对 agents 插件**做）：它走 pnpm file: 安装 ⇒ files 漏一条就
	//   "装不出来 ⇒ import 失败 ⇒ 整页白屏"✗。其它插件 IDE 侧是整目录拷（已装副本比 files 全）
	//   ⇒ 对它们做同一判据只会误报别人的线 ✗。
	if (name !== 'vssaros-agents') {
		console.log(`  --   ${name}：非 agents 插件 ⇒ 跳过已装对照（只做 files 死链检查）`);
		continue;
	}
	const inst = installedCopy(pkg.name);
	if (!inst) {
		console.log(`  --   ${name}：profile 里没有已装副本 ⇒ 跳过已装对照`);
		continue;
	}
	let instPkg = {};
	try { instPkg = JSON.parse(readFileSync(join(inst, 'package.json'), 'utf8')); } catch { /* 忽略 */ }
	/* ★★ 2026-10-26 真实事故（Bots 整页白屏，排查了一整轮）：这里原来是
	   「已装副本版本 ≠ 仓库版本 ⇒ 跳过已装对照」。而"刚 bump 完还没同步"这个**最常见**
	   的中间状态，恰好就是版本不同 ⇒ 守卫在**最该报警的时候静默跳过** ✗。
	   那次的实况：仓库加了 lib/groupFiles.js，真实 home 的已装副本没有 ⇒
	   index.js 的 import 失败 ⇒ agents 插件整个不加载 ⇒ Bots 白屏；
	   而这条守卫报"67/67 全绿"，把我带偏了很久。
	   ⇒ 现在：版本不同**不再跳过**，照常比对 lib 文件集，只把"副本是旧版本"写进原因。 */
	const stale = String(instPkg.version || '?') !== String(pkg.version || '?');
	const repoLib = walk(join(dir, 'lib')).map(f => 'lib/' + f);
	const instLib = walk(join(inst, 'lib')).map(f => 'lib/' + f);
	const instSet = new Set(instLib);
	const notInstalled = repoLib.filter(f => !instSet.has(f));
	check(`${name}：已装副本包含仓库的全部 lib 文件（${repoLib.length} 个）`,
		notInstalled.length === 0,
		notInstalled.length
			? `没装上：${notInstalled.join(', ')}（⇒ 插件 import 失败 ⇒ 整页白屏 ✗；`
			+ '先确认它在 package.json 的 files 白名单里，再跑一次 install-to-ide-home）'
			+ (stale ? `【已装副本是 ${instPkg.version}、仓库是 ${pkg.version} ⇒ 副本过期，需重新同步】` : '')
			: (stale ? `【注意：副本版本 ${instPkg.version} ≠ 仓库 ${pkg.version}，文件集却一致 —— 建议重新同步】` : ''));
}

/* ── ★ 客户端 chunk 不许**裸用 `React.`**（2026-10-26 实锤：Bots 里永远看不到 React 工作台）
   ------------------------------------------------------------------
   事故：`client.agents.js` 里我加了 `class WorkbenchBoundary extends React.Component`，
   但该 chunk 只有 `const react = require('react')` + 解构 hooks，**从未定义 `React`**
   ⇒ 子块一加载就抛 `ReferenceError: React is not defined`
   ⇒ `require.async(...).catch` 把错误吞成 `__vssarosAgentsClient.workbenchFailed`
   ⇒ 工作台**静默不注册**（不白屏、不报错，只是永远打不开）。
   `node --check` 查不出（语法合法），只能跑起来才发现 ⇒ 静态守一条。 */
{
	const clientFiles = [];
	for (const name of names) {
		const dir = join(PLUGINS_DIR, name, 'lib');
		let entries = [];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const e of entries) {
			if (/^client.*\.js$/.test(e)) { clientFiles.push(join(dir, e)); }
		}
	}
	const bare = [];
	for (const f of clientFiles) {
		let text = '';
		try { text = readFileSync(f, 'utf8'); } catch { continue; }
		// 去掉块注释与行注释（注释里提到 React.Component 是正常的）
		const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
		if (!/require\('react'\)/.test(stripped)) { continue; }
		/* ⚠ 有 `const React = require('react')` 的 chunk 裸用 `React.` 是**合法**的
		   （vssaros-scheduler 就是这种）；只有"只解构 hooks、从未绑定 React"的才致命。
		   ⇒ 先看有没有 React 绑定，有就跳过。 */
		const bound = /\b(?:const|let|var)\s+React\s*=/.test(stripped) || /\(React[,)]/.test(stripped);
		if (bound) { continue; }
		// 真·裸用：前面不是 `.`/标识符字符，且不属于 `react.`（大小写已区分）
		if (/(^|[^.\w])React\.[A-Za-z]/.test(stripped)) { bare.push(f.slice(ROOT.length + 1)); }
	}
	check('客户端 chunk 没有**裸用 `React.`**（只解构了 hooks 的 chunk 里裸用会抛 ReferenceError，工作台会静默不注册）',
		bare.length === 0, bare.length ? `命中：${bare.join(', ')}（改成 react.Component）` : `${clientFiles.length} 个 client 文件`);
}

// ── ★ 入口**真的能 import**（2026-10-24 实锤：工具页整页空白）───────────────────────
//
// 事故：`lib/index.js` 里一段 **注释** 写了反引号（`/x/skills/api/plugins`），
//   而那段注释在**页面模板字符串内部** ⇒ 反引号提前闭合模板 ⇒ 后面的 `/x/...`
//   被当成除法表达式 `x / skills / api / plugins` 解析。
//   ⚠ 这个形态**语法合法** ⇒ `node --check` 通过、`--check` 类守卫全绿，
//     直到 dsh 真正 import 时抛 `ReferenceError: x is not defined`
//     ⇒ 插件加载失败 ⇒ 整页白屏（Host 日志只有一行 "failed to import"）。
//   ⇒ 唯一可靠的判据就是**真跑一次 import**。子进程跑，避免污染本进程。
{
	const { execFileSync } = await import('node:child_process');
	const { pathToFileURL } = await import('node:url');
	for (const name of names) {
		const dir = join(PLUGINS_DIR, name);
		let pkg = {};
		try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { continue; }
		const entryRel = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js';
		const entry = join(dir, entryRel);
		if (!existsSync(entry)) { continue; }
		const spec = JSON.stringify(pathToFileURL(entry).href);
		try {
			execFileSync(process.execPath, ['-e', `import(${spec}).then(()=>{},e=>{console.error(e && e.message || e);process.exit(1)})`], { stdio: 'pipe' });
			check(`${name}：入口能真正 import（${entryRel}）`, true);
		} catch (e) {
			const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 2).join(' | ');
			check(`${name}：入口能真正 import（${entryRel}）`, false, msg.slice(0, 200));
		}
	}
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
