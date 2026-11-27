/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL = 'rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0';
const PATCHED = 'rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? rawUsage.cache_read_input_tokens ?? 0';

/** 保留 OpenAI 字段优先级和显式零值，补齐兼容网关的缓存读取字段。 */
export function patchPiAiUsageSource(source) {
	const original = `const cacheReadTokens = ${ORIGINAL};`;
	const patched = `const cacheReadTokens = ${PATCHED};`;
	if (source.includes(patched)) {
		return source;
	}
	if (source.split(original).length !== 2) {
		throw new Error('pi-ai 缓存解析源码不符合预期，拒绝静默跳过修补');
	}
	return source.replace(original, patched);
}

/** 同版本 runtime 复用和全新安装都必须运行，产物无需联网或重装。 */
export function patchPiAiUsage(runtimeDir) {
	const packageDir = join(runtimeDir, 'node_modules', '@earendil-works', 'pi-ai');
	const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
	if (manifest.name !== '@earendil-works/pi-ai') {
		throw new Error(`pi-ai 包名不符合预期：${manifest.name}`);
	}
	const parserPath = join(packageDir, 'dist', 'api', 'openai-completions.js');
	const source = readFileSync(parserPath, 'utf8');
	const patched = patchPiAiUsageSource(source);
	if (patched !== source) {
		writeFileSync(parserPath, patched, 'utf8');
	}
	return { patched: patched !== source, version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) {
		throw new Error('用法：node build/saros/patch-pi-ai-usage.mjs <runtimeDir>');
	}
	const result = patchPiAiUsage(resolve(process.argv[2]));
	console.log(`[prepack-dsh] pi-ai ${result.version}: 缓存字段修补${result.patched ? '完成' : '已生效'}`);
}
