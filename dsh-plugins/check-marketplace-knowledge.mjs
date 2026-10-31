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
const src = (p) => fs.readFileSync(p, 'utf8');
const pubSrc = src(path.join(MP, 'publisher.js'));
const instSrc = src(path.join(MP, 'installers.js'));
const dispSrc = src(path.join(MP, 'dispatch.js'));
const resSrc = src(path.join(MP, 'localResources.js'));
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
	execFileSync('git', ['init', '-q'], { cwd: v, stdio: 'pipe' });
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
	const inner = path.join(kb, 'v1');
	fs.mkdirSync(path.join(inner, '笔记'), { recursive: true });
	fs.writeFileSync(path.join(inner, '笔记', 'a.md'), '# a\n', 'utf8');
	fs.writeFileSync(path.join(kb, '.extra-vaults.json'), JSON.stringify([{ id: 'ext-1', name: '外挂', path: inner }]));
	try {
		const items = await res.listPublishables(prof);
		const kbs = items.filter((x) => x.kind === 'knowledge');
		if (!kbs.length) { throw new Error('列不出知识库'); }
		if (!kbs.every((x) => x.sourceDir && path.isAbsolute(x.sourceDir))) { throw new Error('缺 sourceDir（或不是绝对路径）'); }
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

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
