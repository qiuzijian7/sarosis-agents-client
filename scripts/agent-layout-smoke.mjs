#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  [Saros] 「IDE 底座 + Agent 布局」窗口的日志冒烟脚本
 *
 *  它只做一件事：**把证据端到桌面上** ——
 *    编译 → （可选）启动 → 等日志落定 → 解析 renderer.log → 按指纹去重 →
 *    与上一轮 diff → 打印结构化摘要
 *
 *  ★ 它**不自动改代码**。原因（用实证）：
 *    「错误消失」不等于「根因修好」—— 例如在 `layout.ts:1159` 加个 `?? true`
 *    就能让那个 `reading 'restore'` 消失而根因仍在。闭环若以"错误消失"为收敛条件，
 *    会**报告成功并把问题藏起来**。所以修复必须留给人/agent 审阅。
 *
 *  ★ 停止条件（写死，防止无意义地反复试）：
 *    ① 错误集合与上一轮**完全相同**（一字不差）⇒ 打印醒目警告"上一轮修复无效，
 *       别再在同一假设上再试"；
 *    ② 退出码：0=无新增错误 / 1=有新增错误 / 2=环境或启动失败。
 *
 *  ── 日志路径（已查实）──────────────────────────────────────────────
 *    `platform/environment/electron-main/environmentMainService.ts:75-78`
 *      logsPath = join(userDataPath, 'logs', instanceId ? join('instances', id) : '', key)
 *      key = toLocalISOString(now).replace(/-|:|\.\d+Z$/g, '')   // 形如 20260914T173245
 *    `workbench/services/environment/electron-browser/environmentService.ts:102-106`
 *      windowLogsPath = joinPath(logsHome, 'window' + windowId)
 *      logFile        = joinPath(windowLogsPath, 'renderer.log')
 *
 *  ⚠ 裸 `console.log` **不落这个文件**，只有走 `ILogService` 的内容才落。
 *    所以诊断代码必须用 `ILogService`（见 `agentLayoutWorkspaceService.ts` 的
 *    `_diagnosticLogService`）。
 *
 *  ── 用法 ─────────────────────────────────────────────────────────
 *    node scripts/agent-layout-smoke.mjs --parse-only
 *        只解析**已存在**的最新日志（不编译、不启动）—— 最快，验证脚本本身用它。
 *    node scripts/agent-layout-smoke.mjs --no-build --launch
 *        跳过编译，启动应用（`scripts/code.bat`），等日志落定后解析并**关掉应用**。
 *    node scripts/agent-layout-smoke.mjs
 *        完整：`npm run compile` → 启动 → 等 → 解析。
 *
 *  可选参数：
 *    --timeout=<秒>      等待日志落定的上限（默认 240）
 *    --user-data=<目录>  指定 userData 目录（默认自动探测 `.vssaros-dev` / `.vssaros`）
 *    --tag=<标签>        额外抓取的诊断标签（默认 `[Saros][zenModeDiag]`）
 *    --keep-open         启动后不自动关闭应用（调试脚本时用）
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, '.codebuddy', 'smoke');
const REPORT_FILE = path.join(REPORT_DIR, 'last-report.json');
const STARTED_AT = Date.now();

//#region --- 参数

const argv = process.argv.slice(2);
const hasFlag = name => argv.includes(`--${name}`);
const optValue = (name, fallback) => {
	const hit = argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const PARSE_ONLY = hasFlag('parse-only');
const DO_BUILD = !hasFlag('no-build') && !PARSE_ONLY;
const DO_LAUNCH = hasFlag('launch');
const KEEP_OPEN = hasFlag('keep-open');
const TIMEOUT_SEC = Number(optValue('timeout', '240'));
const TAG = optValue('tag', '[Saros][zenModeDiag]');
const USER_DATA_OPT = optValue('user-data', undefined);

//#endregion

//#region --- 日志定位

/** 探测 userData 目录（本仓 dev 用 `.vssaros-dev`，见 product.json 的 `dataFolderName`）。 */
function userDataCandidates() {
	if (USER_DATA_OPT) {
		return [path.resolve(USER_DATA_OPT)];
	}
	const names = ['.vssaros-dev', '.vssaros'];
	const bases = [os.homedir(), process.env.APPDATA].filter(Boolean);
	const out = [];
	for (const base of bases) {
		for (const name of names) {
			out.push(path.join(base, name));
		}
	}
	return out;
}

/** 找最新的日志会话目录（目录名形如 `20260914T173245`，字典序即时序）。 */
function findLogSessions() {
	const sessions = [];
	for (const userData of userDataCandidates()) {
		const logsRoot = path.join(userData, 'logs');
		if (!fs.existsSync(logsRoot)) {
			continue;
		}
		// 多开时日志在 `logs/instances/<id>/<key>/`，所以递归找形如时间戳的目录。
		const walk = dir => {
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const full = path.join(dir, entry.name);
				if (/^\d{8}T\d{6}$/.test(entry.name)) {
					sessions.push({ key: entry.name, dir: full, userData });
				} else {
					walk(full);
				}
			}
		};
		walk(logsRoot);
	}
	return sessions.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** 会话目录里最新的 renderer.log（位于 `window<N>/` 子目录下）。 */
function findRendererLog(sessionDir) {
	const candidates = [];
	let entries;
	try {
		entries = fs.readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^window\d+$/.test(entry.name)) {
			continue;
		}
		const file = path.join(sessionDir, entry.name, 'renderer.log');
		if (fs.existsSync(file)) {
			candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0]?.file;
}

/**
 * 所有会话里的 renderer.log，**按修改时间倒序**。
 *
 * 为什么不用"字典序最大的会话"：多开时日志被拆到 `logs/instances/<id>/<key>/`，
 * 同一时刻可能存在多个会话目录（有的只有 `main.log`），字典序最大的那个未必是
 * 真正在写的那个。按 mtime 取最新最稳。
 */
function allRendererLogs() {
	const out = [];
	for (const session of findLogSessions()) {
		const file = findRendererLog(session.dir);
		if (!file) {
			continue;
		}
		const stat = fs.statSync(file);
		out.push({ session, file, mtime: stat.mtimeMs, size: stat.size });
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

//#endregion

//#region --- 解析

/**
 * 把一行日志归一化成**指纹** —— 让"同一个错误"在不同轮次里得到同一个键。
 * 去掉：源码绝对路径+行号前缀、uuid、hex、长数字、路径、耗时。
 */
function fingerprint(line) {
	return line
		// 文件格式的行首是 `2026-09-14 01:35:37.623 `（DevTools 里看不到这段）。
		.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s*/, '')
		.replace(/^[A-Za-z]:\\[^\s]*?:\d+(?::\d+)?\s*/, '')
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
		.replace(/0x[0-9a-f]+/gi, '<hex>')
		.replace(/\b\d+\s?ms\b/gi, '<ms>')
		.replace(/\b\d{4,}\b/g, '<num>')
		.replace(/[A-Za-z]:\\[^\s)]+/g, '<path>')
		.trim()
		.slice(0, 300);
}

function parseLog(text) {
	const errors = new Map();
	const warns = new Map();
	const diags = [];
	const lines = text.split(/\r?\n/);

	const bump = (map, key, lineNo, extra) => {
		const existing = map.get(key);
		if (existing) {
			existing.count++;
			return;
		}
		map.set(key, { key, count: 1, firstLine: lineNo, frame: extra });
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		if (TAG && line.includes(TAG)) {
			diags.push(line.trim());
			continue;
		}
		// ★ 日志**文件**里级别是 `[error]` / `[warning]`（带方括号、小写）；
		// DevTools 控制台里才显示成 ` ERR ` / ` WARN `（大写）。只按后者匹配会
		// **一条都抓不到** —— 这是实测踩出来的（脚本第一版就是这个 bug）。
		// 两种都认，并保留 console 风格作为兜底。
		const isError = /\[error\]/i.test(line) || /\bERR\b|\bERROR\b/.test(line);
		const isWarn = /\[warning\]/i.test(line) || /\bWARN\b/.test(line);
		if (!isError && !isWarn) {
			continue;
		}
		// 附带下一行的栈顶帧，便于人眼定位（也参与指纹之外的展示）。
		let frame;
		const next = lines[i + 1] ?? '';
		const frameMatch = next.match(/^\s+at\s+(\S+)/);
		if (frameMatch) {
			frame = frameMatch[1];
		}
		bump(isError ? errors : warns, fingerprint(line), i + 1, frame);
	}

	return { errors, warns, diags };
}

//#endregion

//#region --- 输出

function printGroup(title, map, marker) {
	const items = [...map.values()].sort((a, b) => b.count - a.count);
	if (!items.length) {
		console.log(`${title}：（无）`);
		return;
	}
	console.log(`${title}：`);
	for (const item of items) {
		console.log(`  ${marker} ${item.key}`);
		if (item.frame) {
			console.log(`      首帧：${item.frame}`);
		}
		console.log(`      次数：${item.count}  首次出现：第 ${item.firstLine} 行`);
	}
}

function loadPrevious() {
	try {
		return JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
	} catch {
		return undefined;
	}
}

function saveReport(report) {
	fs.mkdirSync(REPORT_DIR, { recursive: true });
	fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, '\t'), 'utf8');
}

//#endregion

//#region --- 主流程

function run(cmd, args, opts = {}) {
	const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
	return result.status ?? 1;
}

function newestSessionKey() {
	return findLogSessions()[0]?.key;
}

async function waitForLog(beforeKey) {
	const deadline = Date.now() + TIMEOUT_SEC * 1000;
	let lastSize = -1;
	let stablePolls = 0;
	let current;

	while (Date.now() < deadline) {
		const latest = allRendererLogs()[0];
		// 认「比启动前更新」的那一个：换了会话目录，或同一会话还在继续写。
		if (latest && (latest.session.key !== beforeKey || latest.mtime > STARTED_AT)) {
			if (latest.size === lastSize) {
				stablePolls++;
				// 连续 3 次（约 6s）大小不变 ⇒ 认为启动日志已落定。
				if (stablePolls >= 3) {
					return { session: latest.session, file: latest.file };
				}
			} else {
				stablePolls = 0;
				lastSize = latest.size;
			}
			current = { session: latest.session, file: latest.file };
		}
		await new Promise(r => setTimeout(r, 2000));
	}
	return current;
}

async function main() {
	let child;

	// `--list`：只列出找到的 renderer.log（排查"脚本挑错会话"时用）。
	if (hasFlag('list')) {
		const logs = allRendererLogs();
		console.log(`找到 ${logs.length} 个 renderer.log（按修改时间倒序）：`);
		for (const item of logs) {
			console.log(`  ${item.session.key}  ${(item.size / 1024).toFixed(0).padStart(6)} KB  ${item.file}`);
		}
		if (!logs.length) {
			console.log('  （无）探测过这些位置：');
			for (const dir of userDataCandidates()) {
				console.log(`   ${path.join(dir, 'logs')}`);
			}
		}
		process.exit(0);
	}

	if (DO_BUILD) {
		console.log('▶ 编译中（npm run compile）…');
		const code = run('npm', ['run', 'compile']);
		if (code !== 0) {
			console.error(`✖ 编译失败（exit ${code}）—— 先修编译错误，日志冒烟无从谈起。`);
			process.exit(2);
		}
	}

	const beforeKey = newestSessionKey();

	if (DO_LAUNCH) {
		const launcher = path.join(ROOT, 'scripts', process.platform === 'win32' ? 'code.bat' : 'code.sh');
		if (!fs.existsSync(launcher)) {
			console.error(`✖ 找不到启动脚本：${launcher}`);
			process.exit(2);
		}
		console.log(`▶ 启动应用：${launcher}`);
		child = spawn(launcher, [], { cwd: ROOT, detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
		child.unref();
	}

	let target;
	if (DO_LAUNCH) {
		console.log(`▶ 等待新的日志会话（上限 ${TIMEOUT_SEC}s）…`);
		target = await waitForLog(beforeKey);
	} else {
		const latest = allRendererLogs()[0];
		target = latest ? { session: latest.session, file: latest.file } : undefined;
	}

	if (!target?.file) {
		console.error('✖ 没找到 renderer.log。找过这些位置：');
		for (const dir of userDataCandidates()) {
			console.error(`   ${path.join(dir, 'logs')}`);
		}
		console.error('  提示：用 --user-data=<目录> 指定；或先手动启动一次应用生成日志。');
		if (child && !KEEP_OPEN) {
			spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
		}
		process.exit(2);
	}

	const text = fs.readFileSync(target.file, 'utf8');
	const { errors, warns, diags } = parseLog(text);

	console.log('');
	console.log('════════════════ 冒烟报告 ════════════════');
	console.log(`日志会话：${target.session.key}`);
	console.log(`renderer.log：${target.file}（${(text.length / 1024 / 1024).toFixed(2)} MB）`);
	console.log(`userData 根：${target.session.userData}`);
	if (!target.session.userData.includes('.vssaros-dev')) {
		// ★ 本机同时存在 `.vssaros-dev`（本仓 dev 跑的）与 `.vssaros`（另一份安装版构建）。
		// 后者日志里能看到 `vscode-app/d:/Program Files/VsSaros/...` 之类的路径。
		console.log('  ⚠ 这不是本仓 dev 跑出来的根（`.vssaros-dev`）—— 很可能是**另一份构建**，');
		console.log('    它的错误集合与本轮改动无关，**不要据此判断修复效果**。');
	}
	console.log(`错误 ${errors.size} 类 / 警告 ${warns.size} 类 / 诊断 ${diags.length} 条`);
	console.log('');

	const previous = loadPrevious();
	const prevErrors = new Set(Object.keys(previous?.errors ?? {}));
	const currentKeys = new Set(errors.keys());
	const added = [...currentKeys].filter(k => !prevErrors.has(k));
	const removed = [...prevErrors].filter(k => !currentKeys.has(k));

	// ★★ 跨根比较是**假信号**的来源：`.vssaros-dev` 与 `.vssaros` 是两份不同的运行
	// （本仓 dev / 另一份安装版构建），错误集合本来就不一样，直接 diff 会报出
	// "错误消失"这种**与修复无关**的结论。实测踩过：`.vssaros` 那一轮连我们的诊断行
	// 都没有（说明不是同一个窗口），却报了 `reading 'restore'` 错误"消失"。
	// ⇒ 根不同就**拒绝 diff**，只把它当新基线。
	const previousRoot = previous?.userData;
	const rootChanged = !!previous && previousRoot !== target.session.userData;
	// ★ 同一个日志会话 = 同一个进程的同一份日志。跟**自己**做 diff 必然"一字不差"，
	// 却会被读成"上一轮的修复无效" —— 这是**方向完全反掉**的假信号。
	// 实测踩过：重启命令被取消、新实例没起来，脚本读到的仍是旧会话，
	// 于是报了"错误集合与上一轮完全相同 ⇒ 修复无效"。
	const sameSession = !!previous && previous.session === target.session.key;
	const comparable = !!previous && !rootChanged && !sameSession;

	if (rootChanged) {
		console.log('⚠⚠ 上一轮报告来自**另一个 userData 根**，本轮不可比较：');
		console.log(`    上一轮：${previousRoot ?? '(未记录)'}`);
		console.log(`    本轮　：${target.session.userData}`);
		console.log('    ⇒ 已**跳过 diff** —— 跨根的"新增/消失"没有意义。');
		console.log('    请在**同一个根**（同一份构建）上连续跑两轮再比较。');
		console.log('');
	}

	if (sameSession) {
		console.log('⚠⚠ 本轮读到的日志会话与上一轮**完全相同**（同一个进程、同一份日志）。');
		console.log('    ⇒ 已**跳过 diff** —— 跟自己做比较必然"一字不差"，');
		console.log('      那**不代表修复无效**，只说明**新实例没起来 / 新日志目录还没产生**。');
		console.log('    先确认应用真的重启了：`netstat -ano | findstr :9222` 的 PID 应该变了。');
		console.log('');
	}

	if (comparable) {
		if (added.length) {
			console.log(`✚ 新增错误（相对上一轮，共 ${added.length} 类）：`);
			for (const key of added) {
				const item = errors.get(key);
				console.log(`  ✚ ${key}`);
				if (item.frame) {
					console.log(`      首帧：${item.frame}`);
				}
				console.log(`      次数：${item.count}  首次出现：第 ${item.firstLine} 行`);
			}
		} else {
			console.log('✚ 新增错误：无');
		}
		console.log(removed.length ? `✔ 消失的错误（共 ${removed.length} 类）：\n  ${removed.join('\n  ')}` : '✔ 消失的错误：无');
	} else {
		console.log(rootChanged
			? '（跨根，本轮作为新基线）'
			: sameSession
				? '（与上一轮是**同一个日志会话**，本轮作为新基线 —— 同会话比较无意义）'
				: '（无上一轮报告，本轮作为基线）');
		printGroup('当前错误', errors, '•');
	}

	console.log('');
	printGroup('当前警告', warns, '•');

	if (diags.length) {
		console.log('');
		console.log(`诊断输出（${TAG}）：`);
		for (const line of diags) {
			console.log(`  ${line}`);
		}
	} else {
		console.log('');
		console.log(`诊断输出（${TAG}）：无 —— 若刚加过诊断，检查它是否走了 ILogService（裸 console.log 不落文件）`);
	}

	// ★ 停止条件：与上一轮一字不差 ⇒ 上一轮的修复无效。
	const identical = previous && added.length === 0 && removed.length === 0 && currentKeys.size > 0;
	if (identical) {
		console.log('');
		console.log('⚠⚠ 错误集合与上一轮**完全相同**（一字不差）。');
		console.log('    这意味着上一轮的修复**无效** —— 不要再在同一假设上试第二个变体，');
		console.log('    应该先补一条能证伪该假设的诊断，再动手。');
	}

	saveReport({
		generatedAt: new Date().toISOString(),
		session: target.session.key,
		// ★ 必须记根：下一轮靠它判断"能不能 diff"（跨根比较会产生假信号）。
		userData: target.session.userData,
		logFile: target.file,
		errors: Object.fromEntries([...errors].map(([k, v]) => [k, { count: v.count, firstLine: v.firstLine, frame: v.frame }])),
		warns: Object.fromEntries([...warns].map(([k, v]) => [k, { count: v.count, firstLine: v.firstLine }])),
		diags,
	});
	console.log('');
	console.log(`（报告已写入 ${path.relative(ROOT, REPORT_FILE)}，下一轮用它做 diff）`);

	if (child && !KEEP_OPEN) {
		console.log('▶ 关闭应用…');
		spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
	}

	process.exit(previous && added.length ? 1 : 0);
}

main().catch(error => {
	console.error('✖ 脚本自身出错：', error);
	process.exit(2);
});

//#endregion
