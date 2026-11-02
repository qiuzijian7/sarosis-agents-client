// 工作台开发规范的随包副本生成器（对齐 dsh-desktop 的 build-workbench-guide 做法）。
//
// 单一真源：`doc/workbench-development-standard.md`（人读 + 网站）
// 生成产物：`dsh-plugins/vssaros-workbenches/lib/workbench-standard.zh.md`
//          （dsh 侧 Agent 通过 `GET /api/vssaros-workbenches/development-guide` 取这一份）
//
// 为什么必须生成而不是手抄：手维护的副本一定会和源漂移（dsh-desktop 就栽过一次）；
// 漂移由 `dsh-plugins/check-workbench-guide.mjs` 当场抓红。
//
//   node scripts/build-workbench-guide.mjs          写入副本
//   node scripts/build-workbench-guide.mjs --check  只检查（漂移 ⇒ 退出码 1）
//   node scripts/build-workbench-guide.mjs --print  打印渲染结果（调试用）

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE = 'doc/workbench-development-standard.md';
export const TARGET = 'dsh-plugins/vssaros-workbenches/lib/workbench-standard.zh.md';

/** 只加"这是生成的、改源文件"的提示，正文逐字保留（便于 diff 与断言）。 */
export function renderBundledGuide(markdown) {
	const body = markdown.endsWith('\n') ? markdown : markdown + '\n';
	return [
		'<!-- 本文件由 scripts/build-workbench-guide.mjs 生成，不要手改。',
		`     源文件：${SOURCE}（改那里再跑 \`node scripts/build-workbench-guide.mjs\`） -->`,
		'',
		'> 随包离线副本：与仓库源文件逐字一致；如与本机文档冲突，以源文件为准。',
		'',
		body,
	].join('\n');
}

export function renderGuideFromSource(readFile = path => readFileSync(join(root, path), 'utf8')) {
	return renderBundledGuide(readFile(SOURCE));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const rendered = renderGuideFromSource();
	if (argv.includes('--print')) {
		process.stdout.write(rendered);
		process.exit(0);
	}
	const target = join(root, TARGET);
	let current = null;
	try { current = readFileSync(target, 'utf8'); } catch { current = null; }
	if (argv.includes('--check')) {
		if (rendered !== current) {
			console.error(`${TARGET} 与 ${SOURCE} 不一致（或缺失）。跑 node scripts/build-workbench-guide.mjs 重新生成。`);
			process.exit(1);
		}
		console.log(`${TARGET} 与源文件一致。`);
		process.exit(0);
	}
	if (rendered === current) {
		console.log(`${TARGET} 已是最新。`);
		process.exit(0);
	}
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, rendered);
	console.log(`已写入 ${TARGET}`);
}
