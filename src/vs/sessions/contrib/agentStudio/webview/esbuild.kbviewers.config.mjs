// @ts-check
// 独立 esbuild bundle：KB 文档查看器（pdf.js + mammoth）→ media/kbviewers.js
// 与 esbuild.kbblocks.config.mjs 同构：单 IIFE（不做 ESM splitting），宿主一次性内联注入。
//
// 另外会把 pdf.js 的 worker 复制到 media/pdfer.worker.min.mjs ⇒ webview 通过
// `GlobalWorkerOptions.workerSrc` 指向它（worker 让解析不阻塞 UI 线程）。
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const MEDIA = resolve(__dirname, 'media');
const WORKER_OUT = 'pdf.worker.min.mjs';

/** @type {esbuild.BuildOptions} */
const buildOptions = {
	entryPoints: [resolve(__dirname, 'src/kbViewers/index.ts')],
	bundle: true,
	outdir: MEDIA,
	format: 'iife',
	splitting: false,
	platform: 'browser',
	target: ['es2022'],
	minify: !isWatch,
	sourcemap: isWatch ? 'inline' : false,
	entryNames: 'kbviewers',
	loader: {
		'.ts': 'ts',
		'.css': 'css',
	},
	define: {
		'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
	},
	logLevel: 'info',
};

/** 复制 pdf.js worker 到 media/（宿主会用 asWebviewUri 把它交给 webview）。 */
function copyPdfWorker() {
	if (!existsSync(MEDIA)) { mkdirSync(MEDIA, { recursive: true }); }
	const candidates = [
		'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
		'node_modules/pdfjs-dist/build/pdf.worker.mjs',
	];
	for (const rel of candidates) {
		const from = resolve(__dirname, rel);
		if (existsSync(from)) {
			copyFileSync(from, resolve(MEDIA, WORKER_OUT));
			console.log(`[kbviewers] pdf worker ← ${rel}`);
			return;
		}
	}
	console.warn('[kbviewers] ⚠ 未找到 pdf.js worker（PDF 仍可渲染，但会退化为主线程解析）');
}

async function main() {
	if (!isWatch) {
		// 只清理本 bundle 的产物，别动其它 media 文件
		try {
			for (const f of readdirSync(MEDIA)) {
				if (f.startsWith('kbviewers') || f === WORKER_OUT) { unlinkSync(resolve(MEDIA, f)); }
			}
		} catch { /* ignore */ }
	}

	if (isWatch) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		copyPdfWorker();
		console.log('[kbviewers] watching for changes...');
	} else {
		const result = await esbuild.build({ ...buildOptions, metafile: true });
		copyPdfWorker();
		console.log('[kbviewers] build complete.');
		const totals = {};
		for (const out of Object.values(result.metafile.outputs)) {
			for (const [path, info] of Object.entries(out.inputs)) {
				const m = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
				const pkg = m ? m[1] : '(project src)';
				totals[pkg] = (totals[pkg] || 0) + info.bytesInOutput;
			}
		}
		console.log('\n--- kbviewers: Top packages by OUTPUT (bundled) size ---');
		for (const [pkg, bytes] of Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
			console.log(`  ${((bytes / 1024)).toFixed(1).padStart(8)} KB  ${pkg}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
