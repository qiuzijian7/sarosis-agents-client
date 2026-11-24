/**
 * ★ 2026-11-24 阶段3：LLM 安装「优先查 VsSaros 商城」行为守卫。
 *
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-install-priority-check.mjs
 *
 * 覆盖：market_install 只给名称时强制先查商城、命中才装、歧义返回候选、
 *       未命中 notFound 且不擅自换源、给 slug 时保持向后兼容。
 * 全部用注入的 mock，不访问网络、不落盘。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketToolDefinitions } from '../lib/agentTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', 'lib');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  OK  ${name}`);
	} catch (e) {
		failed++;
		failures.push(`${name}: ${e?.message ?? e}`);
		console.error(`  NG  ${name}: ${e?.message ?? e}`);
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  OK  ${name}`);
	} catch (e) {
		failed++;
		failures.push(`${name}: ${e?.message ?? e}`);
		console.error(`  NG  ${name}: ${e?.message ?? e}`);
	}
}

function makeInstall(items = [], installResult) {
	const state = { installCalls: [], listCalls: [] };
	const defs = marketToolDefinitions({
		inspectGithubRepo: async () => ({}),
		publishDistribution: async () => ({}),
		installPackage: async ({ slug, version }) => {
			state.installCalls.push({ slug, version });
			return installResult ?? { ok: true, kind: 'mcp', version: version || '1.0.0' };
		},
		market: () => ({
			list: async (opts) => {
				state.listCalls.push(opts);
				return { items, total: items.length, page: 1, pageSize: opts?.pageSize ?? 20 };
			},
			detail: async (slug) => ({ slug, kind: 'mcp' }),
		}),
	});
	return { def: defs.find(d => d.name === 'market_install'), state, defs };
}

async function main() {
	console.log('================================================');
	console.log('  LLM 安装优先查商城 — 行为守卫');
	console.log('================================================');

	const one = [
		{ slug: 'tapd', name: 'TAPD MCP', kind: 'mcp', installable: true },
	];
	const many = [
		{ slug: 'tapd', name: 'TAPD MCP', kind: 'mcp', installable: true },
		{ slug: 'tapd-lite', name: 'TAPD MCP Lite', kind: 'mcp', installable: true },
		{ slug: 'p4helper', name: 'P4Helper', kind: 'skill', installable: true },
	];

	// ── A. 工具契约 ──────────────────────────────────────────
	check('market_install 参数新增 name / q / kind', () => {
		const { def } = makeInstall();
		const props = def.parameters.properties;
		for (const k of ['slug', 'name', 'q', 'kind', 'version']) {
			assert.ok(props[k], `缺少参数 ${k}`);
		}
		assert.deepEqual(def.parameters.required, [], 'slug 不再是唯一必填');
	});
	check('工具描述明确要求先查商城、未命中不换源', () => {
		const { def } = makeInstall();
		assert.match(def.description, /先查商城/);
		assert.match(def.description, /不要自行改用 npm \/ GitHub/);
	});
	check('输出 schema 含 notFound / ambiguous / candidates / resolvedFrom', () => {
		const { def } = makeInstall();
		const props = def.output.schema.properties;
		for (const k of ['notFound', 'ambiguous', 'candidates', 'resolvedFrom']) {
			assert.ok(props[k], `缺少输出字段 ${k}`);
		}
	});

	// ── B. 名称解析：唯一命中才装 ────────────────────────────
	await checkAsync('只给 name 且商城唯一命中 ⇒ 先查商城再安装', async () => {
		const { def, state } = makeInstall(one);
		const r = await def.execute({ name: 'TAPD MCP' });
		assert.equal(state.listCalls.length, 1, '必须先调商城 list');
		assert.equal(state.listCalls[0].q, 'TAPD MCP');
		assert.equal(state.installCalls.length, 1, '命中后才安装');
		assert.equal(state.installCalls[0].slug, 'tapd');
		assert.equal(r.ok, true);
		assert.equal(r.slug, 'tapd');
		assert.equal(r.resolvedFrom, 'name-exact');
	});
	await checkAsync('多个搜索结果中名称精确唯一 ⇒ 选精确那条', async () => {
		const { def, state } = makeInstall(many);
		const r = await def.execute({ name: 'TAPD MCP', q: 'TAPD' });
		assert.equal(state.installCalls.length, 1);
		assert.equal(state.installCalls[0].slug, 'tapd');
		assert.equal(r.resolvedFrom, 'name-exact');
	});
	await checkAsync('只给 q 且唯一结果 ⇒ name-unique 解析', async () => {
		const { def, state } = makeInstall(one);
		const r = await def.execute({ q: 'tapd' });
		assert.equal(state.installCalls.length, 1);
		assert.equal(r.resolvedFrom, 'name-unique');
	});
	await checkAsync('kind 限定会透传给商城检索', async () => {
		const { def, state } = makeInstall(one);
		await def.execute({ q: 'tapd', kind: 'mcp' });
		assert.equal(state.listCalls[0].kind, 'mcp');
	});

	// ── C. 歧义 / 未命中：绝不擅自安装 ────────────────────────
	await checkAsync('多命中且无精确名称 ⇒ ambiguous + 候选，不安装', async () => {
		const { def, state } = makeInstall(many);
		const r = await def.execute({ q: 'TAPD' });
		assert.equal(r.ok, false);
		assert.equal(r.ambiguous, true);
		assert.equal(r.notFound, false);
		assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 2);
		assert.equal(state.installCalls.length, 0, '歧义时不能落盘');
		assert.match(r.error, /market_search/);
	});
	await checkAsync('商城零命中 ⇒ notFound 且明确禁止改走 npm/GitHub', async () => {
		const { def, state } = makeInstall([]);
		const r = await def.execute({ name: '不存在的东西' });
		assert.equal(r.ok, false);
		assert.equal(r.notFound, true);
		assert.equal(state.installCalls.length, 0, '未命中不能安装');
		assert.match(r.error, /不要自行改用 npm \/ GitHub/);
	});
	await checkAsync('既无 slug 也无 name/q ⇒ 明确拒绝', async () => {
		const { def, state } = makeInstall(one);
		const r = await def.execute({});
		assert.equal(r.ok, false);
		assert.equal(state.listCalls.length, 0);
		assert.equal(state.installCalls.length, 0);
	});
	await checkAsync('商城检索异常 ⇒ 返回检索失败而不是绕过', async () => {
		const defs = marketToolDefinitions({
			inspectGithubRepo: async () => ({}), publishDistribution: async () => ({}),
			installPackage: async () => ({ ok: true }),
			market: () => ({ list: async () => { throw new Error('HTTP 500'); } }),
		});
		const def = defs.find(d => d.name === 'market_install');
		const r = await def.execute({ q: 'x' });
		assert.equal(r.ok, false);
		assert.match(r.error, /商城检索失败/);
	});

	// ── D. 向后兼容与 render ─────────────────────────────────
	await checkAsync('传 slug ⇒ 不查商城列表，直接安装（向后兼容）', async () => {
		const { def, state } = makeInstall(one);
		const r = await def.execute({ slug: 'tapd', version: '1.2.3' });
		assert.equal(state.listCalls.length, 0);
		assert.equal(state.installCalls.length, 1);
		assert.equal(state.installCalls[0].version, '1.2.3');
		assert.equal(r.resolvedFrom, 'slug');
	});
	check('render 对 notFound / ambiguous 给出可读提示', () => {
		const { def } = makeInstall();
		const nf = def.output.render({}, { ok: false, notFound: true, query: 'x', error: '没有' });
		assert.match(nf[0].text, /商城里没有/);
		const amb = def.output.render({}, {
			ok: false, ambiguous: true,
			candidates: [{ name: 'A', kind: 'mcp', slug: 'a', installable: true }],
		});
		assert.match(amb[0].text, /多个候选/);
	});

	// ── E. 人设硬约束 ────────────────────────────────────────
	check('PERSONA 写明「必须优先查商城」与 notFound 停止规则', () => {
		const src = fs.readFileSync(path.join(LIB, 'marketAgent.js'), 'utf8');
		assert.match(src, /必须优先查商城/);
		assert.match(src, /第一步永远是查 VsSaros 商城/);
		assert.match(src, /notFound/);
		assert.match(src, /绝不自行改用/);
	});
	check('PERSONA 要求转述重启提醒且不擅自重启', () => {
		const src = fs.readFileSync(path.join(LIB, 'marketAgent.js'), 'utf8');
		assert.match(src, /必须把 `nextStep` 原样转述/);
		assert.match(src, /只提醒、绝不擅自重启/);
	});

	// ── F. 安装成功后的重启提醒（dsh 官方做法）──────────────────
	await checkAsync('回执 restartRequired ⇒ 生成 warn 级 restartNotice', async () => {
		const { def } = makeInstall([], { ok: true, kind: 'plugin', version: '1.0.0', restartRequired: true });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.ok, true);
		assert.equal(r.restartNotice?.kind, 'warn');
		assert.equal(r.restartNotice?.restartRequired, true);
		assert.equal(r.application, 'restart-required');
		assert.equal(r.restartReason, 'no-hmr');
		assert.match(r.restartNotice?.text ?? '', /重启 Host 进程/);
		assert.match(r.nextStep ?? '', /不要只 Reload Window/);
	});
	await checkAsync('mcpNote / agentsRescan 也并入重启提醒', async () => {
		const { def } = makeInstall([], {
			ok: true, kind: 'agent', version: '1.0.0',
			agentsRescan: 'restart', mcpNote: 'MCP 需要填环境变量',
		});
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.restartNotice?.restartRequired, true);
		assert.match(r.restartNotice?.text ?? '', /MCP 需要填环境变量/);
		assert.match(r.restartNotice?.text ?? '', /Agent 重扫状态：restart/);
	});
	await checkAsync('无需重启 ⇒ 不生成 restartNotice', async () => {
		const { def } = makeInstall([], { ok: true, kind: 'skill', version: '1.0.0' });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.restartNotice, undefined);
	});
	check('render 醒目提示重启且声明不擅自重启', () => {
		const { def } = makeInstall();
		const out = def.output.render({}, {
			ok: true, slug: 'x', kind: 'plugin', version: '1.0.0',
			application: 'restart-required',
			restartNotice: { kind: 'warn', restartRequired: true, text: '⚠ 已装好，但需重启 Host 进程后才生效。我不会替你重启。' },
		});
		assert.match(out[0].text, /重启 Host 进程/);
		assert.match(out[0].text, /不会替你重启/);
	});
	check('工作台页面用 dsh 官方页面桥弹 toast', () => {
		const src = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
		assert.match(src, /window\.vssarosDsh/);
		assert.match(src, /pageBridge\.notify\('warn', notice\)/);
		assert.match(src, /不会自动重启/);
	});
	check('工具 schema 声明 restartNotice', () => {
		const { def } = makeInstall();
		assert.ok(def.output.schema.properties.restartNotice);
	});

	// ── G. P0：ChangeResult 回执与提示分通道 ───────────────────
	await checkAsync('无重启回执 ⇒ applied 且 render 成功静默', async () => {
		const { def } = makeInstall([], { ok: true, kind: 'skill', version: '1.0.0' });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.application, 'applied');
		assert.equal(r.restartNotice, undefined);
		assert.doesNotMatch(def.output.render({}, r)[0].text, /重启/);
	});
	await checkAsync('上游 application=applied 不被误判为需重启', async () => {
		const { def } = makeInstall([], { ok: true, application: 'applied', mcpNote: '运行时挂载会自动连接' });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.application, 'applied');
		assert.equal(r.restartNotice, undefined);
	});
	await checkAsync('packageName 回执 ⇒ package-moved 与启动器指引', async () => {
		const { def } = makeInstall([], { ok: true, application: 'restart-required', packageName: '@x/wb', via: 'dsh' });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.restartReason, 'package-moved');
		assert.match(r.nextStep, /工作台启动器/);
	});
	check('工作台页面按 application 分通道（applied 不弹 toast）', () => {
		const src = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
		assert.match(src, /var application = String\(\(res\.changeReceipt/);
		assert.match(src, /application !== 'applied'/);
		assert.match(src, /pageBridge\.notify\('warn', notice\)/);
		assert.match(src, /res\.changeReceipt && res\.changeReceipt\.restartRequired/);
	});
	check('归一化纯函数是唯一真源且被 agentTools 引用', () => {
		const d = fs.readFileSync(path.join(LIB, 'dispatch.js'), 'utf8');
		const a = fs.readFileSync(path.join(LIB, 'agentTools.js'), 'utf8');
		assert.match(d, /export function toChangeReceipt/);
		assert.match(a, /import \{ toChangeReceipt \} from '\.\/dispatch\.js'/);
		assert.match(a, /toChangeReceipt\(r, \{ op: 'install' \}\)/);
	});
	check('PERSONA 按 application 区分 applied / restart-required', () => {
		const src = fs.readFileSync(path.join(LIB, 'marketAgent.js'), 'utf8');
		assert.match(src, /`applied` ⇒ 已即时生效/);
		assert.match(src, /`restart-required` ⇒/);
	});

	// ── H. P1：Host 出口统一回执 + HMR 探测 ────────────────────
	await checkAsync('工具优先采信 Host 的 changeReceipt（HMR 信息不丢失）', async () => {
		const hostReceipt = {
			application: 'restart-required', restartRequired: true,
			restartReason: 'host-module', nextStep: 'HMR 已启用但涉及启动期模块，需重启 Host。',
			stage: 'install', changed: true,
		};
		const { def } = makeInstall([], { ok: true, kind: 'workbench', changeReceipt: hostReceipt });
		const r = await def.execute({ slug: 'x' });
		assert.equal(r.application, 'restart-required');
		assert.equal(r.restartReason, 'host-module');
		assert.match(r.restartNotice.text, /HMR 已启用/);
	});
	check('index.js 两个出口附 changeReceipt 且探测 ctx.hmr', () => {
		const src = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
		assert.match(src, /import \{ ALL_OPS,.*toChangeReceipt \} from '\.\/dispatch\.js'/);
		assert.match(src, /function withChangeReceipt\(res, op\)/);
		assert.match(src, /ctx\.get\('hmr'\)/);
		assert.match(src, /withChangeReceipt\(await runLocalByTarget/);
		assert.match(src, /withChangeReceipt\(await callIde/);
		assert.match(src, /withChangeReceipt\(\{ kind, \.\.\.result \}, 'install'\)/);
	});
	check('agentTools 消费 Host changeReceipt 而非重复推导', () => {
		const src = fs.readFileSync(path.join(LIB, 'agentTools.js'), 'utf8');
		assert.match(src, /r\?\.changeReceipt && typeof r\.changeReceipt\.application === 'string'/);
	});

	console.log('\n================================================');
	console.log(`  通过: ${passed}`);
	console.log(`  失败: ${failed}`);
	if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
	console.log('================================================');
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); process.exit(1); });
