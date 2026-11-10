// @vssaros/dsh-foundation — VsSaros dsh 插件的共享运行时服务（重构 1.3）。
//
// 提供 cordis 服务 `vssarosFoundation`，收编原先"逐字节复制"的四组实现：
//   · 数据根 / dsh Home 解析（lib/paths.js：dataRootOf / dshHomeOf）
//   · 页面壳（lib/pageShell.js：escapeHtml / SHELL_CSS / renderChips / renderShell）
//   · 跨进程写锁（lib/lock.js：acquireFileLock / atomicWriteFile / lockFileFor …）
//   · **运行期工作区上下文**（lib/workspaceContext.js，2026-10-17）：切工作区不必重启 Host 的落点 ✓
//
// 消费方式（消费插件的 lib/ 下保留同名**委托**文件，调用点不改）：
//   委托从 `ctx.vssarosFoundation` 取真源；拿不到 ⇒ 抛带明确指引的错（不是静默回退 ✗ —
//   静默回退会让"两份实现"偷偷复活）。
// 本插件必须在消费插件**之前**进组合（cordis.patch.yml 的 insert 顺序保证）；
// 消费插件用可选注入（ctx.inject），cordis 会等本服务就绪再激活它们 ✓。
import { dataRootOf, dshHomeOf } from './paths.js';
import { escapeHtml, SHELL_CSS, renderChips, renderShell } from './pageShell.js';
import {
	FILE_LOCK_SUFFIX, FILE_LOCK_WAIT_MS, FILE_LOCK_STALE_MS, FILE_LOCK_POLL_MS, FILE_LOCK_HEARTBEAT_MS, ATOMIC_TMP_POSTFIX,
	lockFileFor, isPidAlive, acquireFileLock, atomicWriteFile,
} from './lock.js';
import {
	createWorkspaceContextStore, normalizeWorkspaceContext, sameWorkspaceContext,
	deriveWorkspaceRoots, rootNameOf, MAX_WORKSPACE_ROOTS,
} from './workspaceContext.js';
import {
	renderWorkspaceRootsText, parseRootQualifiedPath, installWorkspaceRootsPrompt,
	MAX_WORKSPACE_PROMPT_TEXT, WORKSPACE_ROOTS_SECTION_NAME, WORKSPACE_ROOTS_SECTION_ORDER,
} from './workspacePrompt.js';
import { withMultiRootCheckedTarget, installMultiRootFs } from './fsMultiRoot.js';
import { installLogBridge } from './logBridge.js';

export const name = 'vssaros-foundation';
// 无依赖：这是所有 @vssaros/* 插件的底座，自己谁都不等。
export const inject = [];

/** 免 cordis 的工厂：探针/单测直接 `bindFoundation(createFoundationService())`，不必起 Host。 */
export function createFoundationService() {
	// ⚠ **一个 Host 一份**（本工厂在 apply() 里只调一次 ⇒ 各消费插件拿到的是同一个仓库实例 ✓）：
	//   否则"桥推的值"与"消费插件读的值"会各持一份 ⇒ 推了等于没推 ✗。
	const workspaceContext = createWorkspaceContextStore();
	return {
		// 路径解析
		dataRootOf, dshHomeOf,
		// 页面壳
		escapeHtml, SHELL_CSS, renderChips, renderShell,
		// 写锁
		lockFileFor, isPidAlive, acquireFileLock, atomicWriteFile,
		FILE_LOCK_SUFFIX, FILE_LOCK_WAIT_MS, FILE_LOCK_STALE_MS, FILE_LOCK_POLL_MS, FILE_LOCK_HEARTBEAT_MS, ATOMIC_TMP_POSTFIX,
		// 运行期工作区上下文（2026-10-17）：读 / 写 / 订阅三件事。
		//   · `workspaceContext()`   —— 消费插件每次解析时读（同步、零 I/O ✓）；`undefined` = 回落 config ✓。
		//   · `setWorkspaceContext()` —— 由 `@vssaros/dsh-bridge` 的 `workspace.context` 调（探针也可直接调 ✓）。
		//   · `onDidChangeWorkspaceContext()` —— 需要在值变化时重算的消费方（见 workspaceContext.js 的注释 ✓）。
		workspaceContext: workspaceContext.get,
		setWorkspaceContext: workspaceContext.set,
		clearWorkspaceContext: workspaceContext.clear,
		onDidChangeWorkspaceContext: workspaceContext.onDidChange,
		// P0-1（2026-11-10）：**唯一读口** —— 消费插件要根集就调它，别自己拼
		// `[workspaceRoot, ...relatedRoots]`（老载荷的 relatedRoots 全量含主根 ⇒ 会重复 ✗）。
		// 同步、零 I/O；没有上下文 ⇒ `[]`（各自的 config 回落纪律不受影响 ✓）。
		workspaceRoots: () => deriveWorkspaceRoots(workspaceContext.get()),
		// 纯函数（探针/守卫直接 import 用来造夹具、比对；不进运行时热路径 ✓）
		normalizeWorkspaceContext, sameWorkspaceContext, deriveWorkspaceRoots, rootNameOf, MAX_WORKSPACE_ROOTS,
		// P0-2（2026-11-10）：模型上下文段 / 根限定路径解析（纯函数，工具接入前的公共准备 ✓）
		renderWorkspaceRootsText, parseRootQualifiedPath, installWorkspaceRootsPrompt,
		MAX_WORKSPACE_PROMPT_TEXT, WORKSPACE_ROOTS_SECTION_NAME, WORKSPACE_ROOTS_SECTION_ORDER,
		// P0-3（2026-11-10）：多根写围栏（纯函数 + 接线，守卫用假 ctx 断言 ✓）
		withMultiRootCheckedTarget, installMultiRootFs,
	};
}

export function apply(ctx) {
	// 日志桥放在最前：foundation 是最早加载的 @vssaros 插件，越早挂上，漏掉的 warn 越少
	// （理由与机制见 lib/logBridge.js；失败不抛，不拖垮底座）。
	installLogBridge(ctx);
	const service = createFoundationService();
	// tracker 约定与 bridge 一致（cordis 注入时挂上真实 ctx）。
	Object.defineProperty(service, Symbol.for('cordis.tracker'), {
		value: { property: 'ctx', noShadow: true },
		enumerable: false,
	});
	ctx.provide('vssarosFoundation', service);
	// P0-2（2026-11-10）：多根工作区注入模型上下文。
	// ★ 走 `ctx.inject` 子作用域 ⇒ 不改插件级 `inject = []`（foundation 仍是谁都不等的底座）；
	// ★ systemPrompt 服务缺席 / 老 Host / 离线 fake ctx ⇒ 静默跳过（与"能力不存在"逐字一致 ✓）。
	installWorkspaceRootsPrompt(ctx, service);
	// P0-3（2026-11-10）：把 fs 沙箱的写根接到工作区多根。
	// ★ 同样走子作用域注入 ⇒ 不改 `inject = []`；fs 服务缺席 / 属性不可写 ⇒ 回落官方单根（fail-closed ✓）。
	// ★ 本机已降 danger-full-access，看不出差别 ⇒ 验收靠 check-host-config.mjs 的 A5 夹具断言。
	installMultiRootFs(ctx, service);
}
