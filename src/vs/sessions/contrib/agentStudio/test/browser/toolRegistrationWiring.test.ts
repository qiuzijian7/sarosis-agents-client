/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具注册接线**类级**回归守卫（2026-09-21，unreal_* 事故的泛化）。
 *
 * ## 事故与泛化
 * `unreal_*` 找不到的根因：实现存在、注册存在，但 **toolsetConfig 从未登记 `unreal_` 前缀** ⇒
 * `getToolsetForTool` 兜底归 `utility`（Low+deferrable）⇒ focus 模式（代码工作区几乎必触发）
 * 整条剔除 ⇒ LLM 与 tool_search 均不可见。同型坑此前已咬过 `image_gen` / `renderMermaidDiagram` /
 * `canvas_*`（见 toolsetConfig.ts 的三处历史注释）。
 *
 * 本套件把**整个类**钉住（而不是只钉 unreal）：
 *   ① 任何注册工具不得落 `utility` 兜底（除显式白名单）；
 *   ② 不存在「真不可见」工具（focus 裁切 ∧ 不可折叠 ∧ 非 Always ⇒ 直接发与桥接目录都进不去）；
 *   ③ 每个注册工具归入**已定义**的 toolset（防 toolset 拼写漂移）；
 *   ④ 每个 provider 文件里的 `register*Tools` 导出都必须在本扫描内（防新文件漏接）。
 *
 * ## 方法
 * 对全部注册入口**真跑注册**：递归代理 ctx 只截获 `register(descriptor)`，handler 不执行
 * ⇒ 拿到的是**真实注册名单**（不是从源码正则猜的），且不受条件分支影响。
 *
 * ⚠ 维护契约：新增 provider 文件时必须把模块加入 MODULES（否则 ④ 会失败并提示你）。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	getToolsetForTool, getToolsetPriority, ToolsetPriority, isCoreTool, isBridgeTool,
	TOOLSET_DEFINITIONS, UTILITY_BUCKET_WHITELIST,
} from '../../common/toolsetConfig.js';
import { isDeferrableTool } from '../../common/toolSearchAssembler.js';
import * as mAdvancedMemory from '../../browser/providers/tool/advancedMemoryTools.js';
import * as mBundled from '../../browser/providers/tool/bundledTools.js';
import * as mCanvas from '../../browser/providers/tool/canvasTools.js';
import * as mCodebase from '../../browser/providers/tool/codebaseTools.js';
import * as mCompat from '../../browser/providers/tool/compatibilityTools.js';
import * as mCore from '../../browser/providers/tool/coreTools.js';
import * as mDelegation from '../../browser/providers/tool/delegationTools.js';
import * as mDrawio from '../../browser/providers/tool/drawioTools.js';
import * as mHandoff from '../../browser/providers/tool/handoffTools.js';
import * as mImageGen from '../../browser/providers/tool/imageGenTools.js';
import * as mKanban from '../../browser/providers/tool/kanbanTools.js';
import * as mKbVault from '../../browser/providers/tool/kbVaultRecallTools.js';
import * as mMediaGen from '../../browser/providers/tool/mediaGenTools.js';
import * as mMemory from '../../browser/providers/tool/memoryTools.js';
import * as mMermaid from '../../browser/providers/tool/mermaidTools.js';
import * as mMindmap from '../../browser/providers/tool/mindmapTools.js';
import * as mPlanExplore from '../../browser/providers/tool/planExploreTool.js';
import * as mPlanMode from '../../browser/providers/tool/planModeTools.js';
import * as mRoutine from '../../browser/providers/tool/routineCrystalFacetTools.js';
import * as mScheduler from '../../browser/providers/tool/schedulerTools.js';
import * as mSessionSearch from '../../browser/providers/tool/sessionSearchTools.js';
import * as mSkill from '../../browser/providers/tool/skillTools.js';
import * as mUnifiedMemory from '../../browser/providers/tool/unifiedMemoryTools.js';
import * as mUnreal from '../../browser/providers/tool/unrealTools.js';
import * as mVision from '../../browser/providers/tool/visionAnalyzeTools.js';
import * as mWeb from '../../browser/providers/tool/webTools.js';
import * as mWorkflowTool from '../../browser/providers/tool/workflowTool.js';
import * as mWorkflow from '../../browser/providers/tool/workflowTools.js';

const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	['advancedMemoryTools', mAdvancedMemory], ['bundledTools', mBundled], ['canvasTools', mCanvas],
	['codebaseTools', mCodebase], ['compatibilityTools', mCompat], ['coreTools', mCore],
	['delegationTools', mDelegation], ['drawioTools', mDrawio], ['handoffTools', mHandoff],
	['imageGenTools', mImageGen], ['kanbanTools', mKanban], ['kbVaultRecallTools', mKbVault],
	['mediaGenTools', mMediaGen], ['memoryTools', mMemory], ['mermaidTools', mMermaid],
	['mindmapTools', mMindmap], ['planExploreTool', mPlanExplore], ['planModeTools', mPlanMode],
	['routineCrystalFacetTools', mRoutine], ['schedulerTools', mScheduler], ['sessionSearchTools', mSessionSearch],
	['skillTools', mSkill], ['unifiedMemoryTools', mUnifiedMemory], ['unrealTools', mUnreal],
	['visionAnalyzeTools', mVision], ['webTools', mWeb], ['workflowTool', mWorkflowTool], ['workflowTools', mWorkflow],
];

const ROOT = process.cwd();

// ⚠ 白名单从生产侧 `toolsetConfig.ts` 的 `UTILITY_BUCKET_WHITELIST` 导入 ——
// 与 `builtinToolProvider._warnOnUtilityBucketTools`（注册收尾的归类自检 warn）**共用同一份**，
// 两处不得漂移。新加项的理由写在 toolsetConfig.ts 的常量注释里。
const UTILITY_WHITELIST: ReadonlySet<string> = UTILITY_BUCKET_WHITELIST;

/** 递归代理 ctx：任意属性/调用都返回同类代理，`register` 单独截获 descriptor。 */
function makeCtx(capture: (d: unknown) => void): unknown {
	const target = function () { /* noop */ };
	return new Proxy(target, {
		get(_t, prop) {
			if (prop === 'register') { return (d: unknown) => { capture(d); }; }
			if (prop === Symbol.toPrimitive) { return () => 0; }
			if (prop === 'then') { return undefined; } // 防 await 时把代理当 thenable
			return makeCtx(capture);
		},
		apply() { return makeCtx(capture); },
	});
}

/** 真跑全部注册入口，返回 name → 入口名。任一入口抛错直接失败（注册期崩溃是真 bug）。 */
async function sweepRegistrations(): Promise<ReadonlyMap<string, string>> {
	const registrations = new Map<string, string>();
	for (const [file, mod] of MODULES) {
		for (const [fn, handler] of Object.entries(mod)) {
			if (!/^register[A-Za-z0-9_]*$/.test(fn) || typeof handler !== 'function') { continue; }
			const maybe = (handler as (ctx: unknown) => unknown)(makeCtx(d => {
				const name = (d as { definition?: { name?: string }; name?: string })?.definition?.name
					?? (d as { name?: string })?.name;
				if (typeof name === 'string' && name) { registrations.set(name, `${file}.${fn}`); }
			}));
			if (maybe && typeof (maybe as Promise<unknown>).then === 'function') { await maybe; }
		}
	}
	assert.ok(registrations.size > 80,
		`扫描必须真的注册到工具（实际 ${registrations.size} 个）—— 为 0 说明代理 ctx 失效，整条守卫变假绿`);
	return registrations;
}

suite('工具注册接线守卫（unreal_* 事故的类级泛化）', () => {

	test('★★★ ① 任何注册工具不得落 utility 兜底桶（除显式白名单）', async () => {
		const registrations = await sweepRegistrations();
		const offenders = [...registrations.entries()]
			.filter(([name]) => getToolsetForTool(name) === 'utility' && !UTILITY_WHITELIST.has(name));
		assert.deepStrictEqual(offenders, [],
			`这些注册工具落进了 utility 兜底桶 —— 与 unreal_* 事故同型（focus 模式会整条剔除，` +
			`LLM 与 tool_search 均不可见）。修法：在 toolsetConfig.ts 为它们登记独立 toolset` +
			`（前缀或 exactNames），不要靠白名单掩盖。实际：${JSON.stringify(offenders)}`);
	});

	test('★★★ ② 不存在「真不可见」工具（focus 裁切 ∧ 不可折叠 ∧ 非 Always）', async () => {
		const registrations = await sweepRegistrations();
		// focus 推荐集是 focusMode.ts 的模块内常量（未导出）⇒ 从源文本取，保持与实现同源
		const focusSrc = fs.readFileSync(path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/common/focusMode.ts'), 'utf8');
		const focusBlock = focusSrc.slice(focusSrc.indexOf('CODING_FOCUS_TOOLSETS'));
		const focusSet = new Set([...focusBlock.slice(0, focusBlock.indexOf('];')).matchAll(/'([a-z-]+)'/g)].map(m => m[1]));

		const trulyInvisible = [...registrations.keys()].filter(name => {
			const ts = getToolsetForTool(name);
			if (focusSet.has(ts) || isBridgeTool(name) || isCoreTool(name)) { return false; }
			if (getToolsetPriority(ts) === ToolsetPriority.Always) { return false; }
			// deferrable 的被裁后还能经桥接目录找回；不可折叠的才是真不可见
			return !isDeferrableTool({ name } as never);
		});
		assert.deepStrictEqual(trulyInvisible, [],
			`这些工具在 focus 模式下**直接发与桥接目录都进不去**（真不可见）：${JSON.stringify(trulyInvisible)}` +
			`—— 修法：给它们的 toolset 加进 focus 推荐集，或提为 Always/High，或允许折叠`);
	});

	test('★★ ③ 每个注册工具都归入**已定义**的 toolset（防 toolset 拼写漂移）', async () => {
		const registrations = await sweepRegistrations();
		const defined = new Set(TOOLSET_DEFINITIONS.map(d => d.id));
		const orphans = [...registrations.entries()].filter(([name]) => {
			const ts = getToolsetForTool(name);
			return !defined.has(ts) && !ts.startsWith('mcp-'); // mcp-{server} 是动态 toolset
		});
		assert.deepStrictEqual(orphans, [],
			`这些工具归入了 TOOLSET_DEFINITIONS 里**不存在**的 toolset：${JSON.stringify(orphans)}` +
			`—— 通常是把 toolset 名拼错（或注册处显式 toolset 字段与表不一致）`);
	});

	test('★★ ④ 每个 provider 文件的 register*Tools 导出都在本扫描内（防新文件漏接）', () => {
		const toolDir = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/providers/tool');
		const onDisk = new Set<string>();
		for (const f of fs.readdirSync(toolDir).filter(x => /\.ts$/.test(x) && !/\.test\.ts$/.test(x))) {
			const s = fs.readFileSync(path.join(toolDir, f), 'utf8');
			if (/export function register[A-Za-z0-9_]*\(/.test(s)) { onDisk.add(f.replace(/\.ts$/, '')); }
		}
		const swept = new Set(MODULES.map(([f]) => f));
		const missing = [...onDisk].filter(f => !swept.has(f));
		assert.deepStrictEqual(missing, [],
			`这些 provider 文件有注册导出但**不在本扫描**里 ⇒ 上面的 ①②③ 对它们失效：` +
			`${JSON.stringify(missing)} —— 把模块加进本文件的 MODULES 表即可`);
	});
});
