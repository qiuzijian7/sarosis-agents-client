/* Bundles the TS test entry with esbuild and runs it under Node.
 * Usage: node test/run.mjs */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';

const out = join(mkdtempSync(join(tmpdir(), 'kbtest-')), 'test.mjs');

await build({
	entryPoints: ['test/kbMarkdown.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	// react-dom/server is CJS and uses dynamic `require`; provide a real
	// require shim so the ESM bundle can load it under Node.
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
	outfile: out,
	logLevel: 'warning',
});

await import(pathToFileURL(out).href);
