#!/usr/bin/env node
// check-plugins-tracked.mjs — 随包文件必须在 git 里（2026-11-06，P3 交付）
//
// 为什么：CI 从干净检出打包。一个插件 package.json 的 `files` 里列的文件（或目录下的文件）只在本地、没进 git ⇒
// 打出来的包缺件，Host 加载时 import 失败（2026-11-06 实测：vssaros-agents 的 lib/rooms.js、memoryBus.js 等、
// 整个 vssaros-superagent 都是 `??`）。同理，`check:dsh-plugins` 链上调用的脚本没进 git ⇒ CI 上守卫自己就跑不起来。
//
// 规则：
//   ① dsh-plugins/<插件>/package.json 的 `files` 展开后的每个文件都已被 git 跟踪（已提交或已暂存）；
//   ② 根 package.json 的 `check:dsh-plugins` 链里 `node <脚本>` 的每个脚本都已被 git 跟踪。
// 被 .gitignore 忽略的文件不算（它们本来就是生成物，由各自的生成步骤保证）。
//
//   node dsh-plugins/check-plugins-tracked.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGINS = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(PLUGINS);
const slashed = (path) => path.split(sep).join('/');
const git = (args) => {
	const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
	if (run.status !== 0) { throw new Error(`git ${args.join(' ')} 失败：${run.stderr}`); }
	return run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
};
const tracked = new Set(git(['ls-files', '--cached', '--', 'dsh-plugins', 'package.json']));
const ignored = (paths) => {
	if (!paths.length) { return new Set(); }
	const run = spawnSync('git', ['check-ignore', '--stdin'], { cwd: REPO, input: paths.join('\n'), encoding: 'utf8', windowsHide: true });
	return new Set(run.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
};
const expand = (path) => {
	if (!existsSync(path)) { return []; }
	if (!statSync(path).isDirectory()) { return [path]; }
	return readdirSync(path, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
};

const missing = new Map();
let shipped = 0;
for (const plugin of readdirSync(PLUGINS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
	const pkgPath = join(PLUGINS, plugin, 'package.json');
	if (!existsSync(pkgPath)) { continue; }
	const files = JSON.parse(readFileSync(pkgPath, 'utf8')).files;
	if (!Array.isArray(files)) { continue; }
	const paths = [pkgPath, ...files.flatMap((entry) => expand(join(PLUGINS, plugin, entry)))].map((file) => slashed(relative(REPO, file)));
	const skip = ignored(paths);
	shipped += paths.length;
	const untracked = paths.filter((path) => !tracked.has(path) && !skip.has(path));
	if (untracked.length) { missing.set(plugin, untracked); }
}
const chain = String(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts?.['check:dsh-plugins'] ?? '');
const scripts = [...chain.matchAll(/\bnode\s+([\w./-]+\.m?js)/g)].map((match) => match[1]).filter((path) => path.startsWith('dsh-plugins/'));
const untrackedScripts = scripts.filter((path) => existsSync(join(REPO, path)) && !tracked.has(path));

if (missing.size || untrackedScripts.length) {
	const total = [...missing.values()].reduce((sum, list) => sum + list.length, 0);
	console.error(`[check-plugins-tracked] ✗ ${total} 个随包文件、${untrackedScripts.length} 个检查链脚本没进 git（干净检出会缺件）：`);
	for (const [plugin, list] of missing) { console.error(`  ${plugin}: ${list.length} 个，如 ${list.slice(0, 4).join('、')}`); }
	for (const path of untrackedScripts) { console.error(`  检查链：${path}`); }
	console.error('修复：git add 这些文件（暂存即可通过本检查；提交由你决定）。');
	process.exit(1);
}
console.log(`[check-plugins-tracked] ✓ ${shipped} 个随包文件与 ${scripts.length} 个检查链脚本都在 git 里`);
