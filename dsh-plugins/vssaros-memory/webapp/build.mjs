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


// ── 生成到 `lib/client.memory.js`（phase B：**彻底消灭重复**）────────────────
//   为什么是"生成"而不是"运行时 require"：dsh chunk 不能同步 require 相对模块
//   （只允许 require('react') 用宿主那份 + require.async）⇒ 只能构建期同步 ✓
const CHUNK = path.join(HERE, '..', 'lib', 'client.memory.js');
const chunkRaw = fs.readFileSync(CHUNK, 'utf8');
const CHUNK_NL = chunkRaw.includes('\r\n') ? '\r\n' : '\n';

/** 从 detailView.js 取 `createDetailView` 的函数体（去掉 h/hooks/API 声明 —— chunk 里已有）。 */
function factoryBodyOf(viewSrc) {
  const START = 'export function createDetailView(react) {';
  const start = viewSrc.indexOf(START);
  if (start < 0) { throw new Error('detailView.js 找不到 createDetailView'); }
  const afterBrace = viewSrc.indexOf('\n', start) + 1;
  const END = '  return { DETAIL_TABS, renderDetailTab, MemoryDetailPage };';
  const end = viewSrc.indexOf(END);
  if (end < 0) { throw new Error('detailView.js 找不到 return 行'); }
  let body = viewSrc.slice(afterBrace, end);
  const drops = [
    /^\s*const h = react\.createElement;\s*$/m,
    /^\s*const \{ useState, useEffect, useCallback \} = react;\s*$/m,
    /^\s*\/\*\*[^*]*\*\/\s*$/gm,
    // ⚠ 用**字符串匹配**而不是正则：`/x/memory/api` 里的斜杠会把正则转义搞乱（这里踩过 ✗）
    (line => (line.includes("const API = '/x/memory/api';") ? '' : line)),
  ];
  for (const d of drops) {
    body = typeof d === 'function' ? body.split('\n').map(d).join('\n') : body.replace(d, '');
  }
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/** chunk 里的生成块（语句缩进 2 tab + 首尾标记）。 */
function renderGeneratedBlock(viewSrc) {
  const body = factoryBodyOf(viewSrc).split(/\r?\n/).map(line => {
    const stripped = line.startsWith('  ') ? line.slice(2) : line;
    return stripped.length ? '\t\t' + stripped : '';
  }).join(CHUNK_NL);
  return [
    '\t\t/* @generated:detailView begin —— 由 `webapp/build.mjs` 从 `webapp/src/detailView.js` 生成，**别手改** ✗',
    '\t\t   （改真源后跑 `node dsh-plugins/vssaros-memory/webapp/build.mjs`；守卫会比对这块与真源是否一致）*/',
    body,
    '\t\t/* @generated:detailView end */',
  ].join(CHUNK_NL);
}

const MARK_RE = /\t\t\/\* @generated:detailView begin[\s\S]*?\/\* @generated:detailView end \*\//;
if (!MARK_RE.test(chunkRaw)) {
  console.error('[webapp] ✗ lib/client.memory.js 里找不到 @generated:detailView 标记块（先手工建一次标记）');
  process.exit(1);
}
const viewSrc = fs.readFileSync(path.join(HERE, 'src', 'detailView.js'), 'utf8');
const generated = renderGeneratedBlock(viewSrc);
const chunkNext = chunkRaw.replace(MARK_RE, generated);
if (chunkNext !== chunkRaw) {
  fs.writeFileSync(CHUNK, chunkNext, 'utf8');
  console.log('[webapp] regenerated lib/client.memory.js @generated:detailView');
} else {
  console.log('[webapp] lib/client.memory.js @generated:detailView 已是最新');
}

console.log('[webapp] built ' + OUT);
