#!/usr/bin/env node
// 引擎徽标映射单测（真源 lib/core/badge.js）。
import assert from 'node:assert/strict';
import { LOCAL_AGENT_BADGES, localAgentBadgeOf } from '../lib/core/badge.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

check('六个内置引擎都能映射', () => {
	for (const [route, name] of Object.entries(LOCAL_AGENT_BADGES)) {
		assert.equal(localAgentBadgeOf(route), name);
		assert.equal(localAgentBadgeOf(`${route}/default`), name);
	}
	assert.equal(Object.keys(LOCAL_AGENT_BADGES).length, 6);
});

check('provider/model 文本、大小写、前后空格都归一', () => {
	assert.equal(localAgentBadgeOf('  VSSAROS-CODEX-CLI/sonnet  '), 'Codex CLI');
	assert.equal(localAgentBadgeOf('model: vssaros-opencode/default'), undefined, '带前缀的整行不猜');
});

check('自定义 ACP agent 归一类；非本地 Agent 与普通 provider 都不出徽标', () => {
	assert.equal(localAgentBadgeOf('vssaros-acp-myagent/default'), '自定义 ACP Agent');
	assert.equal(localAgentBadgeOf('vssaros-codebuddy/hy4'), undefined);
	assert.equal(localAgentBadgeOf('openai/gpt-4o'), undefined);
	for (const value of ['', undefined, null, 42, {}]) assert.equal(localAgentBadgeOf(value), undefined);
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
