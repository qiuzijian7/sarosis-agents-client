// @vssaros/dsh-codebase — parser/resolve：**tree-sitter wasm 资产在哪**（P0 自证的资产半边）。
//
// ★ 为什么单独一层：写侧要真解析，第一件会撞上的事不是算法，而是"运行时 + grammar 从哪来" ✗。
//   本层只做一件事：把候选目录逐个**探一遍**，返回"用了哪个、为什么用它"，并**如实列出试过哪些** ✓
//   （与 store.js 的 `resolveRoot` 同一条纪律：不猜、并且把"实际用的"回传 ✗——静默用错资产最贵 ✓）。
//
// ## P0 实测出来的两个真结论（2026-10-12，都写进代码而不是只写在文档里 ✓）
//
// ① **`@vscode/tree-sitter-wasm` 的 web 构建在 Node 里能跑** ✓（原以为"要另配 Node 版运行时"）
//    证据：`wasm/tree-sitter.js` 是 **UMD**（文件头 `typeof define === 'function' && define.amd ? … : module.exports = factory()`），
//    且 Emscripten 里带 `ENVIRONMENT_IS_NODE` 分支（`tree-sitter.js:2097`）⇒ `require()` 拿到
//    `{ Parser, Language, … }`，`Parser.init({ locateFile })` 走 Node 分支用 `fs` 读 wasm ✓。
//    实测：init 12ms、解析 8 行 TS 合计 22ms（`worker_threads` 里同样 11ms/16ms ✓）。
//
// ② ⚠ **资产"拷进包"这件事有一个静默陷阱**：仓库根 package.json 是 `"type": "module"` ⇒
//    拷进插件目录的 `tree-sitter.js` 会被当 **ESM** 求值（Node 22.12+ 的 `require(esm)` 会"成功"）
//    ⇒ UMD 走 `globalThis` 分支、`__filename` 未定义 ⇒ 报 **`Unable to determine script URL`** ✗✗
//    —— 一句看不出根因的话，而且**离线字符串比对完全看不出来** ✓（本仓同型教训：YAML 缩进、漏 files）。
//    ⇒ 纪律：**放进我们包里的运行时一律命名为 `.cjs`** ✓（Node 规范：`.cjs` 永远是 CJS，与所在
//    scope 的 type 字段无关 ✓ 实测通过）。`resolve` 因此**优先找 `.cjs`**，并把"只找到 `.js`"
//    这件事如实报成 `kind: 'esm-scope-risk'`，而不是等 `require` 抛一句看不懂的话 ✗。
//
// ## 候选链（顺序即优先级，全部可观测）
//   ① `config.treeSitterWasmDir`（VsSaros 经覆盖层注入 —— 与 workspaceRoot 同一套路 ✓）
//   ② 环境变量 `VSSAROS_TREE_SITTER_WASM_DIR`（零覆盖层也能配 ✓）
//   ③ **随包目录** `<插件根>/vendor`（将来的正式交付位置；P0 阶段通常不存在 ✓）
//   ④ dev 兜底：`<cwd>/node_modules/@vscode/tree-sitter-wasm/wasm`（只有我们能控制 cwd 的场合才对 ✓）
//
// ⚠ ③④ 都是"**能被猜到的**"位置，所以**解析结果必须可观测**（页面诊断行 + 工具输出都打印实际目录 ✓）。
//   ⇒ 不做"全盘搜索 node_modules"那种兜底 ✗（那会在别人的 app 里读到别人的 wasm，静默且无法解释 ✓）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 环境变量名（照本模块既有 `VSSAROS_DATA_ROOT` 的口径 ✓）。 */
export const PARSER_DIR_ENV = 'VSSAROS_TREE_SITTER_WASM_DIR';
/** 运行时文件名：**优先 `.cjs`**（见文件头结论 ②）✓。 */
export const RUNTIME_CJS = 'tree-sitter.cjs';
/** 上游原始名（只在 dev 的 node_modules 里合法：那个包的 package.json 没有 `type` 字段 ✓）。 */
export const RUNTIME_JS = 'tree-sitter.js';
/** 运行时 wasm。 */
export const RUNTIME_WASM = 'tree-sitter.wasm';
const GRAMMAR_PREFIX = 'tree-sitter-';
const GRAMMAR_SUFFIX = '.wasm';

/** 插件根（`lib/parser/` 往上两级）—— 用 `import.meta.url` 而不是 cwd ✓（与进程在哪无关）。 */
export function pluginRootOf() {
	return fileURLToPath(new URL('../../', import.meta.url));
}

/** 随包候选目录（正式交付位置）。 */
export function vendorDirOf() {
	return join(pluginRootOf(), 'vendor');
}

/** grammar 文件名（语言名与真实文件名同构：`typescript` → `tree-sitter-typescript.wasm` ✓）。 */
export function grammarFileOf(language) {
	return `${GRAMMAR_PREFIX}${String(language)}${GRAMMAR_SUFFIX}`;
}

/**
 * 探一个目录：**只读**（authored: 目录不存在 ⇒ 不是异常，是"这个候选不成立" ✓）。
 * @returns `{ ok, runtime, languages, why }` —— `why` 是**给人和模型看**的一句话 ✓
 */
export function inspectWasmDir(dir) {
	if (typeof dir !== 'string' || !dir.trim()) {
		return { ok: false, why: '目录为空' };
	}
	let entries;
	try {
		if (!statSync(dir).isDirectory()) {
			return { ok: false, why: '不是目录' };
		}
		entries = readdirSync(dir);
	} catch (e) {
		return { ok: false, why: `读不到目录（${String(e?.code ?? e?.message ?? e)}）` };
	}
	const has = name => entries.includes(name);
	const runtime = has(RUNTIME_CJS) ? RUNTIME_CJS : (has(RUNTIME_JS) ? RUNTIME_JS : undefined);
	if (!runtime) {
		return { ok: false, why: `没有运行时（既没有 ${RUNTIME_CJS} 也没有 ${RUNTIME_JS}）` };
	}
	if (!has(RUNTIME_WASM)) {
		return { ok: false, why: `没有 ${RUNTIME_WASM}` };
	}
	const languages = entries
		.filter(name => name.startsWith(GRAMMAR_PREFIX) && name.endsWith(GRAMMAR_SUFFIX) && name !== RUNTIME_WASM)
		.map(name => name.slice(GRAMMAR_PREFIX.length, -GRAMMAR_SUFFIX.length))
		.sort();
	if (!languages.length) {
		return { ok: false, runtime, languages, why: '一个 grammar 都没有（目录里只有运行时）' };
	}
	return { ok: true, runtime, languages };
}

/**
 * 候选列表（顺序即优先级；`source` 是要**原样披露**给用户的"这份资产凭什么被信任" ✓）。
 *
 * ★ `options.vendorDir`（2026-10-12 加）：把**第③级候选**指到别处 —— 与 `cwd`/`env` 同一类的注入缝 ✓。
 * 为什么需要它：**全量交付之后**（决策 2 = 21MB 随包），`vendor/` 在任何环境里都存在 ⇒ 探针再想造
 * "**零候选**"那种状态（"这台机器上什么都没有"）就没有别的办法了 ✗ —— 而那条负例仍然值得钉住：
 * 它保护的正是"没有任何资产时要说清试过哪些"（错误文案的可操作性 ✓）。
 * 生产路径**永远不传**它 ⇒ 缺省就是 `vendorDirOf()` ✓（默认值不改变任何行为 ✓）。
 */
export function candidateDirs(config, { cwd = process.cwd(), env = process.env, vendorDir } = {}) {
	const out = [];
	const configured = typeof config?.treeSitterWasmDir === 'string' ? config.treeSitterWasmDir.trim() : '';
	if (configured) {
		out.push({ dir: configured, source: 'config.treeSitterWasmDir' });
	}
	const fromEnv = typeof env?.[PARSER_DIR_ENV] === 'string' ? env[PARSER_DIR_ENV].trim() : '';
	if (fromEnv) {
		out.push({ dir: fromEnv, source: `env ${PARSER_DIR_ENV}` });
	}
	out.push({ dir: typeof vendorDir === 'string' && vendorDir ? vendorDir : vendorDirOf(), source: '随包 vendor/' });
	out.push({ dir: join(cwd, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'), source: 'dev cwd 的 node_modules' });
	return out;
}

/**
 * 解析"用哪个目录"：**逐个探、第一个能用的胜出**；都不可用时 `dir = undefined` 且 `tried` 里
 * 每条都有**拒绝理由** ✓（页面与工具要能原样显示 —— "解析器不可用"最没用的版本就是不说是哪一步不可用 ✓）。
 * @returns `{ dir, source, runtime, languages, risk, tried }`
 *   `risk`：`'esm-scope-risk'` = 目录里只有 `.js` 且它落在 `"type":"module"` 的作用域里（见文件头结论 ②）
 */
export function resolveWasmDir(config, options = {}) {
	const tried = [];
	for (const candidate of candidateDirs(config, options)) {
		const inspected = inspectWasmDir(candidate.dir);
		const entry = { ...candidate, ok: inspected.ok, why: inspected.why, runtime: inspected.runtime };
		tried.push(entry);
		if (!inspected.ok) {
			continue;
		}
		// 只有 `.js` 时给出风险标记（**不据此拒绝** ✓ —— dev 的 node_modules 正是这种、而且完全正常 ✓）
		const risk = inspected.runtime === RUNTIME_JS && insideEsmScope(candidate.dir) ? 'esm-scope-risk' : undefined;
		return { dir: candidate.dir, source: candidate.source, runtime: inspected.runtime, languages: inspected.languages, risk, tried };
	}
	return { dir: undefined, source: undefined, runtime: undefined, languages: [], tried };
}

/**
 * 这个目录里 `require('tree-sitter.js')` 会不会被当 ESM？—— 只看**最近的** package.json 的 `type` ✓。
 * 判据故意**窄**：只在"目录里确实有 package.json 且写了 type: module"时报 ✓（不许凭路径猜 ✗）。
 */
function insideEsmScope(dir) {
	// 从 dir 往上找第一个 package.json（最多 3 层：够覆盖 `<插件根>/vendor` 与 `node_modules/<包>/` ✓）
	let current = dir;
	for (let i = 0; i < 3; i++) {
		const manifest = join(current, 'package.json');
		try {
			if (existsSync(manifest)) {
				// 同步读一个小文件（package.json 总是很小 ✓）；**不用** `import` 缓存/require 缓存 ⇒ 每次看盘上现状 ✓
				const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
				return parsed?.type === 'module';
			}
		} catch {
			return false; // 读不动/畸形 ⇒ 不当成风险（不制造新故障 ✓）
		}
		const parent = join(current, '..');
		if (parent === current) { break; }
		current = parent;
	}
	return false;
}
