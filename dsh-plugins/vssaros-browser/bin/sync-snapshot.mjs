/**
 * 从 VsSaros **真源**生成 `lib/core/snapshot.js`（`browser_snapshot` 的注入脚本 + 渲染器）。
 *
 * 为什么是"生成"而不是"手抄一份"：那个文件 480+ 行，主体是两段**注入页面**的脚本文本 ——
 * 手抄必然漂移，而漂移的表现是"Host 侧给出的 ref 与 IDE 侧不同"（模型按旧习惯调用即失效），
 * 且没有任何编译器会拦。这里用 esbuild 做 **TS→JS 的机械转换**（同一个仓库里现成的能力），
 * 生成物带"请勿手改"头，并用 `--check` 让测试能断言"生成物与真源一致"。
 *
 * 用法：
 *   node dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs           # 生成/更新 lib/core/snapshot.js
 *   node dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs --check   # 只比对；不一致 ⇒ 退出码 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const TRUE_SOURCE = 'src/vs/sessions/contrib/agentStudio/browser/browserCdpSnapshot.ts';
const TARGET = path.join(repo, 'dsh-plugins/vssaros-browser/lib/core/snapshot.js');

const HEADER = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ⚠ **本文件由脚本生成，不要手改**：\`node dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs\`。
 *
 * 真源：\`${TRUE_SOURCE}\`（esbuild 机械转换 TS→JS）。
 * 为什么 Host 侧要有一份：独立入口没有 VsSaros，但 \`browser\` 族的 \`snapshot\` 必须给出**同一套**
 * ref 与同一套渲染结果（模型在两种入口之间不应该看到两种格式）。
 * 一致性由 \`test/common/dshBrowserPlugin.test.ts\` 里的 \`--check\` 守卫兜住。
 */
`;

const esbuild = await import('esbuild');
const built = await esbuild.build({
	absWorkingDir: repo,
	entryPoints: [TRUE_SOURCE],
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	write: false,
	logLevel: 'silent',
});
const code = built.outputFiles.map(f => f.text).join('\n');
const generated = `${HEADER}\n${code.trimEnd()}\n`;

// 生成物必须是**自足**的（插件是零依赖的纯 JS；一旦真源新引入了 node/electron 依赖，这里立刻可见）
for (const line of code.split('\n')) {
	if (/^\s*import\s|\brequire\(/.test(line)) {
		process.stderr.write(`⚠ 生成物里出现了运行时依赖（插件要求零依赖）：${line.trim()}\n`);
	}
}

const check = process.argv.includes('--check');
const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : undefined;

if (check) {
	if (existing === generated) {
		process.stdout.write('sync-snapshot --check: OK（生成物与真源一致）\n');
		process.exit(0);
	}
	process.stderr.write('✗ sync-snapshot --check: 生成物与真源不一致 —— 真源改过但没重新生成？\n'
		+ `  请运行：node dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs（真源：${TRUE_SOURCE}）\n`);
	process.exit(1);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, generated);
process.stdout.write(`sync-snapshot: 已写入 ${path.relative(repo, TARGET)}（${generated.length}B，源 ${code.length}B）\n`);
