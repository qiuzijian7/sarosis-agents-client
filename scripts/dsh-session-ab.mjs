#!/usr/bin/env node
// A/B 对照：两个 dsh 会话的**工具面成本与执行画像**（native vs ptc、加工具前后、改 preset 前后……）。
//
// 为什么需要它：工具面收敛（197 → 1）到底省了什么，不能靠感觉 —— 要有**同一把尺**量两侧。
// 数据源两个，都只读 ✓：
//   ① `<dshHome>/storages/session_projcache/sessions/<id>.json` —— 运行时**自己算的**账：
//      `contextBreakdown.breakdown.{systemTokens,toolsTokens,messageTokens}`、
//      `tokenUsage.totals.{uncachedInputTokens,cacheReadTokens,cacheWriteTokens,outputTokens}`、
//      `sessionStats.{steps,llmMs,toolMs,ttftMs}`、`agentPreset`、`modelSelection.lastUsed`；
//   ② `<dshHome>/sessions/<ws>/<id>/session.v4.jsonl.zstd` —— 工具清单（`request/header.tools`）与
//      逐次调用（`tool/call` / `tool/result` 的 isError）。⚠ 多帧 zstd，必须走 sessions 插件那份
//      `decodeZstdFrames`（`zlib.zstdDecompressSync` 只解第一帧 ✗）。
//
// 用法：
//   node scripts/dsh-session-ab.mjs                       # 最近两个**有内容**的会话
//   node scripts/dsh-session-ab.mjs --last 3              # 最近三个
//   node scripts/dsh-session-ab.mjs --ids <idA>,<idB>     # 指定（id = 会话目录名）
//   node scripts/dsh-session-ab.mjs --dsh-home <path>     # 指定数据根（默认自动找 dev / 生产）
//   node scripts/dsh-session-ab.mjs --json                # 机器可读
//   node scripts/dsh-session-ab.mjs --self-test           # 自证（临时夹具，不碰真机数据）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** 复用 sessions 插件的多帧解码（单一真源：帧切分/重试/丢坏帧的规则都在那儿 ✓）。 */
async function loadSessionLog() {
	const file = path.join(REPO, 'dsh-plugins', 'vssaros-sessions', 'lib', 'core', 'sessionLog.js');
	if (!fs.existsSync(file)) {
		throw new Error(`找不到会话日志读取器：${file}`);
	}
	return import(pathToFileURL(file).href);
}

// ─── 数据根解析 ──────────────────────────────────────────────────────────────
export function resolveDshHome(explicit) {
	if (explicit) { return explicit; }
	const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
	const candidates = [
		path.join(home, '.vssaros-dev', 'dsh-home'), // dev 实例（日常在用）
		path.join(home, '.vssaros', 'dsh-home'),     // 生产实例
		path.join(home, '.dsh'),                     // 官方独立入口
	];
	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, 'storages'))) { return candidate; }
	}
	return candidates[0];
}

// ─── projcache（运行时的账） ─────────────────────────────────────────────────
export function readProjection(dshHome, sessionId) {
	const file = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
	if (!fs.existsSync(file)) { return undefined; }
	let record;
	try {
		record = JSON.parse(fs.readFileSync(file, 'utf8'))?.record;
	} catch {
		return undefined;
	}
	const rows = record?.rows ?? {};
	const val = key => rows[key]?.val;
	const totals = val('tokenUsage')?.totals ?? {};
	const stats = val('sessionStats') ?? {};
	const breakdown = val('contextBreakdown')?.breakdown ?? {};
	const pressure = val('contextPressure') ?? {};
	const model = val('modelSelection')?.lastUsed ?? {};
	return {
		file,
		identity: record?.identity ?? {},
		preset: typeof val('agentPreset') === 'string' ? val('agentPreset') : undefined,
		provider: model.provider,
		model: model.model,
		tokens: {
			uncachedInput: totals.uncachedInputTokens ?? 0,
			cacheRead: totals.cacheReadTokens ?? 0,
			cacheWrite: totals.cacheWriteTokens ?? 0,
			output: totals.outputTokens ?? 0,
		},
		stats: {
			turns: stats.turns ?? 0,
			steps: stats.steps ?? 0,
			llmMs: stats.llmMs ?? 0,
			toolMs: stats.toolMs ?? 0,
			ttftMs: stats.ttftMs ?? 0,
		},
		context: {
			surfaceTokens: val('contextBreakdown')?.surfaceTokens ?? pressure.surfaceTokens ?? 0,
			systemTokens: breakdown.systemTokens ?? 0,
			toolsTokens: breakdown.toolsTokens ?? 0,
			messageTokens: breakdown.messageTokens ?? 0,
			contextWindow: pressure.contextWindow ?? 0,
		},
	};
}

// ─── 会话日志（工具面 + 调用明细） ────────────────────────────────────────────
export function analyzeSessionText(text) {
	const rows = [];
	for (const line of String(text ?? '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		try { rows.push(JSON.parse(trimmed)); } catch { /* 单行坏掉不影响整体 ✓ */ }
	}
	const header = rows.find(row => row?.type === 'request/header');
	const session = rows.find(row => row?.type === 'session');
	const tools = header?.data?.header?.tools ?? [];
	const calls = rows.filter(row => row?.type === 'tool/call');
	const results = rows.filter(row => row?.type === 'tool/result');
	const byName = new Map();
	for (const call of calls) {
		const name = call?.data?.name ?? '(unknown)';
		byName.set(name, (byName.get(name) ?? 0) + 1);
	}
	const failures = results.filter(row => row?.data?.message?.isError === true).length;
	// 工具 schema 的字符数（`chars/4` 估算）—— 只在 projcache 不可用时当兜底 ✓
	const schemaChars = tools.reduce((sum, tool) => sum + JSON.stringify({
		name: tool?.name, description: tool?.description, parameters: tool?.parameters ?? tool?.inputSchema,
	}).length, 0);
	return {
		session,
		tools: { count: tools.length, names: tools.map(tool => tool?.name).filter(Boolean), estimatedTokens: Math.ceil(schemaChars / 4) },
		headerCount: rows.filter(row => row?.type === 'request/header').length,
		steps: rows.filter(row => row?.type === 'step/start').length,
		turns: rows.filter(row => row?.type === 'turn/start').length,
		calls: { total: calls.length, failures, byName: [...byName].sort((a, b) => b[1] - a[1]) },
		firstUserText: firstUserTextOf(rows),
	};
}

function firstUserTextOf(rows) {
	for (const row of rows) {
		if (row?.type !== 'user/message') { continue; }
		const parts = row?.data?.content;
		const text = Array.isArray(parts) ? parts.map(part => part?.text ?? '').join('') : '';
		const clean = text.replace(/<system-reminder>[\s\S]*$/m, '').replace(/\s+/g, ' ').trim();
		if (clean && !/^【人格切换】/.test(clean)) { return clean.slice(0, 80); }
	}
	return undefined;
}

/** 找到某个会话的日志文件（`<sessionsRoot>/<ws>/<id>/session.v4.jsonl.zstd`）。 */
export function findLog(sessionsRoot, sessionId) {
	let workspaces = [];
	try {
		workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
	} catch {
		return undefined;
	}
	for (const ws of workspaces) {
		const candidate = path.join(sessionsRoot, ws.name, sessionId, 'session.v4.jsonl.zstd');
		if (fs.existsSync(candidate)) { return candidate; }
	}
	return undefined;
}

// ─── 汇总一个会话 ────────────────────────────────────────────────────────────
export async function describeSession({ dshHome, sessionId, logApi }) {
	const projection = readProjection(dshHome, sessionId);
	const logFile = findLog(path.join(dshHome, 'sessions'), sessionId);
	let log;
	let logError;
	if (logFile) {
		try {
			const text = logApi.decodeZstdFrames(fs.readFileSync(logFile));
			log = analyzeSessionText(text);
		} catch (error) {
			logError = String(error?.message ?? error);
		}
	}
	const toolsTokens = projection?.context?.toolsTokens || log?.tools?.estimatedTokens || 0;
	return { sessionId, logFile, logError, projection, log, toolsTokens };
}

function pct(part, total) {
	return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '—';
}

function seconds(ms) {
	return Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '—';
}

export function formatOne(entry) {
	const { sessionId, projection, log } = entry;
	const lines = [];
	lines.push(`── ${sessionId}`);
	if (log?.firstUserText) { lines.push(`   提问        ${log.firstUserText}`); }
	const preset = projection?.preset ?? log?.session?.agentPreset;
	const model = [projection?.provider, projection?.model].filter(Boolean).join('/') || [log?.session?.agentPreset && '', ''].filter(Boolean).join('');
	lines.push(`   preset      ${preset ?? '(未知)'}${model ? `   model ${model}` : ''}`);
	const tools = log?.tools?.count;
	const surface = projection?.context?.surfaceTokens ?? 0;
	lines.push(`   工具面      ${tools === undefined ? '(无日志)' : `${tools} 个`}`
		+ ` · toolsTokens ${entry.toolsTokens || '—'}${surface ? `（占 surface ${pct(entry.toolsTokens, surface)}）` : ''}`);
	if (projection) {
		const stats = projection.stats;
		lines.push(`   步数        ${stats.steps} 步 / ${stats.turns} 回合   （日志里 step/start ${log?.steps ?? '—'}）`);
		const tokens = projection.tokens;
		const billedInput = tokens.uncachedInput + tokens.cacheRead;
		lines.push(`   tokens      uncached ${tokens.uncachedInput} · cacheRead ${tokens.cacheRead} · cacheWrite ${tokens.cacheWrite} · output ${tokens.output}`);
		lines.push(`   缓存命中    ${pct(tokens.cacheRead, billedInput)}   （cacheRead / (cacheRead+uncached)）`);
		lines.push(`   耗时        llm ${seconds(stats.llmMs)} · tool ${seconds(stats.toolMs)} · 首 token 合计 ${seconds(stats.ttftMs)}`);
		if (stats.steps > 0) {
			lines.push(`   每步均值    输入 ${Math.round(billedInput / stats.steps)} tok · 输出 ${Math.round(tokens.output / stats.steps)} tok`);
		}
	} else {
		lines.push('   tokens      (没有投影缓存 ⇒ 读不到运行时的账)');
	}
	const calls = log?.calls;
	if (calls) {
		const top = calls.byName.slice(0, 6).map(([name, count]) => `${name}:${count}`).join(', ');
		lines.push(`   工具调用    ${calls.total} 次 · 失败 ${calls.failures}${top ? `   top: ${top}` : ''}`);
	}
	if (entry.logError) { lines.push(`   ⚠ 日志解析失败：${entry.logError}`); }
	return lines.join('\n');
}

function deltaLine(label, a, b, { lowerIsBetter = true, unit = '' } = {}) {
	if (!Number.isFinite(a) || !Number.isFinite(b)) { return undefined; }
	const diff = b - a;
	if (diff === 0) { return `${label.padEnd(12)} ±0`; }
	const sign = diff > 0 ? '+' : '';
	const good = lowerIsBetter ? diff < 0 : diff > 0;
	return `${label.padEnd(12)} ${sign}${Math.round(diff * 100) / 100}${unit}${good ? ' ✓' : ''}`;
}

export function formatDiff(first, second) {
	const a = first.projection;
	const b = second.projection;
	const lines = ['── 差值（B − A）'];
	const rows = [
		deltaLine('toolsTokens', first.toolsTokens, second.toolsTokens),
		deltaLine('工具个数', first.log?.tools?.count, second.log?.tools?.count),
		deltaLine('步数', a?.stats?.steps, b?.stats?.steps),
		deltaLine('输出 tok', a?.tokens?.output, b?.tokens?.output),
		deltaLine('未命中输入', a?.tokens?.uncachedInput, b?.tokens?.uncachedInput),
		deltaLine('llm 秒', a ? a.stats.llmMs / 1000 : undefined, b ? b.stats.llmMs / 1000 : undefined),
	].filter(Boolean);
	lines.push(...rows.map(row => `   ${row}`));
	if (a && b) {
		const hitA = a.tokens.cacheRead + a.tokens.uncachedInput > 0 ? a.tokens.cacheRead / (a.tokens.cacheRead + a.tokens.uncachedInput) : NaN;
		const hitB = b.tokens.cacheRead + b.tokens.uncachedInput > 0 ? b.tokens.cacheRead / (b.tokens.cacheRead + b.tokens.uncachedInput) : NaN;
		if (Number.isFinite(hitA) && Number.isFinite(hitB)) {
			lines.push(`   缓存命中 ${((hitB - hitA) * 100).toFixed(1)}pt${hitB >= hitA ? ' ✓' : ''}`);
		}
	}
	return lines.join('\n');
}

// ─── 最近 N 个"有内容"的会话 ─────────────────────────────────────────────────
export function recentSessionIds(dshHome, count) {
	const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
	let files = [];
	try {
		files = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'));
	} catch {
		return [];
	}
	const rows = [];
	for (const entry of files) {
		const id = entry.name.slice(0, -'.json'.length);
		const full = path.join(dir, entry.name);
		let steps = 0;
		let mtime = 0;
		try {
			mtime = fs.statSync(full).mtimeMs;
			const record = JSON.parse(fs.readFileSync(full, 'utf8'))?.record;
			steps = record?.rows?.sessionStats?.val?.steps ?? 0;
		} catch { continue; }
		if (steps > 0) { rows.push({ id, steps, mtime }); }
	}
	return rows.sort((x, y) => y.mtime - x.mtime).slice(0, Math.max(1, count)).map(row => row.id);
}

// ─── 自证（临时夹具；不读真机数据） ──────────────────────────────────────────
async function selfTest(api) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ab-selftest-'));
	const dshHome = path.join(tmp, 'dsh-home');
	const sessionsRoot = path.join(dshHome, 'sessions');
	const workspace = path.join(sessionsRoot, '--ws--');
	const projDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
	for (const dir of [projDir, path.join(workspace, 'sess-a'), path.join(workspace, 'sess-b')]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const writeProj = (id, steps, toolsTokens, uncached, cacheRead, output) => {
		fs.writeFileSync(path.join(projDir, `${id}.json`), JSON.stringify({
			version: 7,
			record: {
				identity: { cwd: 'x' },
				rows: {
					agentPreset: { val: 'vssaros-standard' },
					modelSelection: { val: { lastUsed: { provider: 'p', model: 'm' } } },
					tokenUsage: { val: { totals: { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } },
					sessionStats: { val: { turns: 1, steps, llmMs: 1000, toolMs: 200, ttftMs: 300 } },
					contextBreakdown: { val: { surfaceTokens: 100, breakdown: { systemTokens: 10, toolsTokens, messageTokens: 20 } } },
					contextPressure: { val: { contextWindow: 1000 } },
				},
			},
		}), 'utf8');
	};
	const writeLog = (dir, tools) => {
		const lines = [
			{ type: 'session', id: 'x', version: 4 },
			{ type: 'user/message', data: { content: [{ type: 'text', text: '请分析这个仓库' }] } },
			{ type: 'request/header', data: { header: { tools } } },
			{ type: 'step/start', data: {} },
			{ type: 'tool/call', data: { name: 'grep' } },
			{ type: 'tool/result', data: { message: { isError: false } } },
			{ type: 'tool/call', data: { name: 'read' } },
			{ type: 'tool/result', data: { message: { isError: true } } },
			{ type: 'step/start', data: {} },
		];
		const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
		// 单帧 zstd（自证只需要"能被 decodeZstdFrames 解出来" ✓）
		fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')));
		return jsonl;
	};
	writeProj('sess-a', 2, 42, 100, 900, 50);
	writeProj('sess-b', 2, 1, 80, 950, 40);
	writeLog(path.join(workspace, 'sess-a'), [{ name: 'grep', description: 'd', parameters: {} }, { name: 'read', description: 'd', parameters: {} }]);
	writeLog(path.join(workspace, 'sess-b'), [{ name: 'run_code', description: 'd', parameters: {} }]);

	const cases = [];
	const check = (label, ok) => { cases.push({ label, ok }); };

	const proj = readProjection(dshHome, 'sess-a');
	check('读出 preset / 模型', proj?.preset === 'vssaros-standard' && proj?.model === 'm');
	check('读出 toolsTokens 与 token 账', proj?.context?.toolsTokens === 42 && proj?.tokens?.cacheRead === 900 && proj?.stats?.steps === 2);

	const entryA = await describeSession({ dshHome, sessionId: 'sess-a', logApi: api });
	check('日志：工具数 2 / 调用 2 / 失败 1', entryA.log?.tools?.count === 2 && entryA.log?.calls?.total === 2 && entryA.log?.calls?.failures === 1);
	check('日志：首条用户提问', entryA.log?.firstUserText === '请分析这个仓库');
	check('toolsTokens 优先取运行时的账', entryA.toolsTokens === 42);

	const text = formatOne(entryA);
	check('报告里出现关键行', /preset\s+vssaros-standard/.test(text) && /toolsTokens 42/.test(text) && /失败 1/.test(text));

	const ids = recentSessionIds(dshHome, 2);
	check('--last 能列出两个有内容的会话', ids.length === 2 && ids.includes('sess-a') && ids.includes('sess-b'));

	const entryB = await describeSession({ dshHome, sessionId: 'sess-b', logApi: api });
	const diff = formatDiff(entryA, entryB);
	check('差值里 toolsTokens 变少且标 ✓', /toolsTokens\s+-41 ✓/.test(diff));

	fs.rmSync(tmp, { recursive: true, force: true });
	const failed = cases.filter(item => !item.ok);
	for (const item of cases) { console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}`); }
	console.log(failed.length === 0 ? `\n自证通过（${cases.length}/${cases.length}）` : `\n${failed.length} 条失败`);
	process.exitCode = failed.length === 0 ? 0 : 1;
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const api = await loadSessionLog();
	if (process.argv.includes('--self-test')) {
		await selfTest(api);
	} else {
		const dshHome = resolveDshHome(argValue('--dsh-home'));
		const explicit = argValue('--ids');
		const ids = explicit
			? explicit.split(',').map(id => id.trim()).filter(Boolean)
			: recentSessionIds(dshHome, Number(argValue('--last') ?? 2) || 2);
		if (ids.length === 0) {
			console.error(`✗ 在 ${dshHome} 下找不到有内容的会话（用 --dsh-home 指数据根，或 --ids 指定会话）`);
			process.exit(1);
		}
		const entries = [];
		for (const id of ids) {
			entries.push(await describeSession({ dshHome, sessionId: id, logApi: api }));
		}
		if (process.argv.includes('--json')) {
			console.log(JSON.stringify({ dshHome, sessions: entries.map(({ sessionId, logFile, log, projection, toolsTokens }) => ({
				sessionId, logFile, toolsTokens,
				preset: projection?.preset, provider: projection?.provider, model: projection?.model,
				tokens: projection?.tokens, stats: projection?.stats, context: projection?.context,
				tools: log?.tools, calls: log?.calls, steps: log?.steps, firstUserText: log?.firstUserText,
			})) }, null, 2));
		} else {
			console.log(`数据根：${dshHome}\n`);
			for (const entry of entries) {
				console.log(formatOne(entry));
				console.log('');
			}
			if (entries.length === 2) { console.log(formatDiff(entries[0], entries[1])); }
		}
	}
}
