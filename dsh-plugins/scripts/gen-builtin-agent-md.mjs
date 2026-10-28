/*
 * 重新生成 `resources/.agents/agents/<id>/.agent.md`（2026-10-27）。
 *
 * 为什么需要它：那些 .agent.md 是**产物**（真源是 `common/builtinAgents.ts`），
 * 而 `builtinAgentSingleSource.test.ts` ③ 要求「代码镜像 ↔ 文件真源逐字段一致」。
 * 只要改了代码不重新生成，那条用例就会红。
 *
 * 做法：esbuild 把「真源 + 序列化器」打成一个临时 ESM，直接调用
 * `getBuiltinAgents()` + `buildAgentMd()` —— 与宿主启动时同一条路径
 * （不是手写模板，避免出现第二份"生成规则"真源）。
 *
 * 用法：
 *   node dsh-plugins/scripts/gen-builtin-agent-md.mjs           # 写盘
 *   node dsh-plugins/scripts/gen-builtin-agent-md.mjs --check   # 只比对，有漂移则 exit 1
 *
 * ⚠ 两个必须记住的坑（都踩过）：
 *   1. 不能比整段文件文本：`buildAgentMd` 会写 createdAt/updatedAt = now ⇒ 每次都"漂移"。
 *      只比 name / description / systemPrompt / skills / tools（与 ③ 同口径）。
 *   2. `parseAgentMd()` 返回 `{ agent, systemPrompt }` —— 正文在**同级字段** systemPrompt 上，
 *      **不在** `agent.systemPrompt` 上。写成后者会拿到 undefined ⇒ 两边都归一化成空串 ⇒
 *      --check 永远"一致"（假绿）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const COMMON = join(REPO, 'src/vs/sessions/contrib/agentStudio/common');
const AGENTS_DIR = join(REPO, 'resources/.agents/agents');
const CHECK_ONLY = process.argv.includes('--check');

const esbuildMod = await import('file://' + join(REPO, 'src/vs/sessions/contrib/agentStudio/webview/node_modules/esbuild/lib/main.js'));
const esbuild = esbuildMod.default ?? esbuildMod;

const fwd = (p) => p.replace(/\\/g, '/');
const dir = mkdtempSync(join(tmpdir(), 'gen-agent-md-'));
const entry = join(dir, 'entry.ts');
writeFileSync(entry, [
	`export { getBuiltinAgents } from ${JSON.stringify(fwd(join(COMMON, 'builtinAgents.ts')))};`,
	`export { buildAgentMd, parseAgentMd } from ${JSON.stringify(fwd(join(COMMON, 'agentMdFormat.ts')))};`,
].join('\n'), 'utf8');

const out = join(dir, 'bundle.mjs');
const built = esbuild.buildSync({
	entryPoints: [entry],
	bundle: true, write: false, format: 'esm', platform: 'node',
	loader: { '.ts': 'ts' }, logLevel: 'silent', external: ['electron'],
});
writeFileSync(out, built.outputFiles[0].text, 'utf8');

const { getBuiltinAgents, buildAgentMd, parseAgentMd } = await import('file://' + fwd(out));
const agents = getBuiltinAgents();
console.log('  真源 agent = ' + agents.length + ' 个' + (CHECK_ONLY ? '（只比对，不写盘）' : ''));

const norm = (s) => String(s ?? '').replace(/\r/g, '').trim();

/** 只取 ③ 会比的那 5 个字段（正文读**同级** systemPrompt）。 */
function fieldsOf(md) {
	const parsed = parseAgentMd(md);
	if (!parsed) { return null; }
	const a = parsed.agent;
	return {
		name: norm(a.name),
		description: norm(a.description),
		systemPrompt: norm(parsed.systemPrompt),
		skills: JSON.stringify([...(a.skills ?? [])].sort()),
		tools: JSON.stringify([...(a.tools ?? [])].sort()),
	};
}

let written = 0;
const drift = [];
const broken = [];

for (const agent of agents) {
	const target = join(AGENTS_DIR, agent.id, '.agent.md');
	const text = buildAgentMd(agent);
	const current = existsSync(target) ? readFileSync(target, 'utf8') : '';

	const want = fieldsOf(text);
	const have = current ? fieldsOf(current) : null;
	const same = !!have && Object.keys(want).every((k) => want[k] === have[k]);
	if (same) { continue; }

	if (CHECK_ONLY) { drift.push(agent.id); continue; }

	mkdirSync(join(AGENTS_DIR, agent.id), { recursive: true });
	writeFileSync(target, text, 'utf8');
	written += 1;

	// 写后回读：同 5 字段（时间戳本来就会变）
	const again = fieldsOf(readFileSync(target, 'utf8'));
	if (!again || Object.keys(want).some((k) => want[k] !== again[k])) { broken.push(agent.id); }
}

if (CHECK_ONLY) {
	if (drift.length) {
		console.log('  ✗ 有漂移的 agent（' + drift.length + '/' + agents.length + '）：' + drift.join(', '));
		console.log('    修复：node dsh-plugins/scripts/gen-builtin-agent-md.mjs');
		process.exit(1);
	}
	console.log('  ✓ 产物与真源逐字段一致（' + relative(REPO, AGENTS_DIR) + '）');
} else {
	console.log('  ✓ 重生成 ' + written + ' 个 .agent.md'
		+ (broken.length ? '；回读不一致：' + broken.join(', ') : '；回读校验通过'));
	if (broken.length) { process.exit(1); }
}
