/*
 * 守卫：商城「知识库」条目（kind=knowledge）的**端到端契约**。
 *
 * 为什么钉这些（2026-10-31 P0）：
 *   · 服务端早已支持 knowledge（kinds.ts / 权限 / 下载 / 升级全在），线上已有 2 个包；
 *     缺的全在客户端 ⇒ 这里守住"客户端这条链不能断"。
 *   · 跨插件用**注册表文件**做契约（两边数据根不同、没有跨插件服务）⇒ 两端的文件名常量
 *     **必须逐字一致**，否则"装完看不见"这种静默失败又会回来 ✗。
 *   · 知识库是私人笔记 ⇒ 打包必须排除缓存/临时媒体/应用态（否则 138MB 视频会被发出去）。
 *
 * 跑法：node dsh-plugins/check-marketplace-knowledge.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MP = path.join(HERE, 'vssaros-marketplace/lib');
const KB = path.join(HERE, 'vssaros-kb/lib');

const pub = await import('file:///' + path.join(MP, 'publisher.js').replace(/\\/g, '/'));
const inst = await import('file:///' + path.join(MP, 'installers.js').replace(/\\/g, '/'));
const res = await import('file:///' + path.join(MP, 'localResources.js').replace(/\\/g, '/'));
const shape = await import('file:///' + path.join(MP, 'shape.js').replace(/\\/g, '/'));
const src = (p) => fs.readFileSync(p, 'utf8');
const pubSrc = src(path.join(MP, 'publisher.js'));
const instSrc = src(path.join(MP, 'installers.js'));
const dispSrc = src(path.join(MP, 'dispatch.js'));
const resSrc = src(path.join(MP, 'localResources.js'));
const idxSrc = src(path.join(MP, 'index.js'));
const shapeSrc = src(path.join(MP, 'shape.js'));
const kbSrc = src(path.join(KB, 'index.js'));

let pass = 0;
const failed = [];
async function check(name, fn) {
	try { await fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

await check('打包器：knowledge 可发布（PUBLISHABLE_KINDS + KIND_DIR + 体积上限）', () => {
	if (!pub.PUBLISHABLE_KINDS.includes('knowledge')) { throw new Error('PUBLISHABLE_KINDS 缺 knowledge'); }
	if (!pub.localRootOf('/tmp/dr', 'knowledge').endsWith('knowledge')) { throw new Error('KIND_DIR 不对'); }
	if (!/knowledge:\s*50\s*\*\s*1024/.test(pubSrc)) { throw new Error('缺 knowledge 体积上限'); }
	if (!/sourceDir/.test(pubSrc)) { throw new Error('preparePublishBundle 必须支持 sourceDir（知识库源不在数据根下）'); }
});

await check('打包：manifest 必须带 knowledge 块（服务端契约）', async () => {
	const v = path.join(os.tmpdir(), 'kb-guard-v-' + Date.now());
	fs.mkdirSync(path.join(v, '笔记'), { recursive: true });
	fs.writeFileSync(path.join(v, '笔记/a.md'), '# a\n', 'utf8');
	try {
		const b = await pub.preparePublishBundle({
			dataRoot: '/tmp/dr', kind: 'knowledge', localId: 'k1', version: '1.0.0',
			meta: { name: 'N', description: 'D' }, sourceDir: v,
		});
		const k = b.manifest.knowledge;
		if (!k || k.id !== 'k1' || !k.name) { throw new Error('manifest.knowledge 块缺失/不对：' + JSON.stringify(k)); }
	} finally { fs.rmSync(v, { recursive: true, force: true }); }
});

await check('打包：排除 .git / 临时媒体 / 应用态 / 索引缓存', async () => {
	const v = path.join(os.tmpdir(), 'kb-guard-x-' + Date.now());
	fs.mkdirSync(path.join(v, '笔记'), { recursive: true });
	fs.mkdirSync(path.join(v, '.tmp-media'), { recursive: true });
	fs.writeFileSync(path.join(v, '笔记/a.md'), '# a\n', 'utf8');
	fs.writeFileSync(path.join(v, '.tmp-media/big.mp4'), Buffer.alloc(1024, 1));
	fs.writeFileSync(path.join(v, '.kbkernel.json'), '{}');
	execFileSync('git', ['init', '-q'], { cwd: v, stdio: 'pipe', windowsHide: true });
	try {
		const b = await pub.preparePublishBundle({
			dataRoot: '/tmp/dr', kind: 'knowledge', localId: 'k2', version: '1.0.0', sourceDir: v,
		});
		const bad = (b.manifest.files || []).filter((p) => /\.git\/|\.tmp-media\/|\.obsidian\/|\.kbkernel\.json/.test(p));
		if (bad.length) { throw new Error('漏进包：' + bad.join(', ')); }
	} finally { fs.rmSync(v, { recursive: true, force: true }); }
});

await check('发布入口：能列出**真实的知识库**（带 sourceDir）', async () => {
	if (typeof res.listKnowledgeVaults !== 'function') { throw new Error('缺 listKnowledgeVaults'); }
	const home = path.join(os.tmpdir(), `kb-guard-h2-${Date.now()}`);
	const prof = path.join(home, 'dsh-home/profiles/vssaros');
	fs.mkdirSync(prof, { recursive: true });
	const kb = path.join(home, 'knowledge-base');
	fs.mkdirSync(kb, { recursive: true });
	// ★ 2026-11-10 用户裁决：单位是 `知识库列表/<文件夹>`，不是 vault 容器 id
	const inner = path.join(kb, 'v1');
	fs.mkdirSync(path.join(inner, '知识库列表', 'AIAgent'), { recursive: true });
	fs.writeFileSync(path.join(inner, '知识库列表', 'AIAgent', 'a.md'), '# a\n', 'utf8');
	fs.mkdirSync(path.join(inner, '知识库列表', '.archive-2026-11-02'), { recursive: true });
	fs.writeFileSync(path.join(kb, '.extra-vaults.json'), JSON.stringify([{ id: 'ext-1', name: '外挂', path: inner }]));
	// dsh 侧唯一真源：聊天框工具卡写的 `<数据根>/.kb-root.json` ⇒ 根直接是唯一库根
	const root = path.join(home, '我的知识库');
	fs.mkdirSync(path.join(root, '知识库列表', '财经'), { recursive: true });
	fs.writeFileSync(path.join(root, '知识库列表', '财经', 'b.md'), '# b\n', 'utf8');
	fs.writeFileSync(path.join(prof, '.kb-root.json'), JSON.stringify({ version: 1, path: root }));
	try {
		const items = await res.listPublishables(prof);
		const kbs = items.filter((x) => x.kind === 'knowledge');
		if (!kbs.length) { throw new Error('列不出知识库'); }
		if (!kbs.every((x) => x.sourceDir && path.isAbsolute(x.sourceDir))) { throw new Error('缺 sourceDir（或不是绝对路径）'); }
		if (!kbs.some((x) => x.localId === 'AIAgent' && x.name === 'AIAgent')) { throw new Error('没列出 知识库列表/AIAgent'); }
		if (!kbs.some((x) => x.localId === '财经' && x.name === '财经')) { throw new Error('没按 .kb-root.json 列出唯一库根下的「财经」'); }
		if (kbs.some((x) => /^ext-/.test(String(x.localId)))) { throw new Error('仍把 ext-* 容器 id 当成知识库商品'); }
		if (kbs.some((x) => String(x.localId).startsWith('.'))) { throw new Error('点开头归档目录没被隐藏'); }
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check('发布流程：sourceDir 已透传到 publishVersion', () => {
	if (!/sourceDir/.test(src(path.join(MP, 'index.js')))) { throw new Error('index.js 没有透传 sourceDir'); }
});

await check('★ 隐私体检：含隐私的库**默认被拦下**，显式确认才放行', async () => {
	const v = path.join(os.tmpdir(), `kb-guard-priv-${Date.now()}`);
	fs.mkdirSync(path.join(v, '笔记'), { recursive: true });
	fs.writeFileSync(path.join(v, '笔记', 'a.md'), '联系 zhangsan@corp.example.com / 13812345678\n', 'utf8');
	try {
		let blocked = false;
		try {
			await pub.preparePublishBundle({ dataRoot: '/tmp/dr', kind: 'knowledge', localId: 'p1', version: '1.0.0', sourceDir: v });
		} catch (e) { blocked = /隐私体检/.test(String(e.message)); }
		if (!blocked) { throw new Error('含隐私竟然放行了 ✗'); }
		const ok = await pub.preparePublishBundle({
			dataRoot: '/tmp/dr', kind: 'knowledge', localId: 'p1', version: '1.0.0', sourceDir: v, acknowledgePrivacy: true,
		});
		if (!ok || !ok.manifest) { throw new Error('显式确认后仍发不出去'); }
	} finally { fs.rmSync(v, { recursive: true, force: true }); }
});

await check('安装器：knowledge 能落盘（<数据根>/knowledge）', () => {
	const root = inst.targetRootOf('/tmp/dr', 'knowledge');
	if (!root.endsWith(path.join('dr', 'knowledge'))) { throw new Error('落盘根不对：' + root); }
	if (!/registerKnowledgeVault/.test(instSrc)) { throw new Error('缺登记函数'); }
	if (!/kind === 'knowledge'/.test(instSrc)) { throw new Error('installBundle 没有在装完时登记'); }
});

await check('分派：knowledge 的装/升/卸由 dsh 自持（不再推给 IDE）', () => {
	if (!/'mcp',\s*'knowledge'/.test(dispSrc)) { throw new Error('LOCAL_WRITE_KINDS 缺 knowledge'); }
});

await check('可发布列表：knowledge 已登记，且不做"单一入口文件"检查', () => {
	if (!/knowledge:\s*'knowledge'/.test(resSrc)) { throw new Error('localResources 的 KIND_DIR 缺 knowledge'); }
	if (!/if \(ENTRY_OF\[kind\]\)/.test(resSrc)) { throw new Error('knowledge 没有入口文件 ⇒ 必须跳过该检查'); }
});

await check('★ 跨插件契约：两端注册表文件名**逐字一致**', () => {
	const a = /const MARKET_VAULTS_FILE = '([^']+)'/.exec(instSrc);
	const b = /const MARKET_VAULTS_FILE = '([^']+)'/.exec(kbSrc);
	if (!a || !b) { throw new Error('两端都要有 MARKET_VAULTS_FILE 常量'); }
	if (a[1] !== b[1]) { throw new Error(`不一致：商城=${a[1]} / 知识库=${b[1]}`); }
	if (!/loadMarketVaults/.test(kbSrc)) { throw new Error('知识库侧没有读注册表'); }
});

await check('★ 闭环：打包 → 安装 → 登记（装完在注册表里能查到）', async () => {
	const home = path.join(os.tmpdir(), 'kb-guard-h-' + Date.now());
	const prof = path.join(home, 'dsh-home/profiles/vssaros');
	fs.mkdirSync(prof, { recursive: true });
	fs.mkdirSync(path.join(home, 'knowledge-base'), { recursive: true });
	const v = path.join(os.tmpdir(), 'kb-guard-vv-' + Date.now());
	fs.mkdirSync(path.join(v, '笔记'), { recursive: true });
	fs.writeFileSync(path.join(v, '笔记/a.md'), '# a\n\n正文\n', 'utf8');
	try {
		const b = await pub.preparePublishBundle({
			dataRoot: prof, kind: 'knowledge', localId: 'team-kb', version: '1.0.0',
			meta: { name: '团队库' }, sourceDir: v,
		});
		const r = await inst.installBundle({ dataRoot: prof, kind: 'knowledge', storeId: 'team-kb', version: '1.0.0', files: b.files });
		if (!fs.existsSync(path.join(r.targetDir, '笔记/a.md'))) { throw new Error('笔记没落盘'); }
		if (!fs.existsSync(path.join(r.targetDir, '.kb-vault.json'))) { throw new Error('缺包内标记'); }
		const reg = path.join(home, 'knowledge-base', '.market-vaults.json');
		if (!fs.existsSync(reg)) { throw new Error('没写注册表'); }
		const list = JSON.parse(fs.readFileSync(reg, 'utf8'));
		const hit = list.find((x) => x.id === 'team-kb');
		if (!hit) { throw new Error('注册表里没有这个库'); }
		if (!hit.name || !hit.path) { throw new Error('注册表条目缺 name/path'); }
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(v, { recursive: true, force: true });
	}
});

// ★ 2026-11-10（用户裁决）：商城「已安装」的知识库 = `知识库列表/<文件夹>`，
//   每个文件夹就是一个独立知识库；`ext-<hash>` 是 vault 容器 id，不该出现在商品列表里。
await check('★ 已安装：本地知识库透传真实库名/描述/相对目录（不能只带 storeId）', () => {
	if (!/displayName:\s*String\(it\.name\)/.test(idxSrc)) { throw new Error('installed op 没透传 displayName'); }
	if (!/description:\s*String\(it\.description\)/.test(idxSrc)) { throw new Error('installed op 没透传 description'); }
	if (!/entry\.displayName\s*\|\|\s*entry\.storeId/.test(shapeSrc)) { throw new Error('toInstalledItem 仍拿 storeId 当显示名'); }
});
await check('★ 已安装：按分类过滤（选「知识库」时不该混入其它 kind）', () => {
	if (!/wantedKind/.test(idxSrc) || !/allItems\.filter\(it => it\.kind === wantedKind\)/.test(idxSrc)) {
		throw new Error('installed op 缺 params.kind 过滤');
	}
});
await check('★ 知识库枚举：用真名 知识库列表、不再把 ext-* 当商品 id、不用旧名判库', () => {
	if (!resSrc.includes("KB_NOTES_DIR = '知识库列表'")) { throw new Error('没用真名 知识库列表'); }
	if (/\['笔记',\s*'库'\]/.test(resSrc)) { throw new Error('还在用旧名 笔记/库 判库'); }
	if (/String\(v\.id \|\| basename/.test(resSrc)) { throw new Error('仍在把 ext-* 登记 id 当 localId'); }
});
await check('★ 已安装项形状：name 是库名、description 有篇数、rel 是 知识库列表/<名>', () => {
	const it = shape.toInstalledItem({
		kind: 'knowledge', storeId: 'AIAgent', displayName: 'AIAgent', version: '1.0.0',
		description: '42 篇文档 · 知识库列表/AIAgent', rel: '知识库列表/AIAgent',
	});
	if (it.name !== 'AIAgent') { throw new Error('name 不是库名'); }
	if (!/篇文档/.test(String(it.description))) { throw new Error('description 丢了'); }
	if (it.rel !== '知识库列表/AIAgent') { throw new Error('rel 丢了'); }
	// 台账商品没有 displayName ⇒ 保持旧行为，不能被顺手改坏
	if (shape.toInstalledItem({ kind: 'skill', storeId: 's1', version: '1' }).name !== 's1') {
		throw new Error('台账商品的显示名被破坏');
	}
});
await check('★ 根配置即唯一库根：listKnowledgeVaults 直接列出文件夹（隐藏点目录）', async () => {
	const home = path.join(os.tmpdir(), 'mp-kb-guard-' + Date.now());
	const prof = path.join(home, 'data');
	const root = path.join(home, '我的知识库');
	try {
		fs.mkdirSync(prof, { recursive: true });
		fs.mkdirSync(path.join(root, '知识库列表', 'AIAgent'), { recursive: true });
		fs.writeFileSync(path.join(root, '知识库列表', 'AIAgent', 'a.md'), '# a\n', 'utf8');
		fs.mkdirSync(path.join(root, '知识库列表', '.archive-2026-11-02'), { recursive: true });
		fs.writeFileSync(path.join(prof, '.kb-root.json'), JSON.stringify({ version: 1, path: root }));
		const items = await res.listKnowledgeVaults(prof);
		if (!items.some(x => x.localId === 'AIAgent' && x.name === 'AIAgent')) { throw new Error('没列出 AIAgent'); }
		if (items.some(x => String(x.localId).startsWith('.'))) { throw new Error('点目录没隐藏'); }
		if (items.some(x => /^ext-/.test(String(x.localId)))) { throw new Error('出现 ext-* 容器 id'); }
		const hit = items.find(x => x.localId === 'AIAgent');
		if (!/1 篇文档/.test(String(hit?.description || ''))) { throw new Error('description 没给篇数'); }
		if (hit?.rel !== '知识库列表/AIAgent') { throw new Error('rel 不对'); }
	} finally { fs.rmSync(home, { recursive: true, force: true }); }
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
