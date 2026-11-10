#!/usr/bin/env node
/**
 * IDE 侧记忆逻辑退役守卫（2026-11-10）。
 *
 * 产品口径：记忆只在 dsh 侧（`@vssaros/dsh-memory` + `vssaros-agents` 的
 * Bot / 工作区两层）；IDE 侧原来的 AgentMemory 网关、工作记忆注入、
 * 记忆视图、webview 协议、注入开关与主进程网关认领全部下线。
 *
 * 与 `check-ide-skill-retirement.mjs` 同款：旧代码删掉后照样能编译，
 * 一次合并冲突或复制粘贴就可能把死链抄回来。禁串只认**代码形态**，
 * 退役说明的注释里保留名字不算命中。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './scripts/skill-bundle-paths.mjs';

let failed = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const fail = msg => { console.error(`  ✗ ${msg}`); failed += 1; };
const abs = rel => join(REPO_ROOT, rel);
const read = rel => readFileSync(abs(rel), 'utf8');

// ── ① 已删除的 IDE 侧记忆文件不许重建 ──────────────────────────────────────
const REMOVED = [
	'src/vs/sessions/contrib/agentStudio/browser/agentMemoryInjection.ts',
	'src/vs/sessions/contrib/agentStudio/browser/memoryEventBridge.ts',
	'src/vs/sessions/contrib/agentStudio/browser/views/memoryLibraryView.ts',
	'src/vs/sessions/contrib/memory/browser/memory.contribution.ts',
	'src/vs/sessions/contrib/memory/browser/memoryViewPane.ts',
	'src/vs/sessions/contrib/agentStudio/test/browser/agentMemoryInjection.test.ts',
	'src/vs/sessions/contrib/agentStudio/test/browser/memoryEventBridge.test.ts',
	'src/vs/sessions/contrib/agentStudio/test/browser/memoryWriteAndFilter.test.ts',
	'src/vs/sessions/contrib/agentStudio/browser/turnHookWiring.ts',
	// 2026-11-10 第六批：检索外置链的两套专属测试。
	'src/vs/sessions/contrib/agentStudio/test/browser/agentContextRetrieval.test.ts',
	'src/vs/sessions/contrib/agentStudio/test/browser/agentOSRetrievalContext.test.ts',
];
for (const rel of REMOVED) {
	if (existsSync(abs(rel))) { fail(`已退役的 IDE 侧记忆路径被重建：${rel}`); }
}
if (!failed) { ok(`${REMOVED.length} 个已退役的 IDE 侧记忆文件都不存在`); }

// ── ② 摘除的接线不许被抄回来 ──────────────────────────────────────────────
const A = 'src/vs/sessions/contrib/agentStudio/browser/';
const FORBIDDEN = {
	[A + 'agentTurnExecutor.ts']: [
		'yield* injectMemoryContext(', 'registerMemoryProviderHooks(',
		'_refreshWorkingMemoryContent?.(', 'storeTurnObservationsAtEnd({',
		'memProvider.observe?.(', "type: 'memory_injected'",
	],
	[A + 'agentOSService.ts']: [
		'public async _refreshWorkingMemoryContent(', 'new WorkingMemoryTagProvider',
		'isMemoryInjectionEnabled()', '_isMemoryInjectContextConfigured()',
		'AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING',
	],
	[A + 'agentDriverService.ts']: [
		'isMemoryInjectionEnabled()', 'Persona Memory (永久事实',
		"from './agentMemoryInjection.js'",
	],
	[A + 'agentChatService.ts']: [
		'this._ensureMemoryEventBridge();', 'provider.onMemoryWritten(',
	],
	[A + 'messageEnrichment/builtinTagProviders.ts']: [
		'class WorkingMemoryTagProvider', 'new WorkingMemoryTagProvider()',
		"readonly tagName = 'working_memory_content'",
		'Memory persistence is handled by the system',
	],
	[A + 'agentStudio.contribution.ts']: [
		'AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING', "id: 'agentStudio.openMemoryDetail'",
		'private async _injectAgentMemoryEndpoint(', 'g.__SAROS_AGENTMEMORY_INJECT__ =',
		"id: 'memory.injectContext'",
	],
	[A + 'agentStudioWebviewController.ts']: [
		'case "memory.listL0"', 'this._handleMemoryListL0(', 'this._cleanupAgentMemory(',
		'IMemoryListPayload,',
	],
	[A + 'messageProtocol.ts']: [
		"| 'memory.listL0'", 'export interface IMemoryListPayload',
	],
	'src/vs/sessions/contrib/agentStudio/webview/src/bridge/messageClient.ts': [
		"| 'memory.listL0'",
	],
	'src/vs/sessions/sessions.common.main.ts': [
		"import './contrib/memory/browser/memory.contribution.js';",
	],
	'src/vs/sessions/contrib/agentStudio/common/constants.ts': [
		'AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING',
	],
	// 2026-11-10 第二批：IDE 主进程网关链 + dsh overlay 的生产/消费方成对删除。
	'src/vs/code/electron-main/app.ts': [
		'this._initAgentMemoryEndpoint();', 'this._initAgentMemoryLlm();',
		'startAgentMemoryGateway(): void {', "process.env['AGENTMEMORY_URL'] =",
		'_spawnAgentMemoryGateway(', 'AGENTMEMORY_GATEWAY_RETRY_DELAYS_MS',
	],
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts': [
		'export function memoryGatewayUrlFromEnv(', 'readonly AGENTMEMORY_URL?:',
		'env.AGENTMEMORY_PORT', 'export function renderMemoryOverlay(',
	],
	'src/vs/sessions/contrib/dshHarness/common/dshHostConfig.ts': [
		'readonly gatewayUrl?:', "optional('gatewayUrl'", "'gatewayUrl', 'unrealBridgeUrl'",
	],
	'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts': [
		'memoryGatewayUrlFromEnv(', 'private _memoryOverlayFile',
		"case 'memory': this._memoryOverlayFile", 'gatewayUrl: memoryGatewayUrl',
	],
	// 2026-11-10 第四批：IMemoryProvider 能力接口与注册槽整体删除，不许重建。
	'src/vs/sessions/contrib/agentStudio/common/providers.ts': [
		'export interface IMemoryProvider', 'export const FIXED_SLOT_NAMES',
	],
	'src/vs/sessions/contrib/agentStudio/browser/slotRegistry.ts': [
		'registerMemoryProvider(', 'getActiveMemoryProvider(', '_memoryProviders',
	],
	// 2026-11-10 第五批：恒假 provider 躯壳与纯记忆方法整体删除，不许重建。
	'src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts': [
		'let memoryProvider: any = undefined;', '_storeTurnObservations(memoryProvider',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts': [
		'const memProvider: any = undefined;', 'captureGitCommit(commit:',
		"memProvider.triggerHook('stop'", 'memProvider.onTaskCompleted(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioDashboardService.ts': [
		'_buildMemorySessions(', '_buildMemoryStats(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/parts/turnContextCompaction.ts': [
		'writeSummaryToMemory(', 'const preCompactInject =', 'INJECT_BUDGET_SAVED_RATIO',
	],
	'src/vs/sessions/contrib/agentStudio/browser/parts/turnFinalization.ts': [
		'storeTurnObservationsAtEnd(', 'IStoreTurnObservationsDeps',
	],
	'src/vs/sessions/contrib/agentStudio/browser/parts/turnPostIteration.ts': [
		'memoryProvider.observe?.(', 'OBSERVE_CONTENT_MAX_CHARS',
	],
	// 2026-11-10 第六批：检索外置链整体删除（estimateMessagesTokens 是通用能力，保留）。
	'src/vs/sessions/contrib/agentStudio/browser/agentContextRetrieval.ts': [
		'RETRIEVED_CTX_PREFIX', 'ContextRetrievalDeps', 'retrieveContextOnly(',
		'retrieveCompactionContext(', 'storeTurnObservations(', 'injectRetrievalSystemMessage(',
		'filterRelevantSessionSummaries', 'tokenizeForRelevance',
	],
	'src/vs/sessions/contrib/agentStudio/browser/turnHost.ts': [
		'_retrieveCompactionContext(', '_retrieveContextOnly(', '_injectRetrievalSystemMessage(',
	],
	'src/vs/sessions/contrib/agentStudio/common/agentOS.ts': [
		'_storeTurnObservations(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/piLoop/piTurnKernel.ts': [
		'_injectRetrievalSystemMessage(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/piLoop/proc/kernelProcWorkerEntry.ts': [
		"rpcInvoke('_storeTurnObservations'", "rpcInvoke('_retrieveCompactionContext'",
		'_retrieveContextOnly:', '_injectRetrievalSystemMessage:',
	],
};
for (const [rel, needles] of Object.entries(FORBIDDEN)) {
	let src;
	try { src = read(rel); } catch { fail(`找不到要检查的文件：${rel}`); continue; }
	const back = needles.filter(n => src.includes(n));
	if (back.length) { fail(`${rel} 里 IDE 侧记忆接线被抄回来了：${back.join(' / ')}`); }
}
if (!failed) { ok(`${Object.keys(FORBIDDEN).length} 个源码文件的 IDE 侧记忆接线都没有回来`); }

// ── ③ dsh 侧替代能力必须在位（否则删除等于「砍了没接」）──────────────────
const REQUIRED_FILES = [
	'dsh-plugins/vssaros-memory/package.json',
	'dsh-plugins/vssaros-memory/lib/store.js',
	'dsh-plugins/vssaros-memory/lib/legacy-import.js',
	'dsh-plugins/vssaros-agents/lib/stepMemory.js',
	'dsh-plugins/vssaros-agents/lib/memoryFiles.js',
	'dsh-plugins/check-agents-memory.mjs',
];
for (const rel of REQUIRED_FILES) {
	if (!existsSync(abs(rel))) { fail(`dsh 侧记忆真源缺失：${rel}`); }
}
const memoryPkg = read('dsh-plugins/vssaros-memory/package.json');
if (!memoryPkg.includes('"name": "@vssaros/dsh-memory"')) {
	fail('dsh 侧记忆插件包名不再是 @vssaros/dsh-memory');
}
const dshContribution = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
if (!dshContribution.includes("id: 'dshHarness.openMemoryDetailReact'") && !dshContribution.includes("'dshHarness.openMemoryDetailReact'")) {
	fail('dsh 记忆页的 IDE 宿主入口（dshHarness.openMemoryDetailReact）被误删');
}
if (!failed) { ok('dsh 侧统一存储 / Bot 记忆 / 工作台入口都还在位'); }

// ── ④ provider 符号与恒假躯壳全部清零 ────────────────────────────────────
// 2026-11-10 第四批删掉 `IMemoryProvider` 接口、注册槽、turnHookWiring 与全部
// getActive/register 调用点；第五批把回合管线里 10 处恒为 undefined 的
// provider 变量及其恒假分支、孤立的纯记忆方法/常量一并删净。两者上限均为 0。
const SCAN_ROOT = 'src/vs/sessions/contrib/agentStudio';
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.map(line => line.replace(/\/\/.*$/, ''))
		.join('\n');
}
function collectFiles(dir, out = []) {
	for (const entry of readdirSync(abs(dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== 'test') { collectFiles(rel, out); }
			continue;
		}
		if (rel.endsWith('.ts') || rel.endsWith('.js')) { out.push(rel); }
	}
	return out;
}
const sources = collectFiles(SCAN_ROOT).map(rel => [rel, stripComments(read(rel))]);
const count = needle => sources.reduce((n, [, src]) => n + (src.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0), 0);

const MAX_GET_ACTIVE_MEMORY_PROVIDER = 0;  // 2026-11-10 第四批：provider 符号清零
const MAX_REGISTER_MEMORY_PROVIDER = 0;
const MAX_NEUTRALIZED_MEMORY_VARS = 0;     // 2026-11-10 第五批：恒假躯壳已删净
// 2026-11-10 第六批：检索外置链（agentContextRetrieval / host 的 _retrieve* / _store* /
// proc RPC 桩 / 两套专属测试）已整体删除；`estimateMessagesTokens` 是通用 token 估算，保留。
const MAX_RETRIEVAL_CHAIN_SYMBOLS = 0;
const getActive = count('getActiveMemoryProvider(');
const register = count('registerMemoryProvider(');
if (getActive > MAX_GET_ACTIVE_MEMORY_PROVIDER) {
	fail(`IDE 侧 getActiveMemoryProvider 调用点回升到 ${getActive} 个（上限 ${MAX_GET_ACTIVE_MEMORY_PROVIDER}）`);
}
if (register > MAX_REGISTER_MEMORY_PROVIDER) {
	fail(`IDE 侧 registerMemoryProvider 调用点回升到 ${register} 个（上限 ${MAX_REGISTER_MEMORY_PROVIDER}）`);
}
// 钩子转发模块已删除，调用不许回来。
const hookCalls = sources.reduce((n, [, src]) => n + (src.match(/registerMemoryProviderHooks\(/g)?.length ?? 0), 0);
if (hookCalls > 0) { fail(`IDE 侧又出现 ${hookCalls} 个 registerMemoryProviderHooks 调用（记忆钩子已退役）`); }
// 恒为 undefined 的 provider 变量：已清零，不许再出现。
const neutralized = sources.reduce((n, [, src]) => n + (src.match(/(?:const|let)\s+(?:memoryProvider|memProvider|provider|rp)\s*(?::\s*any\s*=\s*undefined|=\s*undefined\s+as\s+any)\s*;/g)?.length ?? 0), 0);
if (neutralized > MAX_NEUTRALIZED_MEMORY_VARS) {
	fail(`IDE 侧恒假记忆分支回升到 ${neutralized} 个（上限 ${MAX_NEUTRALIZED_MEMORY_VARS}）`);
}
const RETRIEVAL_KEYS = [
	'_storeTurnObservations', '_retrieveContextOnly', '_retrieveCompactionContext',
	'_injectRetrievalSystemMessage', 'storeTurnObservations(', 'retrieveContextOnly(',
	'retrieveCompactionContext(',
];
const retrievalSymbols = sources.reduce((n, [, src]) => n + RETRIEVAL_KEYS.reduce((m, k) => m + src.split(k).length - 1, 0), 0);
if (retrievalSymbols > MAX_RETRIEVAL_CHAIN_SYMBOLS) {
	fail(`IDE 侧检索外置链符号回升到 ${retrievalSymbols} 个（上限 ${MAX_RETRIEVAL_CHAIN_SYMBOLS}）`);
}
// 兼容层（renderMemoryOverlay / gatewayUrl 字段）已于 2026-11-10 第三批整体删除，
// 连定义都不许回来 —— 否则又会出现「打了一行但插件不认」的空覆盖层。
const DSH_UTIL = [
	'src/vs/sessions/contrib/dshHarness/common/dshCli.ts',
	'src/vs/sessions/contrib/dshHarness/common/dshHostConfig.ts',
	'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts',
];
const overlayRefs = DSH_UTIL.reduce((n, rel) => {
	const src = stripComments(read(rel));
	return n + (src.match(/renderMemoryOverlay\(|gatewayUrl/g)?.length ?? 0);
}, 0);
if (overlayRefs > 0) { fail(`生产代码仍有 ${overlayRefs} 处记忆网关兼容层引用（已整体删除）`); }
// 主进程不再为记忆网关写任何环境变量（否则 dsh 侧会拿到指向不存在网关的地址）。
const appSrc = stripComments(read('src/vs/code/electron-main/app.ts'));
const envWrites = appSrc.match(/AGENTMEMORY_(URL|PORT|LLM_)/g)?.length ?? 0;
if (envWrites > 0) { fail(`IDE 主进程仍写 ${envWrites} 处 AGENTMEMORY_* 环境变量（网关链已删除）`); }
if (!failed) { ok(`provider 符号 getActive=${getActive}/0、register=${register}/0，恒假躯壳 ${neutralized}/0，检索外置链 ${retrievalSymbols}/${MAX_RETRIEVAL_CHAIN_SYMBOLS}，记忆钩子 ${hookCalls} 个，网关兼容层/env 写入 0`); }

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ IDE 侧记忆逻辑退役状态保持完整');
process.exit(failed ? 1 : 0);
