/* ---------------------------------------------------------------------------
 * build-pi-bundle.mjs —— 从 pi checkout 源码打包「轻量 agent loop」为单个自洽 TS 文件。
 *
 * 用法：node build-pi-bundle.mjs [piCheckoutDir]     （默认 G:\CustomWorkspaces\AIProjects\pi）
 * 产物：vendor/piAgentLoop.bundle.ts（esbuild bundle + `// @ts-nocheck` 头）。
 *
 * 为什么这样打包（而非手抄源码 / npm 直引），见 ./VENDORED.md：
 *   · 手抄源码会引入转写错误，且 npm 0.85.1 与 checkout（09-16 未发布新版）**有类型漂移**；
 *   · npm 直引不可行（renderer 不能裸引 npm 包；pi-agent-core 根入口会连带 harness 的 fs/child_process）；
 *   · ⇒ esbuild 从**源码**出 bundle：忠实（编译自真实源码）、自洽（含 typebox 校验）、Node-free
 *     （轻量 loop 链路只用 event-stream/transcript/validation，全部纯 TS）。
 *
 * 升级 pi 时重跑本脚本即可（配合 VENDORED.md 的版本记录）。
 * ------------------------------------------------------------------------- */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const piDir = resolve(process.argv[2] ?? 'G:/CustomWorkspaces/AIProjects/pi');
const here = dirname(fileURLToPath(import.meta.url)); // vendor/
// vendor → piCore → browser → agentStudio → contrib → sessions → vs → src → 仓库根（8 级）
const repoRoot = resolve(here, '../../../../../../../..');

const scratch = join(piDir, '.tmp-saros-pi-bundle');
mkdirSync(scratch, { recursive: true });

// 瘦身入口：只导出轻量 loop 实际用到的 pi-ai 运行时件（**避免把 api/providers 全打包进来**）
writeFileSync(join(scratch, 'piAiSlim.ts'), [
	'export { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";',
	'export { getCurrentTools, getToolStateChanges, normalizeContext, toToolDeclaration } from "../packages/ai/src/utils/transcript.ts";',
	'export { validateToolArguments } from "../packages/ai/src/utils/validation.ts";',
	'',
].join('\n'));

// 主入口：轻量 loop + 事件流工厂（适配层要用）
writeFileSync(join(scratch, 'entry.ts'), [
	'export { agentLoop, agentLoopContinue } from "../packages/agent/src/agent-loop.ts";',
	'export { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";',
	'',
].join('\n'));

const outJs = join(here, 'piAgentLoop.bundle.js');
const outTs = join(here, 'piAgentLoop.bundle.ts');

try {
	await build({
		entryPoints: [join(scratch, 'entry.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',          // 不注入 node 垫片（产物必须 Node-free）
		target: 'es2022',
		// agent-loop.ts 内部 `from "@earendil-works/pi-ai"` → 瘦身入口（不打包 provider 层）
		alias: { '@earendil-works/pi-ai': join(scratch, 'piAiSlim.ts') },
		// typebox（validation.ts 的运行时依赖）从本仓 node_modules 解析
		nodePaths: [join(repoRoot, 'node_modules')],
		outfile: outJs,
		logLevel: 'warning',
	});

	const js = readFileSync(outJs, 'utf8');
	const header = [
		'/* ---------------------------------------------------------------------------',
		' * VENDORED BUNDLE —— 由 build-pi-bundle.mjs 从 pi 源码（checkout 09-16）esbuild 打包生成。',
		' * 上游：https://github.com/earendil-works/pi（MIT）—— 许可与清单见 ./VENDORED.md。',
		' * **不要手改本文件**；升级 pi 时重跑 build-pi-bundle.mjs。',
		' * ------------------------------------------------------------------------- */',
		'// @ts-nocheck  ← esbuild 产物（非手写 TS），类型边界由 ./piLoop.ts 收口',
		'',
	].join('\n');
	writeFileSync(outTs, header + js);
	rmSync(outJs, { force: true });
	console.log('[pi-bundle] written:', outTs, `(${(js.length / 1024).toFixed(1)} KB)`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
