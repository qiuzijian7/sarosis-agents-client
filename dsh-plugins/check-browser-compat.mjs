#!/usr/bin/env node
// check-browser-compat.mjs — §4 浏览器兼容层的静态对账（2026-11-09）
//
// 三条不变量：
//   ① 别名归一后的每个 op 都必须是既有 KNOWN_OPS 里的一个（不许造第二套工具）；
//   ② 归一发生在所有闸之前、截图体积闸发生在存附件之前（换个名字不能绕过审批/限额）；
//   ③ 写盘路径只由 homeDir + safeHostSlug 构造，模型没有任何路径参数可传。
//
//   node dsh-plugins/check-browser-compat.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGINS = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(PLUGINS, 'vssaros-browser');
const text = (rel) => readFileSync(join(PLUGIN, rel), 'utf8');
const problems = [];
const check = (name, ok, detail = '') => {
	if (ok) console.log(`  ok   ${name}`);
	else { problems.push(`${name}${detail ? ` — ${detail}` : ''}`); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

for (const rel of ['lib/index.js', 'lib/core/alias.js', 'lib/core/screenshot.js',
	'lib/core/cookies.js', 'lib/core/storage.js', 'package.json']) {
	check(`必需文件存在：${rel}`, existsSync(join(PLUGIN, rel)));
}
if (problems.length) process.exit(1);

const index = text('lib/index.js');
const alias = await import(pathToFileURL(join(PLUGIN, 'lib/core/alias.js')).href);
const shot = await import(pathToFileURL(join(PLUGIN, 'lib/core/screenshot.js')).href);
const pkg = JSON.parse(text('package.json'));

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const opsBody = stripComments(index).match(/const KNOWN_OPS = \[([\s\S]*?)\];/)?.[1] ?? '';
const knownOps = [...opsBody.matchAll(/'([^']+)'/g)].map((match) => match[1]);
check(`解析到 KNOWN_OPS（${knownOps.length} 个）`, knownOps.length >= 20, `只解析到 ${knownOps.length} 个`);

const badOps = Object.entries(alias.ALIASES)
	.map(([name, make]) => ({ name, op: make({ op: name }).op }))
	.filter(({ op }) => !knownOps.includes(op));
check('★ 每个 DS Bot 别名都归一到既有 KNOWN_OPS 中的 op', badOps.length === 0,
	badOps.map((entry) => `${entry.name}→${entry.op}`).join(', '));
check('不映射清单里的名字都不在别名表里',
	Object.keys(alias.UNMAPPED_ALIASES).every((name) => !Object.hasOwn(alias.ALIASES, name)));
// 必须剥注释：alias.js 的文件头注释里就写着 "不向 ctx.tools.register 注册"，直接扫全文会误命中。
check('别名模块不注册任何工具（模型侧仍只有 browser 一个入口）',
	!/ctx\.tools\.register|defineTool/.test(stripComments(text('lib/core/alias.js'))));

const runAt = index.indexOf('const runOp = async (rawParams');
const normAt = index.indexOf('normalizeOpCall(rawParams)');
const handlersAt = index.indexOf('const handlers = createHandlers(client)');
check('★ 归一在 runOp 最开头、所有 handler/闸之前',
	runAt > 0 && normAt > runAt && (handlersAt < 0 || normAt < handlersAt),
	`run=${runAt} norm=${normAt} handlers=${handlersAt}`);
check('归一后的 params 被用于取 op（不是用原参数）',
	/const params = normalizeOpCall\(rawParams\)\.params;[\s\S]{0,200}const op = typeof params\?\.op/.test(index));

const sizeAt = index.indexOf('screenshotSizeProblem(shot?.image)');
const saveAt = index.indexOf('attachments.saveImage');
check('★ 截图体积闸在存附件之前', sizeAt > 0 && saveAt > sizeAt, `size=${sizeAt} save=${saveAt}`);
check('体积上限 180KB 且超限时提示降质',
	shot.MAX_SCREENSHOT_BYTES === 180 * 1024
	&& /降低 quality/.test(shot.screenshotSizeProblem('A'.repeat(300 * 1024)) ?? '')
	&& shot.screenshotSizeProblem('A'.repeat(100)) === undefined);
check('index.js 引入了 screenshotSizeProblem 与 normalizeOpCall',
	/screenshotSizeProblem/.test(index) && /normalizeOpCall/.test(index));

// ③ 写盘路径不变量：设计稿里的「路径白名单」在本项目是多余的 —— 路径本来就不可由模型指定。
const cookies = text('lib/core/cookies.js');
const storage = text('lib/core/storage.js');
check('★ cookie/storage 存档路径由 homeDir + safeHostSlug(host) 固定构造',
	/safeHostSlug\(host\)/.test(cookies) && /safeHostSlug\(host\)/.test(storage)
	&& /cookieStorePath\(homeDir/.test(index) && /storageStorePath\(homeDir/.test(index));
check('★ 模型侧没有任何路径参数（不存在 params.path / filePath / filename）',
	!/params\?\.?(?:path|filePath|filename|file)\b/.test(index));
check('写盘调用点使用构造出来的 storePath，且走原子写 0600',
	/writeCookieStore\(storePath/.test(index) && /writeStorageStore\(storePath/.test(index)
	&& /mode: 0o600/.test(text('lib/core/cookieStore.js'))
	&& /mode: 0o600/.test(text('lib/core/storageStore.js')));

const listed = new Set(pkg.files ?? []);
check('随包清单含别名模块与截图模块',
	listed.has('lib/core/alias.js') && listed.has('lib/core/screenshot.js'));

if (problems.length) {
	console.error(`\n[check-browser-compat] ✗ ${problems.length} 处：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log('\n[check-browser-compat] ✓ 别名不新增工具、归一与限额都在闸前、写盘路径模型不可控');
