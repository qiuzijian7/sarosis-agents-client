#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  上游 pi 漂移检查（P0-4，2026-09-21）—— `npm run check:pi-drift`
 *
 *  为什么需要：本仓的 `browser/piLoop/` 是**手工复刻**的 pi 内核（fork 基点
 *  `e98f287e…` ✓），差异清单在 `piLoop/FORK-DIVERGENCE.md` ✓。实测结论（D.0）：
 *    · 我们 fork 的 `agent-loop.ts` 自基点起 **0 改动** ✓（fork 源冻结 ✓）；
 *    · 上游仍在动（9 天 87 提交 ✓），但 churn 几乎全在**新增** `harness/pico3/*`
 *      —— 与 fork 模块**物理隔离** ✓；
 *    · ⇒ 真实风险不是"对齐债务累积"，而是"**上游 fix 不会自动到手**" ✓。
 *
 *  所以这脚本只做一件事：**盯住两个被 fork 的文件**，有变化就提示需要人工评估 ✓。
 *  `harness/`（pico3 新架构）**直接忽略** —— 官方标注 "Design under discussion"，
 *  跟进即追移动靶 ✗（详见 FORK-DIVERGENCE.md D.0 ✓）。
 *
 *  用法：
 *      node scripts/check-pi-drift.mjs              # 人类可读；发现漂移也 exit 0（不阻塞 ✓）
 *      node scripts/check-pi-drift.mjs --fetch      # 先 git fetch origin main 再比（默认不联网 ✓）
 *      node scripts/check-pi-drift.mjs --fail-on-drift   # 有漂移 ⇒ exit 1（CI 门 ✓）
 *
 *  上游仓库位置（按序探测，可用环境变量覆盖 ✓）：
 *      $PI_CLONE → ../pi（与本仓同级）→ G:\CustomWorkspaces\AIProjects\pi
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** fork 基点（与 `piLoop/FORK-DIVERGENCE.md` 必须一致 ✓）。 */
const FORK_BASE = 'e98f287ee498e0116546f4e9aa083fdec9793cd2';

/** 被 fork 的文件 —— **只看这两个** ✓（其余上游变化与我们无关 ✓）。 */
const WATCHED_PATHS = [
	'packages/agent/src/agent-loop.ts',
	'packages/agent/src/types.ts',
];

const args = new Set(process.argv.slice(2));
const shouldFetch = args.has('--fetch');
const failOnDrift = args.has('--fail-on-drift');

function findPiClone() {
	const candidates = [
		process.env.PI_CLONE,
		path.resolve(process.cwd(), '..', 'pi'),
		'G:\\CustomWorkspaces\\AIProjects\\pi',
	].filter(Boolean);
	for (const dir of candidates) {
		if (existsSync(path.join(dir, '.git'))) { return dir; }
	}
	return undefined;
}

const piDir = findPiClone();
if (!piDir) {
	console.log('[check:pi-drift] 未找到 pi 克隆（可设 PI_CLONE=<path>）⇒ 跳过 ✓');
	process.exit(0);
}
console.log(`[check:pi-drift] pi 克隆：${piDir}`);
console.log(`[check:pi-drift] fork 基点：${FORK_BASE}`);

const git = (gitArgs) => execFileSync('git', gitArgs, { cwd: piDir, encoding: 'utf8' }).trim();

try {
	if (shouldFetch) {
		try {
			git(['fetch', 'origin', 'main']);
			console.log('[check:pi-drift] 已 git fetch origin main ✓');
		} catch (err) {
			console.warn(`[check:pi-drift] fetch 失败（离线？）⇒ 用现有 refs 继续：${err.message.split('\n')[0]}`);
		}
	}

	let remoteRef = 'origin/main';
	try {
		git(['rev-parse', '--verify', remoteRef]);
	} catch {
		remoteRef = 'main';
		try {
			git(['rev-parse', '--verify', remoteRef]);
		} catch {
			console.log('[check:pi-drift] 没有可用的 origin/main 或 main ref ⇒ 跳过 ✓');
			process.exit(0);
		}
	}

	const range = `${FORK_BASE}..${remoteRef}`;
	const commits = git(['log', '--format=%h %ci %s', range, '--', ...WATCHED_PATHS]);
	const shortstat = git(['diff', '--shortstat', `${FORK_BASE}..${remoteRef}`, '--', ...WATCHED_PATHS]);

	console.log('');
	console.log(`── 被 fork 文件在 ${range} 的变化（${WATCHED_PATHS.join(' / ')}）──`);
	console.log(shortstat || '  （无差异 ✓）');

	if (!commits && !shortstat) {
		console.log('');
		console.log('[check:pi-drift] 结论：上游在**被 fork 的文件**上无变化 ⇒ 无需动作 ✓');
		console.log('[check:pi-drift] （`harness/pico3/*` 的变化按 FORK-DIVERGENCE.md D.0 直接忽略 ✓）');
		process.exit(0);
	}

	console.log('');
	console.log('── 需要人工评估的提交 ──');
	console.log(commits || '  （有 diff 但未见提交 —— 可能基点与 ref 关系异常，请人工核对 ✓）');
	console.log('');
	console.log('[check:pi-drift] 结论：**有漂移** ⇒ 按 FORK-DIVERGENCE.md D.2 评估移植（预计 0.5–1 天 ✓）；');
	console.log('              落地后请同步更新 FORK-DIVERGENCE.md 的 A/B 面 + 跑 piLoop 四套件 ✓。');
	process.exit(failOnDrift ? 1 : 0);
} catch (err) {
	console.warn(`[check:pi-drift] 检查失败（不阻塞 ✓）：${err.message.split('\n')[0]}`);
	process.exit(0);
}
