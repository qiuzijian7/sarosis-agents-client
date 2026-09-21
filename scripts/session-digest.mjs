#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  会话历史体检 / 回放 digest（P1-7，2026-09-21）—— `npm run session:digest -- --all`
 *
 *  对**真实落盘历史**（快照 + 追加日志 ✓）做：回放 ⇒ 结构 digest ⇒ 不变量体检 ✓。
 *  典型用途：
 *    · 排查「这条会话为什么不渲染 / 模型为什么报孤儿工具调用」✓（findings 带 messageId ✓）；
 *    · 改上下文拼装 / 工具执行 / 持久化后，跑一遍拿**确定性对照** ✓（不含模型文本 ✓）；
 *    · CI 门：有 `violation` 即非零退出 ✓（`--no-fail` 只看不改码 ✓）。
 *
 *  ⚠ 本脚本 **import 编译产物**（`out/…/sessionReplay.js` ✓）而不是复刻逻辑 ——
 *    体检规则只有一处实现 ✓（先跑 `npm run transpile-client` ✓）。
 *    这也正是它比 `session-tail` 更安全的原因 ✗：那边为了能直接 `node` 跑而双写了游标语义 ✓。
 *
 *  用法：
 *      node scripts/session-digest.mjs --all                       # 全部 agent、全部会话
 *      node scripts/session-digest.mjs --agent saros-claw          # 某 agent 的全部会话
 *      node scripts/session-digest.mjs --agent X --session Y       # 单个会话（详细 findings）
 *      ... --json         # NDJSON（每行一个 {agent,session,digest,findings} ✓，提示行走 stderr ✓）
 *      ... --no-fail      # 有 violation 也 exit 0 ✓
 *      ... --root <dir>   # 会话根目录覆盖（默认平台探测 ✓）
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveChatHistoryRoot, sessionsDirOf } from './lib/chat-history-root.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = path.join(REPO_ROOT, 'out', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'sessionReplay.js');

const argv = process.argv.slice(2);
const pick = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const json = argv.includes('--json');
const noFail = argv.includes('--no-fail');
const info = (...a) => (json ? console.error(...a) : console.log(...a));

if (argv.includes('--help') || argv.includes('-h')) {
	info('用法：node scripts/session-digest.mjs (--all | --agent <id> [--session <id>]) [--json] [--no-fail] [--root <dir>]');
	process.exit(0);
}

if (!existsSync(COMPILED)) {
	info(`[session-digest] 缺少编译产物：${COMPILED}\n  ⇒ 先跑 \`npm run transpile-client\` ✓（本脚本刻意复用编译模块 ⇒ 规则单一实现 ✓）`);
	process.exit(3);
}
const { replaySessionHistory, formatDigestLine, hasBlockingFindings } = await import(pathToFileURL(COMPILED).href);

const root = resolveChatHistoryRoot(pick('root'));
const onlyAgent = pick('agent');
const onlySession = pick('session');
const allAgents = argv.includes('--all');
if (!allAgents && !onlyAgent) {
	info('需要 --all 或 --agent <id>（--help 看用法 ✓）');
	process.exit(2);
}

/** 收集待体检的 {agent, session} 列表 ✓。 */
function collectTargets() {
	const targets = [];
	const agents = allAgents
		? (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [])
		: [onlyAgent];
	for (const agent of agents) {
		const dir = sessionsDirOf(root, agent);
		if (!existsSync(dir)) { continue; }
		const ids = new Set();
		for (const f of readdirSync(dir)) {
			if (!/\.(json|jsonl)$/.test(f)) { continue; }
			if (f.endsWith('.draft.json') || f.endsWith('.sidecar')) { continue; }
			ids.add(f.replace(/\.(jsonl|json)$/, ''));
		}
		for (const session of onlySession ? [...ids].filter(id => id === onlySession) : [...ids].sort()) {
			targets.push({ agent, session });
		}
	}
	return targets;
}

const targets = collectTargets();
if (targets.length === 0) {
	info(`[session-digest] 没有可体检的会话（root=${root}${onlyAgent ? `, agent=${onlyAgent}` : ''}${onlySession ? `, session=${onlySession}` : ''}）`);
	process.exit(0);
}

let totalViolations = 0;
let totalWarnings = 0;
let totalMessages = 0;

for (const { agent, session } of targets) {
	const dir = sessionsDirOf(root, agent);
	const snapPath = path.join(dir, `${session}.json`);
	const logPath = path.join(dir, `${session}.jsonl`);
	let snap;
	let log;
	try { snap = existsSync(snapPath) ? readFileSync(snapPath, 'utf8') : undefined; } catch { snap = undefined; }
	try { log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined; } catch { log = undefined; }
	if (snap === undefined && log === undefined) { continue; }

	const r = replaySessionHistory(snap, log);
	const violations = r.findings.filter(f => f.severity === 'violation');
	const warnings = r.findings.filter(f => f.severity === 'warning');
	totalViolations += violations.length;
	totalWarnings += warnings.length;
	totalMessages += r.digest.messages;

	if (json) {
		console.log(JSON.stringify({ agent, session, digest: r.digest, logStats: r.logStats, findings: r.findings }));
	} else {
		info(`\n── ${agent} / ${session} ${r.logStats.tornLines > 0 ? `（日志截断 ${r.logStats.tornLines} 行 ✓ 已忽略）` : ''}`);
		info(`   ${formatDigestLine(r.digest)}`);
		for (const f of r.findings) {
			info(`   ${f.severity === 'violation' ? '✗' : '·'} [${f.kind}]${f.messageId ? ` (${f.messageId})` : ''} ${f.detail}`);
		}
		if (r.findings.length === 0) { info('   ✓ 无违规、无疑点'); }
	}
}

if (json) {
	console.error(`[session-digest] 会话 ${targets.length} 个，消息 ${totalMessages} 条；violation ${totalViolations}、warning ${totalWarnings}`);
} else {
	console.log(`\n[session-digest] 完成：${targets.length} 个会话 / ${totalMessages} 条消息；violation ${totalViolations}、warning ${totalWarnings}`);
}
process.exit(!noFail && totalViolations > 0 ? 1 : 0);
