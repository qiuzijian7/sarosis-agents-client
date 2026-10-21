/*---------------------------------------------------------------------------------------------
 *  cjkSegmenter.test.ts — 中文分词守卫（2026-10-21）
 *
 *  锁死两件事：
 *  ① 装上 @node-rs/jieba 且宿主注入 require 垫片后，**真在用 jieba**（不是悄悄降级 bigram）；
 *  ② 没有垫片时**明确降级** bigram（不报错、仍可用）—— 这是"缺依赖也能跑"的保底。
 *
 *  为什么要有这条：jieba 那条分支走 `globalThis.require`，而引擎产物是 **ESM** ⇒ 没有 require ⇒
 *  依赖装了也**永远不生效**（哑巴失败：唯一症状是检索质量差，极难定位）。
 *  垫片由网关宿主注入（extensions/agentmemory-gateway/host/host.mjs 的 installEngineRequireShim）。
 *
 *  跑法：npm run test:unit（在该扩展目录下）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { segmentCjk, jiebaAvailable, engineRequireFn, __resetCjkSegmenterStateForTests } from '../src/cjkSegmenter.js';

/** 引擎自己的 package.json 作基准 —— 依赖装在 extensions/agentmemory-memory/node_modules 下。 */
const here = path.dirname(fileURLToPath(import.meta.url));
const engineRequire = createRequire(path.join(here, '..', 'package.json'));

suite('中文分词（jieba）', () => {
	test('注入 require 垫片后走 jieba：身份认证 → [身份, 认证]（bigram 会切成 身份/份认/认证）', () => {
		const before = (globalThis as any).require;
		(globalThis as any).require = engineRequire;
		try {
			__resetCjkSegmenterStateForTests();
			assert.deepEqual(segmentCjk('身份认证'), ['身份', '认证'], '必须是真分词（jieba）');
			assert.equal(jiebaAvailable(), true, 'jiebaAvailable() 必须为 true');
		} finally {
			if (before === undefined) { delete (globalThis as any).require; } else { (globalThis as any).require = before; }
		}
	});

	// ★ 2026-10-21：**引擎自建 require**（垫片下沉）⇒ 不再依赖宿主注入。
	//   背景：原生模块只能用同步 require 装载，而引擎产物是 ESM ⇒ 以前只有"宿主注入
	//   globalThis.require"一条路 ⇒ **凡是不经网关的场景（渲染侧直跑引擎）恒降级 bigram**
	//   ⇒ "依赖装了也不生效"的哑巴失败（唯一症状：中文检索质量差）✗✗。
	//   现在引擎用 createRequire(import.meta.url) 自建 ⇒ 任何场景都能真分词 ✓
	test('没有宿主垫片时，引擎自建 require ⇒ 仍走 jieba（不再降级 bigram）', () => {
		const before = (globalThis as any).require;
		delete (globalThis as any).require;
		try {
			__resetCjkSegmenterStateForTests();
			const tokens = segmentCjk('身份认证');
			assert.deepEqual(tokens, ['身份', '认证'], '引擎自建 require ⇒ 必须仍是真分词（不能降级）');
			assert.equal(jiebaAvailable(), true, '无宿主垫片时 jiebaAvailable() 也要为 true');
		} finally {
			if (before !== undefined) { (globalThis as any).require = before; }
			__resetCjkSegmenterStateForTests();
		}
	});

	test('引擎自建的 require 以引擎目录为基准（能解析到 extensions/agentmemory-memory/node_modules 的原生包）', () => {
		const req = engineRequireFn();
		assert.ok(req, '引擎必须有可用的同步 require（宿主注入或自建）');
		const resolved = req.resolve('@node-rs/jieba');
		assert.ok(resolved.includes('agentmemory-memory'), `原生包应解析到引擎自己的 node_modules，实际 ${resolved}`);
	});
});