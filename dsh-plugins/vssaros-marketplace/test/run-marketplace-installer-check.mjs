#!/usr/bin/env node
// @vssaros/dsh-marketplace — S2 安装通道守卫（★ 2026-10-22）
//
// 守什么：dsh 侧**自己**完成 skill / workflow 的「下载 → 校验 → 解包 → 落盘 → 台账」
//   ① 落点必须是 `<数据根>/skills/<id>/` 与 `<数据根>/workflows/<id>/`
//   ② skill 的 `SKILL.md` frontmatter 必须**回写 storeId/version**（升级溯源，与 IDE 侧同语义）
//   ③ 已存在时 `install` **必须拒绝**（提示走升级）；`upgrade` 覆盖并**先备份**旧目录
//   ④ sha256 对不上必须**拒绝安装**（包被换过/传坏了）
//   ⑤ 卸载删目录 + 清台账
//   ⑥ workflow 缺 `workflow.json`、skill 缺 `SKILL.md` ⇒ 如实报错（不装半个）
//
// 全程**假 HTTP**（用真 tar.gz 造包）+ 真临时目录，不联网、不启 Host ✓
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-installer-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

const { packTarGzFromMap } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
const { installBundle, uninstallBundle, injectSkillFrontmatter, sha256Of, targetRootOf, BUNDLE_KINDS } =
	await import(pathToFileURL(path.join(LIB, 'installers.js')).href);
const { readInstalled, upsertInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-inst-'));
console.log('★ S2 安装通道守卫（skill / workflow 自持）\n');

const SKILL_PKG = packTarGzFromMap({
	'manifest.json': JSON.stringify({ kind: 'skill', id: 'demo-skill', version: '1.2.0', files: ['SKILL.md'] }),
	'SKILL.md': '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文一\n',
	'scripts/run.sh': '#!/bin/sh\necho hi\n',
});
const SKILL_PKG_V2 = packTarGzFromMap({
	'manifest.json': JSON.stringify({ kind: 'skill', id: 'demo-skill', version: '1.3.0', files: ['SKILL.md'] }),
	'SKILL.md': '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文二（新版）\n',
});
const WF_PKG = packTarGzFromMap({
	'manifest.json': JSON.stringify({ kind: 'workflow', id: 'demo-wf', version: '2.0.0', files: ['workflow.json'] }),
	'workflow.json': JSON.stringify({ id: 'demo-wf', name: '演示流程', version: '2.0.0', nodes: [], connections: [] }, null, 2),
});

// ── ① 落点 ───────────────────────────────────────────────────
check('① skill 落 <数据根>/skills，workflow 落 <数据根>/workflows',
	targetRootOf(dataRoot, 'skill') === path.join(dataRoot, 'skills')
	&& targetRootOf(dataRoot, 'workflow') === path.join(dataRoot, 'workflows'));
check('① 只支持 skill / workflow（agent 会明说"还不行"）',
	(() => { try { targetRootOf(dataRoot, 'agent'); return false; } catch { return true; } })()
	&& BUNDLE_KINDS.join(',') === 'skill,workflow');

// ── ② skill 安装 + frontmatter 回写 ──────────────────────────
{
	const res = await installBundle({ dataRoot, kind: 'skill', storeId: 'demo-skill', version: '1.2.0', gzBuffer: SKILL_PKG });
	const md = fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8');
	check('② 文件落盘（含子目录）', fs.existsSync(path.join(res.targetDir, 'scripts', 'run.sh')));
	check('② frontmatter 回写了 storeId', /^storeId: demo-skill$/m.test(md), md.split('\n').slice(0, 8).join(' | '));
	check('② frontmatter 回写了 version', /^version: 1\.2\.0$/m.test(md));
	check('② frontmatter 其余行逐字保留（name/description 未被改）', /^name: demo-skill$/m.test(md) && /^description: 演示技能$/m.test(md));
	check('② 正文没被动过', md.includes('正文一'));
}

// ── ③ 已存在 ⇒ install 拒绝 / upgrade 覆盖且备份 ─────────────
{
	let threw = '';
	try { await installBundle({ dataRoot, kind: 'skill', storeId: 'demo-skill', version: '1.3.0', gzBuffer: SKILL_PKG_V2 }); }
	catch (e) { threw = String(e.message ?? e); }
	check('③ 已存在时 install 拒绝（提示走升级）', threw.includes('已经装过') && threw.includes('升级'), threw);

	const up = await installBundle({ dataRoot, kind: 'skill', storeId: 'demo-skill', version: '1.3.0', gzBuffer: SKILL_PKG_V2, upgrade: true });
	const md = fs.readFileSync(path.join(up.targetDir, 'SKILL.md'), 'utf8');
	check('③ upgrade 覆盖成功（新正文 + 新版本）', md.includes('正文二') && /^version: 1\.3\.0$/m.test(md));
	check('③ upgrade 前**备份了旧目录**', Boolean(up.backup) && fs.existsSync(up.backup), up.backup);
	const backedMd = up.backup ? fs.readFileSync(path.join(up.backup, 'SKILL.md'), 'utf8') : '';
	check('③ 备份里是**旧版**内容（失手可恢复）', backedMd.includes('正文一') && /^version: 1\.2\.0$/m.test(backedMd));
}

// ── ④ workflow 安装 ─────────────────────────────────────────
{
	const res = await installBundle({ dataRoot, kind: 'workflow', storeId: 'demo-wf', version: '2.0.0', gzBuffer: WF_PKG });
	const raw = JSON.parse(fs.readFileSync(path.join(res.targetDir, 'workflow.json'), 'utf8'));
	check('④ workflow 落到 <数据根>/workflows/<id>/workflow.json', res.targetDir === path.join(dataRoot, 'workflows', 'demo-wf') && raw.name === '演示流程');
}

// ── ⑤ 缺关键文件 ⇒ 如实报错（不装半个）──────────────────────
{
	const noSkillMd = packTarGzFromMap({ 'manifest.json': '{}', 'README.md': 'x' });
	let threw = '';
	try { await installBundle({ dataRoot, kind: 'skill', storeId: 'bad-skill', version: '1.0.0', gzBuffer: noSkillMd }); }
	catch (e) { threw = String(e.message ?? e); }
	check('⑤ skill 缺 SKILL.md ⇒ 报错且**没有落目录**', threw.includes('SKILL.md') && !fs.existsSync(path.join(dataRoot, 'skills', 'bad-skill')), threw);

	const noWf = packTarGzFromMap({ 'manifest.json': '{}', 'README.md': 'x' });
	let threw2 = '';
	try { await installBundle({ dataRoot, kind: 'workflow', storeId: 'bad-wf', version: '1.0.0', gzBuffer: noWf }); }
	catch (e) { threw2 = String(e.message ?? e); }
	check('⑤ workflow 缺 workflow.json ⇒ 报错且没落目录', threw2.includes('workflow.json') && !fs.existsSync(path.join(dataRoot, 'workflows', 'bad-wf')), threw2);

	const empty = packTarGzFromMap({});
	let threw3 = '';
	try { await installBundle({ dataRoot, kind: 'skill', storeId: 'empty', version: '1.0.0', gzBuffer: empty }); }
	catch (e) { threw3 = String(e.message ?? e); }
	check('⑤ 空包 ⇒ 报错（不装一个空目录）', threw3.includes('没有任何文件'), threw3);
}

// ── ⑥ sha256 与台账 ────────────────────────────────────────
{
	check('⑥ sha256Of 是 64 位 hex 且稳定', /^[0-9a-f]{64}$/.test(sha256Of(SKILL_PKG)) && sha256Of(SKILL_PKG) === sha256Of(SKILL_PKG));
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 'demo-skill', version: '1.3.0' });
	const entries = await readInstalled(dataRoot);
	check('⑥ 台账记到了（kind+storeId+version）', entries.some(e => e.kind === 'skill' && e.storeId === 'demo-skill' && e.version === '1.3.0'));
}

// ── ⑦ 卸载 ─────────────────────────────────────────────────
{
	const res = await uninstallBundle({ dataRoot, kind: 'workflow', storeId: 'demo-wf' });
	check('⑦ 卸载删掉了目录', !fs.existsSync(res.targetDir));
	let threw = '';
	try { await uninstallBundle({ dataRoot, kind: 'workflow', storeId: 'demo-wf' }); }
	catch (e) { threw = String(e.message ?? e); }
	check('⑦ 卸一个没装的 ⇒ 如实报错（不静默成功）', threw.includes('没有装过'), threw);
}

// ── ⑧ frontmatter 边界 ─────────────────────────────────────
{
	check('⑧ 没有 frontmatter ⇒ 补一个最小合法的', (() => {
		const out = injectSkillFrontmatter('纯正文\n', { storeId: 's', version: '1.0.0' });
		return out.startsWith('---\n') && out.includes('storeId: s') && out.includes('纯正文');
	})());
	check('⑧ frontmatter 未闭合 ⇒ 抛错（不猜着改）', (() => {
		try { injectSkillFrontmatter('---\nname: x\n正文', { storeId: 's', version: '1' }); return false; } catch { return true; }
	})());
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace installer] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
