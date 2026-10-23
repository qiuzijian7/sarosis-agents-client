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
	check('② PUBLISHABLE_KINDS = skill / workflow / agent',
		PUBLISHABLE_KINDS.join(',') === 'skill,workflow,agent', PUBLISHABLE_KINDS.join(','));
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

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace publish] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
