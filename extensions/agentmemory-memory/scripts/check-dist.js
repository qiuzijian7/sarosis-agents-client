// 检查 dist bundle 是否包含最新 proxy 代码（R4 验证）
// 用法：node extensions/agentmemory-memory/scripts/check-dist.js
// 旧假实现特征：同步 return { totalAuditEntries: 0 }
// 新转发特征：this._call("getAuditSummary")（esbuild 输出统一双引号）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let fail = false;
for (const f of ['extension.js', 'extension.cjs.js']) {
	const text = readFileSync(join(dir, f), 'utf8');
	const oldStub = /getAuditSummary\(\)\s*{\s*return\s*{\s*totalAuditEntries: 0\s*};?\s*}/.test(text);
	const newFwd = text.includes('this._call("getAuditSummary")') || text.includes("this._call('getAuditSummary')");
	const ok = !oldStub && newFwd;
	if (!ok) fail = true;
	console.log(`${f}: oldStub=${oldStub} newForward=${newFwd} => ${ok ? 'OK' : 'STALE — run scripts/build-dist.mjs'}`);
}
process.exit(fail ? 1 : 0);
