#!/usr/bin/env node
// P2 UI：SSR 设置页渲染 + HTTP 路由 + 鉴权/同源/体长限制。
import assert from 'node:assert/strict';
import {
	CSP, PAGE_ROUTE, REFRESH_ACTION, STATE_API, VALIDATE_ACTION,
	apiResponse, escapeHtml, parseForm, renderPage,
} from '../lib/core/page.js';
import { createSettingsService } from '../lib/core/settings.js';
import { apply } from '../lib/index.js';

const fails = [];
let passed = 0;
const check = async (name, fn) => {
	try { await fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error?.message ?? error}`); }
};

const engines = [
	{ route: 'vssaros-codex-cli', name: 'Codex CLI', kind: 'codex-json', command: 'codex', installed: true, version: 'codex 1.2.3', signIn: 'codex login', custom: false, models: [] },
	{ route: 'vssaros-opencode', name: 'OpenCode', kind: 'acp', command: 'opencode', installed: false, version: undefined, signIn: 'opencode auth login', custom: false, models: [] },
];
export const fakeSettings = (overrides = {}) => createSettingsService({
	initialRoutes: ['vssaros-codex-cli'],
	resolve: () => undefined, probe: () => undefined,
	...overrides,
});
const settingsWithRows = () => ({
	list: () => engines.map((row) => ({ ...row })),
	routes: () => ['vssaros-codex-cli'],
	signIn: () => ({ ok: true, command: 'codex login' }),
	validateCustom: (agents) => agents.map((agent, index) => ({
		index, id: agent?.id ?? '', name: agent?.name ?? '',
		valid: !!agent?.command, problems: agent?.command ? [] : ['命令不能为空'],
	})),
	refresh: () => ({ ok: true, routes: ['vssaros-codex-cli'], engines }),
});

await check('escapeHtml 挡住 XSS；parseForm 解析 urlencoded', () => {
	const evil = '<img src=x onerror="alert(1)">&\'"';
	const escaped = escapeHtml(evil);
	assert.ok(!escaped.includes('<img'));
	assert.ok(escaped.includes('&lt;img'));
	assert.ok(escaped.includes('&quot;'));
	assert.ok(escaped.includes('&#39;'));
	assert.deepEqual(parseForm('custom=%5B%5D&note=a+b'), { custom: '[]', note: 'a b' });
	assert.deepEqual(parseForm(''), {});
});

await check('★ renderPage：零 JS、严格 CSP、动态值全部转义', () => {
	const evilName = '<script>alert(1)</script>';
	const html = renderPage({
		engines: [{ ...engines[0], name: evilName }],
		routes: ['vssaros-codex-cli'],
		notice: '已重新检测',
	});
	assert.ok(!html.includes('<script>'), '页面不能含任何 script 标签');
	assert.ok(html.includes('&lt;script&gt;'), '引擎名必须转义');
	assert.ok(html.includes(CSP));
	assert.match(html, /default-src 'none'/);
	assert.match(html, /已重新检测/);
	assert.match(html, /codex login/);
	assert.match(html, /已安装/);
	assert.match(html, /vssaros-codex-cli/);
});

await check('renderPage 校验结果：合法/非法逐条展示', () => {
	const html = renderPage({
		engines, routes: [],
		validation: { results: [
			{ index: 0, id: 'a', name: 'Good', valid: true, problems: [] },
			{ index: 1, id: 'b', name: 'Bad', valid: false, problems: ['命令不能为空', '名称不能为空'] },
		] },
	});
	assert.match(html, /自定义 Agent 校验/);
	assert.match(html, /通过/);
	assert.match(html, /命令不能为空/);
});

await check('apiResponse：GET 页面 / GET state / POST refresh / POST validate / 404', () => {
	let refreshed = 0;
	const settings = {
		...settingsWithRows(),
		refresh: () => { refreshed++; return { ok: true }; },
	};
	const page = apiResponse({ method: 'GET', pathname: PAGE_ROUTE, settings });
	assert.equal(page.status, 200);
	assert.match(page.body, /本地 Agent/);
	const state = apiResponse({ method: 'GET', pathname: STATE_API, settings });
	assert.equal(state.status, 200);
	assert.equal(JSON.parse(state.body).engines.length, 2);
	const refresh = apiResponse({ method: 'POST', pathname: REFRESH_ACTION, settings });
	assert.equal(refresh.status, 303);
	assert.equal(refresh.headers.location, `${PAGE_ROUTE}?refreshed=1`);
	assert.equal(refreshed, 1);
	const valid = apiResponse({
		method: 'POST', pathname: VALIDATE_ACTION,
		body: 'custom=' + encodeURIComponent(JSON.stringify([{ id: 'good', name: 'Good', command: 'x' }])),
		settings,
	});
	assert.equal(valid.status, 200);
	assert.match(valid.body, /通过/);
	const broken = apiResponse({ method: 'POST', pathname: VALIDATE_ACTION, body: 'custom=%7Bbad', settings });
	assert.match(broken.body, /JSON 解析失败/);
	assert.equal(apiResponse({ method: 'GET', pathname: '/x/local-agents/nope', settings }).status, 404);
	assert.equal(apiResponse({ method: 'DELETE', pathname: STATE_API, settings }).status, 404);
});

await check('★ apply() 注册 SSR 路由：鉴权拒绝、页面、JSON、跨站 POST、refresh 重定向、体长限制', async () => {
	const handlers = [];
	const webChild = {
		webServer: { register(def) { handlers.push(def); return () => {}; } },
		connection: { requestRejection: (req) => req.rejected ?? 0 },
		effect(factory) { return factory(); },
	};
	const llmChild = {
		llm: undefined, tools: { register: () => () => {} },
		get: () => undefined, provide: () => () => {},
		effect: () => () => {},
	};
	const ctx = {
		inject(names, callback) { callback(names.includes('webServer') ? webChild : llmChild); },
	};
	// routes 为空（本机没装 CLI）也应能打开设置页显示"未检测到"。
	apply(ctx, { enabled: true, custom: [] });
	assert.equal(handlers.length, 1);
	assert.equal(handlers[0].path, '/x/local-agents');

	const req = (url, options = {}) => ({
		url, method: options.method ?? 'GET',
		headers: { host: '127.0.0.1:9999', ...(options.headers ?? {}) },
		rejected: options.rejected ?? 0,
		async *[Symbol.asyncIterator]() { if (options.body !== undefined) yield options.body; },
	});
	const res = () => ({
		status: 0, headers: {}, body: '', headersSent: false,
		writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
		end(text) { this.body += String(text ?? ''); },
	});
	const call = async (options = {}) => {
		const response = res();
		await handlers[0].handler(req(options.url ?? PAGE_ROUTE, options), response);
		return response;
	};

	const denied = await call({ rejected: 403 });
	assert.equal(denied.status, 403);
	const page = await call();
	assert.equal(page.status, 200);
	assert.match(page.headers['content-type'], /text\/html/);
	assert.match(page.body, /本地 Agent/);
	const state = await call({ url: STATE_API });
	assert.equal(state.status, 200);
	assert.ok(Array.isArray(JSON.parse(state.body).engines));
	const crossSite = await call({ url: REFRESH_ACTION, method: 'POST', headers: { origin: 'http://evil.example' } });
	assert.equal(crossSite.status, 403);
	const sameSite = await call({ url: REFRESH_ACTION, method: 'POST', headers: { origin: 'http://127.0.0.1:9999' } });
	assert.equal(sameSite.status, 303);
	const huge = await call({ url: VALIDATE_ACTION, method: 'POST', body: 'x'.repeat(70 * 1024) });
	assert.equal(huge.status, 500);
	assert.match(huge.body, /请求体过大/);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
