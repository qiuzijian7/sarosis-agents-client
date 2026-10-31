// legacy 调度定义的程序化迁移（重构 2.1）。
//
// ── 迁什么、不迁什么 ────────────────────────────────────────────────────────
// 迁：agent.yaml 里的 `schedules` 声明（`IAgentYamlSchedule`：cron / one-shot / interval /
//     file-watch / event）——它们在 legacy 侧**从未执行过**（`agentSchedulerService` 对
//     `async *` 生成器只 await 不迭代 ⇒ 迁移零回归 ✓）。
// 不迁：渠道桥的 `bridgeScheduler`（IM 内定时，`scheduler.json` 落盘）——那是渠道（2.4）的
//     地盘，渠道迁移时一起处理；在这里迁会让"渠道还没迁、定时先跑了" ✗。
//
// ── 映射口径（官方只收五字段 Vixie cron + IANA 时区，S3 已验证）────────────
//   cron       → { cron: { expression, time_zone } }（只收五字段；秒字段 / L / W / # / @daily 逐条报出）
//   one-shot   → { at: { date, time, time_zone } }（time 是 ISO 字符串时拆成 date + time）
//   interval   → { every_seconds }（官方下限 60s ⇒ 更密的逐条报出）
//   file-watch / event → 官方没有这个语义 ⇒ 逐条报出，不硬迁
//   disabled（enabled === false）⇒ 跳过（不算失败）
//
// 每个任务配一条专属会话（方案 2.1）：sessionId = `sched-<agent>-<task>`，幂等 ⇒
// 重跑迁移不会重复建（官方 create 前我们先按 catalog 查重：同 sessionId 的任务已存在就跳过）。

import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { officialToSelfRule } from './core/task.js';

/** 简易 YAML 抽取：只认 `schedules:` 顶格键下的 `- name/type/...` 块（legacy agentYamlParser 同款手写解析的口径）。 */
function parseYamlSchedules(text) {
	const lines = String(text).split(/\r?\n/);
	const schedules = [];
	let inSchedules = false;
	let current = null;
	for (const raw of lines) {
		const line = raw.replace(/\s+$/, '');
		if (/^schedules\s*:/.test(line)) {
			inSchedules = true;
			continue;
		}
		if (inSchedules && /^\S/.test(line) && !/^schedules\s*:/.test(line)) {
			inSchedules = false; // 下一个顶格键 ⇒ schedules 块结束
		}
		if (!inSchedules) { continue; }
		const item = /^\s+-\s+(\w+)\s*:\s*(.*)$/.exec(line);
		if (item) {
			current = {};
			schedules.push(current);
			current[item[1]] = stripQuotes(item[2]);
			continue;
		}
		const field = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
		if (field && current) {
			current[field[1]] = stripQuotes(field[2]);
		}
	}
	return schedules;
}

function stripQuotes(v) {
	const s = String(v ?? '').trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/** 一条 legacy 声明 → 官方 create 请求；返回 { request } 或 { unsupported: 原因 }。 */
export function toOfficialRequest(schedule, timeZone) {
	const type = String(schedule?.type ?? '');
	const title = String(schedule?.name ?? schedule?.title ?? '').trim() || '未命名任务';
	const prompt = String(schedule?.prompt ?? '').trim();
	if (!prompt) {
		return { unsupported: '没有 prompt（调度任务的指令是必填的）' };
	}
	if (type === 'cron') {
		const expr = String(schedule?.cron ?? schedule?.cronExpr ?? '').trim();
		const fields = expr.split(/\s+/).filter(Boolean);
		if (fields.length !== 5) {
			return { unsupported: `cron 只收五字段（分 时 日 月 周），收到 ${fields.length} 段：${expr}` };
		}
		if (/[#LW?]/.test(expr) || expr.startsWith('@')) {
			return { unsupported: `cron 方言不收 L/W/#/@ 简写：${expr}` };
		}
		return { request: { title, prompt, cron: { expression: expr, time_zone: timeZone } } };
	}
	if (type === 'one-shot') {
		const at = String(schedule?.at ?? schedule?.time ?? '').trim();
		const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)/.exec(at);
		if (!m) {
			return { unsupported: `one-shot 的时间不是 ISO 形态：${at}` };
		}
		return { request: { title, prompt, at: { date: m[1], time: m[2], time_zone: timeZone } } };
	}
	if (type === 'interval') {
		const seconds = Number(schedule?.intervalSeconds ?? schedule?.everySeconds ?? NaN);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			return { unsupported: `interval 缺秒数：${JSON.stringify(schedule)}`.slice(0, 120) };
		}
		if (seconds < 60) {
			return { unsupported: `interval ${seconds}s 低于官方下限 60s` };
		}
		return { request: { title, prompt, every_seconds: Math.floor(seconds) } };
	}
	return { unsupported: `官方调度没有 ${type} 这个语义（只收 cron / one-shot / interval）` };
}

/** 迁移一段 agent.yaml 文本里声明的全部任务。返回 { created, skipped, failed, entries }。 */
export async function migrateYamlText(ctx, agentId, yamlText, { timeZone } = {}) {
	const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	const schedule = ctx.get?.('schedule') ?? ctx.schedule;
	const sessionController = ctx.get?.('sessionController') ?? ctx.sessionController;
	const workspaceRegistry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
	const result = { created: 0, skipped: 0, failed: [], entries: [] };
	if (!schedule) {
		result.failed.push('调度服务不可用（官方 schedule bundle 未安装）');
		return result;
	}
	const declarations = parseYamlSchedules(yamlText).filter(s => s && Object.keys(s).length);
	for (const decl of declarations) {
		const name = String(decl.name ?? '').trim() || '未命名任务';
		if (decl.enabled === 'false') {
			result.skipped++;
			result.entries.push({ name, outcome: 'skipped（disabled）' });
			continue;
		}
		const mapped = toOfficialRequest(decl, tz);
		if (!mapped.request) {
			result.failed.push(`${name}: ${mapped.unsupported}`);
			result.entries.push({ name, outcome: `failed: ${mapped.unsupported}` });
			continue;
		}
		try {
			const sessionId = `sched-${agentId}-${name}`.replace(/[^\w-]+/g, '-').slice(0, 80);
			// 查重：同会话下已有同名任务就跳过（迁移幂等 ✓ 重跑不重复建）。
			// ⚠ 自建引擎的 `list()` 返回**全部**任务（任务不寄生会话）⇒ 这里自己按 sessionId+title 过滤。
			const existing = await schedule.list().catch(() => []);
			if (existing.some(r => r?.title === mapped.request.title && r?.sessionId === sessionId)) {
				result.skipped++;
				result.entries.push({ name, outcome: 'skipped（已存在）' });
				continue;
			}
			// 专属会话要先存在（prompt 型任务绑定会话）。cwd 用 agent 的工作区根（cwd 兜底）。
			if (sessionController && workspaceRegistry) {
				const cwd = workspaceRegistry.list?.()[0]?.path ?? process.cwd();
				await workspaceRegistry.create(cwd);
				await sessionController.create({ cwd, sessionId });
			}
			// ★ 自建引擎签名：`create(task)`（不是官方的 `create(sessionId, request)`）。
			const rule = officialToSelfRule(mapped.request);
			if (!rule) {
				result.failed.push(`${name}: 规则无法转换`);
				result.entries.push({ name, outcome: 'failed: 规则无法转换' });
				continue;
			}
			await schedule.create({
				id: `t-${randomUUID().slice(0, 8)}`,
				title: mapped.request.title,
				kind: 'prompt',
				prompt: mapped.request.prompt,
				sessionId,
				rule,
			});
			result.created++;
			result.entries.push({ name, outcome: 'created' });
		} catch (e) {
			result.failed.push(`${name}: ${String(e?.message ?? e)}`);
			result.entries.push({ name, outcome: `failed: ${String(e?.message ?? e)}` });
		}
	}
	return result;
}

/** 迁移入口：扫 agents 根下每个 agent 的 agent.yaml，逐个迁其 schedules 声明。 */
export async function migrateLegacySchedules(ctx) {
	const foundation = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation;
	if (!foundation) {
		return { ok: false, error: 'foundation 服务不可用' };
	}
	const agentsRoot = join(foundation.dataRootOf({}), 'agents');
	const result = { ok: true, created: 0, skipped: 0, failed: [], agents: 0, files: 0 };
	let dirs = [];
	try {
		dirs = (await readdir(agentsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		// agents 根不存在 ⇒ 没有可迁的（legacy 从来没跑起来过，这很常见 ✓）
		return { ...result, note: 'agents 根目录不存在，没有可迁的 legacy 定义' };
	}
	result.agents = dirs.length;
	for (const dir of dirs) {
		let text;
		try {
			text = await readFile(join(agentsRoot, dir, 'agent.yaml'), 'utf8');
		} catch {
			continue;
		}
		result.files++;
		const r = await migrateYamlText(ctx, dir, text);
		result.created += r.created;
		result.skipped += r.skipped;
		result.failed.push(...r.failed.map(f => `${dir}: ${f}`));
	}
	return result;
}
