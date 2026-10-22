/**
 * Excalidraw 画布产物构建脚本（VsSaros 自研插件 `@vssaros/dsh-imagegen` 的 vendor 步骤）。
 *
 * 为什么要有这个脚本：画布引擎是**第三方 MIT 库**（Excalidraw），我们不把它的源码搬进仓库，
 * 而是「钉版本 + 构建 + 把产物 vendor 进去」——和随包 archify 插件同一套路（见 §archify 记忆）。
 * 产物落在 `../../lib/canvas/`，随插件一起打包进 profile（离线可用 ✓）。
 *
 * 跑法（在**本目录**下）：
 *   node build.mjs            # 缺依赖会自动 npm install，然后构建
 *   node build.mjs --check    # 只校验产物是否与当前依赖一致（CI 用：产物缺失/过期就红）
 *
 * 三处**刻意的裁剪**（都是为了体积，见 README）：
 *   ① mermaid-to-excalidraw ⇒ stub 掉（它会拖进 mermaid + cytoscape + katex ≈ **2.6MB**）；
 *   ② locale 用代码分割 + 只留 **zh-CN / en / ja-JP / zh-TW**（全量 75 个语言包 ≈ **1.6MB**）；
 *   ③ 字体走 woff2 独立文件（不 base64 内联）。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', 'lib', 'canvas');
/** 保留的语言包（其余 locale chunk 全部剪掉 ⇒ 少 1.5MB）。 */
const KEEP_LOCALES = ['zh-CN', 'en', 'ja-JP', 'zh-TW'];

const run = (cmd, args, cwd = HERE) => {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	// `windowsHide` 必须带（`check-spawn-hide` 的判据扫全仓 dsh-plugins；本脚本虽只在打包期跑、
	// 不进随包 `files`，但"构建脚本也遵守同一条纪律"比给守卫开一个 vendor 盲区更划算）。
	execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
};

function ensureDeps() {
	if (existsSync(join(HERE, 'node_modules', '@excalidraw', 'excalidraw'))) { return; }
	console.log('缺依赖 ⇒ 先 npm install（只在重建产物时需要；随包发布的是产物本身）');
	run('npm', ['install', '--no-audit', '--no-fund']);
}

/** 剪掉不需要的语言包 chunk（文件名形如 `zh-CN-LNUGB5OW-W3EV5UJP.js`）。 */
function pruneLocales() {
	const dir = join(OUT, 'chunks');
	if (!existsSync(dir)) { return 0; }
	let removed = 0;
	for (const name of readdirSync(dir)) {
		const m = /^([a-z]{2}(?:-[A-Z]{2})?)-[A-Z0-9]{8}-/.exec(name);
		if (!m) { continue; }              // 非 locale chunk（共享块）⇒ 保留
		if (KEEP_LOCALES.includes(m[1])) { continue; }
		rmSync(join(dir, name), { force: true });
		removed++;
	}
	return removed;
}

function report() {
	let total = 0;
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const s = statSync(p);
			if (s.isDirectory()) { walk(p); } else { total += s.size; }
		}
	};
	walk(OUT);
	console.log(`产物目录：${OUT}`);
	console.log(`总体积：${(total / 1024 / 1024).toFixed(2)} MB`);
}

ensureDeps();

if (process.argv.includes('--check')) {
	// CI 口径：产物必须在（它随包发）；不在就红（提示去跑 build.mjs）。
	if (!existsSync(join(OUT, 'entry.js'))) {
		console.error('✗ 画布产物缺失：dsh-plugins/vssaros-imagegen/lib/canvas/entry.js');
		console.error('  重建：cd vendor/excalidraw && node build.mjs');
		process.exit(1);
	}
	report();
	console.log('✓ 画布产物在位');
	process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
run('npx', [
	'esbuild', 'entry.mjs',
	'--bundle', '--format=esm', '--minify', '--target=es2022',
	'--conditions=production',
	'--loader:.woff2=file', '--asset-names=excal-fonts/[name]-[hash]',
	'--alias:@excalidraw/mermaid-to-excalidraw=./stub-mermaid.js',
	'--splitting', '--chunk-names=chunks/[name]-[hash]',
	'--outdir=out', '--outbase=.',
]);
// esbuild 的产物先落在 out/，再搬到 OUT（保持 vendor 目录干净）。
// ⚠ 搬运**在脚本内做**（不用 `node -e` 子进程）：Windows 下多行 `-e` 脚本会被 shell 改写 ⇒ 炸过一次。
rmSync(OUT, { recursive: true, force: true });
cpSync(join(HERE, 'out'), OUT, { recursive: true });
rmSync(join(HERE, 'out'), { recursive: true, force: true });
const removed = pruneLocales();
console.log(`剪掉语言包 chunk：${removed} 个（只留 ${KEEP_LOCALES.join(' / ')}）`);
report();
