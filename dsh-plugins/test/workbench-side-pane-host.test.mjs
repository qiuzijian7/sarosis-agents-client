/*
 * 外壳契约测试：`buildSidePaneHtml` 的产物结构（2026-10-27）。
 *
 * 为什么单独测它：side pane 的 HTML 外壳从 700 行的 pane 里抽出来之后，
 * "看起来还能渲染"是最容易骗人的——CSP 少一条、脚本顺序反了、`</script>` 没转义，
 * 表现都是"面板白屏 / 后半段动作失灵"，而且只在你手点时才发现。
 *
 * 跑法：node dsh-plugins/test/workbench-side-pane-host.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const HOST = join(REPO, 'src/vs/sessions/contrib/agentStudio/common/workbenchSidePaneHost.ts');
const esbuildPath = join(REPO, 'src/vs/sessions/contrib/agentStudio/webview/node_modules/esbuild/lib/main.js');

const esbuild = (await import('file://' + esbuildPath.replace(/\\/g, '/'))).default;
const dir = mkdtempSync(join(tmpdir(), 'sph-'));
const out = join(dir, 'm.mjs');
const built = esbuild.buildSync({
	entryPoints: [HOST],
	bundle: true, write: false, format: 'esm', platform: 'node',
	loader: { '.ts': 'ts' }, logLevel: 'silent', external: ['electron'],
});
writeFileSync(out, built.outputFiles[0].text, 'utf8');
const mod = await import('file://' + out.replace(/\\/g, '/'));

const html = mod.buildSidePaneHtml({
	nonce: 'N1',
	js: 'console.log("bundle");',
	css: '.a{color:red}',
	dataVar: '__KB_SIDEVIEW_DATA__',
	data: { name: '</script><b>x', n: 1 },
	actionsJs: 'window.__KB_SIDEVIEW_ACTIONS__={openNode:p=>p};',
});

const checks = [
	['文档以 DOCTYPE 开头', html.startsWith('<!DOCTYPE html>')],
	['CSP 用 nonce 作为唯一脚本来源', html.includes("script-src 'nonce-N1';")],
	['CSP 允许 inline style', html.includes("style-src 'unsafe-inline'")],
	['CSP 允许 data:/https 图片', html.includes('img-src data: https:')],
	['基础样式带 nonce', html.includes('<style nonce="N1">html,body{height:100%')],
	['bundle 样式带 nonce', html.includes('<style nonce="N1">.a{color:red}</style>')],
	['注入了数据全局变量', html.includes('window.__KB_SIDEVIEW_DATA__ = ')],
	['数据里的 </script> 已被转义', !html.includes('</script><b>x') && html.includes('\\u003c/script>')],
	['动作桥在组件脚本之前执行', html.indexOf('__KB_SIDEVIEW_ACTIONS__') < html.indexOf('console.log("bundle")')],
	['组件脚本带 nonce', html.includes('<script nonce="N1">console.log("bundle");</script>')],
	['有 #root 挂载点', html.includes('<div id="root"></div>')],
];

let bad = 0;
for (const [name, ok] of checks) {
	console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok) { bad += 1; }
}
console.log('\n  ' + (bad ? '✗ ' + bad + ' 条不通过' : '✓ 外壳契约成立（' + checks.length + ' 条）'));
process.exit(bad ? 1 : 0);
