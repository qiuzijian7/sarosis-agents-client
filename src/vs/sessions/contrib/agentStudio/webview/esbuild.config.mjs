// @ts-check
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, unlinkSync, rmdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

function cleanMedia() {
	const mediaDir = resolve(__dirname, 'media');
	try {
		const entries = readdirSync(mediaDir);
		for (const entry of entries) {
			if (entry === '.gitkeep') continue;
			const fullPath = resolve(mediaDir, entry);
			const st = statSync(fullPath);
			if (st.isDirectory()) {
				// remove files inside then the dir itself
				for (const child of readdirSync(fullPath)) {
					unlinkSync(resolve(fullPath, child));
				}
				rmdirSync(fullPath);
			} else {
				unlinkSync(fullPath);
			}
		}
	} catch {
		// ignore if media dir doesn't exist yet
	}
}

/** @type {esbuild.BuildOptions} */
const buildOptions = {
	entryPoints: [resolve(__dirname, 'src/index.tsx')],
	bundle: true,
	outdir: resolve(__dirname, 'media'),
	// IIFE single-file bundle (NOT esm + splitting). In a VS Code webview every
	// ESM `import "./chunks/..."` is a separate resource fetch proxied through
	// the service worker -> host file read -> postMessage round-trip. On a cold
	// webview that module waterfall costs SECONDS per hop and was the real cause
	// of the ~24s "bundle-load". A single IIFE loaded by a plain <script> needs
	// exactly ONE fetch. Parse/eval of the merged ~930KB is only ~100ms, so the
	// tradeoff is overwhelmingly worth it. Keep this as a single file: do NOT
	// re-enable `splitting`.
	format: 'iife',
	splitting: false,
	platform: 'browser',
	target: ['es2022'],
	minify: !isWatch,
	sourcemap: isWatch ? 'inline' : false,
	jsx: 'automatic',
	entryNames: 'webview',
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
	// External - VS Code API is provided by the webview host
	external: [],
	logLevel: 'info',
};

async function main() {
	if (!isWatch) {
		cleanMedia();
	}
	if (isWatch) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		console.log('Watching for changes...');
	} else {
		const result = await esbuild.build({
			...buildOptions,
			metafile: true,
		});
		console.log('Build complete.');

		// Analyze and print top-30 largest modules
		const meta = result.metafile;
		const inputs = Object.entries(meta.inputs)
			.map(([path, info]) => ({ path, bytes: info.bytes }))
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 30);

		console.log('\n--- Top 30 modules by size ---');
		for (const { path, bytes } of inputs) {
			const kb = (bytes / 1024).toFixed(1);
			console.log(`  ${kb.padStart(7)} KB  ${path}`);
		}

		// Group by package for summary
		/** @type {Record<string, number>} */
		const pkgTotals = {};
		for (const [path, info] of Object.entries(meta.inputs)) {
			const match = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
			const pkg = match ? match[1] : '(project src)';
			pkgTotals[pkg] = (pkgTotals[pkg] || 0) + info.bytes;
		}
		const sortedPkgs = Object.entries(pkgTotals)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15);

		console.log('\n--- Top 15 packages by total size ---');
		const totalAll = Object.values(pkgTotals).reduce((s, v) => s + v, 0);
		for (const [pkg, bytes] of sortedPkgs) {
			const kb = (bytes / 1024).toFixed(1);
			const pct = ((bytes / totalAll) * 100).toFixed(1);
			console.log(`  ${kb.padStart(7)} KB  (${pct.padStart(5)}%)  ${pkg}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
