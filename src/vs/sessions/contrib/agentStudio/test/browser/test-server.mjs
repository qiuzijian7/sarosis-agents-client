/*---------------------------------------------------------------------------------------------
 *  test-server — 测试总控（**单一入口**）。
 *
 *  一个命令、一个端口，进所有测试面板：
 *
 *      node src/vs/sessions/contrib/agentStudio/test/browser/test-server.mjs
 *      → http://127.0.0.1:5600/
 *
 *  路由：
 *      GET  /                  导航页（三个面板入口）
 *      GET  /node              Node 单元测试面板（179 个 *.test.ts，勾选批量跑）
 *      GET  /api/tests         测试文件清单
 *      GET  /api/run?files=…&conc=N   SSE：受控并发执行（N=1..8，默认 4）并流式回传
 *      GET  /visual/*          反向代理到 visual harness（本服务自动拉起）
 *
 *  ★ 为什么由本服务拉起 visual：以前要分别起两个进程（5599 / 5600），入口是碎的。
 *    现在只起这一个，visual 作为子进程托管，退出时一起清理。
 *    /visual/* 走**反向代理**而非重定向——同源才能让 harness 的相对路径资源
 *    （./harness.js）与 Playwright 脚本都正常工作。
 *--------------------------------------------------------------------------------------------*/

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'run-browser-test.mjs');

// ── 聊天沙箱真实数据（与 vssaros.exe 同源：~/.vssaros/ 数据文件 + 真实 git 命令）──
const VSSAROS_DIR = path.join(os.homedir(), '.vssaros');
const CHAT_SESSIONS_FILE = path.join(VSSAROS_DIR, 'chat-history', 'sandbox-chat-sessions.json');

function readJsonSafe(p, fallback) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** 真实 workspaces（~/.vssaros/workspaces.json，与 vssaros.exe 同一文件）。 */
function listRealWorkspaces() {
	const raw = readJsonSafe(path.join(VSSAROS_DIR, 'workspaces.json'), []);
	const list = Array.isArray(raw) ? raw : (raw.workspaces ?? []);
	return list.map(x => ({ id: x.id, name: x.name, path: x.path })).filter(x => x.path);
}

function gitOut(cwd, cmd) {
	try {
		return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch { return ''; }
}

/** 真实 worktrees：git worktree list --porcelain + 每棵的分支/变更计数。 */
function listRealWorktrees(wsPath) {
	const out = gitOut(wsPath, 'git worktree list --porcelain');
	if (!out) { return []; }
	const items = [];
	let cur = {};
	for (const line of out.split('\n')) {
		if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; }
		else if (line.startsWith('branch refs/heads/')) { cur.branch = line.slice(18); }
		else if (line === '') { if (cur.path) { items.push(cur); } cur = {}; }
	}
	if (cur.path) { items.push(cur); }
	return items.map(wt => {
		const branch = wt.branch || gitOut(wt.path, 'git branch --show-current') || '(detached)';
		const uncommittedChanges = gitOut(wt.path, 'git status --porcelain').split('\n').filter(l => l.trim()).length;
		const outgoingChanges = Number(gitOut(wt.path, 'git rev-list --count "@{u}..HEAD"')) || 0;
		const incomingChanges = Number(gitOut(wt.path, 'git rev-list --count "HEAD..@{u}"')) || 0;
		return { path: wt.path, branch, uncommittedChanges, outgoingChanges, incomingChanges };
	});
}

/** 用户自定义 agents（~/.vssaros/agents/{id}/agent.json；内置 agents 由前端 builtinAgents 提供）。 */
function listRealAgents() {
	const dir = path.join(VSSAROS_DIR, 'agents');
	const out = [];
	try {
		for (const d of fs.readdirSync(dir)) {
			const meta = readJsonSafe(path.join(dir, d, 'agent.json'), null);
			if (meta && meta.id) {
				out.push({
					id: meta.id, name: meta.name ?? meta.id,
					role: meta.role ?? meta.description ?? '', icon: meta.icon ?? '🤖',
					model: meta.model ?? '', provider: meta.providerId ?? '',
				});
			}
		}
	} catch { /* agents 目录不存在 → 无自定义 agent */ }
	return out;
}

function loadChatSessions() { return readJsonSafe(CHAT_SESSIONS_FILE, {}); }
function saveChatSessions(s) {
	try {
		fs.mkdirSync(path.dirname(CHAT_SESSIONS_FILE), { recursive: true });
		fs.writeFileSync(CHAT_SESSIONS_FILE, JSON.stringify(s, null, 1));
	} catch { /* 只读盘等场景静默 */ }
}

async function collectBody(req) {
	const chunks = [];
	for await (const c of req) { chunks.push(c); }
	return Buffer.concat(chunks).toString('utf8');
}

// visual harness（webview 子项目）—— 作为子进程托管
const WEBVIEW_DIR = path.resolve(__dirname, '../../webview');
const VISUAL_BUILD = path.join(WEBVIEW_DIR, 'visual', 'build.mjs');
const VISUAL_PORT = Number(process.env.VISUAL_PORT ?? 5599);

const PORT = Number(process.env.TEST_PANEL_PORT ?? 5600);

/** 默认并发度（前端滑块可调 1–8）。 */
const DEFAULT_CONCURRENCY = Number(process.env.TEST_CONCURRENCY ?? 4);
const MAX_CONCURRENCY = 8;

/** 解析并夹紧并发度参数。 */
function parseConc(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) { return DEFAULT_CONCURRENCY; }
	return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n)));
}

// ── Node 单元测试 ──────────────────────────────────────────────────────────

/**
 * ★ 功能模块分类表 —— **有序**，第一个命中即归类。
 *   所以「特殊模块」必须排在「通用模块」前面：
 *     - `agentChatPanel` 同时含 chat 与 agent → chat 在前才归「聊天框」
 *     - `workflowSandbox` 同时含 workflow 与 sandbox → workflow 在前才归「工作流」
 */
const CATEGORIES = [
	{ id: 'chat', label: '聊天框', kw: ['chat', 'minieditor', 'nodementions', 'slashcommand', 'reverseprompt', 'canvascontext', 'stream', 'structuredoutput', 'telegram', 'subagentcard'] },
	{ id: 'workflow', label: '工作流', kw: ['workflow', 'comfy', 'dag', 'litegraph', 'nodecard', 'stage', 'subflow', 'emojistage'] },
	{ id: 'kb', label: '知识库', kw: ['kb', 'wiki', 'enrich', 'pagemerge', 'frontmatter', 'vault', 'knowledge'] },
	{ id: 'agent', label: 'Agent', kw: ['agent', 'delegation', 'concurrent', 'routine'] },
	{ id: 'skill', label: '技能', kw: ['skill', 'newagenttool'] },
	// ⚠ 关键词是 overview 不是 repoverview —— `repoOverviewProvider` 小写后是
	//   `repooverviewprovider`（repo+overview，两个 o），写 repoverview 永远匹配不上。
	{ id: 'codebase', label: '代码库索引', kw: ['codebase', 'search', 'similarity', 'overview'] },
	{ id: 'bridge', label: 'Bridge / LLM', kw: ['bridge', 'llm', 'languagemodels', 'modelselector', 'mcp', 'tof'] },
	{ id: 'context', label: '上下文 / 记忆', kw: ['context', 'memory', 'dedup', 'advancedmemory'] },
	// ★ tool 必须排在 exec 之前：否则 `toolExecutionGuard`（execution 含 exec）会被 exec 抢走
	{ id: 'tool', label: '工具', kw: ['toolargs', 'toolcard', 'toolusage', 'toolexecution', 'tool'] },
	{ id: 'exec', label: '执行 / 终端', kw: ['exec', 'execution', 'terminal', 'shell', 'command', 'processoutput', 'workerpool', 'taskboard', 'taskstatus', 'graphparallel'] },
	{ id: 'security', label: '安全 / 沙箱', kw: ['sandbox', 'sensitive', 'security', 'guard', 'permission', 'worktree', 'workspace'] },
	{ id: 'schedule', label: '调度 / 定时', kw: ['cron', 'schedule', 'scheduler'] },
	{ id: 'infra', label: '基础设施', kw: ['plugin', 'mermaid', 'publish', 'scriptsource', 'slot', 'websearch', 'video', 'crystal'] },
];
const OTHER = { id: 'other', label: '其他', kw: [] };
const ALL_CATS = [...CATEGORIES, OTHER];

/** 按测试名（小写包含匹配）归纳到功能模块。 */
function classify(name) {
	const n = name.toLowerCase();
	for (const c of CATEGORIES) {
		if (c.kw.some(k => n.includes(k))) { return c.id; }
	}
	return OTHER.id;
}

/** 扫描当前目录下所有 *.test.ts，并自动归纳到功能模块。 */
function listTests() {
	return fs.readdirSync(__dirname)
		.filter(f => f.endsWith('.test.ts'))
		.sort()
		.map(f => {
			const name = f.replace(/\.test\.ts$/, '');
			return {
				file: f,
				name,
				cat: classify(name),
				kb: Math.round(fs.statSync(path.join(__dirname, f)).size / 1024),
			};
		});
}

/** suite 路径：栈里所有缩进比用例浅的 suite，用 › 连接。 */
function suitePath(stack, indent) {
	return stack.filter(s => s.indent < indent).map(s => s.name).join(' › ');
}

/** 从失败详情块里切出「用例名」与「错误详情」（详情块里最后一行以冒号结尾的是用例名）。 */
function finishBlock(cur) {
	const idx = cur.lines.findIndex(l => {
		const t = l.trim();
		return t.length > 1 && /:$/.test(t) && !/^\d+\)/.test(t);
	});
	const name = idx >= 0 ? cur.lines[idx].trim().replace(/:$/, '') : '';
	const detail = (idx >= 0 ? cur.lines.slice(idx + 1) : cur.lines)
		.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
	return { name, detail };
}

/** 解析 mocha 的失败详情区（`N failing` 之后），按编号索引。 */
function parseFailureBlocks(lines) {
	const out = new Map();
	let cur = null;
	const re = /^\s*(\d+)\)\s+/;
	for (const line of lines) {
		const m = re.exec(line);
		if (m) {
			if (cur) { out.set(cur.no, finishBlock(cur)); }
			cur = { no: Number(m[1]), lines: [] };
			continue;
		}
		if (cur) { cur.lines.push(line); }
	}
	if (cur) { out.set(cur.no, finishBlock(cur)); }
	return out;
}

/**
 * 结构化解析 mocha spec reporter 输出 → **用例级**结果。
 *
 * 真实格式（2026-09-04 实测）：
 *     格式探测 Suite            ← suite（缩进 2）
 *       ✔ 通过的用例 A          ← pass（符号 ✔/✓；慢用例带 (Nms)）
 *       1) 失败的用例           ← fail（编号 N) ）
 *       - 跳过的用例            ← pending（- 或 ◦）
 *       嵌套 Suite             ← 嵌套 suite（缩进更深）
 *     3 passing (6ms)
 *     1 pending
 *     2 failing
 *     1) 格式探测 Suite         ← 失败详情块；**编号与用例行的 N) 一一对应**
 *          失败的用例:
 *        AssertionError ...
 *        at Context.<anonymous> (...)
 *
 * @returns {{tests: Array<{name:string,suite:string,status:string,ms?:number,error?:string}>,
 *            pass:number, fail:number, skip:number}}
 */
function parseMocha(output) {
	const lines = output.split(/\r?\n/);
	const tests = [];
	const stack = [];
	let summaryAt = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) { continue; }
		// 汇总行出现后，后面的都是失败详情区，交给 parseFailureBlocks 处理
		if (/^\s*\d+\s+(passing|failing|pending)\b/.test(line)) {
			if (summaryAt < 0) { summaryAt = i; }
			continue;
		}
		if (summaryAt >= 0) { continue; }

		const indent = line.length - line.replace(/^\s+/, '').length;
		const body = line.trim();
		let m;
		if ((m = /^[✔✓]\s+(.*?)(?:\s+\((\d+)ms\))?$/.exec(body))) {
			tests.push({ name: m[1], status: 'pass', ms: m[2] ? Number(m[2]) : null, suite: suitePath(stack, indent) });
		} else if ((m = /^(\d+)\)\s+(.*?)$/.exec(body))) {
			tests.push({ name: m[2], status: 'fail', ms: null, no: Number(m[1]), suite: suitePath(stack, indent) });
		} else if ((m = /^[-◦]\s+(.*?)$/.exec(body))) {
			tests.push({ name: m[1], status: 'skip', ms: null, suite: suitePath(stack, indent) });
		} else if (indent >= 2 && !/^\[/.test(body) && !/^\d+\)/.test(body)) {
			// suite 行：弹出同级及更深的项，再入栈
			// ★ indent >= 2 且不以 `[` 开头 —— 被测代码往 stdout 打的诊断日志
			//   （如 `[runStageWorkflow] invoking runner.invoke label=… kind=image`）
			//   会混进 mocha 输出，早期版本没过滤，导致用例的 suite 被解析成日志内容。
			while (stack.length && stack[stack.length - 1].indent >= indent) { stack.pop(); }
			stack.push({ indent, name: body });
		}
	}

	const failures = parseFailureBlocks(summaryAt < 0 ? [] : lines.slice(summaryAt));
	for (const t of tests) {
		if (t.status === 'fail' && failures.has(t.no)) {
			const f = failures.get(t.no);
			if (f.name) { t.name = f.name; }
			t.error = f.detail;
		}
	}
	return {
		tests,
		pass: tests.filter(t => t.status === 'pass').length,
		fail: tests.filter(t => t.status === 'fail').length,
		skip: tests.filter(t => t.status === 'skip').length,
	};
}

/** 跑单个测试文件，返回 { code, output, pass, fail, skip, tests }。 */
function execOne(file) {
	return new Promise(resolve => {
		const p = spawn(process.execPath, [RUNNER, path.join(__dirname, file)], {
			cwd: __dirname,
			env: process.env,
		});
		let out = '';
		p.stdout.on('data', d => { out += d; });
		p.stderr.on('data', d => { out += d; });
		p.on('error', err => resolve({
			code: -1, output: String(err), pass: 0, fail: 1, skip: 0, tests: [],
		}));
		p.on('close', code => {
			const r = parseMocha(out);
			// 崩在加载期（import 就挂）：解析不到任何用例但退出码非 0 → 记为 1 个文件级失败
			const fail = (r.tests.length === 0 && code !== 0) ? 1 : r.fail;
			resolve({
				code, output: out,
				pass: r.pass, fail, skip: r.skip,
				tests: r.tests,
			});
		});
	});
}

function sse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── 历史与 flaky ──────────────────────────────────────────────────────────
// 本地存 JSON（无外部依赖、无重型后端），每次执行后并入。用途：
//   - flaky：同一用例最近若干次里**时成时败**
//   - 耗时回归：同一用例平均耗时的历史基线（前端可据此标出异常慢的用例）
// ⚠ 文件名以 `.` 开头，避免被 `*.test.ts` 扫描误当成测试文件。

const HISTORY_FILE = path.join(__dirname, '.test-history.json');
const HISTORY_CASE_KEEP = 20;   // 每个用例保留最近 20 次
const HISTORY_RUN_KEEP = 50;    // 保留最近 50 次执行汇总
const FLAKY_WINDOW = 5;         // 最近 5 次里既有 pass 又有 fail → flaky

function loadHistory() {
	try {
		if (!fs.existsSync(HISTORY_FILE)) { return { version: 1, cases: {}, runs: [] }; }
		const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
		if (!raw || typeof raw !== 'object') { return { version: 1, cases: {}, runs: [] }; }
		return { version: 1, cases: raw.cases ?? {}, runs: raw.runs ?? [] };
	} catch {
		// 历史文件损坏不应影响面板可用
		return { version: 1, cases: {}, runs: [] };
	}
}

function saveHistory(h) {
	try {
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(h), 'utf8');
	} catch (e) {
		console.warn('[test-panel] 写历史失败：', e?.message ?? e);
	}
}

/** 用例的唯一键：`文件 › suite › 用例名`。 */
function caseKey(file, t) {
	return file + ' › ' + (t.suite ? t.suite + ' › ' : '') + t.name;
}

/** 把单个文件的用例结果并入历史。 */
function recordCases(file, tests) {
	if (!tests || !tests.length) { return; }
	const h = loadHistory();
	const ts = Date.now();
	for (const t of tests) {
		const k = caseKey(file, t);
		const c = h.cases[k] ?? (h.cases[k] = { file, suite: t.suite ?? '', name: t.name, history: [] });
		c.history.push({ ts, status: t.status, ms: t.ms ?? null });
		if (c.history.length > HISTORY_CASE_KEEP) { c.history.splice(0, c.history.length - HISTORY_CASE_KEEP); }
	}
	saveHistory(h);
}

/** 记录一次执行的文件级汇总。 */
function recordRunSummary(sum) {
	const h = loadHistory();
	h.runs.push(Object.assign({ ts: Date.now() }, sum));
	if (h.runs.length > HISTORY_RUN_KEEP) { h.runs.splice(0, h.runs.length - HISTORY_RUN_KEEP); }
	saveHistory(h);
}

/**
 * 派生视图：flaky 用例、文件级 flaky 计数、最近执行汇总。
 * 这些是**派生**数据，不落盘（每次请求现算，历史量级小，开销可忽略）。
 */
function historyView() {
	const h = loadHistory();
	const all = [];
	let flakyCount = 0;
	for (const [k, c] of Object.entries(h.cases)) {
		const recent = c.history.slice(-FLAKY_WINDOW);
		const st = new Set(recent.map(x => x.status));
		const flaky = st.has('pass') && st.has('fail');
		const msList = c.history.map(x => x.ms).filter(x => typeof x === 'number');
		const avgMs = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : null;
		if (flaky) { flakyCount++; }
		all.push({
			key: k, file: c.file, suite: c.suite, name: c.name,
			flaky, runs: c.history.length, avgMs,
			last: recent[recent.length - 1] ?? null,
		});
	}
	// 文件级聚合（供文件行打标记）
	const byFile = {};
	for (const c of all) {
		const f = byFile[c.file] ?? (byFile[c.file] = { file: c.file, flaky: 0, cases: 0, runs: 0 });
		f.cases++;
		if (c.flaky) { f.flaky++; }
		f.runs += c.runs;
	}
	return {
		totalCases: all.length,
		flakyCount,
		flaky: all.filter(c => c.flaky),
		files: Object.values(byFile),
		runs: h.runs.slice(-20).reverse(),
	};
}

/**
 * 受控并发执行，结果按**完成顺序**流式回传。
 *
 * ★ 为什么可以并发而不怕输出交错：`execOne` 对每个文件独立 spawn、独立缓冲
 *   stdout/stderr 到各自的变量，所以多进程同时跑也互不干扰。
 * ★ 为什么按完成顺序推：前端按 `file` 定位行更新，与顺序无关。
 * ★ 并发度默认 4（可调 1–8），由前端滑块经 `?conc=` 传入。
 */
async function handleRun(files, res, conc) {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
	});
	const t0All = Date.now();
	const n = Math.max(1, Math.min(conc, files.length));
	let pass = 0, fail = 0, skip = 0, done = 0;
	let cursor = 0;

	// ⚠ 本文件是 .mjs（纯 JS），不能写 TS 类型注解
	const worker = async () => {
		for (;;) {
			const i = cursor++;
			if (i >= files.length) { return; }
			const f = files[i];
			sse(res, 'start', { file: f });
			const t0 = Date.now();
			const r = await execOne(f);
			done++;
			pass += r.pass;
			fail += r.fail;
			skip += r.skip;
			// ★ 并入历史（flaky / 耗时基线的原始材料）
			recordCases(f, r.tests);
			sse(res, 'result', {
				file: f,
				code: r.code,
				ms: Date.now() - t0,
				pass: r.pass,
				fail: r.fail,
				skip: r.skip,
				// ★ 用例级结果（名称 / suite 路径 / 状态 / 耗时 / 失败详情）
				tests: r.tests,
				// 只有「解析不到任何用例」时（加载期崩溃）才回传输出尾部，便于定位
				tail: r.tests.length === 0 ? r.output.split('\n').slice(-25).join('\n') : '',
				// 进度（前端可显示 x / y）
				done,
				total: files.length,
			});
		}
	};

	await Promise.all(Array.from({ length: n }, worker));

	const summary = { files: files.length, pass, fail, skip, totalMs: Date.now() - t0All, conc: n };
	recordRunSummary(summary);
	sse(res, 'done', summary);
	res.end();
}

// ── visual harness 子进程 + 反向代理 ───────────────────────────────────────

let visualProc = null;

function startVisual() {
	if (!fs.existsSync(VISUAL_BUILD)) {
		console.warn(`[test-panel] 未找到 ${VISUAL_BUILD} —— /visual 入口不可用`);
		return;
	}
	visualProc = spawn(process.execPath, [VISUAL_BUILD, '--serve', `--port=${VISUAL_PORT}`], {
		cwd: WEBVIEW_DIR,
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	visualProc.on('exit', code => {
		if (code !== 0 && code !== null) { console.warn(`[test-panel] visual 服务退出，code=${code}`); }
	});
	console.log(`[test-panel] visual harness 已拉起 → 127.0.0.1:${VISUAL_PORT}（经 /visual 代理）`);
}

/** 反向代理：/visual/xxx → http://127.0.0.1:<VISUAL_PORT>/xxx */
function proxyVisual(req, res) {
	if (!visualProc) {
		res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('visual harness 未启动（未找到 visual/build.mjs）');
		return;
	}
	const rest = (req.url ?? '/').replace(/^\/visual/, '') || '/';
	const target = `http://127.0.0.1:${VISUAL_PORT}${rest}`;
	const upstream = http.request(target, { method: req.method, headers: req.headers }, pr => {
		res.writeHead(pr.statusCode ?? 502, pr.headers);
		pr.pipe(res);   // 流式转发（SSE / 大 bundle 都不会被缓冲）
	});
	upstream.on('error', err => {
		res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(`visual 代理失败：${err.message}`);
	});
	req.pipe(upstream);
}

// ── 页面 ──────────────────────────────────────────────────────────────────

const SHARED_CSS = `
	:root {
		--fg: #cccccc; --desc: #9d9d9d; --bg: #141414; --panel: #1b1b1b;
		--border: #2b2b2b; --input: #313131; --input-border: #3c3c3c; --accent: #0e639c;
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg);
		font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 12px; }
	.bar { position: sticky; top: 0; z-index: 10; display: flex; gap: 10px; align-items: center;
		flex-wrap: wrap; padding: 8px 12px; background: var(--panel);
		border-bottom: 1px solid var(--border); }
	.bar strong { font-size: 13px; }
	.bar input[type="search"], .bar select { background: var(--input); color: var(--fg);
		border: 1px solid var(--input-border); border-radius: 3px; padding: 3px 6px; }
	.bar input[type="search"] { min-width: 200px; }
	.bar button { background: var(--input); color: var(--fg); border: 1px solid var(--input-border);
		border-radius: 3px; padding: 3px 10px; cursor: pointer; font-family: inherit; font-size: 12px; }
	.bar button:hover:not(:disabled) { background: #3a3a3a; }
	.bar button:disabled { opacity: .5; cursor: default; }
	.bar button.primary { background: var(--accent); border-color: #1177bb; color: #fff; }
	.bar button.primary:hover:not(:disabled) { background: #1177bb; }
	.bar .sep { width: 1px; height: 18px; background: var(--border); }
	.bar label { font-size: 11px; color: var(--desc); display: flex; align-items: center; gap: 4px; }
	.bar .prog { opacity: .7; font-variant-numeric: tabular-nums; }
	.bar .count { margin-left: auto; opacity: .8; font-variant-numeric: tabular-nums; }
	.list { padding: 8px 12px 40px; }
	.row { display: grid; grid-template-columns: 18px 14px minmax(200px, 1fr) 88px 1fr 34px;
		gap: 7px; align-items: center; padding: 3px 6px; border-radius: 4px;
		cursor: pointer; border-left: 2px solid transparent; }
	/* 展开箭头（文件行才有） */
	.row .caret { color: var(--desc); font-size: 9px; text-align: center; user-select: none; }
	.row .caret:hover { color: var(--fg); }
	.row .caret.leaf { visibility: hidden; }
	/* 用例级列表（文件行展开后显示） */
	.cases { display: none; padding: 2px 0 6px 34px; }
	.cases.on { display: block; }
	.case { display: grid; grid-template-columns: 14px 1fr 28px 54px 52px;
		gap: 7px; align-items: center; padding: 2px 6px; border-radius: 4px;
		font-size: 11px; border-left: 2px solid transparent; cursor: default; }
	.case.failing { cursor: pointer; }
	.case.failing:hover { background: #232323; }
	.case .cn { font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.case .cs { font-size: 9px; text-align: center; padding: 0 4px; border-radius: 3px;
		background: #2a2a2a; color: var(--desc); }
	.case.pass { border-left-color: #2ea043; }
	.case.pass .cs { background: rgba(46,160,67,.18); color: #4ac26b; }
	.case.fail { border-left-color: #f14c4c; }
	.case.fail .cs { background: rgba(241,76,76,.16); color: #f4878a; }
	.case.skip { border-left-color: #5a5a5a; opacity: .65; }
	.case .cm { font-size: 10px; color: var(--desc); text-align: right; font-variant-numeric: tabular-nums; }
	/* 用例详情（点失败用例内联展开） */
	.case-detail { display: none; margin: 2px 0 4px 20px; padding: 8px;
		background: #101010; border: 1px solid var(--border); border-radius: 4px; }
	.case-detail.on { display: block; }
	.case-detail .msg { color: #f4878a; font-size: 11px; margin-bottom: 6px; word-break: break-word; }
	.case-detail pre { margin: 0; font-family: ui-monospace, Consolas, monospace; font-size: 10px;
		white-space: pre-wrap; color: var(--desc); max-height: 260px; overflow: auto; }
	.case-detail .dl { color: #f4878a; }   /* diff - */
	.case-detail .da { color: #4ac26b; }   /* diff + */
	.case-detail .dat { color: #6a737d; }  /* at ... */
	.row:hover { background: #232323; }
	.row .name { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row .badge { font-size: 10px; text-align: center; padding: 1px 4px; border-radius: 3px;
		background: #2a2a2a; color: var(--desc); }
	.row .detail { font-size: 10px; color: var(--desc); overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap; }
	.row[data-state="pass"] { border-left-color: #2ea043; }
	.row[data-state="pass"] .badge { background: rgba(46,160,67,.18); color: #4ac26b; }
	.row[data-state="fail"] { border-left-color: #f14c4c; }
	.row[data-state="fail"] .badge { background: rgba(241,76,76,.16); color: #f4878a; }
	.row[data-state="running"] .badge { background: rgba(0,120,212,.2); color: #4aa3f0; }
	.row[data-state="untested"] { opacity: .7; }
	.row .runit { background: #2a2a2a; color: var(--desc); border: 1px solid var(--input-border);
		border-radius: 3px; padding: 0 7px; cursor: pointer; font-size: 10px;
		line-height: 17px; font-family: inherit; }
	.row .runit:hover:not(:disabled) { background: #3a3a3a; color: var(--fg); }
	.row .runit:disabled { opacity: .4; cursor: default; }
	/* flaky 标记（历史里时成时败） */
	.flaky-tag { background: rgba(210,153,34,.16); color: #d29922; font-size: 9px;
		padding: 0 4px; border-radius: 3px; white-space: nowrap; }
	.case .flaky-tag { font-size: 9px; padding: 0 3px; }
	.bar .hist { opacity: .75; font-size: 11px; }
	.bar .hist b { color: #d29922; }
	/* 功能模块分组 */
	.group { margin-bottom: 4px; }
	.group-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
		padding: 4px 6px; background: #1e1e1e; border-radius: 4px; cursor: pointer; }
	.group-head:hover { background: #262626; }
	.group-head .tw { width: 10px; opacity: .6; font-size: 10px; }
	.group-head .gname { font-weight: 600; font-size: 12px; }
	.group-head .gcount { opacity: .5; font-size: 11px; }
	.group-head .gbtns { margin-left: auto; display: flex; gap: 4px; }
	.group-head .gbtns button { background: #2a2a2a; color: var(--desc);
		border: 1px solid var(--input-border); border-radius: 3px; padding: 1px 7px;
		cursor: pointer; font-size: 10px; font-family: inherit; }
	.group-head .gbtns button:hover { background: #3a3a3a; color: var(--fg); }
	.group.collapsed .group-body { display: none; }
	.group-body { padding: 2px 0 2px 14px; }
	.log { margin: 8px 12px 40px; padding: 8px; background: #101010; border: 1px solid var(--border);
		border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 10px;
		white-space: pre-wrap; max-height: 320px; overflow: auto; color: var(--desc); display: none; }
	.log.on { display: block; }
	h4 { margin: 12px 12px 4px; font-size: 11px; color: var(--desc); font-weight: 600; }
`;

const HOME = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>测试总控 · agentStudio</title>
<style>${SHARED_CSS}
	.wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
	h1 { font-size: 20px; margin: 0 0 4px; }
	.sub { color: var(--desc); margin: 0 0 24px; font-size: 12px; }
	.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
	.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
		padding: 16px; display: flex; flex-direction: column; gap: 8px; }
	.card:hover { border-color: #3d3d3d; }
	.card h3 { margin: 0; font-size: 14px; }
	.card p { margin: 0; color: var(--desc); font-size: 12px; line-height: 1.6; }
	.card ul { margin: 0; padding-left: 18px; color: var(--desc); font-size: 11px; }
	.card li { margin: 2px 0; }
	.card a { display: inline-block; margin-top: auto; padding: 5px 12px; border-radius: 4px;
		background: var(--accent); color: #fff; text-decoration: none; font-size: 12px; align-self: flex-start; }
	.card a:hover { background: #1177bb; }
	.card a.alt { background: var(--input); border: 1px solid var(--input-border); color: var(--fg); }
	.card a.alt:hover { background: #3a3a3a; }
	code { background: #262626; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
	.note { margin-top: 24px; padding: 10px 14px; border-left: 3px solid var(--accent);
		background: rgba(14,99,156,.12); border-radius: 0 6px 6px 0; color: var(--desc); font-size: 12px; }
</style>
</head>
<body>
	<div class="wrap">
		<h1>测试总控</h1>
		<p class="sub">三层设施：渲染 · 执行 · 逻辑。共用同一份 <code>runtime.ts</code> 与 <code>bridgeStub.mjs</code>。</p>

		<div class="cards">
			<div class="card">
				<h3>测试面板</h3>
				<p>179 个测试用例，按<strong>功能模块自动分类</strong>（聊天框 / 工作流 / 知识库 / Agent / 技能 / 代码库索引 …）。</p>
				<ul>
					<li>分组可折叠，组内「本组全选 / 清空」</li>
					<li>每行 <b>▶</b> 可<strong>单独执行</strong>这一个用例</li>
					<li>也可跨组勾选后批量执行，SSE 流式回传</li>
				</ul>
				<a href="/node">打开</a>
			</div>

			<div class="card">
				<h3>节点执行面板</h3>
				<p>列出全部节点，勾选后<strong>真跑</strong> <code>runNodeOrStage</code>，逐行看产出与错误。</p>
				<ul>
					<li>搜索过滤 / 全选 / 结果筛选</li>
					<li>假后端开关（让 success 路径可跑）</li>
					<li>每条显示：条目数 · 耗时 · 错误文案</li>
				</ul>
				<a class="alt" href="/visual/?panel=1">打开</a>
			</div>
		</div>

		<div class="note">
			<b>怎么选：</b>改了纯函数 / 数据契约 / 执行器 → 测试面板；要看节点执行后 UI 如何变化 → 节点执行面板。
			不确定就先跑测试面板（最快，无浏览器开销）。
			<br><br>
			<b>节点渲染画廊</b>已从面板入口移除（它是截图基线设施，不是「用例执行」），
			仍可命令行访问：<code>cd src/vs/sessions/contrib/agentStudio/webview &amp;&amp; npm run visual:dom</code>
		</div>
	</div>
</body>
</html>`;

/* ---------------------------------------------------------------------------
 * ⚠⚠ 下面这个模板字符串里的「内联前端脚本」有严格转义规则（已在此踩坑 4 次）：
 *   1. 反斜杠必须**双写**：换行写 \\n；正则里的空白写 \\s
 *      单写 \n → 被输出成真换行 → 内联 script「字符串未闭合」；
 *      单写 \s → 反斜杠被吃掉 → /^s*+s?/ 「Nothing to repeat」
 *   2. **注释里也不能出现反引号** —— 会提前结束模板字符串（SyntaxError）
 *   3. 本文件是 .mjs：不能写 TS 类型注解（如 `: Promise<void>`）
 * ------------------------------------------------------------------------ */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Node 测试面板 · agentStudio</title>
<style>${SHARED_CSS}</style>
<style>
	/* ── mockup 对齐层（_test-panel-mockup.html：三栏 / 统计卡 / 详情面板 / 进度条）── */
	body { background: #0d1117; }
	.topbar { display: flex; gap: 8px; align-items: center; padding: 7px 12px;
		background: #1c2129; border-bottom: 1px solid #30363d; }
	.topbar .sp { flex: 1; }
	.tp-stats { display: flex; gap: 10px; padding: 12px; border-bottom: 1px solid #30363d; flex-wrap: wrap; }
	.stat { flex: 1 1 120px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; }
	.stat .k { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .5px; }
	.stat .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.stat.ok .v { color: #3fb950; } .stat.bad .v { color: #f85149; } .stat.info .v { color: #4a9eff; }
	.tp-ctrl { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
		padding: 10px 12px; border-bottom: 1px solid #30363d; background: #161b22; }
	.tp-ctrl .btn { background: #1c2129; color: #e6edf3; border: 1px solid #30363d;
		border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-family: inherit; }
	.tp-ctrl .btn:hover:not(:disabled) { background: #2a313c; }
	.tp-ctrl .btn.primary { background: #4a9eff; border-color: #4a9eff; color: #fff; }
	.tp-ctrl .btn.danger { background: rgba(248,81,73,.12); border-color: rgba(248,81,73,.5); color: #f85149; }
	.tp-ctrl .btn:disabled { opacity: .45; cursor: default; }
	.tp-ctrl .sep { width: 1px; height: 20px; background: #30363d; }
	.tp-ctrl .grow { flex: 1; }
	.tp-ctrl label { font-size: 11px; color: #8b949e; display: flex; align-items: center; gap: 4px; }
	.tp-body { display: grid; grid-template-columns: 210px 1fr 320px; }
	@media (max-width: 1100px) { .tp-body { grid-template-columns: 1fr; }
		.tp-detail { border-left: none; border-top: 1px solid #30363d; } }
	.tp-side { border-right: 1px solid #30363d; padding: 10px; background: #161b22; }
	.tp-side h5, .tp-detail h5 { margin: 2px 0 8px; font-size: 10px; color: #8b949e;
		text-transform: uppercase; letter-spacing: .5px; }
	.cat { display: flex; align-items: center; gap: 6px; padding: 3px 7px; border-radius: 5px;
		cursor: pointer; font-size: 12px; margin-bottom: 1px; }
	.cat:hover { background: #1c2129; }
	.cat.on { background: rgba(74,158,255,.12); color: #4a9eff; }
	.cat .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.cat .c { color: #8b949e; font-size: 11px; font-variant-numeric: tabular-nums; }
	.cat .p { width: 6px; height: 6px; border-radius: 50%; flex: none; }
	.p.ok { background: #3fb950; } .p.bad { background: #f85149; } .p.na { background: #30363d; }
	.tp-main { padding: 10px 12px; overflow: auto; }
	.tp-detail { border-left: 1px solid #30363d; padding: 12px; background: #161b22; font-size: 11.5px; }
	.tp-detail .empty { color: #8b949e; font-style: italic; padding: 20px 0; text-align: center; }
	.tp-detail .fh { color: #f85149; font-weight: 600; margin-bottom: 8px; word-break: break-all; }
	.tp-detail .kv { display: flex; gap: 6px; margin-bottom: 4px; }
	.tp-detail .kv .k { color: #8b949e; min-width: 40px; flex: none; }
	.tp-detail pre { background: #0a0d12; border: 1px solid #30363d; border-radius: 6px;
		padding: 8px; font-size: 10.5px; overflow: auto; max-height: 260px; margin: 8px 0;
		font-family: monospace; color: #8b949e; white-space: pre-wrap; }
	.tp-foot { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
		border-top: 1px solid #30363d; background: #1c2129; font-size: 11px; color: #8b949e; }
	.tp-foot .bar { flex: 1; height: 5px; background: #22282f; border-radius: 3px; overflow: hidden; padding: 0; }
	.tp-foot .bar > i { display: block; height: 100%; background: #4a9eff; width: 0%; transition: width .3s; }
	.badge-live { background: rgba(63,185,80,.12); color: #3fb950; padding: 1px 7px; border-radius: 10px; font-size: 10px; }
	/* 场景条目的「打开」按钮（复用 runit 的视觉，但不触发 mocha 执行） */
	.row .ropen { background: transparent; border: none; color: #8b949e; cursor: pointer; font-size: 12px; }
	.row .ropen:hover { color: #4a9eff; }
	/* ★ 场景行只有 4 个子元素（图标/名称/badge/打开），不覆盖的话 name 会掉进
	   第 2 列（caret 的 14px 列）→ 文字竖排显示不全，badge 反占 200px 的 name 列 */
	.row[data-scen] { grid-template-columns: 18px minmax(200px, 1fr) auto 64px; }
	.row[data-scen] .name { font-family: inherit; font-size: 12px; }
	.row[data-scen] .badge { white-space: nowrap; }
</style>
</head>
<body>
	<div class="topbar">
		<strong><a href="/" style="color:inherit;text-decoration:none">← 总控</a></strong>
		<span class="sp"></span>
		<span class="hist" id="hist" title="来自 .test-history.json：同一用例最近 5 次里时成时败即判 flaky"></span>
	</div>
	<div class="tp-stats">
		<div class="stat info"><div class="k">用例总数</div><div class="v" id="stTotal">0</div></div>
		<div class="stat ok"><div class="k">通过</div><div class="v" id="stPass">0</div></div>
		<div class="stat bad"><div class="k">失败</div><div class="v" id="stFail">0</div></div>
		<div class="stat"><div class="k">文件</div><div class="v" id="stDone">0/0</div></div>
		<div class="stat"><div class="k">耗时</div><div class="v" id="stMs">—</div></div>
	</div>
	<div class="tp-ctrl">
		<button id="run" class="btn primary">▶ 执行选中</button>
		<button id="rerunfail" class="btn danger" title="把上次失败的文件全部重跑">↻ 仅重跑失败</button>
		<button id="stop" class="btn">停止</button>
		<span class="sep"></span>
		<button id="all" class="btn">全选</button>
		<button id="none" class="btn">全不选</button>
		<button id="expandall" class="btn" title="展开/收起全部用例列表">展开/收起</button>
		<span class="sep"></span>
		<label>并发 <input type="range" id="conc" min="1" max="8" value="4" style="width:64px"
			oninput="document.getElementById('concV').textContent=this.value"></label>
		<span id="concV" style="font-size:11px">4</span>
		<span class="grow"></span>
		<input type="search" id="search" placeholder="过滤测试名…" />
		<select id="filter">
			<option value="">全部结果</option>
			<option value="pass">仅通过</option>
			<option value="fail">仅失败</option>
			<option value="untested">仅未跑</option>
			<option value="flaky">⚡ 仅 flaky</option>
		</select>
	</div>
	<div class="tp-body">
		<div class="tp-side"><h5>功能模块</h5><div id="cats"></div></div>
		<div class="tp-main"><div class="list" id="list"></div></div>
		<div class="tp-detail" id="detail">
			<h5>失败详情</h5>
			<div class="empty">点击用例行查看详情（失败显示堆栈与 diff）</div>
		</div>
	</div>
	<div class="tp-foot">
		<span class="badge-live">● LIVE</span>
		<span id="prog">空闲</span>
		<div class="bar"><i id="pbar"></i></div>
		<span id="eta">—</span>
	</div>
	<h4>最近一次输出</h4>
	<div class="log" id="log"></div>
<script>
const state = new Map();
let src = null;
const list = document.getElementById('list');
const log = document.getElementById('log');
const runBtn = document.getElementById('run');
const detailEl = document.getElementById('detail');
let activeCat = '';
let runStartedAt = 0;
let CAT_LIST = [];

// ── 历史 / flaky ──────────────────────────────────────────────────────────
const histByFile = new Map();
const histByKey = new Map();

// 用例唯一键，必须与服务端 caseKey() 保持一致。
// ⚠ 本段在 PAGE 模板字符串内：注释里也不能出现反引号（会提前结束模板字符串）。
function caseKeyOf(file, t) {
	return file + ' › ' + (t.suite ? t.suite + ' › ' : '') + t.name;
}

function applyHistory(h) {
	for (const f of h.files || []) { histByFile.set(f.file, f); }
	for (const c of h.flaky || []) { histByKey.set(c.key, c); }
	const el = document.getElementById('hist');
	if (el) {
		el.innerHTML = h.flakyCount
			? '⚡ <b>' + h.flakyCount + '</b> flaky · ' + (h.totalCases || 0) + ' 用例已记录'
			: ((h.totalCases ? h.totalCases + ' 用例已记录' : ''));
	}
}

function hasFlakyFile(file) {
	const hf = histByFile.get(file);
	return !!(hf && hf.flaky);
}

/** 给文件行打 flaky 标记（历史上有用例时成时败）。 */
function markFlakyFiles() {
	for (const row of list.querySelectorAll('.row')) {
		const f = row.dataset.file;
		if (!hasFlakyFile(f)) { continue; }
		const d = row.querySelector('[data-role="detail"]');
		if (!d || row.querySelector('.flaky-tag')) { continue; }
		const tag = document.createElement('span');
		tag.className = 'flaky-tag';
		tag.textContent = '⚡' + histByFile.get(f).flaky;
		tag.title = '历史上有 ' + histByFile.get(f).flaky + ' 条用例 flaky（时成时败）';
		d.parentNode.insertBefore(tag, d.nextSibling);
	}
}

// ★ 按功能模块分组渲染：先取分类表，再把测试文件归纳进各组
Promise.all([
	fetch('/api/categories').then(r => r.json()),
	fetch('/api/tests').then(r => r.json()),
	fetch('/api/history').then(r => r.json()).catch(() => null),
	fetch('/api/scenarios').then(r => r.json()).catch(() => []),
]).then(([cats, tests, hist, scens]) => {
	if (hist) { applyHistory(hist); }
	// ── 🎬 端到端场景组（置顶）：▶ 在新窗口打开独立工作流 UI，不参与 mocha 执行统计 ──
	if (scens && scens.length) {
		const g = document.createElement('div');
		g.className = 'group';
		g.dataset.cat = 'scenario';
		g.innerHTML =
			'<div class="group-head">' +
				'<span class="tw">▾</span>' +
				'<span class="gname">🎬 端到端场景</span>' +
				'<span class="gcount">' + scens.length + '</span>' +
				'<span class="gbtns"><span style="color:#8b949e;font-size:10px">▶ 在新窗口打开独立工作流 UI</span></span>' +
			'</div>' +
			'<div class="group-body"></div>';
		const body = g.querySelector('.group-body');
		for (const s of scens) {
			const row = document.createElement('label');
			row.className = 'row';
			row.dataset.scen = s.id;
			row.innerHTML =
				'<span class="scen-ic" style="text-align:center">🎬</span>' +
				'<span class="name" title="' + s.url + '">' + esc(s.label) + '</span>' +
				'<span class="badge" style="background:rgba(74,158,255,.12);color:#4a9eff">' + esc(s.badge) + '</span>' +
				'<button class="ropen" data-open="' + s.url + '" title="在新窗口打开（不参与用例统计）">▶ 打开</button>';
			body.appendChild(row);
		}
		g.querySelector('.group-head').addEventListener('click', e => {
			if (e.target.closest('button')) { return; }
			g.classList.toggle('collapsed');
			g.querySelector('.tw').textContent = g.classList.contains('collapsed') ? '▸' : '▾';
		});
		for (const b of g.querySelectorAll('[data-open]')) {
			b.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();
				window.open(b.getAttribute('data-open'), '_blank');
			});
		}
		list.appendChild(g);
	}
	for (const c of cats) {
		const items = tests.filter(t => t.cat === c.id);
		if (!items.length) { continue; }
		const g = document.createElement('div');
		g.className = 'group';
		g.dataset.cat = c.id;
		g.innerHTML =
			'<div class="group-head">' +
				'<span class="tw">▾</span>' +
				'<span class="gname">' + c.label + '</span>' +
				'<span class="gcount">' + items.length + '</span>' +
				'<span class="gbtns">' +
					'<button data-act="sel">本组全选</button>' +
					'<button data-act="clr">清空</button>' +
				'</span>' +
			'</div>' +
			'<div class="group-body"></div>';
		const body = g.querySelector('.group-body');
		for (const t of items) {
			const row = document.createElement('label');
			row.className = 'row';
			row.dataset.file = t.file;
			row.dataset.state = 'untested';
			row.innerHTML =
				'<input type="checkbox" class="pick" data-file="' + t.file + '" checked/>' +
				'<span class="caret" data-role="caret" title="展开/收起用例">▸</span>' +
				'<span class="name" title="' + t.file + '">' + t.name + '</span>' +
				'<span class="badge" data-role="badge">—</span>' +
				'<span class="detail" data-role="detail">' + t.kb + ' KB</span>' +
				'<button class="runit" data-run="' + t.file + '" title="单独执行这一个">▶</button>';
			body.appendChild(row);
			// 用例级容器（执行后填充，默认收起）
			const cases = document.createElement('div');
			cases.className = 'cases';
			body.appendChild(cases);
			row.querySelector('.caret').addEventListener('click', e => {
				// row 是 <label>：不拦的话点箭头会切换 checkbox
				e.preventDefault();
				e.stopPropagation();
				cases.classList.toggle('on');
				row.querySelector('.caret').textContent = cases.classList.contains('on') ? '▾' : '▸';
			});
			state.set(t.file, null);
		}
		g.querySelector('.group-head').addEventListener('click', e => {
			if (e.target.closest('button')) { return; }   // 点组内按钮不折叠
			g.classList.toggle('collapsed');
			g.querySelector('.tw').textContent = g.classList.contains('collapsed') ? '▸' : '▾';
		});
		g.querySelector('[data-act="sel"]').addEventListener('click', () => {
			for (const cb of body.querySelectorAll('.pick')) { cb.checked = true; }
		});
		g.querySelector('[data-act="clr"]').addEventListener('click', () => {
			for (const cb of body.querySelectorAll('.pick')) { cb.checked = false; }
		});
		list.appendChild(g);
	}
	// ★ 单独执行某一个用例（行尾 ▶）
	for (const b of list.querySelectorAll('.runit')) {
		b.addEventListener('click', e => {
			// row 是 <label>，点按钮会触发 label 默认行为（切换 checkbox）——必须拦掉
			e.preventDefault();
			e.stopPropagation();
			runFiles([b.getAttribute('data-run')]);
		});
	}
	CAT_LIST = cats;
	updateStat();
	markFlakyFiles();
	renderCats();
});

/** 左侧模块侧栏（mockup：模块名 + 文件数 + 状态点；点击按模块过滤中间列表）。 */
function renderCats() {
	const el = document.getElementById('cats');
	if (!el) { return; }
	const info = {};
	for (const c of CAT_LIST) { info[c.id] = { label: c.label, total: 0, fail: 0 }; }
	for (const g of list.querySelectorAll('.group')) {
		const id = g.dataset.cat;
		if (!info[id]) { continue; }
		for (const row of g.querySelectorAll('.row')) {
			info[id].total++;
			const v = state.get(row.dataset.file);
			if (v && v.state === 'fail') { info[id].fail++; }
		}
	}
	el.innerHTML = '<div class="cat ' + (activeCat === '' ? 'on' : '') + '" data-cat="">' +
		'<span class="p na"></span><span class="n">全部模块</span><span class="c">' + state.size + '</span></div>' +
		Object.keys(info).filter(id => info[id].total > 0).map(id =>
			'<div class="cat ' + (activeCat === id ? 'on' : '') + '" data-cat="' + id + '">' +
			'<span class="p ' + (info[id].fail ? 'bad' : (info[id].total ? 'ok' : 'na')) + '"></span>' +
			'<span class="n" title="' + esc(info[id].label) + '">' + esc(info[id].label) + '</span>' +
			'<span class="c">' + info[id].total + '</span></div>'
		).join('');
	for (const c of el.querySelectorAll('.cat')) {
		c.addEventListener('click', () => { activeCat = c.dataset.cat; renderCats(); applyFilter(); });
	}
}

/** 右侧详情面板（mockup：点用例行 → 标题/文件/状态/堆栈 diff + 复制复现命令）。 */
function showDetail(file, t) {
	if (!t || !detailEl) { return; }
	const isFail = t.status === 'fail';
	let html = '<h5>' + (isFail ? '失败详情' : '用例详情') + '</h5>';
	html += '<div class="kv"><span class="k">用例</span><span>' + esc(t.name) + '</span></div>';
	html += '<div class="kv"><span class="k">文件</span><span>' + esc(file) + '</span></div>';
	if (t.suite) { html += '<div class="kv"><span class="k">套件</span><span>' + esc(t.suite) + '</span></div>'; }
	if (!isFail) {
		html += '<div class="kv"><span class="k">状态</span><span style="color:#3fb950">PASS · ' +
			(t.ms != null ? t.ms + 'ms' : '—') + '</span></div>';
		detailEl.innerHTML = html;
		return;
	}
	html += '<div class="fh">' + esc(String(t.error || '(无错误详情)').split('\\n')[0]) + '</div>';
	html += '<div style="color:#8b949e;font-size:10px;letter-spacing:.5px;margin:6px 0 0">STACK / DIFF</div>';
	html += detailHtml(t);
	html += '<button class="btn" style="width:100%;margin-top:8px" data-act="copy">复制复现命令</button>';
	detailEl.innerHTML = html;
	const cp = detailEl.querySelector('[data-act="copy"]');
	if (cp) {
		cp.onclick = () => {
			const cmd = 'node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs ' + file;
			if (navigator.clipboard) { navigator.clipboard.writeText(cmd); }
			cp.textContent = '✓ 已复制';
			setTimeout(() => { cp.textContent = '复制复现命令'; }, 1500);
		};
	}
}

function applyFilter() {
	const kw = document.getElementById('search').value.trim().toLowerCase();
	const f = document.getElementById('filter').value;
	// ★ 必须遍历 .row 而不是 list.children —— 后者的直接子元素是 .group，
	//   而 .row 在 .group > .group-body 里。早先写成遍历 group，导致
	//   dataset.file 恒为 undefined，**所有结果筛选一直静默失效**。
	for (const g of list.children) {
		if (!g.classList || !g.classList.contains('group')) { continue; }
		// ★ 模块侧栏过滤：选中某模块时其余整组隐藏
		if (activeCat && g.dataset.cat !== activeCat) { g.style.display = 'none'; continue; }
		let anyVisible = false;
		for (const row of g.querySelectorAll('.row')) {
			const name = row.querySelector('.name').textContent.toLowerCase();
			const st = state.get(row.dataset.file);
			const okKw = !kw || name.includes(kw);
			let okF;
			if (!f) { okF = true; }
			else if (f === 'untested') { okF = !st; }
			else if (f === 'flaky') { okF = hasFlakyFile(row.dataset.file); }
			// ★ st 是 { state, cases } 对象，必须取 .state —— 直接拿 st 比字符串
			//   恒 false（仅通过/仅失败筛选项一直静默失效）
			else { okF = !!st && st.state === f; }
			const show = okKw && okF;
			row.style.display = show ? '' : 'none';
			// 用例容器跟着一起隐藏，否则会留下孤立的用例列表
			const box = row.nextElementSibling;
			if (box && box.classList.contains('cases')) { box.style.display = show ? '' : 'none'; }
			if (show) { anyVisible = true; }
		}
		// 组内一条都不匹配 → 连分组标题一起隐藏
		g.style.display = anyVisible ? '' : 'none';
	}
}

function updateStat() {
	// ★ mockup 统计卡口径：通过/失败/总数按【用例】数；「文件」卡显示文件进度
	let done = 0, pass = 0, fail = 0, cases = 0;
	for (const v of state.values()) {
		if (!v) continue;
		done++;
		pass += v.passCases || 0;
		fail += v.failCases || 0;
		cases += v.cases || 0;
	}
	const el = id => document.getElementById(id);
	el('stTotal').textContent = cases;
	el('stPass').textContent = pass;
	el('stFail').textContent = fail;
	el('stDone').textContent = done + '/' + state.size;
}

function setRow(file, st, text) {
	const row = list.querySelector('.row[data-file="' + CSS.escape(file) + '"]');
	if (!row) return;
	row.dataset.state = st;
	row.querySelector('[data-role="badge"]').textContent = st === 'pass' ? 'PASS' : (st === 'running' ? '...' : 'FAIL');
	row.querySelector('[data-role="detail"]').textContent = text;
	state.set(file, { state: st, cases: (state.get(file) || {}).cases || 0 });
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 失败用例详情：错误消息 + 带 diff 着色的堆栈（行首 -红 / +绿 / at 灰）。 */
function detailHtml(t) {
	// ⚠ PAGE 是模板字符串：换行转义必须写成「双反斜杠 + n」，写成单反斜杠会被
	//   输出成真换行，导致生成的内联 script 出现「字符串未闭合」。
	const raw = String(t.error || '(无错误详情)').split('\\n');
	const head = raw[0] ? '<div class="msg">' + esc(raw[0]) + '</div>' : '';
	const rest = raw.slice(1).map(l => {
		if (/^\\s*at\\s/.test(l)) { return '<span class="dat">' + esc(l) + '</span>'; }
		if (/^\\s*\\+\\s?/.test(l) || /^\\s*\\+$/.test(l)) { return '<span class="da">' + esc(l) + '</span>'; }
		if (/^\\s*-\\s?/.test(l) || /^\\s*-$/.test(l)) { return '<span class="dl">' + esc(l) + '</span>'; }
		return esc(l);
	}).join('\\n');
	return head + '<pre>' + rest + '</pre>';
}

/** 把用例级结果渲染进文件行下方的 .cases 容器（点击用例 → 右侧详情面板）。 */
function renderCases(file, tests) {
	const row = list.querySelector('.row[data-file="' + CSS.escape(file) + '"]');
	if (!row) { return; }
	const box = row.nextElementSibling;
	if (!box || !box.classList.contains('cases')) { return; }
	box.innerHTML = tests.map((t, i) => {
		const cls = t.status === 'pass' ? 'pass' : (t.status === 'fail' ? 'fail' : 'skip');
		const full = t.suite ? t.suite + ' › ' + t.name : t.name;
		return '<div class="case ' + cls + '" data-idx="' + i + '" title="点击查看详情">' +
			'<span></span>' +
			'<span class="cn" title="' + esc(full) + '">' + esc(t.name) + '</span>' +
			(histByKey.get(caseKeyOf(file, t))
				? '<span class="flaky-tag" title="历史 flaky：最近 5 次里时成时败">⚡</span>'
				: '<span></span>') +
			'<span class="cs">' + (t.status === 'pass' ? 'PASS' : t.status === 'fail' ? 'FAIL' : 'SKIP') + '</span>' +
			'<span class="cm">' + (t.ms != null ? t.ms + 'ms' : '—') + '</span>' +
			'</div>';
	}).join('');
	// ★ mockup 交互：点击任意用例 → 右侧详情面板（失败显示堆栈与 diff 着色）
	for (const c of box.querySelectorAll('.case')) {
		c.addEventListener('click', () => {
			showDetail(file, tests[Number(c.getAttribute('data-idx'))]);
		});
	}
}

/** 展开某文件的用例列表。 */
function openCases(file) {
	const row = list.querySelector('.row[data-file="' + CSS.escape(file) + '"]');
	if (!row) { return; }
	const box = row.nextElementSibling;
	if (box && box.classList.contains('cases') && !box.classList.contains('on')) {
		box.classList.add('on');
		row.querySelector('.caret').textContent = '▾';
	}
}

document.getElementById('all').onclick = () => { for (const c of list.querySelectorAll('.pick')) c.checked = true; };
document.getElementById('none').onclick = () => { for (const c of list.querySelectorAll('.pick')) c.checked = false; };
// ★ mockup：一键重跑上次失败的文件
document.getElementById('rerunfail').onclick = () => {
	const failed = [];
	for (const [f, v] of state.entries()) { if (v && v.state === 'fail') { failed.push(f); } }
	if (!failed.length) { detailEl.innerHTML = '<h5>提示</h5><div class="empty">当前没有失败的文件</div>'; return; }
	runFiles(failed);
};
// ★ mockup：展开/收起全部用例列表（按当前多数状态取反）
document.getElementById('expandall').onclick = () => {
	const boxes = Array.from(list.querySelectorAll('.cases'));
	const anyOff = boxes.some(b => !b.classList.contains('on'));
	for (const b of boxes) { b.classList.toggle('on', anyOff); }
	for (const row of list.querySelectorAll('.row')) {
		const c = row.querySelector('.caret');
		if (c) { c.textContent = anyOff ? '▾' : '▸'; }
	}
};
document.getElementById('search').oninput = applyFilter;
document.getElementById('filter').onchange = applyFilter;

document.getElementById('stop').onclick = () => {
	if (src) { src.close(); src = null; runBtn.disabled = false; }
};

/** 执行一组文件（批量勾选 / 单个 ▶ / 仅重跑失败 都走这里）。 */
function runFiles(picked) {
	if (!picked.length) return;
	const runits = () => { for (const b of list.querySelectorAll('.runit')) { b.disabled = true; } };
	const unlock = () => {
		runBtn.disabled = false;
		for (const b of list.querySelectorAll('.runit')) { b.disabled = false; }
	};
	runBtn.disabled = true;
	runits();
	log.classList.add('on');
	log.textContent = '';
	runStartedAt = Date.now();
	const pbar = document.getElementById('pbar');
	const etaEl = document.getElementById('eta');
	pbar.style.width = '0%';
	document.getElementById('prog').textContent = '0/' + picked.length;
	etaEl.textContent = '估算中…';
	for (const f of picked) setRow(f, 'running', '执行中…');
	// ★ 并发度随执行一起提交，服务端据此调度 worker pool
	const conc = document.getElementById('conc').value || 4;
	src = new EventSource('/api/run?files=' + encodeURIComponent(picked.join(',')) + '&conc=' + conc);
	src.addEventListener('result', e => {
		const r = JSON.parse(e.data);
		const st = r.fail === 0 && r.code === 0 ? 'pass' : 'fail';
		if (r.done != null && r.total) {
			document.getElementById('prog').textContent = r.done + '/' + r.total;
			// ★ mockup 底栏进度条 + ETA（按已完成比例线性估算剩余）
			pbar.style.width = Math.round(r.done / r.total * 100) + '%';
			const elapsed = Date.now() - runStartedAt;
			const eta = Math.max(0, Math.round(elapsed / r.done * (r.total - r.done) / 1000));
			etaEl.textContent = r.done < r.total ? '剩余 ~' + eta + 's' : '收尾…';
			document.getElementById('stMs').textContent = (elapsed / 1000).toFixed(1) + 's';
		}
		setRow(r.file, st, r.pass + ' 用例 · ' + r.ms + 'ms' +
			(r.fail ? ' · ✗ ' + r.fail : '') + (r.skip ? ' · ⊘ ' + r.skip : ''));
		// ★ 统计卡的通过/失败是【用例数】口径（mockup 语义），文件数口径在「文件」卡
		const sv = state.get(r.file);
		sv.cases = r.pass + r.fail + (r.skip || 0);
		sv.passCases = r.pass;
		sv.failCases = r.fail;
		if (r.tests && r.tests.length) {
			renderCases(r.file, r.tests);
			// ★ 有失败就自动展开用例列表 —— 省去手动点箭头
			if (r.fail > 0) { openCases(r.file); }
		}
		if (r.tail) {
			log.textContent = '=== ' + r.file + ' ===\\n' + r.tail + '\\n\\n' + log.textContent;
		}
		updateStat();
	});
	src.addEventListener('done', e => {
		const d = JSON.parse(e.data);
		log.textContent = '===== 完成：' + d.files + ' 文件 · ✓ ' + d.pass + ' · ✗ ' + d.fail +
			(d.skip ? ' · ⊘ ' + d.skip : '') + ' · ' + Math.round(d.totalMs / 1000) + 's' +
			' · 并发 ' + (d.conc || '?') + ' =====\\n\\n' + log.textContent;
		document.getElementById('prog').textContent = d.files + '/' + d.files + ' · 完成';
		pbar.style.width = '100%';
		etaEl.textContent = '总耗时 ' + (d.totalMs / 1000).toFixed(1) + 's';
		document.getElementById('stMs').textContent = (d.totalMs / 1000).toFixed(1) + 's';
		src.close(); src = null; unlock();
		updateStat();
		renderCats();
		applyFilter();
	});
	src.onerror = () => { unlock(); if (src) { src.close(); src = null; } };
}

runBtn.onclick = () => {
	runFiles(Array.from(list.querySelectorAll('.pick')).filter(c => c.checked).map(c => c.dataset.file));
};
</script>
</body>
</html>`;

// ── 路由 ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
	const p = url.pathname;

	// visual harness（反向代理，保持同源）
	if (p === '/visual' || p.startsWith('/visual/')) { proxyVisual(req, res); return; }

	if (p === '/' || p === '/index.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(HOME);
		return;
	}
	if (p === '/node') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(PAGE);
		return;
	}
	if (p === '/api/tests') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(listTests()));
		return;
	}
	if (p === '/api/categories') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(ALL_CATS.map(c => ({ id: c.id, label: c.label }))));
		return;
	}
	if (p === '/api/scenarios') {
		// 端到端场景入口：不是 mocha 用例——点击在**新标签**打开画布沙箱并预置好节点
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify([
			{ id: 'emoji-comfyui', label: '表情包端到端 · ComfyUI 真出图', badge: '需本地 ComfyUI 8188',
				url: '/visual/canvas/?scenario=emoji&backend=comfyui' },
			{ id: 'emoji-provider', label: '表情包端到端 · Provider 回放', badge: '需先载入录制 JSON',
				url: '/visual/canvas/?scenario=emoji&backend=provider' },
			{ id: 'storyboard-multi', label: '故事板端到端 · 多宫格真出图', badge: '需本地 ComfyUI 8188',
				url: '/visual/canvas/?scenario=storyboard-multi&backend=comfyui' },
			{ id: 'storyboard-editor', label: '故事板端到端 · 导演台编排', badge: '本地编排 · 无需后端',
				url: '/visual/canvas/?scenario=storyboard-editor' },
			{ id: 'kb-mindmap', label: '知识库思维导图 · 生成→合并→布局→落盘', badge: 'LLM 内置样例 · 无需后端',
				url: '/visual/canvas/?scenario=kb-mindmap' },
			{ id: 'chat-real', label: '聊天框端到端 · 真实聊天框组件（人工交互）', badge: '100% AgentChatPanel · ComfyUI 8188',
				url: '/visual/canvas/?scenario=chat-real&backend=comfyui' },
			{ id: 'chat-ui', label: '聊天框端到端 · 真实聊天框组件（auto 自动发送）', badge: '100% AgentChatPanel · 聊天链路 auto · ComfyUI 8188',
				url: '/visual/canvas/?scenario=chat-ui&backend=comfyui&auto=1' },
			{ id: 'chat-ui-provider', label: '聊天框端到端 · 真实聊天框组件 · Provider 回放', badge: '需先载入录制 JSON · auto',
				url: '/visual/canvas/?scenario=chat-ui&backend=provider&auto=1' },
		]));
		return;
	}
	if (p === '/api/history') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(historyView()));
		return;
	}
	if (p === '/api/history/clear') {
		saveHistory({ version: 1, cases: {}, runs: [] });
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	// ── 聊天沙箱真实数据 API（workspaces / worktrees / agents / chat sessions）──
	// 数据与 vssaros.exe 同源：~/.vssaros/{workspaces.json, agents/, chat-history/}；
	// worktree 走**真实 git 命令**（child_process），与 host 的 WorktreeService 同语义。
	if (p === '/api/real/workspaces') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(listRealWorkspaces()));
		return;
	}
	if (p === '/api/real/worktrees') {
		const wsPath = url.searchParams.get('path') ?? '';
		let items = [];
		try { items = wsPath ? listRealWorktrees(wsPath) : []; } catch (e) { items = []; }
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(items));
		return;
	}
	if (p === '/api/real/agents') {
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(listRealAgents()));
		return;
	}
	if (p === '/api/real/chat-sessions' && req.method === 'GET') {
		const all = loadChatSessions();
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(Object.entries(all).map(([id, s]) => ({
			id, name: s.name, createdAt: s.createdAt, messageCount: (s.messages ?? []).length,
		}))));
		return;
	}
	if (p === '/api/real/chat-sessions' && req.method === 'POST') {
		const body = JSON.parse(await collectBody(req) || '{}');
		const all = loadChatSessions();
		const id = 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
		all[id] = { name: body.name ?? '新会话', createdAt: new Date().toISOString(), messages: [] };
		saveChatSessions(all);
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ id, name: all[id].name }));
		return;
	}
	if (p.startsWith('/api/real/chat-sessions/') && p.endsWith('/messages')) {
		const sid = p.slice('/api/real/chat-sessions/'.length, -'/messages'.length);
		const all = loadChatSessions();
		if (req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(all[sid]?.messages ?? []));
			return;
		}
		if (req.method === 'POST') {
			const body = JSON.parse(await collectBody(req) || '{}');
			if (!all[sid]) { all[sid] = { name: body.sessionName ?? '会话', createdAt: new Date().toISOString(), messages: [] }; }
			all[sid].messages = all[sid].messages ?? [];
			all[sid].messages.push({ role: body.role, text: body.text, imageUrl: body.imageUrl, ts: Date.now() });
			saveChatSessions(all);
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
	}
	if (p === '/api/run') {
		const files = (url.searchParams.get('files') ?? '').split(',').filter(Boolean);
		handleRun(files, res, parseConc(url.searchParams.get('conc')));
		return;
	}
	res.writeHead(404).end('not found');
});

function shutdown() {
	if (visualProc) { visualProc.kill(); }
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
	startVisual();
	const tests = listTests();
	console.log(`[test-panel] → http://127.0.0.1:${PORT}/`);
	console.log(`[test-panel]   · Node 单测    ${tests.length} 个文件  → /node`);
	console.log(`[test-panel]   · 执行面板    223 个节点      → /visual/?panel=1`);
	console.log(`[test-panel]   · 渲染画廊    892 个场景      → /visual/`);
});
