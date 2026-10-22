#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-ide-capability-decls.mjs — 守卫：**dsh 侧 `ide.request` 用到的每个能力**，
 * 都必须同时满足 ① IDE 侧有执行端（`executeIdeCapability` 里有对应 case）② 调用方插件的
 *    清单**声明**了它（`vssaros.ideCapabilities`）。
 *
 * 为什么要有这条（2026-10-21 的发现）：
 *   能力请求要过**三关**才能生效 —— 主进程授权（看清单声明）、渲染进程执行（看 case）、
 *     Host 侧调用（看代码）。**任一关缺失都只会表现为"工具失败"**，日志里也没有线索
 *     （"市场不可用：…" 一句带过）⇒ 真机上极难定位 ✗。
 *   实测两个能力就是这样**长期坏着**的：
 *     · `skills` / `mcp`（`@vssaros/dsh-skills` 的 `skill_market`、`@vssaros/dsh-mcp` 的
 *       `mcp_market`）：清单没声明 + IDE 侧没 case ⇒ 两个都坏；
 *     · `kb`（`@vssaros/dsh-kb` 的语义检索 / 建向量索引）：要 IDE 侧的 **embedding** 实现
 *       ⇒ 本轮只**登记**为已知缺口（见 KNOWN_GAPS），修它要单独立项。
 *   ⇒ 这条守卫把"三关"变成**一次可自动核对的账** ⇒ 以后新增能力漏了哪一关立刻红 ✓。
 *
 * 纪律：
 *   · 采集面非空（扫不到任何 capability ⇒ 判定面失效 ⇒ 不能当通过 ✗）；
 *   · 匹配**代码形态**（`callIDE('ide.request', { capability: 'x' …`）且**剥掉注释**再匹配；
 *   · `KNOWN_GAPS` 里的每一项都必须是**仍然存在的缺口**（修好后要立刻从白名单移除 ⇒
 *     白名单不会变成垃圾桶 ✓）。
 *
 * 用法：node dsh-plugins/check-dsh-ide-capability-decls.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const pluginsDir = join(repo, 'dsh-plugins');

const problems = [];
const ok = (label) => console.log(`  ✓ ${label}`);

/**
 * **已知缺口白名单**（"三关缺哪一关"已查清、但本轮不修的）。
 *
 * ⚠ 每项都必须是**仍然存在**的缺口（守卫会反查：一旦修好 ⇒ 报"请从白名单移除"）✓
 * ⚠ 白名单不是"豁免"：这些能力在真机上**依然是坏的**（工具会失败）⇒ 只能当**账**，不能当"没事了"。
 */
const KNOWN_GAPS = {
	// `kb`：dsh 侧要 IDE 出 **embedding 向量**（`op: embed` / `embedBatch`），IDE 侧尚无该能力
	// （`executeIdeCapability` 没有 `case 'kb'`，`vssaros-kb` 也没声明）⇒ 语义检索 / 建向量索引
	// 在 dsh 侧不可用。修它要先在 IDE 侧接一个 embedding provider（另立项）。
	kb: 'IDE 侧尚无 embedding 执行端（op: embed/embedBatch）⇒ 语义检索/建索引在 dsh 侧不可用',
	// ⚠ **op 层**的已知缺口（这条守卫判到 capability 级为止，op 级的缺口写在这里备查）：
	//   `media` 能力族里，IDE 侧只实现了 `generateImage` / `editImage` / `capabilities`；
	//   而 `@vssaros/dsh-media` 的六个工具用到的 op（`generateVideo` / `generateAudio` /
	//   `visionAnalyze` / `videoAnalyze` / `extractVideoFrames` / …）**IDE 侧都还没有**
	//   ⇒ 补了清单声明后，授权这关过了，但这几个 op 仍会报"op 不认识"（可诊断，但功能不可用）✗。
	//   ⇒ 要让它们真的能用，得在 IDE 侧接视频/音频/视觉 provider（另立项）。
	//   （`@vssaros/dsh-imagegen` 的 `generateImage` / `editImage` 是**好的** ✓）
};

/** 剥注释：块注释 + 行注释（`//` 前不是引号/冒号/反斜杠 ⇒ URL 里的 `//` 不算注释）。 */
function code(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

function walkJs(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'vendor' || name === 'dist' || name === 'out') { continue; }
		const p = join(dir, name);
		if (statSync(p).isDirectory()) { walkJs(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
}

// ── ① IDE 侧执行端：executeIdeCapability 的 case 名单 ─────────────────────────
const capPath = join(repo, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshIdeCapabilities.ts');
if (!existsSync(capPath)) {
	console.error('[check-dsh-ide-capability-decls] ✗ 采集面缺失：dshIdeCapabilities.ts 不存在');
	process.exit(1);
}
const capSrc = code(readFileSync(capPath, 'utf8'));
const fnStart = capSrc.indexOf('export async function executeIdeCapability');
if (fnStart < 0) {
	console.error('[check-dsh-ide-capability-decls] ✗ 采集面失效：找不到 executeIdeCapability');
	process.exit(1);
}
const fnBody = capSrc.slice(fnStart);
const ideCases = new Set([...fnBody.matchAll(/case '([^']+)':/g)].map(m => m[1]));

// ── ② dsh 侧用到的 capability ───────────────────────────────────────────────
/** capability → Set(插件名) */
const usage = new Map();
for (const file of walkJs(pluginsDir)) {
	const src = code(readFileSync(file, 'utf8'));
	// 形态：`callIDE('ide.request', { capability: 'x', …`
	for (const m of src.matchAll(/callIDE\(\s*'ide\.request'\s*,\s*\{([\s\S]{0,400}?)\}/g)) {
		const cap = m[1].match(/capability:\s*'([^']+)'/);
		if (!cap) { continue; }
		const rel = file.slice(pluginsDir.length + 1).split(/[\\/]/).join('/');
		const plugin = rel.split('/')[0];
		if (!usage.has(cap[1])) { usage.set(cap[1], new Set()); }
		usage.get(cap[1]).add(plugin);
	}
}
if (usage.size === 0) {
	console.error('[check-dsh-ide-capability-decls] ✗ 采集面失效：dsh 侧一个 `ide.request` 调用都没扫到（扫描形态变了？）');
	process.exit(1);
}

// ── ③ 逐条对账 ──────────────────────────────────────────────────────────────
const gaps = [];
for (const [cap, plugins] of [...usage].sort()) {
	const hasCase = ideCases.has(cap);
	const missingDecl = [];
	for (const plugin of [...plugins].sort()) {
		const pkgPath = join(pluginsDir, plugin, 'package.json');
		let declared = [];
		if (existsSync(pkgPath)) {
			try {
				declared = JSON.parse(readFileSync(pkgPath, 'utf8'))?.vssaros?.ideCapabilities ?? [];
			} catch { declared = []; }
		}
		if (!declared.includes(cap)) { missingDecl.push(plugin); }
	}
	if (hasCase && missingDecl.length === 0) {
		ok(`${cap}：IDE 有执行端 + 声明齐（${[...plugins].join(', ')}）`);
		continue;
	}
	const why = [!hasCase ? 'IDE 侧无执行端' : '', missingDecl.length ? `未声明：${missingDecl.join(', ')}` : '']
		.filter(Boolean).join('；');
	if (KNOWN_GAPS[cap]) {
		gaps.push(`${cap}（${why}）—— ${KNOWN_GAPS[cap]}`);
		continue;
	}
	problems.push(`能力 ${cap}：${why} ⇒ 请求会静默失败（"三关"缺一关）✗`);
}

// ── ④ 白名单反查：已修好的必须从白名单移除 ──────────────────────────────────
for (const [cap, why] of Object.entries(KNOWN_GAPS)) {
	if (!usage.has(cap)) {
		problems.push(`KNOWN_GAPS 里的 ${cap} 现在**没有任何调用方**（要么已删、要么改了写法）⇒ 请核对后从白名单移除 ✗`);
		continue;
	}
	const hasCase = ideCases.has(cap);
	const plugins = [...usage.get(cap)];
	const allDeclared = plugins.every(plugin => {
		const pkgPath = join(pluginsDir, plugin, 'package.json');
		if (!existsSync(pkgPath)) { return false; }
		try {
			return (JSON.parse(readFileSync(pkgPath, 'utf8'))?.vssaros?.ideCapabilities ?? []).includes(cap);
		} catch { return false; }
	});
	if (hasCase && allDeclared) {
		problems.push(`KNOWN_GAPS 里的 ${cap} **已经修好**（IDE 有执行端 + 声明齐）⇒ 请从白名单移除 ✗（白名单留着就等于把缺口藏起来）`);
	}
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
if (problems.length > 0) {
	console.error(`[check-dsh-ide-capability-decls] ✗ 发现 ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
if (gaps.length > 0) {
	console.log('  ⚠ 已知缺口（**依然坏的**，只是已登记，避免再被发现一次）：');
	for (const g of gaps) { console.log(`    · ${g}`); }
}
console.log(`[check-dsh-ide-capability-decls] ✓ ${usage.size} 个能力的"三关"齐备（IDE 执行端 + 清单声明 + 调用方）`);
