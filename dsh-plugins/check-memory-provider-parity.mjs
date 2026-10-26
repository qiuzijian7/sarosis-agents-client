/*---------------------------------------------------------------------------------------------
 *  check-memory-provider-parity.mjs — 「IDE 调用的记忆方法，proxy 必须都实现」（2026-10-26）
 *
 * ## 为什么要有它（一次**完全静默**的失效）
 * IDE 每迭代调 `memoryProvider.observe?.(agentId, payload)` 写回合观测（"边聊边记"的唯一入口），
 * 而渲染侧代理 `AgentMemoryProviderProxy` **只有 `observeList`、没有 `observe`**
 * ⇒ `?.()` 变成 **no-op**，**一条日志、一个异常都没有** ⇒
 * 实测结果：`observeList('ws-…') = 0`、四层全 0、`addMemory/writeMemory = 0` 次
 * ⇒ 会话记忆从来没被写进去，而排查时"什么都看不到" ✗✗
 *
 * ## 判据（只查**真会影响行为**的那批，不做全量 216 个方法的对账）
 * 扫 `src/vs/sessions/contrib/agentStudio/browser/**` 里对 `memoryProvider` 的调用：
 *   ① `memoryProvider?.<m>(…)` —— **可选调用**：proxy 没实现 ⇒ 静默 no-op ⇒ **必红**（本守卫的主目标）
 *   ② `memoryProvider.<m>(…)`  —— 普通调用：proxy 没实现 ⇒ 运行时 TypeError ⇒ 也红
 * 然后逐个核对 `agentMemoryProviderProxy.ts` 是否定义了 `<m>(`。
 *
 * ⚠ 刻意**不**要求"V2 的 216 个方法 ⊆ proxy"：proxy 是**渲染侧子集**，
 *   大多数引擎方法（mesh/sketch/lease/…）IDE 根本不用 ⇒ 全量对账只会产生 149 条噪音 ✗
 *
 * 用法：node dsh-plugins/check-memory-provider-parity.mjs   （exit 0 = 通过）
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BROWSER_DIR = path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser');
const PROXY = path.join(ROOT, 'extensions', 'agentmemory-memory', 'src', 'agentMemoryProviderProxy.ts');

/** 去掉注释（行注释 + 块注释），避免注释里的示例代码造成误报。 */
function stripComments(text) {
	const out = [];
	let inBlock = false;
	for (const raw of text.split('\n')) {
		let s = raw.replace(/\r$/, '');
		if (inBlock) {
			const end = s.indexOf('*/');
			if (end < 0) { out.push(''); continue; }
			s = s.slice(end + 2);
			inBlock = false;
		}
		const bs = s.indexOf('/*');
		if (bs >= 0) {
			const end = s.indexOf('*/', bs + 2);
			if (end < 0) { s = s.slice(0, bs); inBlock = true; }
			else { s = s.slice(0, bs) + s.slice(end + 2); }
		}
		const lc = s.indexOf('//');
		if (lc >= 0) { s = s.slice(0, lc); }
		out.push(s);
	}
	return out.join('\n');
}

function walk(dir, acc = []) {
	for (const n of fs.readdirSync(dir)) {
		const p = path.join(dir, n);
		let st; try { st = fs.statSync(p); } catch { continue; }
		if (st.isDirectory()) { walk(p, acc); }
		else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) { acc.push(p); }
	}
	return acc;
}

const proxySrc = stripComments(fs.readFileSync(PROXY, 'utf8'));
/** proxy 实现了哪些方法（形如 `\tasync foo(` / `\tfoo(`）。 */
const implemented = new Set(
	[...proxySrc.matchAll(/^\t(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/gm)].map(m => m[1]),
);

const calls = new Map();   // method → { optional: Set(files), required: Set(files) }
for (const file of walk(BROWSER_DIR)) {
	const src = stripComments(fs.readFileSync(file, 'utf8'));
	const rel = path.relative(ROOT, file).replace(/\\/g, '/');
	// ⚠ 两种可选写法都要认（第一版只认前一种 ⇒ 漏掉了 observe 这个真缺陷 ✗✗）：
	//   ① memoryProvider?.loadContext( —— 可选点在**变量名后**
	//   ② memoryProvider.observe?.(    —— 可选点在**方法名后**（IDE 实际用的就是这种）
	for (const m of src.matchAll(/\b(\w*[Pp]rovider)\s*(\??)\.\s*(\w+)\s*(\??)\.?\s*\(/g)) {
		const recv = m[1];
		// 只认记忆类 provider 变量（kbProvider / graphProvider 等不是记忆 ⇒ 跳过 ✓）
		if (!/mem/i.test(recv)) { continue; }
		const optional = m[2] === '?' || m[4] === '?';
		const method = m[3];
		if (!calls.has(method)) { calls.set(method, { optional: new Set(), required: new Set() }); }
		(optional ? calls.get(method).optional : calls.get(method).required).add(rel);
	}
}

const problems = [];
for (const [method, v] of [...calls].sort((a, b) => a[0].localeCompare(b[0]))) {
	if (implemented.has(method)) { continue; }
	const where = [...v.required, ...v.optional].slice(0, 3).join(', ');
	if (v.optional.size > 0) {
		problems.push(`\`memoryProvider?.${method}(…)\` 被调用但 proxy **没有实现** ⇒ \`?.()\` 会**静默 no-op**`
			+ `（零日志零异常 ⇒ 这类缺陷排查时完全看不见 ✗✗）—— 调用点: ${where}`);
	} else {
		problems.push(`\`memoryProvider.${method}(…)\` 被调用但 proxy 没有实现 ⇒ 运行时会 TypeError —— 调用点: ${where}`);
	}
}

if (problems.length) {
	console.error(`✗ 记忆 provider 方法缺口（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	console.error('\n  处置：在 extensions/agentmemory-memory/src/agentMemoryProviderProxy.ts 补齐这些方法'
		+ '（转发到 `_call(\'<method>\', …)` 即可），并加一条"参数原样透传"的单测 ✓');
	process.exit(1);
}

console.log(`✓ 记忆 provider 方法齐备（IDE 侧调用 ${calls.size} 个方法，proxy 均已实现）`);
