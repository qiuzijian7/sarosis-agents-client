/*
 * 守卫：**插件在宿主里的每一份副本都必须与仓库一致**（版本 + 入口字节）。
 *
 * 起因（2026-10-29 真机：聊天底部「导入到知识库」按钮**整个消失**）：
 *   页面里的 partErrors 全是
 *     "client-modules: chunk owner \"@vssaros/dsh-chat-surface\" is not a boot graph entry"
 *     "bundle script plugins/@vssaros/dsh-chat-surface/client.hero.js?rev=… failed to load"
 *   ⇒ **我们所有 chunk 都被拒**（不只新按钮）。
 *   根因：profile 清单里 `dependencies` 指向**暂存副本**
 *     `…/.vssaros/plugins/vssaros-dsh-chat-surface-0.2.275-92fea394`，
 *     而那份的 package.json 版本是 **0.2.279**、node_modules 里却是 **0.2.280**
 *     ⇒ 宿主激活的包与 boot graph 条目对不上 ⇒ loader 判定"不是 boot graph 条目"。
 *
 *   ⇒ 部署必须让**每一份**副本（node_modules + 所有版本化暂存目录）都与仓库一致，
 *     否则一次"同步成功"会把整个插件废掉（而且症状是"某个功能不见了"，极难查）。
 *
 * 跑法：node dsh-plugins/check-dsh-plugin-sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.dirname(HERE);
const PLUGINS = path.join(ROOT, 'dsh-plugins');
const PROFILE_ROOTS = [
	path.join(os.homedir(), '.vssaros-dev/dsh-home/profiles'),
	path.join(os.homedir(), '.vssaros/dsh-home/profiles'),
];

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

const plugins = fs.readdirSync(PLUGINS, { withFileTypes: true })
	.filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS, d.name, 'package.json')))
	.map((d) => d.name);

check('有插件可查（' + plugins.length + ' 个）', () => {
	if (!plugins.length) { throw new Error('dsh-plugins 下没有插件'); }
});

for (const dir of plugins) {
	const srcRoot = path.join(PLUGINS, dir);
	const pkg = readJson(path.join(srcRoot, 'package.json'));
	if (!pkg || !pkg.name) { continue; }
	const repoVer = String(pkg.version ?? '');
	const entryRel = (() => {
		const c = pkg.exports && pkg.exports['./client'];
		if (typeof c === 'string') { return c.replace(/^\.\//, ''); }
		if (c && typeof c === 'object' && typeof c.default === 'string') { return c.default.replace(/^\.\//, ''); }
		return 'lib/client.js';
	})();
	const base = pkg.name.replace(/^@[^/]+\//, '');

	for (const root of PROFILE_ROOTS) {
		if (!fs.existsSync(root)) { continue; }
		const tag = root.includes('.vssaros-dev') ? 'dev' : 'prod';
		for (const prof of fs.readdirSync(root)) {
			const profDir = path.join(root, prof);
			const copies = [];
			const nm = path.join(profDir, 'node_modules', pkg.name);
			if (fs.existsSync(nm)) { copies.push(['node_modules', nm]); }
			const plugDir = path.join(profDir, '.vssaros', 'plugins');
			if (fs.existsSync(plugDir)) {
				for (const d of fs.readdirSync(plugDir)) {
					const prefix = 'vssaros-' + base + '-';
					if (!d.startsWith(prefix) || !/^\d/.test(d.slice(prefix.length))) { continue; }
					copies.push(['installed:' + d, path.join(plugDir, d)]);
				}
			}
			for (const [kind, dirPath] of copies) {
				const pj = readJson(path.join(dirPath, 'package.json'));
				check(`${tag}/${prof} ${kind}：版本与仓库一致（${repoVer}）`, () => {
					if (!pj) { throw new Error('读不到 package.json'); }
					if (String(pj.version ?? '') !== repoVer) {
						throw new Error(`版本 ${pj.version} ≠ 仓库 ${repoVer} ⇒ boot graph 会对不上（chunk 会被判“不是 boot graph 条目”）`);
					}
				});
				// 有些插件**没有客户端入口**（纯服务端）⇒ 仓库里没有该文件就跳过这项（版本检查仍然有效 ✓）
				if (fs.existsSync(path.join(srcRoot, entryRel))) {
					check(`${tag}/${prof} ${kind}：入口与仓库字节一致（${entryRel}）`, () => {
						const a = path.join(srcRoot, entryRel), b = path.join(dirPath, entryRel);
						if (!fs.existsSync(b)) { throw new Error('副本里没有入口文件'); }
						if (!same(a, b)) { throw new Error('入口字节不一致 ⇒ 页面拿到的 rev/内容与仓库不同'); }
					});
				}
			}
		}
	}
}

// profile 清单指向的暂存目录，版本必须与仓库一致（这正是本次事故的那条）
check('profile 清单指向的暂存副本版本与仓库一致', () => {
	for (const root of PROFILE_ROOTS) {
		if (!fs.existsSync(root)) { continue; }
		for (const prof of fs.readdirSync(root)) {
			const pj = readJson(path.join(root, prof, 'package.json'));
			const deps = (pj && pj.dependencies) || {};
			for (const [dir, pkg] of plugins) {
				const srcPkg = readJson(path.join(PLUGINS, dir, 'package.json'));
				if (!srcPkg || !srcPkg.name) { continue; }
				const dep = deps[srcPkg.name];
				if (!dep) { continue; }
				const depDir = String(dep).replace(/^file:/, '');
				const depPkg = readJson(path.join(depDir, 'package.json'));
				if (!depPkg) { throw new Error(`${root}/${prof}: 依赖指向的目录读不到 package.json：${depDir}`); }
				if (String(depPkg.version) !== String(srcPkg.version)) {
					throw new Error(`${root}/${prof}: 依赖指向 ${path.basename(depDir)}（版本 ${depPkg.version}）但仓库是 ${srcPkg.version} ⇒ boot graph 对不上`);
				}
			}
		}
	}
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
