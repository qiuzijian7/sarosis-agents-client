import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
// VsSaros change (built-in): the source lives in the plugin's dev/ workspace and the build writes the shipped ../lib; the
// client registers under the shipped package's name. A VsSaros built-in has no dependencies of its own and its entry loads
// where no DSH package resolves, so zod, proper-lockfile and schemastery (with its cosmokit) are bundled; nothing else from
// DSH is imported at run time (src/infra/host.ts), and the remaining `@deepseek-ai/*` imports are types only.
const OUT = '../lib'
const PACKAGE = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts', 'p4-watch': 'src/sources/p4.ts', 'tapd-watch': 'src/sources/tapd.ts' }, outDir: OUT, format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false, deps: { neverBundle: [/^@deepseek-ai\/(?!schemastery|cosmokit)/], alwaysBundle: [/^zod(\/|$)/, /^proper-lockfile(\/|$)/, /^@deepseek-ai\/(schemastery|cosmokit)(\/|$)/] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: OUT, format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`, footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
