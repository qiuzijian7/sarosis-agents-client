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
	if (instPkg.version !== pkg.version) {
		console.log(`  --   ${name}：已装副本是 ${instPkg.version}（仓库 ${pkg.version}）⇒ 版本不同，跳过已装对照`);
		continue;
	}
	const repoLib = walk(join(dir, 'lib')).map(f => 'lib/' + f);
	const instLib = walk(join(inst, 'lib')).map(f => 'lib/' + f);
	const instSet = new Set(instLib);
	const notInstalled = repoLib.filter(f => !instSet.has(f));
	check(`${name}：已装副本包含仓库的全部 lib 文件（${repoLib.length} 个）`,
		notInstalled.length === 0,
		notInstalled.length
			? `没装上：${notInstalled.join(', ')}（⇒ 插件 import 失败 ⇒ 整页白屏 ✗；请补进 package.json 的 files）`
			: '');
}

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
