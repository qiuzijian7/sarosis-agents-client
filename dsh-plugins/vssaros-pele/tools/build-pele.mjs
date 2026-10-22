// 把上游 pele（Mermaid → SVG 渲染器，MIT）编译成随包产物。
//
// 为什么自己打而不引 npm 包（2026-10-19）：
//   · pele 的 `src/` **零外部 import**（全是相对路径）⇒ esbuild 可以完全离线打，不需要 npm install；
//   · 只打**一份**产物（IIFE，全局 `pele`）：dsh Host 与 IDE 渲染进程都 `new Function` 注入它。
//     ⇒ 结构上就不可能有"两个消费方拿着两个版本的渲染器"（双产物的对账守卫也就不需要了 ✓）。
//
// 用法：
//   node dsh-plugins/vssaros-pele/tools/build-pele.mjs [--src <pele 源码根>] [--check]
//                                                      [--slim <图种,图种,...>]
//
//   --src   上游 pele 仓库根（默认 G:\CustomWorkspaces\AIProjects\pele；含 src/ 与 package.json）。
//   --check 只校验随包产物与"现在重打一份"是否一致（守卫：上游改了没重打 ⇒ 报出来），不写盘。
//   --slim  额外打一份**按图种裁剪**的 `assets/pele.slim.global.js`（实测体积，上游 1.6.0）：
//             全量 663 KB / 8 种 294 KB（−56%）/ 14 种 373 KB（−44%）/ 22 种 508 KB（−23%）
//           ⚠ 代价：不在清单里的图种会报 `unsupported-diagram` ⇒ **默认不打**、默认也不加载。
//             只有"确定只会用到某几个图种"的部署才值得换（比如只画流程图/时序图的内嵌视图）。
//
// ⚠ 构建依赖 esbuild，从仓库根 node_modules 解析（本机 0.28.0）；产物**必须**一起入库，
//   否则 CI 干净检出拿不到 `assets/pele.global.js` ⇒ 所有图表渲染不出来。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const assetsDir = join(pluginRoot, 'assets');
const DEFAULT_SRC = 'G:\\CustomWorkspaces\\AIProjects\\pele';

/** 解析命令行参数（只认 `--k v` 与 `--flag` 两种形态）。 */
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) { continue; }
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
		else { out[key] = 'true'; }
	}
	return out;
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/**
 * 图种 id（detect.ts）→ **目录名**（src/diagrams/<dir>）。
 *
 * ⚠ 两者不是一回事，写错就是"打包静默少了/多了一个图种"（实测踩到：gitGraph→git/、
 *   quadrantChart→quadrant/、treeView→treeview/）⇒ 这张表必须显式列出来。
 */
const DIR_OF = { gitGraph: 'git', quadrantChart: 'quadrant', treeView: 'treeview' };
/** 目录名 → 该目录导出的符号名（class/ 导出的是 `classDiagram`）。 */
const SYMBOL_OF = { class: 'classDiagram', git: 'gitGraph', quadrant: 'quadrantChart', treeview: 'treeView' };

/**
 * 打一份产物文本（不落盘）。`globalName` 只给 iife 用。
 *
 * @param types 传图种 id 数组 ⇒ 只注册这些图种（裁包）；不传 ⇒ 全量（src/index.ts）。
 */
async function buildOnce(format, globalName, types) {
	let entryFile = entry;
	if (types && types.length) {
		entryFile = join(srcRoot, 'src', `_vssaros_slim.ts`);
		const dirs = types.map(t => DIR_OF[t] ?? t);
		const symbols = dirs.map(d => SYMBOL_OF[d] ?? d);
		writeFileSync(entryFile, [
			...dirs.map((d, i) => `import { ${symbols[i]} } from './diagrams/${d}/index.js';`),
			`import { register } from './core.js';`,
			`register(${symbols.join(', ')});`,
			`export * from './core.js';`,
			'',
		].join('\n'), 'utf8');
	}
	try {
		const result = await build({
			bundle: true,
			target: 'es2021',
			minify: true,
			charset: 'utf8',
			legalComments: 'none',
			logLevel: 'warning',
			entryPoints: [entryFile],
			write: false,
			outdir: assetsDir,
			entryNames: `[name]-${format}`,
			format,
			...(globalName ? { globalName } : {}),
			banner: { js: banner },
		});
		const file = result.outputFiles?.[0];
		if (!file) { throw new Error(`[pele] esbuild 没产出 ${format} 产物`); }
		return file.text;
	} finally {
		// 临时入口留在**上游仓库**里，用完必删（留着会让上游工作区变脏 ✗）
		if (entryFile !== entry) {
			try { rmSync(entryFile, { force: true }); } catch { /* ignore */ }
		}
	}
}

const args = parseArgs(process.argv.slice(2));
const srcRoot = resolve(args.src ?? DEFAULT_SRC);
const entry = join(srcRoot, 'src', 'index.ts');
const pkgPath = join(srcRoot, 'package.json');

if (!existsSync(entry)) {
	console.error(`[pele] 上游入口不存在：${entry}（用 --src 指到 pele 仓库根）`);
	process.exit(1);
}
const upstreamVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
const banner = `/*! Pele ${upstreamVersion} | MIT License | (c) kepano | bundled for @vssaros/dsh-pele - do not edit by hand. */`;

async function main() {
	const globalJs = await buildOnce('iife', 'pele');
	const slimTypes = typeof args.slim === 'string' && args.slim.trim()
		? args.slim.split(',').map(s => s.trim()).filter(Boolean)
		: undefined;
	const slimJs = slimTypes ? await buildOnce('iife', 'pele', slimTypes) : undefined;

	if (args.check === 'true') {
		const want = [
			['assets/pele.global.js', globalJs],
			...(slimJs ? [['assets/pele.slim.global.js', slimJs]] : []),
		];
		let bad = 0;
		for (const [rel, text] of want) {
			const abs = join(pluginRoot, rel);
			if (!existsSync(abs)) {
				console.error(`[pele] --check：缺产物 ${rel}`);
				bad++;
				continue;
			}
			const have = readFileSync(abs, 'utf8');
			if (sha(have) !== sha(text)) {
				console.error(`[pele] --check：${rel} 与上游 ${upstreamVersion} 重打结果不一致（上游改过没重打？去掉 --check 重跑本脚本）`);
				bad++;
			}
		}
		if (bad) { process.exit(1); }
		console.log(`[pele] --check ok：随包产物与上游 ${upstreamVersion} 一致`);
		return;
	}

	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(join(assetsDir, 'pele.global.js'), globalJs, 'utf8');
	writeFileSync(join(assetsDir, 'VERSION.txt'), `${upstreamVersion}\n`, 'utf8');
	console.log(`[pele] built from ${srcRoot} (v${upstreamVersion})`);
	console.log(`[pele]   assets/pele.global.js  ${(globalJs.length / 1024).toFixed(1)} KB  #${sha(globalJs)}`);
	if (slimJs) {
		writeFileSync(join(assetsDir, 'pele.slim.global.js'), slimJs, 'utf8');
		writeFileSync(join(assetsDir, 'pele.slim.types.json'), `${JSON.stringify({ types: slimTypes }, null, '\t')}\n`, 'utf8');
		console.log(`[pele]   assets/pele.slim.global.js  ${(slimJs.length / 1024).toFixed(1)} KB  #${sha(slimJs)}  (${slimTypes.length} 图种)`);
		console.log(`[pele]   ⚠ 精简包只认这 ${slimTypes.length} 个图种，其余会报 unsupported-diagram ⇒ 别在通用场景默认用它`);
	}
}

await main();
