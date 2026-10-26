// 离线自检：node resources/.agents/skills/saroasis-platform/test/run-studio-check.mjs
// 用假 fetch 钉住 studio.mjs 里固化的"接口坑"（每条断言都是绝对期望值，不是相对比较）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildParams, CliError, createClient, fetchRows, parseArgs, resolveOwner, resolveStatus, run } from '../scripts/studio.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name}${detail ? '  → ' + detail : ''}`); }
};
const throwsCli = async (fn) => { try { await fn(); return ''; } catch (e) { return e instanceof CliError ? e.message : 'NOT-CLI:' + e; } };

const BUG_MAP = { new: '新建', in_progress: '修复中', resolved: '已修复', status_6: '分支验证完成', verified: '验收完成', rejected: '主干待回归', status_9: '主干验收完成', reopened: '重新打开', closed: '已完成', status_1: '无效关闭', suspended: '挂起', status_8: '分支待回归' };

/** 假 TAPD：/bugs 按 page 切 450 条（id 递减），故意让 offset 无效；/count 返回固定值；未知路径回 Hello world */
function fakeFetch(log) {
	// ⚠ id 必须拼字符串：1168880148001000000 超过 2^53，用数字加法会全部撞成同一个值
	const all = Array.from({ length: 450 }, (_, i) => ({ id: '1168880148001' + String(600000 - i), title: 't' + i, status: 'new', current_owner: i % 2 ? '邱子鉴;' : '邱子鉴;蒋小川;', created: '2026-10-2' + (i % 5) + ' 08:00:00' }));
	return async (url) => {
		const u = new URL(url);
		log.push(u.pathname + '?' + u.searchParams.toString());
		const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
		if (u.pathname === '/api/tapd/workflows/status_map') { return json({ status: 1, data: BUG_MAP, info: 'success' }); }
		if (u.pathname === '/api/tapd/bugs/count') { return json({ status: 1, data: { count: u.searchParams.get('status') === 'new' ? 450 : 450 }, info: 'success' }); }
		if (u.pathname === '/api/tapd/bugs') {
			const limit = Number(u.searchParams.get('limit'));
			const page = Number(u.searchParams.get('page') || 1);
			const slice = all.slice((page - 1) * limit, page * limit).map(b => ({ Bug: b }));
			return json({ status: 1, data: slice, info: 'success' });
		}
		if (u.pathname === '/api/tapd/participants') { return json({ status: 1, data: 'Hello world from TAPD API. abc', info: 'Documents…' }); }
		return { ok: false, status: 404, text: async () => 'Not Found' };
	};
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-check-'));
const mkCtx = (log, me = '') => ({ workspace: '68880148', me, cacheDir: '', client: createClient({ base: 'http://fake', workspace: '68880148', fetchImpl: fakeFetch(log) }) });

console.log('── 参数解析 ──');
{
	const a = parseArgs(['get', 'bug', '--full', '123', '--comments']);
	check('布尔开关不吞位置参数', a.pos.join(',') === 'get,bug,123' && a.opt.full === true && a.opt.comments === true, JSON.stringify(a));
	const b = parseArgs(['get', 'bug', '123', '--comments', '5']);
	check('--comments 后跟数字才当值', b.opt.comments === '5' && b.pos[2] === '123', JSON.stringify(b));
	const c = parseArgs(['list', 'bug', '--param', 'a=1', '--param=b=2', '--owner', '邱子鉴']);
	check('--param 可重复 + = 形式', JSON.stringify(c.opt.param) === '["a=1","b=2"]' && c.opt.owner === '邱子鉴', JSON.stringify(c));
}

console.log('── 状态 / 负责人 ──');
{
	check('todo 分组', resolveStatus('bug', 'todo', BUG_MAP).join('|') === 'new|in_progress|reopened');
	check('open = 全部 − done', resolveStatus('bug', 'open', BUG_MAP).join('|') === 'new|in_progress|resolved|status_6|rejected|reopened|suspended|status_8');
	check('中文名 → 码，混写去重', resolveStatus('bug', '新建,new,主干待回归', BUG_MAP).join('|') === 'new|rejected');
	check('不认识的状态 ⇒ 报错且列出可选值', /不认识的状态「待处理」[\s\S]*rejected=主干待回归/.test(await throwsCli(() => resolveStatus('bug', '待处理', BUG_MAP))));
	check('负责人去掉尾部分号（带分号会少查：459→386）', resolveOwner('邱子鉴;', '') === '邱子鉴');
	check('me 解析为配置的人', resolveOwner('me', '邱子鉴') === '邱子鉴');
	check('me 未配置 ⇒ 报错并提示 me --alias', /me --alias/.test(await throwsCli(() => resolveOwner('me', ''))));
}

console.log('── 筛选防呆 ──');
{
	const ctx = mkCtx([], '邱子鉴');
	const p = await buildParams(ctx, 'bug', { owner: 'me', status: 'todo', since: '2026-09-01', q: 'GC', param: [] });
	check('缺陷 --owner 落在 current_owner', p.current_owner === '邱子鉴' && p.owner === undefined, JSON.stringify(p));
	check('since → created 区间', p.created === '2026-09-01~2099-12-31');
	check('q → 标题模糊', p.title === '%GC%');
	const s = await buildParams(ctx, 'story', { owner: '张三', param: [] });
	check('需求 --owner 落在 owner', s.owner === '张三' && s.current_owner === undefined, JSON.stringify(s));
	check('缺陷误传 owner= ⇒ 报错（会被静默忽略）', /current_owner/.test(await throwsCli(() => buildParams(ctx, 'bug', { param: ['owner=x'] }))));
	check('传 offset ⇒ 报错（服务端忽略）', /offset/.test(await throwsCli(() => buildParams(ctx, 'bug', { param: ['offset=200'] }))));
	check('日期格式不对 ⇒ 报错', /YYYY-MM-DD/.test(await throwsCli(() => buildParams(ctx, 'bug', { since: '10-20', param: [] }))));
}

console.log('── 取数 ──');
{
	const log = [];
	const ctx = mkCtx(log);
	const { rows, pages } = await fetchRows(ctx, 'bug', {}, { max: 1000, fields: 'id', order: 'created desc' });
	check('用 page 翻页取全 450 条', rows.length === 450 && pages === 3, `rows=${rows.length} pages=${pages}`);
	check('请求里没有 offset', log.every(l => !/offset=/.test(l)), log.join(' ; '));
	check('请求带 order=created desc', log.every(l => /order=created\+desc/.test(l)));
	check('id 去重', new Set(rows.map(r => r.id)).size === 450);
	const log2 = [];
	const { rows: r2 } = await fetchRows(mkCtx(log2), 'bug', {}, { max: 50, fields: 'id', order: 'created desc' });
	check('max < 200 时只请求 1 页且 limit=max', r2.length === 50 && log2.length === 1 && /limit=50/.test(log2[0]), log2.join(' ; '));
	const err = await throwsCli(() => mkCtx([]).client.request('/api/tapd/participants', {}));
	check('"Hello world" 识别为接口不存在', /接口不存在/.test(err), err);
	const err404 = await throwsCli(() => mkCtx([]).client.request('/api/tapd/users', {}));
	check('HTTP 404 ⇒ CliError', /HTTP 404/.test(err404), err404);
}

console.log('── 命令端到端（假 fetch）──');
{
	const outBuf = [];
	const deps = { env: { SAROASIS_ME: '邱子鉴' }, write: s => outBuf.push(s), fetch: fakeFetch([]), noCache: true, configPath: path.join(tmp, 'cfg.json') };
	const code = await run(['list', 'bug', '--owner', 'me', '--status', 'todo', '--limit', '3', '--links'], deps);
	const text = outBuf.join('');
	check('list 退出码 0', code === 0, text.slice(0, 300));
	check('list 输出带口径行', /> 口径：`GET \/api\/tapd\/bugs\?/.test(text));
	check('list 状态翻成中文', /\| 新建 \|/.test(text));
	check('list 多负责人用顿号', /邱子鉴、蒋小川/.test(text));
	check('list --links 带 TAPD 链接', /bugtrace\/bugs\/view\?bug_id=/.test(text));
	const out2 = [];
	const code2 = await run(['count', 'bug', '--owner', 'me'], { ...deps, env: {}, write: s => out2.push(s) });
	check('未设置「我」⇒ 退出码 1 + 提示', code2 === 1 && /me --alias/.test(out2.join('')), out2.join(''));
	const out3 = [];
	await run(['nope'], { ...deps, write: s => out3.push(s) });
	check('未知命令 ⇒ 带帮助', /不认识的命令/.test(out3.join('')) && /count bug\|story/.test(out3.join('')));
}

console.log('── 只读约束（静态）──');
{
	const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'studio.mjs'), 'utf8');
	check('没有 POST / PUT / DELETE', !/method:\s*['"](POST|PUT|DELETE|PATCH)/i.test(src));
	check('不访问 206MB 的 /api/bugs/by-team', !/fetch[^\n]*by-team|request\([^\n]*by-team/.test(src));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n[studio] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
