/*---------------------------------------------------------------------------------------------
 *  pruneScopes.test.mjs — 子代理 scope 覆盖面的回归（2026-11-02）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/pruneScopes.test.mjs
 *
 *  锁死两件事：
 *   ① 覆盖面：**每一族** `mem:<族>:subagent-<id>` 都要被抓到（含两级 scope `mem:obs:<id>:<sid>`）。
 *      原来逐族枚举只写了 3 个 ⇒ slots/profiles/lessons/access/retention/graph 永久滞留
 *      （实测 dev 库 557 行空槽位就是这么攒出来的）。
 *   ② 不误伤：真实 agent 的 scope 一律不能匹配（`default` / `ws-*` / 人设名）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUBAGENT_SCOPE_LIKE, isSubagentScope, likeToRegExp } from '../host/pruneScopes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('★ 覆盖面：各族子代理 scope 全部命中', () => {
	const families = [
		'memories', 'semantic', 'obs', 'slots', 'profiles', 'lessons', 'access',
		'retention', 'procedural', 'summaries', 'core-memory', 'insights', 'state',
	];
	for (const family of families) {
		assert.equal(isSubagentScope(`mem:${family}:subagent-1785037203046-tfk2xw54c`), true,
			`未覆盖 ${family}（这正是原来漏掉 slots 的方式）`);
	}
	// 两级 scope（obs 是 `mem:obs:<agent>:<session>`）
	assert.equal(isSubagentScope('mem:obs:subagent-123:sess_abc'), true, '两级 scope 必须命中');
	// 图谱族的段位不同（`mem:graph:nodes:<agent>`）
	assert.equal(isSubagentScope('mem:graph:nodes:subagent-123'), true, 'graph 族必须命中');
	return 'ok';
});

test('★ 不误伤：真实 agent / 工作区 / 空值一律不匹配', () => {
	const safe = [
		'mem:memories:default',
		'mem:memories:gr-gc-expert',
		'mem:slots:ws-saros-agents-client-ncshv',
		'mem:core-memory:knowledge-base-expert',
		'mem:meta',
		'mem:obs:subagent',       // 只是名字前缀，不是 `subagent-<id>`
		'',
	];
	for (const scope of safe) {
		assert.equal(isSubagentScope(scope), false, `不该匹配：${scope}`);
	}
	return 'ok';
});

test('likeToRegExp：% 与 _ 语义正确', () => {
	assert.equal(likeToRegExp('a%b').test('aXXb'), true);
	assert.equal(likeToRegExp('a%b').test('a'), false);
	assert.equal(likeToRegExp('a_b').test('axb'), true);
	assert.equal(likeToRegExp('a.b').test('a.b'), true, '点号必须转义（不能当通配）');
	assert.equal(likeToRegExp('a.b').test('axb'), false);
	return 'ok';
});

test('★ 调用点：host.mjs 的剪枝 SQL 必须使用该模式', () => {
	const hostFile = path.join(__dirname, '..', 'host', 'host.mjs');
	const src = fs.readFileSync(hostFile, 'utf8');
	assert.ok(src.includes('SUBAGENT_SCOPE_LIKE'), 'host.mjs 必须 import 并使用 SUBAGENT_SCOPE_LIKE');
	assert.ok(src.includes('scope LIKE \'${SUBAGENT_SCOPE_LIKE}\''), '剪枝 SQL 必须真的用它拼 LIKE');
	// 反向：不能再回到逐族枚举（那正是漏掉 slots 的写法）
	assert.ok(!src.includes("scope LIKE 'mem:semantic:subagent-%'"),
		'不得回退成逐族枚举（会再次漏掉 slots/profiles/…）');
	assert.equal(SUBAGENT_SCOPE_LIKE, 'mem:%:subagent-%');
});
