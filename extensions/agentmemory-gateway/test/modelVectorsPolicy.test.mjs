/*---------------------------------------------------------------------------------------------
 *  Model 向量降级策略单测 + 源码结构守卫（2026-10-21）
 *
 *  运行：node --test extensions/agentmemory-gateway/test/modelVectorsPolicy.test.mjs
 *
 *  锁死两件事：
 *  ① 策略本身：Worker 不可用时**默认不落主线程**（旧行为会阻塞网关 35–150s）；
 *     只有显式 AGENTMEMORY_MODEL_EMBEDDING_MAINTHREAD=1 才允许旧行为。
 *  ② 源码结构：host.mjs 里**只有一个** embedding 调用点，且它**必须**在策略判定之后
 *     （否则策略形同虚设 —— 这条守卫正是为了防「改了策略但忘了改调用点」）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideFallback, MAINTHREAD_ENV, mainThreadEmbeddingAllowed } from '../host/modelVectorsPolicy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_FILE = path.join(__dirname, '..', 'host', 'host.mjs');
const HOST_SRC = fs.readFileSync(HOST_FILE, 'utf8');

test('mainThreadEmbeddingAllowed：默认关，只有显式 =1 才开', () => {
	assert.equal(mainThreadEmbeddingAllowed({}), false);
	assert.equal(mainThreadEmbeddingAllowed({ [MAINTHREAD_ENV]: '0' }), false);
	assert.equal(mainThreadEmbeddingAllowed({ [MAINTHREAD_ENV]: 'true' }), false);
	assert.equal(mainThreadEmbeddingAllowed({ [MAINTHREAD_ENV]: '1' }), true);
});

test('decideFallback：Worker 可用 ⇒ 用 Worker', () => {
	const p = decideFallback({ workerAvailable: true, allowMainThread: false, mode: 'trigram' });
	assert.equal(p.action, 'use-worker');
});

test('decideFallback：Worker 不可用 + 不允许主线程 ⇒ 保持 model / 保持 trigram（**不阻塞**）', () => {
	const m = decideFallback({ workerAvailable: false, allowMainThread: false, mode: 'model', pendingCount: 7 });
	assert.equal(m.action, 'keep-model');
	assert.equal(m.pendingCount, 7);
	const t = decideFallback({ workerAvailable: false, allowMainThread: false, mode: 'trigram' });
	assert.equal(t.action, 'keep-trigram');
	assert.equal(decideFallback({ workerAvailable: false, allowMainThread: false, mode: 'model' }).action, 'keep-model');
});

test('decideFallback：显式允许 ⇒ 旧行为（主线程 embedding）', () => {
	const p = decideFallback({ workerAvailable: false, allowMainThread: true, mode: 'trigram' });
	assert.equal(p.action, 'embed-on-main-thread');
});

test('decideFallback：缺参数不炸（按最保守处理：保持 trigram）', () => {
	assert.equal(decideFallback({}).action, 'keep-trigram');
	assert.equal(decideFallback(undefined).action, 'keep-trigram');
});

/**
 * 源码结构守卫（纯函数，便于做反向突变验证）。
 * @param {string} src
 * @returns {string[]} 问题列表（空 = 通过）
 */
function scanHost(src) {
	const problems = [];
	// R1：唯一的 embedding 调用点
	const embedCalls = src.match(/await EmbedFn\(/g) || [];
	if (embedCalls.length !== 1) { problems.push(`embedding 调用点应为 1 个，实际 ${embedCalls.length} 个`); }
	// R2：该调用点必须在 embedItemsOnMainThread 函数体内
	const fnIdx = src.indexOf('async function embedItemsOnMainThread(');
	const embedIdx = src.indexOf('await EmbedFn(');
	if (fnIdx < 0) { problems.push('找不到 embedItemsOnMainThread 函数'); }
	else if (embedIdx < fnIdx) { problems.push('embedding 调用点不在 embedItemsOnMainThread 内'); }
	// R3：策略判定 + 降级分支 + continue 三者必须成组出现
	const guardRe = /if \(plan\.action !== 'embed-on-main-thread'\) \{\s*keepExistingVectors\([\s\S]{0,160}?\);\s*continue;\s*\}/;
	if (!guardRe.test(src)) { problems.push('缺少「策略 ⇒ 降级 ⇒ continue」的守卫分支'); }
	// R4：所有 embedItemsOnMainThread 调用点必须在守卫之后
	const guardIdx = src.search(guardRe);
	if (guardIdx < 0) { problems.push('找不到守卫分支位置（无法判定调用点顺序）'); }
	else {
		const callRe = /embedItemsOnMainThread\(/g;
		let m;
		while ((m = callRe.exec(src)) !== null) {
			const at = m.index;
			const before = src.slice(Math.max(0, at - 40), at);
			if (before.includes('async function')) { continue; }
			if (at < guardIdx) { problems.push(`embedItemsOnMainThread 调用点（${at}）在守卫（${guardIdx}）之前`); }
		}
	}
	// R5：必须真的用了策略模块
	if (!src.includes("from './modelVectorsPolicy.mjs'")) { problems.push('host.mjs 未导入 modelVectorsPolicy.mjs'); }
	if (!/mainThreadEmbeddingAllowed\(/.test(src)) { problems.push('host.mjs 未使用 mainThreadEmbeddingAllowed'); }
	if (!/decideFallback\(/.test(src)) { problems.push('host.mjs 未使用 decideFallback'); }
	return problems;
}

test('源码结构守卫：当前 host.mjs 通过', () => {
	assert.deepEqual(scanHost(HOST_SRC), [], 'host.mjs 结构必须满足守卫');
});

test('源码结构守卫：**反向突变**验证（故意改坏 ⇒ 必须变红）', () => {
	// M1：去掉守卫分支里的 continue（策略形同虚设）
	const m1 = HOST_SRC.replace(/(if \(plan\.action !== 'embed-on-main-thread'\) \{[\s\S]{0,160}?);\s*continue;\s*\}/, '$1 }');
	assert.ok(scanHost(m1).length > 0, 'M1（去掉 continue）应变红');
	// M2：把动作名改掉（守卫条件再也匹配不上）
	const m2 = HOST_SRC.replace("plan.action !== 'embed-on-main-thread'", "plan.action !== 'embed-on-mainthread'");
	assert.ok(scanHost(m2).length > 0, 'M2（动作名改错）应变红');
	// M3：在守卫之前插入一个 embedding 调用点
	const m3 = HOST_SRC.replace('const plan = decideFallback({', 'await embedItemsOnMainThread([], vi, agentId);\n\t\t\tconst plan = decideFallback({');
	assert.ok(scanHost(m3).length > 0, 'M3（守卫前插入调用点）应变红');
	// M4：再造一个 embedding 调用点（绕过唯一入口）
	const m4 = HOST_SRC.replace('await EmbedFn(items[i].content);', 'await EmbedFn(items[i].content);\n\t\tconst extra = await EmbedFn(items[i].content);');
	assert.ok(scanHost(m4).length > 0, 'M4（第二个 embedding 调用点）应变红');
	// M5：不导入策略模块
	const m5 = HOST_SRC.replace("from './modelVectorsPolicy.mjs'", "from './nowhere.mjs'");
	assert.ok(scanHost(m5).length > 0, 'M5（去掉策略模块导入）应变红');
});
