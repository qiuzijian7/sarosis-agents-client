import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/client.conversationViews.js', import.meta.url), 'utf8');
const dependencies = await readFile(new URL('../lib/client.dependencies.js', import.meta.url), 'utf8');
const start = source.indexOf('function BotConfigCard(props)');
const end = source.indexOf('\n\t\tfunction SkillsView', start);
assert.ok(start >= 0 && end > start);
const component = source.slice(start, end);

function fixture(hasOverrides = true, confirmed = true) {
	const values = [null, false, '', ''];
	const refs = [{ current: '' }];
	const effects = [];
	const posts = [];
	let stateIndex = 0;
	let refIndex = 0;
	let reloads = 0;
	const data = { hasOverrides, sourceOwner: '@demo/bot', draft: { name: 'Helper', tools: ['read', 'mcp__demo__*'], skills: ['review'], persona: 'Help' } };
	const react = {
		useState: () => { const index = stateIndex++; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
		useRef: () => refs[refIndex++],
		useEffect: fn => effects.push(fn),
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
	};
	const Card = new Function('react', 'useLoader', 'getJson', 'postJson', 'C', 'kids', 'BotChannelBindingsCard', 'window', 'localAgentBadgeOf', component + '\nreturn BotConfigCard;')(
		react, () => [{ data }, () => { reloads++; }], () => Promise.resolve(data), async (url, body) => { posts.push({ url, body }); return { ok: true }; }, {}, items => items.filter(Boolean), () => null,
		{ confirm: () => confirmed }, () => '',
	);
	const render = () => { stateIndex = 0; refIndex = 0; effects.length = 0; const tree = Card({ agentId: 'wb-demo-helper' }); for (const fn of effects) { fn(); } return tree; };
	const find = (tree, predicate) => { if (!tree || typeof tree !== 'object') { return null; } if (predicate(tree)) { return tree; } for (const child of tree.children ?? []) { const hit = find(child, predicate); if (hit) { return hit; } } return null; };
	render();
	return { render, find, posts, refs, get reloads() { return reloads; }, data };
}

test('dsh left-sidebar settings includes dependency components flow and bridge actions', () => {
	assert.match(dependencies, /function DependenciesSection\(\)/);
	assert.match(dependencies, /data-vssaros-dependencies-section/);
	assert.match(dependencies, /pageBridge\.componentsStatus\(\)/);
	assert.match(dependencies, /pageBridge\.installComponent\(id/);
	assert.match(dependencies, /settings\.section/);
	for (const label of ['检测', '官方源', '安装', '校验', '生效', '依赖与组件']) {
		assert.ok(dependencies.includes(label), `设置分区安装流程缺「${label}」`);
	}
});

test('Bot settings saves tools/MCP bindings and exposes reset only for actual overrides', async () => {
	const f = fixture();
	const tree = f.render();
	const tools = f.find(tree, row => row.props['data-vssaros-botcfg-tools']);
	assert.equal(tools.props.value, 'read,mcp__demo__*');
	tools.props.onChange({ target: { value: 'read, mcp__demo__query' } });
	const next = f.render();
	const save = f.find(next, row => row.props.key === 's');
	await save.props.onClick();
	assert.equal(f.posts[0].body.action, 'update');
	assert.equal(f.posts[0].body.draft.tools, 'read, mcp__demo__query');
	assert.ok(f.find(next, row => row.props['data-vssaros-botcfg-reset']));
	f.data.hasOverrides = false;
	assert.equal(f.find(f.render(), row => row.props['data-vssaros-botcfg-reset']), null);
});

test('reset confirms user intent, clears stale form initialization and reloads', async () => {
	const f = fixture();
	const reset = f.find(f.render(), row => row.props['data-vssaros-botcfg-reset']);
	await reset.props.onClick();
	assert.deepEqual(f.posts[0].body, { action: 'resetOverrides', id: 'wb-demo-helper' });
	assert.equal(f.refs[0].current, '');
	assert.equal(f.reloads, 1);
	const cancelled = fixture(true, false);
	await cancelled.find(cancelled.render(), row => row.props['data-vssaros-botcfg-reset']).props.onClick();
	assert.equal(cancelled.posts.length, 0);
});
