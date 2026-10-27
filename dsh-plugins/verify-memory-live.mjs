/*---------------------------------------------------------------------------------------------
 *  verify-memory-live.mjs — **运行态**验证记忆三件事（2026-10-27）
 *
 * 与 `run-memory-checks.mjs` 的分工：
 *   · `run-memory-checks` = **离线**自检（单测/守卫，不需要 IDE）
 *   · 本脚本 = **运行态**取证（读 IDE 日志 / 审计账本 / 草稿 / 网关计数 ⇒ 判"用户此刻能不能用"）
 *
 * 用法：
 *   node dsh-plugins/verify-memory-live.mjs
 *
 * 判定项（每项给出 ✓/✗ + 为什么会这样）：
 *   ① 网关在跑？   ② IDE 在跑？  ③ 别名注入（读写同 scope）
 *   ④ 注入有内容   ⑤ 回合观测（observe）   ⑥ 回合摘要沉淀   ⑦ 旧面板是否已下线
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), '.vssaros-dev');
const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

function tail(file, bytes = 8 * 1024 * 1024) {
	try {
		const st = fs.statSync(file);
		const fd = fs.openSync(file, 'r');
		const len = Math.min(st.size, bytes);
		const b = Buffer.alloc(len);
		fs.readSync(fd, b, 0, len, st.size - len);
		fs.closeSync(fd);
		return { mtime: st.mtime, lines: b.toString('utf8').split(/\r?\n/).filter(Boolean) };
	} catch { return null; }
}

const needle = (lines, re) => lines.filter(l => re.test(l));

/* ── ① 网关 ─────────────────────────────────────────────────────────── */
{
	const r = spawnSync('curl', ['-sS', '--max-time', '4', 'http://127.0.0.1:3112/health'], { encoding: 'utf8' });
	const ok = r.status === 0 && /"status"\s*:\s*"ok"/.test(r.stdout || '');
	add('网关 3112 在跑', ok, ok ? (r.stdout || '').trim().slice(0, 120) : '连不上 ⇒ 记忆读写注入全部不可用（起 IDE 会自动拉起）');
}

/* ── ② IDE 进程 ────────────────────────────────────────────────────── */
let ideStart = null;
{
	const r = spawnSync('powershell', ['-NoProfile', '-Command',
		"Get-CimInstance Win32_Process -Filter \"Name='Saroasis harness.exe'\" | Select-Object -First 1 -ExpandProperty CreationDate"],
	{ encoding: 'utf8' });
	const txt = (r.stdout || '').trim();
	const parsed = txt ? new Date(txt) : null;
	let resolved = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
	if (!resolved && txt) {
		const m = /(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(txt);
		if (m) { resolved = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])); }
	}
	ideStart = resolved;
	add('IDE 在跑', !!txt, txt ? ('启动于 ' + (ideStart ? ideStart.toLocaleString('zh-CN') : '(解析不了: ' + txt + ')')) : '没在跑 ⇒ 渲染侧注入/面板不可用');
}

/* ── 找出最新日志目录 ──────────────────────────────────────────────── */
let latest = null;
try {
	const base = path.join(ROOT, 'logs');
	const dirs = fs.readdirSync(base)
		// ⚠ 只认会话日志目录（`YYYYMMDDTHHMMSS`）；`logs/instances` 也是目录但结构不同 ⇒ 会取错 ✗
		.filter(n => /^\d{8}T\d{6}$/.test(n))
		.filter(n => { try { return fs.statSync(path.join(base, n)).isDirectory(); } catch { return false; } })
		.sort().reverse();
	latest = dirs.length ? path.join(ROOT, 'logs', dirs[0]) : null;
} catch { }

const mainLog = latest ? path.join(latest, 'main.log') : null;
const main = mainLog ? tail(mainLog) : null;

/* ── ③ 别名（读写同 scope）────────────────────────────────────────── */
{
	const lines = main ? main.lines : [];
	const alias = needle(lines, /记忆作用域别名/);
	if (!alias.length) {
		const injectRan = needle(lines, /记忆注入开关/).length > 0;
		add('作用域别名注入', false,
			injectRan ? '注入流程跑了但没打别名 ⇒ 看 workspaceId/agent 是否都拿到'
				: '注入流程**没跑**（`记忆注入开关` 也没有）⇒ 多半是这份日志是**改动前**启动的会话，重启 IDE 再看');
	} else {
		const last = alias[alias.length - 1].trim();
		add('作用域别名注入', true, last.slice(0, 170));
	}
}

/* ── ④ 注入有内容（loadContext 非空）────────────────────────────────── */
{
	const lines = main ? main.lines : [];
	const hits = needle(lines, /注入跨分区兜底|按空注入/);
	add('注入跨分区兜底触发（信息项）', true,
		hits.length ? hits[hits.length - 1].trim().slice(0, 170) : '没触发（正常：说明主分区本身有内容；异常：说明没走到注入）');
}

/* ── ⑤ 回合观测（observe）──────────────────────────────────────────── */
{
	const gw = tail(path.join(ROOT, '.agentmemory', 'gateway.log'));
	const text = gw ? gw.lines.join('\n') : '';
	const obs = (text.match(/'observe'/g) || []).length;
	const fail = gw ? needle(gw.lines, /回合观测写入失败/).length : 0;
	add('回合观测 observe 被调用', obs > 0, `网关日志里 observe=${obs} 次，失败行=${fail}` + (obs === 0 ? ' ⇒ 插件 0.6.9 需 **Host 重启**后才生效' : ''));
}

/* ── ⑥ 回合摘要沉淀 ────────────────────────────────────────────────── */
{
	const au = tail(path.join(ROOT, 'memory-audit', 'audit.jsonl'), 2 * 1024 * 1024);
	let turn = 0, noCand = 0, last = '';
	if (au) {
		for (const line of au.lines) {
			try {
				const j = JSON.parse(line);
				if (j.action !== 'distill') { continue; }
				if (/\(turn:/.test(String(j.outcome || ''))) { turn += 1; last = String(j.outcome); }
				if (j.outcome === 'no-candidate') { noCand += 1; }
			} catch { }
		}
	}
	add('回合摘要已沉淀', turn > 0, `含 (turn:N) 的 distill = ${turn} 条（no-candidate 累计 ${noCand}）` + (turn ? ' 最近: ' + last : ''));
}

/* ── ⑦ 旧面板是否已下线（静态）────────────────────────────────────── */
{
	const pane = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/memoryDetailEditorPane.ts');
	const gone = !fs.existsSync(pane);
	add('旧面板已下线（源码）', gone, gone ? 'memoryDetailEditorPane.ts 不存在 ✓' : '文件仍在 ⇒ 阶段①未生效');
}

/* ── 输出 ──────────────────────────────────────────────────────────── */
const w = Math.max(...results.map(r => r.name.length));
console.log('记忆系统 · 运行态验证'.padEnd(w + 30, ' '));
console.log('─'.repeat(96));
for (const r of results) {
	console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w)}  ${r.detail}`);
}
console.log('─'.repeat(96));
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `✗ ${failed.length}/${results.length} 项未达预期` : `✓ ${results.length} 项全部达预期`);
if (latest) { console.log('日志目录: ' + latest.replace(ROOT, '~')); }
process.exit(failed.length ? 1 : 0);
