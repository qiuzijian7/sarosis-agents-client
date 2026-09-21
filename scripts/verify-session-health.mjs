#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  会话健康总检（P1-7 收尾，2026-09-21）—— `npm run verify:session-health`
 *
 *  一条命令回答：「持久化 / 事件流 / 回放 / 护栏 这几层现在还好吗？」✓
 *
 *  步骤（按序 ✓，任一步失败 ⇒ 整体非零退出 ✓）：
 *    ① **确定性测试**（common 全量 ✓ —— 自带 `failure-baseline.json` 基线容忍：只对**新增**失败判红 ✓）
 *       + 浏览器侧会话关键套件（`sessionHistoryLog`（P0-1 ✓）/ `agentChatBatchPersist` ✓）
 *    ② **真数据报告**：对本机 `chat-history` 跑 `session:digest` ✓（默认只报告 ✓；
 *       想让它成为门加 `--strict-real-data` ✓）
 *
 *  ── 为什么 digest 不进 CI 门 ✗（刻意 ✓）────────────────────────────────────────
 *  CI 机器上**没有真实会话数据** ⇒ 扫描 0 个会话、退出 0 ✓ —— 挂进 CI 只是形式主义 ✗。
 *  真正该进 CI 的是**确定性**部分 ✓（已由 `.github/workflows/agentstudio-kernel-tests.yml`
 *  覆盖：pi 内核套件 + legacy 准入 + **common 全量（基线门）** ✓；本脚本的①与之同源 ✓）。
 *
 *  用法：
 *      node scripts/verify-session-health.mjs                     # 全跑（默认 ✓）
 *      node scripts/verify-session-health.mjs --strict-real-data  # 真数据有 violation 即失败 ✓
 *      node scripts/verify-session-health.mjs --root <dir>        # 指定会话根 ✓
 *      node scripts/verify-session-health.mjs --skip-tests        # 只跑真数据报告 ✓
 *--------------------------------------------------------------------------------------------*/
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChatHistoryRoot } from './lib/chat-history-root.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON_RUNNER = 'src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs';
const BROWSER_RUNNER = 'src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs';

const argv = process.argv.slice(2);
const pick = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const strict = argv.includes('--strict-real-data');
const skipTests = argv.includes('--skip-tests');
const rootOverride = pick('root');

const results = [];
function runStep(name, args) {
	console.log(`\n════ ${name} ════`);
	const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
	const ok = (r.status ?? 1) === 0;
	results.push({ name, ok, status: r.status ?? 1 });
	return ok;
}

if (!skipTests) {
	if (!existsSync(path.join(REPO_ROOT, COMMON_RUNNER))) {
		console.error(`✗ 找不到 common runner：${COMMON_RUNNER}（路径基准变了 ✗）`);
		process.exit(3);
	}
	// ⚠ 读输出须知 ✗：common runner 会为**基线内**的既存失败打印 `✗ N 个套件未通过` ✓
	//   （当前 20 例 / 6 套件，见 `failure-baseline.json` ✓）——那是"存量待修"，不是本次回归 ✗。
	//   本脚本的判据是 **退出码** ✓（runner 只在**新增**失败 / 新增编译失败 / 运行时崩溃时非零 ✓），
	//   所以"看到 ✗ 却判 ✓"是正确行为 ✓；新增回归会让整行变 ✗ ✗。
	console.log('（注：下方 common 输出里的 ✗ 可能是基线内既存失败 ⇒ 判据以**退出码**为准 ✓）');
	// ①-a common 全量（基线门 ⇒ 只对新增失败判红 ✓）
	runStep('①-a 确定性测试：agentStudio common 全量（基线门）', [COMMON_RUNNER]);

	// ①-b 浏览器侧会话关键套件（**必须显式列出**：browser runner 需要逐个文件 ✓）
	for (const suite of ['sessionHistoryLog', 'agentChatBatchPersist']) {
		runStep(`①-b 浏览器套件：${suite}`, [BROWSER_RUNNER, `src/vs/sessions/contrib/agentStudio/test/browser/${suite}.test.ts`]);
	}
} else {
	console.log('（--skip-tests ⇒ 跳过确定性测试 ✓）');
}

// ② 真数据报告（默认非阻塞 ✓）
const root = resolveChatHistoryRoot(rootOverride);
const digestArgs = ['scripts/session-digest.mjs', '--all', '--root', root];
if (!strict) { digestArgs.push('--no-fail'); }
console.log(`\n════ ② 真数据报告：${root}${strict ? '（strict：有 violation 即失败 ✓）' : '（仅报告 ✓）'} ════`);
{
	const r = spawnSync(process.execPath, digestArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
	results.push({ name: '② 真数据体检（session:digest）', ok: (r.status ?? 1) === 0, status: r.status ?? 1 });
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
console.log('\n──────── 汇总 ────────');
for (const s of results) {
	console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}`);
}
const failed = results.filter(r => !r.ok);
if (failed.length === 0) {
	console.log('\n✓ 全部通过：持久化 / 事件流 / 回放 / 护栏 当前健康 ✓');
	console.log('  （真数据详情：npm run session:digest -- --all ✓；实时跟随：npm run session:tail -- --agent <id> --follow ✓）');
	process.exit(0);
}
console.error(`\n✗ ${failed.length} 个步骤未通过：`);
for (const f of failed) { console.error(`    ${f.name}（exit ${f.status}）`); }
console.error('  ① 失败 ⇒ 看上方套件细节（若是既存基线失败之外的**新增**失败，必须修 ✓）；');
console.error('  ② 失败 ⇒ 逐条看 violation（每条带 messageId ✓），用 `npm run session:digest -- --agent <id> --session <id>` 定位 ✓。');
process.exit(1);
