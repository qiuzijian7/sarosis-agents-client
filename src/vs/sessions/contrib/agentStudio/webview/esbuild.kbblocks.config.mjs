// @ts-check
// Separate esbuild bundle for the KB markdown renderer (react-markdown
// pipeline, replacing the old AFFiNE / BlockSuite editor).
// Mirrors esbuild.config.mjs: single IIFE (no ESM splitting) so the webview
// loads it with ONE fetch. Output: media/kbblocks.js (+ media/kbblocks.css).
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

/**
 * Inline KaTeX's stylesheet (and its fonts) as a run-time string module so the
 * markdown renderer can inject it via a <style> tag, independent of the host's
 * separate `kbblocks.css` injection. The fonts are base64-encoded as `data:`
 * URIs so they resolve inside the webview even though the document base URL
 * has no `fonts/` directory.
 *
 * This replaces the old BlockSuite / shiki esbuild plugins, which are no longer
 * needed now that the KB editor uses the react-markdown pipeline and
 * react-syntax-highlighter instead of AFFiNE's BlockSuite + shiki highlighter.
 */
const FONT_MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
const katexCssPlugin = {
	name: 'katex-css',
	setup(build) {
		build.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => {
			return { path: 'katex/dist/katex.min.css', namespace: 'katex-css' };
		});
		build.onLoad({ filter: /.*/, namespace: 'katex-css' }, async () => {
			const cssPath = resolve(__dirname, 'node_modules/katex/dist/katex.min.css');
			let css = await readFile(cssPath, 'utf8');
			const fontsDir = resolve(__dirname, 'node_modules/katex/dist/fonts');
			css = css.replace(/url\(\s*['"]?fonts\/([^)'"]+)['"]?\s*\)/g, (_m, file) => {
				const ext = String(file).split('.').pop()?.toLowerCase() ?? '';
				const mime = FONT_MIME[ext] ?? 'application/octet-stream';
				try {
					const buf = readFileSync(resolve(fontsDir, file));
					return `url(data:${mime};base64,${buf.toString('base64')})`;
				} catch {
					return _m;
				}
			});
			return { contents: `export default ${JSON.stringify(css)};`, loader: 'js' };
		});
	},
};

/** @type {esbuild.BuildOptions} */
const buildOptions = {
	entryPoints: [resolve(__dirname, 'src/kbBlocks/index.tsx')],
	bundle: true,
	outdir: resolve(__dirname, 'media'),
	format: 'iife',
	splitting: false,
	platform: 'browser',
	target: ['es2022'],
	minify: !isWatch,
	sourcemap: isWatch ? 'inline' : false,
	jsx: 'automatic',
	entryNames: 'kbblocks',
	loader: {
		'.tsx': 'tsx',
		'.ts': 'ts',
		'.css': 'css',
	},
	define: {
		'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
	},
	drop: isWatch ? [] : ['console', 'debugger'],
	pure: isWatch ? [] : ['console.log', 'console.warn', 'console.error', 'console.info', 'console.debug', 'console.trace'],
	external: [],
	logLevel: 'info',
	plugins: [katexCssPlugin],
};

async function main() {
	if (!isWatch) {
		// clean previous kbblocks output only
		const { readdirSync, unlinkSync } = await import('fs');
		try {
			for (const f of readdirSync(resolve(__dirname, 'media'))) {
				if (f.startsWith('kbblocks')) { unlinkSync(resolve(__dirname, 'media', f)); }
			}
		} catch { /* ignore */ }
	}
	if (isWatch) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		console.log('[kbblocks] watching for changes...');
	} else {
		const result = await esbuild.build({ ...buildOptions, metafile: true });
		console.log('[kbblocks] build complete.');
		const meta = result.metafile;
		const inputs = Object.entries(meta.inputs)
			.map(([path, info]) => ({ path, bytes: info.bytes }))
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 30);
		console.log('\n--- kbblocks: Top 30 modules by INPUT (source) size ---');
		for (const { path, bytes } of inputs) {
			console.log(`  ${((bytes / 1024)).toFixed(1).padStart(7)} KB  ${path}`);
		}
		// True contribution to the output = sum of bytesInOutput across every
		// module that made it into the bundle (after tree-shaking + minify).
		// `meta.inputs[].bytes` is the raw source size and over-states packages
		// that tree-shake well (e.g. date-fns = many tiny files).
		const outPkgTotals = {};
		const outModuleTotals = {};
		for (const out of Object.values(meta.outputs)) {
			for (const [path, info] of Object.entries(out.inputs)) {
				const m = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
				const pkg = m ? m[1] : '(project src)';
				outPkgTotals[pkg] = (outPkgTotals[pkg] || 0) + info.bytesInOutput;
				outModuleTotals[path] = (outModuleTotals[path] || 0) + info.bytesInOutput;
			}
		}
		const sortedPkg = Object.entries(outPkgTotals).sort((a, b) => b[1] - a[1]).slice(0, 16);
		console.log('\n--- kbblocks: Top packages by OUTPUT (bundled) size ---');
		for (const [pkg, bytes] of sortedPkg) {
			console.log(`  ${((bytes / 1024)).toFixed(1).padStart(7)} KB  ${pkg}`);
		}
		const sortedMod = Object.entries(outModuleTotals).sort((a, b) => b[1] - a[1]).slice(0, 16);
		console.log('\n--- kbblocks: Top 16 modules by OUTPUT (bundled) size ---');
		for (const [path, bytes] of sortedMod) {
			console.log(`  ${((bytes / 1024)).toFixed(1).padStart(7)} KB  ${path}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
