#!/usr/bin/env node
/**
 * 把 `@larksuiteoapi/node-sdk` 及它的依赖 **vendor 进本包**（2026-10-27，方案 C）。
 *
 * ── 为什么要 vendor ────────────────────────────────────────────────────────
 * 飞书入站要用官方 SDK 的 `WSClient`，而本包长期坚持"零运行时依赖"（`dependencies: {}`）。
 * 结果是：任何新装包的人，第一次点「启动入站」都会 `unavailable：未安装 @larksuiteoapi/node-sdk`。
 * 只在报错里给安装命令不够 —— 用户要在 **profile 目录** 执行才生效，而那个路径他并不知道
 * （我们后来用 `installDirOf()` 把路径算出来了，但仍要用户手动装一次、再重启）。
 *
 * ⇒ 方案 C：把 SDK 的**运行时部分**打进包，装完即用。
 *
 * ── 为什么只有 15MB 而不是 38MB ────────────────────────────────────────────
 * SDK 本体 28.9MB 里：
 *   · `types/` 16.85MB —— 纯 `.d.ts`，运行时**完全不需要**
 *   · `es/`     5.94MB —— ESM 构建；Node 对没有 `exports` 字段的 CJS 包走 `main`（`lib/`）
 *   · `lib/`    5.98MB —— 真正被 `require` 的
 * ⇒ 只留 `lib/` + `package.json`。依赖侧同样裁掉 `*.d.ts` / `*.map` / `@types`。
 *
 * ── 不改什么 ──────────────────────────────────────────────────────────────
 * 不写 `dependencies` / `optionalDependencies`：本包对外的依赖声明**保持为空**。
 * vendor 是"打包时塞进去的静态文件"，不是 npm 依赖 —— 这样 profile 的安装链路
 * （`file:` 复制）不需要理解 optional 依赖，也不会多下一次 npm。
 *
 * ── 产物不进 git ──────────────────────────────────────────────────────────
 * `lib/adapters/vendor/` 在 `.gitignore` 里；发布前跑 `npm run vendor`（或直接
 * `node scripts/vendor-lark-sdk.mjs`）生成。**发布脚本必须先跑它**，否则包里没有 SDK。
 *
 * ── 产物形态（2026-10-29 修正，两条都是真机事故）────────────────────────────
 *   lib/adapters/vendor/
 *     node-sdk/lib/index.js        ← SDK 运行时；其中 6 处裸 require 已被改成 `../../deps/*`
 *     deps/package.json            ← {"type":"commonjs"}（本包是 ESM，不声明则 module.exports 直接炸）
 *     deps/{axios.js,qs.js,lodash.*.js}  ← 自包含 shim（真源 = scripts/vendor/*.cjs，入库）
 *     deps/ws/                     ← 唯一真包（WSClient 核心，零必需依赖）
 *
 * ⚠ **绝不能**把依赖放进名为 `node_modules` 的目录：npm 打包会无条件剥掉它（即使 files 里写了），
 *   装到 profile 后就只剩 node-sdk，SDK 启动必然 `Cannot find module 'axios'` ——
 *   「包内自带 SDK」从上线起一次都没生效过（2026-10-29 真机：飞书入站从来没起来）。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = '@larksuiteoapi/node-sdk';
const TMP = join(tmpdir(), 'vssaros-lark-sdk');
const HERE = import.meta.dirname || join(process.cwd(), 'scripts');
const OUT = join(HERE, '..', 'lib', 'adapters', 'vendor');

function dirSize(p) {
	let bytes = 0;
	let files = 0;
	const walk = (d) => {
		let entries = [];
		try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const q = join(d, e.name);
			if (e.isDirectory()) { walk(q); continue; }
			try { bytes += statSync(q).size; files += 1; } catch { /* 忽略 */ }
		}
	};
	walk(p);
	return { bytes, files };
}

/** 删掉运行时用不到的文件（`.d.ts` / sourcemap / @types）。 */
function prune(dir) {
	let removed = 0;
	let entries = [];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
	for (const e of entries) {
		const q = join(dir, e.name);
		if (e.isDirectory()) {
			/* `@types` 全是类型声明；`types`/`docs`/`test` 在依赖里也基本都是噪音 */
			if (e.name === '@types' || e.name === 'docs' || e.name === '__tests__') {
				try { rmSync(q, { recursive: true, force: true }); removed += 1; } catch { /* 忽略 */ }
				continue;
			}
			removed += prune(q);
			continue;
		}
		if (e.name.endsWith('.d.ts') || e.name.endsWith('.d.mts') || e.name.endsWith('.map')) {
			try { rmSync(q, { force: true }); removed += 1; } catch { /* 忽略 */ }
		}
	}
	return removed;
}

console.log('① 清空旧产物');
rmSync(OUT, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

console.log('② 下载 ' + PKG + '（临时目录，不进 node_modules）');
try {
	execFileSync('npm', ['install', PKG, '--prefix', TMP, '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], {
		stdio: 'pipe', shell: true, timeout: 300000, windowsHide: true,
	});
} catch (e) {
	console.error('✗ npm install 失败：' + String(e.stderr || e.message).slice(0, 400));
	process.exit(1);
}

const SRC = join(TMP, 'node_modules');
const sdkSrc = join(SRC, '@larksuiteoapi', 'node-sdk');
if (!existsSync(sdkSrc)) {
	console.error('✗ 临时目录里找不到 SDK');
	process.exit(1);
}

console.log('③ 复制 SDK 运行时（只留 lib/ 与 package.json）');
const sdkOut = join(OUT, 'node-sdk');
mkdirSync(sdkOut, { recursive: true });
cpSync(join(sdkSrc, 'lib'), join(sdkOut, 'lib'), { recursive: true });
cpSync(join(sdkSrc, 'package.json'), join(sdkOut, 'package.json'));

/* ★★ 2026-10-29 事故修正（**别再改回 node_modules**）────────────────────────
   这里原来复制到 `vendor/node_modules/`，指望 SDK 的 `require('axios')` 顺着目录向上找到。
   但 **npm 打包会无条件剥掉任何 node_modules 目录**（即使写进 `files` 白名单）⇒ 装到 profile
   后只剩 `vendor/node-sdk` ⇒ SDK 顶部 `require('axios')` 报 `Cannot find module 'axios'`
   ⇒「包内自带 SDK、装完即用」从上线起就没生效过，飞书入站**从来没真正起来**（2026-10-29 真机定案，
   症状是点「启动入站」立刻 `unavailable：飞书 SDK 不可用 … Cannot find module 'axios'`）。
   ⇒ 现在用**普通目录** `vendor/deps/` + 第 ⑥ 步把 SDK 的裸 require 改写成相对路径。
   ⚠ 另一个坑：本包是 `type: "module"`，而 deps 里的东西是 CJS ⇒ deps/ 必须放一份
     `{"type":"commonjs"}` 的 package.json（否则 `module.exports` 直接 ReferenceError）。 */
console.log('④ 复制依赖到 vendor/deps（普通目录，npm 不会剥）');
const depOut = join(OUT, 'deps');
mkdirSync(depOut, { recursive: true });
let depCount = 0;

/** 复制一个真包（只有 ws 需要：WSClient 的核心，且它零必需依赖）。 */
const copyPkg = (name, to) => {
	const from = join(SRC, name);
	if (!existsSync(from)) { throw new Error('临时目录里缺依赖：' + name); }
	cpSync(from, to, { recursive: true });
	depCount += 1;
};
copyPkg('ws', join(depOut, 'ws'));

/* qs 用**自带的 UMD 构建**（dist/qs.js 自包含）：正规包会拉 side-channel 依赖链，
   而 vendor 里再嵌一层 node_modules 又会被打包剥掉 ⇒ 永远是坏的。 */
const qsDist = join(SRC, 'qs', 'dist', 'qs.js');
if (!existsSync(qsDist)) { throw new Error('qs 缺自包含构建 dist/qs.js'); }
cpSync(qsDist, join(depOut, 'qs.js'));
depCount += 1;

/* axios + 三个 lodash.*：用 scripts/vendor/*.cjs 里的实现（能自包含就不引依赖树）。
   真源入库、可 review；这里只做复制。 */
for (const name of ['axios', 'lodash.identity', 'lodash.pickby', 'lodash.merge']) {
	const from = join(HERE, 'vendor', name + '.cjs');
	if (!existsSync(from)) { throw new Error('缺 shim 源码：scripts/vendor/' + name + '.cjs'); }
	cpSync(from, join(depOut, name + '.js'));
	depCount += 1;
}
const depsPkg = join(HERE, 'vendor', 'deps.package.json');
if (!existsSync(depsPkg)) { throw new Error('缺 scripts/vendor/deps.package.json（deps 必须是 commonjs）'); }
cpSync(depsPkg, join(depOut, 'package.json'));

console.log('⑤ 裁剪（.d.ts / *.map / @types）');
const removed = prune(OUT);

/* ⑥ 把 SDK 的**裸 require 改写成相对路径** —— 这是「依赖不靠 node_modules 解析」的落点。
   只改这次真用到的 6 个；万一上游将来多 require 了别的包，下面 `unresolved` 会把它打出来，
   ⚠ 不要偷偷放过：漏一个就是"点启动入站立刻 unavailable"。 */
console.log('⑥ 改写 SDK 的裸 require → vendor/deps');
const SDK_ENTRY = join(OUT, 'node-sdk', 'lib', 'index.js');
const REQUIRE_MAP = {
	axios: '../../deps/axios.js',
	qs: '../../deps/qs.js',
	'lodash.identity': '../../deps/lodash.identity.js',
	'lodash.pickby': '../../deps/lodash.pickby.js',
	'lodash.merge': '../../deps/lodash.merge.js',
	ws: '../../deps/ws',
};
{
	let text = readFileSync(SDK_ENTRY, 'utf8');
	let hits = 0;
	for (const [name, rel] of Object.entries(REQUIRE_MAP)) {
		const needle = `require('${name}')`;
		const n = text.split(needle).length - 1;
		if (!n) { continue; }
		text = text.split(needle).join(`require('${rel}')`);
		hits += n;
	}
	writeFileSync(SDK_ENTRY, text, 'utf8');
	/* 剩下还没改写的裸 require：内置模块除外，其余一律报出来（宁可在 vendor 阶段红） */
	const builtin = new Set(['fs', 'path', 'crypto', 'os', 'util', 'stream', 'events', 'http', 'https', 'zlib', 'url', 'buffer', 'querystring', 'dns', 'net', 'tls', 'assert', 'child_process']);
	const leftovers = [...text.matchAll(/require\('([^.'/][^']*)'\)/g)]
		.map((m) => m[1])
		.filter((name) => !builtin.has(name) && !name.startsWith('node:'));
	const unresolved = [...new Set(leftovers)];
	console.log('   改写 ' + hits + ' 处');
	if (unresolved.length) {
		console.error('✗ SDK 里还有没接线的外部依赖：' + unresolved.join(', ')
			+ '（要么加进 REQUIRE_MAP + deps，要么它永远会 Cannot find module）');
		process.exit(1);
	}
}

const total = dirSize(OUT);
console.log('\n✓ vendor 完成');
console.log('  依赖包数   = ' + depCount);
console.log('  删除文件数 = ' + removed);
console.log('  最终体积   = ' + (total.bytes / 1024 / 1024).toFixed(1) + ' MB / ' + total.files + ' 文件');
console.log('  位置       = ' + OUT.replace(HERE, 'scripts'));
