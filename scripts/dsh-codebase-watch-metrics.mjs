#!/usr/bin/env node
// 甲档交接的**看护测量**：在一段时间里持续采样，量化 watcher 的真实行为。
//
// 回答四个问题（都能从数据直接读出来，不靠感觉 ✓）：
//   ① 跑了几次、每次多久（`lastRunMs` / meta.history）？
//   ② 有多少次是**空跑**（nodes/edges 逐字相同 ⇒ 什么也没变）？
//   ③ **增量缓存**被重写了多少次（`index-cache.json` 的 mtime 变化次数）？—— 这就是"省下的 135MB 写盘"✓
//   ④ 档位有没有被**静默降级**（history 里的 parser 是否全是 treesitter）？
//
// 用法：
//   node scripts/dsh-codebase-watch-metrics.mjs --minutes 10
//   node scripts/dsh-codebase-watch-metrics.mjs --minutes 5 --interval 15
//   node scripts/dsh-codebase-watch-metrics.mjs --json > metrics.json
//   node scripts/dsh-codebase-watch-metrics.mjs --minutes 8 --save doc/codebase-watch-baseline.json
//   node scripts/dsh-codebase-watch-metrics.mjs --minutes 8 --compare doc/codebase-watch-baseline.json
//   node scripts/dsh-codebase-watch-metrics.mjs --wait-for-version 0.6.81 --minutes 8 --compare <基线>
//     ↑ 改完插件源码后**一条命令**搞定：等新版本上机（宿主会自己换进程）→ 测 → 与基线对比 ✓
//
// ⚠ 只读：不写任何文件、不碰索引锁 ⇒ 可以在 Host 跑着的时候安全地测 ✓。
//   （`--save` 会写一份基线 JSON —— 那是**唯一**的写动作，且只写你指定的那个路径 ✓）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argValue = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const MINUTES = Number(argValue('--minutes', '8'));
const INTERVAL_MS = Math.max(5, Number(argValue('--interval', '20'))) * 1000;
const JSON_OUT = process.argv.includes('--json');

function resolveDshHome() {
	const explicit = argValue('--dsh-home');
	if (explicit) { return explicit; }
	const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
	for (const candidate of [path.join(home, '.vssaros-dev', 'dsh-home'), path.join(home, '.vssaros', 'dsh-home')]) {
		if (fs.existsSync(path.join(candidate, 'storages'))) { return candidate; }
	}
	return path.join(home, '.vssaros-dev', 'dsh-home');
}

const dshHome = resolveDshHome();
const workspace = path.resolve(argValue('--workspace', 'G:/SarosWorkspace/sarosis-agents-client'));
const memDir = path.join(workspace, '.codebase-memory');
const cachePath = path.join(memDir, 'index-cache.json');
const metaPath = path.join(memDir, 'index-meta.json');

// ── 等某个版本上机（"自动等 + 自动出对比表"的那一半）──────────────────────────────
const WAIT_VERSION = argValue('--wait-for-version');
const WAIT_MINUTES = Number(argValue('--wait-minutes', '60'));

/** 版本号比较：`'0.6.81' >= '0.6.80'` ⇒ true（逐段按数字比 ✓，不是字符串比 ✓）。 */
export function versionAtLeast(actual, want) {
	const parse = v => String(v ?? '').split('.').map(part => Number.parseInt(part, 10) || 0);
	const a = parse(actual);
	const b = parse(want);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) { return diff > 0; }
	}
	return true;
}

/** 真机上**已装**的 codebase 插件版本（读 profile 的插件目录 ✓，不猜）。 */
export function stagedCodebaseVersion(home = dshHome) {
	const dir = path.join(home, 'profiles', 'vssaros', '.vssaros', 'plugins');
	let best;
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith('vssaros-dsh-codebase-')) { continue; }
			const pkgPath = path.join(dir, entry.name, 'package.json');
			if (!fs.existsSync(pkgPath)) { continue; }
			const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
			if (version && (!best || versionAtLeast(version, best))) { best = version; }
		}
	} catch { /* 目录不在 ⇒ 没装 ✓ */ }
	return best;
}

async function waitForVersion(target) {
	const deadline = Date.now() + WAIT_MINUTES * 60_000;
	for (;;) {
		const current = stagedCodebaseVersion();
		if (current && versionAtLeast(current, target)) {
			console.error(`✓ 已上机：codebase ${current} ≥ 目标 ${target}（开始测量）`);
			return { ok: true, version: current };
		}
		if (Date.now() > deadline) {
			console.error(`⚠ 等了 ${WAIT_MINUTES} 分钟仍未见 ${target}（现在 ${current ?? '未装'}）—— 继续测当前这版`);
			return { ok: false, version: current };
		}
		console.error(`… 等 codebase ${target} 上机（现在 ${current ?? '未装'}）`);
		await new Promise(r => setTimeout(r, 30_000));
	}
}

/** 读 Host 的只读状态端点（拿不到就退化成"只看 meta/缓存"✓）。 */
async function hostStatus() {
	try {
		const hostFile = path.join(dshHome, 'host.json');
		const raw = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
		const token = String(raw.authUrl ?? '').split('token=')[1];
		const port = JSON.parse(fs.readFileSync(path.join(dshHome, 'host-port.json'), 'utf8')).port;
		const auth = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
		const cookie = (auth.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
		// ⚠ 有些 Host 组合只在"带 token 的那次请求"上发 cookie ⇒ API 端点也把 token 带上更稳 ✓（实测 401 的教训）
		const apiUrl = `http://127.0.0.1:${port}/x/codebase/api/index-status?token=${encodeURIComponent(token)}`;
		const res = await fetch(apiUrl, { headers: cookie ? { cookie } : {} });
		if (!res.ok) { return { error: `HTTP ${res.status}` }; }
		return await res.json();
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

const statOf = file => { try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return undefined; } };
const metaOf = () => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return undefined; } };

const samples = [];
const cacheEvents = [];
const runEvents = [];
let lastCacheMtime = statOf(cachePath)?.mtimeMs;
let lastRunCount = -1;
let lastNodeCount;
let lastEntry;   // 最近一次索引（判"空跑"要与**上一次**比 ⇒ 单独记 ✓）

const started = Date.now();
// ★ 等某个版本上机（"自动等 + 自动出对比表"的那一半 ✓）：宿主会因插件源码变化自动换进程，
//   所以"改了代码"与"新代码在跑"之间有一段时差 ⇒ 让脚本自己等，省得人工盯着 ✓。
if (WAIT_VERSION) { await waitForVersion(WAIT_VERSION); }
console.error(`采样中：${MINUTES} 分钟 / 每 ${INTERVAL_MS / 1000}s 一次（工作区 ${workspace}）…`);

while (Date.now() - started < MINUTES * 60_000) {
	const status = await hostStatus();
	const meta = metaOf();
	const cache = statOf(cachePath);
	const history = meta?.history ?? [];
	const newest = history[0];
	const watch = status?.watch ?? {};

	// 缓存被重写？
	if (cache && lastCacheMtime !== undefined && cache.mtimeMs !== lastCacheMtime) {
		cacheEvents.push({ at: new Date(cache.mtimeMs).toLocaleTimeString('zh-CN', { hour12: false }), sizeMB: +(cache.size / 1048576).toFixed(1) });
	}
	if (cache) { lastCacheMtime = cache.mtimeMs; }

	// 出现新的 meta 记录 ⇒ 又跑了一次
	if (newest && (lastRunCount < 0 || newest.savedAt !== lastRunCount)) {
		lastRunCount = newest.savedAt;
		// ★ "空跑"要跟**上一次运行**比（不是跟采样时刻比、也不是跟"第一次记录的"比 ✗）⇒
		//   用专门的 `lastEntry` 记住最近一次 ⇒ 语义正确 ✓
		const previous = lastEntry;
		runEvents.push({
			at: new Date(newest.savedAt).toLocaleTimeString('zh-CN', { hour12: false }),
			parser: newest.parser, ms: newest.ms, nodes: newest.nodeCount, edges: newest.edgeCount,
			changed: previous ? newest.nodeCount !== previous.nodes : null,
			// ★ 2026-10-21（0.6.81 起 meta 才有这个字段）：这次**连 gzip 编码都省了** ⇒ A 档优化的直接证据 ✓
			encodeSkipped: newest.encodeSkipped === true,
			// ★ 0.6.82 起：这次**内容有没有变** ⇒ 空跑 / 有变更 的耗时可以**分开**统计 ✓
			graphChanged: typeof newest.graphChanged === 'boolean' ? newest.graphChanged : undefined,
		});
		lastEntry = { nodes: newest.nodeCount, savedAt: newest.savedAt };
	}

	samples.push({
		t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
		nodes: status?.manifest?.nodeCount ?? newest?.nodeCount,
		parser: status?.graphParser ?? newest?.parser,
		source: status?.effectiveSource,
		watchActive: watch.active, runs: watch.runs, lastRunMs: watch.lastRunMs, lastRunOk: watch.lastRunOk, lastRunKind: watch.lastRunKind,
		lockHeld: status?.lock?.held,
		cacheMB: cache ? +(cache.size / 1048576).toFixed(1) : undefined,
		cacheMtime: cache ? new Date(cache.mtimeMs).toLocaleTimeString('zh-CN', { hour12: false }) : undefined,
		error: status?.error,
	});
	await new Promise(r => setTimeout(r, INTERVAL_MS));
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const durations = runEvents.map(e => e.ms).filter(Number.isFinite);
const avgOf = list => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : undefined);
// ★ 阶段 0（增量图设计）：**空跑**与**有变更**的耗时分开统计（混在一起看不出优化落在哪 ✓）
const emptyRuns = runEvents.filter(e => e.graphChanged === false);
const changedRuns = runEvents.filter(e => e.graphChanged === true);
const emptyAvgMs = avgOf(emptyRuns.map(e => e.ms).filter(Number.isFinite));
const changedAvgMs = avgOf(changedRuns.map(e => e.ms).filter(Number.isFinite));
const noChange = runEvents.filter(e => e.changed === false).length;
const tierDrops = runEvents.filter(e => e.parser && e.parser !== 'treesitter').length;
const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : undefined;
const max = durations.length ? Math.max(...durations) : undefined;
const min = durations.length ? Math.min(...durations) : undefined;

const report = {
	workspace, dshHome, windowMinutes: MINUTES, samples: samples.length,
	runsObserved: runEvents.length, cacheRewrites: cacheEvents.length,
	encodeSkippedRuns: runEvents.filter(e => e.encodeSkipped).length,
	emptyAvgMs, changedAvgMs, emptyRuns: emptyRuns.length, changedRuns: changedRuns.length,
	avgRunMs: avg, minRunMs: min, maxRunMs: max,
	noChangeRuns: noChange, tierDropsBelowTreesitter: tierDrops,
	runEvents, cacheEvents,
	finalNodes: samples.at(-1)?.nodes, finalParser: samples.at(-1)?.parser, finalSource: samples.at(-1)?.source,
	hostError: samples.find(s => s.error)?.error,
};

// ★ `--save` / `--compare`：把"这次优化到底省了多少"变成**一条命令**能出的对比表 ✓
const SAVE_PATH = argValue('--save');
const COMPARE_PATH = argValue('--compare');
if (SAVE_PATH) {
	fs.writeFileSync(SAVE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(`已保存基线：${SAVE_PATH}`);
}
if (COMPARE_PATH) {
	let baseline;
	try { baseline = JSON.parse(fs.readFileSync(COMPARE_PATH, 'utf8')); } catch (error) {
		console.error(`✗ 读基线失败：${String(error?.message ?? error)}`);
		process.exit(1);
	}
	const rows = [
		['跑索引次数', baseline.runsObserved, report.runsObserved, 'b', null],
		['单次均值 (ms)', baseline.avgRunMs, report.avgRunMs, 'ms', true],
		['单次最快 (ms)', baseline.minRunMs, report.minRunMs, 'ms', true],
		['单次最慢 (ms)', baseline.maxRunMs, report.maxRunMs, 'ms', true],
		['空跑次数（内容没变）', baseline.noChangeRuns, report.noChangeRuns, 'b', null],
		['增量缓存重写次数', baseline.cacheRewrites, report.cacheRewrites, 'b', true],
		['其中"连编码都省了"的次数', baseline.encodeSkippedRuns ?? 0, report.encodeSkippedRuns ?? 0, 'b', null],
		['空跑均值 (ms)', baseline.emptyAvgMs, report.emptyAvgMs, 'ms', true],
		['有变更均值 (ms)', baseline.changedAvgMs, report.changedAvgMs, 'ms', true],
		['档位降级次数（<treesitter）', baseline.tierDropsBelowTreesitter, report.tierDropsBelowTreesitter, 'b', true],
		['最终节点数', baseline.finalNodes, report.finalNodes, 'b', null],
	];
	console.log(`\n=== 对比：${COMPARE_PATH} → 本次 ===`);
	console.log('指标'.padEnd(26) + String(baseline.windowMinutes + ' 分窗').padStart(12) + String(report.windowMinutes + ' 分窗').padStart(12) + 'Δ'.padStart(12));
	for (const [label, before, after, unit, lowerIsBetter] of rows) {
		const fmt = v => (v === undefined || v === null ? '—' : `${v}${unit === 'b' ? '' : unit}`);
		const delta = (Number.isFinite(before) && Number.isFinite(after)) ? after - before : undefined;
		const good = delta === undefined ? ''
			: lowerIsBetter === null ? ' ±'
				: lowerIsBetter ? (delta < 0 ? ' ✓' : delta > 0 ? ' ✗' : ' ±0')
					: (delta > 0 ? ' ✓' : delta < 0 ? ' ✗' : ' ±0');
		console.log(label.padEnd(26) + fmt(before).padStart(12) + fmt(after).padStart(12)
			+ (delta === undefined ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100}${unit === 'b' ? '' : unit}`).padStart(10) + good);
	}
	const verdict = (report.tierDropsBelowTreesitter === 0 ? '✓ 档位未降级' : '✗ 出现降级')
		+ ` · 均耗时 ${report.avgRunMs && baseline.avgRunMs ? (report.avgRunMs <= baseline.avgRunMs ? '↓ 变快' : '↑ 变慢') : '—'}`
		+ ` · 缓存重写 ${report.cacheRewrites <= baseline.cacheRewrites ? '↓ 变少' : '↑ 变多'}`;
	console.log(`\n结论：${verdict}`);
}
if (JSON_OUT) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log('\n=== 甲档 watcher 看护测量 ===');
	console.log(`窗口 ${MINUTES} 分钟 · 采样 ${samples.length} 次`);
	console.log(`跑索引：${report.runsObserved} 次 · 单次 ${min}–${max}ms（均值 ${avg}ms）`);
	console.log(`其中**空跑**（nodes 未变）：${noChange} 次`);
	console.log(`增量缓存被重写：${report.cacheRewrites} 次${cacheEvents.length ? `（${cacheEvents.map(e => e.at).join(', ')}）` : ''}`);
	console.log(`其中**连编码都省了**（指纹相同）：${report.encodeSkippedRuns ?? 0} 次`);
	console.log(`空跑均值：${report.emptyAvgMs ?? '—'}ms（${report.emptyRuns ?? 0} 次）· 有变更均值：${report.changedAvgMs ?? '—'}ms（${report.changedRuns ?? 0} 次）`);
	console.log(`档位降到非 treesitter：${tierDrops} 次 ${tierDrops === 0 ? '✓' : '✗'}`);
	console.log(`最终：${report.finalNodes} 节点 · parser=${report.finalParser} · source=${report.finalSource}`);
	if (report.hostError) { console.log(`⚠ Host 状态端点不可用：${report.hostError}（只有 meta/缓存数据）`); }
	console.log('\n--- 每次索引 ---');
	for (const e of runEvents) { console.log(`  ${e.at}  ${String(e.parser).padEnd(11)} ${String(e.ms).padStart(7)}ms  nodes=${e.nodes}${e.changed === false ? '（未变）' : ''}`); }
	console.log('\n--- 采样轨迹（节选）---');
	for (const s of samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 12)) === 0)) {
		console.log(`  ${s.t}  runs=${String(s.runs ?? '?').padStart(4)}  lastRunMs=${String(s.lastRunMs ?? '?').padStart(6)}  ok=${s.lastRunOk}  lock=${s.lockHeld}  cache=${s.cacheMB ?? '?'}MB @${s.cacheMtime ?? '?'}`);
	}
}
process.exitCode = 0;
