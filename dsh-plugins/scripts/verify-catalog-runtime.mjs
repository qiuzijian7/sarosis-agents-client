#!/usr/bin/env node
/**
 * @vssaros/dsh-plugins — 真机技能目录验收（2026-11-08 建立，2026-11-09 修正口径）
 *
 * 跑法：
 *   node dsh-plugins/scripts/verify-catalog-runtime.mjs
 *   node dsh-plugins/scripts/verify-catalog-runtime.mjs --json
 *   node dsh-plugins/scripts/verify-catalog-runtime.mjs --self-test
 *   node dsh-plugins/scripts/verify-catalog-runtime.mjs --sessions <dir> --max-entries 40
 *   node dsh-plugins/scripts/verify-catalog-runtime.mjs --since 2026-11-09T09:55 --all-history
 *
 * ★ 为什么必须用会话记录：`catalog-fallback` 是**兜底日志**，官方 `dsh-tool-skill`
 *   正常发布目录时本就不该出现；用它验收会得到「没日志 = 没生效」的反向结论（踩过）。
 *
 * ★ 2026-11-09 修正三处口径缺陷（都曾导致真机明明正确却判红）：
 *   ① **只认真正的 catalog 事件**。`request/header` 等事件的工具描述里也会出现字符串
 *      `<available_skills>`（例如 `capability_attach` 的说明），且没有闭合标签；旧实现按行
 *      找标签就把它当成最后一份目录，抓到 4 个名字 ⇒ 误报「技能全丢」。
 *      现在要求 `event.data.source.kind === 'skill-catalog'` 且开闭标签成对。
 *   ② **预算只算随包技能**。目录 = 40 个随包 core + 40 个来自其它根的用户技能 = 80 行；
 *      按总行数 ≤40 判永远不可能通过。现在 `bundled = core + extended`，用户技能单独计数。
 *   ③ **跳过历史 durable 目录**。官方 `catalogHistory` 按 digest 判重，重启后不重发旧目录，
 *      会话里仍留着 230 行的老块。默认只验收「最新一轮」（--window，缺省 15 分钟），
 *      老目录单独归类为 legacy 报告、不计入失败；--all-history 可恢复全量验收。
 *
 * 验收项（只作用于 current 会话）：
 *   ① 随包技能条数 ≤ --max-entries（缺省 40）
 *   ② 不含任何 extended 技能（未 attach 的不该进常驻目录）
 *   ③ 40 个 core 全覆盖（provider 被 skip ⇒ 这里判红，防止「0 行目录」假绿）
 *   ④ `source.entries` 与正文条数一致（报告，不硬判）
 *
 * 只读，不改任何文件；失败 exit 1。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const argOf = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
/** 随包技能条数上限（用户技能不计入）。 */
const MAX_ENTRIES = Number(argOf('--max-entries', '40'));
const SESSION_ROOT = argOf('--sessions', join(homedir(), '.vssaros-dev/dsh-home/sessions'));
const BUNDLED_ROOT = join(REPO, 'dsh-plugins/vssaros-skill-bundle/skills');
/** 最新一轮的时间窗口（分钟）：只验收最新 catalog 事件前后 window 内的目录。 */
const WINDOW_MIN = Number(argOf('--window', '15'));
const SINCE_RAW = argOf('--since', null);
const RECENT_N = Number(argOf('--recent', '0'));
const ALL_HISTORY = argv.includes('--all-history');

/** 多帧 zstd → 文本（帧头 28 B5 2F FD）。 */
function decompressFrames(file) {
	const buf = readFileSync(file);
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const parts = [];
	let off = 0, guard = 0;
	while (off < buf.length && guard++ < 10000) {
		const next = buf.indexOf(MAGIC, off + 1);
		const end = next < 0 ? buf.length : next;
		try { parts.push(zstdDecompressSync(buf.subarray(off, end)).toString('utf8')); }
		catch { break; }
		if (next < 0) { break; }
		off = next;
	}
	return parts.join('');
}

/** 递归找会话文件。 */
function findSessions(dir, out = []) {
	if (!existsSync(dir)) { return out; }
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) { findSessions(p, out); }
		else if (entry.name === 'session.v4.jsonl.zstd') { out.push({ file: p, mtime: statSync(p).mtimeMs }); }
	}
	return out;
}

/**
 * 从会话全部事件里找 `agentPreset`（catalog 事件本身不带 preset）。
 * ★ 2026-11-09：真机上 `dsh-superagent-router`（群聊编排）按设计**不收窄**，
 *   目录仍是 232 行全量；只有 `vssaros-*` preset 才该套用收窄判据。
 *   不区分会把预期行为判成故障（这是上一版验收脚本的第三处误报）。
 */
function agentPresetOf(text) {
	for (const line of text.split('\n')) {
		if (!line.includes('agentPreset')) { continue; }
		let event = null;
		try { event = JSON.parse(line); } catch { continue; }
		const found = [];
		const scan = (o, depth = 0) => {
			if (depth > 5 || !o || typeof o !== 'object') { return; }
			for (const [k, v] of Object.entries(o)) {
				if (k === 'agentPreset' && typeof v === 'string' && v) { found.push(v); }
				else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 4) { scan(v, depth + 1); }
			}
		};
		scan(event);
		if (found.length) { return found[0]; }
	}
	return '';
}

/** `at` 字段统一成 epoch ms（解析不出来返回 0）。 */
function eventTimeOf(event) {
	const raw = event?.at ?? event?.ts ?? event?.time ?? event?.createdAt ?? 0;
	const n = typeof raw === 'number' ? raw : Date.parse(String(raw));
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从 JSONL 文本里抽**真正的** `<available_skills>` 目录。
 * ★ 只认 `source.kind === 'skill-catalog'` 且开闭标签成对的事件。
 *   其它事件正文里提到这个标签（工具描述等）一律忽略。
 */
function catalogsOf(text) {
	const rows = [];
	const OPEN = '<available_skills>';
	const CLOSE = '</available_skills>';
	for (const line of text.split('\n')) {
		if (!line.includes(OPEN)) { continue; }
		let event = null;
		try { event = JSON.parse(line); } catch { continue; }
		if (event?.data?.source?.kind !== 'skill-catalog') { continue; }
		const i = line.indexOf(OPEN);
		const j = line.indexOf(CLOSE, i);
		if (!(j > i)) { continue; }
		const block = line.slice(i, j + CLOSE.length);
		const names = [...block.matchAll(/-\s+\\?`([a-z0-9-]+)\\?`/g)].map(m => m[1]);
		const source = event.data.source;
		rows.push({
			names,
			chars: block.length,
			at: eventTimeOf(event),
			preset: source?.preset ?? event?.preset ?? '',
			form: source?.form ?? '',
			sourceEntries: Array.isArray(source?.entries) ? source.entries.length : null,
		});
	}
	return rows;
}

/** --since：ISO / epoch ms / `30m` / `2h`；缺省返回 null（用最新事件时间窗口）。 */
function parseSince(raw) {
	if (!raw) { return null; }
	const rel = /^(\d+(?:\.\d+)?)([mh])$/i.exec(raw);
	if (rel) { return Date.now() - Number(rel[1]) * (rel[2].toLowerCase() === 'h' ? 3600000 : 60000); }
	const n = Number(raw);
	if (Number.isFinite(n) && n > 0) { return n < 1e11 ? Date.now() - n * 60000 : n; }
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
}

// ── --self-test：合成事件验证解析口径（不读真机会话） ──────────────────────
if (argv.includes('--self-test')) {
	const catalogLine = (names, at) => JSON.stringify({
		type: 'user/message', at,
		data: { content: [{ type: 'text', text: `<available_skills>\n${names.map(n => `- \`${n}\`: desc`).join('\n')}\n</available_skills>` }],
			source: { kind: 'skill-catalog', form: 'catalog', entries: names.map(n => ({ name: n })) } },
	});
	const cases = [];
	const check = (label, cond) => { cases.push({ label, ok: !!cond }); };
	// ① 真 catalog 事件
	const one = catalogsOf(catalogLine(['analysis', 'be-concise', 'act-on-feedback'], 1794189364646));
	check('真 catalog 事件被识别', one.length === 1 && one[0].names.join(',') === 'analysis,be-concise,act-on-feedback');
	check('事件时间与 source.entries 被读出', one[0]?.at === 1794189364646 && one[0]?.sourceEntries === 3);
	// ② request/header 的工具描述里含标签字符串、无闭合 ⇒ 必须忽略（这是真机误报根因）
	const header = JSON.stringify({ type: 'request/header', data: { header: { tools: [
		{ name: 'capability_attach', description: '让它出现在 `<available_skills>` 目录里。' },
	] } } });
	check('工具描述里的 <available_skills> 不算目录', catalogsOf(header).length === 0);
	// ③ catalog 事件但没有闭合标签 ⇒ 忽略（截断不能当完整目录）
	const truncated = JSON.stringify({ type: 'user/message', at: 1,
		data: { content: [{ type: 'text', text: '<available_skills>\n- `analysis`: desc' }],
			source: { kind: 'skill-catalog', entries: [] } } });
	check('未闭合的 catalog 块被忽略', catalogsOf(truncated).length === 0);
	// ④ 混合：只取最后一个真 catalog
	const mixed = [header, catalogLine(['a'], 1), truncated, catalogLine(['b', 'c'], 2)].join('\n');
	const got = catalogsOf(mixed);
	check('混合事件里只收真 catalog 且取到最后一个', got.length === 2 && got[1].names.join(',') === 'b,c');
	const failed = cases.filter(c => !c.ok);
	if (asJson) { console.log(JSON.stringify({ cases, failed: failed.length }, null, 2)); }
	else { for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} self-test：${c.label}`); } console.log(failed.length ? '✗ self-test 失败' : '✓ self-test 全部通过'); }
	process.exit(failed.length ? 1 : 0);
}

// 随包 tier 索引：extended 判「是否混进常驻目录」，core 做正向全覆盖验收。
let extended = new Set();
let core = new Set();
try {
	const m = await import(pathToFileURL(join(REPO, 'dsh-plugins/vssaros-skills/lib/core/bundledSkills.js')).href);
	const idx = m.bundledTierIndex(BUNDLED_ROOT).index;
	for (const [name, entry] of idx) {
		if (entry.tier === 'extended') { extended.add(name); } else { core.add(name); }
	}
} catch { /* 索引不可用时跳过 ②③ */ }

const files = findSessions(SESSION_ROOT).sort((a, b) => b.mtime - a.mtime);
const perSession = [];
for (const { file, mtime } of files) {
	let text;
	try { text = decompressFrames(file); } catch { continue; }
	if (!text.includes('<available_skills>')) { continue; }
	const catalogs = catalogsOf(text);
	if (!catalogs.length) { continue; }
	const last = catalogs[catalogs.length - 1];
	const preset = agentPresetOf(text);
	const coreSeen = core.size ? new Set(last.names.filter(n => core.has(n))).size : null;
	const extendedSeen = last.names.filter(n => extended.has(n)).length;
	const bundled = (coreSeen ?? 0) + extendedSeen;
	perSession.push({
		session: file.split(/[\\/]/).slice(-2)[0],
		mtime: new Date(mtime).toLocaleString('sv'),
		preset,
		scoped: preset.startsWith('vssaros-'),
		count: catalogs.length,
		last: {
			rows: last.names.length,
			bundled,
			other: last.names.length - bundled,
			chars: last.chars,
			extended: extendedSeen,
			coreSeen,
			at: last.at,
			sourceEntries: last.sourceEntries,
			entriesMatch: last.sourceEntries === null || last.sourceEntries === last.names.length,
		},
		signature: [...new Set(last.names)].sort().join(','),
	});
}

// ★ current / legacy 分组：官方 catalogHistory 按 digest 判重，重启后不重发旧目录。
//   按 **catalog 事件时间**（不是会话文件 mtime，心跳也会更新 mtime）划分。
const latestAt = perSession.length ? Math.max(...perSession.map(s => s.last.at)) : 0;
const since = parseSince(SINCE_RAW);
const cutoff = ALL_HISTORY ? 0 : (since ?? (latestAt ? latestAt - WINDOW_MIN * 60000 : 0));
let current = perSession.filter(s => s.last.at >= cutoff);
if (RECENT_N > 0) {
	current = current.sort((a, b) => b.last.at - a.last.at).slice(0, RECENT_N);
}
const currentSessions = new Set(current.map(s => s.session));
const legacy = perSession.filter(s => !currentSessions.has(s.session));

// ★ 判据只作用于 **vssaros-\*** preset：官方 `dsh-superagent-router` 等按设计不收窄
//   （`attachmentsForAgent` 对非 vssaros agent 返回 names:null ⇒ 保持官方全量语义），
//   它们的 232 行全量目录是预期，单独归类报告。
const scoped = current.filter(s => s.scoped);
const unscoped = current.filter(s => !s.scoped);
const overBudget = scoped.filter(s => s.last.bundled > MAX_ENTRIES);
const withExtended = scoped.filter(s => s.last.extended > 0);
/** 正向判据：40 个 core 必须全在目录里（provider 被 skip ⇒ 这里判红）。索引不可用则跳过。 */
const missingCore = core.size ? scoped.filter(s => (s.last.coreSeen ?? 0) < core.size) : [];
const entriesMismatch = scoped.filter(s => !s.last.entriesMatch);
const signatures = new Set(scoped.map(s => s.signature));
// 判据只作用于**本轮的 vssaros-* 会话**；历史 durable 目录与非 vssaros 全量都不该拖累验收。
const failed = scoped.length > 0
	&& (overBudget.length > 0 || withExtended.length > 0 || missingCore.length > 0);
const results = {
	passed: scoped.length > 0 && !failed,
	failed,
	sessionsWithCatalog: perSession.length,
	currentSessions: current.length,
	scopedSessions: scoped.length,
	unscopedSessions: unscoped.length,
	unscopedPresets: [...new Set(unscoped.map(s => s.preset))],
	legacySessions: legacy.length,
	windowMinutes: ALL_HISTORY ? null : (since ? null : WINDOW_MIN),
	since: since ? new Date(since).toISOString() : null,
	evaluatedAt: latestAt ? new Date(latestAt).toISOString() : null,
	maxEntries: MAX_ENTRIES,
	requiredCore: core.size,
	overBudget: overBudget.length,
	withExtendedInCatalog: withExtended.length,
	missingCore: missingCore.length,
	entriesMismatch: entriesMismatch.length,
	worstCoreCoverage: scoped.length ? Math.min(...scoped.map(s => s.last.coreSeen ?? 0)) : 0,
	distinctCatalogSignatures: signatures.size,
	baselineNote: scoped.length === 0 ? '当前窗口内没有 vssaros-* 会话的新目录（重启 Host 并用内置 agent 触发新会话后再跑）' : undefined,
	recent: current.slice(0, 5),
};
if (asJson) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log('verify-catalog-runtime：真机技能目录验收');
	console.log(`  会话目录：${SESSION_ROOT}`);
	console.log(`  含 <available_skills> 的会话：${perSession.length}（本轮 ${current.length}，历史 durable 跳过 ${legacy.length}）`);
	console.log(`  收窄判据对象：vssaros-* ${scoped.length} 个；非 vssaros（按设计全量）${unscoped.length} 个${unscoped.length ? `：${results.unscopedPresets.join(',')}` : ''}`);
	console.log(`  验收基准：${results.evaluatedAt ?? 'n/a'}${results.windowMinutes !== null ? `，窗口 ${results.windowMinutes} 分钟` : (since ? '，按 --since' : '，--all-history 全量')}`);
	console.log(`  随包技能 > ${MAX_ENTRIES} 条：${overBudget.length}（用户技能不计入）`);
	console.log(`  常驻目录含 extended：${withExtended.length}`);
	console.log(`  core 未全覆盖（要求 ${core.size} 个）：${missingCore.length}${core.size ? '' : '（索引不可用，跳过）'}`);
	console.log(`  最低 core 覆盖：${results.worstCoreCoverage}/${core.size}`);
	console.log(`  source.entries 与正文不一致：${entriesMismatch.length}（只报告）`);
	console.log(`  不同目录签名数：${signatures.size}（>1 才说明按 agent 收窄）`);
	for (const s of results.recent) {
		console.log(`   · ${s.mtime} ${s.session.slice(8, 24)} preset=${s.preset} rows=${s.last.rows} bundled=${s.last.bundled} other=${s.last.other} core=${s.last.coreSeen}/${core.size} extended=${s.last.extended}`);
	}
	if (current.length === 0) { console.log('  ⓘ 当前窗口内没有可验收的新目录；重启 Host 并触发新会话后再跑。'); }
	else if (scoped.length === 0) { console.log('  ⓘ 窗口内只有非 vssaros preset（按设计全量）；用内置 agent 发一条消息再跑。'); }
}

// --json 必须保持**纯 JSON**（CI / 脚本会直接 JSON.parse）：结论走 results.passed / failed。
if (!asJson && scoped.length > 0) {
	console.log(failed ? '✗ 真机目录验收未通过（随包技能超预算 / 混入 extended / core 缺失）' : '✓ 真机目录验收通过');
}
process.exitCode = failed ? 1 : 0;
