/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Render a Host-only preload that shares Session's private-field identity across profile copies. */
export function renderSessionIdentityPreload(dshBin: string): string {
	return `import { createRequire, registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(dshBin)});
const entry = realpathSync(require.resolve('@deepseek-ai/dsh-session'));
const canonical = pathToFileURL(entry).href;
const version = JSON.parse(readFileSync(resolve(dirname(entry), '../package.json'), 'utf8')).version;
if (typeof registerHooks !== 'function') throw new Error('dsh Session identity requires Node registerHooks');
const reported = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    let result;
    try {
      result = nextResolve(specifier, context);
    } catch (error) {
      if (specifier !== '@deepseek-ai/dsh-session' || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return { url: canonical, shortCircuit: true };
    }
    if (result.url === canonical || !result.url.startsWith('file:')) return result;
    const candidate = fileURLToPath(result.url);
    const normalized = candidate.replaceAll('\\\\', '/');
    if (!normalized.endsWith('/@deepseek-ai/dsh-session/lib/index.js')) return result;
    const other = JSON.parse(readFileSync(resolve(dirname(candidate), '../package.json'), 'utf8'));
    if (other.name !== '@deepseek-ai/dsh-session' || other.version !== version) {
      throw new Error('dsh Session identity: profile/runtime version mismatch');
    }
    if (!reported.has(result.url)) {
      reported.add(result.url);
      console.info('[vssaros-session-identity] shared Session module: ' + result.url + ' -> ' + canonical);
    }
    return { ...result, url: canonical, shortCircuit: true };
  }
});
console.info('[vssaros-session-identity] enabled for dsh-session@' + version);
`;
}
