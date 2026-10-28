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
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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

console.log('④ 复制依赖到 vendor/node_modules（SDK 的 import 会先找到这里）');
const depOut = join(OUT, 'node_modules');
mkdirSync(depOut, { recursive: true });
let depCount = 0;
for (const entry of readdirSync(SRC)) {
	if (entry === '.bin' || entry === '.package-lock.json' || entry === '@larksuiteoapi') { continue; }
	const from = join(SRC, entry);
	let st = null;
	try { st = statSync(from); } catch { continue; }
	if (!st.isDirectory()) { continue; }
	cpSync(from, join(depOut, entry), { recursive: true });
	depCount += 1;
}

console.log('⑤ 裁剪（.d.ts / *.map / @types）');
const removed = prune(OUT);

const total = dirSize(OUT);
console.log('\n✓ vendor 完成');
console.log('  依赖包数   = ' + depCount);
console.log('  删除文件数 = ' + removed);
console.log('  最终体积   = ' + (total.bytes / 1024 / 1024).toFixed(1) + ' MB / ' + total.files + ' 文件');
console.log('  位置       = ' + OUT.replace(HERE, 'scripts'));
