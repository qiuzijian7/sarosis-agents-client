#!/usr/bin/env node
// 既存失败基线守卫：只盯 `known-test-failures.json` 里登记的测试。
//
// 为什么：这几条测试长期红，每轮都要人工「改动前状态对账」才能确认没有新增回归，
// 成本高且让「N/M 守卫绿」这个信号越来越钝。这里把对账自动化：
//   · 实测与基线完全一致 ⇒ 已知红，不算失败（本守卫 exit 0）
//   · 失败数变多 / 通过数变少 / 指纹消失 / runner 崩溃 ⇒ FAIL，必须复核
//   · 失败数变少 ⇒ FAIL 并提示回来销账（清单只减不增，与 fileSizeBudget 同一约定）
//
// 注意：本守卫**不隐藏**任何红；它只回答「红是不是已经登记过的那一个」。
// 新测试的红不允许靠写进基线绕过。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'dsh-plugins', 'known-test-failures.json');
const stripAnsi = s => String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

let registry;
try {
	registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (error) {
	console.error(`✗ 读基线失败：${error?.message ?? error}`);
	process.exit(1);
}
if (registry.schema !== 1 || !Array.isArray(registry.entries) || !registry.entries.length) {
	console.error('✗ 基线 schema 不是 1 或 entries 为空');
	process.exit(1);
}

const runner = join(ROOT, registry.runner);
if (!existsSync(runner)) {
	console.error(`✗ runner 不存在：${registry.runner}`);
	process.exit(1);
}

let failed = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const fail = msg => { console.error(`  ✗ ${msg}`); failed += 1; };

for (const entry of registry.entries) {
	const rel = entry.test;
	const label = rel.split('/').pop();
	if (!existsSync(join(ROOT, rel))) { fail(`${label}：测试文件不存在（基线过期）`); continue; }
	const r = spawnSync(process.execPath, [runner, rel], {
		cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024,
	});
	const out = stripAnsi((r.stdout ?? '') + (r.stderr ?? ''));
	if (r.error) { fail(`${label}：runner 启动失败 ${r.error.message}`); continue; }

	// 形态 A：esbuild 编译失败，无 mocha 摘要 ⇒ 用稳定的解析错误指纹判定
	if (entry.fingerprints) {
		const expectedExit = entry.exit ?? 1;
		if (r.status !== expectedExit) {
			fail(`${label}：预期编译失败 exit=${expectedExit}，实测 exit=${r.status} ⇒ 形态已变，需复核/销账`);
			continue;
		}
		const missing = entry.fingerprints.filter(f => !out.includes(f));
		if (missing.length) {
			fail(`${label}：基线指纹缺失（${missing.join(' ; ')}）⇒ 可能是修好了或错误形态变了，需复核/销账`);
			continue;
		}
		ok(`${label}：已知编译失败（${entry.fingerprints.length} 条指纹稳定）`);
		continue;
	}

	// 形态 B：有 mocha 摘要 ⇒ 逐项比对 passing / failing
	const p = /(\d+)\s+passing/.exec(out);
	const f = /(\d+)\s+failing/.exec(out);
	if (!p || !f) {
		fail(`${label}：拿不到 passing/failing 摘要（exit=${r.status}），无法与基线对账`);
		continue;
	}
	const passing = Number(p[1]);
	const failing = Number(f[1]);
	if (failing > entry.failing || passing < entry.passing) {
		fail(`${label}：新增回归 —— 基线 ${entry.passing}p/${entry.failing}f，实测 ${passing}p/${failing}f`);
	} else if (failing < entry.failing || passing > entry.passing) {
		fail(`${label}：失败减少/通过增加（实测 ${passing}p/${failing}f）⇒ 请回来销账并更新基线`);
	} else {
		ok(`${label}：已知红 ${passing}p/${failing}f（与基线一致）`);
	}
}

console.log(failed ? `\n✗ ${failed} 项基线漂移，需复核` : `\n✓ ${registry.entries.length} 项既存红均与基线一致（无新增回归）`);
process.exit(failed ? 1 : 0);
