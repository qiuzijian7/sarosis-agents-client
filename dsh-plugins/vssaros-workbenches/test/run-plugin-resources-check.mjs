import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginResourceRegistry } from '../lib/pluginResources.js';

const root = await mkdtemp(join(tmpdir(), 'vssaros-plugin-resources-'));
try {
	await mkdir(join(root, 'skills/help'), { recursive: true });
	await writeFile(join(root, 'skills/help/SKILL.md'), '---\nname: help\ndescription: Help\n---\nInstructions');
	await mkdir(join(root, 'lib/tools'), { recursive: true });
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await writeFile(join(root, 'lib/tools/ping.js'), 'export const definition = {name:"ping",description:"Ping",parameters:{type:"object",properties:{}},output:{schema:{type:"string"},render:String},execute:async()=>"pong"};');
	const plan = { packageName: '@demo/desk', version: '1.0.0', workbench: { title: 'Demo' }, resources: { bots: [], skills: [{ id: 'help', runtimeId: 'wb-help', path: 'skills/help/SKILL.md' }], tools: [{ id: 'ping', runtimeId: 'wb-ping', path: 'lib/tools/ping.js' }], mcp: [] } };
	let skillProvider;
	let tool;
	let disposed = 0;
	let registry = createPluginResourceRegistry();
	const stop = await registry.register({ root, plan });
	assert.equal(registry.status('@demo/desk').resources.skills[0].state, 'awaiting-service');
	await registry.setService('skills', { registerProvider: factory => { skillProvider = factory({ invalidate() {} }); return () => { disposed++; }; } });
	await registry.setService('tools', { register: def => { tool = def; return () => { disposed++; }; } });
	const candidates = await skillProvider.list();
	assert.equal(candidates[0].name, 'wb-help');
	assert.ok((await skillProvider.get(candidates[0])).content.includes('Instructions'));
	assert.equal(await tool.execute({}), 'pong');
	assert.equal(registry.status('@demo/desk').resources.tools[0].state, 'registered');
	await assert.rejects(registry.register({ root, plan }), /重复/);
	await stop();
	assert.equal(disposed, 2);
	assert.equal(registry.status('@demo/desk'), null);
	const empty = await registry.register({ root, plan: { ...plan, resources: { bots: [], skills: [], tools: [], mcp: [] } } });
	assert.deepEqual(registry.status('@demo/desk').resources, { bots: [], skills: [], tools: [], mcp: [] });
	await empty();
	await registry.stop();
	registry = createPluginResourceRegistry();
	await mkdir(join(root, 'bots/helper'), { recursive: true });
	await writeFile(join(root, 'bots/helper/.agent.md'), '---\nname: Helper\nskills: help\ntools: ping, mcp__remote__*\n---\nHelp users.');
	await mkdir(join(root, 'mcp/remote'), { recursive: true });
	await writeFile(join(root, 'mcp/remote/config.json'), '{"type":"stdio","command":"node","args":["server.js"]}');
	const { parseAgentSource } = await import('../../vssaros-agents/lib/store.js');
	const { presetIdOf } = await import('../../vssaros-agents/lib/core/agents.js');
	let parsedBot;
	let capturedMcp;
	const both = await registry.register({ root, plan: { ...plan, workbench: { title: 'Demo', defaultBot: 'helper' }, resources: {
		...plan.resources, bots: [{ id: 'helper', runtimeId: 'wb-helper', path: 'bots/helper/.agent.md' }],
		mcp: [{ id: 'remote', runtimeId: 'wb-remote', path: 'mcp/remote/config.json' }],
	} } });
	await registry.setService('bots', { presetIdOf, registerSource: async request => { parsedBot = await parseAgentSource(request); return () => {}; } });
	await registry.setService('mcp', { ready: Promise.resolve(), registerSource: async request => { capturedMcp = request; return () => {}; } });
	await registry.refresh();
	assert.equal(parsedBot.agents[0].id, 'wb-helper');
	assert.deepEqual(parsedBot.agents[0].skills, ['wb-help']);
	assert.deepEqual(parsedBot.agents[0].tools, ['wb-ping', 'mcp__wb-remote__*']);
	assert.equal(capturedMcp.servers['wb-remote'].approved, false);
	assert.equal(capturedMcp.servers['wb-remote'].cwd, await realpath(join(root, 'mcp/remote')));
	assert.equal(registry.status('@demo/desk').defaultPreset, presetIdOf('wb-helper'));
	await both();
	await registry.stop();
	console.log('[plugin-resources] lifecycle, optional resources, Bot mappings, MCP, skills and tools passed');
} finally { await rm(root, { recursive: true, force: true }); }
