#!/usr/bin/env node
/**
 * VsSaros addition: the TAPD Open API CLI shipped with `tapd-skill`.
 *
 * It replaces mcporter-internal entirely: no MCP service, no per-user login. Credentials
 * come from `tapd-client.mjs` (a shipped API account, overridable by file/env), and every
 * operation is a plain GET/POST to https://api.tapd.cn. Zero dependencies, Node 18+.
 *
 * Output is always one JSON object, so an agent can parse it without scraping a table.
 * Secrets never appear in the output.
 */
import { createTapdClient, TAPD_API_BASE, TAPD_WORKSPACE_DEFAULT } from './tapd-client.mjs';

const KINDS = {
	story: { api: 'stories', key: 'Story', title: 'name', comment: 'stories' },
	bug: { api: 'bugs', key: 'Bug', title: 'title', comment: 'bug' },
	task: { api: 'tasks', key: 'Task', title: 'name', comment: 'tasks' },
};
/** Writable fields: a guard against inventing TAPD field names (which TAPD silently ignores). */
const WRITABLE = new Set([
	'name', 'title', 'description', 'owner', 'current_owner', 'priority', 'priority_label', 'severity',
	'status', 'module', 'release_id', 'iteration_id', 'begin', 'due', 'effort', 'label', 'parent_id',
	'developer', 'creator', 'reporter', 'category_id', 'workitem_type_id', 'story_id',
]);

const HELP = `TAPD Open API CLI（随包凭据，零依赖）

  node "<skillDir>/scripts/tapd-api.mjs" <命令> [参数]

  status                                   验证凭据与连通性（/quickstart/testauth）
  list   <story|bug|task> [--limit 30] [--page 1] [--field k=v ...]   列表
  get    <story|bug|task> <单号> [--comments N]                         详情 + 评论
  count  <story|bug|task> [--field k=v ...]                            服务端精确计数
  create <story|bug|task> --name <标题> [--field k=v ...]               创建
  update <story|bug|task> <单号> --field k=v [--field k=v ...]          更新
  comment <story|bug|task> <单号> --description <HTML 文本> [--author 署名]
  statuses <bug|story>                      状态码 ↔ 中文
  iterations [筛选]                         迭代列表
  fields <story|bug|task>                   字段配置
  raw <GET|POST> <路径> [k=v ...]           任意 Open API 路径（删除等非常用操作走这里）

通用参数：--workspace <ID>（默认 68880148）· --base <URL>（默认 https://api.tapd.cn）
          --pretty（缩进输出）· --confirm（高危操作必须显式带上）

示例：
  status
  list bug --field current_owner=邱子鉴 --limit 10
  get bug 1168880148001266165 --comments 5
  create story --name "新需求" --field owner=邱子鉴
  update bug 1168880148001266165 --field status=resolved
  raw POST /bugs/delete id=1168880148001266165 --confirm

凭据：随包内置 TAPD_CLIENT_ID/TAPD_CLIENT_SECRET（无需登录）；环境变量或
<DSH_HOME>/tapd.env 中的同名键可覆盖；DSH_SUPERAGENT_TAPD_BUNDLED=off 可停用随包账号。`;

function parse(argv) {
	const pos = [];
	const opt = {};
	for (let i = 0; i < argv.length; i++) {
		const a = String(argv[i]);
		if (!a.startsWith('--')) { pos.push(a); continue; }
		const raw = a.slice(2);
		const eq = raw.indexOf('=');
		const name = eq > 0 ? raw.slice(0, eq) : raw;
		const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
		const next = argv[i + 1];
		const value = inline !== undefined ? inline
			: (next !== undefined && !String(next).startsWith('--') ? argv[++i] : true);
		if (name === 'field' || name === 'param') { (opt[name] ??= []).push(String(value)); }
		else { opt[name] = value; }
	}
	return { pos, opt };
}

const kindOf = (value) => {
	const kind = String(value ?? '').toLowerCase();
	const norm = { story: 'story', stories: 'story', 需求: 'story', bug: 'bug', bugs: 'bug', 缺陷: 'bug', task: 'task', tasks: 'task', 任务: 'task' }[kind];
	if (!norm) { throw new Error(`第一个参数要写 story / bug / task，收到：${value ?? '(空)'}`); }
	return norm;
};

function fieldsOf(opt, { writable = false } = {}) {
	const out = {};
	for (const kv of [...(opt.field ?? []), ...(opt.param ?? [])]) {
		const i = kv.indexOf('=');
		if (i <= 0) { throw new Error(`--field 需要 key=value，收到：${kv}`); }
		const key = kv.slice(0, i);
		if (writable && !WRITABLE.has(key)) { throw new Error(`不允许写字段「${key}」；可用：${[...WRITABLE].join('、')}`); }
		out[key] = kv.slice(i + 1);
	}
	if (out.offset !== undefined) { throw new Error('不要用 offset：TAPD 会忽略它并永远返回第 1 页，请用 --field page=N'); }
	return out;
}

const records = (json, key) => (Array.isArray(json?.data) ? json.data : []).map(row => row?.[key] ?? row);

async function main(argv) {
	const { pos, opt } = parse(argv);
	const cmd = String(pos[0] ?? 'help').toLowerCase();
	if (cmd === 'help' || cmd === '-h' || cmd === '--help') { return { ok: true, help: HELP }; }
	const env = { ...process.env };
	const base = String(opt.base ?? env.TAPD_API_BASE ?? TAPD_API_BASE);
	const workspace = String(opt.workspace ?? env.TAPD_WORKSPACE_ID ?? env.SAROASIS_WORKSPACE ?? TAPD_WORKSPACE_DEFAULT);
	const { request, auth } = createTapdClient({ base, workspace, env });
	let data;
	let shown;
	let count;

	switch (cmd) {
		case 'status': {
			const r = await request('GET', '/quickstart/testauth', {});
			data = r.json.data; shown = r.shown; break;
		}
		case 'list': case 'get': case 'count': {
			const kind = kindOf(pos[1]);
			const K = KINDS[kind];
			const params = fieldsOf(opt);
			if (cmd === 'count') {
				const r = await request('GET', `/${K.api}/count`, params);
				data = r.json.data; count = Number(data?.count); shown = r.shown; break;
			}
			if (cmd === 'get') {
				const id = String(pos[2] ?? '');
				if (!/^\d{6,}$/.test(id)) { throw new Error(`用法：get ${kind} <单号>（纯数字长 ID）`); }
				const r = await request('GET', `/${K.api}`, { ...params, id });
				const rows = records(r.json, K.key);
				if (!rows.length) { throw new Error(`没有找到${kind} ${id}`); }
				data = rows[0]; shown = r.shown;
				if (opt.comments) {
					const n = opt.comments === true ? 10 : Math.max(1, Math.min(Number(opt.comments) || 10, 50));
					const c = await request('GET', '/comments', { entry_type: K.comment, entry_id: id, limit: n, order: 'created desc' });
					data.comments = records(c.json, 'Comment');
				}
				break;
			}
			const r = await request('GET', `/${K.api}`, { ...params, limit: Number(opt.limit) || 30, page: Number(opt.page) || 1 });
			data = records(r.json, K.key); count = data.length; shown = r.shown; break;
		}
		case 'create': case 'update': {
			const kind = kindOf(pos[1]);
			const K = KINDS[kind];
			const params = fieldsOf(opt, { writable: true });
			if (cmd === 'update') {
				const id = String(pos[2] ?? '');
				if (!/^\d{6,}$/.test(id)) { throw new Error(`用法：update ${kind} <单号> --field k=v`); }
				params.id = id;
			} else {
				const title = opt.name ?? opt.title;
				if (title === undefined || title === true) { throw new Error(`创建${kind}需要 --name <标题>（或 --field ${K.title}=<标题>）`); }
				params[K.title] = String(title);
			}
			const r = await request('POST', `/${K.api}`, params);
			data = r.json.data; shown = r.shown; break;
		}
		case 'comment': {
			const kind = kindOf(pos[1]);
			const K = KINDS[kind];
			const id = String(pos[2] ?? '');
			if (!/^\d{6,}$/.test(id)) { throw new Error('用法：comment <kind> <单号> --description <文本>'); }
			const description = opt.description;
			if (description === undefined || description === true) { throw new Error('缺少 --description <评论内容>'); }
			const r = await request('POST', '/comments', { entry_type: K.comment, entry_id: id, description: String(description),
				...(opt.author && opt.author !== true ? { author: String(opt.author) } : {}) });
			data = r.json.data; shown = r.shown; break;
		}
		case 'statuses': {
			const r = await request('GET', '/workflows/status_map', { system: kindOf(pos[1]) === 'story' ? 'story' : 'bug' });
			data = r.json.data; shown = r.shown; break;
		}
		case 'iterations': {
			const r = await request('GET', '/iterations', fieldsOf(opt));
			data = records(r.json, 'Iteration'); count = data.length; shown = r.shown; break;
		}
		case 'fields': {
			const K = KINDS[kindOf(pos[1])];
			const r = await request('GET', `/${K.api}/fields_info`, {});
			data = r.json.data; shown = r.shown; break;
		}
		case 'raw': {
			const method = String(pos[1] ?? 'GET').toUpperCase();
			if (!['GET', 'POST'].includes(method)) { throw new Error('raw 只支持 GET / POST'); }
			const pathname = String(pos[2] ?? '');
			if (!pathname.startsWith('/')) { throw new Error('raw 的第二个参数要是 API 路径，如 /stories'); }
			const params = {};
			for (const kv of pos.slice(3)) {
				const i = kv.indexOf('=');
				if (i <= 0) { throw new Error(`raw 的附加参数要写 k=v，收到：${kv}`); }
				params[kv.slice(0, i)] = kv.slice(i + 1);
			}
			Object.assign(params, fieldsOf(opt));
			const dangerous = /(?:^|\/)(delete|remove|batch|bulk)(?:\/|$)/i.test(pathname) || /\/(delete|remove)$/i.test(pathname);
			if ((method === 'POST' || dangerous) && opt.confirm !== true) {
				throw new Error('写操作/删除必须显式带 --confirm，并先向用户展示操作摘要取得同意');
			}
			const r = await request(method, pathname, params);
			data = r.json.data; shown = r.shown; break;
		}
		default: throw new Error(`不认识的命令「${cmd}」。运行 help 看用法。`);
	}
	return { ok: true, command: cmd, credential: auth.method, ...count !== undefined ? { count } : {}, ...shown ? { shown } : {}, data };
}

const invokedDirectly = (() => {
	try { return !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return false; }
})();
if (invokedDirectly || process.argv[1]?.endsWith('tapd-api.mjs')) {
	main(process.argv.slice(2)).then(result => {
		process.stdout.write(`${JSON.stringify(result, null, process.argv.includes('--pretty') ? 2 : 0)}\n`);
	}).catch(error => {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
		process.exitCode = 1;
	});
}

export { main, parse, HELP };
