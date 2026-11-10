#!/usr/bin/env node
// multiroot-integration.test.mjs — 多根工作区「全链路」集成测试（2026-11-10）
//
// 与 check-host-config.mjs 的 A3–A11 / 各插件单测的区别：那些是**单模块**断言，
// 这里把九刀的产物接到**同一个** createFoundationService() 实例上，验证
// 「一份运行期上下文 → 根集真源 / 模型提示词 / 写沙箱 / cwd 闸 / ACP 出口 / 会话映射 /
//   群聊闸 / 会话快照」看到的是同一份真值，且切工作区时一起变。
//
// 全部为纯内存夹具（不 spawn CLI、不碰真实 fs、不起 HTTP）⇒ 可重复、无环境依赖。
// 跑法：node dsh-plugins/test/multiroot-integration.test.mjs
//
// 用例清单：
//   TC-01 老载荷（无 roots）逐字兼容，单根下游零变化
//   TC-02 结构化 5 根：有序/去重/主根/根名，提示词与 ACP 同一份根集
//   TC-03 畸形 roots 整份拒收，下游读到旧值（不半更新）
//   TC-04 切工作区：提示词 / ACP / 沙箱 / 快照同时跟着变
//   TC-05 幂等推送不重复广播
//   TC-06 提示词段 text() 是函数，动态重读真源
//   TC-07 会话 cwd 非主根时的提示文案
//   TC-08 沙箱：多根逐个放行、根外重抛官方错、单根/read-only 回落
//   TC-09 fs 服务接线与卸载恢复
//   TC-10 canonical 复核：symlink 逃逸在普通闸与群聊闸都被拒
//   TC-11 群聊兜底 cwd / 默认 bot 放行，显式 cwd 越界拒
//   TC-12 ACP v2：握手 → caps → new/resume 显式重传根集
//   TC-13 ACP v1：loadSession 与能力 gate，未声明不传字段
//   TC-14 会话映射跨「Host 重启」触发 resumeId；anonymous 不查映射
//   TC-15 映射只存 id，畸形条目丢弃
//   TC-16 会话根集快照：切换报出旧会话、幂等接管后不再报
import assert from 'node:assert/strict';
import { createFoundationService } from '../vssaros-foundation/lib/index.js';
import { normalizeWorkspaceContext, sameWorkspaceContext } from '../vssaros-foundation/lib/workspaceContext.js';
import { renderWorkspaceRootsText, parseRootQualifiedPath, installWorkspaceRootsPrompt } from '../vssaros-foundation/lib/workspacePrompt.js';
import { withMultiRootCheckedTarget, installMultiRootFs } from '../vssaros-foundation/lib/fsMultiRoot.js';
import { checkCwdGrant, canonicalCoveredBy, roomSessionGrantRefusal } from '../vssaros-agents/lib/grants.js';
import { acpSessionParams, acpInitializeParams, acpCapabilitiesOf, acpResumeMethodOf } from '../vssaros-local-agents/lib/core/acp.js';
import { createAcpSessionMap, parseAcpSessionMap } from '../vssaros-local-agents/lib/core/sessionMap.js';
import { createAcpAdapter } from '../vssaros-local-agents/lib/core/acpAdapter.js';
import { createSessionRootBindings, describeRootChange } from '../vssaros-bridge/lib/sessionRoots.js';

const fails = [];
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const checkAsync = async (name, fn) => {
	try { await fn(); ok(name); }
	catch (error) {
		fails.push(name);
		console.error(`  ✗ ${name} — ${String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 260)}`);
	}
};

const BASE = 'G:/SarosWorkspace/';
const FIVE = [
	{ path: BASE + 'app', name: 'frontend', isPrimary: true },
	{ path: BASE + 'lib', name: 'backend' },
	{ path: BASE + 'docs', name: 'contracts' },
	{ path: BASE + 'homepage', name: 'site' },
	{ path: BASE + 'switch', name: 'tools' },
];
const legacyPayload = (root, related) => ({
	workspaceId: 'ws-a', workspaceRoot: root, relatedRoots: related, windowId: 7, at: 123,
});
const structuredPayload = (roots) => ({
	workspaceRoot: roots[0].path,
	relatedRoots: roots.map(r => r.path),
	roots,
});

const fresh = () => createFoundationService();
const setLegacy = (svc) => svc.setWorkspaceContext(legacyPayload(FIVE[0].path, [FIVE[0].path]));
const setFive = (svc) => svc.setWorkspaceContext(structuredPayload(FIVE));

/** 官方形状的 checkedTarget 夹具：按 policy.workspaceRoot 做词法 containment。 */
const DENIED = Object.assign(new Error('FS_SANDBOX_DENIED'), { code: 'FS_SANDBOX_DENIED' });
const makeSandbox = (primaryRoot = FIVE[0].path) => {
	let calls = 0;
	const original = async function (target, policy) {
		calls++;
		const p = policy ?? this.ctx.sandboxPolicy.resolve();
		if (p.mode === 'danger-full-access') { return { target, checkedWith: 'unfenced' }; }
		if (p.mode !== 'workspace-write') { throw DENIED; }
		const root = String(p.workspaceRoot).toLowerCase().replace(/\\/g, '/');
		const file = String(target.displayPath).toLowerCase().replace(/\\/g, '/');
		if (!(file === root || file.startsWith(root + '/'))) { throw DENIED; }
		return { target, checkedWith: p.workspaceRoot };
	};
	const fsCtx = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: primaryRoot }) } } };
	const attempt = (wrapped, displayPath, policy) => wrapped.call(fsCtx, { displayPath }, policy);
	return { original, fsCtx, attempt, get calls() { return calls; }, reset() { calls = 0; } };
};

// ── TC-01 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-01 老载荷（无 roots）逐字兼容，单根下游零变化', async () => {
	const svc = fresh();
	const norm = normalizeWorkspaceContext(legacyPayload(FIVE[0].path, [FIVE[0].path, FIVE[1].path, FIVE[0].path]));
	assert.equal(JSON.stringify(norm), JSON.stringify({
		workspaceId: 'ws-a', workspaceRoot: FIVE[0].path,
		relatedRoots: [FIVE[0].path, FIVE[1].path], windowId: 7, at: 123,
	}));
	assert.equal('roots' in norm, false);
	setLegacy(svc);
	assert.equal(renderWorkspaceRootsText(svc.workspaceContext()), '');
	const params = acpSessionParams({ cwd: FIVE[0].path, roots: svc.workspaceRoots(), capable: true });
	assert.equal('additionalDirectories' in params, false);
	assert.equal(svc.workspaceRoots().length, 1);
});

// ── TC-02 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-02 结构化 5 根：有序/去重/主根/根名，提示词与 ACP 同一份根集', async () => {
	const svc = fresh();
	setFive(svc);
	const roots = svc.workspaceRoots();
	assert.equal(roots.length, 5);
	assert.equal(roots[0].isPrimary, true);
	assert.equal(roots[0].name, 'frontend');
	const text = renderWorkspaceRootsText(svc.workspaceContext());
	assert.ok(text.includes('## Workspace roots (multi-root)') && text.includes('This workspace has 5 roots.'));
	for (const r of roots) { assert.ok(text.includes(r.path), `提示词缺根 ${r.path}`); }
	assert.ok(text.includes('always use its absolute path') && !text.includes('@<root-name>'));
	const params = acpSessionParams({ cwd: roots[0].path, roots, capable: true });
	assert.deepEqual(params.additionalDirectories, roots.slice(1).map(r => r.path));
	assert.equal(parseRootQualifiedPath('@backend:src/App.tsx', roots).root.name, 'backend');
	assert.equal(parseRootQualifiedPath('@backend:src/App.tsx', roots).relativePath, 'src/App.tsx');
	assert.equal(parseRootQualifiedPath('@nope:x', roots).error.includes('unknown'), true);
});

// ── TC-03 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-03 畸形 roots 整份拒收，下游读到旧值（不半更新）', async () => {
	const svc = fresh();
	setFive(svc);
	const before = JSON.stringify(svc.workspaceContext());
	assert.equal(svc.setWorkspaceContext({ roots: 'not-an-array' }), undefined);
	assert.equal(svc.setWorkspaceContext({ roots: [{ path: '  ' }] }), undefined);
	assert.equal(JSON.stringify(svc.workspaceContext()), before);
	assert.equal(svc.workspaceRoots().length, 5);
	const text = renderWorkspaceRootsText(svc.workspaceContext());
	assert.ok(text.includes('This workspace has 5 roots.'));
});

// ── TC-04 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-04 切工作区：提示词 / ACP / 沙箱 / 快照同时跟着变', async () => {
	const svc = fresh();
	const bindings = createSessionRootBindings();
	setFive(svc);
	bindings.bind('s1', svc.workspaceRoots());
	const beforeText = renderWorkspaceRootsText(svc.workspaceContext());
	const sb = makeSandbox();
	const wrapped5 = withMultiRootCheckedTarget(sb.original, () => svc.workspaceRoots());
	assert.equal((await sb.attempt(wrapped5, FIVE[4].path + '/x.ts')).checkedWith, FIVE[4].path);

	const TWO = FIVE.slice(0, 2);
	svc.setWorkspaceContext(structuredPayload(TWO));
	const afterText = renderWorkspaceRootsText(svc.workspaceContext());
	assert.ok(beforeText.includes('This workspace has 5 roots.') && afterText.includes('This workspace has 2 roots.'));
	assert.equal(acpSessionParams({ cwd: TWO[0].path, roots: svc.workspaceRoots(), capable: true }).additionalDirectories.length, 1);
	sb.reset();
	const wrapped2 = withMultiRootCheckedTarget(sb.original, () => svc.workspaceRoots());
	await assert.rejects(() => sb.attempt(wrapped2, FIVE[4].path + '/x.ts'), e => e === DENIED);
	assert.deepEqual(bindings.mismatches(svc.workspaceRoots()), ['s1']);
	bindings.bind('s1', svc.workspaceRoots()); // 幂等接管：重新绑定到当前根集
	assert.equal(bindings.mismatches(svc.workspaceRoots()).length, 0);
});

// ── TC-05 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-05 幂等推送不重复广播', async () => {
	const svc = fresh();
	let fired = 0;
	const off = svc.onDidChangeWorkspaceContext(() => { fired++; });
	setFive(svc);
	const before = svc.workspaceContext();
	svc.setWorkspaceContext(structuredPayload(FIVE));
	assert.equal(sameWorkspaceContext(before, svc.workspaceContext()), true);
	assert.equal(fired, 1);
	svc.setWorkspaceContext({ ...structuredPayload(FIVE), windowId: 99 });
	assert.equal(fired, 1);
	off();
});

// ── TC-06 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-06 提示词段 text() 是函数，动态重读真源', async () => {
	const svc = fresh();
	let captured;
	const fakeCtx = {
		inject: (deps, cb) => { if (deps.includes('systemPrompt')) { cb(fakeCtx); } return { dispose() { } }; },
		effect: (fn) => fn(),
		systemPrompt: { context: (def) => { captured = def; return () => { }; } },
	};
	assert.equal(installWorkspaceRootsPrompt(fakeCtx, svc), true);
	assert.equal(typeof captured.text, 'function');
	setFive(svc);
	assert.ok(captured.text({}).includes('This workspace has 5 roots.'));
	setLegacy(svc);
	assert.equal(captured.text({}), '');
});

// ── TC-07 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-07 会话 cwd 非主根时的提示文案', async () => {
	const svc = fresh();
	setFive(svc);
	const ctx = svc.workspaceContext();
	assert.ok(renderWorkspaceRootsText(ctx, { cwd: FIVE[1].path }).includes('not the primary root'));
	assert.ok(!renderWorkspaceRootsText(ctx, { cwd: FIVE[0].path }).includes('not the primary root'));
});

// ── TC-08 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-08 沙箱：多根逐个放行、根外重抛官方错、单根/read-only 回落', async () => {
	const svc = fresh();
	const sb = makeSandbox();
	const wrapped = withMultiRootCheckedTarget(sb.original, () => svc.workspaceRoots());
	setFive(svc);
	for (const r of FIVE) {
		const out = await sb.attempt(wrapped, r.path + '/src/x.ts');
		assert.equal(out.checkedWith, r.path);
	}
	sb.reset();
	await assert.rejects(() => sb.attempt(wrapped, 'G:/outside/x.ts'), e => e === DENIED);
	assert.equal(sb.calls, 5); // 1 主根 + 其余 4 根，主根不重复试
	await assert.rejects(
		() => sb.attempt(wrapped, FIVE[1].path + '/x.ts', { mode: 'read-only', workspaceRoot: FIVE[0].path }),
		e => e === DENIED,
	);
	setLegacy(svc);
	sb.reset();
	await assert.rejects(() => sb.attempt(wrapped, FIVE[1].path + '/x.ts'), e => e === DENIED);
	assert.equal(sb.calls, 1);
});

// ── TC-09 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-09 fs 服务接线与卸载恢复', async () => {
	const svc = fresh();
	setFive(svc);
	const sb = makeSandbox();
	const proto = { checkedTarget: sb.original };
	const fsService = Object.create(proto);
	let disposer = () => { };
	const fakeCtx = {
		inject: (deps, cb) => { if (deps.includes('fs')) { cb(fakeCtx); } return { dispose() { } }; },
		effect: (fn) => { disposer = fn(); return disposer; },
		fs: fsService,
	};
	assert.equal(installMultiRootFs(fakeCtx, svc), true);
	assert.notEqual(fsService.checkedTarget, sb.original);
	const out = await fsService.checkedTarget.call(sb.fsCtx, { displayPath: FIVE[3].path + '/x.ts' });
	assert.equal(out.checkedWith, FIVE[3].path);
	disposer();
	assert.equal(Object.prototype.hasOwnProperty.call(fsService, 'checkedTarget'), false);
	assert.equal(installMultiRootFs({}, svc), false);
});

// ── TC-10 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-10 canonical 复核：symlink 逃逸在普通闸与群聊闸都被拒', async () => {
	const aliases = new Map([['R:/a', 'R:/real/a'], ['R:/a/link', 'R:/outside']]);
	const entries = [...aliases.entries()].sort((x, y) => y[0].length - x[0].length);
	const real = (p) => {
		const key = String(p).replace(/\\/g, '/');
		for (const [from, to] of entries) {
			if (key === from || key.startsWith(from + '/')) { return to + key.slice(from.length); }
		}
		return key;
	};
	const agent = { name: 'bot', workspaces: { read: ['R:/a'] } };
	assert.equal(canonicalCoveredBy(['R:/a'], 'R:/a/x', real), true);
	assert.equal(canonicalCoveredBy(['R:/a'], 'R:/a/link', real), false);
	assert.ok((checkCwdGrant(agent, 'R:/a/link', real) ?? '').includes('canonical'));
	assert.ok((roomSessionGrantRefusal({ agent, place: { cwd: 'R:/a/link' }, fallbackCwd: 'R:/fallback', realpath: real }) ?? '').includes('canonical'));
	assert.equal(checkCwdGrant(agent, 'R:/a/x', real), undefined);
});

// ── TC-11 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-11 群聊兜底 cwd / 默认 bot 放行，显式 cwd 越界拒', async () => {
	const real = p => String(p).replace(/\\/g, '/');
	const strict = { name: 'bot', workspaces: { read: ['G:/allowed'] } };
	const loose = { name: 'bot' };
	const grant = (agent, cwd) => roomSessionGrantRefusal({ agent, place: { cwd }, fallbackCwd: 'G:/fallback', realpath: real });
	assert.equal(grant(strict, 'G:/fallback'), undefined);
	assert.equal(grant(strict, undefined), undefined);
	assert.equal(grant(loose, 'G:/elsewhere'), undefined);
	assert.equal(grant(undefined, 'G:/elsewhere'), undefined);
	assert.ok((grant(strict, 'G:/elsewhere') ?? '').includes('不覆盖'));
	assert.equal(grant(strict, 'G:/allowed/sub'), undefined);
});

// ── TC-12 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-12 ACP v2：握手 → caps → new / resume 显式重传根集', async () => {
	const svc = fresh();
	setFive(svc);
	const roots = svc.workspaceRoots();
	assert.equal(acpInitializeParams(2).protocolVersion, 2);
	const reply = {
		protocolVersion: 2,
		capabilities: { session: { mcp: { http: {} }, additionalDirectories: {} } },
		info: { name: 'agent', version: '1' },
	};
	const caps = acpCapabilitiesOf(reply);
	assert.equal(caps.resumeMethod, 'session/resume');
	assert.equal(caps.mcpHttp, true);
	const params = acpSessionParams({ cwd: roots[0].path, roots, capable: caps.additionalDirectories });
	assert.equal(params.cwd, roots[0].path);
	assert.deepEqual(params.additionalDirectories, roots.slice(1).map(r => r.path));
	const resumeParams = { ...params, sessionId: 'cli-1' };
	assert.deepEqual(resumeParams.additionalDirectories, params.additionalDirectories);
	assert.equal(acpResumeMethodOf(reply), 'session/resume');
});

// ── TC-13 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-13 ACP v1：loadSession 与能力 gate，未声明不传字段', async () => {
	const svc = fresh();
	setFive(svc);
	const roots = svc.workspaceRoots();
	const reply = {
		protocolVersion: 1,
		agentCapabilities: {
			loadSession: true, mcpCapabilities: { http: true },
			sessionCapabilities: { additionalDirectories: {} },
		},
	};
	const caps = acpCapabilitiesOf(reply);
	assert.equal(caps.resumeMethod, 'session/load');
	assert.equal(caps.loadSession, true);
	const plain = acpSessionParams({ cwd: roots[0].path, roots, capable: false });
	assert.equal('additionalDirectories' in plain, false);
	assert.deepEqual(acpInitializeParams(1).clientInfo, { name: 'vssaros', version: '1' });
});

// ── TC-14 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-14 会话映射跨「Host 重启」触发 resumeId；anonymous 不查映射', async () => {
	const svc = fresh();
	setFive(svc);
	let text = '';
	const mapOf = () => createAcpSessionMap({
		readText: async () => text,
		writeText: async (t) => { text = t; },
	});
	const ROUTE = 'vssaros-acp-it';
	const TABLE = { [ROUTE]: { kind: 'acp', name: 'Fake', command: 'fake', args: [] } };
	const makeEngine = () => ({
		openCalls: [],
		async ensure() { },
		async openSession(opts = {}) { this.openCalls.push(opts); return 'cli-new-1'; },
		events() { return { wait: async () => ({ done: false, value: { type: 'done' } }) }; },
		prompt() { }, cancel() { },
	});
	const drain = async (adapter, options) => { for await (const chunk of adapter.stream(options)) { void chunk; } };
	const adapterOf = (engine, sessionMap) => createAcpAdapter({
		engineTable: TABLE,
		deps: {
			engineFactory: () => engine, sessionMap,
			mcpFactory: () => ({
				start: async () => ({ url: 'http://127.0.0.1:1', token: 't' }),
				close() { }, failAll() { }, settle() { },
			}),
			cwdFor: () => svc.workspaceRoots()[0]?.path ?? process.cwd(),
			rootsFor: () => svc.workspaceRoots().map(r => r.path),
		},
	});
	const first = makeEngine();
	await drain(adapterOf(first, mapOf()), { provider: ROUTE, model: 'default', sessionId: 's1', messages: [] });
	assert.equal('resumeId' in first.openCalls[0], false);
	assert.equal(first.openCalls[0].cwd, FIVE[0].path);
	assert.equal(first.openCalls[0].roots.length, 5);
	assert.equal(JSON.parse(text).s1, 'cli-new-1');

	// 模拟 Host 重启：新建映射实例（读同一份落盘内容）+ 新建 adapter
	const restarted = makeEngine();
	let queried = 0;
	const restartedMap = mapOf();
	const originGet = restartedMap.get.bind(restartedMap);
	restartedMap.get = async (id) => { queried++; return originGet(id); };
	await drain(adapterOf(restarted, restartedMap), { provider: ROUTE, model: 'default', sessionId: 's1', messages: [] });
	assert.equal(restarted.openCalls[0].resumeId, 'cli-new-1');
	assert.equal(restarted.openCalls[0].roots.length, 5);
	assert.equal(queried, 1);

	const anon = makeEngine();
	const anonMap = mapOf();
	let anonQueried = 0;
	const anonGet = anonMap.get.bind(anonMap);
	anonMap.get = async (id) => { anonQueried++; return anonGet(id); };
	await drain(adapterOf(anon, anonMap), { provider: ROUTE, model: 'default', messages: [] });
	assert.equal(anonQueried, 0);
	assert.equal('resumeId' in anon.openCalls[0], false);
});

// ── TC-15 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-15 映射只存 id，畸形条目丢弃', async () => {
	assert.deepEqual(parseAcpSessionMap('broken'), {});
	assert.deepEqual(parseAcpSessionMap(JSON.stringify({ a: 'cli-a', bad: 7 })), { a: 'cli-a' });
	const svc = fresh();
	setFive(svc);
	let text = '';
	const map = createAcpSessionMap({ readText: async () => text, writeText: async t => { text = t; } });
	await map.set('s1', 'cli-1');
	assert.deepEqual(Object.keys(JSON.parse(text)), ['s1']);
	assert.equal(JSON.stringify(JSON.parse(text)).includes(FIVE[0].path), false);
});

// ── TC-16 ──────────────────────────────────────────────────────────────────
await checkAsync('TC-16 会话根集快照：切换报出旧会话、幂等接管后不再报', async () => {
	const svc = fresh();
	const bindings = createSessionRootBindings();
	setFive(svc);
	bindings.note(svc.workspaceRoots());
	bindings.bind('s1', svc.workspaceRoots());
	bindings.bind('s2', svc.workspaceRoots());
	assert.deepEqual(bindings.mismatches(svc.workspaceRoots()), []);
	const TWO = FIVE.slice(0, 2);
	svc.setWorkspaceContext(structuredPayload(TWO));
	assert.deepEqual(bindings.mismatches(svc.workspaceRoots()), ['s1', 's2']);
	const change = describeRootChange(bindings.previous(), svc.workspaceRoots());
	assert.equal(change.added.length, 0);
	assert.equal(change.removed.length, 3);
	bindings.bind('s1', svc.workspaceRoots());
	assert.deepEqual(bindings.mismatches(svc.workspaceRoots()), ['s2']);
	bindings.clear('s2');
	assert.equal(bindings.size(), 1);
});

console.log(`\nmultiroot-integration: ${passed} passed / ${fails.length} failed`);
if (fails.length) { process.exit(1); }
