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
import { createWorkspaceContextStore, normalizeWorkspaceContext, sameWorkspaceContext } from './workspaceContext.js';

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
		// 纯函数（探针/守卫直接 import 用来造夹具、比对；不进运行时热路径 ✓）
		normalizeWorkspaceContext, sameWorkspaceContext,
	};
}

export function apply(ctx) {
	const service = createFoundationService();
	// tracker 约定与 bridge 一致（cordis 注入时挂上真实 ctx）。
	Object.defineProperty(service, Symbol.for('cordis.tracker'), {
		value: { property: 'ctx', noShadow: true },
		enumerable: false,
	});
	ctx.provide('vssarosFoundation', service);
}
