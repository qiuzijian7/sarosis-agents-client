import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as create from '../lib/create.js';
import { draftFromAgentMd, normalizeDraft, serializeAgentMd } from '../lib/core/create.js';
import { agentsRootOf, parseAgentSource, registerAgentSource, scanAgentsFromConfig } from '../lib/store.js';

const ID = 'wb-audit-reviewer';
const OWNER = 'workbench:audit';
const textOf = (fields = {}) => serializeAgentMd(normalizeDraft({
	id: 'reviewer', name: '插件审查员', description: '版本一', persona: '插件人格一。',
	skills: ['audit'], tools: ['read'], ...fields,
}));
const writeAgent = async (root, id, text) => {
	const dir = join(root, id);
	await mkdir(dir, { recursive: true });
	const file = join(dir, '.agent.md');
	await writeFile(file, text, 'utf8');
	return file;
};
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'vssaros-plugin-overrides-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = { dataRoot: join(root, 'data'), dshHome: join(root, 'dsh'), agentsBuiltinRoot: join(root, 'builtin') };
	const bots = join(config.dshHome, 'installed', 'audit', 'bots');
	const file = await writeAgent(bots, 'reviewer', textOf());
	let dispose;
	const register = async (text) => {
		dispose?.();
		if (text !== undefined) { await writeFile(file, text, 'utf8'); }
		const source = await parseAgentSource({ owner: OWNER, root: bots, ids: { reviewer: ID }, skills: { audit: 'wb-audit-skill' }, tools: { read: 'wb-audit-read' } });
		dispose = registerAgentSource(config, source);
	};
	await register();
	t.after(() => dispose?.());
	return { config, file, register, removeSource: () => dispose(), userFile: join(agentsRootOf(config), ID, '.agent.md') };
}
const rowOf = async (config) => (await scanAgentsFromConfig(config)).agents.find(row => row.id === ID);

test('插件 draft 按注册扫描事实回填，路径仍是包内真实文件，读取不创建用户副本', async (t) => {
	const f = await fixture(t);
	const row = await rowOf(f.config);
	assert.equal(row.file, f.file);
	assert.equal(row.sourceOwner, OWNER);
	const raw = await readFile(f.file, 'utf8');
	assert.equal(draftFromAgentMd(raw).draft.persona, '插件人格一。');
	const result = await create.readAgentDraft(f.config, ID);
	assert.equal(result.id, ID);
	assert.equal(result.draft.id, ID);
	assert.equal(result.file, f.file);
	assert.equal(result.draft.persona, '插件人格一。');
	assert.deepEqual(normalizeDraft(result.draft).skills, ['wb-audit-skill']);
	assert.deepEqual(normalizeDraft(result.draft).tools, ['wb-audit-read']);
	await assert.rejects(readFile(f.userFile), { code: 'ENOENT' });
	assert.equal(await readFile(f.file, 'utf8'), raw);
});

test('插件保存只写用户 runtimeId/.agent.md，并只记录实际修改字段', async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.file, 'utf8');
	const { draft } = await create.readAgentDraft(f.config, ID);
	const updated = await create.updateAgentFromDraft(f.config, ID, { ...draft, name: '我的审查员' });
	assert.equal(updated.file, f.userFile);
	assert.equal(updated.overrodePlugin, true);
	assert.equal(await readFile(f.file, 'utf8'), before);
	const row = await rowOf(f.config);
	assert.equal(row.name, '我的审查员');
	assert.equal(row.sourceOwner, OWNER);
	assert.deepEqual(row.pluginOverrides.delta, { name: '我的审查员' });
});

test('插件升级：已修改字段保留，未修改人格/描述/工具随新定义变化', async (t) => {
	const f = await fixture(t);
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, name: '用户名字' });
	await f.register(textOf({ name: '版本二名字', description: '版本二', persona: '插件人格二。', tools: ['read', 'search'] }));
	const row = await rowOf(f.config);
	assert.equal(row.name, '用户名字');
	assert.equal(row.description, '版本二');
	assert.equal(row.persona, '插件人格二。');
	assert.deepEqual(row.tools, ['wb-audit-read', 'search']);
	const next = await create.readAgentDraft(f.config, ID);
	assert.equal(next.draft.name, '用户名字');
	assert.equal(next.draft.persona, '插件人格二。');
	await create.updateAgentFromDraft(f.config, ID, { ...next.draft, role: '用户角色' });
	await f.register(textOf({ description: '版本三', persona: '插件人格三。' }));
	assert.equal((await rowOf(f.config)).persona, '插件人格三。');
	assert.equal((await rowOf(f.config)).role, '用户角色');
});

test('插件覆写可清空列表与正文，升级不把显式清空恢复', async (t) => {
	const f = await fixture(t);
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, skills: [], tools: [], persona: '' });
	await f.register(textOf({ persona: '新的插件人格。', skills: ['new-skill'], tools: ['search'] }));
	const row = await rowOf(f.config);
	assert.deepEqual(row.skills, []);
	assert.deepEqual(row.tools, []);
	assert.equal(row.persona, '');
});

test('重置仅删除插件覆写文件，插件及用户记忆保持不动', async (t) => {
	const f = await fixture(t);
	assert.equal(typeof create.resetAgentOverrides, 'function');
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, name: '用户名字' });
	const memory = join(agentsRootOf(f.config), ID, 'memory', 'MEMORY.md');
	await mkdir(join(agentsRootOf(f.config), ID, 'memory'), { recursive: true });
	await writeFile(memory, '用户记忆', 'utf8');
	const before = await readFile(f.file, 'utf8');
	await create.resetAgentOverrides(f.config, ID);
	await assert.rejects(readFile(f.userFile), { code: 'ENOENT' });
	assert.equal(await readFile(memory, 'utf8'), '用户记忆');
	assert.equal(await readFile(f.file, 'utf8'), before);
	assert.equal((await rowOf(f.config)).source, 'plugin');
	assert.equal((await rowOf(f.config)).name, '插件审查员');
});

test('插件已卸载时用户快照仍可读取编辑，保留覆写来源元数据', async (t) => {
	const f = await fixture(t);
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, name: '用户名字' });
	f.removeSource();
	const next = await create.readAgentDraft(f.config, ID);
	assert.equal(next.draft.name, '用户名字');
	assert.equal(next.draft.persona, '插件人格一。');
	await create.updateAgentFromDraft(f.config, ID, { ...next.draft, role: '离线修改' });
	await f.register(textOf({ description: '重新安装', persona: '新插件人格。' }));
	const row = await rowOf(f.config);
	assert.equal(row.name, '用户名字');
	assert.equal(row.role, '离线修改');
	assert.equal(row.persona, '新插件人格。');
});

test('普通用户同 id 副本优先，不因插件注册/升级被转为 delta 或重置删除', async (t) => {
	const f = await fixture(t);
	await writeAgent(agentsRootOf(f.config), ID, textOf({ name: '独立用户', persona: '用户完整定义。' }));
	const before = await readFile(f.userFile, 'utf8');
	await f.register(textOf({ name: '升级插件' }));
	assert.equal(await readFile(f.userFile, 'utf8'), before);
	assert.equal((await create.readAgentDraft(f.config, ID)).draft.name, '独立用户');
	assert.equal(typeof create.resetAgentOverrides, 'function');
	await assert.rejects(() => create.resetAgentOverrides(f.config, ID), e => e.httpStatus === 409);
	assert.equal(await readFile(f.userFile, 'utf8'), before);
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, role: '编辑独立用户' });
	assert.doesNotMatch(await readFile(f.userFile, 'utf8'), /plugin-overrides:/);
});

test('插件名已占 id，新建冲突不会产生用户覆写；路径穿越拒绝', async (t) => {
	const f = await fixture(t);
	await assert.rejects(() => create.createAgentFromDraft(f.config, { id: ID, name: '新建冲突' }), e => e.httpStatus === 409);
	await assert.rejects(readFile(f.userFile), { code: 'ENOENT' });
	await assert.rejects(() => create.readAgentDraft(f.config, '../escape'), e => e.httpStatus === 400);
});

test('插件委派/记忆写入口也走用户覆写层，不直接改包内定义', async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.file, 'utf8');
	await create.setAgentSubagent(f.config, ID, true);
	assert.equal((await rowOf(f.config)).delegatable, true);
	await create.setAgentMemoryLimits(f.config, ID, { chars: 4096, mode: 'live' });
	assert.equal((await rowOf(f.config)).memoryChars, 4096);
	assert.equal((await rowOf(f.config)).memoryMode, 'live');
	assert.equal(await readFile(f.file, 'utf8'), before);
	assert.equal((await rowOf(f.config)).pluginOverrides.delta.delegatable, true);
});

test('保存工具/MCP声明不批准权限，模型仍仅由会话选择策略消费', async (t) => {
	const f = await fixture(t);
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, tools: ['read', 'mcp__audit__*', '!mcp__audit__danger'], model: 'provider/model' });
	const row = await rowOf(f.config);
	assert.deepEqual(row.tools, ['read', 'mcp__audit__*', '!mcp__audit__danger']);
	assert.equal(row.model, 'provider/model');
	const text = await readFile(f.userFile, 'utf8');
	assert.doesNotMatch(text, /(?:approved|trusted|auto-approve|approval):/);
	assert.equal(await readFile(f.file, 'utf8'), textOf());
});

test('数组注册来源无需文件即可回填和保存；安装包能力在用户快照中保留', async (t) => {
	const f = await fixture(t);
	f.removeSource();
	const dispose = registerAgentSource(f.config, { owner: OWNER, agents: [{ id: ID, name: '数组Bot', systemPrompt: '数组人格', tools: ['read'], capabilities: ['browser'], suggestions: ['检查内容'], subagents: false }] });
	t.after(dispose);
	const { draft } = await create.readAgentDraft(f.config, ID);
	assert.equal(draft.persona, '数组人格');
	await create.updateAgentFromDraft(f.config, ID, { ...draft, name: '用户数组Bot' });
	dispose();
	const row = await rowOf(f.config);
	assert.equal(row.name, '用户数组Bot');
	assert.deepEqual(row.capabilities, ['browser']);
	assert.deepEqual(row.suggestions, ['检查内容']);
	assert.equal(row.subagents, false);
});

test('插件覆写来源冲突与坏JSON明确拒绝，不覆盖或重置用户文件', async (t) => {
	const f = await fixture(t);
	const snapshot = textOf({ name: '用户快照' });
	for (const marker of ['{"version":1,"owner":"workbench:other","delta":{"name":"别的来源"}}', '{bad-json']) {
		const text = snapshot.replace(/^---\n/, '---\nplugin-overrides: ' + marker + '\n');
		await writeAgent(agentsRootOf(f.config), ID, text);
		await assert.rejects(() => create.updateAgentFromDraft(f.config, ID, { name: '试图保存' }), error => [400, 409].includes(error.httpStatus));
		await assert.rejects(() => create.resetAgentOverrides(f.config, ID), error => [400, 409].includes(error.httpStatus));
		assert.equal(await readFile(f.userFile, 'utf8'), text);
	}
});

test('插件未映射模型重置也只写用户覆写，保留原有模型映射保护规则', async (t) => {
	const f = await fixture(t);
	await f.register(textOf({ model: 'unmapped-model' }));
	const before = await readFile(f.file, 'utf8');
	const reset = await create.resetAgentModel(f.config, ID);
	assert.equal(reset.file, f.userFile);
	assert.equal(reset.oldModel, 'unmapped-model');
	assert.equal((await rowOf(f.config)).model ?? '', '');
	assert.equal(await readFile(f.file, 'utf8'), before);
	await assert.rejects(() => create.resetAgentModel(f.config, ID), error => error.httpStatus === 409);
});

test('Host registerSource(root) 的实际 Bot row 可直接用于设置草稿与用户覆写', async (t) => {
	const f = await fixture(t);
	f.removeSource();
	const services = new Map();
	const cleanups = [];
	const definitions = new Map();
	const noop = () => undefined;
	const agentPresets = {
		register: async definition => {
			definitions.set(definition.id, definition);
			return () => definitions.delete(definition.id);
		},
		list: async () => [...definitions.values()],
	};
	const ctx = {
		tools: { register: () => noop, get: noop },
		logger: () => ({ info: noop, warn: noop, error: noop }),
		on: () => noop,
		reflect: { get: name => services.get(name) },
		provide: (name, value) => services.set(name, value),
		inject: (dependencies, callback) => {
			if (dependencies.join(',') === 'agentPresets') { callback({ agentPresets, effect: ctx.effect }); }
		},
		effect: fn => {
			const cleanup = fn();
			if (typeof cleanup === 'function') { cleanups.push(cleanup); }
			return cleanup;
		},
	};
	t.after(async () => { for (const cleanup of cleanups.reverse()) { await cleanup(); } });
	const { apply } = await import('../lib/index.js');
	apply(ctx, { ...f.config, presetMode: 'eager' });
	const service = services.get('vssarosAgents');
	assert.equal(typeof service.registerSource, 'function');
	const dispose = await service.registerSource({ owner: OWNER, root: join(f.config.dshHome, 'installed', 'audit', 'bots'), ids: { reviewer: ID }, skills: { audit: 'wb-audit-skill' }, tools: { read: 'wb-audit-read' } });
	t.after(dispose);
	const row = await rowOf(f.config);
	assert.equal(row.file, f.file);
	assert.equal(row.sourceOwner, OWNER);
	const { draft } = await create.readAgentDraft(f.config, ID);
	assert.deepEqual(draft.skills, ['wb-audit-skill']);
	assert.equal(draft.persona, draftFromAgentMd(await readFile(f.file, 'utf8')).draft.persona);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, name: 'Host 用户覆写' });
	await service.rescan();
	assert.equal(definitions.get('vssaros-' + ID).name, 'Host 用户覆写');
	assert.equal(await readFile(f.file, 'utf8'), textOf());
});

test('插件升级恰好追平用户字段后再次保存，仍保留用户曾修改的字段', async (t) => {
	const f = await fixture(t);
	await create.updateAgentFromDraft(f.config, ID, { name: '用户名字' });
	await f.register(textOf({ name: '用户名字', description: '追平版本' }));
	const { draft } = await create.readAgentDraft(f.config, ID);
	await create.updateAgentFromDraft(f.config, ID, { ...draft, role: '用户角色' });
	assert.equal((await rowOf(f.config)).pluginOverrides.delta.name, '用户名字');
	await f.register(textOf({ name: '下一版插件名字' }));
	assert.equal((await rowOf(f.config)).name, '用户名字');
});
