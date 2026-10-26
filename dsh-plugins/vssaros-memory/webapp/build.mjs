/*---------------------------------------------------------------------------------------------
 *  build.mjs — 把 `src/index.js` 打成 `../lib/detail.bundle.js`（2026-10-26）
 *
 * 为什么产物要**入库**：插件直接从 `lib/` 被宿主加载（dev/CI 都不跑构建）
 * ⇒ bundle 必须提交，否则 IDE 打开会 404 ✗
 *
 * 用法：node dsh-plugins/vssaros-memory/webapp/build.mjs
 * 守卫：`dsh-plugins/check-memory-detail-react.mjs` 检查产物存在且含 `data-memory-detail-tabs`
 *--------------------------------------------------------------------------------------------*/
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'lib', 'detail.bundle.js');

await esbuild.build({
  entryPoints: [path.join(HERE, 'src', 'index.js')],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  charset: 'utf8',   // ⚠ 默认 ascii 会把中文转成 \uXXXX ⇒ 产物不可读、diff 不可查 ✗
  legalComments: 'none',
  logLevel: 'info',
});


// 样式也拷一份到 lib/（服务端按需内联；单一真源仍是 webapp/src/detail.css ✓）
const CSS_IN = path.join(HERE, 'src', 'detail.css');
const CSS_OUT = path.join(HERE, '..', 'lib', 'detail.css');
if (fs.existsSync(CSS_IN)) {
  fs.copyFileSync(CSS_IN, CSS_OUT);
  console.log('[webapp] copied ' + CSS_OUT);
}

console.log('[webapp] built ' + OUT);
