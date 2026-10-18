#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-spawn-hide.mjs — 守卫：dsh-plugins 里任何「起外部进程」的调用都必须带 windowsHide。
 *
 * 为什么（2026-10-17 真机取证）：dsh Host 是 node.exe，本身没有可继承的控制台。它起 CUI 子进程
 * （git / chrome / lark-cli …）时若不带 windowsHide（= CREATE_NO_WINDOW），Windows 会为**每次
 * 调用**新分配一个控制台窗口 ⇒ Windows Terminal / conhost 闪一下。用户报的「点 agent item 闪出
 * git 窗口」根因正是 `vssaros-agents/lib/memory.js` 的 git() 漏了 windowsHide（闪窗控制台属主
 * git.exe 的父进程就是 dsh Host 的 node.exe）。
 *
 * 采集面（按注册形态枚举，不要只认一种写法）：
 *   · 只扫 import / require 了 `node:child_process` | `child_process` 的文件；
 *   · 调用名含 promisify 别名：spawn / spawnSync / execFile / execFileSync / exec / execSync /
 *     execFileP / spawnP / execP（别名历史上真的踩过）；
 *   · 排除 node_modules / skills / assets / dist / test；
 *   · 判据：调用起点之后 500 字符内必须出现 windowsHide；
 *   · **非空跑守卫**：扫到的候选文件 < 5 或调用点 < 6 ⇒ 直接失败（glob/反选失效时不许静默通过）。
 *
 * 用法：node dsh-plugins/check-spawn-hide.mjs [--root <dir>]
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 && process.argv[rootArg + 1] ? resolve(process.argv[rootArg + 1]) : here;

const EXCLUDE_DIRS = new Set(['node_modules', 'skills', 'assets', 'dist', 'test', 'out']);
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const CP_IMPORT = /(?:from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\))/;
/** 调用名（含 promisify 别名）。前面不许紧跟标识符字符，避免 .exec( 之类的正则方法误伤。 */
const CALL = /(?<![\w$.])(execFileP|spawnP|execP|execFile|execFileSync|spawnSync|spawn|execSync|exec)\s*\(/g;

/**
 * 注释区间（字符串感知）：返回 [start,end) 列表。文档注释里常出现 `spawnSync(...)` 例子，
 * 不能当成真调用（否则守卫会被自己的注释误伤 ⇒ 开发者只好删注释，反过来丢了知识）。
 * 字符串/模板字符串里的 `//`、`/*` 不当作注释起点（URL 之类）。
 */
function commentRanges(src) {
	const ranges = [];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (c === '/' && c2 === '/') {
			const start = i;
			while (i < n && src[i] !== '\n') { i++; }
			ranges.push([start, i]);
			continue;
		}
		if (c === '/' && c2 === '*') {
			const start = i;
			i += 2;
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { i++; }
			i = Math.min(n, i + 2);
			ranges.push([start, i]);
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			i++;
			while (i < n) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === quote) { i++; break; }
				// 模板字符串里允许出现代码，但本守卫只看调用字面量 ⇒ 简单跳过整段即可
				i++;
			}
			continue;
		}
		i++;
	}
	return ranges;
}

function inRanges(ranges, index) {
	for (const [s, e] of ranges) {
		if (index >= s && index < e) { return true; }
	}
	return false;
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		let st;
		try { st = statSync(full); } catch { continue; }
		if (st.isDirectory()) {
			if (EXCLUDE_DIRS.has(name)) { continue; }
			walk(full, out);
			continue;
		}
		const dot = name.lastIndexOf('.');
		if (dot > 0 && EXTS.has(name.slice(dot).toLowerCase())) { out.push(full); }
	}
	return out;
}

const files = walk(root);
const candidates = [];
const failures = [];
let callSites = 0;

for (const file of files) {
	const src = readFileSync(file, 'utf8');
	if (!CP_IMPORT.test(src)) { continue; }
	candidates.push(file);

	const comments = commentRanges(src);
	// 判据只看**代码区**的 windowsHide —— 注释里写"这里必须带 windowsHide"不算
	// （反向突变实测：真把 `windowsHide: true` 删了、注释还在 ⇒ 旧判据假绿 ✗）。
	const hasHideInWindow = (from) => {
		const window = src.slice(from, from + 500);
		let idx = window.indexOf('windowsHide');
		while (idx >= 0) {
			if (!inRanges(comments, from + idx)) { return true; }
			idx = window.indexOf('windowsHide', idx + 1);
		}
		return false;
	};

	CALL.lastIndex = 0;
	let m;
	while ((m = CALL.exec(src))) {
		if (inRanges(comments, m.index)) { continue; } // 注释里的示例不算真调用
		callSites++;
		const callName = m[1];
		if (!hasHideInWindow(m.index)) {
			const before = src.slice(0, m.index).split('\n');
			failures.push({ file: relative(root, file), call: callName, line: before.length });
		}
	}
}

if (candidates.length < 5 || callSites < 6) {
	// 反选/目录失效时的"0 命中"不可信 ⇒ 必须非空跑（历史教训：反选 glob 的 0 命中等于假绿）。
	console.error(`[check-spawn-hide] 采集面异常：candidates=${candidates.length} callSites=${callSites}`
		+ `（要求 >=5 / >=6）—— 检查 root=${root} 与排除规则，别把"没扫到"当通过。`);
	process.exit(1);
}

if (failures.length > 0) {
	console.error(`[check-spawn-hide] ✗ ${failures.length} 处子进程调用缺 windowsHide（dsh Host 无控制台 ⇒ 会闪窗）：`);
	for (const f of failures) {
		console.error(`  ${f.file}:${f.line}  ${f.call}(...)`);
	}
	console.error('修复：选项对象里加 `windowsHide: true`（创建型别改默认值）。');
	process.exit(1);
}

console.log(`[check-spawn-hide] ✓ ${candidates.length} 个 child_process 文件 / ${callSites} 处调用均带 windowsHide`);
