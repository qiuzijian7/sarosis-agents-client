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

	const entries = (await listTarGzEntries(prepared.gzBuffer)).files.map(f => f.path).sort();
	check('① 包内是目录镜像（含 SKILL.md + scripts）', entries.includes('SKILL.md') && entries.includes('scripts/run.sh'), entries.join(','));
	check('① 包内只有一份 manifest.json（旧的不重复）', entries.filter(p => p === 'manifest.json').length === 1);
	check('① 排除了 node_modules / .upgrade-backup', !entries.some(p => p.startsWith('node_modules') || p.startsWith('.upgrade-backup')), entries.join(','));
	// ⚠ 解压是 async ⇒ 这个 IIFE 必须 async + await（不是笔误）
	const manifestInPack = await (async () => {
		const raw = (await listTarGzEntries(prepared.gzBuffer)).files.find(f => f.path === 'manifest.json');
		return JSON.parse(raw.data.toString('utf8'));
	})();
	check('① 包内 manifest.json 与返回值一致',
		manifestInPack.id === 'demo-skill' && manifestInPack.version === '1.2.0');

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
	// ★ 2026-10-22 晚：agent **已可发布**（目录镜像含 `.agent.md`，IDE 侧安装器也已认它）
	const ag = await preparePublishBundle({ dataRoot, kind: 'agent', localId: 'demo-agent', version: '3.0.0' });
	check('② agent 可发布（目录镜像：.agent.md 原样进包）',
		ag.manifest.kind === 'agent'
		&& (await listTarGzEntries(ag.gzBuffer)).files.some(f => f.path === '.agent.md'));
	// ★ 2026-10-23：mcp 也能由 dsh 侧打包（目录镜像，入口 config.json）
	check('② PUBLISHABLE_KINDS = skill / workflow / agent / mcp',
		PUBLISHABLE_KINDS.join(',') === 'skill,workflow,agent,mcp', PUBLISHABLE_KINDS.join(','));
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

// ── ⑨ 本地可发布资源的枚举（发布表单的数据源）────────────────────
{
	const { listPublishables } = await import(pathToFileURL(path.join(LIB, 'localResources.js')).href);
	const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-pubables-'));
	// 正常的 skill（frontmatter 带 version）
	fs.mkdirSync(path.join(root2, 'skills', 'ok-skill'), { recursive: true });
	fs.writeFileSync(path.join(root2, 'skills', 'ok-skill', 'SKILL.md'), '---\nname: ok-skill\nversion: 2.1.0\n---\n\n正文\n');
	// 缺 SKILL.md ⇒ 不该列出（发布必失败）
	fs.mkdirSync(path.join(root2, 'skills', 'no-entry'), { recursive: true });
	fs.writeFileSync(path.join(root2, 'skills', 'no-entry', 'README.md'), 'x');
	// 备份目录 ⇒ 跳过
	fs.mkdirSync(path.join(root2, 'skills', '.upgrade-backup', 'old'), { recursive: true });
	// 正常 workflow
	fs.mkdirSync(path.join(root2, 'workflows', 'ok-wf'), { recursive: true });
	fs.writeFileSync(path.join(root2, 'workflows', 'ok-wf', 'workflow.json'), JSON.stringify({ id: 'ok-wf', version: '3.2.1' }));
	// 普通文件（不是目录）⇒ 跳过
	fs.writeFileSync(path.join(root2, 'skills', 'stray.txt'), 'x');
	// ★ 2026-10-22 晚：agent **可以**发布了 ⇒ 这个目录应该出现在列表里（入口是 `.agent.md`）
	fs.mkdirSync(path.join(root2, 'agents', 'some-agent'), { recursive: true });
	fs.writeFileSync(path.join(root2, 'agents', 'some-agent', '.agent.md'), '---\nid: some-agent\nname: a\nversion: 4.5.6\n---\n');

	const list = await listPublishables(root2);
	check('⑨ 列出正常的 skill（带 frontmatter 版本）',
		list.some(it => it.kind === 'skill' && it.localId === 'ok-skill' && it.version === '2.1.0'), JSON.stringify(list));
	check('⑨ 列出正常的 workflow（带 workflow.json 版本）',
		list.some(it => it.kind === 'workflow' && it.localId === 'ok-wf' && it.version === '3.2.1'));
	check('⑨ 跳过缺关键文件的目录（发布必失败的不列）', !list.some(it => it.localId === 'no-entry'));
	check('⑨ 跳过 `.upgrade-backup` 与普通文件', !list.some(it => it.localId === '.upgrade-backup' || it.localId === 'stray.txt'));
	// ★ 2026-10-22 晚：agent 已可发布 ⇒ **应该**列出（且版本从 `.agent.md` 的 frontmatter 读）
	check('⑨ **列**出 agent（入口 `.agent.md`，版本从 frontmatter 读）',
		list.some(it => it.kind === 'agent' && it.localId === 'some-agent' && it.version === '4.5.6'),
		JSON.stringify(list.map(i => `${i.kind}:${i.localId}@${i.version}`)));
	fs.rmSync(root2, { recursive: true, force: true });
}

// ── ⑩ 页面的"发布"入口：按钮 / 表单 / 事件必须齐全 ────────────────
//   背景：能力做了但**没有 UI 入口**，用户就"上传不了"（用户明确要求"可上传"）✗
//   ⇒ 源码级钉住：工具栏有发布按钮、表单有资源/版本/说明三个字段、事件有打开/关闭/提交 ✓
{
	const clientSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
	// ⚠ 判据一律**契约级**（文案 / 调的 op / 组件职责），**不绑实现细节**。
	//   教训：这些断言原本写的是 `data-openpublish` / `vs-mp-pub-pick` 这类**DOM 属性名**，
	//   页面从原生 DOM 换成 React 后 **13 条全部假红** —— 绑实现细节的守卫会惩罚重构 ✗
	check('⑨ 页面有「发布」按钮（否则能力做了也没入口）',
		clientSrc.includes("'发布'") && clientSrc.includes("'发布中…'"));
	check('⑨ 发布表单三要素齐全（资源 / 版本 / 更新说明）',
		/\bpick\b/.test(clientSrc) && /\bversion\b/.test(clientSrc) && /\bchangelog\b/.test(clientSrc)
		&& clientSrc.includes('PublishDrawer'));
	check('⑨ 表单数据来自 Host 的 publishables op（不让用户手打 id）',
		clientSrc.includes("action('publishables'") && idxSrc.includes("'publishables'"));
	check('⑨ 版本为空时**前端就拦**（不发一个注定失败的请求）',
		/if \(!version\) \{[\s\S]{0,160}return;/.test(clientSrc));
	// ⚠ 契约级：不绑"一次写完参数字面量"的写法（重构后改成先构造 params 再传）
	check('⑨ 提交走 publish op 且参数含 kind / localId / version / changelog',
		/params\s*=\s*\{\s*kind:[^}]*localId:[^}]*version:/.test(clientSrc)
		&& clientSrc.includes("action('publish', params)"));
	check('⑨ GitHub 源模式下会把 source 一起提交（本体不打包）',
		/params\.source\s*=/.test(clientSrc));
}

// ── ⑫ 页面必须是 **React** 实现（2026-10-22 用户要求重写）──────────────
//   为什么守这条：自托管页**不在** dsh 的 chunk 装载器里 ⇒ 不能 `require("react")`
//   ⇒ 必须自带 UMD（vendor 两个文件 + 页面按序引入）⇒ 少了任何一个都是**白屏** ✗
{
	const clientSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
	const vendorDir = path.resolve(HERE, '..', 'lib', 'vendor');

	check('⑫ 页面用 React（全局 React + createRoot）',
		clientSrc.includes('window.React') && /ReactDOM\.createRoot\(/.test(clientSrc));
	check('⑫ React 缺装载时**如实报错**（不静默白屏）',
		/clientSrc/.test('') === false && /没有装载成功/.test(clientSrc));
	check('⑫ vendor 里有 React 与 ReactDOM（自托管页自带，不依赖别人的 vendor）',
		fs.existsSync(path.join(vendorDir, 'react.production.min.js'))
		&& fs.existsSync(path.join(vendorDir, 'react-dom.production.min.js')));
	check('⑫ Host 有发 vendor 的路由', /vendor\/react\.js/.test(idxSrc) && /vendor\/react-dom\.js/.test(idxSrc));
	check('⑫ 页面按 react → react-dom → client.js 的**顺序**引入（顺序错就是白屏）', (() => {
		const m = /<\/body>/.test(idxSrc);
		const iReact = idxSrc.indexOf('vendor/react.js');
		const iDom = idxSrc.indexOf('vendor/react-dom.js');
		const iClient = idxSrc.indexOf('}/client.js');
		return m && iReact > 0 && iDom > iReact && iClient > iDom;
	})());
	check('⑫ client.js 是**普通 script**（不是 ESM：自托管页没有 import 解析）',
		!/^\s*import\s+[\s\S]{0,200}from\s+'/m.test(clientSrc) && !/^\s*export\s+/m.test(clientSrc));
}

// ── ⑪ 分页与编辑：页面与 Host 必须真的接上 ──────────────────────
{
	const clientSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
	const mcSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'marketClient.js'), 'utf8');

	// 分页：商城里单类 500+ 条 ⇒ 不分页等于看不到大部分 ✗
	check('⑪ list 支持分页（page/pageSize 都发给服务端）',
		/qs\.set\('page',\s*String\(opts\.page\)\)/.test(mcSrc) && /qs\.set\('pageSize'/.test(mcSrc));
	check('⑪ Host 把 page 透传给 client', /params\.page > 0 \? \{ page: params\.page \}/.test(idxSrc));
	check('⑪ 页面有「加载更多」且是**追加**（不清空已看到的）',
		clientSrc.includes('加载更多') && /fetchPage\([^)]*,\s*true\)/.test(clientSrc));
	check('⑪ 换页签/改搜索时从第一页重来', /fetchPage\(1,\s*false\)/.test(clientSrc));
	check('⑪ 「加载更多」只在还有剩余时出现（items < total）',
		/items\.length < total/.test(clientSrc));

	// 编辑元数据（作者/管理员）—— "可维护"的另一半
	check('⑪ 页面有「编辑信息」按钮且按 permissions.canEdit 渲染',
		clientSrc.includes('编辑信息') && /perm\.canEdit !== false/.test(clientSrc));
	check('⑪ Host 有 updatePackage op（纯 HTTP，服务端 assertAuthor 判权）',
		idxSrc.includes("op === 'updatePackage'") && mcSrc.includes('async function updatePackage'));
	// ⚠ 契约级：映射已收进 `shape.js` 的 `toPackageDetail`（不再写在 index.js 里）
	const shapeSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'shape.js'), 'utf8');
	check('⑪ detail 带 visibility/featured（否则编辑表单回显错、可见性每次被重置）',
		/visibility: p\.visibility \?\? 'public'/.test(shapeSrc)
		&& /featured: p\.featured === true/.test(shapeSrc)
		&& /toPackageDetail\(pkg\)/.test(idxSrc));
	check('⑪ 编辑表单是**受控组件**（React 下 value+onChange ⇒ 不会再出现"打字被渲染吞掉"）',
		/EditDrawer/.test(clientSrc) && /onChange:\s*function \(e\) \{ props\.onChange\(\{ name:/.test(clientSrc));

	// 排序（服务端原生支持 recent|popular|name ⇒ 列表一长就必需）
	check('⑪ client 发 sort 参数', /qs\.set\('sort', opts\.sort\)/.test(mcSrc));
	check('⑪ Host **只透传三个合法值**（非法值不传 ⇒ 用服务端默认，不报错）',
		/params\.sort === 'recent' \|\| params\.sort === 'popular' \|\| params\.sort === 'name'/.test(idxSrc));
	check('⑪ 页面有排序下拉且切排序重新拉第一页',
		clientSrc.includes('最热') && /setSort\(e\.target\.value\)/.test(clientSrc));

	// 分类筛选（服务端 category 参数；分类清单从已加载列表累积提取，不加后端接口）
	check('⑪ 分类筛选把 category 传给 Host', /params\.category = category/.test(clientSrc));
	check('⑪ 分类清单**累积**提取（加载更多后下拉项不跳变）',
		/known\[c\] = true/.test(clientSrc) || /new Set\(state\.categories\)/.test(clientSrc));
	check('⑪ 切 kind 时清空分类（不同类型的分类是两套，留着会"选了就空列表"）',
		/setKind\(id\);[\s\S]{0,80}setCategory\(''\)/.test(clientSrc));
	check('⑪ 分类少于 2 个时不显示（只有一个分类是噪音）',
		/cats\.length < 2 && !category/.test(clientSrc));
}

// ── ⑬ 页面**必须自带底色**（2026-10-23 真机"白屏"的根因，防回归）──────────
//   实测：dsh 页面 iframe 里 `--dsw-*` / `--vscode-*` **全部未定义** ⇒ 所有
//   `var(--dsw-*, …)` 都走兜底值；而页面原先**没有自己的背景色** ⇒ 宿主给白底时
//   兜底的浅色文字（#ddd / #e6e6e6）落在白底上 ⇒ 对比度 ≈1.2:1 ⇒ **看着像白屏** ✗
//   ⇒ 页面必须自带非透明底色，不依赖宿主变量 ✓
{
	const css = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'page.css'), 'utf8');
	// 抓 `html, body { ... }` 这一段（允许中间有换行与空格）
	const block = /html\s*,\s*body\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
	check('⑬ page.css 定义了 html/body 块（页面自带底色，不靠宿主）', block.length > 0);
	check('⑬ html/body 有**非透明** background（白底宿主的根因）',
		/background\s*:\s*#[0-9a-fA-F]{3,8}/.test(block) || /background\s*:\s*rgb/.test(block), block.slice(0, 120));
	check('⑬ html/body 有明确的 color（不能靠继承宿主的黑字）',
		/color\s*:\s*#[0-9a-fA-F]{3,8}/.test(block) || /color\s*:\s*rgb/.test(block));
	check('⑬ 声明 color-scheme（滚动条/表单控件跟着深色，避免割裂）',
		/color-scheme\s*:\s*dark/.test(block));
	check('⑬ #vs-mp-root 有 min-height（内容少时不露透明区 = 另一种"白屏"）',
		/#vs-mp-root\s*\{[\s\S]{0,160}min-height\s*:\s*100vh/.test(css));
}

// ── ⑭ 商品图标（2026-10-23：用户要"item 有图像显示，可懒加载"）────────────
//   实测服务端**没有封面字段**，`icon` 全是同一个默认 emoji ⇒ 光显示 icon 等于没有图像信息 ✗
//   ⇒ 判据：图片走**原生懒加载**、失败要退回 emoji（不留空格子/破图）、空值按类型兜底
{
	const page = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const css = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'page.css'), 'utf8');

	// 卡片一次 + 详情一次（至少两处调用）⇒ split 会得到 3 段
	const iconCallCount = page.split('h(PkgIcon').length - 1;
	check('⑭ 有图标组件 PkgIcon，且卡片/详情都用它',
		/function\s+PkgIcon\s*\(/.test(page) && iconCallCount >= 2,
		`定义=${/function\s+PkgIcon\s*\(/.test(page)} 调用=${iconCallCount}`);
	check('⑭ 图片走**原生懒加载**（loading=lazy + decoding=async）',
		/loading:\s*'lazy'/.test(page) && /decoding:\s*'async'/.test(page));
	check('⑭ 图片加载失败 ⇒ 退回 emoji（不留空格子、不显示破图）',
		/onError:\s*function\s*\(\)\s*\{\s*setEmoji\(fallbackEmoji\)/.test(page));
	check('⑭ 外链图片带 no-referrer（否则部分站点防盗链会 403）',
		/referrerPolicy:\s*'no-referrer'/.test(page));
	check('⑭ 只把 http(s)/data:image 当图片，其余（emoji/短文本）当文字',
		/\^\(https\?:\\\/\\\/\|data:image\\\/\)/i.test(page));
	check('⑭ 空 icon 按类型兜底（agent 🤖 / skill ⚡ / workflow 🔀 …）',
		page.includes("agent: '🤖'") && page.includes("skill: '⚡'") && page.includes("workflow: '🔀'"));
	check('⑭ 图标底色按 slug **稳定**（同一商品刷新不变色）',
		/function hueOf\(/.test(page) && /hueOf\(pkg\.slug \|\| pkg\.name/.test(page));
	check('⑭ 图标格**尺寸固定**（懒加载前后不跳版）',
		/\.vs-mp-icon\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(css),
		(css.match(/\.vs-mp-icon\s*\{[^}]*\}/) ?? [''])[0].slice(0, 100));
	check('⑭ 卡片顶部是「图标 + 标签/标题」横向布局',
		/\.vs-mp-card-top\s*\{[^}]*display:\s*flex/.test(css) && page.includes("'vs-mp-card-top'"));
}

// ── ⑮ 商品缩略图（2026-10-23：参考 colorskill 的 gallery 布局）──────────────
//   数据来源：`tools/fetch-covers.mjs` 从 Cola Skill 页面的 `og:image` 抓来写进 `icon`
//   （131 个商品已回填）。前端只要"icon 是图片地址"就渲染缩略图 ✓
{
	const page = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const css = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'page.css'), 'utf8');
	const toolPath = path.resolve(HERE, '..', 'tools', 'fetch-covers.mjs');
	const tool = fs.existsSync(toolPath) ? fs.readFileSync(toolPath, 'utf8') : '';

	check('⑮ 有缩略图组件 PkgCover，且卡片/详情都用它',
		/function\s+PkgCover\s*\(/.test(page) && page.split('h(PkgCover').length - 1 >= 2);
	check('⑮ 缩略图同样**懒加载**（一页几十张图，必须 lazy）',
		/loading:\s*'lazy'/.test(page) && /decoding:\s*'async'/.test(page));
	check('⑮ 有缩略图时**不再渲染小图标**（否则重复占位）',
		/hasCover\s*\?\s*null\s*:\s*h\(PkgIcon/.test(page), '缺 hasCover 三元');
	check('⑮ 封面尺寸固定 16:9（懒加载前后不跳版）',
		/\.vs-mp-cover\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/.test(css));
	check('⑮ 封面用 object-fit: cover（不同比例图都不变形）',
		/\.vs-mp-cover img\s*\{[^}]*object-fit:\s*cover/.test(css));
	check('⑮ 卡片里封面**贴边**（负 margin 抵消卡片 padding）',
		/\.vs-mp-cover\s*\{[^}]*margin:\s*-14px\s+-16px/.test(css));

	// 抓取工具：必须从 Cola Skill 取 og:image，且幂等（只补没有真图的）
	check('⑮ 有抓取工具 tools/fetch-covers.mjs', tool.length > 0, toolPath);
	check('⑮ 抓取工具从 og:image 取图（twitter:image 兜底）',
		/og:image/i.test(tool) && /twitter:image/i.test(tool));
	check('⑮ 抓取工具只处理 Cola Skill 链接的商品（不瞎抓）',
		/colaskill\\?\.com/i.test(tool));
	check('⑮ 抓取工具**幂等**：已是图片地址就跳过（`--force` 才覆盖）',
		/--force/.test(tool) && /isImageIcon/.test(tool));
	check('⑮ 抓取工具用 OSS 缩略参数 w_480（不用 1920 原图拖慢列表）',
		/THUMB_WIDTH\s*=\s*480/.test(tool) && /x-oss-process/i.test(tool));
	check('⑮ 抓取工具是运维脚本（不进 files 白名单，不随插件分发）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
		return !pkg.files.some(f => f.startsWith('tools/'));
	})());
}

// ── ⑯ 公开市场工作台同步（2026-10-23：把「设置→工作台商城」的数据爬进我们商城）──
//   数据源 = `https://market.dshdesktop.com/index.json`（协议 v2）
//   IDE 的「设置→工作台商城」读的就是它；dsh Host 的 `/x/market/api/catalog` 只是它的快照+策展
{
	const toolPath = path.resolve(HERE, '..', 'tools', 'sync-market-workbenches.mjs');
	const tool = fs.existsSync(toolPath) ? fs.readFileSync(toolPath, 'utf8') : '';

	check('⑯ 有公开市场同步脚本', tool.length > 0, toolPath);
	check('⑯ 数据源是官方市场目录（可覆盖，便于换环境/测试）',
		/market\.dshdesktop\.com\/index\.json/.test(tool) && /MARKET_CATALOG/.test(tool));
	check('⑯ 读的是协议 v2 的 `workbenches`（也兼容 `items`）',
		/catalog\.workbenches/.test(tool) && /catalog\.items/.test(tool));
	check('⑯ slug 用 `owner-repo`（不同人同名仓库不会撞车）',
		/function slugOf\(/.test(tool) && /item\?\.id/.test(tool) && /replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/.test(tool));
	check('⑯ distribution 三种都映射（github-source / github-release / npm）',
		/'github-release'/.test(tool) && /'github-source'/.test(tool) && /'npm'/.test(tool));
	check('⑯ 映射不了就**跳过**（不编造来源）',
		/return null;/.test(tool) && /来源无法映射/.test(tool));
	check('⑯ 缩略图取 `screenshots[0]` 并上传自持（不是存外链）',
		/screenshots/.test(tool) && /api\/v1\/covers/.test(tool) && /updatePackage\(slug, \{ icon/.test(tool));
	check('⑯ 只同步 listed / installable 的（下架与不可装的不入库）',
		/w\.listed === false/.test(tool) && /w\.installable === false/.test(tool));
	check('⑯ 幂等（已存在 ⇒ skipped；`--force` 才重发版本）',
		/--force/.test(tool) && /skip/.test(tool) && /409/.test(tool));
	check('⑯ 同步脚本是运维工具（不进 files 白名单）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
		return !pkg.files.some(f => f.startsWith('tools/'));
	})());

	// ★★ 2026-10-23 用户："内置的工作台不用在商城中展示，我们会随版本更新"
	//   ⇒ 「同步本机工作台」这个能力必须**已经移除**，否则误点一次就把 14 个内置
	//     插件又同步回商城（那正是被要求清掉的数据）✗
	check('⑯ **不再有**「同步本机工作台」能力（内置随版本更新，不进商城）', (() => {
		const idx = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
		const page = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
		const lib = path.resolve(HERE, '..', 'lib');
		return !idx.includes('syncWorkbenches')
			&& !page.includes('syncWorkbenches')
			&& !fs.existsSync(path.join(lib, 'workbenches.js'));
	})());
}

// ── ⑰ 文案兜底 + 卡片尺寸调整（2026-10-23 真机 bug + 用户需求）──────────
//   ① 公开市场的 `description` 是 `{zh,en}` 对象 ⇒ `String(obj)` 渲染成 `[object Object]` ✗
//      19/19 商品都中招（用户截图反馈）。Host 侧 `shape.textOf` + 页面 `textOf` 双兜底。
//   ② 用户要"item 大小调整按钮" ⇒ 三档（小/中/大）改 `--vs-mp-card-min`，auto-fill 自动重排。
{
	const shapeSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'shape.js'), 'utf8');
	const page = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const css = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'page.css'), 'utf8');
	const tool = fs.readFileSync(path.resolve(HERE, '..', 'tools', 'sync-market-workbenches.mjs'), 'utf8');
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');

	// ① 多语言文本兜底
	check('⑰ Host 侧有 `textOf`（多语言对象 ⇒ 字符串）', /export function textOf\(/.test(shapeSrc));
	check('⑰ `baseOf` 的 name/description/author/category 都过 textOf（否则入库即 `[object Object]`）',
		/name: textOf\(p\.name\)/.test(shapeSrc)
		&& /description: textOf\(p\.description\)/.test(shapeSrc)
		&& /author: textOf\(/.test(shapeSrc)
		&& /category: textOf\(p\.category\)/.test(shapeSrc));
	check('⑰ 页面侧也兜一层（mock / 旧缓存也吃得下）',
		/function textOf\(v\)/.test(page) && /textOf\(pkg\.description\)/.test(page)
		&& /textOf\(d\.description\)/.test(page));
	check('⑰ 同步脚本用 `pickText` 处理 `{zh,en}`（不是 String 硬转）',
		/function pickText\(/.test(tool) && /description: pickText\(w\.description\)/.test(tool));
	check('⑰ 重跑同步会**顺手修正**已存在的脏文案（自动治愈，不用手工改库）',
		/fixedText/.test(tool) && /updatePackage\(slug, \{/.test(tool));

	// ② 卡片尺寸调整
	check('⑰ 页面有尺寸三档（小 / 中 / 大）',
		/var SIZES = \[/.test(page) && /label: '小'/.test(page) && /label: '中'/.test(page) && /label: '大'/.test(page));
	check('⑰ 选择**持久化**（localStorage，刷新不丢）',
		/vs-mp-card-size/.test(page) && /localStorage\.setItem/.test(page) && /localStorage\.getItem/.test(page));
	check('⑰ 网格列数由 `--vs-mp-card-min` + auto-fill 决定（档位一变自动重排）',
		/repeat\(auto-fill, minmax\(var\(--vs-mp-card-min/.test(css)
		&& /--vs-mp-card-min': sizeMin \+ 'px'/.test(page));
	check('⑰ 已删掉写死的 3 列 + 媒体查询（否则档位不生效）',
		!/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(css));
	check('⑰ 尺寸按钮有高亮态（.on）', /\.vs-mp-size-btn\.on/.test(css));

	// ③ 服务端字段映射仍是单一真源（这条与 ⑰ 同源，防止有人绕过 shape 直接拼）
	check('⑰ index.js 不自己拼 name/description（都走 shape）',
		!/description: pkg\.description/.test(idxSrc));
}

// ── ⑱ `cover`（16:9 缩略图）与 `icon`（小图标）**分离**（2026-10-24）──────
//   背景：此前把 16:9 大图塞进 `icon` ⇒ 只想要小图标的地方（侧栏/通知/弹窗）都得自己裁剪 ✗
//   约定：列表卡片用 `cover`；小图标位置用 `icon`；缺 cover ⇒ 走 emoji 兜底，**不拿大图顶替**
{
	const shape = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'shape.js'), 'utf8');
	const page = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const tool = fs.readFileSync(path.resolve(HERE, '..', 'tools', 'fetch-covers.mjs'), 'utf8');

	check('⑱ 服务端字段映射有 cover（detail/list 共用 shape）',
		/cover: p\.cover \?\? ''/.test(shape));
	check('⑱ PkgCover **只读 cover**（不再拿 icon 当大图）',
		/\(props\.pkg \|\| \{\}\)\.cover \|\| ''/.test(page) && !/\(props\.pkg \|\| \{\}\)\.icon \|\| ''/.test(page));
	check('⑱ 卡片"有没有封面"判定用 cover',
		/useCoverFallback\(pkg\.cover\)/.test(page));
	check('⑱ 抓取工具写 **cover** 而不是 icon',
		/updatePackage\(pkg\.slug, \{ cover: icon \}\)/.test(tool));
	check('⑱ 详情抽屉：有 cover 才隐藏小图标（用 d.cover 判）',
		/isImageIcon\(d\.cover\)/.test(page));
}

// ── ⑲ 从 Cline MCP Marketplace 爬取（2026-10-24 用户需求）────────────
//   数据源查证：Cline 商城前端是 Next.js SSR（数据在服务端），开源仓库 `cline/cline`
//   只有调用代码 ⇒ **唯一可公开爬取的结构化数据**是提交仓库的 Issues：
//   `cline/mcp-marketplace`（3121 条：2868 open / 253 closed，issue body 里有
//   `### GitHub Repository URL` + `### Logo Image`）
{
	const toolPath = path.resolve(HERE, '..', 'tools', 'sync-cline-mcp.mjs');
	const tool = fs.existsSync(toolPath) ? fs.readFileSync(toolPath, 'utf8') : '';

	check('⑲ 有 Cline 商城同步脚本', tool.length > 0, toolPath);
	check('⑲ 数据源是 `cline/mcp-marketplace` 的 Issues', /cline\/mcp-marketplace/.test(tool) && /api\.github\.com/.test(tool));
	check('⑲ 支持 `GITHUB_TOKEN`（未认证只有 60 请求/h，253 条要 3 页）', /GITHUB_TOKEN/.test(tool));
	check('⑲ 默认只同步 **closed**（提交池 ≠ 已上架，open 是未审核）', /'closed'/.test(tool) && /\[&#39;open&#39;, &#39;closed&#39;, &#39;all&#39;\]|\[\\?'open\\?', \\?'closed\\?', \\?'all\\?'\]/.test(tool));
	check('⑲ 小节解析兼容 `##` / `###`（早期提交通常用二级标题）', /#\{2,4\}/.test(tool));
	check('⑲ logo 兼容 `<img src>` 与裸 URL 两种形态',
		/beskLogo/.test(tool) === false && /pickLogo/.test(tool) && tool.includes('src=[') && tool.includes('https?:'));
	check('⑲ slug 用 `owner-repo`（不同人同名仓库不撞车）',
		/function slugOf/.test(tool) && tool.includes('github.com/') && tool.includes('replace(/-+/g'));
	check('⑲ 封面写 **cover**（不是 icon），并上传自持', /updatePackage\(e\.slug, \{ cover: up\.url \}\)/.test(tool) && /api\/v1\/covers/.test(tool));
	check('⑲ 封面失败**不静默**（记录到 failures，而不是 `catch {}`）', /封面上传失败/.test(tool) && /写 cover 失败/.test(tool));
	check('⑲ 只认 github-source（repo 即安装源）', /'github-source'/.test(tool));

	// ★ 本轮真机踩到的客户端 bug：`updatePackage` 白名单漏了 cover ⇒
	//   调用方收到「没有要改的字段」这种风马牛不相及的报错 ✗
	const mc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'marketClient.js'), 'utf8');
	check('⑲ `marketClient.updatePackage` 白名单**含 cover**（漏了会报「没有要改的字段」）',
		/if \(typeof patch\.cover === 'string'\) \{ body\.cover = patch\.cover; \}/.test(mc));

	check('⑲ 同步脚本是运维工具（不进 files 白名单）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
		return !pkg.files.some(f => f.startsWith('tools/'));
	})());
}

// ── ⑳ MCP 版本对齐（2026-10-24 用户："去各自的 repo 读 package.json"）──────
//   背景：从 Cline 提交 Issue 同步时全部记成 `1.0.0` 占位（Issue 里没有版本）。
//   坑：服务端 `latest_version` 是**按 semver 最大**取，不是"最后发布的"
//       ⇒ 占位 `1.0.0` 永远压过真实版本 `0.2.0`（历史是 `0.2.0, 1.0.0` 但 latest=1.0.0）✗
//       ⇒ 发完真实版本必须**删掉占位 1.0.0**
{
	const toolPath = path.resolve(HERE, '..', 'tools', 'sync-mcp-versions.mjs');
	const tool = fs.existsSync(toolPath) ? fs.readFileSync(toolPath, 'utf8') : '';

	check('⑳ 有 MCP 版本对齐脚本', tool.length > 0, toolPath);
	check('⑳ 从 `distribution_meta.name`（owner/repo）取仓库',
		/distribution_meta\?\.name/.test(tool));
	check('⑳ 读 `package.json`（raw.githubusercontent，不占 API 额度）',
		/raw\.githubusercontent\.com/.test(tool) && /package\.json/.test(tool));
	check('⑳ 依次试 HEAD / main / master（默认分支不统一）',
		/\['HEAD', 'main', 'master'\]/.test(tool));
	check('⑳ 版本要像版本号（挡 `0.0.0` / 占位）', /function isRealVersion/.test(tool));
	check('⑳ **发完真实版本要删占位 1.0.0**（否则 semver 最大仍指向占位）',
		/needPrune = cur === '1\.0\.0' && real !== '1\.0\.0'/.test(tool) && /deleteVersion\(\{ market, slug: p\.slug, version: '1\.0\.0' \}\)/.test(tool));
	check('⑳ 顺手清掉 `_No response_`（Issue 表单占位符曾被当描述入库）',
		/PLACEHOLDERS/.test(tool) && /_No response_/.test(tool));
	check('⑳ 非 Node 项目**如实报**（不是静默跳过）', /没有 package\\?\.json/.test(tool));
	// ★ Releases 回退：非 Node 项目（Python/Go/Rust）没有 package.json，
	//   用 `github.com/<repo>/releases/latest` 的 **302 Location** 取 tag。
	//   为什么不打 `api.github.com/repos/:o/:r/releases/latest`：那**占 API 额度**
	//   （未认证 60/h，67 个项目直接撞墙）✗ 而普通跳转不占额度 ✓
	check('⑳ Releases 回退用 **302 Location** 取 tag（不占 GitHub API 额度）',
		/redirect: 'manual'/.test(tool) && tool.includes('/releases/tag/') && /readReleaseVersion/.test(tool));
	check('⑳ 剥掉 tag 的 `v` 前缀（`v1.2.3` → `1.2.3`）',
		/replace\(\/\^\(v\|ver\|release\[-_\]\?\)\/i/.test(tool));
	check('⑳ `--no-releases` 可关掉回退（只想读 package.json 时）',
		/USE_RELEASES/.test(tool) && /--no-releases/.test(tool));
	check('⑳ 幂等（真实版本已在 ⇒ same，不重复发）', /if \(real === cur\) \{/.test(tool));
	// 只清"**有内容且是占位符**"的描述：原条件含 `desc.length === 0` ⇒
	// 每次跑都会对空描述白调一次 `updatePackage({description:''})`（真机日志里看到）
	check('⑳ 只清「有内容且是占位符」的描述（空描述不反复调 updatePackage）',
		/const needDescFix = PLACEHOLDERS\.has\(desc\);/.test(tool)
		&& !/needDescFix = PLACEHOLDERS\.has\(desc\) \|\|/.test(tool));
	check('⑳ 是运维脚本（不进 files 白名单）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
		return !pkg.files.some(f => f.startsWith('tools/'));
	})());
}


// ── ㉑ 商城「AI/智能发布助手」：贴 GitHub 链接自动填写（2026-10-27）──────────
//   用户："增加一个 ai 助手…当用户发要发布一个 github 链接时，自动填写相关信息并上传"
//   ⚠ dsh 没有给页面暴露模型 API（查过 ctx.models/ctx.chat 都不存在）⇒ 这里是**规则驱动**：
//     从 GitHub 的 og 标签 / raw 文件 / releases 302 里抓元数据，不是 LLM 对话。
//   ★ 硬要求：**全程不占 GitHub API 额度**（未认证只有 60 请求/小时，试几次就 403）
{
	const inspectPath = path.resolve(HERE, '..', 'lib', 'githubInspect.js');
	const src = fs.existsSync(inspectPath) ? fs.readFileSync(inspectPath, 'utf8') : '';
	check('㉑ 有 GitHub 识别模块', src.length > 0, inspectPath);
	check('㉑ 元数据走 og 标签（不占 API 额度）', /og:title/.test(src) && /og:description/.test(src) && /github\.com\/\$\{repo\}/.test(src));
	check('㉑ 版本走 raw package.json（不占额度）', /raw\.githubusercontent\.com/.test(src) && /package\.json/.test(src));
	check('㉑ 版本兜底走 releases 的 302 Location（不占额度）',
		/redirect:\s*'manual'/.test(src) && /releases\/latest/.test(src) && src.includes('releases') && src.includes('tag') && src.includes('location'));
	check('㉑ **代码里**不出现 api.github.com（注释里说明原因是可以的）',
		!src.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).some(l => l.includes('api.github.com')));
	check('㉑ tag 前缀剥离是**宽松**的（`cli-v0.3.3` → `0.3.3`）', /\^\[A-Za-z@\._\/-\]\*\(\?=\\d\)/.test(src) || src.includes('[A-Za-z@._/-]*(?='));
	check('㉑ kind 自动判定（SKILL.md ⇒ skill / 根或子包带 dsh ⇒ plugin）', /hasSkillMd/.test(src) && /rootHasDsh/.test(src) && /dshPkgs/.test(src));
	check('㉑ logo 用 owner 头像（真实且不占额度）', /github\.com\/\$\{owner\}\.png/.test(src));

	// 纯函数用例（不联网）
	const mod = await import(pathToFileURL(inspectPath).href);
	check('㉑ 链接归一化：完整 URL', mod.normalizeRepo('https://github.com/Tencent/BrowserSkill/') === 'Tencent/BrowserSkill');
	check('㉑ 链接归一化：owner/repo 简写', mod.normalizeRepo('Tencent/BrowserSkill') === 'Tencent/BrowserSkill');
	check('㉑ 链接归一化：带子路径只取前两段', mod.normalizeRepo('https://github.com/Tencent/BrowserSkill/tree/main/x') === 'Tencent/BrowserSkill');
	check('㉑ 链接归一化：无效输入返回空（不猜）', mod.normalizeRepo('not-a-repo') === '' && mod.normalizeRepo('') === '');
	check('㉑ slug 合法（小写 + 合法字符 + ≤64）', (() => { const x = mod.slugOfRepo('Tencent/BrowserSkill'); return /^[a-z0-9][a-z0-9_-]*$/.test(x) && x.length <= 64; })(), mod.slugOfRepo('Tencent/BrowserSkill'));

	// 接线：op 是**只读**（不该进写白名单），且 UI 有按钮
	const dispatchSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'dispatch.js'), 'utf8');
	const pageSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
	check("㉑ `inspectGithub` 在 LOCAL_READ_OPS（只读，不触发写审批）", /LOCAL_READ_OPS = new Set\(\[[^\]]*'inspectGithub'/.test(dispatchSrc));
	check("㉑ Host 有 `inspectGithub` 分支", /op === 'inspectGithub'/.test(idxSrc));
	check('㉑ 页面有「✨ 自动填写」按钮', pageSrc.includes('✨ 自动填写'));
	check('㉑ 自动填写只补空字段（不抢用户手填的）', /String\(pub\.slug \|\| ''\)\.trim\(\) \|\| r\.slug/.test(pageSrc));
	check('㉑ 识别结果看得见（成功/失败都有提示）', /st\.inspectNote/.test(pageSrc) && /正在识别/.test(pageSrc));
	check('㉑ 识别模块在 files 白名单里（否则装到用户机就缺文件）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
		return pkg.files.includes('lib/githubInspect.js');
	})());
}


// ── ㉒ 商城工作台：左侧商城页 + 右侧官方对话（2026-10-27）────────────────
//   用户："参考小红书、萨罗斯工作台的 ai 助手实现方式，生成解决方案" → "直接阶段 2-3"
//
//   ★ 调研结论（别再绕）：AI 助手**不是**页面自己调模型，而是
//     `customFrame: true` 的注册式工作台由宿主注入 `props.conversation`
//     （内部 = 官方 chat-surface 本体）。studio 已经把"自绘浮层 iframe 指向 dsh 根"
//     那版**删掉了** —— 会出现两套助手，且浮层里的客户端拿不到会话上下文 ✗
{
	const wbPath = path.resolve(HERE, '..', 'lib', 'workbench.js');
	const wb = fs.existsSync(wbPath) ? fs.readFileSync(wbPath, 'utf8') : '';
	const toolsPath = path.resolve(HERE, '..', 'lib', 'agentTools.js');
	const at = fs.existsSync(toolsPath) ? fs.readFileSync(toolsPath, 'utf8') : '';
	const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
	const pageJs = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');

	check('㉒ 有工作台 chunk（workbench.js）', wb.length > 0, wbPath);
	check('㉒ chunk 走 `__ModuleLoader__`（不是页面脚本）', /__ModuleLoader__\.load\(/.test(wb));
	check('㉒ 用 `require(\'react\')`（chunk 才能这么拿 React）', /require\('react'\)/.test(wb));
	check('㉒ `customFrame: true`（只有它为真才注入 props.conversation）', /customFrame: true/.test(wb) && pkg.vssaros.workbench.customFrame === true);
	check('㉒ 声明 `dsh.client`（否则 chunk 不会被加载）', pkg.dsh?.client?.platform === 'web');
	check('㉒ `exports["./client"]` 指向 workbench.js', pkg.exports['./client'] === './lib/workbench.js');

	// ★ 页面脚本**不能被 chunk 顶掉**：它走 `/x/marketplace/client.js` 路由
	check('㉒ 页面脚本仍由路由 serve（不被 chunk 顶掉）', /\$\{ROUTE_PREFIX\}\/client\.js/.test(pageJs) || pageJs.includes('/client.js'));
	check('㉒ 左侧就是现有商城页（iframe 指向 /x/marketplace/）', wb.includes("'/x/marketplace/'") || wb.includes('\"/x/marketplace/\"'));
	check('㉒ 没有对话停靠点 ⇒ 优雅降级成整页（不报错）', /if \(!conversation\)/.test(wb));

	// 拖拽条的经典坑：iframe 是独立文档，鼠标一进去父文档收不到 mouseup
	check('㉒ 拖拽期间关掉 iframe 的 pointer-events（否则拖一半断）', /pointerEvents = 'none'/.test(wb));
	check('㉒ 拖拽收尾覆盖 blur（Alt+Tab 也要恢复）', /addEventListener\('blur', onUp/.test(wb));
	// 注册要能在缺少服务时跳过（老宿主 / 非工作台形态）
	check('㉒ 缺 desktopWorkbenches 时跳过注册（页面照常可用）', /typeof dw\.register !== 'function'/.test(wb));

	// ── 阶段 3：Agent 工具 ────────────────────────────────────
	check('㉒ 有 agentTools.js', at.length > 0, toolsPath);
	check('㉒ 只读工具 `market_inspect_github`', at.includes("'market_inspect_github'"));
	check('㉒ 写工具 `market_publish`', at.includes("'market_publish'"));
	check('㉒ 写工具的 slug/version/source 是**必填**（不给默认值）', /required: \['source', 'kind', 'slug', 'version'\]/.test(at));
	check('㉒ 写工具标记 `isConcurrencySafe: false`（同 slug 并发会撞 409）', /isConcurrencySafe: \(\) => false/.test(at));
	// ⚠ 2026-10-26 改：`ctx.tools` **必须**走 `ctx.inject(['tools'])`（直接访问会抛
	//   `cannot get property "tools" without inject`，被 catch 吞掉 ⇒ 工具静默不存在）
	check('㉒ 工具注册走 `ctx.inject([tools])`，缺服务时优雅跳过',
		pageJs.includes("ctx.inject(['tools']") && pageJs.includes('typeof tools.register !== \'function\''));
	check('㉒ 两个新文件都在 files 白名单（否则装到用户机就缺）', pkg.files.includes('lib/workbench.js') && pkg.files.includes('lib/agentTools.js'));

	// ── ㉓ 按 `doc/marketplace-workbench-github-flow.html` 完善（2026-10-27）──────
	//   §7 反面案例：monorepo（根 private:true、无 dsh）当 github-source 发 ⇒
	//   **发布成功但装不上**（pnpm 拒绝 + 根没有 dsh 字段 ⇒ 装了没效果）
	//   ⇒ 必须识别出「该用 npm 子包」
	{
		const gi = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'githubInspect.js'), 'utf8');
		const nlPath = path.resolve(HERE, '..', 'lib', 'npmLookup.js');
		const nl = fs.existsSync(nlPath) ? fs.readFileSync(nlPath, 'utf8') : '';

		check('㉓ 有 npm 反查模块', nl.length > 0, nlPath);
		check('㉓ 反查走 npm search（不占 GitHub API 额度）', /registry\.npmjs\.org/.test(nl) && nl.includes('/v1/search'));
		check('㉓ 用 `repository` 字段证明归属（不是碰巧同名）', nl.includes('links?.repository') || nl.includes('repository?.url'));
		check('㉓ 反查结果带 `hasDsh`（决定它是不是 dsh 插件）', nl.includes('hasDsh'));
		check('㉓ peerRange 由 peerDependencies 压出（服务端有该字段）', nl.includes('peerRangeOf') && nl.includes('peerDependencies'));

		check('㉓ 识别根 `private: true`（pnpm 拒绝的直接原因）', gi.includes('pkgPrivate = j.private === true'));
		check('㉓ 识别 monorepo（workspaces 或 pnpm-workspace.yaml）', gi.includes('hasWorkspaces') && gi.includes('pnpm-workspace.yaml'));
		check('㉓ 给出 `recommendedDistribution`（不让调用方去猜）', gi.includes('recommendedDistribution'));
		check('㉓ **根可装才给 github-source**（rootHasDsh && !pkgPrivate）', gi.includes('rootHasDsh && !pkgPrivate'));
		check('㉓ 根不可装时**优先给 npm 子包**', gi.includes("type: 'npm'") && gi.includes('best.name'));
		check('㉓ 推荐不出时**如实说明理由**（不猜）', gi.includes('recommendWhy'));
		check('㉓ slug 跟推荐发布源走（npm 名派生，与文档 §6 A1 一致）', gi.includes('slugFromNpm'));

		check('㉓ 写工具支持 `via`（npm / github-source）', at.includes('VIA_SET') && at.includes("'github-source'"));
		check('㉓ `via=npm` 必须给 npmName', at.includes('via=npm 时必须给 npmName'));
		check('㉓ 自动识别失败时**报错并给原因**（不静默降级）', at.includes('不能直接发布'));
		check('㉓ 用 `publishDistribution`（不是硬编码 github-source 的 publishExternal）', pageJs.includes('publishDistribution,'));
		check('㉓ npmLookup 在 files 白名单', pkg.files.includes('lib/npmLookup.js'));
	}
}


	// ── ㉔ 发布原子性（`doc/…github-flow.html` §10）：失败时回滚空包（2026-10-26）──
	//   发布是两次 HTTP（建包 → 发版本）；第二步失败会留下**用户能看到的空商品**
	//   （列表里有它、点进去没版本）⇒ 若包是这次**刚建**的，就回滚掉。
	{
		const pub = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'publisher.js'), 'utf8');

		check('㉔ 有 rollbackEmptyPackage 辅助函数', pub.includes('async function rollbackEmptyPackage('));
		check('㉔ 只回滚 `created === true`（**已存在的包绝不能删** —— 会连带删掉历史版本）',
			pub.includes('if (!created) { return { rolledBack: false, reason:'));
		check('㉔ 回滚失败时**如实说明**（不谎称干净了）', pub.includes('回滚失败') && pub.includes('需要手工删除'));
		check('㉔ 成功回滚时明确告知「商城无残留」', pub.includes('已回滚刚建的空包（商城无残留）'));
		// 两条发布路径都要回滚：external（登记来源）与 raw（打包上传）
		const calls = (pub.match(/rollbackEmptyPackage\(market, localId, created\)/g) || []).length;
		check('㉔ publishDistribution 与 publishVersion **两条路径都回滚**', calls >= 2, `实际 ${calls} 处`);
		check('㉔ 抛出的错误里带上回滚结论（rollbackNote）', pub.includes('rollbackNote(created, rb)'));
	}

	// ── ㉕ 文档 §10 剩余两项：commit 锁定 + peer 兼容性提示（2026-10-26）──────
	{
		const gs = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'githubSource.js'), 'utf8');
		const pub = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'publisher.js'), 'utf8');
		const hvPath = path.resolve(HERE, '..', 'lib', 'hostVersion.js');
		const hv = fs.existsSync(hvPath) ? fs.readFileSync(hvPath, 'utf8') : '';
		// ⚠ `pkg` 在 ㉒ 块里是 `const`（块级作用域）⇒ 本块必须自己声明一次
		const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));

		// ── ① github-source 锁 commit（防 force-push 漂移 / 可复现）
		check('㉕ 有 resolveCommitSha', gs.includes('export async function resolveCommitSha('));
		check('㉕ 用 `.atom` 取 sha（**不占 GitHub API 额度**）',
			gs.includes('/commits/') && gs.includes('.atom')
			// 只查代码行（注释里解释「为什么不用 API」是应该存在的，不算违规）
			&& !gs.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).some(l => l.includes('api.github.com')));
		check('㉕ 抓不到 sha **返回空串**（不当失败）', gs.includes("return '';") && gs.includes('取不到返回'));
		check('㉕ `publishDistribution` 对 github-source 自动补 commit',
			pub.includes('resolveCommitSha(') && pub.includes("dist.type === 'github-source' && !dist.commit"));
		check('㉕ 抓不到 commit **不阻断发布**（注释写明）', pub.includes('不阻断发布'));
		check('㉕ 安装侧本来就会用 `dist.commit`（可复现闭环）',
			gs.includes("dist.commit ?? ''") || gs.includes('dist.commit'));

		// ── ② peerDependencies 兼容性：只提示、不阻断
		check('㉕ 有 hostVersion.js', hv.length > 0, hvPath);
		check('㉕ 宿主版本优先从 `process.argv[1]` 上溯（最可靠）',
			hv.includes('process.argv[1]') && hv.includes("'@deepseek-ai/dsh'"));
		check('㉕ 版本来源不可靠时**不报不兼容**（防误报 —— 多版本目录名未必是运行中的那个）',
			hv.includes('const reliable = ') && hv.includes('if (!reliable)'));
		check('㉕ satisfies 支持 `^` / `~` / `>=` / `||`',
			hv.includes("case '^':") && hv.includes("case '~':") && hv.includes("||'") || hv.includes('.split(\'||\')'));
		check('㉕ 看不懂的 range 返回 `null`（按「未知」处理，不当不兼容）',
			hv.includes('return null;') && hv.includes('看不懂'));
		// ⚠ cordis 的版本线是 4.x，而 currentDshVersion() 给的是 dsh 版本（0.2.1-*）
		//   ⇒ 拿 dsh 版本比 cordis 的 `^4.0.2` **必然误报**。所以 HOST_PEERS 只留 dsh。
		check('㉕ 只校验**能拿到准确版本**的包（cordis 版本线不同 ⇒ 不判，避免误报）',
			hv.includes('HOST_PEERS') && /HOST_PEERS = \['@deepseek-ai\/dsh'\]/.test(hv));
		check('㉕ 兼容性结论**只进 notes**（不阻断发布）',
			fs.readFileSync(path.resolve(HERE, '..', 'lib', 'githubInspect.js'), 'utf8').includes('peer 兼容性：'));
		check('㉕ hostVersion 在 files 白名单', pkg.files.includes('lib/hostVersion.js'));
	}

	// ── ㉖ 外部依赖写进商品介绍（文档 §10 最后一条，2026-10-26）──────────────
	//   商城只表达"装什么"，表达不了"装完还要装什么"。
	//   典型：BrowserSkill 的插件只给 `bsk_*` 工具，真正跑浏览器还要 bsk CLI + 扩展。
	//   ★ 原则：**只追加、不覆盖、不重复、可关** —— 作者的原文一个字都不动。
	{
		const gi = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'githubInspect.js'), 'utf8');
		const at2 = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'agentTools.js'), 'utf8');

		check('㉖ 有 detectExternalDeps 且已 export', gi.includes('export async function detectExternalDeps('));
		check('㉖ 检测走 raw（**不占 GitHub API 额度**）', gi.includes('readRaw(repo, f)') || gi.includes('readRaw(repo, readme)'));
		// 检测规则确实同时覆盖「脚本名」与「包管理器」两类信号（探针用 flat 字符串，避免正则转义踩坑）
		check('㉖ 只认**明确信号**：安装脚本 / 一行式安装命令 / 包管理器安装',
			['install.sh', 'setup.sh', 'cargo', 'brew'].every(k => gi.includes(k)));
		// ★ 关键：只匹配到 `pip install x` 这类**弱信号**时不写进介绍
		//   （实测 modelcontextprotocol/servers 的 README 里有 `pip install mcp-server-git`
		//     只是它收录的某个 server 的装法 ⇒ 写进介绍就是误导）
		check('㉖ **只有自带安装脚本才写进介绍**（弱信号不写，防误导）',
			gi.includes('files.length ? parts.join') && gi.includes('弱信号'));
		check('㉖ 拿不到明确信号返回 null（不编造）', gi.includes('if (!files.length && !installHint) { return null; }'));

		check('㉖ 只**追加**、不覆盖原文（空介绍不留前导空行）',
			at2.includes("const sep = finalDescription ? '\\n\\n---\\n' : ''") || at2.includes('const sep = finalDescription'));
		check('㉖ 作者已写明依赖时**不重复追加**', at2.includes('DEP_MENTIONED') && at2.includes('!DEP_MENTIONED.test(finalDescription)'));
		check('㉖ 可用 `includeDependencyNote: false` 关掉', at2.includes('includeDependencyNote !== false'));
		check('㉖ 追加内容**标明来源**（可编辑）', at2.includes('商城自动检测，发布后可编辑'));
		check('㉖ 检测失败**不影响发布**', at2.includes('检测失败不影响发布'));
		check('㉖ 介绍仍受 2048 上限约束', at2.includes('.slice(0, 2048)'));
	}

	// ── ㉗ 商城专用 agent（新建会话默认选中，2026-10-26）──────────────────
	//   用户："商城工作台中… 新建会话时，使用专门的商城 agent"
	//   ⚠ preset **只由 `vssaros-agents` 扫 `<数据根>/agents/*/.agent.md` 注册**
	//     ⇒ 本插件不直接 `ctx.agentPresets.register()`（那要深依赖它的 `toPresetDefinition`
	//       与 `presetBase.generated.js`，换装法路径就变了 ✗），而是**落一个 .agent.md**。
	{
		const maPath = path.resolve(HERE, '..', 'lib', 'marketAgent.js');
		const ma = fs.existsSync(maPath) ? fs.readFileSync(maPath, 'utf8') : '';
		const wb = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'workbench.js'), 'utf8');
		const pageSrc2 = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
		const pkg2 = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));

		check('㉗ 有 marketAgent.js', ma.length > 0, maPath);
		check('㉗ agent id = marketplace-bot', ma.includes("MARKET_AGENT_ID = 'marketplace-bot'"));
		check('㉗ preset id = `vssaros-marketplace-bot`（单前缀，多一层就永远 not-found）',
			ma.includes("MARKET_PRESET = 'vssaros-marketplace-bot'") && wb.includes("MARKET_PRESET = 'vssaros-marketplace-bot'"));
		check('㉗ **不写 tools 白名单**（allowlist 会把没列的全 deny ⇒ 变哑巴）',
			!ma.includes('"tools"'));
		check('㉗ 落在 `<数据根>/agents/<id>/.agent.md`（与用户自建 bot 同构）',
			ma.includes("'agents'") && ma.includes("'.agent.md'"));
		check('㉗ **幂等**：已存在不覆写（用户可能改过人设）',
			ma.includes('if (await exists(file))'));
		check('㉗ 有 rescan 时立即生效（不用重启）',
			pageSrc2.includes('state.agentsRescan') && pageSrc2.includes('await state.agentsRescan()'));

		check('㉗ 工作台包了 `newSession`（点「+ 新会话」也带同款 preset）',
			wb.includes('origNewSession') && wb.includes('dw.newSession = patched'));
		check('㉗ 包装**会还原**（dispose 放回原函数）', wb.includes('dw.newSession = origNewSession'));
		check('㉗ 不覆盖别人的钩子（已被包过就不挂）',
			wb.includes('if (dw.newSession !== origNewSession) { return; }'));
		check('㉗ 只在**面板挂载 / 新会话**时设（agentPresets 是全局的，不能抢别人的）',
			wb.includes('useEffect') && wb.includes('ensureMarketDefaults(ctx)'));
		check('㉗ 输入框预填 `@商城助手`', wb.includes("DRAFT_SEED = '@商城助手 '"));
		check('㉗ 预设 API 试多种方法名（没有公开文档）',
			wb.includes("'select'") && wb.includes("'setPreset'") && wb.includes("'selectPreset'"));
		// ★ 必须**无论 created 都 rescan**：文件已存在时（`created:false`）看似无事可做，
		//   但本次 Host 启动可能还没扫过它（插件后装 / 用户手动放文件）⇒ 不 rescan 就永远没 preset
		check('㉗ **无论 created 都 rescan**（否则文件早已存在时永远没 preset）',
			!pageSrc2.includes('!r.created || !state.agentsRescan'));
		check('㉗ marketAgent.js 在 files 白名单', pkg2.files.includes('lib/marketAgent.js'));
	}
// ── ㉘ 「＋ 新会话」按钮 + `vssarosAgents.rescan`（2026-10-26）────────────
//   用户两件事：① 商城工作台右侧**没有「＋ 新会话」按钮**（studio 有）
//              ② 让 `vssaros-agents` 补 `provide + rescan()`（否则装完插件要重启两次）
{
	const wb2 = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'workbench.js'), 'utf8');
	const agPath = path.resolve(HERE, '..', '..', 'vssaros-agents', 'lib', 'index.js');
	const ag = fs.existsSync(agPath) ? fs.readFileSync(agPath, 'utf8') : '';

	check('㉘ 有「＋ 新会话」按钮', wb2.includes('＋ 新会话') && wb2.includes('data-vssaros-market-neww'));
	check('㉘ 按钮挂进 **aside**（生命周期与面板绑定，不用轮询显隐）', wb2.includes('mountNewButton(el)'));
	check('㉘ 用原生 DOM + addEventListener（customFrame+portal 里 React onClick 不触发）',
		wb2.includes("document.createElement('button')") && wb2.includes("nb.addEventListener('click'"));
	check('㉘ 点击走宿主 `newSession`（已被我们包过 ⇒ 自动设商城 preset）', wb2.includes('dw.newSession();'));

	check('㉘ `vssaros-agents` 提供 `vssarosAgents` 服务', ag.includes("ctx.provide('vssarosAgents'"));
	check('㉘ 服务含 `rescan()`（重扫目录 + 增量注册）', ag.includes('rescan: async ()'));
	check('㉘ rescan 在 agentPresets 未就绪时**抛错**（调用方走重启兜底，不静默）',
		ag.includes('agentPresets 服务还没就绪'));
	check('㉘ 暴露 `agentsRoot()`（排查「文件放错地方」用）', ag.includes('agentsRoot: () => agentsRootOf(config)'));
}

// ── ㉙ AI 助手栏伸缩按钮（2026-10-26 用户：「AI 助手栏增加伸缩按钮」）──────
{
	const wb3 = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'workbench.js'), 'utf8');

	// ★ 收起后**整个对话栏隐藏**（`display:none`），只留面板右上角一个小按钮。
	//   为什么不再用"30px 窄条"：竖排文字在真实主题下会被拆成两列（实测截图，很难看）✗
	check('㉙ 收起时整个对话栏隐藏（不是收成窄条）',
		wb3.includes("display: collapsed ? 'none' : 'flex'"));
	// ★ 隐藏 ≠ 卸载：DOM 还在 ⇒ 会话状态 / 滚动位置 / 正在流式的回复都保住
	check('㉙ 收起**不卸载**对话（`display:none`，保住流式与会话状态）',
		wb3.includes('collapsed ? \'none\' : \'flex\'') && !wb3.includes('collapsed ? null : conversation'));
	check('㉙ 面板是定位上下文（浮动按钮才能贴右上角）',
		wb3.includes("'data-vssaros-market-panel'") && wb3.includes("position: 'relative',"));
	check('㉙ 收起后**右上角**浮一个「« AI 助手」按钮',
		wb3.includes("'data-vssaros-market-expand'") && wb3.includes("right: '10px', top: '8px'")
		&& wb3.includes("'AI 助手'"));
	check('㉙ 展开态按钮是「» 收起」、只做收起（setCollapsed(true)）',
		wb3.includes('» 收起') && wb3.includes('setCollapsed(true)'));
	check('㉙ 浮动按钮做展开（setCollapsed(false)）', wb3.includes('setCollapsed(false)'));
	check('㉙ 不再用竖排文字（`writing-mode: vertical-rl` 会被拆成两列）',
		!wb3.includes('vertical-rl'));
	check('㉙ 收起时藏起拖拽条（宽度由 state 控制，拖了会被覆盖 ⇒ 表现成"拖不动"）',
		wb3.includes("display: collapsed ? 'none' : undefined"));
	check('㉙ 收起状态持久化（关掉再打开还是上次那样）',
		wb3.includes('__vssarosMarketCollapsed') && wb3.includes('localStorage.setItem(COLLAPSE_KEY'));
	check('㉙ 收起时不挂「＋ 新会话」（对话栏都隐藏了）', wb3.includes('if (el && !collapsed)'));
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace publish] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
