/*---------------------------------------------------------------------------------------------
 *  copy-src-resources.mjs —— 把 src/ 里的**非 TS 资源**补齐到 out/（不清空、只补缺/补旧）
 *
 *  ★ 2026-10-25（用户报「F5 没反应」）现场：
 *    `npm run watch` 启动时先 `cleanDir(out/)`，再 transpile（js 全部写出），最后
 *    `copyAllNonTsFiles` 拷 html/css/json…。当时 app 正在跑、占着 out/ 里的文件 ⇒
 *    资源拷贝阶段失败（watch 只打一行 "Initial build failed" 然后继续监听）⇒ out/ 只剩
 *    7874 个 js、**没有任何 html** ⇒ app 起不来，启动器 ABORT。
 *    这时不能再跑 `transpile-client`（它也会 cleanDir，和仍在运行的 watch 互相踩），
 *    只需要把资源补上 —— 这就是本脚本：**纯增量、无删除**，与 watch 共存安全。
 *
 *  规则与 build/next/index.ts 的 copyAllNonTsFiles 保持一致：
 *    · 拷所有非 .ts 文件；.d.ts 也拷（运行时类型引用要用）
 *    · 跳过 **\/webview/visual/**（开发期视觉测试基线）
 *    · 跳过 vs/package.json（会把 out/vs 误判成 CommonJS，主进程直接崩）
 *    · 跳过有同名 .ts 的 .js（transpile 产物才是对的）
 *
 *  用法：node scripts/copy-src-resources.mjs [--dry]
 *  输出最后一行：`RESOURCES copied=N skipped=M failed=K`（启动器据此判断）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SRC = path.join(REPO, 'src');
const OUT = path.join(REPO, 'out');
const dry = process.argv.includes('--dry');

const files = [];
(function walk(dir, rel) {
	let es;
	try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of es) {
		const r = rel ? rel + '/' + e.name : e.name;
		if (e.isDirectory()) {
			if (e.name === 'visual' && /(^|\/)webview$/.test(rel)) { continue; }
			walk(path.join(dir, e.name), r);
			continue;
		}
		if (r === 'vs/package.json') { continue; }
		if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) { continue; }
		if (e.name.endsWith('.js') && fs.existsSync(path.join(dir, e.name.replace(/\.js$/, '.ts')))) { continue; }
		files.push(r);
	}
})(SRC, '');

let copied = 0, skipped = 0, failed = 0;
const errors = [];
for (const r of files) {
	const from = path.join(SRC, r);
	const to = path.join(OUT, r);
	try {
		const a = fs.statSync(from);
		let b = null;
		try { b = fs.statSync(to); } catch { /* 不存在 */ }
		if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) { skipped++; continue; }
		if (!dry) {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
		}
		copied++;
	} catch (e) {
		failed++;
		if (errors.length < 5) { errors.push(r + ': ' + String(e && e.code || e)); }
	}
}

for (const e of errors) { console.log('  ✗ ' + e); }
console.log(`RESOURCES copied=${copied} skipped=${skipped} failed=${failed}${dry ? ' (dry)' : ''}`);
process.exit(failed ? 1 : 0);
