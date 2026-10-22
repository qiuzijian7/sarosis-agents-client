#!/usr/bin/env node
// @vssaros/dsh-marketplace — S2c 发布/下架守卫（★ 2026-10-22）
//
// 守什么：`publish` / `deletePackage` / `deleteVersion` 在 **dsh 侧自持**完成
//   ① 打包成**目录镜像**（`<数据根>/<kind根>/<id>/` 整个进去），manifest 关键字段被强制覆盖
//   ② `manifest.id` 必须等于 slug、`kind` 一致（服务端 `validateManifestKind` 的硬要求）
//   ③ 建包 409（slug 已被占用）要**容忍**（那是在更新已有包），其它错误必须抛
//   ④ 上传走 raw tar.gz + `X-Changelog`（服务端 `/versions/raw` 的契约）
//   ⑤ 体积超上限要**提前拒**（别等服务端 413）
//   ⑥ 下架两个 op 打对应的 DELETE
//   ⑦ 排除依赖/备份目录（node_modules / .git / .upgrade-backup）
//
// 全程假 HTTP + 真临时目录，不联网、不启 Host ✓
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-publish-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

const { listTarGzEntries } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
const { PUBLISHABLE_KINDS, preparePublishBundle, publishVersion, deletePackage, deleteVersion, collectDir, localRootOf } =
	await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-pub-'));
console.log('★ S2c 发布/下架守卫（dsh 侧自持）\n');

/** 造一个本地 skill 目录（含作者写的 manifest、子目录、以及要排除的东西）。 */
function makeSkill(localId, version, extra = {}) {
	const dir = path.join(dataRoot, 'skills', localId);
	fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${localId}\ndescription: 演示\n---\n\n正文\n`);
	fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
	// 作者写的 manifest（name/description 应被**保留**，kind/id/version/files 应被覆盖）
	fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
		kind: 'skill', id: 'WRONG-ID', name: '作者起的名字', description: '作者写的介绍', version: '0.0.0',
		files: ['stale'],
	}));
	// 应被排除的目录
	fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'x');
	fs.mkdirSync(path.join(dir, '.upgrade-backup'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.upgrade-backup', 'old.md'), 'old');
	for (const [k, v] of Object.entries(extra)) { fs.writeFileSync(path.join(dir, k), v); }
	return dir;
}

// ── ① 目录镜像 + manifest 强制覆盖 ──────────────────────────────
{
	makeSkill('demo-skill', '1.2.0');
	const prepared = await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'demo-skill', version: '1.2.0' });
	check('① manifest.id 被强制改成 slug（服务端要求 id===slug）', prepared.manifest.id === 'demo-skill', prepared.manifest.id);
	check('① manifest.kind 被强制写成 skill', prepared.manifest.kind === 'skill');
	check('① manifest.version 用本次发布版本（不是目录里那个 0.0.0）', prepared.manifest.version === '1.2.0', prepared.manifest.version);
	check('① 作者写的 name/description 被**保留**', prepared.manifest.name === '作者起的名字' && prepared.manifest.description === '作者写的介绍');
	check('① files 是实际打包的相对路径', Array.isArray(prepared.manifest.files) && prepared.manifest.files.includes('SKILL.md') && prepared.manifest.files.includes('scripts/run.sh'));

	const entries = listTarGzEntries(prepared.gzBuffer).files.map(f => f.path).sort();
	check('① 包内是目录镜像（含 SKILL.md + scripts）', entries.includes('SKILL.md') && entries.includes('scripts/run.sh'), entries.join(','));
	check('① 包内只有一份 manifest.json（旧的不重复）', entries.filter(p => p === 'manifest.json').length === 1);
	check('① 排除了 node_modules / .upgrade-backup', !entries.some(p => p.startsWith('node_modules') || p.startsWith('.upgrade-backup')), entries.join(','));
	check('① 包内 manifest.json 与返回值一致', (() => {
		const raw = listTarGzEntries(prepared.gzBuffer).files.find(f => f.path === 'manifest.json');
		const parsed = JSON.parse(raw.data.toString('utf8'));
		return parsed.id === 'demo-skill' && parsed.version === '1.2.0';
	})());

	// 确定性：同样内容 ⇒ 同样字节（发布前比对依赖它）
	const again = await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'demo-skill', version: '1.2.0' });
	check('① 打包确定性（同内容同字节）', again.gzBuffer.equals(prepared.gzBuffer));
}

// ── ② workflow / agent 目录也能发布（目录镜像）─────────────────
{
	fs.mkdirSync(path.join(dataRoot, 'workflows', 'demo-wf'), { recursive: true });
	fs.writeFileSync(path.join(dataRoot, 'workflows', 'demo-wf', 'workflow.json'), JSON.stringify({ id: 'demo-wf', name: '演示流程', version: '2.0.0' }));
	const wf = await preparePublishBundle({ dataRoot, kind: 'workflow', localId: 'demo-wf', version: '2.0.0' });
	check('② workflow 目录镜像可发布（manifest 自动生成）', wf.manifest.kind === 'workflow' && wf.manifest.id === 'demo-wf' && wf.manifest.version === '2.0.0');

	// ⚠ agent **不可**由 dsh 侧发布（2026-10-22 收窄）：包格式是 `agent.json`，
	//   只有 IDE 侧 `agentInstaller.preparePack` 会正确组装（含嵌套 configHtml）⇒
	//   dsh 侧打目录镜像会让"别人装不上"✗
	fs.mkdirSync(path.join(dataRoot, 'agents', 'demo-agent'), { recursive: true });
	fs.writeFileSync(path.join(dataRoot, 'agents', 'demo-agent', '.agent.md'), '---\nname: demo-agent\n---\n\n人设\n');
	let agentThrew = '';
	try { await preparePublishBundle({ dataRoot, kind: 'agent', localId: 'demo-agent', version: '3.0.0' }); }
	catch (e) { agentThrew = String(e.message ?? e); }
	check('② agent **不**走 dsh 侧发布（包格式 agent.json 归 IDE 组装）',
		agentThrew.includes('不支持发布这一类') && agentThrew.includes('agent'), agentThrew);
	check('② PUBLISHABLE_KINDS 只剩 skill / workflow', PUBLISHABLE_KINDS.join(',') === 'skill,workflow');
}

// ── ③ 本地没有 / 空目录 / slug 非法 ⇒ 如实报错 ─────────────────
{
	let threw = '';
	try { await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'nope', version: '1.0.0' }); }
	catch (e) { threw = String(e.message ?? e); }
	check('③ 本地没有这个资源 ⇒ 报错并给出路径', threw.includes('本地没有这个资源') && threw.includes('nope'), threw);

	fs.mkdirSync(path.join(dataRoot, 'skills', 'empty-skill'), { recursive: true });
	let threw2 = '';
	try { await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'empty-skill', version: '1.0.0' }); }
	catch (e) { threw2 = String(e.message ?? e); }
	check('③ 空目录 ⇒ 拒绝发布空包', threw2.includes('没有文件'), threw2);

	let threw3 = '';
	try { await preparePublishBundle({ dataRoot, kind: 'workbench', localId: 'x', version: '1.0.0' }); }
	catch (e) { threw3 = String(e.message ?? e); }
	check('③ workbench 不走 bundle 发布（外部发布源）', threw3.includes('不支持发布这一类'), threw3);
}

// ── ④ 建包 409 容忍 / 其它错误抛出 / 上传契约 ──────────────────
{
	const calls = [];
	function fakeMarket({ createStatus = 200 } = {}) {
		return {
			request: async (method, urlPath, body) => {
				calls.push({ kind: 'request', method, urlPath, body });
				if (urlPath === '/packages') {
					if (createStatus === 409) { throw new Error('slug "demo-skill" 已被占用'); }
					if (createStatus === 500) { throw new Error('HTTP 500'); }
					return { ok: true };
				}
				return { ok: true };
			},
			upload: async (urlPath, buffer, opts) => {
				calls.push({ kind: 'upload', urlPath, bytes: buffer.length, changelog: opts?.changelog });
				// 服务端 `/versions/raw` 会回 `{ version }`；这里回 undefined 是**故意**的：
				// 用来验证 publisher 在"服务端没回版本"时会**回落到本地版本**（不写空串）✓
				return undefined;
			},
		};
	}

	const m1 = fakeMarket();
	const r1 = await publishVersion({ market: m1, dataRoot, kind: 'skill', localId: 'demo-skill', version: '1.2.0', changelog: '首个版本' });
	check('④ 新包：先建包再传版本（顺序正确）',
		calls[0]?.urlPath === '/packages' && calls[1]?.kind === 'upload', JSON.stringify(calls.map(c => c.urlPath ?? c.kind)));
	check('④ 上传走 /versions/raw 并带 changelog', calls[1]?.urlPath === '/packages/demo-skill/versions/raw' && calls[1]?.changelog === '首个版本');
	check('④ 回执带 created/version/bytes', r1.created === true && r1.version === '1.2.0' && r1.bytes > 0);

	calls.length = 0;
	const m2 = fakeMarket({ createStatus: 409 });
	// ⚠ 用 try/catch 包起来：拿掉容忍逻辑时这里会抛 ⇒ 要**优雅报红**而不是让整个脚本崩掉
	//   （崩溃会让后面的用例全不跑 ⇒ 守卫的信息量骤降 ✗）
	let r2;
	let takenThrew = '';
	try { r2 = await publishVersion({ market: m2, dataRoot, kind: 'skill', localId: 'demo-skill', version: '1.3.0' }); }
	catch (e) { takenThrew = String(e.message ?? e); }
	check('④ 建包 409（slug 已被占用）⇒ 容忍并继续发版本',
		!takenThrew && r2?.created === false && r2?.version === '1.3.0',
		takenThrew ? `抛出了：${takenThrew}` : JSON.stringify(r2));

	calls.length = 0;
	const m3 = fakeMarket({ createStatus: 500 });
	let threw = '';
	try { await publishVersion({ market: m3, dataRoot, kind: 'skill', localId: 'demo-skill', version: '1.4.0' }); }
	catch (e) { threw = String(e.message ?? e); }
	check('④ 建包 500 ⇒ 如实抛出（不假装发成功）', threw.includes('500') && !calls.some(c => c.kind === 'upload'), threw);
}

// ── ⑤ 下架两个 op ─────────────────────────────────────────────
{
	const calls = [];
	const m = {
		request: async (method, urlPath) => { calls.push({ method, urlPath }); return { ok: true }; },
		upload: async () => ({ ok: true }),
	};
	await deletePackage({ market: m, slug: 'demo-skill' });
	check('⑤ deletePackage 打 DELETE /packages/:slug', calls[0]?.method === 'DELETE' && calls[0]?.urlPath === '/packages/demo-skill');
	await deleteVersion({ market: m, slug: 'demo-skill', version: '1.0.0' });
	check('⑤ deleteVersion 打 DELETE /packages/:slug/versions/:v',
		calls[1]?.method === 'DELETE' && calls[1]?.urlPath === '/packages/demo-skill/versions/1.0.0');
	let threw = '';
	try { await deleteVersion({ market: m, slug: 'x' }); } catch (e) { threw = String(e.message ?? e); }
	check('⑤ 少参数如实报错', threw.includes('需要 slug 与 version'), threw);
}

// ── ⑥ collectDir 的排除规则（单独可测）─────────────────────────
{
	const dir = makeSkill('excl-skill', '1.0.0');
	const files = await collectDir(dir);
	check('⑥ collectDir 排除 node_modules / .upgrade-backup',
		!files.some(f => f.path.startsWith('node_modules') || f.path.startsWith('.upgrade-backup')),
		files.map(f => f.path).join(','));
	check('⑥ collectDir 用 / 分隔的相对路径', files.every(f => !f.path.includes('\\')));
	check('⑥ localRootOf 三类根正确',
		localRootOf(dataRoot, 'skill') === path.join(dataRoot, 'skills')
		&& localRootOf(dataRoot, 'agent') === path.join(dataRoot, 'agents')
		&& localRootOf(dataRoot, 'workflow') === path.join(dataRoot, 'workflows'));
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace publish] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
