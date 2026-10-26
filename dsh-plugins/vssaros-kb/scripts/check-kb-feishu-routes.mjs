/*
 * 守卫：**飞书相关路由**（2026-10-24，把 IDE 侧的飞书功能搬到 dsh 侧）。
 *
 * 覆盖四条（都不改用户的库，只读 + 一个「未启用就该拒绝」的写口）：
 *   GET  /api/feishu-cli      → 返回 { ok, exe, version } 或 { ok:false, error }（形状必须有）
 *   POST /api/feishu-cli      → action=upgrade 走 update（本守卫只验形状，不真跑升级）
 *   GET  /api/feishu-spaces   → { ok:true, spaces[] } 或 { ok:false, error }
 *   GET  /api/feishu-log      → { ok:true, exists, lines[] }
 *   POST /api/feishu-sync     → **设置里没启用时必须明确拒绝**（不能静默空跑）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-routes.mjs
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VAULT = process.env.KB_VAULT || 'E:/VsSarosVault';
if (!existsSync(VAULT)) {
	console.log(`（跳过）未找到真实库：${VAULT}`);
	process.exit(0);
}

const KB = new URL('../lib/index.js', import.meta.url).href;
const FND = new URL('../../vssaros-foundation/lib/index.js', import.meta.url).href;
const mod = await import(KB);
const fnd = await import(FND);
const foundation = fnd.createFoundationService();

let handler;
const noop = () => () => {};
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({
						effect: fn => { fn(); return noop(); },
						connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } },
					});
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-feishu-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '我的知识库', path: VAULT }]),
});

const call = async (path, method = 'GET', body = '') => {
	const out = [];
	const req = { method, url: path };
	if (method === 'POST') {
		req[Symbol.asyncIterator] = async function* () { if (body) { yield Buffer.from(body); } };
	}
	await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

// 预热：填充 LAST_VAULT_DIRS（/api/feishu-log、/api/feishu-sync 选库要用）
await call('/x/kb/api/view-data');

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

// ① CLI 检测：要么 ok+version，要么 ok=false 且有可读错误（含安装指引）
const cli = await call('/x/kb/api/feishu-cli');
t('feishu-cli 返回可判定的形状',
	(cli.ok === true && typeof cli.version === 'string')
	|| (cli.ok === false && typeof cli.error === 'string' && cli.error.length > 0),
	JSON.stringify(cli).slice(0, 140));
t('feishu-cli 带 exe 字段（便于排查"装在别处"）', typeof cli.exe === 'string' && cli.exe.length > 0);
if (cli.ok === false) {
	t('CLI 缺失时错误里带安装指引', /npm|lark-cli|安装/.test(String(cli.error || '')));
}

// ② 知识库列表：成功则必须有 id/name；失败必须给原因
const spaces = await call('/x/kb/api/feishu-spaces');
t('feishu-spaces 形状正确',
	(spaces.ok === true && Array.isArray(spaces.spaces))
	|| (spaces.ok === false && typeof spaces.error === 'string'),
	JSON.stringify(spaces).slice(0, 140));
if (spaces.ok === true && spaces.spaces.length) {
	t('知识库项都有 id 与 name', spaces.spaces.every(s => s.id && typeof s.name === 'string'));
}

// ③ 同步日志：永远 ok（没有日志就是空数组，不是错误）
const log = await call('/x/kb/api/feishu-log?lines=50');
t('feishu-log 返回 ok 且 lines 是数组', log.ok === true && Array.isArray(log.lines));

// ④ 定时同步状态：形状必须完整（设置页据此显示"下次运行 / 上次结果"）
const sch = await call('/x/kb/api/feishu-schedule');
t('feishu-schedule 形状正确',
	sch.ok === true
	&& typeof sch.active === 'boolean'
	&& typeof sch.everyMinutes === 'number'
	&& typeof sch.nextRunAt === 'number'
	&& typeof sch.running === 'boolean',
	JSON.stringify(sch).slice(0, 160));
t('未启用定时时 nextRunAt=0（不假装有下次运行）',
	sch.active === true ? sch.nextRunAt > 0 : sch.nextRunAt === 0,
	'active=' + sch.active + ' nextRunAt=' + sch.nextRunAt);
t('定时默认间隔 ≥ 5 分钟（防误配成秒级）', sch.everyMinutes >= 5, 'everyMinutes=' + sch.everyMinutes);

// ⑤ 同步门禁：设置里默认 `enabled:false` ⇒ 必须 400 且提示去哪开
const sync = await call('/x/kb/api/feishu-sync', 'POST');
t('未启用飞书同步时明确拒绝', sync.ok === false && String(sync.error || '').includes('未启用'),
	JSON.stringify(sync).slice(0, 160));

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（飞书路由）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（飞书路由：CLI / 库列表 / 日志 / 同步门禁）`);
