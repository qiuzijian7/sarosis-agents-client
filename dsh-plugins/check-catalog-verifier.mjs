// @vssaros/dsh-plugins — 真机目录验收脚本的口径守卫（2026-11-09）
//
// 跑法：node dsh-plugins/check-catalog-verifier.mjs
//
// ★ 背景：`verify-catalog-runtime.mjs` 曾用「按行找 <available_skills>」解析，
//   把 `request/header` 事件里工具描述的标签字符串当成目录 ⇒ 真机明明 40 core 全覆盖
//   却报 `rows=4 core=0/40`。本守卫钉住解析口径的三条契约，并真跑 --self-test。
//   历史 durable 目录 / 非 vssaros preset 的分组逻辑也一并钉住，避免改回去。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const problems = [];
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
};
const src = read('dsh-plugins/scripts/verify-catalog-runtime.mjs');
const runSelfTest = () => spawnSync(process.execPath,
	['dsh-plugins/scripts/verify-catalog-runtime.mjs', '--self-test', '--json'],
	{ cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });

console.log('check-catalog-verifier：真机目录验收口径');

// ① 静态口径契约
{
	ok('① 只认 source.kind === skill-catalog 的 catalog 事件',
		src.includes("event?.data?.source?.kind !== 'skill-catalog'"));
	ok('① 要求 <available_skills> 开闭标签成对（拒绝截断块）',
		src.includes('line.indexOf(CLOSE, i)') && /if\s*\(!\(j > i\)\)\s*\{\s*continue;/.test(src));
	ok('① 预算只算随包技能，用户技能单独计数',
		src.includes('const bundled = (coreSeen ?? 0) + extendedSeen;')
		&& src.includes('other: last.names.length - bundled'));
	ok('① 按 agentPreset 区分收窄对象（非 vssaros 全量不判红）',
		src.includes('function agentPresetOf') && src.includes("preset.startsWith('vssaros-')")
		&& src.includes('const scoped = current.filter(s => s.scoped)'));
	ok('① 按 catalog 事件时间分 current / legacy（不看文件 mtime）',
		src.includes('const latestAt = perSession.length ? Math.max') && src.includes('s.last.at >= cutoff'));
	// ★ 磁盘级突变暴露的缺口：真机当前 core 恰好 40/40，把这条判据删掉不会立刻体现 ⇒
	//   必须静态钉住「missingCore 由 coreSeen < core.size 计算」，否则技能全丢时会假绿。
	ok('① core 全覆盖判据由 coreSeen 计算且参与 failed',
		/core\.size \? scoped\.filter\(s => \(s\.last\.coreSeen \?\? 0\) < core\.size\)/.test(src)
		&& /failed = scoped\.length > 0[\s\S]{0,180}missingCore\.length > 0/.test(src));
	ok('① 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-catalog-verifier.mjs'));
}

// ② 真跑 --self-test（合成事件覆盖四种情形）
{
	const r = runSelfTest();
	let parsed = null;
	try { parsed = JSON.parse(r.stdout); } catch { /* 下面统一报错 */ }
	ok('② 验收脚本 --self-test 全部通过', r.status === 0 && parsed?.failed === 0,
		`exit=${r.status} failed=${parsed?.failed ?? '?'} ${String(r.stderr ?? '').slice(0, 120)}`);
	ok('② self-test 覆盖了「工具描述里的假标签」用例',
		(parsed?.cases ?? []).some(c => /工具描述/.test(c.label) && c.ok));
	ok('② self-test 覆盖了「未闭合块」与「真 catalog」用例',
		(parsed?.cases ?? []).length >= 5);
	// ★ --json 必须能被直接 JSON.parse：曾因末尾多打一行「✓ 验收通过」而解析失败。
	//   结论走 results.passed / failed 字段，不再往 stdout 追加文本。
	const j = spawnSync(process.execPath, ['dsh-plugins/scripts/verify-catalog-runtime.mjs', '--json'],
		{ cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
	let realJson = null;
	try { realJson = JSON.parse((j.stdout ?? '').replace(/^\uFEFF/, '')); } catch { /* 下面判红 */ }
	ok('② --json 输出是纯 JSON 且带 passed / failed 结论',
		!!realJson && typeof realJson.passed === 'boolean' && typeof realJson.failed === 'boolean',
		`parse=${!!realJson} exit=${j.status}`);
}

// ③ 反向突变（内存副本 + 真跑 --self-test；判定用脚本源码文本，不污染仓库）
{
	const verdict = (s) => ({
		kindFilter: s.includes("event?.data?.source?.kind !== 'skill-catalog'"),
		pairCheck: /if\s*\(!\(j > i\)\)\s*\{\s*continue;/.test(s),
		bundledBudget: s.includes('const bundled = (coreSeen ?? 0) + extendedSeen;'),
		presetSplit: s.includes("preset.startsWith('vssaros-')"),
	});
	const base = verdict(src);
	ok('反向突变基线全绿', Object.values(base).every(Boolean), JSON.stringify(base));
	const cases = [
		['去掉 source.kind 过滤', "if (event?.data?.source?.kind !== 'skill-catalog') { continue; }", 'if (false) { continue; }', 'kindFilter'],
		['去掉闭合标签校验', 'if (!(j > i)) { continue; }', 'if (false) { continue; }', 'pairCheck'],
		['预算改回按总行数', 'const bundled = (coreSeen ?? 0) + extendedSeen;', 'const bundled = last.names.length;', 'bundledBudget'],
		['去掉 preset 区分', "preset.startsWith('vssaros-')", 'true', 'presetSplit'],
	];
	for (const [label, from, to, key] of cases) {
		const mutated = src.replace(from, () => to);
		ok(`反向突变 ${label} ⇒ 判据变红`, mutated !== src && verdict(mutated)[key] === false);
	}
}

console.log(problems.length ? `\n✗ check-catalog-verifier：${problems.length} 项失败` : '\n✓ check-catalog-verifier：全部通过');
if (problems.length) { for (const p of problems) { console.log(`  ✗ ${p}`); } }
process.exitCode = problems.length ? 1 : 0;
