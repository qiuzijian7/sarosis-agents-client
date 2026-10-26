/*
 * 守卫：**mermaid 渲染走 pele**（2026-10-26）。
 *
 * 为什么单独一条：真机踩过一次「仓库里能渲染、装到 profile 里不行」——
 *   资产路径算错一层，`findAssetsDir()` 返回空 ⇒ 静默降级成源码块，
 *   用户看到的是"图表没渲染"，而日志里什么都没报。
 * ⇒ 这里把**路径探测**抽出来按三种布局各验一遍（这是最容易回归的部分），
 *   再加上"能渲染 / 坏语法降级 / 客户端引擎已下线"三条。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-pele.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickAssetsDir, peleDiagnostics, renderMermaidSvg } from '../lib/md/pele.js';

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const HERE = new URL('../lib/md/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// ① 仓库布局：dsh-plugins/vssaros-kb/lib/md → dsh-plugins/vssaros-pele/assets
{
	const dir = pickAssetsDir(HERE);
	t('仓库布局能找到 pele 资产', /vssaros-pele[\\/]assets$/.test(String(dir)), dir);
}

// ② 版本化安装布局：<profile>/.vssaros/plugins/vssaros-dsh-kb-*/lib/md
//    + 同级的 vssaros-dsh-pele-*/assets（真机就是这个形态，路径最容易算错）
{
	const root = mkdtempSync(join(tmpdir(), 'kb-pele-plugins-'));
	const kbMd = join(root, 'plugins', 'vssaros-dsh-kb-0.5.8-abc', 'lib', 'md');
	const peleAssets = join(root, 'plugins', 'vssaros-dsh-pele-0.1.0-xyz', 'assets');
	mkdirSync(kbMd, { recursive: true });
	mkdirSync(peleAssets, { recursive: true });
	writeFileSync(join(peleAssets, 'pele.global.js'), 'var pele=(function(){return{render:function(){return{ok:true};}};})();', 'utf8');
	const dir = pickAssetsDir(kbMd);
	t('版本化安装布局能找到 pele 资产', dir === peleAssets, 'got=' + dir);
}

// ③ node_modules 布局：<profile>/node_modules/@vssaros/dsh-kb/lib/md
{
	const root = mkdtempSync(join(tmpdir(), 'kb-pele-nm-'));
	const kbMd = join(root, 'node_modules', '@vssaros', 'dsh-kb', 'lib', 'md');
	const peleAssets = join(root, 'node_modules', '@vssaros', 'dsh-pele', 'assets');
	mkdirSync(kbMd, { recursive: true });
	mkdirSync(peleAssets, { recursive: true });
	writeFileSync(join(peleAssets, 'pele.global.js'), 'x', 'utf8');
	t('node_modules 布局能找到 pele 资产', pickAssetsDir(kbMd) === peleAssets);
}

// ④ 找不到时返回空串（而不是抛）
t('找不到资产时返回空串', pickAssetsDir(join(tmpdir(), 'definitely-not-exists')) === '');

// ⑤ 真实环境：诊断 + 真渲染
{
	const diag = peleDiagnostics();
	t('当前环境 pele 可用（诊断 ok）', diag.ok === true, JSON.stringify(diag).slice(0, 160));
	const svg = renderMermaidSvg('graph LR\n  A[取数] --> B[清洗]');
	t('能渲染出 SVG', svg.startsWith('<svg') && svg.length > 200, 'len=' + svg.length);
	t('SVG 内联了主题变量（深色不至于白底）', svg.includes('--pele-') || svg.includes('style="'));
	const bad = renderMermaidSvg('graph LR\n  A-->');
	t('语法错误时返回空串（调用方降级为源码）', bad === '', 'len=' + bad.length);
	t('超长源码被拒（不把服务端拖死）', renderMermaidSvg('graph LR\n' + 'A-->B\n'.repeat(9000)) === '');
}

// ⑥ 客户端引擎必须已下线（避免两套实现并存）
{
	const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
	t('vendor/mermaid 已删除', !existsSync(join(root, 'vendor', 'mermaid', 'mermaid.min.js')));
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（mermaid → pele）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（mermaid → pele：路径探测 / 渲染 / 降级）`);
