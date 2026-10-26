#!/usr/bin/env node
// studio.mjs —— 萨罗斯管理平台（SaroasisStudioSystem）只读查询 CLI
//
// 为什么要有它（2026-10-25 真机日志复盘）：agent 用 26 次 pwsh 才拼出一份「我名下的缺陷」，
// 其中 ~20 次是在踩接口的坑。下面这些坑**全部固化在本脚本里**，调用方不必再知道：
//   1. 翻页只能用 `page`；`offset` 会被忽略、永远返回第 1 页（曾把 200 条当成 8000 条）。
//   2. 默认排序是 id 正序（2024 年的老单），要看最新必须 `order=created desc`。
//   3. 缺陷的负责人字段是 `current_owner`；`owner=` 会被**静默忽略**并返回全项目数据。需求才用 `owner`。
//   4. 负责人值形如 `邱子鉴;` / `邱子鉴;蒋小川;`，服务端是模糊匹配；带分号查反而少（459 → 386）。
//   5. 状态码要翻译：`rejected`=主干待回归、`status_1`=无效关闭、`status_8`=分支待回归 …（workflows/status_map）。
//   6. 计数走 `/api/tapd/<bugs|stories>/count`（~100ms），不要拉全量本地数。
//   7. `/api/tapd/<不存在的路径>` 返回 `"Hello world from TAPD API"`（status=1，像成功）⇒ 必须当错误处理。
//   8. 「我」是谁：成员表 `/api/tapd/members` 里有 `wecomAlias`（企微账号）→ TAPD 中文名。
//   9. `/api/bugs/by-team` ≈206MB，本脚本不碰。
//
// 只读：本脚本**不提供任何写操作**（写单据交给 tapd-skill）。
// 零依赖：Node 18+ 自带 fetch。用法见 `node studio.mjs help`。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_DEFAULT = 'http://saroasisstudiosystem.saroasis.woa.com:9999';
export const WORKSPACE_DEFAULT = '68880148';
const PAGE_SIZE = 200;              // TAPD 单页上限（limit 再大也只回 200）
const TIMEOUT_MS = 30000;
const MAX_PAGES = 200;              // 安全阀：最多 4 万条
const OUTPUT_CAP = 120 * 1024;      // 单次输出上限，防止撑爆上下文

export const KINDS = {
	bug: {
		label: '缺陷', api: 'bugs', key: 'Bug', owner: 'current_owner', title: 'title', system: 'bug', comment: 'bug', author: 'reporter',
		listFields: 'id,title,status,current_owner,priority,severity,module,reporter,created,modified',
		detailFields: 'id,title,status,current_owner,priority,severity,module,reporter,created,modified,resolved,closed,version_report,release_id,iteration_id,de,te,fixer,description',
		url: (ws, id) => `https://www.tapd.cn/${ws}/bugtrace/bugs/view?bug_id=${id}`,
	},
	story: {
		label: '需求', api: 'stories', key: 'Story', owner: 'owner', title: 'name', system: 'story', comment: 'stories', author: 'creator',
		listFields: 'id,name,status,owner,priority,iteration_id,release_id,creator,created,modified',
		detailFields: 'id,name,status,owner,priority,iteration_id,release_id,creator,created,modified,begin,due,label,description',
		url: (ws, id) => `https://www.tapd.cn/${ws}/prong/stories/view/${id}`,
	},
};

/**
 * 状态分组（由 `workflows/status_map` 实测确定，2026-10-25）。
 * `open` 不在表里：= 全部状态码 − done（随 status_map 动态算）。
 */
export const STATUS_GROUPS = {
	bug: {
		todo: ['new', 'in_progress', 'reopened'],                // 新建 / 修复中 / 重新打开 —— 开发要处理的
		regress: ['resolved', 'status_6', 'status_8', 'rejected'], // 已修复 / 分支验证完成 / 分支待回归 / 主干待回归 —— 等回归
		suspended: ['suspended'],
		done: ['closed', 'verified', 'status_9', 'status_1'],     // 已完成 / 验收完成 / 主干验收完成 / 无效关闭
	},
	story: {
		suspended: ['workflow_suspended'],
		done: ['resolved', 'rejected', 'status_9', 'status_25', 'workflow_end'], // 已实现 / 关闭 / 已完成 / 无效关闭 / 流程终止
	},
};

const PRIORITY_LABEL = { urgent: '紧急', high: '高', medium: '中', middle: '中', low: '低', insignificant: '无关紧要' };
const SEVERITY_LABEL = { fatal: '致命', serious: '严重', normal: '一般', prompt: '提示', advice: '建议' };

export class CliError extends Error {}

// ── 参数解析 ─────────────────────────────────────────────────────────────
/** 纯开关：后面跟的东西**不**当值吞掉（否则 `get bug --full 123` 会把单号吃成 full 的值）。 */
const BOOL_FLAGS = new Set(['json', 'links', 'full']);
/** 可选数字值：后面是数字才当值，否则视为开关（`--comments` / `--comments 5`）。 */
const OPTIONAL_NUMBER_FLAGS = new Set(['comments']);

export function parseArgs(argv) {
	const pos = [];
	const opt = { param: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = String(argv[i]);
		if (!a.startsWith('--')) { pos.push(a); continue; }
		const eq = a.indexOf('=');
		let key;
		let val;
		if (eq > 2) {
			key = a.slice(2, eq);
			val = a.slice(eq + 1);
		} else {
			key = a.slice(2);
			const next = argv[i + 1];
			const takes = next !== undefined && !String(next).startsWith('--')
				&& !BOOL_FLAGS.has(key)
				&& (!OPTIONAL_NUMBER_FLAGS.has(key) || /^\d+$/.test(String(next)));
			if (takes) { val = String(next); i++; } else { val = true; }
		}
		if (key === 'param') { opt.param.push(String(val)); } else { opt[key] = val; }
	}
	return { pos, opt };
}

// ── HTTP ─────────────────────────────────────────────────────────────────
export function createClient({ base, workspace, fetchImpl, timeoutMs = TIMEOUT_MS }) {
	async function request(pathname, params = {}, { tapd = true } = {}) {
		const qs = new URLSearchParams();
		if (tapd) { qs.set('workspace_id', workspace); }
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null && v !== '') { qs.set(k, String(v)); }
		}
		const query = qs.toString();
		const url = `${base}${pathname}${query ? '?' + query : ''}`;
		const shown = `GET ${pathname}${query ? '?' + safeDecode(query.replace(/\+/g, ' ')) : ''}`;
		let res;
		try {
			res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
		} catch (e) {
			throw new CliError(`请求失败（网络或超时 ${timeoutMs}ms）：${e?.message ?? e}\n  ${shown}`);
		}
		const text = await res.text();
		if (!res.ok) { throw new CliError(`HTTP ${res.status}：${text.slice(0, 300)}\n  ${shown}`); }
		let json;
		try { json = JSON.parse(text); } catch { throw new CliError(`返回的不是 JSON：${text.slice(0, 200)}\n  ${shown}`); }
		if (tapd) {
			if (typeof json?.data === 'string' && /Hello world from TAPD API/i.test(json.data)) {
				throw new CliError(`接口不存在：${pathname}（TAPD 对未知路径返回 "Hello world"，不是数据）`);
			}
			if (json?.status !== 1) { throw new CliError(`TAPD 返回失败：${text.slice(0, 300)}\n  ${shown}`); }
		}
		return { json, shown, bytes: text.length };
	}
	return { request };
}

function safeDecode(s) {
	try { return decodeURIComponent(s); } catch { return s; }
}

// ── 缓存（状态表 / 成员表）────────────────────────────────────────────────
function cacheRead(ctx, name, ttlMs) {
	if (!ctx.cacheDir) { return undefined; }
	try {
		const f = path.join(ctx.cacheDir, `${name}.json`);
		if (Date.now() - fs.statSync(f).mtimeMs < ttlMs) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
	} catch { /* 无缓存 */ }
	return undefined;
}
function cacheWrite(ctx, name, value) {
	if (!ctx.cacheDir) { return; }
	try {
		fs.mkdirSync(ctx.cacheDir, { recursive: true });
		fs.writeFileSync(path.join(ctx.cacheDir, `${name}.json`), JSON.stringify(value), 'utf8');
	} catch { /* 缓存失败不影响结果 */ }
}

export async function statusMap(ctx, kind) {
	const name = `status-${ctx.workspace}-${KINDS[kind].system}`;
	const hit = cacheRead(ctx, name, 6 * 3600e3);
	if (hit) { return hit; }
	const { json } = await ctx.client.request('/api/tapd/workflows/status_map', { system: KINDS[kind].system });
	const map = json?.data && typeof json.data === 'object' ? json.data : {};
	cacheWrite(ctx, name, map);
	return map;
}

async function membersOf(ctx) {
	const name = `members-${ctx.workspace}`;
	const hit = cacheRead(ctx, name, 12 * 3600e3);
	if (hit) { return hit; }
	const { json } = await ctx.client.request('/api/tapd/members', {}, { tapd: false });
	const byUser = new Map();
	for (const g of Array.isArray(json?.groups) ? json.groups : []) {
		for (const m of Array.isArray(g?.members) ? g.members : []) {
			if (!m?.user) { continue; }
			const cur = byUser.get(m.user) ?? {
				user: m.user, alias: m.wecomAlias || '', position: m.wecomPosition || '',
				dept: m.feishuDept || (m.wecomDepartments || [])[0] || '', groups: [], active: m.active !== false,
			};
			if (g.name && !cur.groups.includes(g.name)) { cur.groups.push(g.name); }
			byUser.set(m.user, cur);
		}
	}
	const list = [...byUser.values()];
	cacheWrite(ctx, name, list);
	return list;
}

// ── 筛选条件 ─────────────────────────────────────────────────────────────
export function resolveStatus(kind, value, map) {
	const groups = STATUS_GROUPS[kind];
	const done = new Set(groups.done);
	const tokens = String(value).split(/[,|，、]/).map(s => s.trim()).filter(Boolean);
	const out = [];
	for (const t of tokens) {
		const low = t.toLowerCase();
		if (low === 'open' || (low === 'todo' && !groups.todo)) {
			out.push(...Object.keys(map).filter(c => !done.has(c)));
			continue;
		}
		if (groups[low]) { out.push(...groups[low]); continue; }
		if (Object.prototype.hasOwnProperty.call(map, t)) { out.push(t); continue; }
		const byLabel = Object.keys(map).filter(c => map[c] === t);
		if (byLabel.length) { out.push(...byLabel); continue; }
		const aliases = ['open', ...Object.keys(groups)].join(' / ');
		const codes = Object.entries(map).map(([c, l]) => `${c}=${l}`).join('、');
		throw new CliError(`不认识的状态「${t}」。可用分组：${aliases}；或状态码 / 中文名：${codes}`);
	}
	return [...new Set(out)];
}

export function resolveOwner(value, me) {
	let v = String(value).trim();
	if (v === 'me' || v === '我') {
		if (!me) {
			throw new CliError('还没设置「我」是谁。先问用户的企微账号（如 zijianqiu）或 TAPD 中文名，然后：\n'
				+ '  node studio.mjs me --alias <企微账号>    或    node studio.mjs me --set <TAPD 中文名>');
		}
		v = me;
	}
	return v.replace(/[;；]+$/, '');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function buildParams(ctx, kind, opt) {
	const K = KINDS[kind];
	const p = {};
	if (opt.owner && opt.owner !== true) { p[K.owner] = resolveOwner(opt.owner, ctx.me); }
	if (opt.status && opt.status !== true) { p.status = resolveStatus(kind, opt.status, await statusMap(ctx, kind)).join('|'); }
	for (const k of ['since', 'until']) {
		if (opt[k] !== undefined && !DATE_RE.test(String(opt[k]))) { throw new CliError(`--${k} 需要 YYYY-MM-DD，收到：${opt[k]}`); }
	}
	if (opt.since || opt.until) { p.created = `${opt.since || '2000-01-01'}~${opt.until || '2099-12-31'}`; }
	if (opt.q && opt.q !== true) { p[K.title] = `%${opt.q}%`; }
	for (const k of ['severity', 'priority', 'module', 'reporter', 'creator', 'label']) {
		if (opt[k] && opt[k] !== true) { p[k] = String(opt[k]); }
	}
	if (opt.release && opt.release !== true) { p.release_id = String(opt.release); }
	if (opt.iteration && opt.iteration !== true) { p.iteration_id = String(opt.iteration); }
	for (const kv of opt.param ?? []) {
		const i = kv.indexOf('=');
		if (i <= 0) { throw new CliError(`--param 需要 key=value，收到：${kv}`); }
		p[kv.slice(0, i)] = kv.slice(i + 1);
	}
	// 防呆：字段名用错时服务端**静默忽略**，返回全项目数据 —— 宁可报错
	if (kind === 'bug' && p.owner !== undefined) { throw new CliError('缺陷的负责人字段是 current_owner，不是 owner（owner 会被静默忽略并返回全项目数据）——请用 --owner'); }
	if (kind === 'story' && p.current_owner !== undefined) { throw new CliError('需求的负责人字段是 owner，不是 current_owner——请用 --owner'); }
	if (p.offset !== undefined) { throw new CliError('不要用 offset：服务端会忽略它并永远返回第 1 页（脚本内部已用 page 翻页）'); }
	return p;
}

// ── 取数 ─────────────────────────────────────────────────────────────────
async function countOf(ctx, kind, params) {
	const { json, shown } = await ctx.client.request(`/api/tapd/${KINDS[kind].api}/count`, params);
	const n = Number(json?.data?.count);
	if (!Number.isFinite(n)) { throw new CliError(`计数接口返回异常：${JSON.stringify(json).slice(0, 200)}`); }
	return { count: n, shown };
}

export async function fetchRows(ctx, kind, params, { max, fields, order }) {
	const K = KINDS[kind];
	const size = Math.max(1, Math.min(PAGE_SIZE, max));
	const seen = new Map();
	let shown = '';
	let pages = 0;
	for (let page = 1; page <= MAX_PAGES && seen.size < max; page++) {
		const res = await ctx.client.request(`/api/tapd/${K.api}`, { ...params, order, fields, limit: size, page });
		if (page === 1) { shown = res.shown; }
		pages = page;
		const data = Array.isArray(res.json?.data) ? res.json.data : [];
		let fresh = 0;
		for (const item of data) {
			const row = item?.[K.key] ?? item;
			if (row?.id && !seen.has(row.id)) { seen.set(row.id, row); fresh++; }
		}
		if (data.length < size || fresh === 0) { break; }
	}
	return { rows: [...seen.values()].slice(0, max), pages, shown };
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

// ── 展示 ─────────────────────────────────────────────────────────────────
const ownerText = v => String(v ?? '').split(/[;；]/).map(s => s.trim()).filter(Boolean).join('、') || '—';
const priorityText = v => PRIORITY_LABEL[String(v ?? '').toLowerCase()] ?? (v || '—');
const severityText = v => SEVERITY_LABEL[String(v ?? '').toLowerCase()] ?? (v || '—');
const cell = (v, n = 0) => {
	let s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '｜').trim();
	if (n && s.length > n) { s = s.slice(0, n - 1) + '…'; }
	return s || '—';
};
const shortTime = v => (v ? String(v).slice(5, 16) : '—');

function htmlToText(html) {
	return String(html ?? '')
		.replace(/<img[^>]*>/gi, '[图片]')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
		.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
		.trim();
}

const stamp = () => {
	const d = new Date();
	const z = n => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};
const provenance = (ctx, shown, extra = '') => ctx.out(`\n> 口径：\`${shown}\`${extra ? ' · ' + extra : ''} · 数据时间 ${stamp()}`);

function needKind(pos) {
	const kind = String(pos ?? '').toLowerCase();
	const norm = { bug: 'bug', bugs: 'bug', 缺陷: 'bug', story: 'story', stories: 'story', 需求: 'story' }[kind];
	if (!norm) { throw new CliError(`第一个参数要写 bug 或 story，收到：${pos ?? '(空)'}`); }
	return norm;
}

function priorityHint(ctx, kind, opt) {
	if (kind === 'bug' && opt.priority && opt.priority !== true) {
		ctx.out('> 注：缺陷优先级有中英两套值（自动化单用 high/medium，手工单用 高/中），--priority 只匹配你给的那一个值。');
	}
}

// ── 命令 ─────────────────────────────────────────────────────────────────
async function cmdPing(ctx) {
	const { json, shown } = await ctx.client.request('/api/version', {}, { tapd: false });
	ctx.out(`平台在线：commit ${json?.runningCommit ?? '?'} · 更新于 ${json?.updatedAt ?? '?'} · pid ${json?.pid ?? '?'}`);
	provenance(ctx, shown);
}

async function cmdMe(ctx, opt) {
	if (opt.set || opt.alias) {
		const members = await membersOf(ctx);
		let name;
		if (opt.alias && opt.alias !== true) {
			const a = String(opt.alias).toLowerCase();
			const hit = members.find(m => m.alias.toLowerCase() === a);
			if (!hit) { throw new CliError(`成员表里没有企微账号「${opt.alias}」。可以用 who <关键字> 找人，再 me --set <中文名>`); }
			name = hit.user;
		} else {
			name = String(opt.set).trim().replace(/[;；]+$/, '');
			if (!members.some(m => m.user === name)) { ctx.out(`> 注意：成员表里没找到「${name}」，仍按你给的写入（拼写请再确认）。`); }
		}
		const m = members.find(x => x.user === name);
		fs.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
		fs.writeFileSync(ctx.configPath, JSON.stringify({ me: name, alias: m?.alias || '', updatedAt: new Date().toISOString() }, null, 2), 'utf8');
		ctx.out(`已记住「我」= ${name}${m ? `（企微 ${m.alias || '—'} · ${m.dept || m.position || ''}）` : ''}`);
		ctx.out(`配置：${ctx.configPath}`);
		return;
	}
	if (!ctx.me) {
		ctx.out('还没设置「我」。问用户的企微账号或 TAPD 中文名，然后：node studio.mjs me --alias <企微账号>  /  me --set <中文名>');
		return;
	}
	ctx.out(`「我」= ${ctx.me}${ctx.meSource ? `（来源：${ctx.meSource}）` : ''}`);
}

async function cmdWho(ctx, pos) {
	const kw = pos.join(' ').trim().toLowerCase();
	if (!kw) { throw new CliError('用法：who <关键字>（中文名 / 企微账号 / 部门 / 职位都能搜）'); }
	const members = await membersOf(ctx);
	const hits = members.filter(m => [m.user, m.alias, m.position, m.dept, ...m.groups].some(v => String(v).toLowerCase().includes(kw)));
	ctx.out(`成员表匹配「${kw}」：${hits.length} 人${hits.length > 30 ? '（只列前 30）' : ''}`);
	if (!hits.length) { return; }
	ctx.out('| TAPD 名 | 企微账号 | 职位 | 部门 | 用户组 |');
	ctx.out('|---|---|---|---|---|');
	for (const m of hits.slice(0, 30)) {
		ctx.out(`| ${cell(m.user)} | ${cell(m.alias)} | ${cell(m.position)} | ${cell(m.dept, 40)} | ${cell(m.groups.join('、'), 40)} |`);
	}
}

async function cmdStatuses(ctx, kind) {
	const map = await statusMap(ctx, kind);
	const groups = STATUS_GROUPS[kind];
	const groupOf = c => Object.keys(groups).find(g => groups[g].includes(c)) ?? (groups.done.includes(c) ? 'done' : 'open');
	ctx.out(`${KINDS[kind].label}状态码（${Object.keys(map).length} 个）：`);
	ctx.out('| 状态码 | 中文 | 分组 |');
	ctx.out('|---|---|---|');
	for (const [c, l] of Object.entries(map)) { ctx.out(`| ${c} | ${l} | ${groupOf(c)} |`); }
	ctx.out(`\n分组可直接用于 --status：open（= 全部 − done）、${Object.keys(groups).join('、')}`);
}

async function cmdCount(ctx, kind, opt) {
	const params = await buildParams(ctx, kind, opt);
	const { count, shown } = await countOf(ctx, kind, params);
	if (opt.json) { ctx.out(JSON.stringify({ kind, count, query: shown })); return; }
	ctx.out(`${KINDS[kind].label}数：${count}`);
	priorityHint(ctx, kind, opt);
	provenance(ctx, shown);
}

async function cmdList(ctx, kind, opt) {
	const K = KINDS[kind];
	const limit = Math.max(1, Math.min(Number(opt.limit) || 50, 20000));
	const params = await buildParams(ctx, kind, opt);
	const { count: total } = await countOf(ctx, kind, params);
	const order = opt.order && opt.order !== true ? String(opt.order) : 'created desc';
	const fields = opt.fields && opt.fields !== true ? String(opt.fields) : K.listFields;
	const { rows, pages, shown } = await fetchRows(ctx, kind, params, { max: limit, fields, order });
	const map = await statusMap(ctx, kind);

	if (opt.out && opt.out !== true) {
		fs.writeFileSync(String(opt.out), JSON.stringify(rows, null, 2), 'utf8');
		ctx.out(`已写入 ${rows.length} 条到 ${opt.out}（服务端共 ${total} 条）`);
	}
	if (opt.json) { ctx.out(JSON.stringify({ kind, total, rows })); return; }

	const show = Math.min(rows.length, Math.max(1, Math.min(Number(opt.show) || 200, 500)));
	ctx.out(`${K.label}：服务端共 ${total} 条，取回 ${rows.length} 条（${pages} 页，按 ${order}）${show < rows.length ? `，下表列前 ${show} 条` : ''}`);
	priorityHint(ctx, kind, opt);
	if (!rows.length) { provenance(ctx, shown); return; }
	const links = !!opt.links;
	const head = kind === 'bug'
		? ['#', '单号', '创建', '状态', '优先级', '严重度', '负责人', '标题']
		: ['#', '单号', '创建', '状态', '优先级', '负责人', '标题'];
	if (links) { head.push('链接'); }
	ctx.out(`| ${head.join(' | ')} |`);
	ctx.out(`|${head.map(() => '---').join('|')}|`);
	rows.slice(0, show).forEach((r, i) => {
		const cols = kind === 'bug'
			? [i + 1, r.id, shortTime(r.created), map[r.status] ?? r.status, priorityText(r.priority), severityText(r.severity), cell(ownerText(r.current_owner), 24), cell(r.title, 60)]
			: [i + 1, r.id, shortTime(r.created), map[r.status] ?? r.status, priorityText(r.priority), cell(ownerText(r.owner), 24), cell(r.name, 60)];
		if (links) { cols.push(K.url(ctx.workspace, r.id)); }
		ctx.out(`| ${cols.join(' | ')} |`);
	});
	provenance(ctx, shown, `翻页参数 page=1..${pages}`);
}

const DIMENSIONS = {
	status: null, // 走计数接口（精确），见下
	owner: { bug: 'current_owner', story: 'owner' },
	priority: 'priority', severity: 'severity', module: 'module',
	reporter: { bug: 'reporter', story: 'creator' }, creator: { bug: 'reporter', story: 'creator' },
	day: 'created', month: 'created', release: 'release_id', iteration: 'iteration_id',
};

async function cmdStats(ctx, kind, opt) {
	const by = String(opt.by && opt.by !== true ? opt.by : 'status').toLowerCase();
	if (!(by in DIMENSIONS)) { throw new CliError(`--by 只支持：${Object.keys(DIMENSIONS).join(' / ')}`); }
	const params = await buildParams(ctx, kind, opt);
	const { count: total, shown } = await countOf(ctx, kind, params);
	const top = Math.max(1, Math.min(Number(opt.top) || 20, 200));
	const K = KINDS[kind];

	if (by === 'status') {
		const map = await statusMap(ctx, kind);
		const codes = params.status ? params.status.split('|') : Object.keys(map);
		const counts = await mapLimit(codes, 6, async c => [c, (await countOf(ctx, kind, { ...params, status: c })).count]);
		const nonzero = counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
		const sum = nonzero.reduce((s, [, n]) => s + n, 0);
		if (opt.json) { ctx.out(JSON.stringify({ kind, by, total, items: nonzero.map(([c, n]) => ({ code: c, label: map[c] ?? c, count: n })) })); return; }
		ctx.out(`${K.label}按状态（服务端精确计数）：共 ${total} 条`);
		ctx.out('| 状态 | 状态码 | 数量 | 占比 |');
		ctx.out('|---|---|---|---|');
		for (const [c, n] of nonzero) { ctx.out(`| ${map[c] ?? c} | ${c} | ${n} | ${total ? (n * 100 / total).toFixed(1) : '0'}% |`); }
		if (!params.status && sum !== total) { ctx.out(`> 注：各状态合计 ${sum} ≠ 总数 ${total}，差额是 status_map 之外的状态。`); }
		provenance(ctx, shown, `按状态逐个调 /count（${codes.length} 次）`);
		return;
	}

	const dimField = typeof DIMENSIONS[by] === 'string' ? DIMENSIONS[by] : DIMENSIONS[by][kind];
	const max = Math.max(1, Math.min(Number(opt.max) || 3000, 20000));
	const { rows, pages } = await fetchRows(ctx, kind, params, { max, fields: `id,created,${dimField}`, order: 'created desc' });
	const tally = new Map();
	const add = k => tally.set(k, (tally.get(k) ?? 0) + 1);
	for (const r of rows) {
		const v = r[dimField];
		if (by === 'owner') {
			const names = String(v ?? '').split(/[;；]/).map(s => s.trim()).filter(Boolean);
			if (!names.length) { add('（未指派）'); }
			names.forEach(add);
		} else if (by === 'day') { add(String(v ?? '').slice(0, 10) || '（空）'); }
		else if (by === 'month') { add(String(v ?? '').slice(0, 7) || '（空）'); }
		else if (by === 'priority') { add(priorityText(v)); }
		else if (by === 'severity') { add(severityText(v)); }
		else { add(v ? String(v) : '（空）'); }
	}
	let items = [...tally.entries()];
	items.sort(by === 'day' || by === 'month' ? (a, b) => (a[0] < b[0] ? 1 : -1) : (a, b) => b[1] - a[1]);
	items = items.slice(0, top);
	if (opt.json) { ctx.out(JSON.stringify({ kind, by, total, sampled: rows.length, items: items.map(([k, n]) => ({ key: k, count: n })) })); return; }
	ctx.out(`${K.label}按 ${by} 聚合：样本 ${rows.length} / 服务端总数 ${total}（取最新的，${pages} 页）`);
	if (rows.length < total) { ctx.out(`> ⚠ 只聚合了最新 ${rows.length} 条；要全量请收窄筛选（--since / --owner / --status）或调大 --max（上限 20000）。`); }
	if (by === 'owner') { ctx.out('> 注：一单多负责人时每人各计 1 次，合计可能大于样本数。'); }
	ctx.out(`| ${by} | 数量 | 占样本 |`);
	ctx.out('|---|---|---|');
	for (const [k, n] of items) { ctx.out(`| ${cell(k, 40)} | ${n} | ${rows.length ? (n * 100 / rows.length).toFixed(1) : '0'}% |`); }
	provenance(ctx, shown);
}

async function cmdGet(ctx, kind, id, opt) {
	const K = KINDS[kind];
	if (!/^\d{6,}$/.test(String(id ?? ''))) { throw new CliError(`用法：get ${kind} <单号>（纯数字，如 1168880148001266165）`); }
	const { json, shown } = await ctx.client.request(`/api/tapd/${K.api}`, { id, fields: K.detailFields });
	const row = Array.isArray(json?.data) ? (json.data[0]?.[K.key] ?? json.data[0]) : undefined;
	if (!row) { throw new CliError(`没有找到${K.label} ${id}`); }
	const map = await statusMap(ctx, kind);
	const title = kind === 'bug' ? row.title : row.name;
	const owner = kind === 'bug' ? row.current_owner : row.owner;
	ctx.out(`## ${title}`);
	ctx.out(`- 单号：${row.id} · ${K.url(ctx.workspace, row.id)}`);
	ctx.out(`- 状态：${map[row.status] ?? row.status}（${row.status}）`);
	ctx.out(`- 负责人：${ownerText(owner)}`);
	ctx.out(`- 优先级：${priorityText(row.priority)}${kind === 'bug' ? ` · 严重度：${severityText(row.severity)}` : ''}`);
	if (kind === 'bug') {
		ctx.out(`- 模块：${row.module || '—'} · 报告人：${row.reporter || '—'} · 开发：${ownerText(row.de)} · 测试：${ownerText(row.te)}`);
		ctx.out(`- 发现版本：${row.version_report || '—'} · 发布计划：${row.release_id || '—'}`);
	} else {
		ctx.out(`- 创建人：${row.creator || '—'} · 迭代：${row.iteration_id || '—'} · 发布计划：${row.release_id || '—'} · 标签：${row.label || '—'}`);
		ctx.out(`- 计划：${row.begin || '—'} ~ ${row.due || '—'}`);
	}
	ctx.out(`- 创建：${row.created || '—'} · 修改：${row.modified || '—'}`);
	const desc = htmlToText(row.description);
	const limit = opt.full ? Infinity : 1500;
	ctx.out(`\n### 描述\n${desc ? (desc.length > limit ? desc.slice(0, limit) + `\n…（共 ${desc.length} 字，--full 看全文）` : desc) : '（空）'}`);
	if (opt.comments) {
		const n = opt.comments === true ? 10 : Math.max(1, Math.min(Number(opt.comments) || 10, 50));
		const { json: cj } = await ctx.client.request('/api/tapd/comments', { entry_type: K.comment, entry_id: id, order: 'created desc', limit: n });
		const list = Array.isArray(cj?.data) ? cj.data.map(x => x?.Comment ?? x) : [];
		ctx.out(`\n### 评论（最新 ${list.length} 条）`);
		if (!list.length) { ctx.out('（无）'); }
		for (const c of list) { ctx.out(`- ${c.created || '—'} · ${c.author || '—'}：${cell(htmlToText(c.description), 300)}`); }
	}
	provenance(ctx, shown);
}

function cmdUrl(ctx, kind, ids) {
	if (!ids.length) { throw new CliError(`用法：url ${kind} <单号> [单号…]`); }
	for (const id of ids) { ctx.out(`${id}  ${KINDS[kind].url(ctx.workspace, id)}`); }
}

const HELP = `萨罗斯管理平台只读查询（TAPD workspace 由 SAROASIS_WORKSPACE 指定，默认 ${WORKSPACE_DEFAULT}）

  ping                                平台是否在线 + 当前部署版本
  me [--alias 企微账号 | --set 中文名]  查看 / 设置「我」（--owner me 用它）
  who <关键字>                        在成员表里找人（中文名 / 企微账号 / 部门 / 职位）
  statuses bug|story                  状态码 ↔ 中文 ↔ 分组
  count bug|story [筛选]              服务端计数（秒回，统计首选）
  stats bug|story --by <维度> [筛选]   聚合：status（精确）/ owner / priority / severity / module / reporter / day / month / release
  list  bug|story [筛选] [--limit 50] [--links] [--order "modified desc"] [--out 文件.json] [--json]
  get   bug|story <单号> [--comments [N]] [--full]
  url   bug|story <单号…>              TAPD 链接

筛选：
  --owner <中文名|me>     缺陷自动用 current_owner，需求用 owner（模糊匹配，多负责人也能命中）
  --status <分组|码|中文>  分组：open / todo / regress / suspended / done；可逗号多选，如 --status todo,挂起
  --since / --until YYYY-MM-DD   按创建时间（含首尾两天）
  --q <关键字>            标题模糊匹配
  --severity / --priority / --module / --reporter / --release / --iteration
  --param key=value       其它 TAPD 字段原样透传（可重复）

示例：
  node studio.mjs count bug --owner me --status todo
  node studio.mjs list bug --owner me --status todo --links
  node studio.mjs stats bug --by owner --since 2026-10-20 --status todo --top 15
  node studio.mjs get bug 1168880148001266165 --comments 5`;

// ── 入口 ─────────────────────────────────────────────────────────────────
function loadMe(configPath, env) {
	if (env.SAROASIS_ME) { return { me: String(env.SAROASIS_ME).trim(), meSource: '环境变量 SAROASIS_ME' }; }
	try {
		const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		if (cfg?.me) { return { me: String(cfg.me), meSource: configPath }; }
	} catch { /* 未设置 */ }
	return { me: '', meSource: '' };
}

export async function run(argv, deps = {}) {
	const env = deps.env ?? process.env;
	const lines = [];
	let bytes = 0;
	let capped = false;
	const write = deps.write ?? (s => process.stdout.write(s));
	const out = (s = '') => {
		if (capped) { return; }
		const text = String(s) + '\n';
		bytes += Buffer.byteLength(text);
		if (bytes > OUTPUT_CAP) {
			capped = true;
			write('…（输出超过上限已截断：请加筛选、调小 --limit，或用 --out 写文件）\n');
			return;
		}
		lines.push(text);
		write(text);
	};
	const configPath = deps.configPath ?? path.join(os.homedir(), '.vssaros', 'saroasis-studio.json');
	const workspace = String(env.SAROASIS_WORKSPACE || WORKSPACE_DEFAULT);
	const ctx = {
		out, configPath, workspace,
		cacheDir: deps.noCache ? '' : (deps.cacheDir ?? path.join(os.tmpdir(), 'saroasis-studio-cache')),
		client: createClient({
			base: String(env.SAROASIS_BASE || BASE_DEFAULT).replace(/\/+$/, ''),
			workspace,
			fetchImpl: deps.fetch ?? globalThis.fetch,
		}),
		...loadMe(configPath, env),
	};
	const { pos, opt } = parseArgs(argv);
	const cmd = String(pos[0] ?? 'help').toLowerCase();
	try {
		switch (cmd) {
			case 'ping': await cmdPing(ctx); break;
			case 'me': await cmdMe(ctx, opt); break;
			case 'who': await cmdWho(ctx, pos.slice(1)); break;
			case 'statuses': case 'status': await cmdStatuses(ctx, needKind(pos[1])); break;
			case 'count': await cmdCount(ctx, needKind(pos[1]), opt); break;
			case 'list': await cmdList(ctx, needKind(pos[1]), opt); break;
			case 'stats': await cmdStats(ctx, needKind(pos[1]), opt); break;
			case 'get': await cmdGet(ctx, needKind(pos[1]), pos[2], opt); break;
			case 'url': cmdUrl(ctx, needKind(pos[1]), pos.slice(2)); break;
			case 'help': case '-h': case '--help': out(HELP); break;
			default: throw new CliError(`不认识的命令「${cmd}」\n\n${HELP}`);
		}
		return 0;
	} catch (e) {
		if (e instanceof CliError) { out(`✗ ${e.message}`); return 1; }
		out(`✗ 未预期的错误：${e?.stack ?? e}`);
		return 2;
	}
}

const invokedDirectly = (() => {
	try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase(); } catch { return false; }
})();
if (invokedDirectly) {
	// 调用方用 `| Select-Object -First N` 截断管道时会 EPIPE —— 那是"读够了"，不是错误，安静退出
	process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') { process.exit(0); } throw e; });
	process.exitCode = await run(process.argv.slice(2));
}
