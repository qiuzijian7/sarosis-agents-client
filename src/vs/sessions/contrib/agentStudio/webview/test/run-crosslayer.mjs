/* Bundles the cross-layer test entry with esbuild and runs it under Node.
 * Usage: node test/run-crosslayer.mjs */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';

const out = join(mkdtempSync(join(tmpdir(), 'crosslayer-')), 'test.mjs');

await build({
	entryPoints: ['test/crossLayer.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	// Some deps (react-dom/server etc.) are CJS and use dynamic `require`.
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
	outfile: out,
	logLevel: 'warning',
});

await import(pathToFileURL(out).href);
