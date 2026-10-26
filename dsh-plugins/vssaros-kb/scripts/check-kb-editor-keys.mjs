/*
 * 守卫：**编辑态键盘行为**（2026-10-26）。
 *
 * 被测对象是 `src/.../kbSideview/mdList.ts` —— 刻意做成**纯函数单独成文件**：
 * 守卫只需 esbuild 打包这 40 行，不用把 React / DOM 拖进来（那种测试很脆）。
 *
 * 覆盖：列表续写（无序 / 有序 / 任务 / 空条目跳出 / 非列表不接管）、Tab 缩进（光标与选区）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-editor-keys.mjs
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const REPO = 'g:/SarosWorkspace/sarosis-agents-client';
const SRC = join(REPO, 'src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/mdList.ts');
const OUT_DIR = join(REPO, 'dsh-plugins/vssaros-kb/.tmp-mdlist');
const OUT = join(OUT_DIR, 'bundle.mjs');

mkdirSync(OUT_DIR, { recursive: true });
await build({
	entryPoints: [SRC],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: ['es2022'],
	outfile: OUT,
	logLevel: 'silent',
});

const mod = await import(pathToFileURL(OUT).href + '?t=' + Date.now());
const { continueMarkdownList, indentAt } = mod;

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const j = (x) => JSON.stringify(x);

// ① 无序列表续写
{
	const r = continueMarkdownList('- 项目', 4);
	t('无序列表回车续写 "- "', r && r.next === '- 项目\n- ' && r.caret === 7, j(r));
}
// ② 空条目回车 ⇒ 跳出列表
{
	const r = continueMarkdownList('- ', 2);
	t('空条目回车跳出列表（前缀被去掉）', r && r.next === '' && r.caret === 0, j(r));
}
// ③ 有序列表序号自增
{
	const r = continueMarkdownList('1. 第一', 5);
	t('有序列表续写为 "2. "', r && r.next === '1. 第一\n2. ' && r.caret === 9, j(r));
}
// ④ 任务清单续写为**未勾选**
{
	const r = continueMarkdownList('- [x] 已完成', 9);
	t('任务清单续写为未勾选 "- [ ] "', r && r.next === '- [x] 已完成\n- [ ] ' && r.caret === 16, j(r));
}
// ⑤ 缩进保留
{
	const r = continueMarkdownList('  - 子项', 6);
	t('缩进层级被保留', r && r.next === '  - 子项\n  - ' && r.caret === 11, j(r));
}
// ⑥ 非列表不接管（走默认换行）
{
	const r = continueMarkdownList('普通段落', 4);
	t('普通段落不接管回车', r === null, j(r));
}
// ⑦ Tab 缩进：无选区
{
	const r = indentAt('abc', 1, 1);
	t('Tab 插入两个空格（光标跟随）', r.next === 'a  bc' && r.start === 3 && r.end === 3, j(r));
}
// ⑧ Tab 缩进：多行选区整体前缀
{
	const r = indentAt('a\nb', 0, 3);
	t('选区整体缩进（每行两空格）', r.next === '  a\n  b' && r.start === 0 && r.end === 7, j(r));
}

try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（编辑态键盘行为）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（编辑态键盘行为：列表续写 / 跳出 / 缩进）`);
