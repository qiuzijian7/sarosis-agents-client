/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchPiAiUsage, patchPiAiUsageSource } from './patch-pi-ai-usage.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const original = 'const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;';

function parse(source, rawUsage) {
	return new Function('rawUsage', `${source}\nreturn { cacheRead: cacheReadTokens, input: Math.max(0, rawUsage.prompt_tokens - cacheReadTokens) };`)(rawUsage);
}

test('兼容网关缓存字段进入 cacheRead 并从未缓存输入中扣除', () => {
	const source = patchPiAiUsageSource(original);
	for (const key of ['prompt_cache_hit_tokens', 'cached_tokens', 'cache_read_input_tokens']) {
		assert.deepEqual(parse(source, { prompt_tokens: 100, [key]: 80 }), { cacheRead: 80, input: 20 });
	}
	assert.deepEqual(parse(source, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }), { cacheRead: 80, input: 20 });
});

test('保留优先级、显式零值、缺失字段和 input 下限', () => {
	const source = patchPiAiUsageSource(original);
	assert.deepEqual(parse(source, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 80 }), { cacheRead: 0, input: 100 });
	assert.deepEqual(parse(source, { prompt_tokens: 100, prompt_cache_hit_tokens: 40, cached_tokens: 60, cache_read_input_tokens: 80 }), { cacheRead: 40, input: 60 });
	assert.deepEqual(parse(source, { prompt_tokens: 100 }), { cacheRead: 0, input: 100 });
	assert.deepEqual(parse(source, { prompt_tokens: 100, cache_read_input_tokens: 120 }), { cacheRead: 120, input: 0 });
});

test('修补幂等，未知或重复源码必须报错', () => {
	const patched = patchPiAiUsageSource(original);
	assert.equal(patchPiAiUsageSource(patched), patched);
	assert.throws(() => patchPiAiUsageSource('const cacheReadTokens = 0;'), /不符合预期/);
	assert.throws(() => patchPiAiUsageSource(`${original}\n${original}`), /不符合预期/);
});

test('文件修补覆盖全新产物及同版本复用，不改动无关内容', t => {
	const parent = join(root, '.build');
	mkdirSync(parent, { recursive: true });
	const runtime = mkdtempSync(join(parent, 'pi-usage-test-'));
	t.after(() => rmSync(runtime, { recursive: true, force: true }));
	const pkg = join(runtime, 'node_modules', '@earendil-works', 'pi-ai');
	const entry = join(pkg, 'dist', 'api', 'openai-completions.js');
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '1.6.0' }));
	writeFileSync(entry, `before\n${original}\nafter`);
	assert.deepEqual(patchPiAiUsage(runtime), { patched: true, version: '1.6.0' });
	const patched = readFileSync(entry, 'utf8');
	assert.equal(patched, `before\n${patchPiAiUsageSource(original)}\nafter`);
	assert.deepEqual(patchPiAiUsage(runtime), { patched: false, version: '1.6.0' });
});

test('prepack 的复用与新安装分支均接入修补', () => {
	const source = readFileSync(join(root, 'build', 'prepack-dsh-runtime.mjs'), 'utf8');
	assert.match(source, /if \(actual0 === version\) \{\s*patchPiAiUsage\(target\);/);
	assert.match(source, /patchPiAiUsage\(target\);\s*prune\(target\);\s*console\.log\(`\[prepack-dsh\] done:/);
});

test('随包真实解析器支持新增字段', t => {
	const manifest = JSON.parse(readFileSync(join(root, 'dsh-plugins', 'dsh-compat.json'), 'utf8'));
	const entry = join(root, 'dsh-runtime', manifest.bundled, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js');
	if (!existsSync(entry)) {
		t.skip('当前环境没有随包运行时');
		return;
	}
	const source = readFileSync(entry, 'utf8');
	const body = /function parseChunkUsage\([\s\S]*?\n\}/.exec(source)?.[0];
	assert.ok(body, '必须找到真实 parseChunkUsage');
	const parseChunk = new Function('calculateCost', 'isOpenRouterModel', 'applyOpenRouterReportedCost', `${body}\nreturn parseChunkUsage;`)(() => undefined, () => false, () => undefined);
	const usage = parseChunk({ prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 80 }, {});
	assert.deepEqual({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, total: usage.totalTokens }, { input: 20, output: 20, cacheRead: 80, total: 120 });
});
