// @ts-check
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webviewRoot = path.resolve(__dirname, '..');
const entry = path.join(__dirname, 'entry.mjs');
const out = path.join(__dirname, 'bundle.mjs');

const tsResolvePlugin = {
  name: 'ts-js-resolve',
  setup(build) {
    build.onResolve({ filter: /^\.+\// }, (args) => {
      const dir = args.resolveDir;
      const path0 = args.path;
      const ext = path.extname(path0);
      const candidates = ext
        ? [path0, path0.replace(/\.(js|ts|tsx|json)$/, '.ts'), path0.replace(/\.(js|ts|tsx|json)$/, '.tsx')]
        : [path0 + '.ts', path0 + '.tsx', path0 + '.js', path0 + '/index.ts', path0 + '/index.js', path0];
      for (const c of candidates) {
        const resolved = path.resolve(dir, c);
        try { if (fs.statSync(resolved).isFile()) return { path: resolved, namespace: 'file' }; } catch {}
      }
      return undefined;
    });
  },
};

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: out,
  nodePaths: [path.join(webviewRoot, 'node_modules')],
  resolveExtensions: ['.mjs', '.js', '.mts', '.ts', '.tsx', '.json'],
  plugins: [tsResolvePlugin],
  logLevel: 'warning',
});

const child = spawn(process.execPath, [out], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
