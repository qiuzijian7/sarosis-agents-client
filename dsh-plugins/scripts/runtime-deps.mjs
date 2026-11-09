/**
 * @vssaros/dsh-plugins — 运行时依赖树完整性（2026-11-09）。
 *
 * ★ 事故背景：profile 与两个 dsh-runtime 里，`compression/node_modules/negotiator/lib/`
 *   都缺 `accept.js`（顶层 `negotiator/lib/` 有）。`charset.js` 里 `require('./accept')`
 *   ⇒ compression 加载失败 ⇒ `webserver` / `web-startup` / `web-runtime` /
 *   `directory-picker` 四个模块 failed to import ⇒ 9282 不监听 ⇒
 *   IDE 客户端 `session/prompt` 报 `Failed to fetch (gateway/internal)`。
 *   重启 Host 不会补 npm 包里缺的文件，必须从同树顶层复制。
 *
 * 用法：
 *   node dsh-plugins/scripts/runtime-deps.mjs           # 检查并自动补齐
 *   node dsh-plugins/scripts/runtime-deps.mjs --check   # 只检查，缺件 exit 1
 *   node dsh-plugins/scripts/runtime-deps.mjs --json    # 机器可读
 *
 * 纯逻辑导出给 `check-runtime-deps.mjs` 复用（守卫与修复脚本不能各写一份真源）。
 * 本机没有开发环境（CI / 干净检出）⇒ `roots()` 返回空，调用方跳过，不误报。
 */
import { existsSync, readFileSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * 需要保证存在的「嵌套依赖文件 → 同树顶层同名文件」映射。
 * 新增条目要写明为什么（缺了会怎样），不要拿它当通用文件同步器。
 */
export const DEP_RULES = Object.freeze([
	Object.freeze({
		id: 'negotiator/accept.js',
		nested: 'compression/node_modules/negotiator/lib/accept.js',
		top: 'negotiator/lib/accept.js',
		why: 'compression → negotiator/lib/charset.js require("./accept")；缺了 webserver 起不来',
	}),
]);

const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex');

/**
 * 找所有需要检查的 `node_modules` 根：
 *   · 各 profile（dev / prod）的 `dsh-home/profiles/<name>/node_modules`
 *   · 各 dsh 运行时版本 `<runtime>/<ver>/node_modules`
 * 目录不存在就跳过 —— 干净检出/CI 不应因本机没装环境而判红。
 */
export function roots(home = homedir()) {
	const out = [];
	const profileBases = [
		join(home, '.vssaros-dev/dsh-home/profiles'),
		join(home, '.vssaros/dsh-home/profiles'),
	];
	for (const base of profileBases) {
		if (!existsSync(base)) { continue; }
		for (const e of readdirSync(base, { withFileTypes: true })) {
			if (!e.isDirectory()) { continue; }
			const nm = join(base, e.name, 'node_modules');
			if (existsSync(nm)) { out.push({ label: `profile/${e.name}`, base: nm }); }
		}
	}
	for (const base of [join(home, '.vssaros-dev/dsh-runtime'), join(home, '.vssaros/dsh-runtime')]) {
		if (!existsSync(base)) { continue; }
		for (const e of readdirSync(base, { withFileTypes: true })) {
			if (!e.isDirectory()) { continue; }
			const nm = join(base, e.name, 'node_modules');
			if (existsSync(nm)) { out.push({ label: `runtime/${e.name}`, base: nm }); }
		}
	}
	return out;
}

/**
 * 检查一棵树。
 * @returns `{ label, base, problems:[{id, nested, state, detail}] }`
 *   state: 'missing'（缺件，可从顶层补） | 'source-missing'（顶层也缺，需重装）
 *          | 'hash-mismatch'（文件在但内容不一致） | 'ok'
 */
export function checkTree(label, base) {
	const problems = [];
	for (const rule of DEP_RULES) {
		const nestedAbs = join(base, rule.nested);
		const topAbs = join(base, rule.top);
		// 只在「这棵树确实装了 compression 的嵌套 negotiator」时检查；没装就不需要这个文件
		const nestedDir = join(base, 'compression/node_modules/negotiator/lib');
		if (!existsSync(nestedDir)) { continue; }
		if (!existsSync(nestedAbs)) {
			problems.push({ id: rule.id, nested: rule.nested,
				state: existsSync(topAbs) ? 'missing' : 'source-missing',
				detail: existsSync(topAbs) ? `可从 ${rule.top} 补齐` : '顶层文件也缺失 ⇒ 需重装依赖', why: rule.why });
			continue;
		}
		if (existsSync(topAbs) && md5(nestedAbs) !== md5(topAbs)) {
			problems.push({ id: rule.id, nested: rule.nested, state: 'hash-mismatch',
				detail: '与同树顶层同名文件 hash 不一致（版本混装）', why: rule.why });
		}
	}
	return { label, base, problems };
}

/** 按规则补齐一棵树；只处理 state==='missing'。返回修复的条目。 */
export function repairTree(label, base) {
	const fixed = [];
	for (const rule of DEP_RULES) {
		const nestedAbs = join(base, rule.nested);
		const topAbs = join(base, rule.top);
		if (!existsSync(join(base, 'compression/node_modules/negotiator/lib'))) { continue; }
		if (existsSync(nestedAbs) || !existsSync(topAbs)) { continue; }
		copyFileSync(topAbs, nestedAbs);
		fixed.push({ label, id: rule.id, file: rule.nested, bytes: statSync(nestedAbs).size,
			hashOk: md5(nestedAbs) === md5(topAbs) });
	}
	return fixed;
}

export function scan(home = homedir()) {
	return roots(home).map(({ label, base }) => checkTree(label, base));
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('dsh-plugins/scripts/runtime-deps.mjs')) {
	const asJson = process.argv.includes('--json');
	const checkOnly = process.argv.includes('--check');
	const trees = scan();
	if (trees.length === 0) {
		console.log(asJson ? JSON.stringify({ skipped: true, reason: '本机无 dsh 开发环境' })
			: 'runtime-deps：本机无 dsh 开发环境，跳过');
		process.exit(0);
	}
	const before = trees.flatMap(t => t.problems.map(p => ({ label: t.label, ...p })));
	const fixed = checkOnly ? [] : trees.flatMap(t => repairTree(t.label, t.base));
	const after = checkOnly ? before : scan().flatMap(t => t.problems.map(p => ({ label: t.label, ...p })));
	if (asJson) {
		console.log(JSON.stringify({ trees: trees.length, missingBefore: before.length, fixed, remaining: after }, null, 2));
	} else {
		console.log(`runtime-deps：检查 ${trees.length} 棵依赖树`);
		if (before.length) { for (const p of before) { console.log(`  ✗ ${p.label} ${p.nested}：${p.state} — ${p.detail}`); } }
		if (!checkOnly) { for (const f of fixed) { console.log(`  ✓ ${f.label} 补齐 ${f.file}（${f.bytes}B hash=${f.hashOk ? 'OK' : 'MISMATCH'}）`); } }
		if (after.length === 0) { console.log('  ✓ 依赖树完整'); }
		else { for (const p of after) { console.log(`  ✗ 仍缺失：${p.label} ${p.nested}（${p.state}）`); } }
	}
	process.exitCode = after.length ? 1 : 0;
}
