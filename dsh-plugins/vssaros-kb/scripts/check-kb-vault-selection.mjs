import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { rootVaultIdOf, serializeRootConfig } from '../lib/core/kbRootConfig.js';
import { setConfiguredRoot } from '../lib/store.js';
import { createFoundationService } from '../../vssaros-foundation/lib/index.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
	try { await fn(); pass++; console.log('PASS ' + name); }
	catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); }
};
const tmp = await mkdtemp(join(tmpdir(), 'kb-vault-selection-'));
const root = join(tmp, 'knowledge-base');
const a = { id: rootVaultIdOf(join(tmp, 'vault-a')), name: 'A', path: join(tmp, 'vault-a') };
const b = { id: rootVaultIdOf(join(tmp, 'vault-b')), name: 'B', path: join(tmp, 'vault-b') };
const stale = '20260922123131-827wo3k';
const config = { dataRoot: tmp, stageDocSources: false, maintainNavigation: false };
const defs = new Map();
const disposers = [];
let handler;
const foundation = createFoundationService();
const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; };
const noop = () => () => {};
const ctx = {
	get: key => key === 'vssarosFoundation' ? foundation : undefined,
	tools: { register: def => { defs.set(def.name, def); return () => defs.delete(def.name); }, get: id => defs.get(id) },
	effect,
	on: noop,
	inject: (deps, cb) => {
		if (deps.includes('webServer')) cb({ effect, connection: { requestRejection: () => undefined }, webServer: { register: spec => { handler = spec.handler; return noop(); } } });
		else if (deps.includes('vssarosFoundation')) cb({ vssarosFoundation: foundation });
		return noop();
	},
};
const sidecar = (active) => writeFile(join(root, '.active-dir.json'), JSON.stringify({ __activeVaultId: active, [stale]: '' }), 'utf8');
const register = async vaults => {
	if (!handler) { return writeFile(join(root, '.extra-vaults.json'), JSON.stringify(vaults), 'utf8'); }
	const existing = JSON.parse(await readFile(join(root, '.extra-vaults.json'), 'utf8'));
	for (const v of existing) assert.equal((await post({ vaultId: v.id }, '/x/kb/api/vault-remove')).status, 200);
	for (const v of vaults) {
		const value = await post({ mode: 'attach', path: v.path, name: v.name }, '/x/kb/api/vault-add');
		assert.equal(value.status, 200);
		v.id = value.body.vault.id;
	}
};
const tool = (name, params) => defs.get(name).execute(params);
const post = async (payload, url = '/x/kb/api/active-dir') => {
	let status, body;
	const req = { method: 'POST', url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
	await handler(req, { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } });
	return { status, body };
};
try {
	await mkdir(root, { recursive: true });
	for (const v of [a, b]) {
		await mkdir(join(v.path, '知识库列表', '测试'), { recursive: true });
		await mkdir(join(v.path, '数据源'), { recursive: true });
		await writeFile(join(v.path, '知识库列表', '测试', 'existing.md'), '# ' + v.name + '\n', 'utf8');
	}
	await register([a]);
	await sidecar(stale);
	apply(ctx, config);
	assert.ok(handler && defs.has('kb_build') && defs.has('kb_write_note'), '必须实际注册 Host 与工具');
	await check('list 正确列出 ext 库，陈旧 sidecar 不污染列表', async () => {
		const value = await tool('kb_list', {});
		assert.deepEqual(value.vaults.map(v => v.id), [a.id]);
	});
	for (const explicit of [false, true]) {
		const params = explicit ? { vaultId: a.id } : {};
		await check('陈旧当前库 + ' + (explicit ? '正确显式 ID' : '无参数') + '：read 使用真实库根', async () => {
			const value = await tool('kb_read', { ...params, uri: '知识库列表/测试/existing.md' });
			assert.equal(value.content.trim(), '# A');
		});
		await check('陈旧当前库 + ' + (explicit ? '正确显式 ID' : '无参数') + '：build preview 选择正确库', async () => {
			const value = await tool('kb_build', { ...params, mode: 'preview' });
			assert.equal(value.vault, a.id);
		});
		await check('陈旧当前库 + ' + (explicit ? '正确显式 ID' : '无参数') + '：write 只落真实库根', async () => {
			const path = '知识库列表/测试/' + (explicit ? 'explicit.md' : 'default.md');
			const value = await tool('kb_write_note', { ...params, path, content: '# Test\n' });
			assert.equal(value.vault, a.id);
			assert.equal(resolve(value.path), resolve(a.path, path));
			assert.equal(await readFile(join(a.path, path), 'utf8'), '# Test\n');
			await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
		});
	}
	await check('未知或非法显式 ID 明确拒绝，不静默改写其它库', async () => {
		for (const id of ['ext-deadbeef', '../escape']) {
			await assert.rejects(tool('kb_read', { vaultId: id, uri: '知识库列表/测试/existing.md' }), /vault|vaultId/);
		}
	});
	await check('HTTP 当前库上报拒绝已失效 ID，并保持原始 sidecar', async () => {
		const before = await readFile(join(root, '.active-dir.json'), 'utf8');
		const value = await post({ vaultId: stale, dir: '' });
		assert.equal(value.status, 400);
		assert.equal(value.body.ok, false);
		assert.equal(await readFile(join(root, '.active-dir.json'), 'utf8'), before);
	});
	await check('HTTP 上报有效 ID 更新当前库，合并保留其它目录记录', async () => {
		const value = await post({ vaultId: a.id, dir: '知识库列表/测试' });
		assert.equal(value.status, 200);
		const saved = JSON.parse(await readFile(join(root, '.active-dir.json'), 'utf8'));
		assert.equal(saved.__activeVaultId, a.id);
		assert.equal(saved[a.id], '知识库列表/测试');
		assert.equal(saved[stale], '');
	});
	await register([a, b]);
	await sidecar(stale);
	await check('多库 + 陈旧当前库：read/build/write 缺参数均明确要求选择', async () => {
		for (const [name, params] of [['kb_read', { uri: '知识库列表/测试/existing.md' }], ['kb_build', { mode: 'preview' }], ['kb_write_note', { path: '知识库列表/测试/must-not-write.md', content: '# Fail' }]]) {
			await assert.rejects(tool(name, params), /请.*(vault|知识库)/);
		}
		await assert.rejects(readFile(join(a.path, '知识库列表/测试/must-not-write.md')), { code: 'ENOENT' });
		await assert.rejects(readFile(join(b.path, '知识库列表/测试/must-not-write.md')), { code: 'ENOENT' });
	});
	await check('多库 + 陈旧当前库：正确显式参数可以读取 B', async () => {
		assert.equal((await tool('kb_read', { vaultId: b.id, uri: '知识库列表/测试/existing.md' })).content.trim(), '# B');
	});
	config.kbActiveVaultId = b.id;
	await check('sidecar 失效时可以采用有效注入当前库', async () => {
		assert.equal((await tool('kb_build', { mode: 'preview' })).vault, b.id);
	});
	delete config.kbActiveVaultId;
	await sidecar(a.id);
	await check('读取显式参数优先，不被另一个有效当前库覆盖', async () => {
		assert.equal((await tool('kb_read', { vaultId: b.id, uri: '知识库列表/测试/existing.md' })).content.trim(), '# B');
	});
	await check('写入保留有效当前库优先策略，并报告 overriddenFrom', async () => {
		const value = await tool('kb_write_note', { vaultId: b.id, path: '知识库列表/测试/current.md', content: '# Current\n' });
		assert.equal(value.vault, a.id);
		assert.equal(value.overriddenFrom, b.id);
		await assert.rejects(readFile(join(b.path, '知识库列表/测试/current.md')), { code: 'ENOENT' });
	});
	await check('file URI 不受歧义/陈旧当前库阻断，库外围栏仍拒绝', async () => {
		await sidecar(stale);
		assert.equal((await tool('kb_read', { uri: pathToFileURL(join(b.path, '知识库列表/测试/existing.md')).href })).content.trim(), '# B');
		const outside = join(tmp, 'outside.md');
		await writeFile(outside, '# Outside');
		await assert.rejects(tool('kb_read', { uri: pathToFileURL(outside).href }), /只允许|范围|库|路径|拒绝/);
	});
	await check('空清单明确拒绝选择，不回退读取容器中的同名文件', async () => {
		await register([]);
		await mkdir(join(root, '知识库列表', '测试'), { recursive: true });
		await writeFile(join(root, '知识库列表', '测试', 'existing.md'), '# Wrong root');
		await assert.rejects(tool('kb_read', { uri: '知识库列表/测试/existing.md' }), /vault|知识库/);
	});
	await check('根即唯一库模式也能忽略旧 ID，写后派生维护正常', async () => {
		setConfiguredRoot(a.path);
		await writeFile(join(a.path, '.active-dir.json'), JSON.stringify({ __activeVaultId: stale }));
		config.maintainNavigation = true;
		const result = await tool('kb_write_note', { path: '知识库列表/测试/derived.md', content: '# Derived\n' });
		assert.equal(result.vault, rootVaultIdOf(a.path));
		assert.ok(result.navigation && !result.navigation.error);
		for (const name of ['index.md', 'overview.md', 'insights.md']) await readFile(join(a.path, '.kb/nav', name));
	});
	await check('页面与面板在加载真实库后上报当前库，失败有可见诊断', async () => {
		const page = await readFile(new URL('./sync-kb-sideview.mjs', import.meta.url), 'utf8');
		const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
		assert.ok(page.includes("post('/active-dir'") && page.includes('await reportCurrentVault(VAULT_ID)'));
		assert.ok(client.includes("post('/active-dir'") && client.includes('await reportCurrentVault(cur.id)'));
		const boot = await readFile(new URL('../lib/web/page-boot.js', import.meta.url), 'utf8');
		assert.ok(boot.includes('await reportCurrentVault(VAULT_ID)'));
	});
	for (const file of ['./sync-kb-sideview.mjs', '../lib/client.js']) {
		const src = await readFile(new URL(file, import.meta.url), 'utf8');
		const reporter = src.match(/^([ \t]*)async function reportCurrentVault\(id\) \{[\s\S]*?^\1\}/m)?.[0];
		const load = (post, state) => {
			assert.ok(reporter, '缺真实上报函数：' + file);
			return new Function('post', 'reportedVault', 'AbortController', 'setTimeout', 'clearTimeout', 'return ' + reporter)(
				post, state, AbortController, (fn, ms) => setTimeout(fn, ms === 15_000 ? 20 : ms), clearTimeout);
		};
		await check(file + '：上报成功才记住当前库，同库刷新不清目录，切新库重新上报', async () => {
			const calls = [], state = { id: '' };
			const report = load(async (path, body) => {
				assert.equal(path, '/active-dir');
				calls.push(body);
				return { ok: true, json: async () => ({ ok: true, vaultId: body.vaultId }) };
			}, state);
			await report(''); await report(a.id); await report(a.id); await report(b.id);
			assert.deepEqual(calls.map(c => c.vaultId), [a.id, b.id]);
			assert.equal(state.id, b.id);
		});
		await check(file + '：上报被拒或响应 ID 错误时不记成功', async () => {
			for (const body of [{ ok: false, error: '库已移除' }, { ok: true, vaultId: 'wrong' }]) {
				const state = { id: '' };
				await assert.rejects(load(async () => ({ ok: true, json: async () => body }), state)(a.id), /库已移除|当前知识库未保存/);
				assert.equal(state.id, '');
			}
		});
		await check(file + '：网络/正文挂起有界超时，不覆盖已确认库', async () => {
			for (const hangBody of [false, true]) {
				const state = { id: a.id };
				let signal;
				const report = load(async (_, __, init) => {
					signal = init.signal;
					return hangBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
				}, state);
				await assert.rejects(report(b.id), /上报超时/);
				assert.equal(signal.aborted, true);
				assert.equal(state.id, a.id);
			}
		});
	}
	await check('反向突变：恢复旧选择器会重现正确显式 ID 被陈旧状态覆盖', async () => {
		const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
		const selector = src.match(/async function vaultWantedOf\([\s\S]*?\n\}/)?.[0];
		assert.ok(selector);
		const mutated = selector.replace("[active, configured].find(id => validIds.has(id)) || ''", "active || configured");
		assert.notEqual(mutated, selector);
		const run = new Function('readActiveVault', 'readFile', 'kbRootOf', 'listAllVaults', 'isVaultId', 'return ' + mutated)(
			async () => stale, readFile, () => root, async () => ({ vaults: [{ id: a.id, dir: a.path }] }), () => true);
		assert.equal((await run({ vaultId: a.id }, {})).vaultId, stale);
	});
} finally {
	for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
	setConfiguredRoot('');
	await rm(tmp, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
