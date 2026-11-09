// @vssaros/dsh-plugins — 运行时依赖树完整性守卫（2026-11-09）
//
// 跑法：node dsh-plugins/check-runtime-deps.mjs
//
// ★ 为什么需要：2026-11-09 真机事故 —— profile 与两个 dsh-runtime 的
//   `compression/node_modules/negotiator/lib/accept.js` 都缺，导致
//   `webserver` 等 4 个模块 failed to import ⇒ 9282 不监听 ⇒
//   `client api: session/prompt failed: Failed to fetch (gateway/internal)`。
//   这类缺件**重启 Host 修不好**（文件不在盘上），而全链守卫都在查仓库代码，
//   一条也没发现。本守卫把「运行时依赖树」也纳入检查，并在无开发环境时跳过。
//
// 真源是 `scripts/runtime-deps.mjs`（修复脚本与本守卫共用同一份规则），
// 本文件只做断言与反向突变，不复制规则。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const deps = await import(pathToFileURL(join(ROOT, 'dsh-plugins/scripts/runtime-deps.mjs')).href);
const problems = [];
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
};

console.log('check-runtime-deps：运行时依赖树完整性');

// ① 规则与真源
{
	ok('① 规则表存在且写明缺件后果',
		deps.DEP_RULES.length >= 1 && deps.DEP_RULES.every(r => r.nested && r.top && r.why)
		&& deps.DEP_RULES.some(r => r.nested.includes('negotiator/lib/accept.js')));
	ok('① 修复脚本可独立运行（CLI 有 --check / --json）',
		read('dsh-plugins/scripts/runtime-deps.mjs').includes("process.argv.includes('--check')")
		&& read('dsh-plugins/scripts/runtime-deps.mjs').includes('--json'));
	ok('① 本机无开发环境时优雅跳过（CI 不误报）',
		read('dsh-plugins/scripts/runtime-deps.mjs').includes('本机无 dsh 开发环境'));
	ok('① 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-runtime-deps.mjs'));
	ok('① 修复命令已注册', read('package.json').includes('repair:runtime-deps'));
}

// ② 用临时目录做纯逻辑反向验证（不碰真实依赖树）
{
	const tmp = mkdtempSync(join(tmpdir(), 'dep-guard-'));
	try {
		const base = join(tmp, 'node_modules');
		const lib = join(base, 'compression/node_modules/negotiator/lib');
		const top = join(base, 'negotiator/lib');
		mkdirSync(lib, { recursive: true }); mkdirSync(top, { recursive: true });
		writeFileSync(join(top, 'accept.js'), 'module.exports = function parseAccept(){};\n');
		for (const f of ['charset.js', 'encoding.js', 'language.js', 'mediaType.js']) writeFileSync(join(lib, f), 'x');
		const missing = deps.checkTree('probe', base);
		ok('② 缺 accept.js 时判出 missing（且可从顶层补）',
			missing.problems.length === 1 && missing.problems[0].state === 'missing',
			JSON.stringify(missing.problems));
		const fixed = deps.repairTree('probe', base);
		ok('② repairTree 从同树顶层复制且 hash 一致',
			fixed.length === 1 && fixed[0].hashOk === true && existsSync(join(lib, 'accept.js')));
		const after = deps.checkTree('probe', base);
		ok('② 补齐后不再报问题', after.problems.length === 0);
		// hash 不一致要能抓到（版本混装）
		writeFileSync(join(lib, 'accept.js'), 'module.exports = function DIFFERENT(){};\n');
		const mixed = deps.checkTree('probe', base);
		ok('② 嵌套与顶层内容不一致时判出 hash-mismatch',
			mixed.problems.length === 1 && mixed.problems[0].state === 'hash-mismatch');
		// 顶层也缺 ⇒ 不能假装能修
		rmSync(base, { recursive: true, force: true });
		mkdirSync(lib, { recursive: true });
		for (const f of ['charset.js']) writeFileSync(join(lib, f), 'x');
		const orphan = deps.checkTree('probe', base);
		ok('② 顶层也缺时判 source-missing（提示重装，不静默）',
			orphan.problems.length === 1 && orphan.problems[0].state === 'source-missing');
	} finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ③ 真实环境（有则查，无则跳过）
{
	const trees = deps.scan();
	if (trees.length === 0) {
		console.log('  ⓘ 本机无 dsh 开发环境 ⇒ 跳过真实依赖树检查（不算失败）');
	} else {
		const bad = trees.flatMap(t => t.problems.map(p => `${t.label}:${p.nested}(${p.state})`));
		ok(`③ 真实环境 ${trees.length} 棵依赖树完整`, bad.length === 0, bad.slice(0, 3).join(' | '));
	}
}

console.log(problems.length ? `\n✗ check-runtime-deps：${problems.length} 项失败` : '\n✓ check-runtime-deps：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
