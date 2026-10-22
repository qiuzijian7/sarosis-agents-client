#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-host-singleton.mjs — 守卫：插件不许自带"宿主单例"的副本（对齐 dsh-desktop 的 HOST_SINGLETON_PATTERNS）。
 *
 * 为什么：React / react-dom / `@deepseek-ai/*` 由宿主（dsh web client 的共享模块表）独占。插件一旦自带一份：
 *   · 第二份 React ⇒ hooks 报 "Invalid hook call"（两个 React 实例）；
 *   · 第二份 `@deepseek-ai/*` ⇒ 服务 / 类型是两套，`ctx.inject` 拿到的不是同一个对象。
 * dsh-desktop 的做法（packages/dsh-desktop-market-installer/generations/installer.mjs:31-43）：
 *   `HOST_SINGLETON_PATTERNS = [/^react$/, /^react-dom$/, /^@deepseek-ai\//]`，安装时把它们从代际里删掉。
 * 我们现在是随包直装 ⇒ 在**源头**拦：清单与客户端产物里都不许出现。
 *
 * 两条规则：
 *   1. `package.json` 的 dependencies / optionalDependencies / bundleDependencies 不许命中单例模式
 *      （例外：`@deepseek-ai/schemastery` —— 官方工作台规范也把它当运行时依赖，`Config` 用它定义）；
 *      peerDependencies 不受限（官方要求的正是"写在 peer 里"）。
 *   2. 客户端入口（`exports["./client"]` 与同目录 `client.*.js` chunk）里不许出现**打包进来的 React 实现**
 *      （判据：React 内部导出名 / 生产构建特征串）。只能 `require('react')` 拿宿主那一份。
 *      白名单：`vssaros-imagegen/lib/canvas/**` —— Excalidraw 画布跑在**独立插件页文档**里（不进 dsh 客户端
 *      bundle，见 vendor/excalidraw/README.md），是另一个 JS realm，不与宿主 React 冲突。
 *
 * 非空跑：扫到的 package.json < 10 或客户端文件 < 5 ⇒ 直接失败（采集面失效时不许静默通过）。
 * 用法：node dsh-plugins/check-host-singleton.mjs [--root <dir>]
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 && process.argv[rootArg + 1] ? resolve(process.argv[rootArg + 1]) : here;

/** 与 dsh-desktop installer.mjs:32 逐字同款。 */
export const HOST_SINGLETON_PATTERNS = [/^react$/u, /^react-dom$/u, /^@deepseek-ai\//u];
const ALLOWED = new Set(['@deepseek-ai/schemastery']);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
/** 打包进来的 React 实现特征（任一命中即判定"自带了 React"）。 */
const REACT_BUNDLE_MARKERS = [
	'__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
	'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
	'react.production.min.js',
	'react-dom.production.min.js',
	'Minified React error #',
];
const CLIENT_WHITELIST = [/^vssaros-imagegen[\\/]lib[\\/]canvas[\\/]/];

const problems = [];
let pkgCount = 0;
let clientCount = 0;

for (const dir of readdirSync(root)) {
	const pkgPath = join(root, dir, 'package.json');
	if (!statSync(join(root, dir)).isDirectory() || !existsSync(pkgPath)) {
		continue;
	}
	let pkg;
	try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch (e) { problems.push(`${dir}/package.json 不是合法 JSON：${e.message}`); continue; }
	pkgCount++;
	for (const field of DEP_FIELDS) {
		const deps = pkg[field];
		const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
		for (const name of names) {
			if (!ALLOWED.has(name) && HOST_SINGLETON_PATTERNS.some(p => p.test(name))) {
				problems.push(`${dir}/package.json 的 ${field} 里有宿主单例 ${name} ⇒ 改成 peerDependencies（宿主独占，插件不许自带副本）`);
			}
		}
	}
	// 客户端产物：exports["./client"] + 同目录 client.*.js
	const clientRel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : pkg.exports?.['./client']?.default;
	if (typeof clientRel !== 'string') {
		continue;
	}
	const clientPath = join(root, dir, clientRel);
	const files = existsSync(clientPath) ? [clientPath] : [];
	const clientDir = dirname(clientPath);
	if (existsSync(clientDir)) {
		for (const f of readdirSync(clientDir)) {
			if (/^client\..+\.js$/.test(f)) {
				files.push(join(clientDir, f));
			}
		}
	}
	for (const f of files) {
		const rel = relative(root, f);
		if (CLIENT_WHITELIST.some(re => re.test(rel))) {
			continue;
		}
		clientCount++;
		// 注释里引用报错原文（如 "Minified React error #130" 的真机现场）不算打包进了 React ⇒ 先剥掉行注释与块注释
		const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
		const hit = REACT_BUNDLE_MARKERS.find(m => text.includes(m));
		if (hit) {
			problems.push(`${rel} 里打包进了 React 实现（特征串 "${hit}"）⇒ 只能 require('react') 用宿主那一份`);
		}
	}
}

if (pkgCount < 10 || clientCount < 5) {
	problems.push(`采集面异常：package.json ${pkgCount} 个、客户端文件 ${clientCount} 个（下限 10 / 5）⇒ 守卫可能在空跑`);
}

if (problems.length) {
	console.error(`[check-host-singleton] ✗ ${problems.length} 处：`);
	for (const p of problems) {
		console.error('  ' + p);
	}
	process.exit(1);
}
console.log(`[check-host-singleton] ✓ ${pkgCount} 个插件清单、${clientCount} 个客户端文件均未自带宿主单例（react / react-dom / @deepseek-ai/*）`);
