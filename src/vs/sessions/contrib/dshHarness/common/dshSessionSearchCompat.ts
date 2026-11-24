/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Treat a legacy null turn-end reason as unknown metadata, not as a fabricated outcome. */
export function tolerateNullSessionSearchReason(source: string): string {
	const declaration = /^function turnEndText\(reason\) \{\s*(?:if \(reason === null\) return "";\s*)?switch \(reason\.kind\) \{/gm;
	const matches = [...source.matchAll(declaration)];
	if (matches.length !== 1) {
		throw new Error('dsh session search compatibility: unsupported turnEndText source contract');
	}
	if (matches[0][0].includes('if (reason === null) return "";')) {
		return source;
	}
	return source.replace(declaration, text => text.replace('switch (reason.kind)', 'if (reason === null) return "";\n\tswitch (reason.kind)'));
}

/**
 * Patch only the pinned Host query extractor in memory; leave logs and dependency files intact.
 *
 * ★★ 2026-11-24：从「精确版本门禁」改成**版本无关的能力探测**。
 *   旧实现 `version !== '0.2.2-rc.2'` 直接抛错 ⇒ bundled 升到 rc.5 / 0.2.3 时 Host 启动即崩
 *   （这是 0.2.3 迁移清单里最硬的一处阻断点）。现在不按版本拒绝：
 *     · profile 里 `@deepseek-ai/dsh-session-query` 与运行时版本不一致 ⇒ 警告并**跳过** patch，不抛；
 *     · `tolerateNullSessionSearchReason` 只认一种历史源码形状，形状变了 ⇒ 原样返回 + 日志，
 *       不把「上游自己修好了 / 改了实现」当成启动错误 ✗；
 *   因此今后换 dsh 版本这里不需要再改代码，只需按新接口另做能力适配。
 */
export function renderSessionSearchCompatPreload(version: string): string {
	return `import { registerHooks as registerSessionSearchHooks } from 'node:module';
import { readFileSync as readSessionSearchFile } from 'node:fs';
import { dirname as sessionSearchDirname, resolve as sessionSearchResolve } from 'node:path';
import { fileURLToPath as sessionSearchFilePath } from 'node:url';
const tolerateNullSessionSearchReason = ${tolerateNullSessionSearchReason.toString()};
registerSessionSearchHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || !sessionSearchFilePath(url).replaceAll('\\\\', '/').endsWith('/@deepseek-ai/dsh-session-query/lib/index.js')) return result;
    const manifest = JSON.parse(readSessionSearchFile(sessionSearchResolve(sessionSearchDirname(sessionSearchFilePath(url)), '../package.json'), 'utf8'));
    if (manifest.name !== '@deepseek-ai/dsh-session-query' || manifest.version !== ${JSON.stringify(version)}) {
      console.warn('[vssaros-session-search-compat] profile/runtime version mismatch; skip patch');
      return result;
    }
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    let patched = source;
    try {
      patched = tolerateNullSessionSearchReason(source);
    } catch (e) {
      console.warn('[vssaros-session-search-compat] source shape changed; skip patch: ' + String(e && e.message ? e.message : e));
      return result;
    }
    if (patched === source) return result;
    console.info('[vssaros-session-search-compat] null turn-end reason is non-searchable metadata');
    return { ...result, source: patched };
  }
});
`;
}
