#!/usr/bin/env node
// check-dsbot-notice.mjs — DS Bot（Apache-2.0）派生代码必须署名（2026-11-06，P2 合规收口）
//
// 规则：dsh-plugins/<插件>/ 下任何源文件（lib/**/*.js、dev/src/**/*.{ts,tsx,css}；跳过 node_modules / vendor）
// 只要写了它移植/参照的 DS Bot 源文件路径（`ds-bot/src/<…>.js`），就是派生文件，必须：
//   ① 列在该插件的 NOTICE 里（路径相对插件根，或相对 dev/ —— superagent 的源码在 dev/）；
//   ② 该插件 package.json 的 license 写成复合声明，含 Apache-2.0；files 里带 NOTICE。
// 反过来，NOTICE 里列的文件必须存在（避免改名后署名指向空）。
//
//   node dsh-plugins/check-dsbot-notice.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKER = /ds-bot\/src\/[\w/.-]+\.js/;
const slashed = (path) => path.split(sep).join('/');

function walk(dir, accept) {
	if (!existsSync(dir)) { return []; }
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && accept(entry.name) && !/[\\/](node_modules|vendor)[\\/]/.test(join(entry.parentPath, entry.name)))
		.map((entry) => join(entry.parentPath, entry.name));
}

const problems = [];
let derivedCount = 0;
for (const plugin of readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
	const base = join(ROOT, plugin);
	if (!existsSync(join(base, 'package.json'))) { continue; }
	const files = [
		...walk(join(base, 'lib'), (name) => name.endsWith('.js')),
		...walk(join(base, 'dev', 'src'), (name) => /\.(tsx?|css)$/.test(name)),
	];
	const derived = files.filter((file) => MARKER.test(readFileSync(file, 'utf8')));
	// superagent 的 lib/ 是 dev/src 的构建产物：只看源码一侧
	const sources = derived.filter((file) => !(existsSync(join(base, 'dev', 'src')) && slashed(relative(base, file)).startsWith('lib/')));
	if (!sources.length) { continue; }
	derivedCount += sources.length;
	const noticePath = join(base, 'NOTICE');
	if (!existsSync(noticePath)) { problems.push(`${plugin}: ${sources.length} 个 DS Bot 派生文件，但没有 NOTICE`); continue; }
	const notice = readFileSync(noticePath, 'utf8');
	for (const file of sources) {
		const fromRoot = slashed(relative(base, file)), fromDev = slashed(relative(join(base, 'dev'), file));
		if (!notice.includes(fromRoot) && !notice.includes(fromDev)) { problems.push(`${plugin}: ${fromRoot} 写了 ds-bot/src/ 来源，但 NOTICE 没列它`); }
	}
	// 本插件的文件（`ds-bot/src/…` 是被引用的上游来源，不算）
	for (const [, listed] of notice.matchAll(/(?<![\w/-])((?:lib|src)\/[\w/.-]+\.(?:js|tsx?|css))\b/g)) {
		if (!existsSync(join(base, listed)) && !existsSync(join(base, 'dev', listed))) { problems.push(`${plugin}: NOTICE 列了不存在的 ${listed}`); }
	}
	const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
	if (!/\bApache-2\.0\b/.test(String(pkg.license ?? ''))) { problems.push(`${plugin}: package.json 的 license（${pkg.license}）没有声明 Apache-2.0`); }
	if (!Array.isArray(pkg.files) || !pkg.files.includes('NOTICE')) { problems.push(`${plugin}: package.json 的 files 没有带上 NOTICE`); }
}

if (problems.length) {
	console.error(`[check-dsbot-notice] ✗ ${problems.length} 处：\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
console.log(`[check-dsbot-notice] ✓ ${derivedCount} 个 DS Bot 派生文件都已在各自插件的 NOTICE 署名，license 为复合声明`);
