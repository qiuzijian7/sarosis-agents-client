#!/usr/bin/env node
// 商城工作台插件（`@vssaros/dsh-marketplace`）的**页面脚本守卫**。
//
// ★ 为什么需要这道守卫（同类事故已犯两次，2026-10-22）：
//   在 PowerShell 上用 here-string 落盘长文件时，**内容里的 `||` 会被吞成 `;`**
//   （`|` 被 shell 当成管道符解析）⇒ 前端脚本里出现 `a || b` 变成 `a; b`：
//     · `a; b` 在多数位置**语法合法** ⇒ `node --check` 过得去 ⇒ 不会在提交前被发现；
//     · 运行时语义却变了（`pkg.permissions; {}` ⇒ 权限判定永远落到空对象 ⇒
//       按钮该藏不藏 / 该显不显）⇒ 表现为"界面上少个按钮"这种查不到根因的现象。
//   ⇒ 这道守卫**专门**抓这种"分号夹在表达式中间"的形态 ✓。
//
// ★ 守卫做三件事：
//   1. 扫 `lib/client.js` / `lib/index.js`：不允许出现"分号 + 同行还有内容"的表达式形态
//      （去掉字符串字面量后判定）✓；
//   2. `node --check` 真解析（语法坏了当场红）✓；
//   3. 页内脚本不许出现 `//` 行注释（拼出来是一长行 ⇒ 注释会吃掉后续拼接 ⇒ 整页交互静默失效）✓。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 本脚本在 `dsh-plugins/` 下 ⇒ 插件目录是它的同级子目录（不是仓库根的子目录）✓
const root = here;
const pluginDir = path.join(root, 'vssaros-marketplace');
const clientFile = path.join(pluginDir, 'lib', 'client.js');
const indexFile = path.join(pluginDir, 'lib', 'index.js');

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

if (!fs.existsSync(clientFile) || !fs.existsSync(indexFile)) {
	console.error('[check-marketplace-client] 找不到插件文件（vssaros-marketplace/lib/{client,index}.js）');
	process.exit(1);
}

// ── 1. 扫"被吞掉的 ||"形态 ────────────────────────────────────────
/**
 * 判据（**只抓有鉴别力的形态**，避免假阳性）：
 *   误替换 `a || b` → `a; b` 时，若 b 是**对象字面量**，结果是 `a; {}` ——
 *   这在 JS 里**语法合法**（`;` 是语句分隔、`{}` 是空块）⇒ `node --check` 抓不到 ✗
 *   ⇒ 这道守卫专门抓「分号 + 空块」这一形态 ✓（实测两处误替换都是它）。
 *
 * ⚠ **只保留这一条**：更宽的判据（"实参内有分号"）会被**正则字面量**误伤
 *   （`.replace(/"/g, 'x')` 里的分号）⇒ 假阳性会让守卫失去可信度 ✗。
 *   其它形态（`esc(a; 'x')` 这类**实参内**分号）语法非法 ⇒ 由 `node --check` 兜底 ✓。
 */
function scanSwallowedOperators(file) {
	const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
	const hits = [];
	lines.forEach((line, i) => {
		// 去掉字符串/模板串，避免把字符串里的内容当代码
		const code = line
			.replace(/'[^']*'/g, "''")
			.replace(/"[^"]*"/g, '""')
			.replace(/`[^`]*`/g, '``');
		// 「分号 + 空块」⇒ `|| {}` 被吞成 `; {}`
		if (/;\s*\{\s*\}/.test(code)) {
			hits.push({ line: i + 1, text: line.trim() });
		}
	});
	return hits;
}

for (const file of [clientFile, indexFile]) {
	const hits = scanSwallowedOperators(file);
	const rel = path.relative(root, file);
	if (hits.length === 0) {
		ok(`${rel}：没有被吞掉的运算符（分号形态扫描）`);
	} else {
		for (const h of hits) {
			fail(`${rel}:${h.line} 疑似 || 被吞成 ;（PowerShell here-string 会吃掉 |）⇒ ${h.text}`);
		}
	}
}

// ── 2. 真解析（语法坏了当场红）──────────────────────────────────
for (const file of [clientFile, indexFile]) {
	const rel = path.relative(root, file);
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', windowsHide: true });
		ok(`${rel}：node --check 通过`);
	} catch (e) {
		fail(`${rel}：语法错误（node --check 失败）⇒ ${String(e.stderr ?? e.message).split('\n').slice(0, 3).join(' ')}`);
	}
}

// ── 3. 清单与路由的自洽（页面必须能被 IDE 侧清单解析出来）────────
{
	const rel = path.relative(root, path.join(root, 'vssaros-marketplace', 'package.json'));
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'vssaros-marketplace', 'package.json'), 'utf8'));
	const route = pkg?.vssaros?.view?.route;
	if (route === '/x/marketplace/') {
		ok(`${rel}：清单路由 = ${route}（与页面/Host 路由一致）`);
	} else {
		fail(`${rel}：清单路由应为 /x/marketplace/，实际 ${String(route)}`);
	}
	const caps = pkg?.vssaros?.ideCapabilities;
	if (Array.isArray(caps) && caps.includes('marketplace')) {
		ok(`${rel}：清单声明了 marketplace 能力（否则 IDE 侧会拒授权）`);
	} else {
		fail(`${rel}：清单必须声明 ideCapabilities:["marketplace"]（缺了 IDE 侧直接拒授权）`);
	}
}

console.log(problems === 0
	? '\n[check-marketplace-client] ✓ 商城页面脚本守卫通过'
	: `\n[check-marketplace-client] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
