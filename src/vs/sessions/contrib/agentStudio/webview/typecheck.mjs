/*---------------------------------------------------------------------------------------------
 * typecheck.mjs — webview 类型检查 + 新增错误基线校验（2026-09-09）。
 *
 * 背景：webview 的 esbuild 构建链**不做类型检查**，src/tsconfig.json 的 tsgo
 * 也不覆盖 webview/src —— 此前 webview 侧没有任何静态类型防线，graphNodeExecutors
 * 的 `runNodeOrStage is not defined`（ReferenceError）只能在运行时测试暴露。
 *
 * 用法：node typecheck.mjs
 *   - 0 新增错误 → exit 0
 *   - 有基线外新错误 → 列出并 exit 1
 *   - 修复了基线内错误 → 提示从 typecheck-baseline.txt 移除
 * 存量 210 条见 typecheck-baseline.txt（渐进清零目标，勿新增）。
 *--------------------------------------------------------------------------------------------*/
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baselineFile = join(here, 'typecheck-baseline.txt');

let out;
try {
	out = execSync('npx tsgo -p tsconfig.json --noEmit', { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
	out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}

const errors = out.split('\n').filter(l => l.includes('error TS')).map(l => {
	// 归一化行:列 → L:C，使基线对行号漂移不敏感
	return l.trim().replace(/\(\d+,\d+\)/, '(L:C)');
});

const baseline = existsSync(baselineFile)
	? readFileSync(baselineFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
	: [];

const baselineSet = new Set(baseline);
const newErrors = errors.filter(e => !baselineSet.has(e));
const fixed = baseline.filter(e => !errors.includes(e));

if (fixed.length > 0) {
	console.log(`✓ ${fixed.length} 个基线内类型错误已修复（请从 typecheck-baseline.txt 移除）：`);
	for (const f of fixed) { console.log(`    ${f}`); }
}
if (newErrors.length > 0) {
	console.error(`✗ ${newErrors.length} 个**新增**类型错误（不在基线内）：`);
	for (const e of newErrors.slice(0, 30)) { console.error(`    ${e}`); }
	process.exit(1);
}
console.log(`✓ typecheck: ${errors.length} errors（全部在基线内），0 新增`);
