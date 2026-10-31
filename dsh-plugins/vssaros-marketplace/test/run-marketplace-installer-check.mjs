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
const { resolveInstalledVersions } = await import(pathToFileURL(path.join(LIB, 'installedState.js')).href);

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
// ★ 2026-10-22 晚：agent **已搬过来** ⇒ 这条断言从"agent 还不行"改成"这三类都行、其它类明说不行"
// ★ 2026-10-23（用户「都转移到 dsh 侧实现」）：mcp 也搬过来了 ⇒ 四类都支持；
// ★ 2026-10-31：**knowledge 也搬过来了**（商城知识库包落到 <数据根>/knowledge/<id>/）
//   ⇒ 这条断言从"四类"改成"五类"；"明说不支持"改用 workbench 验证 ✓
check('① 支持 skill / workflow / agent / mcp / knowledge 五类；未知 kind 仍明说不支持',
	targetRootOf(dataRoot, 'agent') === path.join(dataRoot, 'agents')
	&& targetRootOf(dataRoot, 'mcp') === path.join(dataRoot, 'mcp')
	&& targetRootOf(dataRoot, 'knowledge') === path.join(dataRoot, 'knowledge')
	&& (() => { try { targetRootOf(dataRoot, 'workbench'); return false; } catch (e) { return /还不支持/.test(String(e.message ?? e)); } })());

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

// ── ⑨ agent 安装（★ 2026-10-22 晚：从 IDE 侧搬过来）────────────────
//   取证：agent 本地形态就是 `<数据根>/agents/<id>/.agent.md`，
//   而 `.agent.md` 的 frontmatter 自带完整定义 ⇒ 不需要 IDE 的 createAgent ✓
{
	// 9a. 目录镜像包（dsh 侧发布格式）：直接有 .agent.md
	const mirrorPkg = packTarGzFromMap({
		'.agent.md': '---\nid: demo-agent\nname: 演示 Agent\ntools:\n  - read\n---\n\n你是一个演示 agent\n',
		'README.md': '说明\n',
	});
	const r1 = await installBundle({
		dataRoot, kind: 'agent', storeId: 'demo-agent', version: '1.0.0', gzBuffer: mirrorPkg,
	});
	check('⑨ agent 落到 <数据根>/agents/<id>', r1.targetDir === path.join(dataRoot, 'agents', 'demo-agent'), r1.targetDir);
	check('⑨ .agent.md 原样落盘（frontmatter 完整）',
		fs.readFileSync(path.join(r1.targetDir, '.agent.md'), 'utf8').includes('id: demo-agent'));

	// 9b. 旧包（IDE 的 preparePack 产物）：agent.json + files.agentsMd
	const legacyPkg = packTarGzFromMap({
		'agent.json': JSON.stringify({
			agent: { id: 'legacy-agent', name: '旧格式 Agent', description: 'x', tools: ['read'] },
			files: {
				agentsMd: '---\nid: legacy-agent\nname: 旧格式 Agent\n---\n\n旧包正文\n',
				configHtml: '<html><body>配置</body></html>',
			},
		}),
	});
	const r2 = await installBundle({
		dataRoot, kind: 'agent', storeId: 'legacy-agent', version: '0.9.0', gzBuffer: legacyPkg,
	});
	check('⑨ 旧包：files.agentsMd 被转成 .agent.md',
		fs.existsSync(path.join(r2.targetDir, '.agent.md'))
		&& fs.readFileSync(path.join(r2.targetDir, '.agent.md'), 'utf8').includes('旧包正文'));
	check('⑨ 旧包：agent.json 不落盘（它不是运行期文件）',
		!fs.existsSync(path.join(r2.targetDir, 'agent.json')));
	check('⑨ 旧包：files.configHtml 落成 config.html（与 IDE 侧同名）',
		fs.existsSync(path.join(r2.targetDir, 'config.html')));

	// 9c. agent.json 的 id 与商城标识不一致 ⇒ 明确拒（否则目录名和 frontmatter 对不上）
	const mismatch = packTarGzFromMap({
		'agent.json': JSON.stringify({ agent: { id: 'other-id' }, files: { agentsMd: '---\nid: other-id\n---\n' } }),
	});
	let msg = '';
	try {
		await installBundle({ dataRoot, kind: 'agent', storeId: 'wanted-id', version: '1.0.0', gzBuffer: mismatch });
	} catch (e) { msg = String(e.message ?? e); }
	check('⑨ agent.json 的 id 与标识不一致 ⇒ 拒绝', msg.includes('不一致'), msg);
	check('⑨ 被拒时没有落下目录', !fs.existsSync(path.join(dataRoot, 'agents', 'wanted-id')));

	// 9d. 两种来源都没有 ⇒ 拒绝（不装空壳）
	const empty = packTarGzFromMap({ 'README.md': 'x\n' });
	msg = '';
	try {
		await installBundle({ dataRoot, kind: 'agent', storeId: 'no-entry', version: '1.0.0', gzBuffer: empty });
	} catch (e) { msg = String(e.message ?? e); }
	check('⑨ 既无 agent.json 又无 .agent.md ⇒ 拒绝', msg.includes('.agent.md'), msg);

	// 9e. agent.json 缺 files.agentsMd ⇒ 拒绝（装不出可用 agent）
	const noMd = packTarGzFromMap({ 'agent.json': JSON.stringify({ agent: { id: 'x' }, files: {} }) });
	msg = '';
	try {
		await installBundle({ dataRoot, kind: 'agent', storeId: 'x', version: '1.0.0', gzBuffer: noMd });
	} catch (e) { msg = String(e.message ?? e); }
	check('⑨ agent.json 缺 agentsMd ⇒ 拒绝', msg.includes('agentsMd'), msg);

	// 9f. 升级 = 覆盖 + 先备份
	const v2 = packTarGzFromMap({ '.agent.md': '---\nid: demo-agent\nname: v2\n---\n\n第二版\n' });
	const up = await installBundle({
		dataRoot, kind: 'agent', storeId: 'demo-agent', version: '2.0.0', gzBuffer: v2, upgrade: true,
	});
	check('⑨ agent 升级生效（内容换了）',
		fs.readFileSync(path.join(up.targetDir, '.agent.md'), 'utf8').includes('第二版'));
	check('⑨ agent 升级前有备份', Boolean(up.backup) && fs.existsSync(up.backup), String(up.backup));

	// 9g. **manifest.json 不落盘**（三 kind 一致）：它是打包元数据，不属于资源本体
	//     （2026-10-22 真机端到端抓到：此前会跟着写进资源目录，污染且下次发布会再打进去 ✗）
	const withManifest = packTarGzFromMap({
		'manifest.json': JSON.stringify({ kind: 'skill', id: 'mf-skill', version: '1.0.0', files: ['SKILL.md'] }),
		'SKILL.md': '---\nname: mf\n---\n\nx\n',
	});
	const rmf = await installBundle({ dataRoot, kind: 'skill', storeId: 'mf-skill', version: '1.0.0', gzBuffer: withManifest });
	check('⑨ 包里的 manifest.json **不落盘**（打包元数据不属于资源）',
		!fs.existsSync(path.join(rmf.targetDir, 'manifest.json')) && fs.existsSync(path.join(rmf.targetDir, 'SKILL.md')));

	// 9h. BUNDLE_KINDS 现在包含 agent；uninstall 也认
	check('⑨ BUNDLE_KINDS 含 agent', BUNDLE_KINDS.includes('agent'), BUNDLE_KINDS.join(','));
	await uninstallBundle({ dataRoot, kind: 'agent', storeId: 'demo-agent' });
	check('⑨ agent 能卸载（目录删掉）', !fs.existsSync(path.join(dataRoot, 'agents', 'demo-agent')));
}

// ── ⑩ 「已安装」判据（★ 2026-10-29 用户：「已经安装的 item 状态要更新」）────
//
// 守什么：台账 `installed-packages.json` **只增不减**（删目录/换机器都不会清条目）
//   ⇒ "算不算已安装"必须以**磁盘落地物**为准，否则商城里会有一大片谎报"已安装"。
//   真机实测：台账 135 条 skill、磁盘只剩 21 个目录 ⇒ 若照台账渲染 = 100+ 条假绿 ✗
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-state-'));
	const write = (rel, body) => {
		const p = path.join(root, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, body);
	};
	// ① 落地物在，且磁盘版本 ≠ 台账版本 ⇒ 以磁盘为准（升级判断要跟真正装的那份对得上）
	write('skills/disk-skill/SKILL.md', '---\nname: disk-skill\nversion: 1.2.0\n---\n\nx\n');
	// ② 落地物不在（幽灵条目）
	// ③ 老技能手写的 SKILL.md 没有 `version:` 字段 ⇒ 仍算已装，版本回退台账
	write('skills/no-ver/SKILL.md', '---\nname: no-ver\ndescription: 老技能\n---\n\nx\n');
	// ④ agent 要有 .agent.md；⑤ mcp 要目录 + mcp.json 注册项都在
	write('agents/ok-agent/.agent.md', '---\nid: ok-agent\n---\n\n正文\n');
	write('mcp/ok-mcp/config.json', JSON.stringify({ version: '3.1.0', command: 'node' }));
	write('mcp/no-reg/config.json', JSON.stringify({ version: '1.0.0' }));
	write('mcp.json', JSON.stringify({ servers: { 'ok-mcp': { command: 'node' } } }));

	for (const e of [
		{ kind: 'skill', storeId: 'disk-skill', version: '1.0.0' },
		{ kind: 'skill', storeId: 'ghost-skill', version: '9.9.9' },
		{ kind: 'skill', storeId: 'no-ver', version: '0.4.2' },
		{ kind: 'agent', storeId: 'ok-agent', version: '1.0.0' },
		{ kind: 'agent', storeId: 'ghost-agent', version: '1.0.0' },
		{ kind: 'mcp', storeId: 'ok-mcp', version: '1.0.0' },
		{ kind: 'mcp', storeId: 'no-reg', version: '1.0.0' },
		{ kind: 'plugin', storeId: 'some-plugin', version: '0.7.0' },
	]) { await upsertInstalled(root, e); }

	const map = await resolveInstalledVersions(root);

	check('⑩ skill 落地 ⇒ 已装，版本取**磁盘**那份（台账是旧的 1.0.0）',
		map.get('skill:disk-skill') === '1.2.0', String(map.get('skill:disk-skill')));
	check('⑩ 台账有、目录已被删 ⇒ **不算已装**（不谎报）',
		!map.has('skill:ghost-skill'));
	check('⑩ 老技能没有 version 字段 ⇒ 仍算已装（回退台账版本，不误判成未装）',
		map.get('skill:no-ver') === '0.4.2', String(map.get('skill:no-ver')));
	check('⑩ agent 看 .agent.md', map.get('agent:ok-agent') === '1.0.0' && !map.has('agent:ghost-agent'));
	check('⑩ mcp 要「目录 + mcp.json 注册项」都在',
		map.get('mcp:ok-mcp') === '3.1.0' && !map.has('mcp:no-reg'),
		`ok-mcp=${String(map.get('mcp:ok-mcp'))} no-reg=${String(map.get('mcp:no-reg'))}`);
	check('⑩ plugin 没有可查的落地物 ⇒ 信台账', map.get('plugin:some-plugin') === '0.7.0');
	check('⑩ 空/缺 dataRoot ⇒ 空 Map（不抛）',
		(await resolveInstalledVersions('')).size === 0 && (await resolveInstalledVersions(undefined)).size === 0);

	fs.rmSync(root, { recursive: true, force: true });
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace installer] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
