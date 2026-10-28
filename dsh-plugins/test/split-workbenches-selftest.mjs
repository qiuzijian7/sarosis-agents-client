/*
 * 自测：证明 `check-split-workbenches.mjs` **不是空转**（2026-10-27）。
 *
 * 做法：把契约涉及的文件拷进临时 fixture，故意破坏两条规则，用 `SPLIT_WB_ROOT`
 * 指过去跑守卫，期望它以非零退出并**点名**被破坏的那两条。
 *
 * 为什么需要它：契约守卫最容易变成"永远绿"——文件路径写错、正则写宽、
 * 变量名换了，都会静默通过。只有能证明它**会红**，绿才有意义。
 *
 * 跑法：node dsh-plugins/test/split-workbenches-selftest.mjs
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const GUARD = join(REPO, 'dsh-plugins/check-split-workbenches.mjs');
const FIX = mkdtempSync(join(tmpdir(), 'split-wb-'));

const copy = (rel) => {
	const src = join(REPO, rel);
	const dst = join(FIX, rel);
	if (!existsSync(src)) { throw new Error('源文件缺失：' + rel); }
	mkdirSync(dirname(dst), { recursive: true });
	cpSync(src, dst);
};

[
	'dsh-plugins/split-workbenches.json',
	'dsh-plugins/vssaros-kb/package.json',
	'src/vs/sessions/contrib/agentStudio/browser/views/kbSideviewReactViewPane.ts',
	'src/vs/sessions/contrib/agentStudio/browser/kbNoteEditorInput.ts',
	'src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx',
	// 外壳模块也要拷：否则 R5「外壳模块存在」会误报，掩盖真正要验的 R2/R4
	'src/vs/sessions/contrib/agentStudio/common/workbenchSidePaneHost.ts',
].forEach(copy);

// 故意破坏 R2（side pane 不该有 loadDoc）与 R4（bundle 必须有 docMode 判据）
{
	const p = join(FIX, 'src/vs/sessions/contrib/agentStudio/browser/views/kbSideviewReactViewPane.ts');
	writeFileSync(p, readFileSync(p, 'utf8') + '\n// fixture: loadDoc\n', 'utf8');
}
{
	const p = join(FIX, 'src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx');
	writeFileSync(p, readFileSync(p, 'utf8').split('!!actions?.loadDoc').join('false'), 'utf8');
}

const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, SPLIT_WB_ROOT: FIX } });
const out = String(r.stdout || '') + String(r.stderr || '');
const fails = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));

const hitR2 = fails.some((f) => f.includes('R2'));
const hitR4 = fails.some((f) => f.includes('R4'));
const ok = r.status === 1 && hitR2 && hitR4;

console.log('  退出码 = ' + r.status + '（期望 1）· 失败 ' + fails.length + ' 条');
for (const f of fails) { console.log('    ' + f.slice(0, 110)); }
console.log(ok ? '  ✓ 自测通过：守卫能抓到违规（R2 / R4）' : '  ✗ 自测失败：守卫疑似空转');
process.exit(ok ? 0 : 1);
