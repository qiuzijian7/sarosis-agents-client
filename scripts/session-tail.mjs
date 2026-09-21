#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  会话事件流 tail（P1-5，2026-09-21）—— `npm run session:tail -- --agent <id> [--session <id>]`
 *
 *  这是**游标协议的第一个真实消费者** ✓，也是"跨进程可读"的证明 ✓：
 *  它完全不进 app、不共享内存，只读磁盘上的
 *      <chat-history>/<agentId>/sessions/<sessionId>.jsonl      （追加日志 ✓）
 *      <chat-history>/<agentId>/sessions/<sessionId>.json        （快照 ✓，reset 时是权威 ✗）
 *  并用**游标**（行序号 ✓）增量消费事件 ✓。
 *
 *  用途：
 *    · headless 观察正在跑的会话（`--follow` ✓）；
 *    · 排查「某条消息到底写没写进去 / 什么时候写进去的」✓；
 *    · 给其它工具喂 NDJSON（`--json` ✓）。
 *
 *  选项：
 *      --agent <id>        必填（agentId）
 *      --session <id>      会话 id；省略则**列出**该 agent 的会话 ✓
 *      --root <dir>        会话根目录覆盖（默认按平台探测 ✓，也可用 SAROSIS_CHAT_HISTORY_ROOT）
 *      --follow            持续跟随（默认间隔 1000ms ✓）
 *      --interval <ms>     轮询间隔（仅 --follow ✓）
 *      --from <seq>        起始游标（默认 0 = 从头 ✓）
 *      --json              输出 NDJSON（每行一个事件对象 ✓）
 *      --limit <n>         只打印最近 n 条消息事件（默认全部 ✓）
 *--------------------------------------------------------------------------------------------*/
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { resolveChatHistoryRoot } from './lib/chat-history-root.mjs';

// ── 参数解析（零依赖 ✓ 与 scripts/check-pi-drift.mjs 保持一致风格 ✓）──────────────
const argv = process.argv.slice(2);
const opts = { follow: false, json: false, interval: 1000, from: 0, limit: Infinity };
const pick = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 26).map(l => l.replace(/^\s\*\s?/, '')).join('\n'));
	process.exit(0);
}
const agentId = pick('agent');
if (!agentId) { console.error('缺少 --agent <id>（用 --help 看用法）'); process.exit(2); }
const sessionId = pick('session');
const rootOverride = pick('root') ?? process.env.SAROSIS_CHAT_HISTORY_ROOT;
opts.follow = argv.includes('--follow');
opts.json = argv.includes('--json');
if (pick('interval')) { opts.interval = Math.max(200, Number(pick('interval')) || 1000); }
if (pick('from')) { opts.from = Math.max(0, Number(pick('from')) || 0); }
if (pick('limit')) { opts.limit = Math.max(0, Number(pick('limit')) || 0); }

// 会话根目录：与 `AgentChatService._getChatHistoryRoot` 对齐 ✓（口径抽到共用模块 ⇒ 多脚本不会漂 ✗✓）
const root = resolveChatHistoryRoot(rootOverride);
const sessionsDir = path.join(root, agentId, 'sessions');
const logPath = sessionId ? path.join(sessionsDir, `${sessionId}.jsonl`) : undefined;
const snapshotPath = sessionId ? path.join(sessionsDir, `${sessionId}.json`) : undefined;

// ── 事件解析（与 src/.../common/sessionEventStream.ts 同一套语义 ✓）──────────────
// ⚠ 刻意**不 import** TS 源（本脚本必须能直接 `node` 跑 ✓）——但语义必须一致 ✗：
//   · 行序号 = 游标（1 起 ✓，只增不改 ✓）；
//   · 末尾半行**不越游标** ✓；
//   · 总行数 < 游标 ⇒ 日志被压缩重写 ⇒ 发 reset ✓；
//   · 屏障行 ⇒ 发 reset ✓。
function readEvents(text, from) {
	const lines = text ? text.split('\n') : [];
	const effective = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === '' && i === lines.length - 1) { continue; }
		effective.push({ raw: lines[i], seq: i + 1 });
	}
	const events = [];
	let torn = 0;
	let seq = from;
	if (effective.length < from) { events.push({ seq: from + 1, kind: 'reset', reason: 'log-rewritten' }); seq = 0; }
	for (const line of effective) {
		if (line.seq <= seq) { continue; }
		const raw = line.raw.trim();
		if (raw === '') { seq = line.seq; continue; }
		let parsed;
		try { parsed = JSON.parse(raw); } catch { torn++; break; }
		if (parsed?.op === 'base') { events.push({ seq: line.seq, kind: 'reset', reason: 'barrier' }); seq = line.seq; continue; }
		if (parsed?.op === 'a' && parsed.msg?.id) { events.push({ seq: line.seq, kind: 'message', msg: parsed.msg }); }
		seq = line.seq;
	}
	return { events, cursor: { seq }, torn, total: effective.length };
}

function snapshotMessageCount() {
	if (!snapshotPath || !existsSync(snapshotPath)) { return undefined; }
	try { return JSON.parse(readFileSync(snapshotPath, 'utf8')).length; } catch { return undefined; }
}

function printEvent(ev) {
	if (opts.json) { console.log(JSON.stringify(ev)); return; }
	if (ev.kind === 'reset') {
		const n = snapshotMessageCount();
		info(`[${String(ev.seq).padStart(5)}] ⟲ reset（${ev.reason}）⇒ 历史被整段改写/压缩，权威内容在快照` +
			(n === undefined ? '（快照不可读 ✗）' : `（快照 ${n} 条 ✓）`));
		return;
	}
	const m = ev.msg;
	const text = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
	info(`[${String(ev.seq).padStart(5)}] ${String(m.role ?? '?').padEnd(9)} ${text}${String(m.content ?? '').length > 120 ? '…' : ''}`);
}

if (!sessionId) {
	console.log(`[session-tail] 会话根目录：${root}`);
	if (!existsSync(path.join(root, agentId))) { console.error(`  未找到 agent 目录：${path.join(root, agentId)}`); process.exit(1); }
	console.log(`[session-tail] agent「${agentId}」的会话：`);
	const entries = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
	const ids = [...new Set(entries.filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
		.filter(f => !f.endsWith('.draft.json'))
		.map(f => f.replace(/\.(jsonl|json)$/, '')))];
	if (ids.length === 0) { console.log('  （无）'); process.exit(0); }
	for (const id of ids.sort()) {
		const log = path.join(sessionsDir, `${id}.jsonl`);
		const snap = path.join(sessionsDir, `${id}.json`);
		const logLines = existsSync(log) ? readEvents(readFileSync(log, 'utf8'), 0).total : 0;
		const snapCount = existsSync(snap) ? (() => { try { return JSON.parse(readFileSync(snap, 'utf8')).length; } catch { return 'unreadable'; } })() : '—';
		const mtime = existsSync(snap) ? statSync(snap).mtime.toISOString() : (existsSync(log) ? statSync(log).mtime.toISOString() : '');
		console.log(`  ${id}  快照=${String(snapCount).padEnd(6)} 日志行=${String(logLines).padEnd(5)} ${mtime}`);
	}
	process.exit(0);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
/**
 * 人类可读提示：`--json` 模式走 **stderr** ✓ —— 否则会污染 NDJSON 流 ✗
 * （消费方按行 `JSON.parse` 会直接炸 ✗）。
 */
const info = (...a) => (opts.json ? console.error(...a) : console.log(...a));
info(`[session-tail] ${path.join(root, agentId, 'sessions')}/${sessionId}`);
let cursor = { seq: opts.from };
let printed = 0;
const emit = (events) => {
	for (const ev of events) { printEvent(ev); printed++; }
};

function tick() {
	let text = '';
	if (existsSync(logPath)) {
		try { text = readFileSync(logPath, 'utf8'); } catch { text = ''; }
	}
	const r = readEvents(text, cursor.seq);
	if (r.torn > 0) { info(`[session-tail] ⚠ 末尾 ${r.torn} 行不完整（追加中被截断 ✓ 游标未越过它 ✓）`); }
	// --limit：只对"非跟随"模式生效（跟随模式不该丢事件 ✗）
	if (!opts.follow && opts.limit !== Infinity) {
		const msgs = r.events.filter(e => e.kind === 'message');
		const keepFrom = Math.max(0, msgs.length - opts.limit);
		emit(r.events.filter(e => e.kind !== 'message').concat(msgs.slice(keepFrom)));
	} else {
		emit(r.events);
	}
	cursor = r.cursor;
}

tick();
if (!opts.follow) {
	info(`[session-tail] 游标 = ${cursor.seq}（用 --from ${cursor.seq} 从这里继续 ✓；--follow 持续跟随 ✓）`);
	process.exit(0);
}
info(`[session-tail] 跟随中（间隔 ${opts.interval}ms，Ctrl+C 退出 ✓）游标 = ${cursor.seq}`);
setInterval(tick, opts.interval);
