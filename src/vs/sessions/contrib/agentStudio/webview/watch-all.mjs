#!/usr/bin/env node
/**
 * watch-all.mjs — AgentStudio webview 双构建链聚合 watch（2026-09-04）。
 *
 * AgentStudio 有两条独立 webview 构建链，改执行器/编辑器代码后**都要重建**，
 * 否则出现「主面板好了、E2E 跑旧代码」（或反之）：
 *   ① esbuild.config.mjs --watch  → media/webview.js（主面板；onEnd 自动同步 out/）
 *   ② visual/build.mjs  --watch   → visual/dist/canvas/canvas.js（E2E 沙箱 canvasHost）
 *
 * 用法：cd src/vs/sessions/contrib/agentStudio/webview && npm run watch
 * （Ctrl+C 同时停掉两条 watch。）
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const children = [];

function start(args, label) {
	const p = spawn(process.execPath, args, { stdio: 'inherit' });
	children.push(p);
	p.on('exit', (code) => {
		console.log(`[watch-all] ${label} exited (code=${code ?? 'signal'})`);
	});
	return p;
}

console.log('[watch-all] ① esbuild.config.mjs --watch  → media/webview.js (+auto sync to out/)');
console.log('[watch-all] ② visual/build.mjs   --watch  → visual/dist/canvas/canvas.js');
// ★ 独立端口 5598：--watch 会起静态服务，默认 5599 常被手动 `npm run visual` 的
//   残留实例占用（EADDRINUSE → watch 秒退）。5598 也冲突时可再改端口。
start(['esbuild.config.mjs', '--watch'], '① 主面板');
start(['visual/build.mjs', '--watch', '--port=5598'], '② E2E 沙箱');

function stopAll() {
	for (const p of children) {
		try { p.kill(); } catch { /* already dead */ }
	}
	process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
