#!/usr/bin/env node
// check-superagent-ratchet.mjs ★ 静默失败 / 类型逃逸棘轮（2026-11-10）
//
// 只许减不许增：新增一个 `catch {}` 或 `as unknown as` 前，先想想能不能显式处理。
// 基线是 2026-11-10 实测值；要降低基线（销账）请同步改这里的常量，而不是调高上限。
// 与 check-legacy-freeze.mjs:19-24 同型。
//
// 跑法：node dsh-plugins/check-superagent-ratchet.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const P = 'dsh-plugins/vssaros-superagent/'
// ⚠ 只钉生产代码：dev/tests 的 `as unknown as` 是 fixture 类型逃逸（基线 107 且并行窗口常改），
//   纳入会让「别人加一条测试」把整条链卡红，反而逼着人调高上限、失去棘轮意义。
const BASELINE = {
	'dev/src': { catches: 64, casts: 26 },
	'vssaros-agents/lib/rooms.js': { catches: 11, casts: 0 },
	'vssaros-chat-surface/lib/client.workspaces.js': { catches: 165, casts: 0 },
}
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`) }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}
const countIn = (text) => ({ catches: (text.match(/catch \{/g) ?? []).length, casts: (text.match(/as unknown as/g) ?? []).length })
const walk = (d) => {
	let out = ''
	for (const e of readdirSync(d, { withFileTypes: true })) {
		const f = join(d, e.name)
		if (e.isDirectory()) { out += walk(f); }
		else if (/\.(ts|tsx)$/.test(e.name)) { out += readFileSync(f, 'utf8') + '\n'; }
	}
	return out
}

console.log('check-superagent-ratchet：静默失败与类型逃逸只许减不许增')
for (const [rel, base] of Object.entries(BASELINE)) {
	const isDir = !rel.endsWith('.js')
	const path = isDir ? join(ROOT, P, rel) : join(ROOT, 'dsh-plugins', rel)
	const text = isDir ? walk(path) : readFileSync(path, 'utf8')
	const now = countIn(text)
	ok(`${rel}：catch { ≤ ${base.catches}（当前 ${now.catches}）`, now.catches <= base.catches,
		now.catches > base.catches ? `新增 ${now.catches - base.catches} 处静默 catch，请显式处理或先销账` : '')
	ok(`${rel}：as unknown as ≤ ${base.casts}（当前 ${now.casts}）`, now.casts <= base.casts,
		now.casts > base.casts ? `新增 ${now.casts - base.casts} 处类型逃逸，请改用真实类型或先销账` : '')
}

console.log(problems.length ? `\n✗ check-superagent-ratchet：${problems.length} 项失败` : '\n✓ check-superagent-ratchet：全部通过')
process.exitCode = problems.length ? 1 : 0
