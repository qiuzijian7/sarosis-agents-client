/* Bundles the collaboration-kernel test entry with esbuild and runs it under Node.
 * Usage: node test/run-collaboration.mjs */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';

const out = join(mkdtempSync(join(tmpdir(), 'collab-')), 'test.mjs');

await build({
	entryPoints: ['test/collaboration.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
	outfile: out,
	logLevel: 'warning',
});

await import(pathToFileURL(out).href);
